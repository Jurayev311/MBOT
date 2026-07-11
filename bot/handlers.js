const ExcelJS = require('exceljs');

const {
  categorizeExpense,
  categorizeVoiceExpense,
  generateAdvice,
  generatePlanGoalAnalysis,
  parseExpensesLocally
} = require('../services/ai');
const apiUsageService = require('../services/apiUsageService');
const budgetPlanService = require('../services/budgetPlanService');
const expenseService = require('../services/expenseService');
const userService = require('../services/userService');
const { rolloverUserMonth } = require('../jobs/monthCheck');
const { parseAmount } = require('../utils/parseAmount');

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ['📊 Hisobot', '💰 Maosh'],
      ['🤖 AI Tahlil', '⚙️ Sozlamalar'],
      ['🎯 Reja va Maqsad', '📆 Rejam']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const SETTINGS_EXPORT_EXCEL_CALLBACK = 'settings_export_excel';
const BUDGET_PLAN_BUTTON_TEXT = '📆 Rejam';
const BUDGET_PLAN_START_PREFIX = 'budget_start_';
const BUDGET_PLAN_SKIP_PREFIX = 'budget_skip_';
const BUDGET_PLAN_CANCEL_PREFIX = 'budget_cancel_';
const BUDGET_PLAN_DATE_CONFIRM_PREFIX = 'budget_date_ok_';
const BUDGET_PLAN_DATE_RETRY_PREFIX = 'budget_date_retry_';
const BUDGET_PLAN_MANAGE_EDIT_PREFIX = 'budget_manage_edit_';
const BUDGET_PLAN_MANAGE_ADD_PREFIX = 'budget_manage_add_';
const BUDGET_PLAN_MANAGE_DATE_PREFIX = 'budget_manage_date_';

const CLEAR_CONFIRM_INLINE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: 'Ha, tozalash', callback_data: 'settings_clear_confirm' },
        { text: 'Bekor qilish', callback_data: 'settings_clear_cancel' }
      ]
    ]
  }
};

function getSettingsInlineKeyboard(user) {
  const inlineKeyboard = [
    [{ text: "✏️ Ismni o'zgartirish", callback_data: 'settings_change_name' }],
    [{ text: "🗑️ Ma'lumotlarni tozalash", callback_data: 'settings_clear_request' }]
  ];

  if (user?.is_premium) {
    inlineKeyboard.push([{ text: '📥 Excel hisobot (5 limit)', callback_data: SETTINGS_EXPORT_EXCEL_CALLBACK }]);
  }

  return {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };
}

const PAYMENT_START_CALLBACK = 'payment_send_receipt';
const PAYMENT_CONFIRM_PREFIX = 'payment_confirm_';
const PAYMENT_REJECT_PREFIX = 'payment_reject_';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_COUNT = 20;
const configuredRateLimitCount = Number(process.env.RATE_LIMIT_PER_MINUTE);
const RATE_LIMIT_COUNT = Number.isInteger(configuredRateLimitCount) && configuredRateLimitCount > 0
  ? configuredRateLimitCount
  : DEFAULT_RATE_LIMIT_COUNT;
const FREE_DAILY_LIMIT = 15;
const PREMIUM_DAILY_LIMIT = 50;
const EXCEL_EXPORT_LIMIT_COST = 5;
const FREE_AI_ANALYSIS_LIMIT_COST = 3;
const PREMIUM_AI_ANALYSIS_LIMIT_COST = 5;
const FREE_DAILY_VOICE_LIMIT = 2;
const PREMIUM_DAILY_VOICE_LIMIT = 10;
const ADMIN_USERS_PAGE_SIZE = 10;
const ADMIN_LIST_PREFIX = 'adm_l_';
const ADMIN_VIEW_PREFIX = 'adm_v_';
const ADMIN_DELETE_ASK_PREFIX = 'adm_da_';
const ADMIN_DELETE_DO_PREFIX = 'adm_dd_';
const ADMIN_DELETE_CANCEL_PREFIX = 'adm_dc_';
const EXPENSE_EDIT_PREFIX = 'exed_';
const EXPENSE_DELETE_PREFIX = 'exdel_';
const EXPENSE_DELETE_CONFIRM_PREFIX = 'exok_';
const EXPENSE_DELETE_CANCEL_PREFIX = 'excn_';
const PLAN_GOAL_CANCEL_CALLBACK = 'plan_goal_cancel';
const PLAN_GOAL_LIMIT_COST = 15;
const AMOUNT_PARSE_ERROR_TEXT = "Summani tushunmadim. Masalan: 15000, 15 ming, yoki 1.5 mln kabi yozing.";
const BUDGET_PLAN_TEXT_MIN_LENGTH = 10;
const BUDGET_PLAN_TEXT_MAX_LENGTH = 4000;
const rateBuckets = new Map();
const userStates = new Map();
const consumedCallbackMessages = new Map();
const CALLBACK_CONSUMED_TTL_MS = 6 * 60 * 60 * 1000;

function formatMoney(value) {
  return `${new Intl.NumberFormat('uz-UZ').format(Math.round(Number(value || 0)))} so'm`;
}

function getChatId(msg) {
  return msg.chat.id;
}

function getTelegramId(from) {
  return userService.normalizeTelegramId(from.id);
}

function validateExpenseText(text) {
  const cleanText = String(text || '').trim();

  if (!cleanText) {
    return {
      ok: false,
      text: cleanText,
      message: "Xarajat yoki kirim matni bo'sh bo'lmasligi kerak."
    };
  }

  return {
    ok: true,
    text: cleanText
  };
}

function validateBudgetPlanText(text) {
  const cleanText = String(text || '').trim();

  if (cleanText.length < BUDGET_PLAN_TEXT_MIN_LENGTH) {
    return {
      ok: false,
      text: cleanText,
      message: "Rejani biroz batafsilroq yozing. Masalan: ovqatga 800000, taxiga 300000"
    };
  }

  return {
    ok: true,
    text: cleanText
  };
}

function cleanupConsumedCallbacks() {
  const now = Date.now();

  for (const [key, timestamp] of consumedCallbackMessages.entries()) {
    if (now - timestamp > CALLBACK_CONSUMED_TTL_MS) {
      consumedCallbackMessages.delete(key);
    }
  }
}

function getCallbackMessageKey(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  return chatId && messageId ? `${chatId}:${messageId}` : null;
}

function isCallbackMessageConsumed(key) {
  cleanupConsumedCallbacks();
  return key ? consumedCallbackMessages.has(key) : false;
}

function markCallbackMessageConsumed(key) {
  if (!key) {
    return;
  }

  cleanupConsumedCallbacks();
  consumedCallbackMessages.set(key, Date.now());
}

async function answerCallback(bot, query, text = null) {
  const options = text ? { text, show_alert: false } : undefined;

  try {
    await bot.answerCallbackQuery(query.id, options);
  } catch (error) {
    console.error('Callback javobini yuborishda xato:', error);
  }
}

async function removeInlineKeyboard(bot, query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    return;
  }

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }
    );
  } catch (error) {
    const message = String(error?.message || '');

    if (!message.includes('message is not modified') && !message.includes('message to edit not found')) {
      console.error('Inline tugmalarni olib tashlashda xato:', error);
    }
  }
}

async function consumeCallbackMessage(bot, query, key) {
  markCallbackMessageConsumed(key);
  await removeInlineKeyboard(bot, query);
}

function isAdminUser(from) {
  return String(from?.id || '') === String(process.env.ADMIN_TELEGRAM_ID || '').trim();
}

function getAdminTelegramId() {
  return String(process.env.ADMIN_TELEGRAM_ID || '').trim();
}

function getPaymentCardNumber() {
  return process.env.PAYMENT_CARD_NUMBER || '8600 1234 5678 9012';
}

function getPaymentPrice() {
  return Number(process.env.PAYMENT_PRICE || 5000);
}

function formatPaymentPrice() {
  return new Intl.NumberFormat('uz-UZ').format(getPaymentPrice());
}

function getPaymentStartMarkup() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 To'lov qildim, chek yuboraman", callback_data: PAYMENT_START_CALLBACK }]
      ]
    }
  };
}

function getBudgetPlanOfferMarkup(telegramId, startLabel = '📋 Reja tuzaman') {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: startLabel, callback_data: `${BUDGET_PLAN_START_PREFIX}${telegramId}` },
          { text: '➡️ Rejasiz davom etaman', callback_data: `${BUDGET_PLAN_SKIP_PREFIX}${telegramId}` }
        ]
      ]
    }
  };
}

function getBudgetPlanCancelMarkup(telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Bekor qilish', callback_data: `${BUDGET_PLAN_CANCEL_PREFIX}${telegramId}` }]
      ]
    }
  };
}

function getBudgetPlanDateConfirmMarkup(telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ To'g'ri", callback_data: `${BUDGET_PLAN_DATE_CONFIRM_PREFIX}${telegramId}` },
          { text: '✏️ Qayta kiritish', callback_data: `${BUDGET_PLAN_DATE_RETRY_PREFIX}${telegramId}` }
        ]
      ]
    }
  };
}

function getBudgetPlanManageMarkup(telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✏️ Kategoriya o'zgartirish", callback_data: `${BUDGET_PLAN_MANAGE_EDIT_PREFIX}${telegramId}` },
          { text: "➕ Yangi band qo'shish", callback_data: `${BUDGET_PLAN_MANAGE_ADD_PREFIX}${telegramId}` }
        ],
        [
          { text: "📅 Muddatni o'zgartirish", callback_data: `${BUDGET_PLAN_MANAGE_DATE_PREFIX}${telegramId}` }
        ]
      ]
    }
  };
}

function getPlanGoalCancelMarkup() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Bekor qilish', callback_data: PLAN_GOAL_CANCEL_CALLBACK }]
      ]
    }
  };
}

function getPaymentReviewMarkup(telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Tasdiqlash', callback_data: `${PAYMENT_CONFIRM_PREFIX}${telegramId}` },
          { text: '❌ Rad etish', callback_data: `${PAYMENT_REJECT_PREFIX}${telegramId}` }
        ]
      ]
    }
  };
}

function parsePaymentReviewCallback(data) {
  const value = String(data || '');

  if (value.startsWith(PAYMENT_CONFIRM_PREFIX)) {
    return {
      action: 'confirm',
      telegramId: value.slice(PAYMENT_CONFIRM_PREFIX.length)
    };
  }

  if (value.startsWith(PAYMENT_REJECT_PREFIX)) {
    return {
      action: 'reject',
      telegramId: value.slice(PAYMENT_REJECT_PREFIX.length)
    };
  }

  return null;
}

function parseBudgetPlanCallback(data) {
  const value = String(data || '');

  if (value.startsWith(BUDGET_PLAN_START_PREFIX)) {
    return {
      action: 'start',
      telegramId: value.slice(BUDGET_PLAN_START_PREFIX.length)
    };
  }

  if (value.startsWith(BUDGET_PLAN_SKIP_PREFIX)) {
    return {
      action: 'skip',
      telegramId: value.slice(BUDGET_PLAN_SKIP_PREFIX.length)
    };
  }

  if (value.startsWith(BUDGET_PLAN_CANCEL_PREFIX)) {
    return {
      action: 'cancel',
      telegramId: value.slice(BUDGET_PLAN_CANCEL_PREFIX.length)
    };
  }

  if (value.startsWith(BUDGET_PLAN_DATE_CONFIRM_PREFIX)) {
    return {
      action: 'dateConfirm',
      telegramId: value.slice(BUDGET_PLAN_DATE_CONFIRM_PREFIX.length)
    };
  }

  if (value.startsWith(BUDGET_PLAN_DATE_RETRY_PREFIX)) {
    return {
      action: 'dateRetry',
      telegramId: value.slice(BUDGET_PLAN_DATE_RETRY_PREFIX.length)
    };
  }

  return null;
}

function parseBudgetPlanManageCallback(data) {
  const value = String(data || '');
  const actions = [
    [BUDGET_PLAN_MANAGE_EDIT_PREFIX, 'edit'],
    [BUDGET_PLAN_MANAGE_ADD_PREFIX, 'add'],
    [BUDGET_PLAN_MANAGE_DATE_PREFIX, 'date']
  ];

  for (const [prefix, action] of actions) {
    if (value.startsWith(prefix)) {
      return {
        action,
        telegramId: value.slice(prefix.length)
      };
    }
  }

  return null;
}

function buildAdminCallback(prefix, page, telegramId = null) {
  const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
  return telegramId === null
    ? `${prefix}${safePage}`
    : `${prefix}${safePage}_${telegramId}`;
}

function parseAdminStatsCallback(data) {
  const value = String(data || '');
  const listMatch = value.match(/^adm_l_(\d+)$/);

  if (listMatch) {
    return {
      action: 'list',
      page: Number(listMatch[1])
    };
  }

  const actionMap = [
    [ADMIN_VIEW_PREFIX, 'view'],
    [ADMIN_DELETE_ASK_PREFIX, 'deleteAsk'],
    [ADMIN_DELETE_DO_PREFIX, 'deleteDo'],
    [ADMIN_DELETE_CANCEL_PREFIX, 'deleteCancel']
  ];

  for (const [prefix, action] of actionMap) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = value.match(new RegExp(`^${escapedPrefix}(\\d+)_(\\d+)$`));

    if (match) {
      return {
        action,
        page: Number(match[1]),
        telegramId: match[2]
      };
    }
  }

  return null;
}

