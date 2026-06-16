import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('pulse.db');

const DEFAULT_CATEGORIES = [
  ['Food', '🍜', '#FF6B6B'],
  ['Transport', '🚗', '#4ECDC4'],
  ['Subscriptions', '📱', '#A78BFA'],
  ['Income', '💸', '#34D399'],
  ['Shopping', '🛍️', '#F59E0B'],
  ['Bills', '🧾', '#60A5FA'],
];

export const bootstrapDb = async () => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchant_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_normalized TEXT UNIQUE NOT NULL,
      category_id INTEGER NOT NULL,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_app TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      extras_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      merchant TEXT NOT NULL,
      type TEXT NOT NULL,
      category_id INTEGER,
      source_app TEXT,
      confidence REAL NOT NULL,
      confirmed INTEGER DEFAULT 0,
      raw_text TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
  `);

  for (const [name, emoji, color] of DEFAULT_CATEGORIES) {
    await db.runAsync(
      'INSERT OR IGNORE INTO categories(name, emoji, color) VALUES(?, ?, ?)',
      [name, emoji, color]
    );
  }
};

export const getSetting = async (key) => {
  const row = await db.getFirstAsync('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
};

export const setSetting = async (key, value) => {
  await db.runAsync('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
};

export const addNotificationLog = async ({ sourceApp, rawText, extras }) => {
  await db.runAsync(
    'INSERT INTO notification_log(source_app, raw_text, extras_json, created_at) VALUES (?, ?, ?, ?)',
    [sourceApp, rawText, JSON.stringify(extras ?? {}), new Date().toISOString()]
  );
};

export const getCategories = () => db.getAllAsync('SELECT * FROM categories ORDER BY name');

export const getMerchantMemories = () =>
  db.getAllAsync(
    'SELECT m.id, m.merchant_normalized, m.category_id, c.name as category_name, c.emoji, c.color FROM merchant_memory m JOIN categories c ON c.id = m.category_id'
  );

export const saveMerchantMemory = async (merchantNormalized, categoryId) => {
  await db.runAsync(
    'INSERT INTO merchant_memory(merchant_normalized, category_id) VALUES(?, ?) ON CONFLICT(merchant_normalized) DO UPDATE SET category_id = excluded.category_id',
    [merchantNormalized, categoryId]
  );
};

export const insertTransaction = async (tx) => {
  const result = await db.runAsync(
    `INSERT INTO transactions(amount, currency, merchant, type, category_id, source_app, confidence, confirmed, raw_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      tx.amount,
      tx.currency,
      tx.merchant,
      tx.type,
      tx.categoryId ?? null,
      tx.sourceApp,
      tx.confidence,
      tx.confirmed ? 1 : 0,
      tx.rawText,
      (tx.timestamp ? new Date(tx.timestamp) : new Date()).toISOString(),
    ]
  );
  return result.lastInsertRowId;
};

export const updateTransaction = async (id, tx) => {
  await db.runAsync(
    `UPDATE transactions
     SET amount=?, currency=?, merchant=?, type=?, category_id=?, confidence=?, confirmed=?, raw_text=?
     WHERE id=?`,
    [tx.amount, tx.currency, tx.merchant, tx.type, tx.categoryId ?? null, tx.confidence, tx.confirmed ? 1 : 0, tx.rawText, id]
  );
};

export const confirmTransaction = (id) => db.runAsync('UPDATE transactions SET confirmed = 1 WHERE id = ?', [id]);

export const deleteTransaction = (id) => db.runAsync('DELETE FROM transactions WHERE id = ?', [id]);

export const getTransactions = () =>
  db.getAllAsync(
    `SELECT t.*, c.name as category_name, c.emoji as category_emoji, c.color as category_color
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     ORDER BY datetime(t.created_at) DESC`
  );

export const getMonthlyTotals = async () =>
  db.getAllAsync(
    `SELECT strftime('%Y-%m', created_at) as month,
            SUM(CASE WHEN type='debit' THEN amount ELSE 0 END) as expense,
            SUM(CASE WHEN type='credit' THEN amount ELSE 0 END) as income
     FROM transactions
     GROUP BY strftime('%Y-%m', created_at)
     ORDER BY month DESC
     LIMIT 6`
  );

export const getCategorySpendForMonth = (monthPrefix) =>
  db.getAllAsync(
    `SELECT COALESCE(c.name, 'Uncategorized') as name,
            COALESCE(c.color, '#9CA3AF') as color,
            SUM(t.amount) as total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.type='debit' AND t.created_at LIKE ?
     GROUP BY COALESCE(c.name, 'Uncategorized'), COALESCE(c.color, '#9CA3AF')
     ORDER BY total DESC`,
    [`${monthPrefix}%`]
  );

export default db;
