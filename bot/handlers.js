const { categorizeExpense, categorizeVoiceExpense, generateAdvice, generatePlanGoalAnalysis } = require('../services/ai');
const apiUsageService = require('../services/apiUsageService');
const expenseService = require('../services/expenseService');
const userService = require('../services/userService');
const { rolloverUserMonth } = require('../jobs/monthCheck');

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ['📊 Hisobot', '💰 Maosh'],
      ['🤖 AI Tahlil', '⚙️ Sozlamalar'],
      ['🎯 Reja va Maqsad']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const SETTINGS_INLINE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "✏️ Ismni o'zgartirish", callback_data: 'settings_change_name' }],
      [{ text: "🗑️ Ma'lumotlarni tozalash", callback_data: 'settings_clear_request' }]
    ]
  }
};

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

const PAYMENT_START_CALLBACK = 'payment_send_receipt';
const PAYMENT_CONFIRM_PREFIX = 'payment_confirm_';
const PAYMENT_REJECT_PREFIX = 'payment_reject_';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_COUNT = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);
const FREE_DAILY_LIMIT = 15;
const PREMIUM_DAILY_LIMIT = 50;
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

  const isExpired = Date.now() - state.createdAt > 15 * 60 * 1000;
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
  // Maosh kiritishda "2 500 000" yoki "2500000" kabi formatlar qabul qilinadi.
  const raw = String(text || '').trim();

  if (/^\d{1,3}([ .]\d{3})+$/.test(raw)) {
    const groupedAmount = Number(raw.replace(/[ .]/g, ''));
    return groupedAmount > 0 ? groupedAmount : null;
  }

  const compact = raw.replace(/\s+/g, '');

  if (!/^\d+([.,]\d+)?$/.test(compact)) {
    return null;
  }

  const amount = Number(compact.replace(',', '.'));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function isPlanGoalButtonText(text) {
  return String(text || '')
    .replace(/\uFE0F/g, '')
    .trim()
    .toLowerCase()
    .includes('reja va maqsad');
}

function formatReport(user, summary) {
  const salary = Number(user.current_salary || 0);
  const totalSpent = Number(summary.totalSpent || 0);
  const balance = salary - totalSpent;
  const categoryLines = Object.entries(summary.byCategory)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([category, amount]) => `- ${category}: ${formatMoney(amount)}`);

  const percent = salary > 0 ? Math.round((totalSpent / salary) * 100) : 0;

  return [
    `📊 ${summary.month} hisobot`,
    '',
    `Maosh: ${formatMoney(salary)}`,
    `Jami xarajat: ${formatMoney(totalSpent)}${salary > 0 ? ` (${percent}%)` : ''}`,
    `Qolgan balans: ${formatMoney(balance)}`,
    '',
    'Kategoriyalar:',
    categoryLines.length ? categoryLines.join('\n') : "- Hali xarajat yo'q"
  ].join('\n');
}

function buildSalarySavedText(salary) {
  return [
    `Maosh saqlandi: ${formatMoney(salary)} ✅`,
    '',
    'Endi xarajatlaringizni istalgan vaqtda oddiy matn bilan yozib boraverishingiz mumkin. Masalan: 25000 nonga',
    '',
    '🆓 Bepul tarif:',
    '   📝 Matn orqali: kuniga 15 ta xarajat',
    '   🎤 Ovozli xabar: kuniga 2 ta',
    '',
    '💎 Premium tarif:',
    '   📝 Matn orqali: kuniga 50 ta xarajat',
    '   🎤 Ovozli xabar: kuniga 10 ta',
    '',
    "Bepul limitingiz tugagach, premium tarifga o'tish taklif qilinadi.",
    '',
    buildPremiumShortcutText()
  ].join('\n');
}

function buildNamePromptText() {
  return "Assalomu alaykum! Men sizning shaxsiy moliyaviy yordamchingizman. Avval ismingizni bilsam bo'ladimi?";
}

function buildSalaryPromptText(name) {
  return `Xush kelibsiz, ${name}! Endi oylik maoshingizni kiriting (so'mda). Masalan: 5000000`;
}

