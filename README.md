# Telegram Moliyaviy AI-bot

Node.js, Express, Supabase va Google Gemini asosida qurilgan Telegram moliyaviy yordamchi bot. Foydalanuvchi odatda erkin matn yozadi, masalan `25000 nonga`; bot summa va kategoriyani Gemini orqali ajratadi, Supabase'ga saqlaydi va hisobot hamda maslahat beradi.

## Papka Tuzilishi

```text
/config
  db.js
/services
  ai.js
  expenseService.js
  userService.js
/bot
  bot.js
  handlers.js
/jobs
  monthCheck.js
index.js
package.json
README.md
supabase_schema.sql
```

## O'rnatish

```bash
npm install
```

Lokal `.env` faylini yarating va to'ldiring. Bu fayl gitga qo'shilmasligi kerak:

```env
TELEGRAM_BOT_TOKEN=123456789:telegram_bot_token
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
GEMINI_API_KEY=your_gemini_api_key
ADMIN_TELEGRAM_ID=123456789
PAYMENT_CARD_NUMBER=8600 1234 5678 9012
PAYMENT_PRICE=5000
PORT=3000
BOT_TIMEZONE=Asia/Tashkent
BOT_POLLING=true
GEMINI_MODEL=gemini-3.1-flash-lite
RATE_LIMIT_PER_MINUTE=20
AI_DEBUG=false
```

Botni ishga tushirish:

```bash
npm start
```

Sog'lik tekshiruvi:

```text
GET http://localhost:3000/
GET http://localhost:3000/health
```

## Supabase Sozlash

Supabase loyihangizda `Project Settings -> API` bo'limidan `SUPABASE_URL` va `service_role` kalitini oling. `service_role` faqat backend `.env` faylida turishi kerak.

Keyin `SQL Editor` bo'limida `supabase_schema.sql` faylidagi skriptni to'liq ishga tushiring. Skript quyidagilarni yaratadi:

- `users`
- `expenses`
- `monthly_history`
- indekslar
- RLS yoqilishi
- faqat `service_role` uchun to'liq ruxsat policy'lari

## Telegram Bot Olish

1. Telegram'da `@BotFather` ga kiring.
2. `/newbot` buyrug'i bilan bot yarating.
3. Berilgan tokenni `.env` ichidagi `TELEGRAM_BOT_TOKEN` ga yozing.

## Gemini API Kaliti

Google AI Studio'dan Gemini API kalitini oling va `.env` ichidagi `GEMINI_API_KEY` ga yozing. Standart model: `gemini-3.1-flash-lite`.

## Premium va Admin

`users` jadvaliga premium uchun `daily_limit`, `daily_voice_limit` va `is_premium` ustunlari qo'shilgan. Mavjud Supabase loyihada `supabase_schema.sql` ichidagi migration blokini SQL Editor'da ishga tushiring.

Admin buyruqlari faqat `.env` ichidagi `ADMIN_TELEGRAM_ID` egasiga ishlaydi:

```text
/premium <telegram_id>
/removepremium <telegram_id>
```

Oddiy foydalanuvchi kuniga 15 ta matnli va 2 ta ovozli xarajat, premium foydalanuvchi esa 50 ta matnli va 10 ta ovozli xarajat kirita oladi. Premium to'lov tasdiqlanganda 30 kunga faollashadi va `premium_expires_at` ustuniga muddati yoziladi.

Limit tugaganda bot premium karta raqami va narxni ko'rsatadi. Foydalanuvchi `💳 To'lov qildim, chek yuboraman` tugmasini bosgandan keyingina chek rasmini qabul qiladi. Kutilmagan rasmlar adminga yuborilmaydi.

Kunlik cron muddati tugagan premiumlarni avtomatik oddiy tarifga qaytaradi.

## Ishlash Mantiqi

- `/start` foydalanuvchini `users` jadvaliga yozadi va maosh so'raydi.
- Foydalanuvchi faqat raqam yozsa va maoshi hali `0` bo'lsa, bu qiymat maosh sifatida saqlanadi.
- Erkin xarajat matni Gemini'ga yuboriladi va `{ amount, category, note }` sifatida qaytadi.
- Gemini modeli uchun so'rovlar orasida 300ms oraliq bor; 429 yoki QuotaFailure bo'lsa 2 soniyadan keyin 1 marta qayta uriniladi.
- Xarajat `expenses` jadvaliga yoziladi; `input_type` ustuni matnli xarajatlar uchun `text`, ovozli xarajatlar uchun `voice` bo'ladi.
- ReplyKeyboard doim 4 ta tugmani ko'rsatadi: `📊 Hisobot`, `💰 Maosh`, `🤖 AI Tahlil`, `⚙️ Sozlamalar`.
- `node-cron` har kuni soat 09:00 da oy almashganini tekshiradi, eski oy yakunini `monthly_history` ga yozadi va foydalanuvchidan maoshni tasdiqlashni so'raydi.

## Render.com Deploy

1. Loyihani GitHub repository'ga push qiling.
2. Render'da `New -> Web Service` tanlang.
3. Repository'ni ulang.
4. Build command: `npm install`
5. Start command: `npm start`
6. Environment variables bo'limiga lokal `.env` dagi kerakli qiymatlarni kiriting.
7. Deploy qiling.

## Railway.app Deploy

1. Railway'da yangi project oching.
2. GitHub repository'ni ulang.
3. Variables bo'limiga lokal `.env` dagi kerakli o'zgaruvchilarni kiriting.
4. Railway odatda `npm install` va `npm start` ni avtomatik topadi; topmasa start command sifatida `npm start` kiriting.

## Xavfsizlik

- `.env` `.gitignore` ichida turadi, maxfiy kalitlar gitga tushmaydi.
- Backend Supabase'ga faqat `service_role` orqali ulanadi.
- Har bir Telegram xabari `telegram_id` orqali foydalanuvchiga bog'lanadi.
- Xarajat matni 200 belgi bilan cheklangan.
- Summa musbat raqam bo'lishi shart.
- Har bir foydalanuvchi uchun in-memory rate limit: daqiqasiga 20 xabar.
- Gemini JSON javobi `try/catch` bilan parse qilinadi, noto'g'ri javob serverni yiqitmaydi.
