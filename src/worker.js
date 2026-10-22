// ============================================================
//  پیامک‌یار — سایت + فروشگاه (پرداخت با رسید) + سرور اشتراک (Cloudflare Worker + D1)
//  فایل‌های سایت داخل پوشه public هستند (binding: ASSETS)
// ============================================================

const DAY = 86400000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS codes (
     code TEXT PRIMARY KEY, days INTEGER NOT NULL, max_devices INTEGER NOT NULL DEFAULT 1,
     note TEXT DEFAULT '', created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS activations (
     code TEXT NOT NULL, device_id TEXT NOT NULL, activated_at INTEGER NOT NULL,
     until INTEGER NOT NULL, PRIMARY KEY (code, device_id))`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, plan_id TEXT NOT NULL,
     plan_title TEXT NOT NULL, days INTEGER NOT NULL, amount INTEGER NOT NULL, contact TEXT NOT NULL,
     track TEXT DEFAULT '', receipt TEXT DEFAULT '', ip TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'review',
     code TEXT, note TEXT DEFAULT '', created_at INTEGER NOT NULL, decided_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, plan_id TEXT NOT NULL,
     plan_title TEXT NOT NULL, days INTEGER NOT NULL, amount INTEGER NOT NULL, contact TEXT NOT NULL,
     authority TEXT, status TEXT NOT NULL DEFAULT 'pending', code TEXT,
     created_at INTEGER NOT NULL, paid_at INTEGER)`,
];

const DEFAULT_PLANS = [
  { id: 'm1', title: 'یک‌ماهه', days: 30, price: 49000 },
  { id: 'm3', title: 'سه‌ماهه', days: 90, price: 119000, badge: 'محبوب‌ترین' },
  { id: 'y1', title: 'سالانه', days: 365, price: 349000, badge: 'به‌صرفه‌ترین' },
];
const DEFAULT_SETTINGS = {
  apkUrl: '', version: '1.0.0', changelog: '', telegram: '',
  cardNumber: '', cardOwner: '', bank: '', payNote: '',
};

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const redirect = (to) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function readJson(req) {
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}

// ---------- تنظیمات ----------
async function kvGet(env, k) {
  return env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first('v');
}
async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, v).run();
}
async function getSettings(env) {
  let s = {};
  try { s = JSON.parse((await kvGet(env, 'settings')) || '{}'); } catch (_) {}
  return { ...DEFAULT_SETTINGS, ...s };
}
async function getPlans(env) {
  try {
    const p = JSON.parse((await kvGet(env, 'plans')) || 'null');
    if (Array.isArray(p) && p.length) return p;
  } catch (_) {}
  return DEFAULT_PLANS;
}

// ---------- کلید امضا ----------
const EC = { name: 'ECDSA', namedCurve: 'P-256' };

async function getKeys(env, retry = true) {
  const priv = await kvGet(env, 'priv');
  const pub = await kvGet(env, 'pub');
  if (priv && pub) {
    const key = await crypto.subtle.importKey('jwk', JSON.parse(priv), EC, false, ['sign']);
    return { priv: key, pub };
  }
  if (!retry) throw new Error('key init failed');
  const kp = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const spki = b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('priv', ?)").bind(JSON.stringify(jwk)),
    env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('pub', ?)").bind(spki),
  ]);
  return getKeys(env, false);
}

async function sign(env, deviceId, until) {
  const { priv } = await getKeys(env);
  const msg = new TextEncoder().encode(deviceId + '|' + until);
  return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg));
}

