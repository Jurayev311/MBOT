require('dotenv').config({ quiet: true });

const { GoogleGenerativeAI } = require('@google/generative-ai');
const apiUsageService = require('./apiUsageService');

const CATEGORIES = [
  'Oziq-ovqat',
  'Transport',
  'Kommunal',
  'Uy-joy',
  "Sog'liq",
  "Ta'lim",
  'Texnika',
  'Kiyim-kechak',
  "Bo'lib to'lash",
  'Oilaviy yordam',
  "Ko'ngilochar",
  'Boshqa'
];
const INCOME_CATEGORY = 'Kirim';

const FIXED_CATEGORIES = ['Kommunal', "Sog'liq", 'Uy-joy', "Bo'lib to'lash"];
const SIMPLE_FLEXIBLE_CATEGORIES = [
  'Oziq-ovqat',
  "Ta'lim",
  'Texnika',
  'Kiyim-kechak',
  'Oilaviy yordam',
  'Boshqa'
];
const EASY_FLEXIBLE_CATEGORIES = ['Transport', "Ko'ngilochar"];
const FLEXIBLE_CATEGORIES = [...SIMPLE_FLEXIBLE_CATEGORIES, ...EASY_FLEXIBLE_CATEGORIES];
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const AI_BUSY_MESSAGE = "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.";
const AI_ANALYSIS_UNAVAILABLE_MESSAGE = "Hozir tahlil qila olmadim, birozdan keyin qayta urinib ko'ring";
const PLAN_GOAL_UNAVAILABLE_MESSAGE = "Hozir reja tahlilini qila olmadim, birozdan keyin qayta urinib ko'ring.";
const GEMINI_MIN_INTERVAL_MS = 300;
const GEMINI_RETRY_DELAY_MS = 2000;
const SIGNED_AMOUNT_PATTERN = /\+?\b\d{1,3}(?:[ .]\d{3})+(?:[,.]\d+)?\b|\+?\b\d+(?:[,.]\d+)?\b/;
const INCOME_KEYWORDS = [
  'qarzimni qaytardi',
  'qarzini qaytardi',
  'qarz qaytdi',
  'qarz qaytardi',
  'qarz qaytarildi',
  'pul keldi',
  "sovg'a berdi",
  'sovga berdi',
  'topib oldim',
  "qo'shimcha ish haqi",
  'qoshimcha ish haqi',
  "qo'shimcha daromad",
  'qoshimcha daromad',
  'kirim',
  'daromad'
];
const CATEGORY_KEYWORDS = [
  {
    category: 'Uy-joy',
    keywords: ['kvartira', 'ijara', 'uy-joy', 'uy joy', 'uy uchun', 'kvartira uchun', 'arenda', 'renta']
  },
  {
    category: "Bo'lib to'lash",
    keywords: ['kredit', "bo'lib", 'bolib', 'rassrochka', 'muddatli', 'oylik tolov', "oylik to'lov", 'muntazam tolov', "muntazam to'lov"]
  },
  {
    category: 'Oilaviy yordam',
    keywords: ['dadam', 'otam', 'adamga', 'onam', 'oyim', 'akam', 'ukam', 'opam', 'singlim', 'qarindosh', 'ota-onam', 'ota onam', 'oilamga']
  },
  {
    category: "Ta'lim",
    keywords: ["o'qish", 'oqish', 'kontrakt', 'universitet', 'maktab', 'kurs', 'repetitor', 'kitob', 'daftar', "ta'lim", 'talim']
  },
  {
    category: 'Texnika',
    keywords: ['telefon', 'smartfon', 'iphone', 'android', 'noutbuk', 'laptop', 'kompyuter', 'planshet', 'televizor', 'muzlatkich', 'konditsioner', 'texnika']
  },
  {
    category: 'Transport',
    keywords: ['taxi', 'taksi', 'yandex', 'metro', 'avtobus', 'transport', 'benzin', 'yoqilgi', 'yonilgi', "yo'l", 'yol']
  },
  {
    category: 'Oziq-ovqat',
    keywords: ['non', 'nonga', 'ovqat', 'osh', 'somsa', 'lavash', 'market', 'supermarket', 'meva', 'sabzavot', 'choy', 'qahva', 'ichimlik']
  },
  {
    category: 'Kommunal',
    keywords: ['kommunal', 'svet', 'elektr', 'gaz', 'suv', 'internet']
  },
  {
    category: "Ko'ngilochar",
    keywords: ['kino', 'konsert', "o'yin", 'oyin', 'netflix', 'spotify', 'dam olish', 'kafe', 'restoran', 'sayohat']
  },
  {
    category: 'Kiyim-kechak',
    keywords: ['kiyim', "ko'ylak", 'koylak', 'shim', 'poyabzal', 'krossovka', 'futbolka']
  },
  {
    category: "Sog'liq",
    keywords: ['dori', 'dorixona', 'shifokor', 'klinika', 'kasalxona', "sog'liq", 'sogliq', 'tish']
  }
];

const CATEGORY_ALIASES = {
  'uy joy': 'Uy-joy',
  'uy-joy': 'Uy-joy',
  uyjoy: 'Uy-joy',
  talim: "Ta'lim",
  "ta'lim": "Ta'lim",
  texnika: 'Texnika',
  'bolib tolash': "Bo'lib to'lash",
  "bo'lib to'lash": "Bo'lib to'lash",
  'bolib tolovi': "Bo'lib to'lash",
  "bo'lib to'lovi": "Bo'lib to'lash",
  kredit: "Bo'lib to'lash",
  'oilaviy yordam': 'Oilaviy yordam',
  oila: 'Oilaviy yordam'
};