function buildExpenseActionCallback(prefix, expenseId, telegramId) {
  return `${prefix}${expenseId}_${telegramId}`;
}

function parseExpenseActionCallback(data) {
  const value = String(data || '');
  const actionMap = [
    [EXPENSE_DELETE_CONFIRM_PREFIX, 'deleteConfirm'],
    [EXPENSE_DELETE_CANCEL_PREFIX, 'deleteCancel'],
    [EXPENSE_DELETE_PREFIX, 'deleteAsk'],
    [EXPENSE_EDIT_PREFIX, 'edit']
  ];

  for (const [prefix, action] of actionMap) {
    if (!value.startsWith(prefix)) {
      continue;
    }

    const payload = value.slice(prefix.length);
    const match = payload.match(/^([0-9a-fA-F-]{36})_(\d+)$/);

    if (match) {
      return {
        action,
        expenseId: match[1],
        telegramId: match[2]
      };
    }
  }

  return null;
}

function getExpenseActionMarkup(expense, telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '✏️ Tahrirlash',
            callback_data: buildExpenseActionCallback(EXPENSE_EDIT_PREFIX, expense.id, telegramId)
          },
          {
            text: "🗑️ O'chirish",
            callback_data: buildExpenseActionCallback(EXPENSE_DELETE_PREFIX, expense.id, telegramId)
          }
        ]
      ]
    }
  };
}

function getExpenseDeleteConfirmMarkup(expenseId, telegramId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Ha, o'chirish",
            callback_data: buildExpenseActionCallback(EXPENSE_DELETE_CONFIRM_PREFIX, expenseId, telegramId)
          },
          {
            text: 'Bekor qilish',
            callback_data: buildExpenseActionCallback(EXPENSE_DELETE_CANCEL_PREFIX, expenseId, telegramId)
          }
        ]
      ]
    }
  };
}

function formatUserName(user, from = {}) {
  return user?.full_name || userService.buildFullName(from) || 'Nomaʼlum';
}

function hasFullName(user) {
  return Boolean(String(user?.full_name || '').trim());
}

function getDisplayName(user) {
  return String(user?.full_name || '').trim() || "do'stim";
}

function formatDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('uz-UZ', {
    timeZone: process.env.BOT_TIMEZONE || 'Asia/Tashkent',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

function formatDateOnly(dateInput) {
  if (!dateInput) {
    return "Noma'lum";
  }

  const date = new Date(dateInput);

  if (!Number.isFinite(date.getTime())) {
    return "Noma'lum";
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.BOT_TIMEZONE || 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getRemainingDays(dateInput, now = new Date()) {
  if (!dateInput) {
    return null;
  }

  const date = new Date(dateInput);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / dayMs));
}

function formatRemainingDays(dateInput) {
  const remainingDays = getRemainingDays(dateInput);
  return remainingDays === null ? "Noma'lum" : `${remainingDays} kun`;
}

function getUserDailyLimit(user) {
  const storedLimit = Number(user?.daily_limit);

  if (Number.isInteger(storedLimit) && storedLimit > 0) {
    return storedLimit;
  }

  return user?.is_premium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
}

function getAiAnalysisLimitCost(user) {
  return user?.is_premium
    ? PREMIUM_AI_ANALYSIS_LIMIT_COST
    : FREE_AI_ANALYSIS_LIMIT_COST;
}

function getUserDailyVoiceLimit(user) {
  const storedLimit = Number(user?.daily_voice_limit);

  if (Number.isInteger(storedLimit) && storedLimit > 0) {
    return storedLimit;
  }

  return user?.is_premium ? PREMIUM_DAILY_VOICE_LIMIT : FREE_DAILY_VOICE_LIMIT;
}

function setUserState(telegramId, type, data = {}) {
  // Oddiy in-memory state botga navbatdagi xabar nimani anglatishini eslab turadi.
  userStates.set(String(telegramId), {
    type,
    data,
    createdAt: Date.now()
  });
}

function clearUserState(telegramId) {
  userStates.delete(String(telegramId));
}

function getUserState(telegramId) {
  const state = userStates.get(String(telegramId));

  if (!state) {
    return null;
  }

  const isExpired = Date.now() - state.createdAt > 30 * 60 * 1000; // Extended from 15 to 30 minutes
  if (isExpired) {
    clearUserState(telegramId);
    return null;
  }

  return state;
}

function isRateLimited(telegramId) {
  const now = Date.now();
  const bucket = rateBuckets.get(telegramId);

  if (!bucket || now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(telegramId, { startedAt: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_COUNT;
}

function parsePositiveAmount(text) {
  return parseAmount(text);
}

function isPlanGoalButtonText(text) {
  return String(text || '')
    .replace(/\uFE0F/g, '')
    .trim()
    .toLowerCase()
    .includes('reja va maqsad');
}

function normalizeKeyboardText(text) {
  return String(text || '')
    .replace(/\uFE0F/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getMainKeyboardAction(text) {
  const normalizedText = normalizeKeyboardText(text);

  if (normalizedText.includes('hisobot')) {
    return 'report';
  }

  if (normalizedText.includes('maosh')) {
    return 'salary';
  }

  if (normalizedText.includes('ai tahlil')) {
    return 'analysis';
  }

  if (normalizedText.includes('sozlamalar')) {
    return 'settings';
  }

  if (normalizedText === normalizeKeyboardText(BUDGET_PLAN_BUTTON_TEXT) || normalizedText.includes('rejam')) {
    return 'budgetPlan';
  }

  if (isPlanGoalButtonText(normalizedText)) {
    return 'planGoal';
  }

  return null;
}

function isMainKeyboardButtonText(text) {
  return Boolean(getMainKeyboardAction(text));
}

function formatReportExpenseNote(expense) {
  return String(expense?.note || '').trim() || expense?.category || 'Xarajat';
}

function getTopExpenseLines(expenses = []) {
  const expenseItems = expenses
    .filter((expense) => expense?.type !== 'income')
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));

  if (expenseItems.length < 3) {
    return [];
  }

  return expenseItems
    .slice(0, 3)
    .map((expense, index) => `${index + 1}. ${formatReportExpenseNote(expense)} — ${formatMoney(expense.amount)}`);
}

function formatReport(user, summary) {
  const salary = Number(user.current_salary || 0);
  const totalSpent = Number(summary.totalSpent || 0);
  const totalIncome = Number(summary.totalIncome || 0);
  const balance = salary - totalSpent + totalIncome;
  const categoryLines = Object.entries(summary.byCategory)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([category, amount]) => `- ${category}: ${formatMoney(amount)}`);

  const percent = salary > 0 ? Math.round((totalSpent / salary) * 100) : 0;
  const topExpenseLines = getTopExpenseLines(summary.expenses);
  const topExpensesBlock = topExpenseLines.length
    ? ['', '🔝 Eng katta xarajatlar:', topExpenseLines.join('\n')]
    : [];

  return [
    `📊 ${summary.month} hisobot`,
    '',
    `Maosh: ${formatMoney(salary)}`,
    `➕ Qo'shimcha kirim: ${formatMoney(totalIncome)}`,
    `Jami xarajat: ${formatMoney(totalSpent)}${salary > 0 ? ` (${percent}%)` : ''}`,
    `Qolgan balans: ${formatMoney(balance)}`,
    '',
    'Kategoriyalar:',
    categoryLines.length ? categoryLines.join('\n') : "- Hali xarajat yo'q",
    ...topExpensesBlock
  ].join('\n');
}

function buildSalarySavedText(salary) {
  return [
    `Maosh saqlandi: ${formatMoney(salary)} ✅`,
    '',
    'Xarajat yoki kirimni oddiy matn bilan yozing:',
    '📝 "25000 nonga" — xarajat',
    '📝 "50000 qarzim qaytdi" — kirim',
    '',
    '🆓 Bepul: 15 xarajat, 2 ovozli/kun',
    '💎 Premium: 50 xarajat, 10 ovozli/kun — /premium_narxi'
  ].join('\n');
}

function buildSalaryBudgetPromptText(salary) {
  return [
    `✅ Maosh: ${formatMoney(salary)}`,
    '',
    'Xarajatlaringizni reja asosida kuzatishni xohlaysizmi?',
    "Reja bo'lsa, bot xarajatlaringizni belgilangan muddat va summalar bilan solishtirib, oshib ketsa ogohlantiradi."
  ].join('\n');
}

function buildSalaryUpdatedWithPlanText(salary, progress) {
  const outsideAmount = Number(salary || 0) - Number(progress?.totalPlanned || 0);

  return [
    `✅ Maosh yangilandi: ${formatMoney(salary)}`,
    '',
    "Joriy rejangiz o'zgarmadi, faqat 'rejadan tashqari qoladigan' summa qayta hisoblandi:",
    formatMoney(outsideAmount)
  ].join('\n');
}

function buildBudgetPlanDatePromptText() {
  return [
    "Reja qaysi muddatga bo'lsin? Sana oralig'ini yozing.",
    'Masalan: 12-iyundan 15-iyulgacha'
  ].join('\n');
}

function buildBudgetPlanDateRetryText() {
  return "Sana oralig'ini qayta yozing:";
}

function parseBudgetDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function formatBudgetPlanHumanDate(value, options = {}) {
  const { includeYear = true } = options;
  const parts = parseBudgetDateKey(value);
  const monthNames = [
    'yanvar',
    'fevral',
    'mart',
    'aprel',
    'may',
    'iyun',
    'iyul',
    'avgust',
    'sentabr',
    'oktabr',
    'noyabr',
    'dekabr'
  ];

  if (!parts || parts.month < 1 || parts.month > 12) {
    return budgetPlanService.formatDate(value);
  }

  const base = `${parts.day}-${monthNames[parts.month - 1]}`;
  return includeYear ? `${base} ${parts.year}` : base;
}

function formatBudgetPlanDateRange(startDate, endDate) {
  const startParts = parseBudgetDateKey(startDate);
  const endParts = parseBudgetDateKey(endDate);

  if (startParts && endParts && startParts.year === endParts.year) {
    return `${formatBudgetPlanHumanDate(startDate, { includeYear: false })} — ${formatBudgetPlanHumanDate(endDate, { includeYear: false })} ${endParts.year}`;
  }

  return `${formatBudgetPlanHumanDate(startDate)} — ${formatBudgetPlanHumanDate(endDate)}`;
}

function buildBudgetPlanDateConfirmText(dateRange) {
  return `Muddat: ${formatBudgetPlanDateRange(dateRange.startDate, dateRange.endDate)}. To'g'rimi?`;
}

function buildBudgetPlanItemsPromptText(startDate, endDate) {
  return [
    `✅ Muddat: ${formatBudgetPlanDateRange(startDate, endDate)}`,
    '',
    "Endi shu muddat uchun taxminiy xarajatlaringizni yozing. Kategoriya nomlarini bilish shart emas - oddiy tilda yozing, men o'zim tushunaman.",
    '',
    'Barchasini BITTA xabarda yuboring. Misol:',
    "'Ovqatga 800000, taxiga 300000, kvartiraga 1200000, telefon uchun 200000'"
  ].join('\n');
}

function buildBudgetPlanContinueText(stateData = {}) {
  const dateText = formatBudgetPlanDateRange(stateData.startDate, stateData.endDate);

  return [
    `Siz hozir reja tuzish jarayonidasiz (muddat: ${dateText}).`,
    "Davom etish uchun taxminiy xarajatlaringizni oddiy tilda yozing, yoki bekor qilish uchun tugmani bosing:",
    '',
    "Misol: 'Ovqatga 800000, taxiga 300000, kvartiraga 1200000'"
  ].join('\n');
}

function getPlanItemAmount(item) {
  return Number(item?.planned_amount ?? item?.plannedAmount ?? 0);
}

function formatBudgetPlanItemList(items = []) {
  return items.map((item, index) => (
    `${index + 1}. ${item.category} — ${formatMoney(getPlanItemAmount(item))}`
  )).join('\n');
}

function buildBudgetPlanSavedText(plan, salary) {
  const items = plan.items || [];
  const totalPlanned = items.reduce((sum, item) => sum + getPlanItemAmount(item), 0);
  const outsideAmount = Number(salary || 0) - totalPlanned;

  return [
    `✅ Rejangiz saqlandi (${formatBudgetPlanDateRange(plan.start_date, plan.end_date)}):`,
    '',
    formatBudgetPlanItemList(items),
    '',
    `Jami reja: ${formatMoney(totalPlanned)}`,
    `Maoshingiz: ${formatMoney(salary)}`,
    `Rejadan tashqari qoladigan: ${formatMoney(outsideAmount)}`,
    '',
    "Xarajatlaringizni yozib boring — men reja bilan solishtirib turaman."
  ].join('\n');
}

function formatBudgetProgressLine(item) {
  const plannedAmount = Number(item.plannedAmount || 0);
  const isLimitReached = Boolean(item.isLimitReached)
    || (plannedAmount > 0 && Number(item.spent || 0) >= plannedAmount);
  const statusText = isLimitReached
    ? `${formatMoney(item.overAmount)} oshgan`
    : `${formatMoney(item.remainingAmount)} qoldi`;
  const prefix = isLimitReached ? '⚠️ Reja:' : '📆 Reja:';

  return `${prefix} ${item.category} ${formatMoney(item.spent)} / ${formatMoney(item.plannedAmount)} (${item.percent}%, ${statusText})`;
}

function formatBudgetPlanProgressItem(item, index) {
  return `${index + 1}. ${formatBudgetProgressLine(item)}`;
}

function buildBudgetPlanViewText(progress, salary = 0) {
  const unplannedLines = (progress.unplannedItems || []).map((item) => (
    `- ${item.category} — ${formatMoney(item.spent)}`
  ));
  const totalPlanned = (progress.items || []).reduce(
    (sum, item) => sum + Number(item.plannedAmount || 0),
    0
  );
  const plannedSpent = (progress.items || []).reduce(
    (sum, item) => sum + Number(item.spent || 0),
    0
  );
  const unplannedSpent = (progress.unplannedItems || []).reduce(
    (sum, item) => sum + Number(item.spent || 0),
    0
  );
  const totalSpent = plannedSpent + unplannedSpent;
  const totalPercent = totalPlanned > 0 ? Math.round((totalSpent / totalPlanned) * 100) : 0;
  const totalStatus = totalSpent > totalPlanned
    ? `⚠️ Rejadan ${formatMoney(totalSpent - totalPlanned)}ga oshib ketdingiz`
    : `✅ Reja bo'yicha qolgan: ${formatMoney(totalPlanned - totalSpent)}`;
  const currentSalary = Number(salary || 0);
  const outsidePlanAmount = currentSalary - totalPlanned;
  const outsidePlanStatus = outsidePlanAmount < 0
    ? `⚠️ Rejangiz maoshingizdan ${formatMoney(Math.abs(outsidePlanAmount))}ga ko'p! Byudjetingizni qayta ko'rib chiqing.`
    : `📈 Rejadan tashqari qoladigan: ${formatMoney(outsidePlanAmount)}`;

  return [
    `📆 Joriy reja (${formatBudgetPlanDateRange(progress.plan.start_date, progress.plan.end_date)}):`,
    '',
    progress.items.map(formatBudgetPlanProgressItem).join('\n'),
    unplannedLines.length ? '' : null,
    unplannedLines.length ? 'Rejadan tashqari xarajatlar:' : null,
    unplannedLines.length ? unplannedLines.join('\n') : null,
    '',
    '━━━━━━━━━━━━━━━',
    `📊 Jami reja: ${formatMoney(totalPlanned)}`,
    `💸 Jami sarflangan: ${formatMoney(totalSpent)} (${totalPercent}%)`,
    totalStatus,
    '',
    `💰 Maoshingiz: ${formatMoney(currentSalary)}`,
    outsidePlanStatus
  ].filter((line) => line !== null).join('\n');
}

function formatBudgetWarningLines(warnings = []) {
  return warnings.map(formatBudgetProgressLine);
}

function buildNamePromptText() {
  return "Assalomu alaykum! Men sizning shaxsiy moliyaviy yordamchingizman. Avval ismingizni bilsam bo'ladimi?";
}

function buildSalaryPromptText(name) {
  return `Xush kelibsiz, ${name}! Endi oylik maoshingizni kiriting (so'mda). Masalan: 5000000`;
}

function buildStartWelcomeText(user) {
  return [
    `Xush kelibsiz, ${getDisplayName(user)}! Xarajat yoki kirimni yozing.`,
    '',
    'Hisobot, maosh va tahlil uchun pastdagi tugmalardan foydalaning.'
  ].join('\n');
}

function buildPremiumPriceText() {
  return [
    `💎 Premium — ${formatPaymentPrice()} so'm/oy`,
    '',
    '📝 50 ta matn/kun',
    '🎤 10 ta ovozli/kun',
    '🎯 Reja va Maqsad tahlili',
    '',
    `💳 Karta: ${getPaymentCardNumber()}`,
    "To'lovdan keyin pastdagi tugma orqali chek yuboring."
  ].join('\n');
}

function buildPlanGoalPremiumOnlyText() {
  return [
    '🎯 Reja va Maqsad faqat premiumda.',
    'Premium: /premium_narxi'
  ].join('\n');
}

function buildPlanGoalIntroText() {
  return [
    '🎯 Reja va Maqsad',
    '',
    "⚠️ Bu ma'lumot saqlanmaydi va limitdan 15 ta hisoblanadi.",
    '',
    "Avval keyingi oy daromadini yozing (so'mda)."
  ].join('\n');
}

function buildPlanGoalIncomeSavedText(income) {
  return [
    `✅ Daromad: ${formatMoney(income)}`,
    '',
    'Endi reja va maqsadingizni yozing. Misol:',
    "'Oziq-ovqat 800000, Uy-joy 1200000. Telefon 2.5mln, 3 oyga 836000 dan bo'lib to'lash mumkinmi?'"
  ].join('\n');
}

function buildPlanGoalLimitRequiredText(remainingLimit) {
  return [
    `🎯 Reja tahlili uchun ${PLAN_GOAL_LIMIT_COST} ta limit kerak.`,
    `Bugun qolgan: ${remainingLimit}. Ertaga qayta urinib ko'ring.`
  ].join('\n');
}

function buildPlanGoalResultText(analysisText) {
  return [
    '📊 Tahlil natijasi:',
    '',
    String(analysisText || '').trim(),
    '',
    "⚠️ Bu ma'lumot saqlanmadi."
  ].join('\n');
}

function buildLimitReachedText(dailyLimit) {
  return [
    `Bugungi bepul limit tugadi (${dailyLimit} ta).`,
    `💎 Premium: ${formatPaymentPrice()} so'm/oy`,
    '📝 50 ta matn/kun, 🎤 10 ta ovozli/kun',
    '',
    `💳 Karta: ${getPaymentCardNumber()}`,
    "To'lovdan keyin pastdagi tugma orqali chek yuboring."
  ].join('\n');
}

function buildFreeVoiceLimitReachedText(usedCount, dailyVoiceLimit) {
  return [
    `🎤 Bugungi ovozli limit tugadi (${usedCount}/${dailyVoiceLimit}).`,
    `💎 Premium: ${formatPaymentPrice()} so'm/oy`,
    '🎤 10 ta ovozli/kun',
    '',
    `💳 Karta: ${getPaymentCardNumber()}`,
    "Yoki matn bilan yozing: 25000 nonga."
  ].join('\n');
}

function buildPremiumVoiceLimitReachedText(usedCount, dailyVoiceLimit) {
  return [
    `🎤 Bugungi ovozli limit tugadi (${usedCount}/${dailyVoiceLimit}).`,
    'Ertaga yana foydalanishingiz mumkin. Hozircha matn bilan yozing.'
  ].join('\n');
}

function buildSettingsText(user, todayExpenseCount) {
  const dailyLimit = getUserDailyLimit(user);

  if (user?.is_premium) {
    return [
      '⚙️ Sozlamalar',
      '',
      '💎 Status: Premium',
      `📅 Tugash sanasi: ${formatDateOnly(user.premium_expires_at)}`,
      `⏳ Qolgan kunlar: ${formatRemainingDays(user.premium_expires_at)}`,
      `📊 Bugun: ${todayExpenseCount}/${dailyLimit}`,
      `📥 Excel eksport: ${EXCEL_EXPORT_LIMIT_COST} ta limit`,
      '',
      'Kerakli amalni tanlang:'
    ].join('\n');
  }

  return [
    '⚙️ Sozlamalar',
    '',
    '🆓 Status: Bepul',
    `📊 Bugun: ${todayExpenseCount}/${dailyLimit}`,
    '',
    'Kerakli amalni tanlang:'
  ].join('\n');
}

function formatStatsUserName(user) {
  return user?.full_name || `Telegram ID ${user?.telegram_id || "noma'lum"}`;
}

function formatStatsStatus(user) {
  if (!user?.is_premium) {
    return 'Oddiy';
  }

  if (!user.premium_expires_at) {
    return 'Premium';
  }

  return `Premium (tugaydi: ${formatDateOnly(user.premium_expires_at)})`;
}

function formatStatsShortStatus(user) {
  return user?.is_premium ? 'Premium' : 'Oddiy';
}

function truncateButtonText(text, maxLength = 58) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function getStatsTotalPages(users) {
  return Math.max(1, Math.ceil(users.length / ADMIN_USERS_PAGE_SIZE));
}

function clampStatsPage(page, users) {
  const parsedPage = Math.max(0, Number.parseInt(page, 10) || 0);
  return Math.min(parsedPage, getStatsTotalPages(users) - 1);
}

function buildStatsHeader(users, todayAiUsageCount, notice = null) {
  const totalUsers = users.length;
  const premiumCount = users.filter((user) => user.is_premium).length;
  const regularCount = totalUsers - premiumCount;
  const lines = [];

  if (notice) {
    lines.push(notice, '');
  }

  lines.push(
    '📊 Bot statistikasi',
    '',
    `👥 Jami foydalanuvchilar: ${totalUsers}`,
    `💎 Premium: ${premiumCount}`,
    `🆓 Oddiy: ${regularCount}`,
    '',
    `🤖 Bugun AI so'rovlari: ${todayAiUsageCount}/500`,
    '',
    users.length
      ? 'Foydalanuvchini boshqarish uchun tanlang:'
      : "Hali foydalanuvchi yo'q."
  );

  return lines.join('\n');
}

function buildAdminUserButtonText(user) {
  const todayCount = userService.getDailyUsageCount(user, 'text');
  const dailyLimit = getUserDailyLimit(user);

  return truncateButtonText(
    `${formatStatsUserName(user)} — ${formatStatsShortStatus(user)} — bugun ${todayCount}/${dailyLimit}`
  );
}

function buildStatsKeyboard(users, page) {
  const currentPage = clampStatsPage(page, users);
  const startIndex = currentPage * ADMIN_USERS_PAGE_SIZE;
  const pageUsers = users.slice(startIndex, startIndex + ADMIN_USERS_PAGE_SIZE);
  const rows = pageUsers
    .filter((user) => user?.telegram_id)
    .map((user) => ([{
      text: buildAdminUserButtonText(user),
      callback_data: buildAdminCallback(ADMIN_VIEW_PREFIX, currentPage, user.telegram_id)
    }]));

  const navigationRow = [];

  if (currentPage > 0) {
    navigationRow.push({
      text: '⬅️ Oldingi',
      callback_data: buildAdminCallback(ADMIN_LIST_PREFIX, currentPage - 1)
    });
  }

  if (currentPage < getStatsTotalPages(users) - 1) {
    navigationRow.push({
      text: 'Keyingi ➡️',
      callback_data: buildAdminCallback(ADMIN_LIST_PREFIX, currentPage + 1)
    });
  }

  if (navigationRow.length) {
    rows.push(navigationRow);
  }

  return rows;
}

function buildStatsMessage(users, todayAiUsageCount, page = 0, notice = null) {
  const currentPage = clampStatsPage(page, users);

  return {
    text: buildStatsHeader(users, todayAiUsageCount, notice),
    options: {
      reply_markup: {
        inline_keyboard: buildStatsKeyboard(users, currentPage)
      }
    },
    page: currentPage
  };
}

function buildAdminUserDetailsText(user) {
  const todayCount = userService.getDailyUsageCount(user, 'text');
  const todayVoiceCount = userService.getDailyUsageCount(user, 'voice');
  const dailyLimit = getUserDailyLimit(user);
  const dailyVoiceLimit = getUserDailyVoiceLimit(user);

  return [
    `👤 ${formatStatsUserName(user)}`,
    `Telegram ID: ${user.telegram_id}`,
    `Status: ${formatStatsStatus(user)}`,
    `Bugungi limit: ${todayCount}/${dailyLimit} (matn), ${todayVoiceCount}/${dailyVoiceLimit} (ovoz)`,
    `Ro'yxatdan o'tgan: ${formatDateOnly(user.created_at)}`,
    '',
    'Amalni tanlang:'
  ].join('\n');
}

function buildAdminUserDetailsMarkup(user, page) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{
          text: "🗑️ Foydalanuvchini o'chirish",
          callback_data: buildAdminCallback(ADMIN_DELETE_ASK_PREFIX, page, user.telegram_id)
        }],
        [{
          text: '⬅️ Ortga',
          callback_data: buildAdminCallback(ADMIN_LIST_PREFIX, page)
        }]
      ]
    }
  };
}

function buildAdminDeleteConfirmText(user) {
  return [
    `⚠️ Rostdan ham ${formatStatsUserName(user)} ni butunlay o'chirmoqchimisiz?`,
    "Uning barcha ma'lumotlari (yozuvlar, tarix, profil) o'chadi va qaytarib bo'lmaydi."
  ].join('\n');
}

function buildAdminDeleteConfirmMarkup(user, page) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Ha, o'chirish",
            callback_data: buildAdminCallback(ADMIN_DELETE_DO_PREFIX, page, user.telegram_id)
          },
          {
            text: 'Bekor qilish',
            callback_data: buildAdminCallback(ADMIN_DELETE_CANCEL_PREFIX, page, user.telegram_id)
          }
        ]
      ]
    }
  };
}

