const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { getDb } = require('./db');
const { addLedgerEntry } = require('./ledger');
const { getOracleTimestamp } = require('./timeOracle');
const { calculateAccrual } = require('./accrual');

const app = express();
const PORT = process.env.PORT || 3001;
const DEMO_EMPLOYER_ID = 1;
const DEMO_EMPLOYEE_ID = 2;
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please retry shortly.' }
});

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use('/api', apiLimiter);

function round2(value) {
  return Number(Number(value).toFixed(2));
}

async function getOracleConfig(db) {
  return db.get('SELECT * FROM time_oracle WHERE id = 1');
}

async function syncCompanyLiquidityToContracts(db, liquidityBalance) {
  await db.run('UPDATE work_contracts SET companyLiquidityBalance = ?', [liquidityBalance]);
}

async function hydrateLedger(db, contractId, limit = 20) {
  const rows = await db.all(
    'SELECT * FROM ledger_entries WHERE contractId = ? ORDER BY id DESC LIMIT ?',
    [contractId, limit]
  );

  return rows.map((row) => ({
    ...row,
    details: JSON.parse(row.details)
  }));
}

async function getContractByEmployeeId(db, employeeId) {
  return db.get(
    `SELECT c.*, comp.name as companyName, comp.liquidityBalance, e.name as employeeName, em.name as employerName
     FROM work_contracts c
     JOIN companies comp ON comp.id = 1
     JOIN users e ON e.id = c.employeeId
     JOIN users em ON em.id = c.employerId
     WHERE c.employeeId = ?`,
    [employeeId]
  );
}

app.get('/api/health', async (req, res) => {
  await getDb();
  res.json({ ok: true });
});

app.get('/api/time', async (req, res) => {
  const db = await getDb();
  const company = await db.get('SELECT payDay FROM companies WHERE id = 1');
  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);

  res.json({
    oracleName: oracle.name,
    oracleTimestamp: oracleNow.toISOString(),
    companyPayDay: company.payDay
  });
});

app.get('/api/employee/dashboard', async (req, res) => {
  const db = await getDb();
  const employeeId = DEMO_EMPLOYEE_ID;
  const contract = await getContractByEmployeeId(db, employeeId);

  if (!contract) {
    return res.status(404).json({ error: 'Employee contract not found' });
  }

  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);
  const accrual = calculateAccrual(contract, oracleNow);

  const requests = await db.all(
    'SELECT * FROM advance_requests WHERE employeeId = ? ORDER BY id DESC LIMIT 20',
    [employeeId]
  );

  const ledger = await hydrateLedger(db, contract.id);

  res.json({
    employee: {
      id: contract.employeeId,
      name: contract.employeeName
    },
    employer: {
      id: contract.employerId,
      name: contract.employerName
    },
    company: {
      name: contract.companyName,
      payDay: contract.payDay,
      companyLiquidityBalance: contract.liquidityBalance
    },
    contract: {
      id: contract.id,
      employerId: contract.employerId,
      employeeId: contract.employeeId,
      monthlySalary: contract.monthlySalary,
      payDay: contract.payDay,
      accrualPerDay: contract.accrualPerDay,
      alreadyWithdrawn: contract.alreadyWithdrawn,
      feeRate: contract.feeRate,
      minWithdraw: contract.minWithdraw,
      companyLiquidityBalance: contract.liquidityBalance,
      ledgerEntries: ledger
    },
    accrual,
    requests,
    oracle: {
      name: oracle.name,
      timestamp: oracleNow.toISOString()
    }
  });
});

