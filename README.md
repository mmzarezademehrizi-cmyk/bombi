# سایت و سرور پیامک‌یار (GitHub ← Cloudflare)

این پوشه کل سایت، فروشگاه، پنل مالک و سرور اشتراک است:
- `public/index.html` صفحه اصلی (دانلود، قیمت و خرید)
- `public/admin.html` پنل مالک (با رمز `ADMIN_TOKEN`)
- `public/result.html` صفحه نتیجه پرداخت (نمایش کد اشتراک)
- `src/worker.js` سرور (API اشتراک، پرداخت زرین‌پال، تنظیمات)
- `wrangler.toml` تنظیمات Cloudflare

## ۱) آپلود روی GitHub
1. در github.com یک مخزن (Repository) جدید بسازید، مثلاً `smsyar-site` (می‌تواند Private باشد).
2. **Add file ← Upload files** و کل محتویات همین پوشه (`public`, `src`, `wrangler.toml`, `.gitignore`, `README.md`) را بکشید و **Commit** کنید.
3. هیچ رمزی داخل فایل‌ها نیست؛ رمزها را فقط در کلودفلر می‌گذارید.

## ۲) دیتابیس
اگر قبلاً دیتابیس `smsyar` را ساخته‌اید همان را نگه دارید (کدها و کلید امضای قبلی حفظ می‌شود و نیازی به تغییر `License.kt` نیست).
در غیر این صورت: Cloudflare ← **Storage & Databases ← D1 ← Create** با نام `smsyar`.
سپس **Database ID** را کپی کنید و در GitHub فایل `wrangler.toml` را ویرایش کنید: به‌جای `DATABASE-ID-RA-INJA-BEGZARID` بگذارید. (ID محرمانه نیست.)

## ۳) اتصال به Cloudflare
1. Cloudflare ← **Workers & Pages ← Create ← Import a repository** (اتصال GitHub را مجاز کنید) و مخزن را انتخاب کنید.
2. نام پروژه باید دقیقاً با `name` در `wrangler.toml` یکی باشد: `smsyar-license`.
   (اگر قبلاً Worker با همین نام ساخته‌اید: داخل همان Worker ← **Settings ← Builds ← Connect** و مخزن را وصل کنید.)
3. Build command را خالی بگذارید و Deploy command همان `npx wrangler deploy` باشد. **Save and Deploy**.
4. از این به بعد هر بار فایلی را در GitHub تغییر دهید، خودکار منتشر می‌شود.

## ۴) رمزها (Settings ← Variables and Secrets)
| نام | نوع | مقدار |
|---|---|---|
| `ADMIN_TOKEN` | Secret | رمز طولانی و تصادفی برای پنل مالک |
| `ZARINPAL_MERCHANT` | Secret | مرچنت‌کد زرین‌پال (برای پرداخت آنلاین) |
| `ZARINPAL_SANDBOX` | Text | `1` فقط برای تست؛ برای فروش واقعی این متغیر را پاک کنید |

## ۵) دامنه
آدرس پیش‌فرض: `https://smsyar-license.<نام-شما>.workers.dev`.
برای فروش با زرین‌پال دامنه واقعی لازم است: دامنه (مثلاً `madirmed.ir`) را به کلودفلر اضافه کنید، سپس Worker ← **Settings ← Domains & Routes ← Add ← Custom domain**. همان دامنه را در پنل زرین‌پال برای درگاه ثبت کنید (زرین‌پال آدرس بازگشت را فقط روی دامنه ثبت‌شده می‌پذیرد).

## ۶) پنل مالک
آدرس `/admin` را باز کنید و `ADMIN_TOKEN` را بزنید:
- **سفارش‌ها:** فروش‌ها، مبلغ، مشتری، کد صادرشده.
- **کدهای اشتراک:** ساخت کد دستی (برای کارت‌به‌کارت یا هدیه)، ابطال، آزادسازی دستگاه.
- **تنظیمات سایت:** لینک دانلود APK، شماره نسخه، آیدی تلگرام پشتیبانی، قیمت و مدت پلن‌ها.

## ۷) انتشار APK
1. در GitHub مخزن: **Releases ← Create a new release**، فایل APK را ضمیمه کنید و Publish.
2. روی فایل APK کلیک راست و «Copy link address» کنید.
3. در پنل مالک ← تنظیمات سایت، لینک را در «لینک دانلود APK» بگذارید و ذخیره کنید. دکمه‌های دانلود سایت از همین لحظه کار می‌کنند.
ساخت APK: `flutter build apk --release` (فایل: `build/app/outputs/flutter-apk/app-release.apk`).

## ۸) اتصال اپ به سرور
- `lib/native.dart`: مقدار `YOUR-SUBDOMAIN` در `licenseUrl` را با دامنه سایت عوض کنید (مثلاً `https://madirmed.ir/api/license/activate`).
- `License.kt`: مقدار `PUB` را از `https://دامنه-شما/api/pubkey` (فیلد `spki`) بگذارید. اگر دیتابیس قبلی را نگه داشته‌اید همان مقدار قبلی درست است.

## تست پرداخت
با `ZARINPAL_SANDBOX=1` و یک مرچنت آزمایشی، از سایت خرید کنید؛ باید به صفحه درگاه بروید و بعد از پرداخت، صفحه «پرداخت موفق بود» با کد اشتراک نمایش داده شود. آدرس‌های Sandbox را با مستندات فعلی زرین‌پال تطبیق دهید.

## نکات
- قیمت‌ها در `public` نیستند؛ از پنل مالک عوض می‌شوند.
- فونت وزیرمتن از Google Fonts لود می‌شود؛ اگر در شبکه شما کند بود، فایل فونت را داخل `public/` بگذارید.
- پلن رایگان کلودفلر (۱۰۰ هزار درخواست در روز) برای شروع کافی است.
