const { supabase } = require('../config/db');
const budgetPlanService = require('./budgetPlanService');
const { CATEGORIES } = require('./ai');
const { getMonthKey } = require('./userService');
const { parseAmount } = require('../utils/parseAmount');

const EXPENSE_SELECT_COLUMNS = 'id, user_id, amount, category, type, note, month, input_type, created_at';
const INCOME_CATEGORY = 'Kirim';

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

function getDayBounds(date = new Date()) {
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

function normalizeTransactionType(type, category) {
  const normalizedType = String(type || '').trim().toLowerCase();
  const normalizedCategory = String(category || '').trim().toLowerCase();

  if (normalizedType === 'income' || normalizedType === 'kirim' || normalizedCategory === 'kirim') {
    return 'income';
  }

  return 'expense';
}

function validateExpense({ amount, category, note, type }) {
  const normalizedAmount = parseAmount(amount);

  if (!normalizedAmount) {
    throw new Error("Operatsiya summasi musbat raqam bo'lishi kerak.");
  }

  const normalizedType = normalizeTransactionType(type, category);
  const normalizedCategory = normalizedType === 'income'
    ? INCOME_CATEGORY
    : CATEGORIES.includes(category) ? category : 'Boshqa';
  const normalizedNote = sanitizeNote(note);

  if (normalizedNote.length > 200) {
    throw new Error("Izoh 200 belgidan oshmasligi kerak.");
  }

  return {
    amount: normalizedAmount,
    category: normalizedCategory,
    type: normalizedType,
    note: normalizedNote
  };
}

function assertPositiveAmount(amount) {
  const normalizedAmount = parseAmount(amount);

  if (!normalizedAmount) {
    throw new Error("Operatsiya summasi musbat raqam bo'lishi kerak.");
  }

  return normalizedAmount;
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
      type: payload.type,
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

async function getMonthlyExpenses(userId, month = getMonthKey()) {
  const { data, error } = await supabase
    .from('expenses')
    .select(EXPENSE_SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('month', month)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getExpenseByIdForUser(userId, expenseId) {
  const { data, error } = await supabase
    .from('expenses')
    .select(EXPENSE_SELECT_COLUMNS)
    .eq('id', expenseId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getDailyTransactionCount(userId, date = new Date()) {
  const { start, end } = getDayBounds(date);
  const { count, error } = await supabase
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  if (error) {
    throw error;
  }

  return Number(count || 0);
}

async function updateExpenseAmount(userId, expenseId, amount) {
  const { data, error } = await supabase
    .from('expenses')
    .update({ amount: assertPositiveAmount(amount) })
    .eq('id', expenseId)
    .eq('user_id', userId)
    .select(EXPENSE_SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFoundError = new Error('EXPENSE_NOT_FOUND');
    notFoundError.code = 'EXPENSE_NOT_FOUND';
    throw notFoundError;
  }

  return data;
}

async function deleteExpenseByIdForUser(userId, expenseId) {
  const expense = await getExpenseByIdForUser(userId, expenseId);

  if (!expense) {
    const notFoundError = new Error('EXPENSE_NOT_FOUND');
    notFoundError.code = 'EXPENSE_NOT_FOUND';
    throw notFoundError;
  }

  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', expenseId)
    .eq('user_id', userId);

  if (error) {
    throw error;
  }

  return expense;
}

async function getMonthlySummary(userId, month = getMonthKey()) {
  const expenses = await getMonthlyExpenses(userId, month);
  // Hisobotda barcha kategoriyalar bir xil tartibda ko'rinishi uchun oldindan 0 bilan ochiladi.
  const byCategory = CATEGORIES.reduce((acc, category) => {
    acc[category] = 0;
    return acc;
  }, {});

  let totalIncome = 0;
  const totalSpent = expenses.reduce((sum, expense) => {
    const amount = Number(expense.amount || 0);

    if (expense.type === 'income') {
      totalIncome += amount;
      return sum;
    }

    byCategory[expense.category] = Number(byCategory[expense.category] || 0) + amount;
    return sum + amount;
  }, 0);
  const netSpent = totalSpent - totalIncome;

  return {
    month,
    totalSpent,
    totalIncome,
    netSpent,
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
  const [currentSummary, previousMonths, activeBudgetPlan] = await Promise.all([
    getMonthlySummary(user.id, month),
    getMonthlyHistory(user.id, 6),
    budgetPlanService.getActiveBudgetPlan(user.id, new Date())
  ]);
  const budgetPlanProgress = activeBudgetPlan
    ? await budgetPlanService.getBudgetPlanProgress(user.id, activeBudgetPlan)
    : null;
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
      totalIncome: currentSummary.totalIncome,
      netSpent: currentSummary.netSpent,
      balance: salary - currentSummary.netSpent,
      byCategory: currentSummary.byCategory,
      expensesCount: currentSummary.expenses.length,
      budgetPlan: budgetPlanProgress
        ? {
          startDate: budgetPlanProgress.plan.start_date,
          endDate: budgetPlanProgress.plan.end_date,
          totalPlanned: budgetPlanProgress.totalPlanned,
          totalSpent: budgetPlanProgress.totalSpent,
          items: budgetPlanProgress.items.map((item) => ({
            category: item.category,
            plannedAmount: item.plannedAmount,
            spent: item.spent,
            overAmount: item.overAmount
          }))
        }
        : null
    },
    previousMonths
  };
}

module.exports = {
  createExpense,
  deleteExpenseByIdForUser,
  getAdviceData,
  getDailyTransactionCount,
  getDayBounds,
  getExpenseByIdForUser,
  getMonthlyExpenses,
  getMonthlyHistory,
  getMonthlySummary,
  sanitizeNote,
  updateExpenseAmount,
  validateExpense
};
