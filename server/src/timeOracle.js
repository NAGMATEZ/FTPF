function getOracleTimestamp(oracleConfig) {
  const offsetSeconds = oracleConfig?.offsetSeconds ?? 0;
  return new Date(Date.now() + offsetSeconds * 1000);
}

module.exports = { getOracleTimestamp };