let geminiModel;
let geminiModelName;
let geminiRequestQueue = Promise.resolve();
let lastGeminiRequestAt = 0;

function getConfiguredModelName() {
  const rawModel = String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  return (rawModel || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
}

function isAiDebugEnabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.AI_DEBUG || '').toLowerCase());
}

function debugAi(label, value) {
  if (isAiDebugEnabled()) {
    console.log(`[AI_DEBUG] ${label}:`, value);
  }
}

async function logApiUsageSafely() {
  try {
    await apiUsageService.logApiUsage();
  } catch (error) {
    console.error("AI so'rovini api_usage_log jadvaliga yozishda xato:", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error) {
  const message = String(error?.message || '');
  const status = Number(error?.status || error?.code || 0);

  return status === 429
    || message.includes('429')
    || message.includes('QuotaFailure')
    || message.includes('Too Many Requests');
}

function createAiBusyError(cause) {
  const error = new Error('AI_TEMPORARILY_UNAVAILABLE');
  error.code = 'AI_TEMPORARILY_UNAVAILABLE';
  error.userMessage = AI_BUSY_MESSAGE;
  error.cause = cause;
  return error;
}

function createAnalysisUnavailableError(cause) {
  const error = new Error('AI_ANALYSIS_UNAVAILABLE');
  error.code = 'AI_ANALYSIS_UNAVAILABLE';
  error.userMessage = AI_ANALYSIS_UNAVAILABLE_MESSAGE;
  error.cause = cause;
  return error;
}

function createPlanGoalUnavailableError(cause) {
  const error = new Error('PLAN_GOAL_UNAVAILABLE');
  error.code = 'PLAN_GOAL_UNAVAILABLE';
  error.userMessage = PLAN_GOAL_UNAVAILABLE_MESSAGE;
  error.cause = cause;
  return error;
}

async function runWithGeminiPacing(task) {
  const queuedTask = geminiRequestQueue.then(async () => {
    const elapsed = Date.now() - lastGeminiRequestAt;

    if (elapsed < GEMINI_MIN_INTERVAL_MS) {
      await sleep(GEMINI_MIN_INTERVAL_MS - elapsed);
    }

    lastGeminiRequestAt = Date.now();
    return task();
  });

  geminiRequestQueue = queuedTask.catch(() => {});
  return queuedTask;
}

async function callGeminiWithRetry(label, task) {
  try {
    return await runWithGeminiPacing(task);
  } catch (error) {
    debugAi(`${label}.requestError`, {
      model: geminiModelName || getConfiguredModelName(),
      message: error.message,
      status: error.status || error.code
    });

    if (!isRetryableGeminiError(error)) {
      throw error;
    }

    await sleep(GEMINI_RETRY_DELAY_MS);

    try {
      return await runWithGeminiPacing(task);
    } catch (retryError) {
      debugAi(`${label}.retryError`, {
        model: geminiModelName || getConfiguredModelName(),
        message: retryError.message,
        status: retryError.status || retryError.code
      });

      if (isRetryableGeminiError(retryError)) {
        throw createAiBusyError(retryError);
      }

      throw retryError;
    }
  }
}

function getGeminiModel() {
  if (geminiModel) {
    return geminiModel;
  }

  // Gemini client faqat birinchi AI so'rovida yaratiladi.
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY .env faylida kiritilishi kerak.');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModelName = getConfiguredModelName();
  geminiModel = genAI.getGenerativeModel({
    model: geminiModelName
  });

  return geminiModel;
}

function compactInput(text, maxLength = 200) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function fetchAsBase64(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Ovozli faylni yuklab bo'lmadi: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

function extractJson(rawText) {
  const text = String(rawText || '').trim();
  // Model ba'zan JSON atrofida markdown fence qaytarishi mumkin.
  const withoutFence = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBracket = withoutFence.indexOf('[');
  const lastBracket = withoutFence.lastIndexOf(']');
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');

  if (firstBracket !== -1
    && lastBracket !== -1
    && lastBracket > firstBracket
    && (firstBrace === -1 || firstBracket < firstBrace)) {
    return withoutFence.slice(firstBracket, lastBracket + 1);
  }

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Gemini JSON qiymat qaytarmadi.');
  }

  return withoutFence.slice(firstBrace, lastBrace + 1);
}

function toPositiveNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/[^\d.,]/g, '');

  if (!cleaned) {
    return null;
  }

  const noSpaces = raw.replace(/\s+/g, '');
  const normalized = /^\d{1,3}([., ]\d{3})+$/.test(raw)
    ? raw.replace(/[., ]/g, '')
    : cleaned.includes(',') && !cleaned.includes('.') && !/^\d{1,3}(,\d{3})+$/.test(noSpaces)
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeCategoryKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/ʻ/g, "'")
    .replace(/\s+/g, ' ');
}

function normalizeCategory(value) {
  const requested = normalizeCategoryKey(value);
  const exactMatch = CATEGORIES.find((category) => normalizeCategoryKey(category) === requested);

  return exactMatch || CATEGORY_ALIASES[requested] || 'Boshqa';
}

function normalizeKeywordText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/ʻ/g, "'")
    .replace(/\s+/g, ' ');
}

