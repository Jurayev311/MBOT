const cron = require('node-cron');

const budgetPlanService = require('../services/budgetPlanService');
const expenseService = require('../services/expenseService');
const userService = require('../services/userService');

const BUDGET_PLAN_START_PREFIX = 'budget_start_';
const BUDGET_PLAN_SKIP_PREFIX = 'budget_skip_';

function formatMoney(value) {
  return `${new Intl.NumberFormat('uz-UZ').format(Math.round(Number(value || 0)))} so'm`;
}

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

async function notifyDailyReminder(bot, telegramId) {
  await bot.sendMessage(
    telegramId,
    "👋 Bugun hech narsa yozmadingiz. Xarajat bo'lgan bo'lsa, unutmang!"
  );
}

function budgetPlanOfferMarkup(telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 Yangi reja', callback_data: `${BUDGET_PLAN_START_PREFIX}${telegramId}` },
          { text: '➡️ Rejasiz davom etaman', callback_data: `${BUDGET_PLAN_SKIP_PREFIX}${telegramId}` }
        ]
      ]
    }
  };
}

function formatBudgetPlanFinalReport(progress, options = {}) {
  const offerNewPlan = options.offerNewPlan !== false;
  const plan = progress.plan;
  const itemLines = progress.items.map((item) => {
    const overAmount = Number(item.overAmount || 0);
    const status = overAmount > 0 ? '⚠️' : '✅';
    const suffix = overAmount > 0
      ? `+${formatMoney(overAmount)} oshgan`
      : 'yaxshi';

    return `${status} ${item.category}: ${formatMoney(item.spent)} / ${formatMoney(item.plannedAmount)} (${suffix})`;
  });
  const unplannedLines = (progress.unplannedItems || []).map((item) => (
    `⚠️ ${item.category}: ${formatMoney(item.spent)} rejadan tashqari`
  ));
  const totalOver = Math.max(0, Number(progress.totalSpent || 0) - Number(progress.totalPlanned || 0));
  const totalSuffix = totalOver > 0
    ? `, +${formatMoney(totalOver)} oshgan`
    : '';

  return [
    `📅 Rejangizning muddati tugadi (${budgetPlanService.formatDate(plan.start_date)} — ${budgetPlanService.formatDate(plan.end_date)}).`,
    '',
    'Yakuniy natija:',
    itemLines.join('\n'),
    unplannedLines.length ? unplannedLines.join('\n') : null,
    '',
    `Jami: ${formatMoney(progress.totalSpent)} / ${formatMoney(progress.totalPlanned)} rejadan${totalSuffix}`,
    '',
    offerNewPlan
      ? 'Yangi davr uchun reja tuzasizmi?'
      : "Avval yangi oy maoshini tasdiqlang. Keyin 📆 Rejam orqali yangi reja tuzishingiz mumkin."
  ].filter((line) => line !== null).join('\n');
}

async function rolloverUserMonth(bot, user, date = new Date()) {
  const currentMonth = userService.getMonthKey(date);

  if (!user.current_month) {
    return userService.updateCurrentMonth(user.id, currentMonth);
  }

  if (user.current_month === currentMonth) {
    return user;
  }

  const previousSummary = await expenseService.getMonthlySummary(user.id, user.current_month);
  const salary = Number(user.current_salary || 0);
  const netSpent = Number(previousSummary.netSpent || 0);

  await userService.saveMonthlyHistory({
    userId: user.id,
    month: user.current_month,
    salary,
    totalSpent: netSpent,
    savings: salary - netSpent
  });

  const updatedUser = await userService.updateCurrentMonth(user.id, currentMonth);

  if (bot && user.telegram_id) {
    await notifyNewMonth(bot, user.telegram_id);
  }

  return updatedUser;
}

async function expirePremiumIfNeeded(bot, user, date = new Date()) {
  if (!userService.isPremiumExpired(user, date)) {
    return user;
  }

  const updatedUser = await userService.expirePremium(user.id);

  if (bot && user.telegram_id) {
    await notifyPremiumExpired(bot, user.telegram_id);
  }

  return updatedUser;
}

async function closeExpiredBudgetPlanIfNeeded(bot, user, date = new Date(), options = {}) {
  const expiredPlan = await budgetPlanService.getExpiredActiveBudgetPlan(user.id, date);

  if (!expiredPlan) {
    return;
  }

  const progress = await budgetPlanService.getBudgetPlanProgress(user.id, expiredPlan);
  await budgetPlanService.closeBudgetPlan(user.id, expiredPlan.id);

  if (bot && user.telegram_id) {
    await bot.sendMessage(
      user.telegram_id,
      formatBudgetPlanFinalReport(progress, options),
      options.offerNewPlan === false ? undefined : budgetPlanOfferMarkup(user.telegram_id)
    );
  }
}

async function runMonthCheck(bot, date = new Date()) {
  const users = await userService.getAllUsers();
  const currentMonth = userService.getMonthKey(date);

  for (const user of users) {
    let checkedUser = user;

    try {
      checkedUser = await expirePremiumIfNeeded(bot, user, date);
    } catch (error) {
      console.error(`Premium tekshiruvida xato: user=${user.id}`, error);
    }

    const monthWillRollover = Boolean(checkedUser.current_month && checkedUser.current_month !== currentMonth);

    try {
      await closeExpiredBudgetPlanIfNeeded(bot, checkedUser, date, {
        offerNewPlan: !monthWillRollover
      });
    } catch (error) {
      console.error(`Reja muddati tekshiruvida xato: user=${user.id}`, error);
    }

    try {
      await rolloverUserMonth(bot, checkedUser, date);
    } catch (error) {
      console.error(`Oy almashtirish tekshiruvida xato: user=${user.id}`, error);
    }
  }
}

async function runDailyReminder(bot, date = new Date()) {
  if (!bot) {
    return;
  }

  const users = await userService.getAllUsers();

  for (const user of users) {
    try {
      if (!user.telegram_id || Number(user.current_salary || 0) <= 0) {
        continue;
      }

      const todayCount = await expenseService.getDailyTransactionCount(user.id, date);

      if (todayCount === 0) {
        await notifyDailyReminder(bot, user.telegram_id);
      }
    } catch (error) {
      console.error(`Kunlik eslatmada xato: user=${user.id}`, error);
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

  cron.schedule('0 21 * * *', () => {
    runDailyReminder(bot).catch((error) => {
      console.error('Cron kunlik eslatmada xato:', error);
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
  closeExpiredBudgetPlanIfNeeded,
  notifyDailyReminder,
  notifyNewMonth,
  notifyPremiumExpired,
  runDailyReminder,
  rolloverUserMonth,
  runMonthCheck,
  startMonthCheck
};
