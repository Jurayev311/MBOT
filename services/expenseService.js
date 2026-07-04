const { supabase } = require('../config/db');
const { CATEGORIES } = require('./ai');
const { getMonthKey } = require('./userService');

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
  sanitizeNote,
  validateExpense
};
