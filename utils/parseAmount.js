const UNIT_MULTIPLIERS = [
  {
    multiplier: 1_000_000,
    pattern: /([+]?\d+(?:[\s.,]\d+)*)\s*(mln|million|m)\b/i
  },
  {
    multiplier: 1_000,
    pattern: /([+]?\d+(?:[\s.,]\d+)*)\s*(ming(?:\s+so['’`ʻ]?m)?|k)\b/i
  }
];

const NUMBER_PATTERN = /[+]?\d+(?:[\s.,]\d+)*/;

function cleanNumericText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGroupedThousands(value) {
  return /^[+]?\d{1,3}(?:[ .,]\d{3})+$/.test(value);
}

function parseNumberWithOptionalDecimal(value) {
  const raw = cleanNumericText(value);

  if (!raw) {
    return null;
  }

  if (isGroupedThousands(raw)) {
    const grouped = Number(raw.replace(/[ .,]/g, '').replace(/^\+/, ''));
    return Number.isFinite(grouped) ? grouped : null;
  }

  const compact = raw.replace(/\s+/g, '').replace(/^\+/, '');

  if (!/^\d+(?:[.,]\d+)?$/.test(compact)) {
    return null;
  }

  const normalized = compact.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parsePlainNumber(value) {
  const raw = cleanNumericText(value);

  if (!raw) {
    return null;
  }

  if (/^[+]?\d+$/.test(raw)) {
    const amount = Number(raw.replace(/^\+/, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  if (isGroupedThousands(raw)) {
    const amount = Number(raw.replace(/[ .,]/g, '').replace(/^\+/, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  return null;
}

function roundPositiveInteger(value) {
  const amount = Math.round(Number(value));

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

function parseAmount(input) {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input > 0 ? input : null;
  }

  const text = cleanNumericText(input);

  if (!text) {
    return null;
  }

  for (const { pattern, multiplier } of UNIT_MULTIPLIERS) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const baseAmount = parseNumberWithOptionalDecimal(match[1]);
    return baseAmount ? roundPositiveInteger(baseAmount * multiplier) : null;
  }

  const numberMatch = text.match(NUMBER_PATTERN);

  if (!numberMatch) {
    return null;
  }

  return roundPositiveInteger(parsePlainNumber(numberMatch[0]));
}

module.exports = {
  parseAmount
};
