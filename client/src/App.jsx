import { useCallback, useEffect, useState } from 'react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function api(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload;
}

function App() {
  const [view, setView] = useState('employee');
  const [employeeData, setEmployeeData] = useState(null);
  const [employerData, setEmployerData] = useState(null);
  const [withdrawAmount, setWithdrawAmount] = useState('100');
  const [liquidityAmount, setLiquidityAmount] = useState('10000');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadEmployee = useCallback(async () => {
    const data = await api('/api/employee/dashboard');
    setEmployeeData(data);
  }, []);

  const loadEmployer = useCallback(async () => {
    const data = await api('/api/employer/dashboard');
    setEmployerData(data);
  }, []);

  const refreshAll = useCallback(async () => {
    setError('');
    await Promise.all([loadEmployee(), loadEmployer()]);
  }, [loadEmployee, loadEmployer]);

  useEffect(() => {
    refreshAll().catch((err) => setError(err.message));
  }, [refreshAll]);

  const submitWithdraw = async () => {
    setError('');
    setMessage('');
    try {
      const result = await api('/api/employee/2/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount: Number(withdrawAmount) })
      });
      setMessage(`Advance request submitted (approved amount: ${result.approvedAmount} HUF)`);
      await refreshAll();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateLiquidity = async () => {
    setError('');
    setMessage('');
    try {
      const result = await api('/api/employer/1/liquidity', {
        method: 'POST',
        body: JSON.stringify({ amount: Number(liquidityAmount) })
      });
      setMessage(`Liquidity updated: ${result.liquidityBalance} HUF`);
      await refreshAll();
    } catch (err) {
      setError(err.message);
    }
  };

  const approveRequest = async (requestId) => {
    setError('');
    setMessage('');
    try {
      await api(`/api/employer/1/requests/${requestId}/approve`, { method: 'POST' });
      setMessage(`Request ${requestId} paid via simulated Qvik/AFR`);
      await refreshAll();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="container">
      <h1>PayFlow EWA MVP</h1>
      <p className="subtitle">React + Express + SQLite with simulated blockchain ledger</p>

      <div className="switcher">
        <button className={view === 'employee' ? 'active' : ''} onClick={() => setView('employee')}>Employee UI</button>
        <button className={view === 'employer' ? 'active' : ''} onClick={() => setView('employer')}>Employer UI</button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="ok">{message}</div>}

      {view === 'employee' && employeeData && (
        <section className="panel">
          <h2>Employee Dashboard ({employeeData.employee.name})</h2>
          <p>Oracle time: <strong>{employeeData.oracle.timestamp}</strong></p>
          <div className="grid">
            <div><span>Monthly salary</span><strong>{employeeData.contract.monthlySalary} HUF</strong></div>
            <div><span>Accrual/day</span><strong>{employeeData.contract.accrualPerDay} HUF</strong></div>
            <div><span>Earned</span><strong>{employeeData.accrual.earnedAmount} HUF</strong></div>
            <div><span>Available to withdraw</span><strong>{employeeData.accrual.availableAmount} HUF</strong></div>
            <div><span>alreadyWithdrawn</span><strong>{employeeData.contract.alreadyWithdrawn} HUF</strong></div>
            <div><span>Fee rate</span><strong>{employeeData.contract.feeRate * 100}%</strong></div>
            <div><span>Min withdraw</span><strong>{employeeData.contract.minWithdraw} HUF</strong></div>
            <div><span>Company liquidity</span><strong>{employeeData.contract.companyLiquidityBalance} HUF</strong></div>
            <div><span>Company payDay</span><strong>Day {employeeData.contract.payDay}</strong></div>
          </div>

          <div className="actions">
            <input value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} type="number" min="1" />
            <button onClick={submitWithdraw}>Request advance</button>
          </div>

          <h3>Requests</h3>
          <ul>
            {employeeData.requests.map((request) => (
              <li key={request.id}>#{request.id} {request.status} | requested {request.requestedAmount} | approved {request.approvedAmount ?? '-'} | fee {request.feeAmount ?? '-'} {request.paymentRef ? `| ${request.paymentRef}` : ''}</li>
            ))}
          </ul>

          <h3>Ledger (hash chain)</h3>
          <ul className="ledger">
            {employeeData.contract.ledgerEntries.map((entry) => (
              <li key={entry.id}>
                <div><strong>{entry.eventType}</strong> @ {entry.oracleTimestamp}</div>
                <div>prevHash: {entry.prevHash.slice(0, 16)}... | hash: {entry.hash.slice(0, 16)}...</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view === 'employer' && employerData && (
        <section className="panel">
          <h2>Employer Dashboard ({employerData.employer.name})</h2>
          <p>Oracle time: <strong>{employerData.oracle.timestamp}</strong></p>
          <p>Company liquidity: <strong>{employerData.company.liquidityBalance} HUF</strong> | payDay: <strong>{employerData.company.payDay}</strong></p>

          <div className="actions">
            <input value={liquidityAmount} onChange={(e) => setLiquidityAmount(e.target.value)} type="number" />
            <button onClick={updateLiquidity}>Adjust liquidity</button>
          </div>

          <h3>Contracts</h3>
          <ul>
            {employerData.contracts.map((contract) => (
              <li key={contract.id}>Employee: {contract.employeeName} | salary {contract.monthlySalary} | available {contract.accrual.availableAmount} | alreadyWithdrawn {contract.alreadyWithdrawn}</li>
            ))}
          </ul>

          <h3>Pending requests</h3>
          <ul>
            {employerData.pendingRequests.map((request) => (
              <li key={request.id}>
                Request #{request.id} ({request.employeeName}) requested {request.requestedAmount}, proposed payout {request.approvedAmount}
                <button onClick={() => approveRequest(request.id)}>Approve + trigger payout</button>
              </li>
            ))}
          </ul>

          <h3>Ledger (hash chain)</h3>
          <ul className="ledger">
            {employerData.ledger.map((entry) => (
              <li key={entry.id}>
                <div><strong>{entry.eventType}</strong> amount {entry.amount}</div>
                <div>prevHash: {entry.prevHash.slice(0, 16)}... | hash: {entry.hash.slice(0, 16)}...</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

export default App;