app.post('/api/employee/:employeeId/withdraw', async (req, res) => {
  const db = await getDb();
  const employeeId = Number(req.params.employeeId);
  const amount = round2(Number(req.body.amount));

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const contract = await getContractByEmployeeId(db, employeeId);
  if (!contract) {
    return res.status(404).json({ error: 'Employee contract not found' });
  }

  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);
  const accrual = calculateAccrual(contract, oracleNow);

  if (amount < contract.minWithdraw) {
    return res.status(400).json({ error: `Minimum withdrawal is ${contract.minWithdraw}` });
  }

  if (amount > accrual.availableAmount) {
    return res.status(400).json({ error: `Amount exceeds available earned balance (${accrual.availableAmount})` });
  }

  const company = await db.get('SELECT * FROM companies WHERE id = 1');
  let approvedAmount = amount;
  let note = null;

  if (approvedAmount > company.liquidityBalance) {
    if (company.liquidityBalance < contract.minWithdraw) {
      return res.status(400).json({ error: 'Insufficient company liquidity' });
    }

    approvedAmount = round2(company.liquidityBalance);
    note = 'CAPPED_BY_LIQUIDITY';
  }

  const feeAmount = round2(approvedAmount * contract.feeRate);

  const result = await db.run(
    `INSERT INTO advance_requests
      (contractId, employeeId, requestedAmount, approvedAmount, feeAmount, status, note, createdAt)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    [contract.id, employeeId, amount, approvedAmount, feeAmount, note, oracleNow.toISOString()]
  );

  await addLedgerEntry(db, {
    contractId: contract.id,
    eventType: 'ADVANCE_REQUESTED',
    amount: approvedAmount,
    feeAmount,
    details: {
      requestedAmount: amount,
      note,
      oracle: oracle.name
    },
    oracleTimestamp: oracleNow.toISOString()
  });

  return res.status(201).json({
    id: result.lastID,
    status: 'PENDING',
    requestedAmount: amount,
    approvedAmount,
    feeAmount,
    note
  });
});

app.get('/api/employer/dashboard', async (req, res) => {
  const db = await getDb();
  const employerId = DEMO_EMPLOYER_ID;

  const employer = await db.get('SELECT * FROM users WHERE id = ? AND role = ?', [employerId, 'EMPLOYER']);
  if (!employer) {
    return res.status(404).json({ error: 'Employer not found' });
  }

  const company = await db.get('SELECT * FROM companies WHERE id = 1');
  const contracts = await db.all(
    `SELECT c.*, e.name as employeeName
     FROM work_contracts c
     JOIN users e ON e.id = c.employeeId
     WHERE c.employerId = ?`,
    [employerId]
  );

  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);

  const hydratedContracts = contracts.map((contract) => ({
    ...contract,
    accrual: calculateAccrual(contract, oracleNow)
  }));

  const pendingRequests = await db.all(
    `SELECT r.*, u.name as employeeName
     FROM advance_requests r
     JOIN users u ON u.id = r.employeeId
     JOIN work_contracts c ON c.id = r.contractId
     WHERE c.employerId = ? AND r.status = 'PENDING'
     ORDER BY r.id DESC`,
    [employerId]
  );

  const ledger = contracts.length > 0 ? await hydrateLedger(db, contracts[0].id, 25) : [];

  res.json({
    employer,
    company,
    oracle: {
      name: oracle.name,
      timestamp: oracleNow.toISOString()
    },
    contracts: hydratedContracts,
    pendingRequests,
    ledger
  });
});

app.post('/api/employer/:employerId/liquidity', async (req, res) => {
  const db = await getDb();
  const employerId = Number(req.params.employerId);
  const amount = round2(Number(req.body.amount));

  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const contracts = await db.all('SELECT id FROM work_contracts WHERE employerId = ?', [employerId]);
  if (contracts.length === 0) {
    return res.status(404).json({ error: 'No contract for employer' });
  }

  const company = await db.get('SELECT * FROM companies WHERE id = 1');
  const newBalance = round2(company.liquidityBalance + amount);

  if (newBalance < 0) {
    return res.status(400).json({ error: 'Liquidity cannot be negative' });
  }

  await db.run('UPDATE companies SET liquidityBalance = ? WHERE id = 1', [newBalance]);
  await syncCompanyLiquidityToContracts(db, newBalance);

  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);

  await Promise.all(
    contracts.map((contract) =>
      addLedgerEntry(db, {
        contractId: contract.id,
        eventType: amount > 0 ? 'LIQUIDITY_TOPUP' : 'LIQUIDITY_REDUCTION',
        amount,
        feeAmount: 0,
        details: {
          employerId,
          resultingLiquidityBalance: newBalance
        },
        oracleTimestamp: oracleNow.toISOString()
      })
    )
  );

  res.json({ liquidityBalance: newBalance });
});

app.post('/api/employer/:employerId/requests/:requestId/approve', async (req, res) => {
  const db = await getDb();
  const employerId = Number(req.params.employerId);
  const requestId = Number(req.params.requestId);

  const request = await db.get(
    `SELECT r.*, c.employerId, c.feeRate, c.minWithdraw, c.id as contractId
     FROM advance_requests r
     JOIN work_contracts c ON c.id = r.contractId
     WHERE r.id = ? AND c.employerId = ?`,
    [requestId, employerId]
  );

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (request.status !== 'PENDING') {
    return res.status(400).json({ error: 'Request already processed' });
  }

  const company = await db.get('SELECT * FROM companies WHERE id = 1');
  if (request.approvedAmount === null || request.approvedAmount === undefined) {
    return res.status(400).json({ error: 'Pending request has no approved amount' });
  }

  let payoutAmount = round2(request.approvedAmount);

  if (payoutAmount > company.liquidityBalance) {
    if (company.liquidityBalance < request.minWithdraw) {
      return res.status(400).json({ error: 'Insufficient liquidity for payout' });
    }

    payoutAmount = round2(company.liquidityBalance);
  }

  if (payoutAmount < request.minWithdraw) {
    return res.status(400).json({ error: `Payout must remain >= ${request.minWithdraw}` });
  }

  const feeAmount = round2(payoutAmount * request.feeRate);
  const newLiquidity = round2(company.liquidityBalance - payoutAmount);
  const oracle = await getOracleConfig(db);
  const oracleNow = getOracleTimestamp(oracle);
  const paymentRef = `SIM-${randomUUID()}`;

  await db.run('UPDATE companies SET liquidityBalance = ? WHERE id = 1', [newLiquidity]);
  await syncCompanyLiquidityToContracts(db, newLiquidity);

  await db.run(
    `UPDATE work_contracts
     SET alreadyWithdrawn = alreadyWithdrawn + ?, companyLiquidityBalance = ?
     WHERE id = ?`,
    [payoutAmount, newLiquidity, request.contractId]
  );

  await db.run(
    `UPDATE advance_requests
     SET status = 'PAID', approvedAmount = ?, feeAmount = ?, paymentProvider = ?, paymentRef = ?, approvedAt = ?, note = COALESCE(note, 'APPROVED')
     WHERE id = ?`,
    [payoutAmount, feeAmount, 'QVIK_AFR_SIM', paymentRef, oracleNow.toISOString(), requestId]
  );

  await addLedgerEntry(db, {
    contractId: request.contractId,
    eventType: 'PAYMENT_REQUEST_LOGGED',
    amount: payoutAmount,
    feeAmount,
    details: {
      provider: 'QVIK_AFR_SIM',
      paymentRef,
      from: 'Demo Employer Bank Account',
      to: `Employee#${request.employeeId}`
    },
    oracleTimestamp: oracleNow.toISOString()
  });

  await addLedgerEntry(db, {
    contractId: request.contractId,
    eventType: 'PAYOUT_COMPLETED',
    amount: payoutAmount,
    feeAmount,
    details: {
      requestId,
      alreadyWithdrawnIncrease: payoutAmount,
      remainingLiquidity: newLiquidity
    },
    oracleTimestamp: oracleNow.toISOString()
  });

  const updated = await db.get('SELECT * FROM advance_requests WHERE id = ?', [requestId]);
  res.json(updated);
});

app.listen(PORT, async () => {
  await getDb();
  // eslint-disable-next-line no-console
  console.log(`PayFlow backend running on http://localhost:${PORT}`);
});
