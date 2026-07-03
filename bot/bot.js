require('dotenv').config({ quiet: true });

const TelegramBotPackage = require('node-telegram-bot-api');
const { registerHandlers } = require('./handlers');

const TelegramBot = TelegramBotPackage.TelegramBot || TelegramBotPackage.default || TelegramBotPackage;

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN .env faylida kiritilishi kerak.');
  }

  const polling = process.env.BOT_POLLING !== 'false';
  // Render/Railway uchun polling rejimi oddiy va alohida webhook sozlash talab qilmaydi.
  const bot = new TelegramBot(token, { polling });

  registerHandlers(bot);
  console.log(`Telegram bot ${polling ? 'polling' : 'manual'} rejimida ishga tushdi.`);

  return bot;
}

module.exports = { startBot };