function inferTransactionType(text, rawAmount = '') {
  if (String(rawAmount || '').trim().startsWith('+')) {
    return 'income';
  }

  const normalizedText = normalizeKeywordText(text);
  const hasIncomeKeyword = INCOME_KEYWORDS.some((keyword) => (
    normalizedText.includes(normalizeKeywordText(keyword))
  ));

  return hasIncomeKeyword ? 'income' : 'expense';
}

function normalizeTransactionType(value, context = '', category = '') {
  const requested = normalizeKeywordText(value);

  if (requested === 'income' || requested === 'kirim' || requested === 'daromad') {
    return 'income';
  }

  if (requested === 'expense' || requested === 'chiqim' || requested === 'xarajat') {
    return 'expense';
  }

  if (normalizeCategoryKey(category) === normalizeCategoryKey(INCOME_CATEGORY)) {
    return 'income';
  }

  return inferTransactionType(context);
}

function normalizeExpensePayload(payload, fallbackNote) {
  const amount = toPositiveNumber(payload.amount);

  if (!amount) {
    throw new Error("Gemini summa qiymatini to'g'ri ajratmadi.");
  }

  const typeContext = payload.note
    ? String(payload.note)
    : String(fallbackNote || '');
  const type = normalizeTransactionType(payload.type, typeContext, payload.category);

  return {
    amount,
    type,
    category: type === 'income' ? INCOME_CATEGORY : normalizeCategory(payload.category),
    note: compactInput(payload.note || fallbackNote, 200)
  };
}

function normalizeExpenseListPayload(payload, fallbackNote) {
  const expenses = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.expenses)
      ? payload.expenses
      : payload?.amount
        ? [payload]
        : [];

  if (!expenses.length) {
    throw new Error("Gemini xarajatlar ro'yxatini qaytarmadi.");
  }

  return expenses.map((expense) => normalizeExpensePayload(expense, fallbackNote));
}

function inferCategory(text) {
  const lowerText = String(text || '').toLowerCase();

  const matched = CATEGORY_KEYWORDS.find(({ keywords }) => (
    keywords.some((keyword) => lowerText.includes(keyword))
  ));

  return matched?.category || 'Boshqa';
}

function parseExpenseLocally(text) {
  const cleanText = compactInput(text, 200);
  const amountMatch = cleanText.match(SIGNED_AMOUNT_PATTERN);

  if (!amountMatch) {
    return null;
  }

  const amount = toPositiveNumber(amountMatch[0]);

  if (!amount) {
    return null;
  }

  const note = compactInput(cleanText.replace(amountMatch[0], '').trim() || cleanText, 200);
  const type = inferTransactionType(cleanText, amountMatch[0]);

  return {
    amount,
    type,
    category: type === 'income' ? INCOME_CATEGORY : inferCategory(cleanText),
    note
  };
}

function parseExpensesLocally(text) {
  const cleanText = compactInput(text, 200);
  const amountMatches = [...cleanText.matchAll(new RegExp(SIGNED_AMOUNT_PATTERN.source, 'g'))];

  if (!amountMatches.length) {
    return null;
  }

  const amounts = amountMatches
    .map((match) => ({
      raw: match[0],
      index: match.index,
      amount: toPositiveNumber(match[0])
    }))
    .filter((match) => match.amount);

  if (!amounts.length) {
    return null;
  }

  const lastAmount = amounts[amounts.length - 1];
  const tailAfterLastAmount = compactInput(
    cleanText
      .slice(lastAmount.index + lastAmount.raw.length)
      .replace(/^[\s+;,.-]+/, ''),
    200
  );
  const tailParts = tailAfterLastAmount
    .split(/\s+(?:va|hamda)\s+|[;,]/i)
    .map((part) => compactInput(part.replace(/^[\s+;,.-]+|[\s+;,.-]+$/g, ''), 80))
    .filter(Boolean)
    .map((part) => (
      /to'?lovi|tolovi/i.test(tailAfterLastAmount) && !/to'?lov|tolov/i.test(part)
        ? `${part} to'lovi`
        : part
    ));
  const canUseTailPartsForNotes = amounts.length > 1 && tailParts.length === amounts.length;

  return amounts.map((match, index) => {
    const nextMatch = amounts[index + 1];
    const previousText = cleanText.slice(0, match.index);
    const previousDelimiter = Math.max(
      previousText.lastIndexOf(','),
      previousText.lastIndexOf(';'),
      previousText.lastIndexOf('\n')
    );
    const amountEnd = match.index + match.raw.length;
    const nextDelimiterCandidates = [',', ';', '\n']
      .map((delimiter) => cleanText.indexOf(delimiter, amountEnd))
      .filter((delimiterIndex) => delimiterIndex !== -1);
    const nextDelimiter = nextDelimiterCandidates.length
      ? Math.min(...nextDelimiterCandidates)
      : -1;
    const segmentStart = match.raw.startsWith('+')
      ? match.index
      : previousDelimiter === -1 ? 0 : previousDelimiter + 1;
    const segmentEnd = [
      nextMatch?.index,
      nextDelimiter === -1 ? null : nextDelimiter,
      cleanText.length
    ]
      .filter((value) => Number.isInteger(value))
      .reduce((min, value) => Math.min(min, value), cleanText.length);
    const segmentText = cleanText.slice(segmentStart, segmentEnd);
    const noteFromSegment = compactInput(
      segmentText
        .replace(match.raw, '')
        .replace(/^[\s+;,.-]*(?:va\s+)?/i, '')
        .replace(/[\s+;,.-]+$/g, ''),
      80
    );
    const note = canUseTailPartsForNotes
      ? tailParts[index]
      : noteFromSegment || tailAfterLastAmount || cleanText;
    const typeContext = `${match.raw} ${note} ${segmentText}`;
    const type = inferTransactionType(typeContext, match.raw);

    return {
      amount: match.amount,
      type,
      category: type === 'income' ? INCOME_CATEGORY : inferCategory(note),
      note
    };
  });
}

