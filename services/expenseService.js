const { supabase } = require('../config/db');
const { CATEGORIES } = require('./ai');
const { getMonthKey } = require('./userService');

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const utcFromParts = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return utcFromParts - date.getTime();
}

function zonedDateToUtc(year, month, day, timeZone) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function getTodayBounds(date = new Date()) {
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const parts = getTimeZoneParts(date, timeZone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const start = zonedDateToUtc(year, month, day, timeZone);
  const endGuess = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  const endParts = getTimeZoneParts(endGuess, timeZone);
  const end = zonedDateToUtc(
    Number(endParts.year),
    Number(endParts.month),
    Number(endParts.day),
    timeZone
  );

  return { start, end };
}

function sanitizeNote(note) {
  // Bazaga yoziladigan izohlar qisqa va bir qatorli saqlanadi.
  return String(note || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function validateExpense({ amount, category, note }) {
  const normalizedAmount = Number(amount);

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Xarajat summasi musbat raqam bo'lishi kerak.");
  }

  const normalizedCategory = CATEGORIES.includes(category) ? category : 'Boshqa';
  const normalizedNote = sanitizeNote(note);

  if (normalizedNote.length > 200) {
    throw new Error("Izoh 200 belgidan oshmasligi kerak.");
  }

  return {
    amount: normalizedAmount,
    category: normalizedCategory,
    note: normalizedNote
  };
}

function normalizeInputType(inputType) {
  return inputType === 'voice' ? 'voice' : 'text';
}

async function createExpense(userId, expense, month = getMonthKey(), inputType = 'text') {
  const payload = validateExpense(expense);
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      user_id: userId,
      amount: payload.amount,
      category: payload.category,
      note: payload.note,
      month,
      input_type: normalizeInputType(inputType)
    })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getTodayExpenseCount(userId, date = new Date(), inputType = 'text') {
  const { start, end } = getTodayBounds(date);
  const { count, error } = await supabase
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('input_type', normalizeInputType(inputType))
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  if (error) {
    throw error;
  }

  return Number(count || 0);
}

async function getTodayVoiceExpenseCount(userId, date = new Date()) {
  return getTodayExpenseCount(userId, date, 'voice');
}

async function getTodayExpenseCountsByUserIds(userIds, date = new Date(), inputType = 'text') {
  const ids = [...new Set((userIds || []).filter(Boolean))];

  if (!ids.length) {
    return {};
  }

  const { start, end } = getTodayBounds(date);
  const { data, error } = await supabase
    .from('expenses')
    .select('user_id')
    .in('user_id', ids)
    .eq('input_type', normalizeInputType(inputType))
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  if (error) {
    throw error;
  }

  return (data || []).reduce((acc, expense) => {
    acc[expense.user_id] = Number(acc[expense.user_id] || 0) + 1;
    return acc;
  }, {});
}

async function getTodayVoiceExpenseCountsByUserIds(userIds, date = new Date()) {
  return getTodayExpenseCountsByUserIds(userIds, date, 'voice');
}

async function getMonthlyExpenses(userId, month = getMonthKey()) {
  const { data, error } = await supabase
    .from('expenses')
    .select('id, amount, category, note, month, input_type, created_at')
    .eq('user_id', userId)
    .eq('month', month)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getMonthlySummary(userId, month = getMonthKey()) {
  const expenses = await getMonthlyExpenses(userId, month);
  // Hisobotda barcha kategoriyalar bir xil tartibda ko'rinishi uchun oldindan 0 bilan ochiladi.
  const byCategory = CATEGORIES.reduce((acc, category) => {
    acc[category] = 0;
    return acc;
  }, {});

  const totalSpent = expenses.reduce((sum, expense) => {
    const amount = Number(expense.amount || 0);
    byCategory[expense.category] = Number(byCategory[expense.category] || 0) + amount;
    return sum + amount;
  }, 0);

  return {
    month,
    totalSpent,
    byCategory,
    expenses
  };
}

async function getMonthlyHistory(userId, limit = 6) {
  const { data, error } = await supabase
    .from('monthly_history')
    .select('month, salary, total_spent, savings, created_at')
    .eq('user_id', userId)
    .order('month', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getAdviceData(user) {
  const month = user.current_month || getMonthKey();
  const currentSummary = await getMonthlySummary(user.id, month);
  const previousMonths = await getMonthlyHistory(user.id, 6);
  const salary = Number(user.current_salary || 0);

  return {
    user: {
      id: user.id,
      name: user.full_name,
      currentMonth: month,
      currentSalary: salary
    },
    currentMonth: {
      month,
      salary,
      totalSpent: currentSummary.totalSpent,
      balance: salary - currentSummary.totalSpent,
      byCategory: currentSummary.byCategory,
      expensesCount: currentSummary.expenses.length
    },
    previousMonths
  };
}

module.exports = {
  createExpense,
  getAdviceData,
  getMonthlyExpenses,
  getMonthlyHistory,
  getMonthlySummary,
  getTodayBounds,
  getTodayExpenseCount,
  getTodayExpenseCountsByUserIds,
  getTodayVoiceExpenseCount,
  getTodayVoiceExpenseCountsByUserIds,
  sanitizeNote,
  validateExpense
};
