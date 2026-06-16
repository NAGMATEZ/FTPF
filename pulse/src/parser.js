const GOOGLE_WALLET_PATTERNS = [
  /You paid ([₹$€£¥][\d,]+(?:\.\d{2})?) to (.+)/i,
  /Payment of ([₹$€£¥][\d,]+(?:\.\d{2})?) to (.+?) confirmed/i,
  /([₹$€£¥][\d,]+(?:\.\d{2})?) debited.*?at (.+)/i,
  /INR ([\d,]+(?:\.\d{2})?) spent at (.+)/i,
  /Sent ([₹$€£¥][\d,]+(?:\.\d{2})?) to (.+)/i,
  /([₹$€£¥][\d,]+(?:\.\d{2})?) credited.*?(?:from (.+))?/i,
];

const DEBIT_HINTS = /paid|debited|spent|sent|purchase|txn|transaction/i;
const CREDIT_HINTS = /credited|received|refund|salary|deposit/i;

export const normalizeMerchantName = (input = '') =>
  input
    .replace(/\b(PVT\.?\s*LTD\.?|PRIVATE\s*LIMITED|LTD\.?|LLC|INC\.?|CORP\.?|BANK|PAYMENTS?)\b/gi, '')
    .replace(/\b(mumbai|delhi|bangalore|bengaluru|pune|hyderabad|chennai|kolkata)\b/gi, '')
    .replace(/[\-*_,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseAmount = (amountPart) => {
  if (!amountPart) return { amount: 0, currency: 'INR' };
  const symbol = amountPart.match(/[₹$€£¥]/)?.[0] ?? '₹';
  const currencyMap = { '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const amount = Number.parseFloat(amountPart.replace(/[^\d.]/g, ''));
  return { amount: Number.isFinite(amount) ? amount : 0, currency: currencyMap[symbol] ?? 'INR' };
};

const fuzzy = (a = '', b = '') => {
  const x = normalizeMerchantName(a).toLowerCase();
  const y = normalizeMerchantName(b).toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  const intersection = [...xs].filter((w) => ys.has(w)).length;
  return intersection / Math.max(xs.size, ys.size, 1);
};

export const findMerchantMemory = (merchant, memories = []) => {
  let best = null;
  for (const row of memories) {
    const score = fuzzy(merchant, row.merchant_normalized);
    if (!best || score > best.score) best = { row, score };
  }
  return best && best.score >= 0.72 ? best.row : null;
};

export const parseNotificationText = ({ rawText = '', sourceApp = '' }) => {
  let merchant = '';
  let amount = 0;
  let currency = 'INR';
  let confidence = 0.35;
  let type = DEBIT_HINTS.test(rawText) ? 'debit' : CREDIT_HINTS.test(rawText) ? 'credit' : 'debit';

  for (const pattern of GOOGLE_WALLET_PATTERNS) {
    const match = rawText.match(pattern);
    if (!match) continue;
    const parsedAmount = parseAmount(match[1]);
    amount = parsedAmount.amount;
    currency = parsedAmount.currency;
    merchant = normalizeMerchantName(match[2] ?? sourceApp ?? 'Unknown');
    confidence = 0.84;
    if (/credited/i.test(rawText)) {
      type = 'credit';
      confidence = 0.86;
    }
    break;
  }

  if (!merchant) {
    const merchantGuess = rawText.match(/(?:to|at|from)\s+([A-Za-z0-9&\-\s]+)/i)?.[1];
    merchant = normalizeMerchantName(merchantGuess ?? sourceApp ?? 'Unknown');
    confidence -= 0.12;
  }

  if (amount <= 0) {
    const amountGuess = rawText.match(/([₹$€£¥]\s?[\d,]+(?:\.\d{2})?|INR\s?[\d,]+(?:\.\d{2})?)/i)?.[1];
    const parsed = parseAmount(amountGuess?.replace(/^INR/i, '₹'));
    amount = parsed.amount;
    currency = amountGuess?.toUpperCase().includes('INR') ? 'INR' : parsed.currency;
    confidence -= 0.1;
  }

  confidence = Math.max(0.1, Math.min(confidence, 0.98));

  return {
    amount,
    currency,
    merchant,
    type,
    rawText,
    timestamp: new Date(),
    sourceApp,
    confidence,
  };
};

export { GOOGLE_WALLET_PATTERNS };