function buildStartWelcomeText(user) {
  return [
    `Xush kelibsiz, ${getDisplayName(user)}! Xarajatingizni yozing yoki pastdagi tugmalardan foydalaning.`,
    '',
    "Istasangiz, limitingiz tugashini kutmasdan, istalgan vaqtda /premium_narxi buyrug'i orqali premium tarifga o'tishingiz mumkin."
  ].join('\n');
}

function buildPremiumShortcutText() {
  return "Istasangiz, limitingiz tugashini kutmasdan, istalgan vaqtda /premium_narxi buyrug'i orqali premium tarifga o'tishingiz mumkin.";
}

function buildPremiumPriceText() {
  return [
    '💎 Premium tarif',
    '',
    '📝 Matn orqali: kuniga 50 ta xarajat',
    '🎤 Ovozli xabar: kuniga 10 ta',
    '🎯 Reja va Maqsad tahlili (yangi!)',
    '',
    `💳 Karta: ${getPaymentCardNumber()}`,
    `💰 Narxi: ${formatPaymentPrice()} so'm/oy`,
    '',
    "To'lov qilgach, pastdagi tugmani bosib, chek rasmini yuboring."
  ].join('\n');
}

function buildPlanGoalPremiumOnlyText() {
  return [
    '🎯 Bu funksiya faqat premium foydalanuvchilar uchun mavjud.',
    '',
    "Premium tarifga o'tish uchun: /premium_narxi"
  ].join('\n');
}

function buildPlanGoalIntroText() {
  return [
    '🎯 Reja va Maqsad',
    '',
    "Keyingi oy uchun xarajat rejangizni va maqsadingizni yozing — AI sizga tahlil beradi.",
    '',
    "⚠️ Bu ma'lumot saqlanmaydi va limitdan 15 ta hisoblanadi.",
    '',
    "Avval, keyingi oy uchun kutilayotgan daromadingizni kiriting (so'mda):"
  ].join('\n');
}

function buildPlanGoalIncomeSavedText(income) {
  return [
    `✅ Daromad: ${formatMoney(income)}`,
    '',
    "Endi xarajat rejangizni va maqsadingizni yozing. Misol:",
    "'Oziq-ovqat 800000, Uy-joy 1200000. Telefon 2.5mln, 3 oyga 836000 dan bo'lib to'lash mumkinmi?'"
  ].join('\n');
}

function buildPlanGoalLimitRequiredText(remainingLimit) {
  return [
    `Bu funksiya uchun ${PLAN_GOAL_LIMIT_COST} ta limit kerak, lekin sizda bugun faqat ${remainingLimit} ta qoldi.`,
    "Ertaga qayta urinib ko'ring."
  ].join('\n');
}

function buildPlanGoalResultText(analysisText) {
  return [
    '📊 Tahlil natijasi:',
    '',
    String(analysisText || '').trim(),
    '',
    "⚠️ Eslatma: bu ma'lumotlar saqlanmadi. Qaytadan tahlil qilish uchun '🎯 Reja va Maqsad' tugmasini yana bosishingiz kerak bo'ladi."
  ].join('\n');
}

function buildLimitReachedText(dailyLimit) {
  return [
    `Bugungi bepul limitingiz tugadi (${dailyLimit} ta). Ko'proq xarajat kiritish uchun premium sotib oling:`,
    '',
    `💳 Karta: ${getPaymentCardNumber()}`,
    `💰 Narxi: ${formatPaymentPrice()} so'm/oy`,
    '',
    "To'lov qilgach, pastdagi tugmani bosib, chek rasmini yuboring.",
    '',
    buildPremiumShortcutText()
  ].join('\n');
}

function buildFreeVoiceLimitReachedText(usedCount, dailyVoiceLimit) {
  return [
    `🎤 Bugungi bepul ovozli xabar limitingiz tugadi (${usedCount}/${dailyVoiceLimit} ta).`,
    '',
    "Ko'proq ovozli xabar yuborish uchun premium sotib oling:",
    `💳 Karta: ${getPaymentCardNumber()}`,
    `💰 Narxi: ${formatPaymentPrice()} so'm/oy`,
    '',
    'Yoki xarajatni matn bilan yozing (masalan: 25000 nonga).',
    '',
    buildPremiumShortcutText()
  ].join('\n');
}