function formatMoney(value) {
  return `${new Intl.NumberFormat('uz-UZ').format(Math.round(Number(value || 0)))} so'm`;
}

function formatPercent(value) {
  return String(Math.round(Number(value || 0)));
}

function getDateParts(date = new Date()) {
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function getMonthTiming(date = new Date()) {
  const parts = getDateParts(date);
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  const dayOfMonth = Math.max(1, parts.day || 1);

  return {
    dayOfMonth,
    daysInMonth,
    daysRemaining: Math.max(0, daysInMonth - dayOfMonth)
  };
}

function getCategoryPercent(amount, totalSpent) {
  const total = Number(totalSpent || 0);

  if (total <= 0) {
    return 0;
  }

  return Math.round((Number(amount || 0) / total) * 100);
}

function buildCategoryBreakdown(byCategory = {}, totalSpent = 0) {
  return CATEGORIES.map((category) => {
    const amount = Math.round(Number(byCategory[category] || 0));

    return {
      category,
      amount,
      percent: getCategoryPercent(amount, totalSpent),
      type: FIXED_CATEGORIES.includes(category) ? 'fixed' : 'flexible'
    };
  });
}

function formatCategoryBreakdownList(items) {
  const positiveItems = items.filter((item) => item.amount > 0);

  if (!positiveItems.length) {
    return "xarajat yo'q";
  }

  return positiveItems
    .map((item) => `${item.category}: ${formatMoney(item.amount)} (${item.percent}%)`)
    .join('; ');
}

function getLastSentenceEndIndex(text) {
  return Math.max(
    text.lastIndexOf('.'),
    text.lastIndexOf('!'),
    text.lastIndexOf('?')
  );
}

function truncateAdviceText(text, maxLength = 500, options = {}) {
  const { preferCompleteSentence = false } = options;
  const cleanText = String(text || '').replace(/\s+\n/g, '\n').trim();

  if (!cleanText) {
    return '';
  }

  const limit = Number.isFinite(Number(maxLength)) && Number(maxLength) > 0
    ? Number(maxLength)
    : 500;
  const isOverLimit = cleanText.length > limit;
  const safeText = isOverLimit
    ? cleanText.slice(0, limit).trim()
    : cleanText;

  if (/[.!?]$/.test(safeText)) {
    return safeText;
  }

  const lastSentenceEnd = getLastSentenceEndIndex(safeText);
  const minSentenceEnd = preferCompleteSentence
    ? 0
    : Math.floor(limit * 0.25);

  if (lastSentenceEnd > minSentenceEnd) {
    return safeText.slice(0, lastSentenceEnd + 1).trim();
  }

  if (!isOverLimit && !preferCompleteSentence) {
    return safeText;
  }

  const lastSpace = safeText.lastIndexOf(' ');
  const minSpace = preferCompleteSentence
    ? 0
    : Math.floor(limit * 0.45);

  if (lastSpace > minSpace) {
    return `${safeText.slice(0, lastSpace).trim()}...`;
  }

  return `${safeText}...`;
}

function getTopCategory(byCategory = {}) {
  const [name, amount] = Object.entries(byCategory)
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0] || [];

  return name
    ? { name, amount: Number(amount || 0) }
    : { name: 'Boshqa', amount: 0 };
}

function getTopFlexibleCategory(byCategory = {}) {
  const flexibleAmounts = FLEXIBLE_CATEGORIES.reduce((acc, category) => {
    acc[category] = Number(byCategory[category] || 0);
    return acc;
  }, {});

  return getTopCategory(flexibleAmounts);
}

