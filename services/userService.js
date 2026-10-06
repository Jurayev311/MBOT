const { buildSet, query, queryOne } = require('../config/db');
const { parseAmount } = require('../utils/parseAmount');

function getMonthKey(date = new Date()) {
  // Oy kaliti server timezone'iga bog'lanib qolmasligi uchun sozlanadigan timezone ishlatiladi.
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;

  return `${year}-${month}`;
}

function getDateKey(date = new Date()) {
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function normalizeDateKey(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  }

  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function normalizeUsageType(inputType) {
  return inputType === 'voice' ? 'voice' : 'text';
}

function getDailyUsageCount(user, inputType = 'text', date = new Date()) {
  const usageType = normalizeUsageType(inputType);
  const today = getDateKey(date);
  const usageDate = normalizeDateKey(
    usageType === 'voice' ? user?.daily_voice_usage_date : user?.daily_usage_date
  );
  const usageCount = Number(
    usageType === 'voice' ? user?.daily_voice_usage_count : user?.daily_usage_count
  );

  if (usageDate !== today) {
    return 0;
  }

  return Number.isInteger(usageCount) && usageCount > 0 ? usageCount : 0;
}

function normalizeTelegramId(telegramId) {
  const normalized = String(telegramId || '').trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error("Telegram ID noto'g'ri.");
  }

  return normalized;
}

function buildFullName(from = {}) {
  const fullName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fullName || from.username || null;
}

function getPremiumExpiryDate(date = new Date()) {
  const expiresAt = new Date(date);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);
  return expiresAt;
}

function isPremiumExpired(user, date = new Date()) {
  if (!user?.is_premium || !user?.premium_expires_at) {
    return false;
  }

  const expiresAt = new Date(user.premium_expires_at);
  return Number.isFinite(expiresAt.getTime()) && expiresAt <= date;
}

async function getUserByTelegramId(telegramId) {
  const normalizedId = normalizeTelegramId(telegramId);
  return queryOne('select * from users where telegram_id = $1', [normalizedId]);
}

async function ensureUser(from) {
  const telegramId = normalizeTelegramId(from.id);
  const existingUser = await getUserByTelegramId(telegramId);

  if (existingUser) {
    return existingUser;
  }

  try {
    return await queryOne(
      'insert into users (telegram_id, current_month) values ($1, $2) returning *',
      [telegramId, getMonthKey()]
    );
  } catch (error) {
    if (error.code === '23505') {
      return getUserByTelegramId(telegramId);
    }

    throw error;
  }
}

function assertPositiveAmount(amount) {
  const normalized = parseAmount(amount);

  if (!normalized) {
    throw new Error("Summa musbat raqam bo'lishi kerak.");
  }

  return normalized;
}

async function updateUserById(userId, fields) {
  const { clause, values } = buildSet(fields, 2);
  const data = await queryOne(`update users set ${clause} where id = $1 returning *`, [userId, ...values]);

  if (!data) {
    throw new Error('USER_NOT_FOUND');
  }

  return data;
}

async function updateUserByTelegramId(telegramId, fields) {
  const { clause, values } = buildSet(fields, 2);
  return queryOne(`update users set ${clause} where telegram_id = $1 returning *`, [telegramId, ...values]);
}

async function updateSalary(userId, amount, month = getMonthKey()) {
  return updateUserById(userId, {
    current_salary: assertPositiveAmount(amount),
    current_month: month
  });
}

async function updateCurrentMonth(userId, month = getMonthKey()) {
  return updateUserById(userId, { current_month: month });
}