// ---------- ابزار ----------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  const a = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += ALPHA[a[i] % 32];
    if (i % 4 === 3 && i < 11) s += '-';
  }
  return s;
}
function randomRef() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHA[a[i] % 32];
  return s;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function isAdmin(req, env) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!env.ADMIN_TOKEN && t.length > 0 && safeEqual(t, String(env.ADMIN_TOKEN));
}
function clampInt(v, min, max, def) {
  const n = parseInt(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ---------- فعال‌سازی کد (اپ) ----------
async function activate(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();

  const nf = await env.DB.prepare('SELECT COUNT(*) AS n FROM fails WHERE ip = ? AND ts > ?')
    .bind(ip, now - 10 * 60 * 1000).first('n');
  if (nf >= 10) return json({ ok: false, error: 'تلاش بیش از حد؛ چند دقیقه بعد دوباره امتحان کنید' }, 429);

  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'درخواست نامعتبر است' }, 400);
  const code = String(body.code || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '').trim();
  if (!code || deviceId.length < 8 || deviceId.length > 64) return json({ ok: false, error: 'اطلاعات ناقص است' }, 400);

  const fail = async (msg) => {
    await env.DB.prepare('INSERT INTO fails (ip, ts) VALUES (?, ?)').bind(ip, now).run();
    await env.DB.prepare('DELETE FROM fails WHERE ts < ?').bind(now - 3600 * 1000).run();
    return json({ ok: false, error: msg });
  };

  const row = await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(code).first();
  if (!row || row.revoked) return fail('کد نامعتبر است');

  let until;
  const act = await env.DB.prepare('SELECT until FROM activations WHERE code = ? AND device_id = ?')
    .bind(code, deviceId).first();
  if (act) {
    until = act.until;
  } else {
    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM activations WHERE code = ?').bind(code).first('n');
    if (used >= row.max_devices) return fail('ظرفیت این کد پر شده است');
    until = now + row.days * DAY;
    await env.DB.prepare('INSERT INTO activations (code, device_id, activated_at, until) VALUES (?, ?, ?, ?)')
      .bind(code, deviceId, now, until).run();
  }
  if (until < now) return json({ ok: false, error: 'مدت این کد تمام شده است' });
  return json({ ok: true, until, deviceId, sig: await sign(env, deviceId, until) });
}

// ---------- پرداخت با رسید (کارت‌به‌کارت) ----------
async function notifyOwner(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
    });
  } catch (_) {}
}

async function orderNew(req, env, ctx, origin) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE ip = ? AND created_at > ?')
    .bind(ip, now - 3600 * 1000).first('n');
  if (recent >= 5) return json({ ok: false, error: 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کنید' }, 429);

  const s = await getSettings(env);
  if (!s.cardNumber) return json({ ok: false, error: 'پرداخت با رسید هنوز فعال نشده است' });

  const b = (await readJson(req)) || {};
  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === b.plan);
  if (!plan) return json({ ok: false, error: 'پلن نامعتبر است' }, 400);
  const contact = String(b.contact || '').trim().slice(0, 60);
  if (contact.length < 5) return json({ ok: false, error: 'ایمیل یا شماره موبایل را وارد کنید' }, 400);
  const track = String(b.track || '').trim().slice(0, 40);
  const receipt = String(b.receipt || '');
  if (receipt && (!/^data:image\/(jpeg|png|webp);base64,/.test(receipt) || receipt.length > 900000)) {
    return json({ ok: false, error: 'تصویر رسید نامعتبر یا حجمش زیاد است' }, 400);
  }
  if (!receipt && track.length < 4) return json({ ok: false, error: 'تصویر رسید یا شماره پیگیری را وارد کنید' }, 400);

  const ref = randomRef();
  await env.DB.prepare(
    `INSERT INTO payments (ref, plan_id, plan_title, days, amount, contact, track, receipt, ip, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?)`
  ).bind(ref, plan.id, plan.title, plan.days, plan.price, contact, track, receipt, ip, now).run();

  const text = '🧾 رسید جدید پیامک‌یار\nپلن: ' + plan.title + ' (' + plan.price + ' تومان)\nمشتری: ' + contact +
    (track ? '\nپیگیری: ' + track : '') + '\nبررسی: ' + origin + '/admin';
  if (ctx && ctx.waitUntil) ctx.waitUntil(notifyOwner(env, text)); else await notifyOwner(env, text);
  return json({ ok: true, ref });
}