function buildAdviceMetrics(userData) {
  const current = userData?.currentMonth || {};
  const salary = Number(current.salary || 0);
  const totalSpent = Number(current.totalSpent || 0);
  const totalIncome = Number(current.totalIncome || 0);
  const netSpent = Number.isFinite(Number(current.netSpent))
    ? Number(current.netSpent)
    : totalSpent - totalIncome;
  const byCategory = current.byCategory || {};
  const categoryBreakdown = buildCategoryBreakdown(byCategory, totalSpent);
  const fixedBreakdown = categoryBreakdown.filter((item) => item.type === 'fixed');
  const flexibleBreakdown = categoryBreakdown.filter((item) => item.type === 'flexible');
  const topCategory = getTopCategory(byCategory);
  const adviceCategory = getTopFlexibleCategory(byCategory);
  const adviceReductionPercent = adviceCategory.amount > 0
    ? EASY_FLEXIBLE_CATEGORIES.includes(adviceCategory.name) ? 20 : 10
    : 0;
  const adviceSavings = adviceCategory.amount > 0
    ? Math.round(adviceCategory.amount * (adviceReductionPercent / 100))
    : 0;
  const spentPercent = salary > 0 ? (netSpent / salary) * 100 : 0;
  const remainingBalance = salary - netSpent;
  const monthTiming = getMonthTiming();
  const dailyAverage = netSpent / Math.max(1, monthTiming.dayOfMonth);
  const projectedMonthlySpent = Math.round(dailyAverage * monthTiming.daysInMonth);
  const projectedMonthEndBalance = Math.round(salary - projectedMonthlySpent);
  const projectionLimit = salary > 0 ? salary * 2 : 0;
  const canShowProjectedBalance = salary > 0
    && Math.abs(projectedMonthEndBalance) <= projectionLimit;

  return {
    month: current.month,
    salary,
    totalSpent,
    totalIncome,
    netSpent,
    spentPercent: Math.round(spentPercent),
    remainingBalance: Math.round(remainingBalance),
    dayOfMonth: monthTiming.dayOfMonth,
    daysInMonth: monthTiming.daysInMonth,
    daysRemaining: monthTiming.daysRemaining,
    categoryBreakdown,
    fixedBreakdown,
    flexibleBreakdown,
    projectedMonthlySpent,
    projectedMonthEndBalance,
    canShowProjectedBalance,
    projectionHint: canShowProjectedBalance
      ? `oy oxirida taxminiy balans ${formatMoney(projectedMonthEndBalance)}`
      : projectedMonthEndBalance >= 0
        ? "aniq prognoz sonini yozma; hozirgi sur'atda oy oxirigacha yetarli yoki ehtiyotkorlik kerak deb sifat jihatidan ayt"
        : "aniq prognoz sonini yozma; tejash kerak deb sifat jihatidan ayt",
    topCategory: {
      name: topCategory.name,
      amount: Math.round(topCategory.amount)
    },
    adviceCategory: adviceCategory.amount > 0
      ? {
        name: adviceCategory.name,
        amount: Math.round(adviceCategory.amount),
        reductionPercent: adviceReductionPercent,
        savings: adviceSavings
      }
      : null,
    byCategory
  };
}

function getCategoryAdviceType(category) {
  if (EASY_FLEXIBLE_CATEGORIES.includes(category)) {
    return 'easy';
  }

  if (SIMPLE_FLEXIBLE_CATEGORIES.includes(category)) {
    return 'simple';
  }

  return null;
}

function buildAdviceSentence(metrics) {
  if (!metrics.adviceCategory) {
    return "Xarajatlaringiz asosan majburiy to'lovlardan iborat. Hozircha kamaytiradigan alohida joy yo'q — yaxshi holat!";
  }

  if (metrics.topCategory.name === 'Kommunal') {
    return "Kommunal — majburiy to'lov, uni kamaytirish qiyin. Lekin svet va suvni tejab ishlatsangiz, keyingi oy hisobingiz biroz pasayishi mumkin.";
  }

  const adviceType = getCategoryAdviceType(metrics.adviceCategory.name);

  if (adviceType === 'easy') {
    const savings = Math.round(metrics.adviceCategory.amount * 0.20);
    return `${metrics.adviceCategory.name} — tejash uchun eng oson joy. 20% kamaytirsangiz, ~${formatMoney(savings)} qo'shimcha jamg'arasiz.`;
  }

  const savings = Math.round(metrics.adviceCategory.amount * 0.10);
  return `${metrics.adviceCategory.name}ni 10% tejasangiz, ~${formatMoney(savings)} qo'shimcha qoladi. Faqat sifatga e'tibor bering, keskin tejamang.`;
}

function buildAdviceText(metrics, adviceSentence) {
  return [
    `📊 Bu oy sof xarajat ${formatPercent(metrics.spentPercent)}%. Qolgan balans: ${formatMoney(metrics.remainingBalance)}.`,
    '',
    `Eng ko'p xarajat: ${metrics.topCategory.name} (${formatMoney(metrics.topCategory.amount)}).`,
    '',
    `💡 ${adviceSentence}`
  ].join('\n');
}