function buildPremiumVoiceLimitReachedText(usedCount, dailyVoiceLimit) {
  return [
    `🎤 Bugungi ovozli xabar limitingiz tugadi (${usedCount}/${dailyVoiceLimit} ta).`,
    '',
    'Ertaga yana foydalanishingiz mumkin. Hozircha xarajatni matn bilan yozing (masalan: 25000 nonga).'
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
      `📊 Bugungi limit: ${todayExpenseCount}/${dailyLimit} ta xarajat`,
      '',
      'Kerakli amalni tanlang:'
    ].join('\n');
  }

  return [
    '⚙️ Sozlamalar',
    '',
    '🆓 Status: Bepul',
    `📊 Bugungi limit: ${todayExpenseCount}/${dailyLimit} ta xarajat`,
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
    "Uning barcha ma'lumotlari (xarajatlar, tarix, profil) butunlay o'chadi va qaytarib bo'lmaydi."
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
  const label = note || expense?.category || 'Xarajat';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function buildSkippedExpensesText(skippedCount) {
  return skippedCount > 0
    ? `Limit tugagani sababli ${skippedCount} ta xarajat saqlanmadi.`
    : null;
}

function buildSavedExpensesText(savedExpenses, balance, skippedCount = 0) {
  const skippedText = buildSkippedExpensesText(skippedCount);

  if (savedExpenses.length === 1) {
    const savedExpense = savedExpenses[0];
    return [
      `✅ Saqlandi: ${formatMoney(savedExpense.amount)}`,
      `Kategoriya: ${savedExpense.category}`,
      `Qolgan balans: ${formatMoney(balance)}`,
      skippedText ? '' : null,
      skippedText
    ].filter((line) => line !== null).join('\n');
  }

  const totalSaved = savedExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const expenseLines = savedExpenses.map((expense, index) => (
    `${index + 1}. ${formatExpenseLabel(expense)} — ${formatMoney(expense.amount)} (${expense.category})`
  ));

  return [
    `✅ ${savedExpenses.length} ta xarajat saqlandi:`,
    '',
    expenseLines.join('\n'),
    '',
    `Jami: ${formatMoney(totalSaved)}`,
    `Qolgan balans: ${formatMoney(balance)}`,
    skippedText ? '' : null,
    skippedText
  ].filter((line) => line !== null).join('\n');
}

async function getCurrentBalance(user, month = user?.current_month || userService.getMonthKey()) {
  const summary = await expenseService.getMonthlySummary(user.id, month);
  return Number(user.current_salary || 0) - Number(summary.totalSpent || 0);
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
  try {
    await bot.sendMessage(chatId, "Tahlil tayyorlanmoqda, bir necha soniya kuting...", MAIN_KEYBOARD);
    const adviceData = await expenseService.getAdviceData(user);
    const advice = await generateAdvice(adviceData);
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
    await bot.sendMessage(chatId, "Daromadni faqat musbat raqam shaklida yozing. Masalan: 5000000", getPlanGoalCancelMarkup());
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
      totalSpent: Number(summary.totalSpent || 0)
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

async function handleSalaryInput(bot, chatId, telegramId, user, text, nextState = null) {
  const amount = parsePositiveAmount(text);

  if (!amount) {
    await bot.sendMessage(chatId, "Maoshni faqat musbat raqam shaklida yozing. Masalan: 5000000", MAIN_KEYBOARD);
    return null;
  }

  const updatedUser = await userService.updateSalary(user.id, amount, userService.getMonthKey());
  clearUserState(telegramId);

  if (nextState) {
    setUserState(telegramId, nextState);
  }

  await bot.sendMessage(
    chatId,
    buildSalarySavedText(updatedUser.current_salary),
    MAIN_KEYBOARD
  );

  return updatedUser;
}

async function handleSettings(bot, chatId, user) {
  const todayExpenseCount = userService.getDailyUsageCount(user, 'text');

  await bot.sendMessage(
    chatId,
    buildSettingsText(user, todayExpenseCount),
    SETTINGS_INLINE_KEYBOARD
  );
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
  const cleanText = String(text || '').trim();

  if (!cleanText || cleanText.length > 200) {
    await bot.sendMessage(chatId, "Xarajat matni 1 dan 200 belgigacha bo'lishi kerak.", MAIN_KEYBOARD);
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

    // Erkin matn Gemini orqali bir yoki bir nechta strukturali xarajatga aylantiriladi.
    const parsedExpenses = await categorizeExpense(cleanText);
    const expenses = (Array.isArray(parsedExpenses) ? parsedExpenses : [parsedExpenses]).filter(Boolean);

    if (!expenses.length) {
      await bot.sendMessage(chatId, "Tushunmadim, qaytadan yozing. Masalan: 25000 nonga", MAIN_KEYBOARD);
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
    const savedExpenses = [];

    for (const expense of expensesToSave) {
      const savedExpense = await expenseService.createExpense(user.id, expense, month);
      savedExpenses.push(savedExpense);
    }

    await userService.incrementDailyUsage(user, savedExpenses.length, 'text');

    const summary = await expenseService.getMonthlySummary(user.id, month);
    const balance = Number(user.current_salary || 0) - Number(summary.totalSpent || 0);

    const messageOptions = expenses.length === 1 && savedExpenses.length === 1 && skippedCount === 0
      ? getExpenseActionMarkup(savedExpenses[0], user.telegram_id)
      : MAIN_KEYBOARD;

    await bot.sendMessage(
      chatId,
      buildSavedExpensesText(savedExpenses, balance, skippedCount),
      messageOptions
    );
  } catch (error) {
    console.error('Xarajatni qayta ishlashda xato:', error);
    if (error.code === 'AI_TEMPORARILY_UNAVAILABLE') {
      await bot.sendMessage(chatId, error.userMessage || "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Tushunmadim, qaytadan yozing. Masalan: 25000 nonga", MAIN_KEYBOARD);
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
      await bot.sendMessage(chatId, "Ovozli xabarni o'qib bo'lmadi. Xarajatni matn bilan yozib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Ovozli xabar tahlil qilinmoqda, bir necha soniya kuting...", MAIN_KEYBOARD);

    const fileUrl = await bot.getFileLink(voice.file_id);
    const parsedExpense = await categorizeVoiceExpense(fileUrl, voice.mime_type || 'audio/ogg');
    const month = user.current_month || userService.getMonthKey();
    const savedExpense = await expenseService.createExpense(user.id, parsedExpense, month, 'voice');
    await userService.incrementDailyUsage(user, 1, 'voice');
    const summary = await expenseService.getMonthlySummary(user.id, month);
    const balance = Number(user.current_salary || 0) - Number(summary.totalSpent || 0);

    await bot.sendMessage(
      chatId,
      [
        `✅ Ovozli xarajat saqlandi: ${formatMoney(savedExpense.amount)}`,
        `Kategoriya: ${savedExpense.category}`,
        `Qolgan balans: ${formatMoney(balance)}`
      ].join('\n'),
      getExpenseActionMarkup(savedExpense, user.telegram_id)
    );
  } catch (error) {
    console.error('Ovozli xarajatni qayta ishlashda xato:', error);

    if (error.code === 'AI_TEMPORARILY_UNAVAILABLE') {
      await bot.sendMessage(chatId, error.userMessage || "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
      return;
    }

    await bot.sendMessage(chatId, "Ovozli xabarni tushunmadim. Xarajatni matn bilan yozib ko'ring: 25000 nonga", MAIN_KEYBOARD);
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
      "✅ To'lovingiz tasdiqlandi! Premium tarif faollashtirildi, endi kuniga 50 ta matnli va 10 ta ovozli xarajat kirita olasiz.",
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
          'Sizga premium tarif ochildi! Endi kuniga 50 ta matnli va 10 ta ovozli xarajat kirita olasiz',
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
    await answerCallback(bot, query, 'Bu xarajat sizga tegishli emas.');
    return;
  }

  await answerCallback(bot, query);

  if (expenseAction.action === 'deleteAsk') {
    const expense = await expenseService.getExpenseByIdForUser(user.id, expenseAction.expenseId);

    if (!expense) {
      await editCallbackMessageText(
        bot,
        query,
        "Xarajat topilmadi yoki allaqachon o'chirilgan.",
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    await editCallbackMessageText(
      bot,
      query,
      [
        "Bu xarajatni o'chirmoqchimisiz?",
        '',
        `${formatMoney(expense.amount)} (${expense.category})`
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
        `✅ Xarajat o'chirildi. Yangi balans: ${formatMoney(balance)}`,
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      if (error.code === 'EXPENSE_NOT_FOUND') {
        await editCallbackMessageText(
          bot,
          query,
          "Xarajat allaqachon o'chirilgan yoki topilmadi.",
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
        "Xarajat topilmadi yoki allaqachon o'chirilgan.",
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    await removeInlineKeyboard(bot, query);
    setUserState(telegramId, 'awaiting_expense_edit_amount', {
      expenseId: expense.id,
      oldAmount: Number(expense.amount || 0),
      category: expense.category,
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

    const adminStatsCallback = parseAdminStatsCallback(query.data);

    if (adminStatsCallback) {
      await handleAdminStatsCallback(bot, query, adminStatsCallback);
      return;
    }

    if (isCallbackMessageConsumed(callbackKey)) {
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

    await answerCallback(bot, query);

    const user = await userService.ensureUser(query.from);

    if (query.data === PAYMENT_START_CALLBACK) {
      await consumeCallbackMessage(bot, query, callbackKey);
      await userService.updateAwaitingPayment(user.id, true);
      await bot.sendMessage(chatId, "Chek yoki to'lov skrinshotini shu yerga yuboring.", MAIN_KEYBOARD);
      return;
    }

    if (query.data === PLAN_GOAL_CANCEL_CALLBACK) {
      await consumeCallbackMessage(bot, query, callbackKey);
      clearUserState(telegramId);
      await bot.sendMessage(chatId, 'Bekor qilindi.', MAIN_KEYBOARD);
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
        "Barcha xarajatlar, tarix va maosh ma'lumotlari o'chadi. Davom etasizmi?",
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
    await bot.sendMessage(chatId, "Yangi summani musbat raqam shaklida yozing. Masalan: 53200", MAIN_KEYBOARD);
    return;
  }

  try {
    const existingExpense = await expenseService.getExpenseByIdForUser(user.id, stateData.expenseId);

    if (!existingExpense) {
      clearUserState(telegramId);
      await bot.sendMessage(chatId, "Tahrirlanadigan xarajat topilmadi yoki allaqachon o'chirilgan.", MAIN_KEYBOARD);
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
        `✅ Yangilandi: ${formatMoney(oldAmount)} -> ${formatMoney(updatedExpense.amount)}`,
        `Kategoriya: ${updatedExpense.category}`,
        `Yangi balans: ${formatMoney(balance)}`
      ].join('\n'),
      MAIN_KEYBOARD
    );
  } catch (error) {
    console.error('Xarajatni tahrirlashda xato:', error);
    clearUserState(telegramId);
    await bot.sendMessage(chatId, "Xarajatni tahrirlashda xato bo'ldi. Birozdan keyin qayta urinib ko'ring.", MAIN_KEYBOARD);
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
      await handleSalaryInput(bot, chatId, telegramId, user, normalizedText);
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

    if (normalizedText === '📊 Hisobot') {
      await handleReport(bot, chatId, user);
      return;
    }

    if (normalizedText === '🤖 AI Tahlil') {
      await handleAnalysis(bot, chatId, user);
      return;
    }

    if (normalizedText === '💰 Maosh') {
      setUserState(telegramId, 'awaiting_new_salary');
      await bot.sendMessage(chatId, `Hozirgi maosh: ${formatMoney(user.current_salary)}. Yangi summani kiriting.`, MAIN_KEYBOARD);
      return;
    }

    if (normalizedText === '⚙️ Sozlamalar') {
      await handleSettings(bot, chatId, user);
      return;
    }

    if (isPlanGoalButtonText(normalizedText)) {
      await handlePlanGoalStart(bot, chatId, telegramId, user);
      return;
    }

    if (Number(user.current_salary || 0) <= 0) {
      const amount = parsePositiveAmount(normalizedText);

      if (amount) {
        await handleSalaryInput(bot, chatId, telegramId, user, normalizedText);
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
      "Xarajatni oddiy yozing: 25000 nonga. Hisobot va tahlil uchun pastdagi tugmalardan foydalaning.",
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
