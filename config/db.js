require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL .env faylida kiritilishi kerak.');
}

// Qiymatlar avvalgi Supabase javoblari bilan bir xil ko'rinishda qaytishi uchun.
types.setTypeParser(20, (value) => Number(value)); // bigint
types.setTypeParser(1700, (value) => Number(value)); // numeric
types.setTypeParser(1082, (value) => value); // date -> 'YYYY-MM-DD'
types.setTypeParser(1184, (value) => new Date(value).toISOString()); // timestamptz

// Railway ichki tarmog'ida SSL kerak emas, tashqi proxy orqali ulanganda esa kerak.
const useSsl = !/\.railway\.internal|localhost|127\.0\.0\.1/.test(DATABASE_URL)
  && process.env.DATABASE_SSL !== 'false';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_MAX || 10)
});

pool.on('error', (error) => {
  console.error('Postgres pool xatosi:', error.message || error);
});

async function query(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// UPDATE ... SET qismini obyekt kalitlaridan yig'adi; kalitlar faqat kod ichidan keladi.
function buildSet(fields, startIndex = 1) {
  const keys = Object.keys(fields);
  return {
    clause: keys.map((key, index) => `${key} = $${startIndex + index}`).join(', '),
    values: keys.map((key) => fields[key])
  };
}

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

module.exports = { buildSet, migrate, pool, query, queryOne };
