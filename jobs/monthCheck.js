const cron = require('node-cron');

const expenseService = require('../services/expenseService');
const userService = require('../services/userService');

function monthPromptMarkup() {
  // Asosiy ReplyKeyboard o'zgarmasligi uchun oy savoli inline tugmalar bilan beriladi.
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Ha', callback_data: 'month_salary_keep' },
          { text: 'Yangilash', callback_data: 'month_salary_update' }
        ]
      ]
    }
  };
}

async function notifyNewMonth(bot, telegramId) {
  await bot.sendMessage(
    telegramId,
    "Yangi oy boshlandi! Bu oy uchun maoshingiz avvalgidek qoladimi?",
    monthPromptMarkup()
  );
}

async function notifyPremiumExpired(bot, telegramId) {
  await bot.sendMessage(
    telegramId,
    "⏳ Premium tarifingizning 1 oylik muddati tugadi. Endi oddiy tarifga qaytdingiz (kuniga 15 ta matnli va 2 ta ovozli xarajat). Davom etish uchun qayta premium sotib olishingiz mumkin."
  );
}

async function rolloverUserMonth(bot, user) {
  const currentMonth = userService.getMonthKey();

  if (!user.current_month) {
    return userService.updateCurrentMonth(user.id, currentMonth);
  }

  if (user.current_month === currentMonth) {
    return user;
  }

  const previousSummary = await expenseService.getMonthlySummary(user.id, user.current_month);
  const salary = Number(user.current_salary || 0);
  const totalSpent = Number(previousSummary.totalSpent || 0);

  await userService.saveMonthlyHistory({
    userId: user.id,
    month: user.current_month,
    salary,
    totalSpent,
    savings: salary - totalSpent
  });

  const updatedUser = await userService.updateCurrentMonth(user.id, currentMonth);

  if (bot && user.telegram_id) {
    await notifyNewMonth(bot, user.telegram_id);
  }

  return updatedUser;
}

async function expirePremiumIfNeeded(bot, user) {
  if (!userService.isPremiumExpired(user)) {
    return user;
  }

  const updatedUser = await userService.expirePremium(user.id);

  if (bot && user.telegram_id) {
    await notifyPremiumExpired(bot, user.telegram_id);
  }

  return updatedUser;
}

async function runMonthCheck(bot) {
  const users = await userService.getAllUsers();

  for (const user of users) {
    try {
      const checkedUser = await expirePremiumIfNeeded(bot, user);
      await rolloverUserMonth(bot, checkedUser);
    } catch (error) {
      console.error(`Kunlik tekshiruvda xato: user=${user.id}`, error);
    }
  }
}

function startMonthCheck(bot) {
  const timezone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';

  // Kuniga bir marta eski oyni tarixga yopish uchun tekshiruv ishlaydi.
  cron.schedule('0 9 * * *', () => {
    runMonthCheck(bot).catch((error) => {
      console.error('Cron oy tekshiruvida xato:', error);
    });
  }, { timezone });

  setTimeout(() => {
    runMonthCheck(bot).catch((error) => {
      console.error("Boshlang'ich oy tekshiruvida xato:", error);
    });
  }, 1500);
}

module.exports = {
  expirePremiumIfNeeded,
  notifyNewMonth,
  notifyPremiumExpired,
  rolloverUserMonth,
  runMonthCheck,
  startMonthCheck
};