async function updateFullName(userId, fullName) {
  const cleanName = String(fullName || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  if (!cleanName) {
    throw new Error("Ism bo'sh bo'lmasligi kerak.");
  }

  return updateUserById(userId, { full_name: cleanName });
}

async function updatePremiumByTelegramId(telegramId, enabled) {
  const normalizedId = normalizeTelegramId(telegramId);
  const data = await updateUserByTelegramId(normalizedId, {
    is_premium: Boolean(enabled),
    daily_limit: enabled ? 50 : 15,
    daily_voice_limit: enabled ? 10 : 2,
    premium_expires_at: enabled ? getPremiumExpiryDate().toISOString() : null,
    awaiting_payment: false
  });

  if (!data) {
    const notFoundError = new Error('USER_NOT_FOUND');
    notFoundError.code = 'USER_NOT_FOUND';
    throw notFoundError;
  }

  return data;
}

async function expirePremium(userId) {
  return updateUserById(userId, {
    is_premium: false,
    daily_limit: 15,
    daily_voice_limit: 2,
    premium_expires_at: null
  });
}

async function incrementDailyUsage(user, amount = 1, inputType = 'text', date = new Date()) {
  const usageType = normalizeUsageType(inputType);
  const incrementBy = Number(amount || 0);

  if (!user?.id || !Number.isInteger(incrementBy) || incrementBy <= 0) {
    return user;
  }

  const today = getDateKey(date);
  const nextCount = getDailyUsageCount(user, usageType, date) + incrementBy;
  const payload = usageType === 'voice'
    ? {
      daily_voice_usage_count: nextCount,
      daily_voice_usage_date: today
    }
    : {
      daily_usage_count: nextCount,
      daily_usage_date: today
    };

  return updateUserById(user.id, payload);
}

async function updateAwaitingPayment(userId, awaitingPayment) {
  return updateUserById(userId, { awaiting_payment: Boolean(awaitingPayment) });
}

async function updateAwaitingPaymentByTelegramId(telegramId, awaitingPayment) {
  const normalizedId = normalizeTelegramId(telegramId);
  return updateUserByTelegramId(normalizedId, { awaiting_payment: Boolean(awaitingPayment) });
}

async function resetUserData(userId) {
  // Foydalanuvchi qatori qoladi, moliyaviy ma'lumotlar esa tozalanadi.
  await query('delete from budget_plans where user_id = $1', [userId]);
  await query('delete from expenses where user_id = $1', [userId]);
  await query('delete from monthly_history where user_id = $1', [userId]);

  return updateUserById(userId, {
    current_salary: 0,
    current_month: getMonthKey()
  });
}

async function deleteUserCompletelyByTelegramId(telegramId) {
  const normalizedId = normalizeTelegramId(telegramId);
  const user = await getUserByTelegramId(normalizedId);

  if (!user) {
    const notFoundError = new Error('USER_NOT_FOUND');
    notFoundError.code = 'USER_NOT_FOUND';
    throw notFoundError;
  }

  // Bog'liq jadvallar "on delete cascade" orqali tozalanadi.
  await query('delete from users where id = $1', [user.id]);

  return user;
}

async function getAllUsers() {
  return query('select * from users order by created_at desc');
}

async function saveMonthlyHistory({ userId, month, salary, totalSpent, savings }) {
  return queryOne(
    `insert into monthly_history (user_id, month, salary, total_spent, savings)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, month) do update set
       salary = excluded.salary,
       total_spent = excluded.total_spent,
       savings = excluded.savings
     returning *`,
    [userId, month, Number(salary || 0), Number(totalSpent || 0), Number(savings || 0)]
  );
}

module.exports = {
  buildFullName,
  deleteUserCompletelyByTelegramId,
  ensureUser,
  expirePremium,
  getAllUsers,
  getDailyUsageCount,
  getDateKey,
  getMonthKey,
  getPremiumExpiryDate,
  getUserByTelegramId,
  incrementDailyUsage,
  isPremiumExpired,
  normalizeTelegramId,
  resetUserData,
  saveMonthlyHistory,
  updateAwaitingPayment,
  updateAwaitingPaymentByTelegramId,
  updateCurrentMonth,
  updateFullName,
  updatePremiumByTelegramId,
  updateSalary
};
