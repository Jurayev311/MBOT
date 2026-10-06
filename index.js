require('dotenv').config({ quiet: true });

const express = require('express');
const { migrate, pool } = require('./config/db');
const { startBot } = require('./bot/bot');
const { startMonthCheck } = require('./jobs/monthCheck');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

// Deploy platformalari uchun engil health check endpoint.
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'telegram-finance-ai-bot',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

async function main() {
  // Jadvallar mavjud bo'lmasa yaratiladi; schema idempotent.
  await migrate();
  console.log('Postgres schema tayyor.');

  const bot = startBot();
  startMonthCheck(bot);

  const server = app.listen(port, () => {
    console.log(`Express server ${port}-portda ishga tushdi.`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} qabul qilindi, server to'xtatilmoqda...`);
    server.close();

    if (bot.isPolling()) {
      await bot.stopPolling();
    }

    await pool.end();

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Ilovani ishga tushirishda xato:', error);
  process.exit(1);
});
