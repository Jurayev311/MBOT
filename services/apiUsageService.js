const { supabase } = require('../config/db');

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

async function logApiUsage() {
  const { error } = await supabase
    .from('api_usage_log')
    .insert({});

  if (error) {
    throw error;
  }
}

async function getTodayApiUsageCount(date = new Date()) {
  const { start, end } = getTodayBounds(date);
  const { count, error } = await supabase
    .from('api_usage_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  if (error) {
    throw error;
  }

  return Number(count || 0);
}

module.exports = {
  getTodayApiUsageCount,
  logApiUsage
};