function formatExpenseLabel(expense) {
  const note = String(expense?.note || '').trim();
  const label = note || expense?.category || (expense?.type === 'income' ? 'Kirim' : 'Xarajat');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function isIncomeTransaction(transaction) {
  return transaction?.type === 'income';
}

function getTransactionKindLabel(transaction) {
  return isIncomeTransaction(transaction) ? 'Kirim' : 'Xarajat';
}

function formatTransactionAmount(transaction) {
  const prefix = isIncomeTransaction(transaction) ? '+' : '';
  return `${prefix}${formatMoney(transaction?.amount)}`;
}

function isUnusualExpense(expense, previousExpenses = []) {
  if (isIncomeTransaction(expense) || previousExpenses.length < 3) {
    return false;
  }

  const total = previousExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const average = total / previousExpenses.length;

  return average > 0 && Number(expense.amount || 0) >= average * 3;
}

function getExpenseItems(expenses = []) {
  return expenses.filter((expense) => expense?.type !== 'income');
}

function buildSkippedExpensesText(skippedCount) {
  return skippedCount > 0
    ? `Limit tugagani sababli ${skippedCount} ta operatsiya saqlanmadi.`
    : null;
}

function buildSavedExpensesText(savedExpenses, balance, skippedCount = 0, options = {}) {
  const skippedText = buildSkippedExpensesText(skippedCount);
  const unusualWarning = options.hasUnusualExpense && savedExpenses.some((expense) => !isIncomeTransaction(expense))
    ? "⚠️ Bu odatdagidan ancha katta xarajat, diqqat bilan kuzating."
    : null;
  const budgetWarningLines = formatBudgetWarningLines(options.budgetWarnings);
  const budgetWarningsText = budgetWarningLines.length ? budgetWarningLines.join('\n') : null;

  if (savedExpenses.length === 1) {
    const savedExpense = savedExpenses[0];

    if (isIncomeTransaction(savedExpense)) {
      return [
        `✅ Kirim qo'shildi: +${formatMoney(savedExpense.amount)}`,
        `Izoh: ${savedExpense.note || 'Kirim'}`,
        `Yangi balans: ${formatMoney(balance)}`,
        unusualWarning ? '' : null,
        unusualWarning,
        budgetWarningsText ? '' : null,
        budgetWarningsText,
        skippedText ? '' : null,
        skippedText
      ].filter((line) => line !== null).join('\n');
    }

    return [
      `✅ Saqlandi: ${formatMoney(savedExpense.amount)}`,
      `Kategoriya: ${savedExpense.category}`,
      `Qolgan balans: ${formatMoney(balance)}`,
      unusualWarning ? '' : null,
      unusualWarning,
      budgetWarningsText ? '' : null,
      budgetWarningsText,
      skippedText ? '' : null,
      skippedText
    ].filter((line) => line !== null).join('\n');
  }

  const totalExpense = savedExpenses
    .filter((expense) => !isIncomeTransaction(expense))
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const totalIncome = savedExpenses
    .filter(isIncomeTransaction)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const hasExpense = totalExpense > 0;
  const hasIncome = totalIncome > 0;
  const heading = hasExpense && hasIncome
    ? `✅ ${savedExpenses.length} ta operatsiya saqlandi:`
    : hasIncome
      ? `✅ ${savedExpenses.length} ta kirim saqlandi:`
      : `✅ ${savedExpenses.length} ta xarajat saqlandi:`;
  const expenseLines = savedExpenses.map((expense, index) => (
    `${index + 1}. ${formatExpenseLabel(expense)} — ${formatTransactionAmount(expense)} (${expense.category})`
  ));

  return [
    heading,
    '',
    expenseLines.join('\n'),
    '',
    hasExpense ? `Jami xarajat: ${formatMoney(totalExpense)}` : null,
    hasIncome ? `Qo'shimcha kirim: ${formatMoney(totalIncome)}` : null,
    hasIncome ? `Yangi balans: ${formatMoney(balance)}` : `Qolgan balans: ${formatMoney(balance)}`,
    unusualWarning ? '' : null,
    unusualWarning,
    budgetWarningsText ? '' : null,
    budgetWarningsText,
    skippedText ? '' : null,
    skippedText
  ].filter((line) => line !== null).join('\n');
}

async function getCurrentBalance(user, month = user?.current_month || userService.getMonthKey()) {
  const summary = await expenseService.getMonthlySummary(user.id, month);
  return Number(user.current_salary || 0)
    - Number(summary.totalSpent || 0)
    + Number(summary.totalIncome || 0);
}

function formatExcelDate(dateInput) {
  if (!dateInput) {
    return '';
  }

  const date = new Date(dateInput);

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('uz-UZ', {
    timeZone: process.env.BOT_TIMEZONE || 'Asia/Tashkent',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function getExcelReportFileName(month) {
  const safeMonth = String(month || userService.getMonthKey()).replace(/[^\w-]/g, '_');
  return `hisobot_${safeMonth}.xlsx`;
}

async function buildExcelReportBuffer(summary) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MBot';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Hisobot');
  worksheet.columns = [
    { header: 'Sana', key: 'date', width: 18 },
    { header: 'Turi', key: 'type', width: 10 },
    { header: 'Summa', key: 'amount', width: 14 },
    { header: 'Kategoriya', key: 'category', width: 20 },
    { header: 'Izoh', key: 'note', width: 32 }
  ];

  worksheet.getRow(1).font = { bold: true };

  const rows = [...(summary.expenses || [])]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  for (const expense of rows) {
    worksheet.addRow({
      date: formatExcelDate(expense.created_at),
      type: isIncomeTransaction(expense) ? 'Kirim' : 'Chiqim',
      amount: Number(expense.amount || 0),
      category: expense.category || '',
      note: expense.note || ''
    });
  }

  worksheet.getColumn('amount').numFmt = '#,##0';

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function sendExcelReport(bot, chatId, user) {
  if (!user?.is_premium) {
    await bot.sendMessage(chatId, 'Bu funksiya faqat premium uchun. /premium_narxi', MAIN_KEYBOARD);
    return;
  }

  const dailyLimit = getUserDailyLimit(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');
  const remainingLimit = Math.max(0, dailyLimit - todayUsageCount);

  if (remainingLimit < EXCEL_EXPORT_LIMIT_COST) {
    await bot.sendMessage(
      chatId,
      `Excel hisobot uchun ${EXCEL_EXPORT_LIMIT_COST} ta limit kerak, lekin sizda bugun faqat ${remainingLimit} ta qoldi. Ertaga qayta urinib ko'ring.`,
      MAIN_KEYBOARD
    );
    return;
  }

  const month = user.current_month || userService.getMonthKey();
  const summary = await expenseService.getMonthlySummary(user.id, month);
  const fileName = getExcelReportFileName(month);
  const buffer = await buildExcelReportBuffer(summary);

  await bot.sendDocument(
    chatId,
    buffer,
    { caption: `📥 ${month} hisobot` },
    {
      filename: fileName,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
  );

  await userService.incrementDailyUsage(user, EXCEL_EXPORT_LIMIT_COST, 'text');
}

async function sendLongMessage(bot, chatId, text) {
  const chunks = [];
  const maxLength = 3800;
  let remaining = text;

  while (remaining.length > maxLength) {
    const sliceAt = remaining.lastIndexOf('\n', maxLength);
    const end = sliceAt > 500 ? sliceAt : maxLength;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, MAIN_KEYBOARD);
  }
}

async function editCallbackMessageText(bot, query, text, options = {}) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    return;
  }

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (error) {
    const message = String(error?.message || '');

    if (!message.includes('message is not modified') && !message.includes('message to edit not found')) {
      throw error;
    }
  }
}

async function getStatsData() {
  const [users, todayAiUsageCount] = await Promise.all([
    userService.getAllUsers(),
    apiUsageService.getTodayApiUsageCount()
  ]);

  return { users, todayAiUsageCount };
}

async function editStatsListMessage(bot, query, page = 0, notice = null) {
  const { users, todayAiUsageCount } = await getStatsData();
  const message = buildStatsMessage(users, todayAiUsageCount, page, notice);
  await editCallbackMessageText(bot, query, message.text, message.options);
}

async function handleStart(bot, msg) {
  const chatId = getChatId(msg);

  try {
    const user = await userService.ensureUser(msg.from);
    const telegramId = getTelegramId(msg.from);

    if (!hasFullName(user)) {
      setUserState(telegramId, 'awaiting_start_name');
      await bot.sendMessage(
        chatId,
        buildNamePromptText(),
        MAIN_KEYBOARD
      );
      return;
    }

    if (Number(user.current_salary || 0) <= 0) {
      setUserState(telegramId, 'awaiting_salary');
      await bot.sendMessage(
        chatId,
        buildSalaryPromptText(getDisplayName(user)),
        MAIN_KEYBOARD
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      buildStartWelcomeText(user),
      MAIN_KEYBOARD
    );
  } catch (error) {
    console.error('/start xatosi:', error);
    await bot.sendMessage(chatId, "Botni ishga tushirishda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.");
  }
}

async function handleReport(bot, chatId, user) {
  const summary = await expenseService.getMonthlySummary(user.id, user.current_month || userService.getMonthKey());
  await bot.sendMessage(chatId, formatReport(user, summary), MAIN_KEYBOARD);
}

async function handleAnalysis(bot, chatId, user) {
  const dailyLimit = getUserDailyLimit(user);
  const analysisLimitCost = getAiAnalysisLimitCost(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');
  const remainingLimit = Math.max(0, dailyLimit - todayUsageCount);

  if (remainingLimit < analysisLimitCost) {
    const retryText = user?.is_premium
      ? "Ertaga qayta urinib ko'ring."
      : "Ertaga qayta urinib ko'ring yoki /premium_narxi orqali premium tarifga o'ting.";

    await bot.sendMessage(
      chatId,
      `AI Tahlil uchun ${analysisLimitCost} ta limit kerak, lekin sizda bugun faqat ${remainingLimit} ta qoldi (jami ${dailyLimit} tadan). ${retryText}`,
      MAIN_KEYBOARD
    );
    return;
  }

  try {
    await bot.sendMessage(chatId, "Tahlil tayyorlanmoqda, bir necha soniya kuting...", MAIN_KEYBOARD);
    const adviceData = await expenseService.getAdviceData(user);
    const advice = await generateAdvice(adviceData);
    await userService.incrementDailyUsage(user, analysisLimitCost, 'text');
    await sendLongMessage(bot, chatId, advice || "Hozir tahlil qila olmadim, birozdan keyin qayta urinib ko'ring");
  } catch (error) {
    console.error('Tahlil tayyorlashda xato:', error);
    await bot.sendMessage(
      chatId,
      error.userMessage || "Hozir tahlil qila olmadim, birozdan keyin qayta urinib ko'ring",
      MAIN_KEYBOARD
    );
  }
}

async function handlePlanGoalStart(bot, chatId, telegramId, user) {
  if (!user?.is_premium) {
    await bot.sendMessage(chatId, buildPlanGoalPremiumOnlyText(), MAIN_KEYBOARD);
    return;
  }

  const dailyLimit = getUserDailyLimit(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');
  const remainingLimit = Math.max(0, dailyLimit - todayUsageCount);

  if (remainingLimit < PLAN_GOAL_LIMIT_COST) {
    await bot.sendMessage(chatId, buildPlanGoalLimitRequiredText(remainingLimit), MAIN_KEYBOARD);
    return;
  }

  clearUserState(telegramId);
  setUserState(telegramId, 'awaiting_plan_goal_income');
  await bot.sendMessage(chatId, buildPlanGoalIntroText(), getPlanGoalCancelMarkup());
}

async function handlePlanGoalIncomeInput(bot, chatId, telegramId, user, text) {
  if (!user?.is_premium) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildPlanGoalPremiumOnlyText(), MAIN_KEYBOARD);
    return;
  }

  const dailyLimit = getUserDailyLimit(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');
  const remainingLimit = Math.max(0, dailyLimit - todayUsageCount);

  if (remainingLimit < PLAN_GOAL_LIMIT_COST) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildPlanGoalLimitRequiredText(remainingLimit), MAIN_KEYBOARD);
    return;
  }

  const income = parsePositiveAmount(text);

  if (!income) {
    await bot.sendMessage(chatId, AMOUNT_PARSE_ERROR_TEXT, getPlanGoalCancelMarkup());
    return;
  }

  setUserState(telegramId, 'awaiting_plan_goal_text', { planIncome: income });
  await bot.sendMessage(chatId, buildPlanGoalIncomeSavedText(income), getPlanGoalCancelMarkup());
}

async function handlePlanGoalInput(bot, chatId, telegramId, user, stateData, text) {
  const planText = String(text || '').trim();
  const planIncome = Number(stateData?.planIncome || 0);

  if (!user?.is_premium) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildPlanGoalPremiumOnlyText(), MAIN_KEYBOARD);
    return;
  }

  if (!Number.isFinite(planIncome) || planIncome <= 0) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Reja tahlili sessiyasi eskirgan. Iltimos, '🎯 Reja va Maqsad' tugmasini qayta bosing.", MAIN_KEYBOARD);
    return;
  }

  if (!planText || planText.length < 10) {
    await bot.sendMessage(chatId, "Rejangizni biroz batafsilroq yozing. Masalan: Oziq-ovqat 800000, Transport 300000, Maqsad: telefon.", getPlanGoalCancelMarkup());
    return;
  }

  if (planText.length > 1200) {
    await bot.sendMessage(chatId, "Reja matni juda uzun. Iltimos, 1200 belgidan oshirmay qisqaroq yozing.", getPlanGoalCancelMarkup());
    return;
  }

  const dailyLimit = getUserDailyLimit(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');
  const remainingLimit = Math.max(0, dailyLimit - todayUsageCount);

  if (remainingLimit < PLAN_GOAL_LIMIT_COST) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildPlanGoalLimitRequiredText(remainingLimit), MAIN_KEYBOARD);
    return;
  }

  try {
    await bot.sendMessage(chatId, "Rejangiz AI orqali tahlil qilinmoqda, bir necha soniya kuting...", MAIN_KEYBOARD);

    const month = user.current_month || userService.getMonthKey();
    const summary = await expenseService.getMonthlySummary(user.id, month);
    const analysis = await generatePlanGoalAnalysis({
      planText,
      salary: planIncome,
      totalSpent: Number(summary.netSpent || 0)
    });

    await userService.incrementDailyUsage(user, PLAN_GOAL_LIMIT_COST, 'text');
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildPlanGoalResultText(analysis), MAIN_KEYBOARD);
  } catch (error) {
    console.error('Reja va Maqsad tahlilida xato:', error);
    clearUserState(telegramId);

    await bot.sendMessage(
      chatId,
      error.userMessage || "Hozir reja tahlilini qila olmadim, birozdan keyin qayta urinib ko'ring.",
      MAIN_KEYBOARD
    );
  }
}