function buildAnalysisPrompt(metrics) {
  const categoryList = formatCategoryBreakdownList(metrics.categoryBreakdown);
  const fixedList = formatCategoryBreakdownList(metrics.fixedBreakdown);
  const flexibleList = formatCategoryBreakdownList(metrics.flexibleBreakdown);
  const adviceTarget = metrics.adviceCategory
    ? `${metrics.adviceCategory.name}: ${metrics.adviceCategory.reductionPercent}% kamaytirsa ~${formatMoney(metrics.adviceCategory.savings)} qoladi`
    : "moslashuvchan xarajat yo'q; aynan shu mazmunda yoz: Moslashuvchan xarajat yo'q, kamaytiradigan alohida joy ko'rinmayapti.";

  return [
    "Sen moliyaviy yordamchisan. Quyidagi ma'lumotlar asosida foydalanuvchiga QISQA va ANIQ tahlil yoz.",
    '',
    "Ma'lumotlar:",
    `- Oylik maosh: ${formatMoney(metrics.salary)}`,
    `- Bugungi kun: oyning ${metrics.dayOfMonth}-kuni, ${metrics.daysRemaining} kun qolgan`,
    `- Jami xarajat: ${formatMoney(metrics.totalSpent)}`,
    `- Qo'shimcha kirim: ${formatMoney(metrics.totalIncome)}`,
    `- Sof xarajat (xarajat - kirim): ${formatMoney(metrics.netSpent)} (${formatPercent(metrics.spentPercent)}%)`,
    `- Qolgan balans: ${formatMoney(metrics.remainingBalance)}`,
    `- Kategoriyalar: ${categoryList}`,
    `- Majburiy xarajatlar (kamaytirib bo'lmaydi): ${fixedList}`,
    `- Moslashuvchan xarajatlar (kamaytirish mumkin): ${flexibleList}`,
    `- Tavsiya uchun yagona moslashuvchan asos: ${adviceTarget}`,
    `- Joriy sarflash sur'ati bo'yicha backend hisob-kitobi: ${metrics.projectionHint}`,
    '',
    'QATTIQ QOIDALAR:',
    '1. Javob MAKSIMAL 450 belgi yoki 4 ta qisqa jumla bo\'lsin. Uzun tushuntirish, umumiy gaplar ("moliyaviy barqarorlik", "moliyaviy intizom" kabi), salomlashish, xayrlashish YOZMA.',
    '2. Faqat MOSLASHUVCHAN xarajatlar orasidan maslahat ber. Majburiy xarajatlarni (Kommunal, Sog\'liq) hech qachon "kamaytiring" deb aytma - agar shular eng katta bo\'lsa, buni aytib, moslashuvchan qismdan boshqa maslahat top. Agar moslashuvchan xarajat umuman yo\'q bo\'lsa, faqat "Moslashuvchan xarajat yo\'q, kamaytiradigan alohida joy ko\'rinmayapti" mazmunida yoz.',
    '3. Agar "Tavsiya uchun yagona moslashuvchan asos" berilgan bo\'lsa, faqat o\'sha kategoriya, foiz va tejash summasidan foydalan; boshqa foiz, kunlik limit, kunlik budjet yoki yangi raqam o\'ylab topma.',
    '4. Real vaziyatni baholab, joriy sarflash sur\'ati asosida oy oxirida taxminan qancha balans (musbat yoki manfiy) qolishini hisoblab ayt - lekin bu son maoshning 2 barobaridan oshib ketmasin (agar formula noto\'g\'ri katta son chiqarsa, buning o\'rniga shunchaki "hozirgi sur\'atda oy oxirigacha yetarli" yoki "tejash kerak" deb sifat jihatidan ayt, aniq son bermang).',
    '5. Agar kamaytirish tavsiya qilsang, 1 qisqa jumlada nima uchun buni ehtiyot bilan qilish kerakligini ayt (masalan sifat yoki qulaylikka ta\'siri).',
    '6. "Kunlik limit", "kunlik budjet", "barobar oshdi" kabi iboralarni yozma. Ohang - do\'stona, lekin professional va to\'g\'ridan-to\'g\'ri. Ortiqcha emoji ishlatma (maksimal 2-3 ta).',
    "7. Javobni albatta tugallangan gap bilan yakunla; yarim so'z yoki yarim jumla qoldirma.",
    '',
    "Faqat tahlil matnini yoz, boshqa hech narsa qo'shma."
  ].join('\n');
}

function buildGeminiAdviceResponse(metrics, rawAdviceText) {
  const adviceText = truncateAdviceText(rawAdviceText, 500, { preferCompleteSentence: true });

  return [
    `📊 Bu oy sof xarajat ${formatPercent(metrics.spentPercent)}%. Qolgan balans: ${formatMoney(metrics.remainingBalance)}.`,
    '',
    adviceText || AI_ANALYSIS_UNAVAILABLE_MESSAGE
  ].join('\n');
}

function generateLocalAdvice(userData) {
  const metrics = buildAdviceMetrics(userData);
  return buildAdviceText(metrics, buildAdviceSentence(metrics));
}

