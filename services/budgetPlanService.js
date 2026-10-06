const { query, queryOne } = require('../config/db');
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

function prefixColumns(columns, alias) {
  return columns.split(',').map((column) => `${alias}.${column.trim()}`).join(', ');
}

function normalizeCategory(category) {
  return CATEGORIES.includes(category) && category !== 'Kirim' ? category : 'Boshqa';
}

function normalizePlanItems(items = []) {
  const groupedItems = new Map();

  for (const item of items) {
    const amount = parseAmount(item?.planned_amount ?? item?.plannedAmount ?? item?.amount ?? 0);

    if (!amount) {
      continue;
    }

    if (item?.type === 'income' || String(item?.category || '').trim() === 'Kirim') {
      continue;
    }

    const category = normalizeCategory(item?.category);
    const previous = groupedItems.get(category);

    groupedItems.set(category, {
      category,
      plannedAmount: Number(previous?.plannedAmount || 0) + amount
    });
  }

  return [...groupedItems.values()];
}

async function getBudgetPlanItems(planId, userId) {
  return query(
    `select ${prefixColumns(ITEM_SELECT_COLUMNS, 'i')} from budget_plan_items i
     join budget_plans p on p.id = i.budget_plan_id
     where i.budget_plan_id = $1 and p.user_id = $2
     order by i.category asc`,
    [planId, userId]
  );
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
  const data = await queryOne(
    `select ${PLAN_SELECT_COLUMNS} from budget_plans
     where user_id = $1 and is_active = true and start_date <= $2 and end_date >= $2
     order by created_at desc
     limit 1`,
    [userId, today]
  );

  return attachItems(data);
}

async function getAnyActiveBudgetPlan(userId) {
  const data = await queryOne(
    `select ${PLAN_SELECT_COLUMNS} from budget_plans
     where user_id = $1 and is_active = true
     order by created_at desc
     limit 1`,
    [userId]
  );

  return attachItems(data);
}

async function closeActiveBudgetPlans(userId) {
  await query('update budget_plans set is_active = false where user_id = $1 and is_active = true', [userId]);
}

async function insertPlanItems(planId, items) {
  for (const item of items) {
    await query(
      'insert into budget_plan_items (budget_plan_id, category, planned_amount) values ($1, $2, $3)',
      [planId, item.category, item.plannedAmount]
    );
  }
}

async function createBudgetPlan(userId, { startDate, endDate, items }) {
  const normalizedItems = normalizePlanItems(items);

  if (!normalizedItems.length) {
    throw new Error('BUDGET_PLAN_ITEMS_EMPTY');
  }

  await closeActiveBudgetPlans(userId);

  const plan = await queryOne(
    `insert into budget_plans (user_id, start_date, end_date, is_active)
     values ($1, $2, $3, true)
     returning ${PLAN_SELECT_COLUMNS}`,
    [userId, startDate, endDate]
  );

  await insertPlanItems(plan.id, normalizedItems);

  return attachItems(plan);
}

async function addBudgetPlanItems(userId, planId, items) {
  const normalizedItems = normalizePlanItems(items);

  if (!normalizedItems.length) {
    const emptyError = new Error('BUDGET_PLAN_ITEMS_EMPTY');
    emptyError.code = 'BUDGET_PLAN_ITEMS_EMPTY';
    throw emptyError;
  }

  const plan = await queryOne(
    `select ${PLAN_SELECT_COLUMNS} from budget_plans
     where id = $1 and user_id = $2 and is_active = true`,
    [planId, userId]
  );

  if (!plan) {
    const notFoundError = new Error('BUDGET_PLAN_NOT_FOUND');
    notFoundError.code = 'BUDGET_PLAN_NOT_FOUND';
    throw notFoundError;
  }

  const currentItems = await getBudgetPlanItems(plan.id, userId);
  const itemByCategory = new Map(currentItems.map((item) => [item.category, item]));
  const itemsToInsert = [];

  for (const item of normalizedItems) {
    const currentItem = itemByCategory.get(item.category);

    if (!currentItem) {
      itemsToInsert.push(item);
      continue;
    }

    const nextAmount = Number(currentItem.planned_amount || 0) + Number(item.plannedAmount || 0);
    const updatedItem = await queryOne(
      `update budget_plan_items set planned_amount = $2 where id = $1 returning ${ITEM_SELECT_COLUMNS}`,
      [currentItem.id, nextAmount]
    );

    itemByCategory.set(item.category, updatedItem);
  }

  await insertPlanItems(plan.id, itemsToInsert);

  return attachItems(plan);
}

