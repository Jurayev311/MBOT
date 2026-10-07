// Bir martalik: eski Supabase ma'lumotlarini joriy Postgres (DATABASE_URL) ga ko'chiradi.
// Ishlatish: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/importSupabase.js
// Qayta ishga tushirish xavfsiz: mavjud qatorlar (id yoki telegram_id bo'yicha) o'tkazib yuboriladi.
require('dotenv').config({ quiet: true });

const { migrate, pool } = require('../config/db');
const { CATEGORIES } = require('../services/ai');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const PAGE_SIZE = 1000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL va SUPABASE_SERVICE_KEY kerak.');
  process.exit(1);
}

async function fetchTable(table) {
  const rows = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.asc`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        'Range-Unit': 'items'
      }
    });

    if (!response.ok) {
      throw new Error(`${table}: ${response.status} ${await response.text()}`);
    }

    const page = await response.json();
    rows.push(...page);

    if (page.length < PAGE_SIZE) {
      return rows;
    }
  }
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table]
  );
  return new Set(rows.map((row) => row.column_name));
}

async function insertRows(client, table, rows) {
  if (!rows.length) {
    return 0;
  }

  const columns = await getColumns(client, table);
  let inserted = 0;

  for (const row of rows) {
    const keys = Object.keys(row).filter((key) => columns.has(key));
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
    const result = await client.query(
      `insert into ${table} (${keys.join(', ')}) values (${placeholders}) on conflict do nothing`,
      keys.map((key) => row[key])
    );
    inserted += result.rowCount;
  }

  return inserted;
}

async function main() {
  await migrate();

  const [users, expenses, history, plans, planItems, apiUsage] = await Promise.all([
    fetchTable('users'),
    fetchTable('expenses'),
    fetchTable('monthly_history'),
    fetchTable('budget_plans'),
    fetchTable('budget_plan_items'),
    fetchTable('api_usage_log')
  ]);

  console.log(`Supabase: users=${users.length}, expenses=${expenses.length}, monthly_history=${history.length}, ` +
    `budget_plans=${plans.length}, budget_plan_items=${planItems.length}, api_usage_log=${apiUsage.length}`);

  const client = await pool.connect();

  try {
    await client.query('begin');

    const usersInserted = await insertRows(client, 'users', users);

    // Railway'da allaqachon bor foydalanuvchilar (masalan admin) uchun eski id yangi id'ga bog'lanadi.
    const { rows: currentUsers } = await client.query('select id, telegram_id from users');
    const idByTelegramId = new Map(currentUsers.map((user) => [String(user.telegram_id), user.id]));
    const userIdMap = new Map(users.map((user) => [user.id, idByTelegramId.get(String(user.telegram_id))]));
    const remapUser = (rows) => rows
      .map((row) => ({ ...row, user_id: userIdMap.get(row.user_id) }))
      .filter((row) => row.user_id);

    // Supabase'dagi kategoriya cheklovi "not valid" edi, eski qatorlarda noma'lum kategoriya bo'lishi mumkin.
    const fixCategory = (row) => {
      if (row.type === 'income') {
        return { ...row, category: 'Kirim' };
      }

      return CATEGORIES.includes(row.category) && row.category !== 'Kirim' ? row : { ...row, category: 'Boshqa' };
    };

    const expensesInserted = await insertRows(client, 'expenses', remapUser(expenses).map(fixCategory));
    const historyInserted = await insertRows(client, 'monthly_history', remapUser(history));
    const plansToInsert = remapUser(plans);
    const plansInserted = await insertRows(client, 'budget_plans', plansToInsert);
    const planIds = new Set(plansToInsert.map((plan) => plan.id));
    const itemsInserted = await insertRows(
      client,
      'budget_plan_items',
      planItems.filter((item) => planIds.has(item.budget_plan_id)).map((item) => fixCategory({ ...item, type: 'expense' }))
    );
    const apiInserted = await insertRows(client, 'api_usage_log', apiUsage);

    await client.query('commit');

    console.log(`Ko'chirildi: users=${usersInserted}, expenses=${expensesInserted}, monthly_history=${historyInserted}, ` +
      `budget_plans=${plansInserted}, budget_plan_items=${itemsInserted}, api_usage_log=${apiInserted}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Import xatosi:', error);
  process.exit(1);
});