async function categorizeExpense(text) {
  const cleanText = compactInput(text, 200);

  if (!cleanText) {
    throw new Error("Operatsiya matni bo'sh bo'lmasligi kerak.");
  }

  const localFallback = parseExpensesLocally(cleanText);
  const prompt = [
    "Quyidagi matnda bitta yoki bir nechta moliyaviy operatsiya bo'lishi mumkin.",
    "Har bir operatsiyani alohida summa, type, kategoriya va izoh sifatida JSON massiv qilib qaytar.",
    "Ajratuvchilar '+', ',', ';', 'va', yangi qator yoki oddiy bo'shliq bo'lishi mumkin.",
    "Matndan bu xarajat (chiqim) yoki daromad (kirim) ekanini aniqla.",
    '',
    "KIRIM belgilari: 'qarzimni qaytardi', 'pul keldi', 'sovg'a berdi', 'topib oldim', 'qo'shimcha ish haqi', '+' belgisi bilan boshlangan summa, 'kirim', 'daromad' so'zlari.",
    '',
    "Aks holda bu CHIQIM (xarajat) hisoblanadi.",
    '',
    "Agar KIRIM bo'lsa, type='income' va category='Kirim' deb belgila (kirim uchun boshqa kategoriyalar kerak emas, hammasi 'Kirim' deb belgilansin). Agar CHIQIM bo'lsa, type='expense' va mavjud kategoriyalar ro'yxatidan birini tanla.",
    `Chiqim kategoriyalari faqat shu ro'yxatdan bo'lsin: ${CATEGORIES.join(', ')}.`,
    "Kommunal faqat svet, gaz, suv, internet uchun; kvartira ijarasi yoki uy to'lovi Kommunal emas, Uy-joy.",
    "Boshqa kategoriyasini faqat aniq hech qaysi toifaga kirmagan holatda ishlat.",
    "Kategoriyalarni to'g'ri tanlash uchun misollar:",
    "- 'kvartira uchun', 'ijaraga', 'uy to'lovi' -> Uy-joy",
    "- 'svet', 'gaz', 'internet', 'suv' -> Kommunal",
    "- 'telefon sotib oldim', 'noutbuk', 'maishiy texnika' -> Texnika",
    "- 'dadamga', 'onamga', 'ukamga berdim', 'ota-onamga' -> Oilaviy yordam",
    "- 'kredit to'lovi', 'bo'lib to'lash', 'oylik to'lov' -> Bo'lib to'lash",
    "- 'o'qish', 'kurs', 'repetitor', 'kitob' -> Ta'lim",
    "Faqat JSON massiv qaytar, boshqa hech narsa yozma.",
    'JSON formati aniq shunday bolsin: [{"amount":25000,"type":"expense","category":"Oziq-ovqat","note":"nonga"},{"amount":50000,"type":"income","category":"Kirim","note":"qarz qaytdi"}].',
    'Masalan, "20000 non, +50000 qarz qaytdi" uchun [{"amount":20000,"type":"expense","category":"Oziq-ovqat","note":"non"},{"amount":50000,"type":"income","category":"Kirim","note":"qarz qaytdi"}] qaytar.',
    `Matn: "${cleanText.replace(/"/g, '\\"')}"`
  ].join('\n');

  debugAi('categorizeExpense.model', getConfiguredModelName());
  debugAi('categorizeExpense.input', cleanText);

  let rawText = '';

  try {
    const result = await callGeminiWithRetry('categorizeExpense', () => getGeminiModel().generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    }));

    await logApiUsageSafely();
    rawText = result.response.text();
    debugAi('categorizeExpense.rawResponse', rawText);
    debugAi('categorizeExpense.finishReason', result.response.candidates?.[0]?.finishReason);
  } catch (error) {
    debugAi('categorizeExpense.requestError', {
      model: geminiModelName || getConfiguredModelName(),
      message: error.message,
      status: error.status || error.code
    });

    if (error.code !== 'AI_TEMPORARILY_UNAVAILABLE' && localFallback) {
      debugAi('categorizeExpense.localFallback', localFallback);
      return localFallback;
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(extractJson(rawText));
    return normalizeExpenseListPayload(parsed, cleanText);
  } catch (error) {
    if (localFallback) {
      debugAi('categorizeExpense.localFallback', localFallback);
      return localFallback;
    }

    const parseError = new Error('AI_JSON_PARSE_FAILED');
    parseError.cause = error;
    throw parseError;
  }
}

async function categorizeVoiceExpense(fileUrl, mimeType = 'audio/ogg') {
  const audioData = await fetchAsBase64(fileUrl);
  const prompt = [
    "Ovozli xabardagi moliyaviy operatsiyani tinglab, summa, type, kategoriya va izohni JSON formatida ajrat.",
    "Matndan bu xarajat (chiqim) yoki daromad (kirim) ekanini aniqla.",
    "KIRIM belgilari: 'qarzimni qaytardi', 'pul keldi', 'sovg'a berdi', 'topib oldim', 'qo'shimcha ish haqi', 'kirim', 'daromad' so'zlari.",
    "Aks holda bu CHIQIM (xarajat) hisoblanadi.",
    "Agar KIRIM bo'lsa, type='income' va category='Kirim' deb belgila. Agar CHIQIM bo'lsa, type='expense' va mavjud kategoriyalar ro'yxatidan birini tanla.",
    `Chiqim kategoriyasi faqat shu ro'yxatdan bo'lsin: [${CATEGORIES.join(', ')}].`,
    "Kommunal faqat svet, gaz, suv, internet; kvartira ijarasi yoki uy to'lovi -> Uy-joy.",
    "Telefon/noutbuk/maishiy texnika -> Texnika. O'qish/kurs/kitob -> Ta'lim. Ota-onaga yoki qarindoshga pul -> Oilaviy yordam.",
    "Kredit, bo'lib to'lash, oylik muntazam to'lov -> Bo'lib to'lash.",
    "Faqat JSON qaytar, boshqa hech narsa yozma.",
    'JSON formati aniq shunday bolsin: {"amount":25000,"type":"expense","category":"Oziq-ovqat","note":"nonga"}.',
    "Agar kategoriya aniq bo'lmasa, Boshqa tanla. Note qismiga qisqa mazmun yoz."
  ].join('\n');

  let rawText = '';

  try {
    const result = await callGeminiWithRetry('categorizeVoiceExpense', () => getGeminiModel().generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: audioData
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    }));

    await logApiUsageSafely();
    rawText = result.response.text();
    debugAi('categorizeVoiceExpense.rawResponse', rawText);
    debugAi('categorizeVoiceExpense.finishReason', result.response.candidates?.[0]?.finishReason);
  } catch (error) {
    debugAi('categorizeVoiceExpense.requestError', {
      model: geminiModelName || getConfiguredModelName(),
      message: error.message,
      status: error.status || error.code
    });

    throw error;
  }

  try {
    const parsed = JSON.parse(extractJson(rawText));
    return normalizeExpensePayload(parsed, 'voice');
  } catch (error) {
    const parseError = new Error('AI_JSON_PARSE_FAILED');
    parseError.cause = error;
    throw parseError;
  }
}