async function updateBudgetPlanDates(userId, planId, { startDate, endDate }) {
  const data = await queryOne(
    `update budget_plans set start_date = $3, end_date = $4
     where id = $1 and user_id = $2 and is_active = true
     returning ${PLAN_SELECT_COLUMNS}`,
    [planId, userId, startDate, endDate]
  );

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

  const item = await queryOne(
    `select i.id from budget_plan_items i
     join budget_plans p on p.id = i.budget_plan_id
     where i.id = $1 and p.user_id = $2 and p.is_active = true`,
    [itemId, userId]
  );

  if (!item) {
    const notFoundError = new Error('BUDGET_PLAN_ITEM_NOT_FOUND');
    notFoundError.code = 'BUDGET_PLAN_ITEM_NOT_FOUND';
    throw notFoundError;
  }

  return queryOne(
    `update budget_plan_items set planned_amount = $2 where id = $1 returning ${ITEM_SELECT_COLUMNS}`,
    [itemId, amount]
  );
}

async function getPlanExpenses(userId, plan) {
  const { start, end } = getDateRangeBounds(plan.start_date, plan.end_date);
  return query(
    `select id, amount, category, type, created_at from expenses
     where user_id = $1 and type = 'expense' and created_at >= $2 and created_at < $3`,
    [userId, start.toISOString(), end.toISOString()]
  );
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
    const isLimitReached = plannedAmount > 0 && spent >= plannedAmount;
    const rawPercent = plannedAmount > 0 ? (spent / plannedAmount) * 100 : 0;
    const percent = isLimitReached
      ? Math.round(rawPercent)
      : Math.min(99, Math.round(rawPercent));

    return {
      id: item.id,
      category: item.category,
      plannedAmount,
      spent,
      percent,
      isLimitReached,
      remainingAmount: Math.max(0, plannedAmount - spent),
      overAmount: Math.max(0, spent - plannedAmount)
    };
  });
  const plannedCategories = new Set(items.map((item) => item.category));
  const unplannedItems = Object.entries(spentByCategory)
    .filter(([category, spent]) => !plannedCategories.has(category) && Number(spent) > 0)
    .map(([category, spent]) => ({ category, spent: Number(spent) }))
    .sort((a, b) => b.spent - a.spent);

  return {
    plan: planWithItems,
    items,
    unplannedItems,
    totalPlanned: items.reduce((sum, item) => sum + item.plannedAmount, 0),
    totalSpent: expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    totalUnplannedSpent: unplannedItems.reduce((sum, item) => sum + item.spent, 0)
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
    .filter((item) => expenseCategories.has(item.category))
    .map((item) => ({
      type: item.isLimitReached ? 'limit_reached' : 'progress',
      category: item.category,
      plannedAmount: item.plannedAmount,
      spent: item.spent,
      percent: item.percent,
      isLimitReached: item.isLimitReached,
      remainingAmount: item.remainingAmount,
      overAmount: item.overAmount
    }));
}

async function getExpiredActiveBudgetPlan(userId, date = new Date()) {
  const today = getDateKey(date);
  const data = await queryOne(
    `select ${PLAN_SELECT_COLUMNS} from budget_plans
     where user_id = $1 and is_active = true and end_date < $2
     order by end_date desc
     limit 1`,
    [userId, today]
  );

  return attachItems(data);
}

async function closeBudgetPlan(userId, planId) {
  return queryOne(
    `update budget_plans set is_active = false
     where id = $1 and user_id = $2
     returning ${PLAN_SELECT_COLUMNS}`,
    [planId, userId]
  );
}

module.exports = {
  addBudgetPlanItems,
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
