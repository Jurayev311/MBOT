require('dotenv').config({ quiet: true });

const { GoogleGenerativeAI } = require('@google/generative-ai');
const apiUsageService = require('./apiUsageService');

const CATEGORIES = [
  'Oziq-ovqat',
  'Transport',
  'Kommunal',
  "Ko'ngilochar",
  'Kiyim-kechak',
  "Sog'liq",
  'Boshqa'
];

const FIXED_CATEGORIES = ['Kommunal', "Sog'liq"];
const SIMPLE_FLEXIBLE_CATEGORIES = ['Oziq-ovqat', 'Kiyim-kechak', 'Boshqa'];
const EASY_FLEXIBLE_CATEGORIES = ['Transport', "Ko'ngilochar"];
const FLEXIBLE_CATEGORIES = [...SIMPLE_FLEXIBLE_CATEGORIES, ...EASY_FLEXIBLE_CATEGORIES];
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const AI_BUSY_MESSAGE = "Hozir tizim biroz band, 1 daqiqadan keyin qayta urinib ko'ring.";
const GEMINI_MIN_INTERVAL_MS = 300;
const GEMINI_RETRY_DELAY_MS = 2000;
const AMOUNT_PATTERN = /\b\d{1,3}(?:[ .]\d{3})+(?:[,.]\d+)?\b|\b\d+(?:[,.]\d+)?\b/;
const CATEGORY_KEYWORDS = [
  {
    category: 'Transport',
    keywords: ['taxi', 'taksi', 'yandex', 'metro', 'avtobus', 'transport', 'benzin', 'yoqilgi', 'yonilgi', "yo'l", 'yol']
  },
  {
    category: 'Oziq-ovqat',
    keywords: ['non', 'nonga', 'ovqat', 'osh', 'somsa', 'lavash', 'market', 'supermarket', 'meva', 'sabzavot', 'suv', 'choy', 'qahva']
  },
  {
    category: 'Kommunal',
    keywords: ['kommunal', 'svet', 'elektr', 'gaz', 'ijara', 'internet', 'telefon', "to'lov", 'tolov']
  },
  {
    category: "Ko'ngilochar",
    keywords: ['kino', 'konsert', "o'yin", 'oyin', 'netflix', 'spotify', 'dam olish', 'kafe']
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

function normalizeCategory(value) {
  const requested = String(value || '').trim().toLowerCase();
  return CATEGORIES.find((category) => category.toLowerCase() === requested) || 'Boshqa';
}

function normalizeExpensePayload(payload, fallbackNote) {
  const amount = toPositiveNumber(payload.amount);

  if (!amount) {
    throw new Error("Gemini summa qiymatini to'g'ri ajratmadi.");
  }

  return {
    amount,
    category: normalizeCategory(payload.category),
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

  if (/(^|\s)(o'qish|oqish|kontrakt|universitet|maktab|kurs)(\s|$)/i.test(lowerText)) {
    return 'Boshqa';
  }

  const matched = CATEGORY_KEYWORDS.find(({ keywords }) => (
    keywords.some((keyword) => lowerText.includes(keyword))
  ));

  return matched?.category || 'Boshqa';
}

function parseExpenseLocally(text) {
  const cleanText = compactInput(text, 200);
  const amountMatch = cleanText.match(AMOUNT_PATTERN);

  if (!amountMatch) {
    return null;
  }

  const amount = toPositiveNumber(amountMatch[0]);

  if (!amount) {
    return null;
  }

  const note = compactInput(cleanText.replace(amountMatch[0], '').trim() || cleanText, 200);

  return {
    amount,
    category: inferCategory(cleanText),
    note
  };
}

function parseExpensesLocally(text) {
  const cleanText = compactInput(text, 200);
  const amountMatches = [...cleanText.matchAll(new RegExp(AMOUNT_PATTERN.source, 'g'))];

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
    const segmentEnd = nextMatch ? nextMatch.index : cleanText.length;
    const noteFromSegment = compactInput(
      cleanText
        .slice(match.index + match.raw.length, segmentEnd)
        .replace(/^[\s+;,.-]*(?:va\s+)?/i, '')
        .replace(/[\s+;,.-]+$/g, ''),
      80
    );
    const note = canUseTailPartsForNotes
      ? tailParts[index]
      : noteFromSegment || tailAfterLastAmount || cleanText;

    return {
      amount: match.amount,
      category: inferCategory(note),
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
  const byCategory = current.byCategory || {};
  const topCategory = getTopCategory(byCategory);
  const adviceCategory = getTopFlexibleCategory(byCategory);
  const spentPercent = salary > 0 ? (totalSpent / salary) * 100 : 0;
  const remainingBalance = salary - totalSpent;

  return {
    month: current.month,
    salary,
    totalSpent,
    spentPercent: Math.round(spentPercent),
    remainingBalance: Math.round(remainingBalance),
    topCategory: {
      name: topCategory.name,
      amount: Math.round(topCategory.amount)
    },
    adviceCategory: adviceCategory.amount > 0
      ? {
        name: adviceCategory.name,
        amount: Math.round(adviceCategory.amount)
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
    `📊 Bu oy ${formatPercent(metrics.spentPercent)}% sarflandi. Qolgan balans: ${formatMoney(metrics.remainingBalance)}.`,
    '',
    `Eng ko'p xarajat: ${metrics.topCategory.name} (${formatMoney(metrics.topCategory.amount)}).`,
    '',
    `💡 ${adviceSentence}`
  ].join('\n');
}

function generateLocalAdvice(userData) {
  const metrics = buildAdviceMetrics(userData);
  return buildAdviceText(metrics, buildAdviceSentence(metrics));
}

async function categorizeExpense(text) {
  const cleanText = compactInput(text, 200);

  if (!cleanText) {
    throw new Error("Xarajat matni bo'sh bo'lmasligi kerak.");
  }

  const localFallback = parseExpensesLocally(cleanText);
  const prompt = [
    "Quyidagi matnda bitta yoki bir nechta xarajat bo'lishi mumkin.",
    "Har bir xarajatni alohida summa, kategoriya va izoh sifatida JSON massiv qilib qaytar.",
    "Ajratuvchilar '+', ',', ';', 'va', yangi qator yoki oddiy bo'shliq bo'lishi mumkin.",
    "Kategoriyalar faqat shu ro'yxatdan bo'lsin: Oziq-ovqat, Transport, Kommunal, Ko'ngilochar, Kiyim-kechak, Sog'liq, Boshqa.",
    "Faqat JSON massiv qaytar, boshqa hech narsa yozma.",
    'JSON formati aniq shunday bolsin: [{"amount":25000,"category":"Oziq-ovqat","note":"nonga"},{"amount":15000,"category":"Transport","note":"taxi"}].',
    'Masalan, "532000+586000 o\'qish va telefon to\'lovi" uchun taxminan [{"amount":532000,"category":"Boshqa","note":"o\'qish to\'lovi"},{"amount":586000,"category":"Kommunal","note":"telefon to\'lovi"}] qaytar.',
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
    "Ovozli xabardagi xarajatni tinglab, summa va kategoriyani JSON formatida ajrat.",
    "Kategoriya faqat shu ro'yxatdan bo'lsin: [Oziq-ovqat, Transport, Kommunal, Ko'ngilochar, Kiyim-kechak, Sog'liq, Boshqa].",
    "Faqat JSON qaytar, boshqa hech narsa yozma.",
    'JSON formati aniq shunday bolsin: {"amount":25000,"category":"Oziq-ovqat","note":"nonga"}.',
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
  return buildAdviceText(metrics, buildAdviceSentence(metrics));
}

module.exports = {
  CATEGORIES,
  FIXED_CATEGORIES,
  SIMPLE_FLEXIBLE_CATEGORIES,
  EASY_FLEXIBLE_CATEGORIES,
  FLEXIBLE_CATEGORIES,
  AI_BUSY_MESSAGE,
  DEFAULT_GEMINI_MODEL,
  buildAdviceMetrics,
  categorizeExpense,
  categorizeVoiceExpense,
  generateLocalAdvice,
  parseExpenseLocally,
  parseExpensesLocally,
  generateAdvice
};