async function generateAdvice(userData) {
  const metrics = buildAdviceMetrics(userData);
  const prompt = buildAnalysisPrompt(metrics);

  debugAi('generateAdvice.model', getConfiguredModelName());
  debugAi('generateAdvice.metrics', {
    salary: metrics.salary,
    totalSpent: metrics.totalSpent,
    totalIncome: metrics.totalIncome,
    netSpent: metrics.netSpent,
    spentPercent: metrics.spentPercent,
    remainingBalance: metrics.remainingBalance,
    dayOfMonth: metrics.dayOfMonth,
    daysRemaining: metrics.daysRemaining,
    projectedMonthEndBalance: metrics.projectedMonthEndBalance,
    canShowProjectedBalance: metrics.canShowProjectedBalance
  });

  try {
    const result = await callGeminiWithRetry('generateAdvice', () => getGeminiModel().generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 450
      }
    }));

    await logApiUsageSafely();
    const rawText = result.response.text();
    debugAi('generateAdvice.rawResponse', rawText);
    debugAi('generateAdvice.finishReason', result.response.candidates?.[0]?.finishReason);

    return buildGeminiAdviceResponse(metrics, rawText);
  } catch (error) {
    debugAi('generateAdvice.requestError', {
      model: geminiModelName || getConfiguredModelName(),
      message: error.message,
      status: error.status || error.code
    });

    throw createAnalysisUnavailableError(error);
  }
}

function buildPlanGoalPrompt({ planText, salary, totalSpent }) {
  return [
    "Sen moliyaviy maslahatchisan. Foydalanuvchi keyingi oy uchun quyidagi rejani yozdi:",
    '',
    String(planText || '').trim(),
    '',
    "Foydalanuvchining joriy holati (kontekst uchun, taqqoslash uchun):",
    `Keyingi oy kutilayotgan daromad: ${formatMoney(salary)}`,
    `Shu oy haqiqiy sof xarajati (xarajat - kirim): ${formatMoney(totalSpent)}`,
    '',
    'Vazifang:',
    '1. Yozilgan reja xarajatlarini jamla, umumiy summani hisobla.',
    '2. Agar reja jami maoshdan oshib ketsa, buni aniq ayt va qancha oshib ketganini hisobla.',
    '3. Agar rejada "maqsad" (masalan biror narsa sotib olish) aytilgan bo\'lsa, bu narsani hozir sotib olish (naqd yoki bo\'lib to\'lash) maqbul yoki maqbul emasligini hisobla va ayt.',
    "4. Agar bo'lib to'lash summasi berilgan bo'lsa, byudjetga bir martalik umumiy narx emas, oylik to'lov ta'sir qilishini hisobga ol.",
    "5. Agar foydalanuvchi 'oyiga X dan', 'har oy X', 'X dan', 'bo'lib to'lash' desa, buni umumiy narx va oylik to'lov sifatida alohida ajrat. Masalan: 'telefon 3mln oyiga 345000 dan' => umumiy narx 3 000 000 so'm, oyiga to'lov 345 000 so'm; byudjet hisobida 345 000 so'mni qo'sh, 3 000 000 so'mni alohida maqsad narxi sifatida eslat.",
    '',
    "QISQA yoz: maksimal 400 belgi yoki 5 ta qisqa jumla. Raqamlangan ro'yxat ishlatma. Javobni albatta to'liq gap bilan tugat, yarim so'z yoki tugallanmagan jumla qoldirma. Raqamlarga asoslan, umumiy gaplar yozma."
  ].join('\n');
}

async function generatePlanGoalAnalysis(planData) {
  const prompt = buildPlanGoalPrompt(planData);

  debugAi('generatePlanGoalAnalysis.model', getConfiguredModelName());

  try {
    const result = await callGeminiWithRetry('generatePlanGoalAnalysis', () => getGeminiModel().generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 700
      }
    }));

    await logApiUsageSafely();
    const rawText = result.response.text();
    debugAi('generatePlanGoalAnalysis.rawResponse', rawText);
    debugAi('generatePlanGoalAnalysis.finishReason', result.response.candidates?.[0]?.finishReason);

    return truncateAdviceText(rawText, 500, { preferCompleteSentence: true });
  } catch (error) {
    debugAi('generatePlanGoalAnalysis.requestError', {
      model: geminiModelName || getConfiguredModelName(),
      message: error.message,
      status: error.status || error.code
    });

    throw createPlanGoalUnavailableError(error);
  }
}

module.exports = {
  CATEGORIES,
  INCOME_CATEGORY,
  FIXED_CATEGORIES,
  SIMPLE_FLEXIBLE_CATEGORIES,
  EASY_FLEXIBLE_CATEGORIES,
  FLEXIBLE_CATEGORIES,
  AI_BUSY_MESSAGE,
  AI_ANALYSIS_UNAVAILABLE_MESSAGE,
  PLAN_GOAL_UNAVAILABLE_MESSAGE,
  DEFAULT_GEMINI_MODEL,
  buildAnalysisPrompt,
  buildAdviceMetrics,
  buildGeminiAdviceResponse,
  buildPlanGoalPrompt,
  categorizeExpense,
  categorizeTransaction: categorizeExpense,
  categorizeVoiceExpense,
  generateLocalAdvice,
  generatePlanGoalAnalysis,
  parseExpenseLocally,
  parseExpensesLocally,
  generateAdvice
};
