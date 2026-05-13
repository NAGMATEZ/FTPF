# PayFlow EWA MVP (React + Node.js + SQLite)

This repository now includes a runnable MVP webapp for EWA/payflow:

- **Employee UI**: daily accrual, available withdrawal, request advance, ledger view
- **Employer UI**: liquidity management, pending request approval, payout trigger, ledger view
- **Simulated blockchain ledger**: hash-chained ledger entries (`prevHash` + `hash`)
- **Simulated time oracle**: trusted oracle timestamp endpoint
- **WorkContract model fields**:
  - `employerId`
  - `employeeId`
  - `monthlySalary`
  - `payDay` (company-level)
  - `accrualPerDay`
  - `alreadyWithdrawn`
  - `feeRate` (default 3%)
  - `minWithdraw` (default 100 HUF)
  - `companyLiquidityBalance`
  - `ledgerEntries`
- **Qvik/AFR simulation**: payment requests are logged and marked with simulated refs

## Project structure

- `/server` – Express API + SQLite persistence + seed data
- `/client` – React UI (Vite)
- Existing Solidity and HTML files remain intact.

## Local setup

```bash
npm install
npm --prefix server install
npm --prefix client install
```

## Run in development

Run both server and client:

```bash
npm run dev
```

Or separately:

```bash
npm run dev:server
npm run dev:client
```

- Server: `http://localhost:3001`
- Client: `http://localhost:5173`

## Demo users (seed)

- Employer: ID `1`
- Employee: ID `2`
- Seed contract: monthly salary `450000`, payDay `10`, fee `3%`, min withdraw `100`, initial liquidity `500000`

## API highlights

- `GET /api/time` – oracle timestamp and company payDay
- `GET /api/employee/2/dashboard` – employee data + contract + accrual + ledger
- `POST /api/employee/2/withdraw` – request advance
- `GET /api/employer/1/dashboard` – employer data + requests + ledger
- `POST /api/employer/1/liquidity` – adjust company liquidity
- `POST /api/employer/1/requests/:requestId/approve` – approve + trigger payout (simulated Qvik/AFR)

## Business rules implemented

- Daily accrual only
- Employee can request up to earned amount minus `alreadyWithdrawn`
- Minimum withdrawal of `100`
- Liquidity check enforced; request is capped/rejected if company liquidity is insufficient
- Employer approval triggers simulated payout and updates ledger/liquidity/withdrawn totals
