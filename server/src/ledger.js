const crypto = require('crypto');

function computeHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function addLedgerEntry(db, {
  contractId,
  eventType,
  amount = 0,
  feeAmount = 0,
  details,
  oracleTimestamp
}) {
  const previous = await db.get(
    'SELECT hash FROM ledger_entries WHERE contractId = ? ORDER BY id DESC LIMIT 1',
    [contractId]
  );

  const prevHash = previous?.hash ?? 'GENESIS';
  const detailsJson = JSON.stringify(details ?? {});

  const hash = computeHash({
    contractId,
    eventType,
    amount,
    feeAmount,
    details: detailsJson,
    oracleTimestamp,
    prevHash
  });

  const result = await db.run(
    `INSERT INTO ledger_entries
      (contractId, eventType, amount, feeAmount, details, oracleTimestamp, prevHash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [contractId, eventType, amount, feeAmount, detailsJson, oracleTimestamp, prevHash, hash]
  );

  return db.get('SELECT * FROM ledger_entries WHERE id = ?', [result.lastID]);
}

module.exports = { addLedgerEntry };
