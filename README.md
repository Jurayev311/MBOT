# Telegram Moliyaviy AI-bot

Node.js, Express, PostgreSQL (Railway) va Google Gemini asosida qurilgan Telegram moliyaviy yordamchi bot. Foydalanuvchi odatda erkin matn yozadi, masalan `25000 nonga`; bot summa va kategoriyani Gemini orqali ajratadi, PostgreSQL'ga saqlaydi va hisobot hamda maslahat beradi.

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
/db
  schema.sql
```

## O'rnatish

```bash
npm install
```

Lokal `.env` faylini yarating va to'ldiring. Bu fayl gitga qo'shilmasligi kerak:

```env
TELEGRAM_BOT_TOKEN=123456789:telegram_bot_token
DATABASE_URL=postgresql://user:password@host:5432/railway
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

## Baza

Bot oddiy PostgreSQL bilan ishlaydi (`DATABASE_URL`). Ishga tushganda `db/schema.sql` avtomatik bajariladi va jadvallar yaratiladi, shuning uchun qo'lda SQL ishga tushirish shart emas. Schema idempotent: har deployda qayta ishlashi xavfsiz.

## Telegram Bot Olish

1. Telegram'da `@BotFather` ga kiring.
2. `/newbot` buyrug'i bilan bot yarating.
3. Berilgan tokenni `.env` ichidagi `TELEGRAM_BOT_TOKEN` ga yozing.

## Gemini API Kaliti

Google AI Studio'dan Gemini API kalitini oling va `.env` ichidagi `GEMINI_API_KEY` ga yozing. Standart model: `gemini-3.1-flash-lite`.

## Premium va Admin

`users` jadvaliga premium uchun `daily_limit`, `daily_voice_limit` va `is_premium` ustunlari qo'shilgan. Migratsiya bot ishga tushganda avtomatik bajariladi.

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

## Railway Deploy

Project: `mbot` (servislar: `bot` va `Postgres`). `bot` servisidagi `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.

```bash
railway link                 # papkani mbot projectiga ulash
railway service link bot
railway up --detach          # deploy
railway logs                 # loglar
railway variables            # o'zgaruvchilar
railway variables --set "KEY=VALUE"
```

Botni bir vaqtning o'zida faqat bitta joyda polling rejimida ishga tushiring, aks holda Telegram 409 Conflict qaytaradi.

## Xavfsizlik

- `.env` `.gitignore` ichida turadi, maxfiy kalitlar gitga tushmaydi.
- Baza faqat Railway ichki tarmog'i orqali ulanadi (`postgres.railway.internal`).
- Har bir Telegram xabari `telegram_id` orqali foydalanuvchiga bog'lanadi.
- Xarajat matni 200 belgi bilan cheklangan.
- Summa musbat raqam bo'lishi shart.
- Har bir foydalanuvchi uchun in-memory rate limit: daqiqasiga 20 xabar.
- Gemini JSON javobi `try/catch` bilan parse qilinadi, noto'g'ri javob serverni yiqitmaydi.
