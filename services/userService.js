const { supabase } = require('../config/db');

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
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', normalizedId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function ensureUser(from) {
  const telegramId = normalizeTelegramId(from.id);
  const existingUser = await getUserByTelegramId(telegramId);

  if (existingUser) {
    return existingUser;
  }

  const { data, error } = await supabase
    .from('users')
    .insert({
      telegram_id: telegramId,
      current_month: getMonthKey()
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return getUserByTelegramId(telegramId);
    }

    throw error;
  }

  return data;
}

function assertPositiveAmount(amount) {
  const normalized = Number(amount);

  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Summa musbat raqam bo'lishi kerak.");
  }

  return normalized;
}

async function updateSalary(userId, amount, month = getMonthKey()) {
  const { data, error } = await supabase
    .from('users')
    .update({
      current_salary: assertPositiveAmount(amount),
      current_month: month
    })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateCurrentMonth(userId, month = getMonthKey()) {
  const { data, error } = await supabase
    .from('users')
    .update({ current_month: month })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateFullName(userId, fullName) {
  const cleanName = String(fullName || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  if (!cleanName) {
    throw new Error("Ism bo'sh bo'lmasligi kerak.");
  }

  const { data, error } = await supabase
    .from('users')
    .update({ full_name: cleanName })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updatePremiumByTelegramId(telegramId, enabled) {
  const normalizedId = normalizeTelegramId(telegramId);
  const { data, error } = await supabase
    .from('users')
    .update({
      is_premium: Boolean(enabled),
      daily_limit: enabled ? 50 : 15,
      daily_voice_limit: enabled ? 10 : 2,
      premium_expires_at: enabled ? getPremiumExpiryDate().toISOString() : null,
      awaiting_payment: false
    })
    .eq('telegram_id', normalizedId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFoundError = new Error('USER_NOT_FOUND');
    notFoundError.code = 'USER_NOT_FOUND';
    throw notFoundError;
  }

  return data;
}

async function expirePremium(userId) {
  const { data, error } = await supabase
    .from('users')
    .update({
      is_premium: false,
      daily_limit: 15,
      daily_voice_limit: 2,
      premium_expires_at: null
    })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateAwaitingPayment(userId, awaitingPayment) {
  const { data, error } = await supabase
    .from('users')
    .update({ awaiting_payment: Boolean(awaitingPayment) })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateAwaitingPaymentByTelegramId(telegramId, awaitingPayment) {
  const normalizedId = normalizeTelegramId(telegramId);
  const { data, error } = await supabase
    .from('users')
    .update({ awaiting_payment: Boolean(awaitingPayment) })
    .eq('telegram_id', normalizedId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function resetUserData(userId) {
  // Foydalanuvchi qatori qoladi, moliyaviy ma'lumotlar esa tozalanadi.
  const expensesDelete = await supabase
    .from('expenses')
    .delete()
    .eq('user_id', userId);

  if (expensesDelete.error) {
    throw expensesDelete.error;
  }

  const historyDelete = await supabase
    .from('monthly_history')
    .delete()
    .eq('user_id', userId);

  if (historyDelete.error) {
    throw historyDelete.error;
  }

  const { data, error } = await supabase
    .from('users')
    .update({
      current_salary: 0,
      current_month: getMonthKey()
    })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*');

  if (error) {
    throw error;
  }

  return data || [];
}

async function saveMonthlyHistory({ userId, month, salary, totalSpent, savings }) {
  const { data, error } = await supabase
    .from('monthly_history')
    .upsert({
      user_id: userId,
      month,
      salary: Number(salary || 0),
      total_spent: Number(totalSpent || 0),
      savings: Number(savings || 0)
    }, { onConflict: 'user_id,month' })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = {
  buildFullName,
  ensureUser,
  expirePremium,
  getAllUsers,
  getMonthKey,
  getPremiumExpiryDate,
  getUserByTelegramId,
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
