const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { addLedgerEntry } = require('./ledger');
const { getOracleTimestamp } = require('./timeOracle');

const DB_PATH = path.join(__dirname, '..', 'data', 'payflow.db');

let dbPromise;

async function initializeSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      payDay INTEGER NOT NULL,
      liquidityBalance REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('EMPLOYER', 'EMPLOYEE'))
    );

    CREATE TABLE IF NOT EXISTS work_contracts (
      id INTEGER PRIMARY KEY,
      employerId INTEGER NOT NULL,
      employeeId INTEGER NOT NULL,
      monthlySalary REAL NOT NULL,
      payDay INTEGER NOT NULL,
      accrualPerDay REAL NOT NULL,
      alreadyWithdrawn REAL NOT NULL DEFAULT 0,
      feeRate REAL NOT NULL DEFAULT 0.03,
      minWithdraw REAL NOT NULL DEFAULT 100,
      companyLiquidityBalance REAL NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(employerId) REFERENCES users(id),
      FOREIGN KEY(employeeId) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS advance_requests (
      id INTEGER PRIMARY KEY,
      contractId INTEGER NOT NULL,
      employeeId INTEGER NOT NULL,
      requestedAmount REAL NOT NULL,
      approvedAmount REAL,
      feeAmount REAL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PAID', 'REJECTED')),
      note TEXT,
      paymentProvider TEXT,
      paymentRef TEXT,
      createdAt TEXT NOT NULL,
      approvedAt TEXT,
      FOREIGN KEY(contractId) REFERENCES work_contracts(id)
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY,
      contractId INTEGER NOT NULL,
      eventType TEXT NOT NULL,
      amount REAL NOT NULL,
      feeAmount REAL NOT NULL,
      details TEXT NOT NULL,
      oracleTimestamp TEXT NOT NULL,
      prevHash TEXT NOT NULL,
      hash TEXT NOT NULL,
      FOREIGN KEY(contractId) REFERENCES work_contracts(id)
    );

    CREATE TABLE IF NOT EXISTS time_oracle (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      offsetSeconds INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function seedIfEmpty(db) {
  const companyCount = await db.get('SELECT COUNT(*) as count FROM companies');
  if (companyCount.count > 0) {
    return;
  }

  await db.run(
    'INSERT INTO companies (id, name, payDay, liquidityBalance) VALUES (?, ?, ?, ?)',
    [1, 'Demo Employer Ltd.', 10, 500000]
  );

  await db.run(
    'INSERT INTO users (id, name, role) VALUES (?, ?, ?), (?, ?, ?)',
    [1, 'Demo Employer', 'EMPLOYER', 2, 'Demo Employee', 'EMPLOYEE']
  );

  const createdAt = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
  await db.run(
    `INSERT INTO work_contracts
      (id, employerId, employeeId, monthlySalary, payDay, accrualPerDay, alreadyWithdrawn, feeRate, minWithdraw, companyLiquidityBalance, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 2, 450000, 10, 15000, 0, 0.03, 100, 500000, createdAt]
  );

  await db.run(
    'INSERT INTO time_oracle (id, name, offsetSeconds) VALUES (?, ?, ?)',
    [1, 'Simulated trusted oracle', 0]
  );

  const oracle = await db.get('SELECT * FROM time_oracle WHERE id = 1');
  const oracleTimestamp = getOracleTimestamp(oracle).toISOString();

  await addLedgerEntry(db, {
    contractId: 1,
    eventType: 'CONTRACT_CREATED',
    amount: 0,
    feeAmount: 0,
    details: {
      employerId: 1,
      employeeId: 2,
      monthlySalary: 450000,
      payDay: 10
    },
    oracleTimestamp
  });
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: DB_PATH,
      driver: sqlite3.Database
    }).then(async (db) => {
      await initializeSchema(db);
      await seedIfEmpty(db);
      return db;
    });
  }

  return dbPromise;
}

module.exports = { getDb };
