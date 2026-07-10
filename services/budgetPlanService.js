const { supabase } = require('../config/db');
const { CATEGORIES } = require('./ai');
const { parseAmount } = require('../utils/parseAmount');

const PLAN_SELECT_COLUMNS = 'id, user_id, start_date, end_date, is_active, created_at';
const ITEM_SELECT_COLUMNS = 'id, budget_plan_id, category, planned_amount';
const MONTH_NAMES = [
  ['yanvar'],
  ['fevral'],
  ['mart'],
  ['aprel'],
  ['may'],
  ['iyun'],
  ['iyul'],
  ['avgust'],
  ['sentabr', 'sentyabr'],
  ['oktabr', 'oktyabr'],
  ['noyabr'],
  ['dekabr']
];

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

function getDateKey(date = new Date()) {
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const parts = getTimeZoneParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function toDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function getDateRangeBounds(startDateKey, endDateKey) {
  const timeZone = process.env.BOT_TIMEZONE || 'Asia/Tashkent';
  const startMatch = String(startDateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const endMatch = String(endDateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!startMatch || !endMatch) {
    throw new Error("Reja sanasi noto'g'ri.");
  }

  const start = zonedDateToUtc(Number(startMatch[1]), Number(startMatch[2]), Number(startMatch[3]), timeZone);
  const end = zonedDateToUtc(Number(endMatch[1]), Number(endMatch[2]), Number(endMatch[3]) + 1, timeZone);

  return { start, end };
}

function normalizeMonthToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/ʻ/g, "'")
    .replace(/[^a-z']/g, '');
}

function getMonthNumber(token) {
  const normalized = normalizeMonthToken(token);
  const monthIndex = MONTH_NAMES.findIndex((aliases) => (
    aliases.some((alias) => normalized.startsWith(alias))
  ));

  return monthIndex === -1 ? null : monthIndex + 1;
}

function buildDateFromMatch(match, fallbackYear) {
  const day = Number(match[1]);
  const month = getMonthNumber(match[2]);
  const year = match[3] ? Number(match[3]) : fallbackYear;

  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return {
    date,
    hasExplicitYear: Boolean(match[3])
  };
}

function parseBudgetDateRange(text, referenceDate = new Date()) {
  const cleanText = String(text || '').trim();
  const referenceYear = Number(getDateKey(referenceDate).slice(0, 4));
  const matches = [...cleanText.matchAll(/(\d{1,2})\s*[- ]?\s*([A-Za-z'ʻ’`]+)(?:\s+(\d{4}))?/g)];

  if (matches.length < 2) {
    return null;
  }

  const start = buildDateFromMatch(matches[0], referenceYear);
  const end = buildDateFromMatch(matches[1], referenceYear);

  if (!start || !end) {
    return null;
  }

  if (end.date < start.date && !end.hasExplicitYear) {
    end.date.setUTCFullYear(end.date.getUTCFullYear() + 1);
  }

  const today = parseDateKey(getDateKey(referenceDate));

  if (today && end.date < today && !start.hasExplicitYear && !end.hasExplicitYear) {
    start.date.setUTCFullYear(start.date.getUTCFullYear() + 1);
    end.date.setUTCFullYear(end.date.getUTCFullYear() + 1);
  }

  if (end.date < start.date) {
    return null;
  }

  return {
    startDate: toDateKey(start.date),
    endDate: toDateKey(end.date)
  };
}

function formatDate(value) {
  const date = parseDateKey(value);

  if (!date) {
    return String(value || '');
  }

  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function normalizeCategory(category) {
  return CATEGORIES.includes(category) && category !== 'Kirim' ? category : 'Boshqa';
}

function normalizePlanItems(items = []) {
  // Har bir item alohida qoladi - kategoriya bo'yicha aggregation qilmamiz
  // Sababi: Budget plan'dagi har bir band alohida item bo'lishi kerak
  
  return items
    .map((item) => {
      const amount = parseAmount(item?.planned_amount ?? item?.amount ?? 0);
      
      // Tuhi yoki 0 summa bo'lsa, skip
      if (!amount) {
        return null;
      }
      
      // Income bo'lsa, skip
      if (item?.type === 'income' || String(item?.category || '').trim() === 'Kirim') {
        return null;
      }
      
      const category = normalizeCategory(item?.category);
      
      return {
        category,
        plannedAmount: amount
      };
    })
    .filter((item) => item !== null);
}

async function getBudgetPlanItems(planId, userId) {
  const { data, error } = await supabase
    .from('budget_plan_items')
    .select(`${ITEM_SELECT_COLUMNS}, budget_plans!inner(user_id)`)
    .eq('budget_plan_id', planId)
    .eq('budget_plans.user_id', userId)
    .order('category', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function attachItems(plan) {
  if (!plan) {
    return null;
  }

  return {
    ...plan,
    items: await getBudgetPlanItems(plan.id, plan.user_id)
  };
}

async function getActiveBudgetPlan(userId, date = new Date()) {
  const today = getDateKey(date);
  const { data, error } = await supabase
    .from('budget_plans')
    .select(PLAN_SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('is_active', true)
    .lte('start_date', today)
    .gte('end_date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return attachItems(data);
}

async function getAnyActiveBudgetPlan(userId) {
  const { data, error } = await supabase
    .from('budget_plans')
    .select(PLAN_SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return attachItems(data);
}

async function closeActiveBudgetPlans(userId) {
  const { error } = await supabase
    .from('budget_plans')
    .update({ is_active: false })
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) {
    throw error;
  }
}

async function createBudgetPlan(userId, { startDate, endDate, items }) {
  const normalizedItems = normalizePlanItems(items);

  if (!normalizedItems.length) {
    throw new Error('BUDGET_PLAN_ITEMS_EMPTY');
  }

  await closeActiveBudgetPlans(userId);

  const { data: plan, error: planError } = await supabase
    .from('budget_plans')
    .insert({
      user_id: userId,
      start_date: startDate,
      end_date: endDate,
      is_active: true
    })
    .select(PLAN_SELECT_COLUMNS)
    .single();

  if (planError) {
    throw planError;
  }

  const { error: itemsError } = await supabase
    .from('budget_plan_items')
    .insert(normalizedItems.map((item) => ({
      budget_plan_id: plan.id,
      category: item.category,
      planned_amount: item.plannedAmount
    })));

  if (itemsError) {
    throw itemsError;
  }

  return attachItems(plan);
}

async function updateBudgetPlanDates(userId, planId, { startDate, endDate }) {
  const { data, error } = await supabase
    .from('budget_plans')
    .update({
      start_date: startDate,
      end_date: endDate
    })
    .eq('id', planId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .select(PLAN_SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFoundError = new Error('BUDGET_PLAN_NOT_FOUND');
    notFoundError.code = 'BUDGET_PLAN_NOT_FOUND';
    throw notFoundError;
  }

  return attachItems(data);
}

async function updateBudgetPlanItem(userId, itemId, plannedAmount) {
  const amount = parseAmount(plannedAmount);

  if (!amount) {
    throw new Error("Reja summasi musbat raqam bo'lishi kerak.");
  }

  const { data: item, error: itemError } = await supabase
    .from('budget_plan_items')
    .select(`${ITEM_SELECT_COLUMNS}, budget_plans!inner(user_id, is_active)`)
    .eq('id', itemId)
    .eq('budget_plans.user_id', userId)
    .eq('budget_plans.is_active', true)
    .maybeSingle();

  if (itemError) {
    throw itemError;
  }

  if (!item) {
    const notFoundError = new Error('BUDGET_PLAN_ITEM_NOT_FOUND');
    notFoundError.code = 'BUDGET_PLAN_ITEM_NOT_FOUND';
    throw notFoundError;
  }

  const { data, error } = await supabase
    .from('budget_plan_items')
    .update({ planned_amount: amount })
    .eq('id', itemId)
    .select(ITEM_SELECT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getPlanExpenses(userId, plan) {
  const { start, end } = getDateRangeBounds(plan.start_date, plan.end_date);
  const { data, error } = await supabase
    .from('expenses')
    .select('id, amount, category, type, created_at')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  if (error) {
    throw error;
  }

  return data || [];
}

async function getBudgetPlanProgress(userId, plan) {
  if (!plan) {
    return null;
  }

  const planWithItems = plan.items ? plan : await attachItems(plan);
  const expenses = await getPlanExpenses(userId, planWithItems);
  const spentByCategory = expenses.reduce((acc, expense) => {
    acc[expense.category] = Number(acc[expense.category] || 0) + Number(expense.amount || 0);
    return acc;
  }, {});
  const items = (planWithItems.items || []).map((item) => {
    const plannedAmount = Number(item.planned_amount || 0);
    const spent = Number(spentByCategory[item.category] || 0);

    return {
      id: item.id,
      category: item.category,
      plannedAmount,
      spent,
      overAmount: Math.max(0, spent - plannedAmount)
    };
  });

  return {
    plan: planWithItems,
    items,
    totalPlanned: items.reduce((sum, item) => sum + item.plannedAmount, 0),
    totalSpent: items.reduce((sum, item) => sum + item.spent, 0)
  };
}

async function getBudgetWarningsForExpenses(userId, expenses = [], date = new Date()) {
  const activePlan = await getActiveBudgetPlan(userId, date);

  if (!activePlan) {
    return [];
  }

  const progress = await getBudgetPlanProgress(userId, activePlan);
  const expenseCategories = new Set(
    expenses
      .filter((expense) => expense?.type !== 'income')
      .map((expense) => expense.category)
  );

  return progress.items
    .filter((item) => expenseCategories.has(item.category) && item.overAmount > 0)
    .map((item) => ({
      category: item.category,
      plannedAmount: item.plannedAmount,
      spent: item.spent,
      overAmount: item.overAmount
    }));
}

async function getExpiredActiveBudgetPlan(userId, date = new Date()) {
  const today = getDateKey(date);
  const { data, error } = await supabase
    .from('budget_plans')
    .select(PLAN_SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('is_active', true)
    .lt('end_date', today)
    .order('end_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return attachItems(data);
}

async function closeBudgetPlan(userId, planId) {
  const { data, error } = await supabase
    .from('budget_plans')
    .update({ is_active: false })
    .eq('id', planId)
    .eq('user_id', userId)
    .select(PLAN_SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = {
  closeActiveBudgetPlans,
  closeBudgetPlan,
  createBudgetPlan,
  formatDate,
  getActiveBudgetPlan,
  getAnyActiveBudgetPlan,
  getBudgetPlanProgress,
  getBudgetWarningsForExpenses,
  getDateKey,
  getDateRangeBounds,
  getExpiredActiveBudgetPlan,
  normalizePlanItems,
  parseBudgetDateRange,
  updateBudgetPlanDates,
  updateBudgetPlanItem
};