// ---------- API عمومی ----------
async function publicInfo(env) {
  const s = await getSettings(env);
  const downloads = parseInt((await kvGet(env, 'downloads')) || '0') || 0;
  return {
    ok: true,
    plans: await getPlans(env),
    version: s.version,
    changelog: s.changelog,
    telegram: s.telegram,
    hasApk: !!s.apkUrl,
    pay: !!s.cardNumber,
    card: s.cardNumber ? { number: s.cardNumber, owner: s.cardOwner, bank: s.bank, note: s.payNote } : null,
    downloads,
  };
}

// ---------- مدیریت ----------
async function admin(req, env, path) {
  if (path === '/api/admin/stats' && req.method === 'GET') {
    const n = async (sql) => (await env.DB.prepare(sql).first('n')) || 0;
    const now = Date.now();
    return json({
      ok: true,
      codes: await n('SELECT COUNT(*) AS n FROM codes'),
      activations: await n('SELECT COUNT(*) AS n FROM activations'),
      activeNow: await env.DB.prepare('SELECT COUNT(*) AS n FROM activations WHERE until > ?').bind(now).first('n'),
      approved: await n("SELECT COUNT(*) AS n FROM payments WHERE status = 'approved'"),
      revenue: await n("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'approved'"),
      pending: await n("SELECT COUNT(*) AS n FROM payments WHERE status = 'review'"),
      downloads: parseInt((await kvGet(env, 'downloads')) || '0') || 0,
    });
  }

  if (path === '/api/admin/payments' && req.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT id, plan_title, days, amount, contact, track, status, code, note, created_at, decided_at,
              (CASE WHEN receipt != '' THEN 1 ELSE 0 END) AS has_receipt
       FROM payments ORDER BY (status = 'review') DESC, id DESC LIMIT 300`
    ).all();
    return json({ ok: true, payments: r.results });
  }

  if (path === '/api/admin/receipt' && req.method === 'GET') {
    const id = parseInt(new URL(req.url).searchParams.get('id') || '0');
    const data = await env.DB.prepare('SELECT receipt FROM payments WHERE id = ?').bind(id).first('receipt');
    return json({ ok: !!data, data: data || '' });
  }

  if (path === '/api/admin/pay/approve' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    const p = await env.DB.prepare('SELECT id, days, contact, status FROM payments WHERE id = ?').bind(parseInt(b.id) || 0).first();
    if (!p) return json({ ok: false, error: 'پیدا نشد' }, 404);
    if (p.status === 'approved') return json({ ok: false, error: 'قبلاً تأیید شده است' });
    const lic = makeCode();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO codes (code, days, max_devices, note, created_at) VALUES (?, ?, 1, ?, ?)')
        .bind(lic, p.days, 'رسید ' + p.id + ' - ' + p.contact, Date.now()),
      env.DB.prepare("UPDATE payments SET status = 'approved', code = ?, note = '', decided_at = ? WHERE id = ?")
        .bind(lic, Date.now(), p.id),
    ]);
    return json({ ok: true, code: lic });
  }

  if (path === '/api/admin/pay/reject' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    await env.DB.prepare("UPDATE payments SET status = 'rejected', note = ?, decided_at = ? WHERE id = ? AND status = 'review'")
      .bind(String(b.note || 'رسید تأیید نشد').slice(0, 200), Date.now(), parseInt(b.id) || 0).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/settings' && req.method === 'GET') {
    return json({ ok: true, settings: await getSettings(env), plans: await getPlans(env) });
  }

  if (path === '/api/admin/settings' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    const cur = await getSettings(env);
    const apkUrl = String(b.apkUrl ?? cur.apkUrl).trim();
    if (apkUrl && !/^https:\/\//.test(apkUrl)) return json({ ok: false, error: 'لینک دانلود باید با https:// شروع شود' });
    const s = {
      apkUrl,
      version: String(b.version ?? cur.version).trim().slice(0, 20),
      changelog: String(b.changelog ?? cur.changelog).slice(0, 500),
      telegram: String(b.telegram ?? cur.telegram).trim().replace(/^@/, '').slice(0, 40),
      cardNumber: String(b.cardNumber ?? cur.cardNumber).replace(/[^0-9 \-]/g, '').trim().slice(0, 24),
      cardOwner: String(b.cardOwner ?? cur.cardOwner).trim().slice(0, 40),
      bank: String(b.bank ?? cur.bank).trim().slice(0, 30),
      payNote: String(b.payNote ?? cur.payNote).trim().slice(0, 200),
    };
    await kvSet(env, 'settings', JSON.stringify(s));
    if (Array.isArray(b.plans)) {
      const plans = b.plans.slice(0, 6).map((p, i) => ({
        id: String(p.id || 'p' + i).slice(0, 12),
        title: String(p.title || 'پلن').slice(0, 30),
        days: clampInt(p.days, 1, 3650, 30),
        price: clampInt(p.price, 1000, 100000000, 49000),
        badge: p.badge ? String(p.badge).slice(0, 20) : undefined,
      }));
      if (plans.length) await kvSet(env, 'plans', JSON.stringify(plans));
    }
    return json({ ok: true });
  }

  if (path === '/api/admin/codes' && req.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT c.code, c.days, c.max_devices, c.note, c.created_at, c.revoked,
              (SELECT COUNT(*) FROM activations a WHERE a.code = c.code) AS used
       FROM codes c ORDER BY c.created_at DESC LIMIT 500`
    ).all();
    return json({ ok: true, codes: r.results });
  }

  if (path === '/api/admin/codes' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    const days = clampInt(b.days, 1, 3650, 30);
    const count = clampInt(b.count, 1, 200, 1);
    const maxDevices = clampInt(b.maxDevices, 1, 100, 1);
    const note = String(b.note || '').slice(0, 100);
    const codes = [];
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const c = makeCode();
      codes.push(c);
      stmts.push(
        env.DB.prepare('INSERT INTO codes (code, days, max_devices, note, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(c, days, maxDevices, note, Date.now())
      );
    }
    await env.DB.batch(stmts);
    return json({ ok: true, codes });
  }

  if (path === '/api/admin/revoke' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    await env.DB.prepare('UPDATE codes SET revoked = 1 WHERE code = ?').bind(String(b.code || '')).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/unbind' && req.method === 'POST') {
    const b = (await readJson(req)) || {};
    await env.DB.prepare('DELETE FROM activations WHERE code = ?').bind(String(b.code || '')).run();
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// ---------- مسیریابی ----------
export default {
  async fetch(req, env, ctx) {
    try {
      await init(env);
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/api/public' && req.method === 'GET') return json(await publicInfo(env));

      if (path === '/api/pubkey' && req.method === 'GET') {
        const { pub } = await getKeys(env);
        return json({ ok: true, spki: pub });
      }

      if (path === '/api/license/activate' && req.method === 'POST') return await activate(req, env);

      if (path === '/api/order/new' && req.method === 'POST') return await orderNew(req, env, ctx, url.origin);

      if (path === '/api/order' && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || '';
        const o = await env.DB.prepare(
          'SELECT plan_title, days, amount, status, code, note FROM payments WHERE ref = ?'
        ).bind(ref).first();
        if (!o) return json({ ok: false, error: 'سفارش پیدا نشد' }, 404);
        return json({ ok: true, order: { ...o, code: o.status === 'approved' ? o.code : null } });
      }

      if (path === '/dl' && req.method === 'GET') {
        const s = await getSettings(env);
        if (!s.apkUrl) return redirect('/#download');
        await env.DB.prepare(
          "INSERT INTO kv (k, v) VALUES ('downloads', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1"
        ).run();
        return redirect(s.apkUrl);
      }

      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(req, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        return await admin(req, env, path);
      }

      // بقیه مسیرها: فایل‌های سایت
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ ok: false, error: 'server error' }, 500);
    }
  },
};