async function startBudgetPlanSetup(bot, chatId, telegramId) {
  clearUserState(telegramId);
  setUserState(telegramId, 'awaiting_budget_plan_dates');
  await bot.sendMessage(chatId, buildBudgetPlanDatePromptText(), getBudgetPlanCancelMarkup(telegramId));
}

async function askBudgetPlanItems(bot, chatId, telegramId, dateRange) {
  setUserState(telegramId, 'awaiting_budget_plan_items', dateRange);
  await bot.sendMessage(
    chatId,
    buildBudgetPlanItemsPromptText(dateRange.startDate, dateRange.endDate),
    getBudgetPlanCancelMarkup(telegramId)
  );
}

async function handleBudgetPlanDateInput(bot, chatId, telegramId, text) {
  const dateRange = budgetPlanService.parseBudgetDateRange(text);

  if (!dateRange) {
    await bot.sendMessage(
      chatId,
      "Sana oralig'ini tushunmadim. Masalan: 12-iyundan 15-iyulgacha",
      getBudgetPlanCancelMarkup(telegramId)
    );
    return;
  }

  setUserState(telegramId, 'awaiting_budget_plan_date_confirm', dateRange);
  await bot.sendMessage(
    chatId,
    buildBudgetPlanDateConfirmText(dateRange),
    getBudgetPlanDateConfirmMarkup(telegramId)
  );
}

function getExpenseTransactions(transactions) {
  return (Array.isArray(transactions) ? transactions : [transactions])
    .filter((transaction) => transaction && !isIncomeTransaction(transaction));
}

function mapTransactionsToPlanItems(transactions) {
  return transactions.map((transaction) => ({
    category: transaction.category,
    amount: transaction.amount
  }));
}

