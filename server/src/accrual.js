const DAY_MS = 24 * 60 * 60 * 1000;

function getCycleStart(payDay, now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (day >= payDay) {
    return new Date(Date.UTC(year, month, payDay, 0, 0, 0));
  }

  return new Date(Date.UTC(year, month - 1, payDay, 0, 0, 0));
}

function calculateAccrual(contract, oracleNow) {
  const cycleStart = getCycleStart(contract.payDay, oracleNow);
  const contractStart = new Date(contract.createdAt);
  const accrualStart = contractStart > cycleStart ? contractStart : cycleStart;

  const elapsedMs = Math.max(0, oracleNow.getTime() - accrualStart.getTime());
  const earnedDays = Math.floor(elapsedMs / DAY_MS);
  const earnedAmount = Number((earnedDays * contract.accrualPerDay).toFixed(2));
  const availableAmount = Number(Math.max(0, earnedAmount - contract.alreadyWithdrawn).toFixed(2));

  return {
    cycleStart: accrualStart.toISOString(),
    earnedDays,
    earnedAmount,
    availableAmount
  };
}

module.exports = { calculateAccrual };