function normalizeBudgetPlanCommand(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’`ʻ]/g, "'")
    .replace(/\s+/g, ' ');
}

function isBudgetPlanAddCommand(text) {
  const normalizedText = normalizeBudgetPlanCommand(text);

  return normalizedText === '+'
    || normalizedText === 'add'
    || normalizedText === 'yangi'
    || normalizedText.includes("qo'sh")
    || normalizedText.includes('qosh');
}

function isBudgetPlanCancelText(text) {
  const normalizedText = normalizeBudgetPlanCommand(text);

  return normalizedText === 'bekor'
    || normalizedText === 'cancel'
    || normalizedText === 'bekor qilish';
}

async function parseBudgetPlanItems(planText) {
  const localTransactions = getExpenseTransactions(
    parseExpensesLocally(planText, { maxLength: BUDGET_PLAN_TEXT_MAX_LENGTH }) || []
  );
  let parsedTransactions = [];

  try {
    parsedTransactions = getExpenseTransactions(await categorizeExpense(planText, {
      maxLength: BUDGET_PLAN_TEXT_MAX_LENGTH
    }));
  } catch (error) {
    if (!localTransactions.length) {
      throw error;
    }

    console.warn('[BUDGET_PLAN_WARN] AI categorization failed, using local parser:', {
      message: error.message,
      code: error.code,
      localCount: localTransactions.length
    });
  }

  const transactions = localTransactions.length > parsedTransactions.length
    ? localTransactions
    : parsedTransactions;
  const mappedItems = mapTransactionsToPlanItems(transactions);
  const items = budgetPlanService.normalizePlanItems(mappedItems);

  return {
    items,
    source: transactions === localTransactions ? 'local' : 'ai',
    transactionCount: transactions.length
  };
}

async function handleBudgetPlanItemsInput(bot, chatId, telegramId, user, stateData, text) {
  const validation = validateBudgetPlanText(text);
  const planText = validation.text;

  if (!validation.ok) {
    await bot.sendMessage(
      chatId,
      validation.message,
      getBudgetPlanCancelMarkup(telegramId)
    );
    return;
  }

  const dailyLimit = getUserDailyLimit(user);
  const todayUsageCount = userService.getDailyUsageCount(user, 'text');

  if (todayUsageCount >= dailyLimit) {
    await bot.sendMessage(chatId, buildLimitReachedText(dailyLimit), getBudgetPlanCancelMarkup(telegramId));
    return;
  }

  let parsedPlan;

  try {
    parsedPlan = await parseBudgetPlanItems(planText);
  } catch (error) {
    console.error('[BUDGET_PLAN_PARSE_ERROR] Full error:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    if (error.code === 'AI_TEMPORARILY_UNAVAILABLE') {
      await bot.sendMessage(
        chatId,
        error.userMessage || "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.",
        getBudgetPlanCancelMarkup(telegramId)
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      "Rejani tushunmadim. Masalan: ovqatga 800000, taxiga 300000, kvartiraga 1200000",
      getBudgetPlanCancelMarkup(telegramId)
    );
    return;
  }

  if (!parsedPlan.items.length) {
    await bot.sendMessage(
      chatId,
      "Rejada summa topilmadi. Masalan: ovqatga 800000, taxiga 300000",
      getBudgetPlanCancelMarkup(telegramId)
    );
    return;
  }

  try {
    const plan = await budgetPlanService.createBudgetPlan(user.id, {
      startDate: stateData.startDate,
      endDate: stateData.endDate,
      items: parsedPlan.items
    });

    await userService.incrementDailyUsage(user, 1, 'text');
    clearUserState(telegramId);
    await bot.sendMessage(chatId, buildBudgetPlanSavedText(plan, user.current_salary), MAIN_KEYBOARD);
  } catch (error) {
    console.error('[BUDGET_PLAN_SAVE_ERROR] Full error:', {
      message: error.message,
      code: error.code,
      parsedSource: parsedPlan.source,
      itemCount: parsedPlan.items.length,
      stack: error.stack
    });

    const isCategoryConstraintError = error.code === '23514'
      && String(error.message || '').toLowerCase().includes('category');

    await bot.sendMessage(
      chatId,
      isCategoryConstraintError
        ? "Reja tushunildi, lekin bazadagi kategoriya ro'yxati yangilanmagan. Supabase migratsiyasini ishga tushiring."
        : "Reja tushunildi, lekin saqlashda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.",
      getBudgetPlanCancelMarkup(telegramId)
    );
  }
}

async function showBudgetPlan(bot, chatId, telegramId, user, plan = null) {
  const activePlan = plan || await budgetPlanService.getAnyActiveBudgetPlan(user.id);

  if (!activePlan) {
    await bot.sendMessage(chatId, "Sizda faol reja yo'q. Reja tuzishni boshlaymiz.", MAIN_KEYBOARD);
    await startBudgetPlanSetup(bot, chatId, telegramId);
    return;
  }

  const progress = await budgetPlanService.getBudgetPlanProgress(user.id, activePlan);
  const stateData = {
    userId: user.id,
    planId: progress.plan.id,
    items: progress.items.map((item, index) => ({
      index: index + 1,
      itemId: item.id,
      category: item.category,
      plannedAmount: item.plannedAmount
    }))
  };
  setUserState(telegramId, 'awaiting_budget_plan_action', stateData);
  await bot.sendMessage(chatId, buildBudgetPlanViewText(progress, user.current_salary), getBudgetPlanManageMarkup(telegramId));
}

async function handleBudgetPlanViewOrStart(bot, chatId, telegramId, user) {
  await showBudgetPlan(bot, chatId, telegramId, user);
}

async function handleBudgetPlanActionInput(bot, chatId, telegramId, user, stateData, text) {
  const normalizedText = String(text || '').trim().toLowerCase();

  if (normalizedText === 'sana') {
    setUserState(telegramId, 'awaiting_budget_plan_date_edit', {
      planId: stateData.planId
    });
    const currentPlan = await budgetPlanService.getAnyActiveBudgetPlan(stateData.userId);
    const dateText = currentPlan
      ? formatBudgetPlanDateRange(currentPlan.start_date, currentPlan.end_date)
      : "Noma'lum";

    await bot.sendMessage(
      chatId,
      [
        `Joriy muddat: ${dateText}`,
        '',
        "Yangi sana oralig'ini yozing. Masalan: 10-iyuldan 20-avgustgacha"
      ].join('\n'),
      MAIN_KEYBOARD
    );
    return;
  }

  if (isBudgetPlanAddCommand(normalizedText)) {
    setUserState(telegramId, 'awaiting_budget_plan_add_items', {
      userId: stateData.userId,
      planId: stateData.planId
    });
    await bot.sendMessage(
      chatId,
      [
        "Qo'shiladigan reja bandlarini oddiy matnda yozing.",
        "Masalan: transport 300000, aloqa 35000, doriga 120000",
        '',
        "Bekor qilish uchun 'bekor' deb yozing."
      ].join('\n'),
      MAIN_KEYBOARD
    );
    return;
  }

  const isItemNumber = /^\d+$/.test(normalizedText);
  const index = isItemNumber ? Number.parseInt(normalizedText, 10) : null;
  const item = isItemNumber
    ? (stateData.items || []).find((candidate) => candidate.index === index)
    : null;

  if (!item) {
    if (isItemNumber) {
      await bot.sendMessage(chatId, "Bunday reja bandi yo'q. Ro'yxatdagi raqamni yozing.", MAIN_KEYBOARD);
      return;
    }

    clearUserState(telegramId);
    await handleExpenseText(bot, chatId, user, text);
    return;
  }

  setUserState(telegramId, 'awaiting_budget_plan_item_amount', item);
  await bot.sendMessage(
    chatId,
    `${item.category} uchun yangi reja summasini kiriting (hozirgi: ${formatMoney(item.plannedAmount)}):`,
    MAIN_KEYBOARD
  );
}

async function handleBudgetPlanManageCallback(bot, query, user, manageCallback) {
  const chatId = query.message.chat.id;
  const telegramId = getTelegramId(query.from);
  const activePlan = await budgetPlanService.getAnyActiveBudgetPlan(user.id);

  if (!activePlan) {
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Sizda faol reja yo'q. Reja tuzishni boshlaymiz.", MAIN_KEYBOARD);
    await startBudgetPlanSetup(bot, chatId, telegramId);
    return;
  }

  const progress = await budgetPlanService.getBudgetPlanProgress(user.id, activePlan);
  const stateData = {
    userId: user.id,
    planId: progress.plan.id,
    items: progress.items.map((item, index) => ({
      index: index + 1,
      itemId: item.id,
      category: item.category,
      plannedAmount: item.plannedAmount
    }))
  };

  if (manageCallback.action === 'edit') {
    setUserState(telegramId, 'awaiting_budget_plan_action', stateData);
    await bot.sendMessage(chatId, "Qaysi kategoriyani o'zgartirmoqchisiz? Raqamini yozing:", MAIN_KEYBOARD);
    return;
  }

  if (manageCallback.action === 'add') {
    await handleBudgetPlanActionInput(bot, chatId, telegramId, user, stateData, "qo'shish");
    return;
  }

  await handleBudgetPlanActionInput(bot, chatId, telegramId, user, stateData, 'sana');
}

async function handleBudgetPlanAddItemsInput(bot, chatId, telegramId, user, stateData, text) {
  const planText = String(text || '').trim();

  if (isBudgetPlanCancelText(planText)) {
    await bot.sendMessage(chatId, "Qo'shish bekor qilindi.", MAIN_KEYBOARD);
    await showBudgetPlan(bot, chatId, telegramId, user);
    return;
  }

  if (!planText) {
    await bot.sendMessage(chatId, "Qo'shiladigan bandlarni yozing. Masalan: transport 300000, aloqa 35000", MAIN_KEYBOARD);
    return;
  }

  let parsedPlan;

  try {
    parsedPlan = await parseBudgetPlanItems(planText);
  } catch (error) {
    console.error('[BUDGET_PLAN_ADD_PARSE_ERROR] Full error:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    await bot.sendMessage(
      chatId,
      "Qo'shiladigan bandlarni tushunmadim. Masalan: transport 300000, aloqa 35000",
      MAIN_KEYBOARD
    );
    return;
  }

  if (!parsedPlan.items.length) {
    await bot.sendMessage(chatId, "Qo'shish uchun summa topilmadi. Masalan: transport 300000, aloqa 35000", MAIN_KEYBOARD);
    return;
  }

  try {
    const plan = await budgetPlanService.addBudgetPlanItems(user.id, stateData.planId, parsedPlan.items);
    await bot.sendMessage(chatId, "✅ Rejaga qo'shildi.", MAIN_KEYBOARD);
    await showBudgetPlan(bot, chatId, telegramId, user, plan);
  } catch (error) {
    console.error('[BUDGET_PLAN_ADD_SAVE_ERROR] Full error:', {
      message: error.message,
      code: error.code,
      parsedSource: parsedPlan.source,
      itemCount: parsedPlan.items.length,
      stack: error.stack
    });

    const isCategoryConstraintError = error.code === '23514'
      && String(error.message || '').toLowerCase().includes('category');

    await bot.sendMessage(
      chatId,
      isCategoryConstraintError
        ? "Bandlar tushunildi, lekin bazadagi kategoriya ro'yxati yangilanmagan. Supabase migratsiyasini ishga tushiring."
        : "Bandlarni qo'shishda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.",
      MAIN_KEYBOARD
    );
  }
}

async function handleBudgetPlanItemAmountInput(bot, chatId, telegramId, user, stateData, text) {
  const newAmount = parsePositiveAmount(text);

  if (!newAmount) {
    await bot.sendMessage(chatId, AMOUNT_PARSE_ERROR_TEXT, MAIN_KEYBOARD);
    return;
  }

  try {
    await budgetPlanService.updateBudgetPlanItem(user.id, stateData.itemId, newAmount);
    await bot.sendMessage(chatId, '✅ Reja summasi yangilandi.', MAIN_KEYBOARD);
    await showBudgetPlan(bot, chatId, telegramId, user);
  } catch (error) {
    console.error('Byudjet reja bandini yangilashda xato:', error);
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Reja bandini yangilashda xato bo'ldi.", MAIN_KEYBOARD);
  }
}

async function handleBudgetPlanDateEditInput(bot, chatId, telegramId, user, stateData, text) {
  const dateRange = budgetPlanService.parseBudgetDateRange(text);

  if (!dateRange) {
    await bot.sendMessage(chatId, "Sana oralig'ini tushunmadim. Masalan: 10-iyuldan 20-avgustgacha", MAIN_KEYBOARD);
    return;
  }

  try {
    const plan = await budgetPlanService.updateBudgetPlanDates(user.id, stateData.planId, dateRange);
    await bot.sendMessage(chatId, '✅ Muddat yangilandi.', MAIN_KEYBOARD);
    await showBudgetPlan(bot, chatId, telegramId, user, plan);
  } catch (error) {
    console.error('Byudjet reja muddatini yangilashda xato:', error);
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Reja muddatini yangilashda xato bo'ldi.", MAIN_KEYBOARD);
  }
}

async function handleSalaryInput(bot, chatId, telegramId, user, text, options = {}) {
  const amount = parsePositiveAmount(text);

  if (!amount) {
    await bot.sendMessage(chatId, AMOUNT_PARSE_ERROR_TEXT, MAIN_KEYBOARD);
    return null;
  }

  const updatedUser = await userService.updateSalary(user.id, amount, userService.getMonthKey());
  clearUserState(telegramId);

  const activePlan = await budgetPlanService.getAnyActiveBudgetPlan(user.id);

  if (activePlan) {
    const progress = await budgetPlanService.getBudgetPlanProgress(user.id, activePlan);
    await bot.sendMessage(chatId, buildSalaryUpdatedWithPlanText(updatedUser.current_salary, progress), MAIN_KEYBOARD);
  } else if (options.offerBudgetPlan) {
    await bot.sendMessage(
      chatId,
      buildSalaryBudgetPromptText(updatedUser.current_salary),
      getBudgetPlanOfferMarkup(telegramId)
    );
  } else {
    await bot.sendMessage(
      chatId,
      buildSalarySavedText(updatedUser.current_salary),
      MAIN_KEYBOARD
    );
  }

  return updatedUser;
}

async function handleSettings(bot, chatId, user) {
  const todayExpenseCount = userService.getDailyUsageCount(user, 'text');

  await bot.sendMessage(
    chatId,
    buildSettingsText(user, todayExpenseCount),
    getSettingsInlineKeyboard(user)
  );
}

async function promptForMissingName(bot, chatId, telegramId) {
  setUserState(telegramId, 'awaiting_start_name');
  await bot.sendMessage(chatId, "Iltimos, avval ismingizni kiriting.", MAIN_KEYBOARD);
}

async function promptForMissingSalary(bot, chatId, telegramId) {
  setUserState(telegramId, 'awaiting_salary');
  await bot.sendMessage(chatId, "Iltimos, avval maoshingizni kiriting. Masalan: 5000000", MAIN_KEYBOARD);
}

async function handleMainKeyboardButton(bot, chatId, telegramId, user, text) {
  const action = getMainKeyboardAction(text);

  if (!action) {
    return false;
  }

  if (!hasFullName(user)) {
    await promptForMissingName(bot, chatId, telegramId);
    return true;
  }

  if (action === 'salary') {
    const hasSalary = Number(user.current_salary || 0) > 0;
    setUserState(telegramId, hasSalary ? 'awaiting_new_salary' : 'awaiting_salary');
    await bot.sendMessage(
      chatId,
      hasSalary
        ? `Hozirgi maosh: ${formatMoney(user.current_salary)}. Yangi summani kiriting.`
        : "Maoshingizni kiriting. Masalan: 5000000",
      MAIN_KEYBOARD
    );
    return true;
  }

  if (Number(user.current_salary || 0) <= 0) {
    await promptForMissingSalary(bot, chatId, telegramId);
    return true;
  }

  if (action === 'report') {
    await handleReport(bot, chatId, user);
    return true;
  }

  if (action === 'analysis') {
    await handleAnalysis(bot, chatId, user);
    return true;
  }

  if (action === 'settings') {
    await handleSettings(bot, chatId, user);
    return true;
  }

  if (action === 'budgetPlan') {
    await handleBudgetPlanViewOrStart(bot, chatId, telegramId, user);
    return true;
  }

  if (action === 'planGoal') {
    await handlePlanGoalStart(bot, chatId, telegramId, user);
    return true;
  }

  return false;
}

async function handleStatsCommand(bot, msg) {
  if (!isAdminUser(msg.from)) {
    return;
  }

  const chatId = getChatId(msg);

  try {
    const { users, todayAiUsageCount } = await getStatsData();
    const message = buildStatsMessage(users, todayAiUsageCount);

    await bot.sendMessage(chatId, message.text, message.options);
  } catch (error) {
    console.error('/stats xatosi:', error);
    await bot.sendMessage(chatId, "Statistikani olishda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
  }
}

async function handleExpenseText(bot, chatId, user, text) {
  const validation = validateExpenseText(text);
  const cleanText = validation.text;

  if (!validation.ok) {
    await bot.sendMessage(chatId, validation.message, MAIN_KEYBOARD);
    return;
  }

  try {
    const dailyLimit = getUserDailyLimit(user);
    const todayExpenseCount = userService.getDailyUsageCount(user, 'text');

    if (todayExpenseCount >= dailyLimit) {
      await bot.sendMessage(
        chatId,
        buildLimitReachedText(dailyLimit),
        getPaymentStartMarkup()
      );
      return;
    }

    // Erkin matn Gemini orqali bir yoki bir nechta strukturali operatsiyaga aylantiriladi.
    const parsedExpenses = await categorizeExpense(cleanText);
    const expenses = (Array.isArray(parsedExpenses) ? parsedExpenses : [parsedExpenses]).filter(Boolean);

    if (!expenses.length) {
      await bot.sendMessage(chatId, "Tushunmadim, qaytadan yozing. Masalan: 25000 nonga yoki +50000 qarz qaytdi", MAIN_KEYBOARD);
      return;
    }

    const remainingSlots = Math.max(0, dailyLimit - todayExpenseCount);
    const expensesToSave = expenses.slice(0, remainingSlots);
    const skippedCount = expenses.length - expensesToSave.length;

    if (!expensesToSave.length) {
      await bot.sendMessage(
        chatId,
        buildLimitReachedText(dailyLimit),
        getPaymentStartMarkup()
      );
      return;
    }

    const month = user.current_month || userService.getMonthKey();
    const summaryBeforeSave = await expenseService.getMonthlySummary(user.id, month);
    const previousExpenses = getExpenseItems(summaryBeforeSave.expenses);
    const savedExpenses = [];
    let hasUnusualExpense = false;

    for (const expense of expensesToSave) {
      if (isUnusualExpense(expense, previousExpenses)) {
        hasUnusualExpense = true;
      }

      const savedExpense = await expenseService.createExpense(user.id, expense, month);
      savedExpenses.push(savedExpense);

      if (!isIncomeTransaction(savedExpense)) {
        previousExpenses.push(savedExpense);
      }
    }

    await userService.incrementDailyUsage(user, savedExpenses.length, 'text');

    const summary = await expenseService.getMonthlySummary(user.id, month);
    const balance = Number(user.current_salary || 0)
      - Number(summary.totalSpent || 0)
      + Number(summary.totalIncome || 0);
    const budgetWarnings = await budgetPlanService.getBudgetWarningsForExpenses(user.id, savedExpenses);

    const messageOptions = expenses.length === 1 && savedExpenses.length === 1 && skippedCount === 0
      ? getExpenseActionMarkup(savedExpenses[0], user.telegram_id)
      : MAIN_KEYBOARD;

    await bot.sendMessage(
      chatId,
      buildSavedExpensesText(savedExpenses, balance, skippedCount, { hasUnusualExpense, budgetWarnings }),
      messageOptions
    );
  } catch (error) {
    console.error('Operatsiyani qayta ishlashda xato:', error);
    if (error.code === 'AI_TEMPORARILY_UNAVAILABLE') {
      await bot.sendMessage(chatId, error.userMessage || "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Tushunmadim, qaytadan yozing. Masalan: 25000 nonga yoki +50000 qarz qaytdi", MAIN_KEYBOARD);
  }
}

async function sendVoiceLimitReachedMessage(bot, chatId, user, todayVoiceCount, dailyVoiceLimit) {
  if (user?.is_premium) {
    await bot.sendMessage(
      chatId,
      buildPremiumVoiceLimitReachedText(todayVoiceCount, dailyVoiceLimit),
      MAIN_KEYBOARD
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    buildFreeVoiceLimitReachedText(todayVoiceCount, dailyVoiceLimit),
    getPaymentStartMarkup()
  );
}

async function handleVoice(bot, msg) {
  const chatId = getChatId(msg);
  const telegramId = getTelegramId(msg.from);

  if (isRateLimited(telegramId)) {
    await bot.sendMessage(chatId, "Bir daqiqada 20 tadan ortiq xabar yubormang. Biroz kutib qayta yozing.", MAIN_KEYBOARD);
    return;
  }

  try {
    let user = await userService.ensureUser(msg.from);
    user = await rolloverUserMonth(bot, user);

    if (!hasFullName(user)) {
      setUserState(telegramId, 'awaiting_start_name');
      await bot.sendMessage(chatId, buildNamePromptText(), MAIN_KEYBOARD);
      return;
    }

    if (Number(user.current_salary || 0) <= 0) {
      setUserState(telegramId, 'awaiting_salary');
      await bot.sendMessage(chatId, "Avval oylik maoshingizni matn bilan kiriting. Masalan: 5000000", MAIN_KEYBOARD);
      return;
    }

    const dailyVoiceLimit = getUserDailyVoiceLimit(user);
    const todayVoiceCount = userService.getDailyUsageCount(user, 'voice');

    if (todayVoiceCount >= dailyVoiceLimit) {
      await sendVoiceLimitReachedMessage(bot, chatId, user, todayVoiceCount, dailyVoiceLimit);
      return;
    }

    const voice = msg.voice;

    if (!voice?.file_id) {
      await bot.sendMessage(chatId, "Ovozli xabarni o'qib bo'lmadi. Xarajat yoki kirimni matn bilan yozib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Ovozli xabar tahlil qilinmoqda, bir necha soniya kuting...", MAIN_KEYBOARD);

    const fileUrl = await bot.getFileLink(voice.file_id);
    const parsedExpense = await categorizeVoiceExpense(fileUrl, voice.mime_type || 'audio/ogg');
    const month = user.current_month || userService.getMonthKey();
    const summaryBeforeSave = await expenseService.getMonthlySummary(user.id, month);
    const previousExpenses = getExpenseItems(summaryBeforeSave.expenses);
    const hasUnusualExpense = isUnusualExpense(parsedExpense, previousExpenses);
    const savedExpense = await expenseService.createExpense(user.id, parsedExpense, month, 'voice');
    await userService.incrementDailyUsage(user, 1, 'voice');
    const summary = await expenseService.getMonthlySummary(user.id, month);
    const balance = Number(user.current_salary || 0)
      - Number(summary.totalSpent || 0)
      + Number(summary.totalIncome || 0);
    const budgetWarnings = await budgetPlanService.getBudgetWarningsForExpenses(user.id, [savedExpense]);

    await bot.sendMessage(
      chatId,
      buildSavedExpensesText([savedExpense], balance, 0, { hasUnusualExpense, budgetWarnings }),
      getExpenseActionMarkup(savedExpense, user.telegram_id)
    );
  } catch (error) {
    console.error('Ovozli operatsiyani qayta ishlashda xato:', error);

    if (error.code === 'AI_TEMPORARILY_UNAVAILABLE') {
      await bot.sendMessage(chatId, error.userMessage || "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Ovozli xabarni tushunmadim. Matn bilan yozib ko'ring: 25000 nonga yoki +50000 qarz qaytdi", MAIN_KEYBOARD);
  }
}

async function updateAdminPaymentMessage(bot, query, statusText) {
  const message = query.message;
  const baseText = message.text || message.caption || "To'lov cheki ko'rib chiqildi.";
  const options = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] }
  };

  if (message.text) {
    await bot.editMessageText(`${baseText}\n\n${statusText}`, options);
    return;
  }

  await bot.editMessageCaption(`${baseText}\n\n${statusText}`, options);
}

async function handlePaymentReviewCallback(bot, query, review) {
  if (!isAdminUser(query.from)) {
    return;
  }

  if (!/^\d+$/.test(review.telegramId)) {
    return;
  }

  if (review.action === 'confirm') {
    await userService.updatePremiumByTelegramId(review.telegramId, true);
    await bot.sendMessage(
      review.telegramId,
      "✅ To'lov tasdiqlandi. Premium faollashdi: 50 ta matn, 10 ta ovozli/kun.",
      MAIN_KEYBOARD
    );
    await updateAdminPaymentMessage(bot, query, 'Tasdiqlandi ✅');
    return;
  }

  await userService.updateAwaitingPaymentByTelegramId(review.telegramId, false);
  await bot.sendMessage(
    review.telegramId,
    "❌ To'lovingiz tasdiqlanmadi. Iltimos qaytadan tekshirib ko'ring yoki qo'llab-quvvatlash bilan bog'laning.",
    MAIN_KEYBOARD
  );
  await updateAdminPaymentMessage(bot, query, 'Rad etildi ❌');
}

async function handlePremiumCommand(bot, msg, match, enabled) {
  if (!isAdminUser(msg.from)) {
    return;
  }

  const chatId = getChatId(msg);
  const targetTelegramId = match?.[1];

  if (!targetTelegramId) {
    return;
  }

  try {
    const updatedUser = await userService.updatePremiumByTelegramId(targetTelegramId, enabled);

    if (enabled) {
      try {
        await bot.sendMessage(
          targetTelegramId,
          'Premium ochildi: 50 ta matn, 10 ta ovozli/kun.',
          MAIN_KEYBOARD
        );
      } catch (notifyError) {
        console.error('Premium xabarini foydalanuvchiga yuborishda xato:', notifyError);
      }
    }

    await bot.sendMessage(
      chatId,
      enabled
        ? `Premium yoqildi: ${updatedUser.telegram_id} (matn 50, ovoz 10).`
        : `Premium olib tashlandi: ${updatedUser.telegram_id} (matn 15, ovoz 2).`,
      MAIN_KEYBOARD
    );
  } catch (error) {
    console.error('Premium buyrugida xato:', error);

    if (error.code === 'USER_NOT_FOUND') {
      await bot.sendMessage(chatId, "Foydalanuvchi topilmadi. Avval u botga /start bosgan bo'lishi kerak.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Premium sozlamasini o'zgartirishda xato bo'ldi.", MAIN_KEYBOARD);
  }
}

async function handlePremiumPriceCommand(bot, msg) {
  const chatId = getChatId(msg);

  try {
    const user = await userService.ensureUser(msg.from);

    if (user?.is_premium) {
      await bot.sendMessage(
        chatId,
        `Siz allaqachon premium foydalanuvchisiz! Tugash sanasi: ${formatDateOnly(user.premium_expires_at)}`,
        MAIN_KEYBOARD
      );
      return;
    }

    await bot.sendMessage(chatId, buildPremiumPriceText(), getPaymentStartMarkup());
  } catch (error) {
    console.error('/premium_narxi xatosi:', error);
    await bot.sendMessage(chatId, "Premium tarif ma'lumotini olishda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
  }
}

async function handleAdminStatsCallback(bot, query, adminCallback) {
  if (!isAdminUser(query.from)) {
    await answerCallback(bot, query, 'Bu tugma siz uchun emas.');
    return;
  }

  await answerCallback(bot, query);

  const page = Math.max(0, Number.parseInt(adminCallback.page, 10) || 0);

  if (adminCallback.action === 'list') {
    await editStatsListMessage(bot, query, page);
    return;
  }

  if (!/^\d+$/.test(String(adminCallback.telegramId || ''))) {
    await editStatsListMessage(bot, query, page, "Telegram ID noto'g'ri.");
    return;
  }

  if (adminCallback.action === 'deleteDo') {
    try {
      const deletedUser = await userService.deleteUserCompletelyByTelegramId(adminCallback.telegramId);
      await editStatsListMessage(
        bot,
        query,
        page,
        `✅ ${formatStatsUserName(deletedUser)} muvaffaqiyatli o'chirildi`
      );
    } catch (error) {
      if (error.code === 'USER_NOT_FOUND') {
        await editStatsListMessage(bot, query, page, "Foydalanuvchi allaqachon o'chirilgan.");
        return;
      }

      throw error;
    }

    return;
  }

  const user = await userService.getUserByTelegramId(adminCallback.telegramId);

  if (!user) {
    await editStatsListMessage(bot, query, page, "Foydalanuvchi topilmadi yoki allaqachon o'chirilgan.");
    return;
  }

  if (adminCallback.action === 'view' || adminCallback.action === 'deleteCancel') {
    await editCallbackMessageText(
      bot,
      query,
      buildAdminUserDetailsText(user),
      buildAdminUserDetailsMarkup(user, page)
    );
    return;
  }

  if (adminCallback.action === 'deleteAsk') {
    await editCallbackMessageText(
      bot,
      query,
      buildAdminDeleteConfirmText(user),
      buildAdminDeleteConfirmMarkup(user, page)
    );
  }
}

async function handleExpenseActionCallback(bot, query, user, expenseAction) {
  const telegramId = getTelegramId(query.from);

  if (String(expenseAction.telegramId) !== telegramId) {
    await answerCallback(bot, query, 'Bu yozuv sizga tegishli emas.');
    return;
  }

  await answerCallback(bot, query);

  if (expenseAction.action === 'deleteAsk') {
    const expense = await expenseService.getExpenseByIdForUser(user.id, expenseAction.expenseId);

    if (!expense) {
      await editCallbackMessageText(
        bot,
        query,
        "Yozuv topilmadi yoki allaqachon o'chirilgan.",
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    await editCallbackMessageText(
      bot,
      query,
      [
        `Bu ${getTransactionKindLabel(expense).toLowerCase()}ni o'chirmoqchimisiz?`,
        '',
        `${formatTransactionAmount(expense)} (${expense.category})`
      ].join('\n'),
      getExpenseDeleteConfirmMarkup(expense.id, telegramId)
    );
    return;
  }

  if (expenseAction.action === 'deleteCancel') {
    await editCallbackMessageText(
      bot,
      query,
      "O'chirish bekor qilindi.",
      { reply_markup: { inline_keyboard: [] } }
    );
    return;
  }

  if (expenseAction.action === 'deleteConfirm') {
    try {
      const deletedExpense = await expenseService.deleteExpenseByIdForUser(user.id, expenseAction.expenseId);
      const balance = await getCurrentBalance(user, deletedExpense.month || user.current_month || userService.getMonthKey());

      await editCallbackMessageText(
        bot,
        query,
        `✅ ${getTransactionKindLabel(deletedExpense)} o'chirildi. Yangi balans: ${formatMoney(balance)}`,
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      if (error.code === 'EXPENSE_NOT_FOUND') {
        await editCallbackMessageText(
          bot,
          query,
          "Yozuv allaqachon o'chirilgan yoki topilmadi.",
          { reply_markup: { inline_keyboard: [] } }
        );
        return;
      }

      throw error;
    }

    return;
  }

  if (expenseAction.action === 'edit') {
    const expense = await expenseService.getExpenseByIdForUser(user.id, expenseAction.expenseId);

    if (!expense) {
      await editCallbackMessageText(
        bot,
        query,
        "Yozuv topilmadi yoki allaqachon o'chirilgan.",
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    await removeInlineKeyboard(bot, query);
    setUserState(telegramId, 'awaiting_expense_edit_amount', {
      expenseId: expense.id,
      oldAmount: Number(expense.amount || 0),
      category: expense.category,
      type: expense.type,
      note: expense.note,
      month: expense.month || user.current_month || userService.getMonthKey()
    });
    await bot.sendMessage(query.message.chat.id, "Yangi summani kiriting (so'mda):", MAIN_KEYBOARD);
  }
}

async function handleCallback(bot, query) {
  const chatId = query.message?.chat?.id;
  const telegramId = getTelegramId(query.from);
  const callbackKey = getCallbackMessageKey(query);

  try {
    if (!chatId) {
      await answerCallback(bot, query);
      return;
    }

    if (isRateLimited(telegramId)) {
      await answerCallback(bot, query, `Bir daqiqada ${RATE_LIMIT_COUNT} tadan ortiq amal qilmang.`);
      return;
    }

    const adminStatsCallback = parseAdminStatsCallback(query.data);

    if (adminStatsCallback) {
      await handleAdminStatsCallback(bot, query, adminStatsCallback);
      return;
    }

    const budgetPlanCallback = parseBudgetPlanCallback(query.data);
    const budgetPlanManageCallback = parseBudgetPlanManageCallback(query.data);

    if (budgetPlanManageCallback) {
      if (String(budgetPlanManageCallback.telegramId) !== telegramId) {
        await answerCallback(bot, query, 'Bu tugma siz uchun emas.');
        return;
      }

      await answerCallback(bot, query);
      const user = await userService.ensureUser(query.from);
      await handleBudgetPlanManageCallback(bot, query, user, budgetPlanManageCallback);
      return;
    }

    if (isCallbackMessageConsumed(callbackKey) && budgetPlanCallback?.action !== 'cancel') {
      await answerCallback(bot, query, "Bu so'rov allaqachon bajarilgan");
      return;
    }

    const paymentReview = parsePaymentReviewCallback(query.data);

    if (paymentReview) {
      if (!isAdminUser(query.from)) {
        await answerCallback(bot, query, 'Bu tugma siz uchun emas.');
        return;
      }

      await answerCallback(bot, query);
      await consumeCallbackMessage(bot, query, callbackKey);
      await handlePaymentReviewCallback(bot, query, paymentReview);
      return;
    }

    const expenseAction = parseExpenseActionCallback(query.data);

    if (expenseAction) {
      const user = await userService.ensureUser(query.from);
      await handleExpenseActionCallback(bot, query, user, expenseAction);
      return;
    }

    if (budgetPlanCallback) {
      if (String(budgetPlanCallback.telegramId) !== telegramId) {
        await answerCallback(bot, query, 'Bu tugma siz uchun emas.');
        return;
      }

      await answerCallback(bot, query);
      await consumeCallbackMessage(bot, query, callbackKey);

      if (budgetPlanCallback.action === 'cancel') {
        clearUserState(telegramId);
        await bot.sendMessage(chatId, "Reja tuzish bekor qilindi.", MAIN_KEYBOARD);
        return;
      }

      if (budgetPlanCallback.action === 'skip') {
        clearUserState(telegramId);
        await bot.sendMessage(chatId, "Mayli, rejasiz davom etamiz. Xarajat yoki kirimni yozavering.", MAIN_KEYBOARD);
        return;
      }

      if (budgetPlanCallback.action === 'dateRetry') {
        setUserState(telegramId, 'awaiting_budget_plan_dates');
        await bot.sendMessage(chatId, buildBudgetPlanDateRetryText(), getBudgetPlanCancelMarkup(telegramId));
        return;
      }

      if (budgetPlanCallback.action === 'dateConfirm') {
        const state = getUserState(telegramId);

        if (state?.type !== 'awaiting_budget_plan_date_confirm' || !state.data?.startDate || !state.data?.endDate) {
          await bot.sendMessage(chatId, "Sana tasdiqlash eskirgan. Sana oralig'ini qayta yozing.", getBudgetPlanCancelMarkup(telegramId));
          setUserState(telegramId, 'awaiting_budget_plan_dates');
          return;
        }

        await askBudgetPlanItems(bot, chatId, telegramId, state.data);
        return;
      }

      const user = await userService.ensureUser(query.from);

      if (!hasFullName(user)) {
        await promptForMissingName(bot, chatId, telegramId);
        return;
      }

      if (Number(user.current_salary || 0) <= 0) {
        await promptForMissingSalary(bot, chatId, telegramId);
        return;
      }

      await startBudgetPlanSetup(bot, chatId, telegramId);
      return;
    }

    await answerCallback(bot, query);

    if (query.data === PLAN_GOAL_CANCEL_CALLBACK) {
      await consumeCallbackMessage(bot, query, callbackKey);
      clearUserState(telegramId);
      await bot.sendMessage(chatId, 'Bekor qilindi.', MAIN_KEYBOARD);
      return;
    }

    if (query.data === 'settings_clear_cancel') {
      await consumeCallbackMessage(bot, query, callbackKey);
      clearUserState(telegramId);
      await bot.sendMessage(chatId, "Tozalash bekor qilindi.", MAIN_KEYBOARD);
      return;
    }

    if (query.data === 'month_salary_keep') {
      await consumeCallbackMessage(bot, query, callbackKey);
      clearUserState(telegramId);
      await bot.sendMessage(chatId, "Mayli, bu oyda ham avvalgi maosh bilan davom etamiz.", MAIN_KEYBOARD);
      return;
    }

    const user = await userService.ensureUser(query.from);

    if (query.data === PAYMENT_START_CALLBACK) {
      await consumeCallbackMessage(bot, query, callbackKey);
      await userService.updateAwaitingPayment(user.id, true);
      await bot.sendMessage(chatId, "Chek yoki to'lov skrinshotini shu yerga yuboring.", MAIN_KEYBOARD);
      return;
    }

    if (query.data === SETTINGS_EXPORT_EXCEL_CALLBACK) {
      await answerCallback(bot, query);
      await sendExcelReport(bot, chatId, user);
      return;
    }

    if (query.data === 'settings_change_name') {
      await consumeCallbackMessage(bot, query, callbackKey);
      setUserState(telegramId, 'awaiting_name');
      await bot.sendMessage(chatId, "Yangi ismingizni kiriting.", MAIN_KEYBOARD);
      return;
    }

    if (query.data === 'settings_clear_request') {
      await consumeCallbackMessage(bot, query, callbackKey);
      clearUserState(telegramId);
      await bot.sendMessage(
        chatId,
        "Barcha yozuvlar, tarix va maosh ma'lumotlari o'chadi. Davom etasizmi?",
        CLEAR_CONFIRM_INLINE_KEYBOARD
      );
      return;
    }

    if (query.data === 'settings_clear_confirm') {
      await consumeCallbackMessage(bot, query, callbackKey);
      await userService.resetUserData(user.id);
      clearUserState(telegramId);
      setUserState(telegramId, 'awaiting_salary');
      await bot.sendMessage(chatId, "Ma'lumotlaringiz tozalandi. Qaytadan oylik maoshingizni kiriting.", MAIN_KEYBOARD);
      return;
    }

    if (query.data === 'month_salary_update') {
      await consumeCallbackMessage(bot, query, callbackKey);
      setUserState(telegramId, 'awaiting_new_salary');
      await bot.sendMessage(chatId, "Yangi oy uchun maoshingizni kiriting. Masalan: 5500000", MAIN_KEYBOARD);
      return;
    }

    await consumeCallbackMessage(bot, query, callbackKey);
    await bot.sendMessage(chatId, "Bu tugma uchun amal topilmadi.", MAIN_KEYBOARD);
  } catch (error) {
    console.error('Callback xatosi:', error);
    if (chatId) {
      await bot.sendMessage(chatId, "Tugmani qayta ishlashda xato bo'ldi.", MAIN_KEYBOARD);
    }
  }
}

async function handlePhoto(bot, msg) {
  const chatId = getChatId(msg);
  const telegramId = getTelegramId(msg.from);

  if (isRateLimited(telegramId)) {
    await bot.sendMessage(chatId, "Bir daqiqada 20 tadan ortiq xabar yubormang. Biroz kutib qayta yozing.", MAIN_KEYBOARD);
    return;
  }

  try {
    const user = await userService.ensureUser(msg.from);

    if (!user.awaiting_payment) {
      await bot.sendMessage(
        chatId,
        "Agar to'lov chekini yubormoqchi bo'lsangiz, avval tegishli tugmani bosing",
        MAIN_KEYBOARD
      );
      return;
    }

    const adminTelegramId = getAdminTelegramId();

    if (!adminTelegramId) {
      await bot.sendMessage(chatId, "To'lovni qabul qiluvchi admin sozlanmagan. Keyinroq qayta urinib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    const adminText = [
      "Yangi to'lov cheki yuborildi.",
      '',
      `Foydalanuvchi: ${formatUserName(user, msg.from)}`,
      `Telegram ID: ${telegramId}`,
      `Vaqt: ${formatDateTime()}`
    ].join('\n');

    await bot.forwardMessage(adminTelegramId, chatId, msg.message_id);
    await bot.sendMessage(adminTelegramId, adminText, getPaymentReviewMarkup(telegramId));
    await userService.updateAwaitingPayment(user.id, false);
    await bot.sendMessage(
      chatId,
      "To'lovingiz ko'rib chiqilmoqda, tez orada javob beramiz",
      MAIN_KEYBOARD
    );
  } catch (error) {
    console.error("To'lov chekini qayta ishlashda xato:", error);
    await bot.sendMessage(chatId, "To'lov chekini qabul qilishda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
  }
}

async function handleExpenseEditAmountInput(bot, chatId, telegramId, user, stateData, text) {
  const newAmount = parsePositiveAmount(text);

  if (!newAmount) {
    await bot.sendMessage(chatId, AMOUNT_PARSE_ERROR_TEXT, MAIN_KEYBOARD);
    return;
  }

  try {
    const existingExpense = await expenseService.getExpenseByIdForUser(user.id, stateData.expenseId);

    if (!existingExpense) {
      clearUserState(telegramId);
      await bot.sendMessage(chatId, "Tahrirlanadigan yozuv topilmadi yoki allaqachon o'chirilgan.", MAIN_KEYBOARD);
      return;
    }

    const oldAmount = Number(existingExpense.amount || stateData.oldAmount || 0);
    const updatedExpense = await expenseService.updateExpenseAmount(user.id, stateData.expenseId, newAmount);
    clearUserState(telegramId);

    const month = updatedExpense.month || stateData.month || user.current_month || userService.getMonthKey();
    const balance = await getCurrentBalance(user, month);

    await bot.sendMessage(
      chatId,
      [
        `✅ Yangilandi: ${formatTransactionAmount({ ...updatedExpense, amount: oldAmount })} -> ${formatTransactionAmount(updatedExpense)}`,
        isIncomeTransaction(updatedExpense)
          ? `Izoh: ${updatedExpense.note || 'Kirim'}`
          : `Kategoriya: ${updatedExpense.category}`,
        `Yangi balans: ${formatMoney(balance)}`
      ].join('\n'),
      MAIN_KEYBOARD
    );
  } catch (error) {
    console.error('Yozuvni tahrirlashda xato:', error);
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Yozuvni tahrirlashda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
  }
}

async function handleMessage(bot, msg) {
  const text = msg.text;

  if (!text || text.startsWith('/')) {
    return;
  }

  const chatId = getChatId(msg);
  const telegramId = getTelegramId(msg.from);

  if (isRateLimited(telegramId)) {
    await bot.sendMessage(chatId, "Bir daqiqada 20 tadan ortiq xabar yubormang. Biroz kutib qayta yozing.", MAIN_KEYBOARD);
    return;
  }

  try {
    let user = await userService.ensureUser(msg.from);
    user = await rolloverUserMonth(bot, user);
    const state = getUserState(telegramId);
    const normalizedText = text.trim();
    
    // Debug state
    if (text.length > 100) {
      console.log('[STATE_DEBUG] Message received:', {
        telegramId,
        hasState: !!state,
        stateType: state?.type,
        textLength: text.length
      });
    }

    if (state && isMainKeyboardButtonText(normalizedText)) {
      if (state.type === 'awaiting_budget_plan_dates') {
        await bot.sendMessage(
          chatId,
          [
            'Siz hozir reja tuzish jarayonidasiz.',
            "Davom etish uchun sana oralig'ini yozing, yoki bekor qilish uchun tugmani bosing:",
            '',
            'Masalan: 12-iyundan 15-iyulgacha'
          ].join('\n'),
          getBudgetPlanCancelMarkup(telegramId)
        );
        return;
      }

      if (state.type === 'awaiting_budget_plan_date_confirm') {
        await bot.sendMessage(
          chatId,
          buildBudgetPlanDateConfirmText(state.data),
          getBudgetPlanDateConfirmMarkup(telegramId)
        );
        return;
      }

      if (state.type === 'awaiting_budget_plan_items') {
        await bot.sendMessage(
          chatId,
          buildBudgetPlanContinueText(state.data),
          getBudgetPlanCancelMarkup(telegramId)
        );
        return;
      }

      // Boshqa tugmalar bosilsa state tozala va tugmani ishlat
      clearUserState(telegramId);
      await handleMainKeyboardButton(bot, chatId, telegramId, user, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_start_name') {
      if (!normalizedText) {
        await bot.sendMessage(chatId, buildNamePromptText(), MAIN_KEYBOARD);
        return;
      }

      const updatedUser = await userService.updateFullName(user.id, normalizedText);
      setUserState(telegramId, 'awaiting_salary');
      await bot.sendMessage(chatId, buildSalaryPromptText(updatedUser.full_name), MAIN_KEYBOARD);
      return;
    }

    if (state?.type === 'awaiting_salary' || state?.type === 'awaiting_new_salary') {
      await handleSalaryInput(bot, chatId, telegramId, user, normalizedText, {
        offerBudgetPlan: state.type === 'awaiting_salary'
      });
      return;
    }

    if (state?.type === 'awaiting_name') {
      const updatedUser = await userService.updateFullName(user.id, normalizedText);
      clearUserState(telegramId);
      await bot.sendMessage(chatId, `Ism yangilandi: ${updatedUser.full_name}`, MAIN_KEYBOARD);
      return;
    }

    if (state?.type === 'awaiting_expense_edit_amount') {
      await handleExpenseEditAmountInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_dates') {
      await handleBudgetPlanDateInput(bot, chatId, telegramId, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_date_confirm') {
      await bot.sendMessage(
        chatId,
        buildBudgetPlanDateConfirmText(state.data),
        getBudgetPlanDateConfirmMarkup(telegramId)
      );
      return;
    }

    if (state?.type === 'awaiting_budget_plan_items') {
      console.log('[BUDGET_PLAN_DEBUG] State found: awaiting_budget_plan_items, calling handler');
      await handleBudgetPlanItemsInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_action') {
      console.log('[BUDGET_PLAN_DEBUG] State found: awaiting_budget_plan_action, not items');
      await handleBudgetPlanActionInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_add_items') {
      await handleBudgetPlanAddItemsInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_item_amount') {
      await handleBudgetPlanItemAmountInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_budget_plan_date_edit') {
      await handleBudgetPlanDateEditInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_plan_goal_income') {
      await handlePlanGoalIncomeInput(bot, chatId, telegramId, user, normalizedText);
      return;
    }

    if (state?.type === 'awaiting_plan_goal_text') {
      await handlePlanGoalInput(bot, chatId, telegramId, user, state.data, normalizedText);
      return;
    }

    if (!hasFullName(user)) {
      setUserState(telegramId, 'awaiting_start_name');
      await bot.sendMessage(chatId, buildNamePromptText(), MAIN_KEYBOARD);
      return;
    }

    if (await handleMainKeyboardButton(bot, chatId, telegramId, user, normalizedText)) {
      return;
    }

    if (Number(user.current_salary || 0) <= 0) {
      const amount = parsePositiveAmount(normalizedText);

      if (amount) {
        await handleSalaryInput(bot, chatId, telegramId, user, normalizedText, { offerBudgetPlan: true });
        return;
      }

      setUserState(telegramId, 'awaiting_salary');
      await bot.sendMessage(chatId, "Avval oylik maoshingizni kiriting. Masalan: 5000000", MAIN_KEYBOARD);
      return;
    }

    await handleExpenseText(bot, chatId, user, normalizedText);
  } catch (error) {
    console.error('Xabarni qayta ishlashda xato:', error);
    await bot.sendMessage(chatId, "Ichki xato yuz berdi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
  }
}

function registerHandlers(bot) {
  bot.onText(/^\/start$/, (msg) => handleStart(bot, msg));
  bot.onText(/^\/stats$/, (msg) => handleStatsCommand(bot, msg));
  bot.onText(/^\/premium_narxi$/, (msg) => handlePremiumPriceCommand(bot, msg));
  bot.onText(/^\/premium\s+(\d+)$/, (msg, match) => handlePremiumCommand(bot, msg, match, true));
  bot.onText(/^\/removepremium\s+(\d+)$/, (msg, match) => handlePremiumCommand(bot, msg, match, false));
  bot.onText(/^\/help$/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "Xarajat yoki kirimni yozing: 25000 nonga, 50000 qarzim qaytdi. Hisobot va tahlil uchun tugmalardan foydalaning.",
      MAIN_KEYBOARD
    );
  });

  bot.on('callback_query', (query) => handleCallback(bot, query));
  bot.on('voice', (msg) => handleVoice(bot, msg));
  bot.on('photo', (msg) => handlePhoto(bot, msg));
  bot.on('message', (msg) => handleMessage(bot, msg));
  bot.on('polling_error', (error) => {
    console.error('Telegram polling xatosi:', error.message);
  });
}

module.exports = {
  MAIN_KEYBOARD,
  clearUserState,
  formatMoney,
  registerHandlers,
  setUserState
};
