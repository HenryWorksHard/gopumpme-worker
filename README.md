# GoPumpMe Fee Worker

Open fee-routing for [GoPumpMe](https://gopumpmecoin.fun) — the charity launchpad where every coin's trading fees pay a real cause.

This service is intentionally public so anyone can verify exactly how money moves. It never holds custody beyond the moments it is executing a transfer, and every action it takes is written to a public on-chain ledger you can audit on the fund's page.

## What it does

Every few minutes, for each launched or registered coin:

1. **Claim** — collects the coin's accrued pump.fun creator fees (bonding-curve *and* PumpSwap AMM vaults) into that fund's on-chain escrow. The fund creator pays nothing; the ops wallet covers the claim fee.
2. **Swap** — converts the claimed SOL into **USDC** so amounts are stable dollars.
3. **Split** — **80% stays in the fund escrow** for the charity, **20% buys back and burns $GPM**.
4. **Pay out** — once a verified charity's escrow passes its threshold, USDC is sent to the charity (crypto now; fiat-to-bank via our payment partner).
5. **Burn** — the 20% is used to buy $GPM on the open market and permanently burn it.

```
pump.fun creator fees
        │  claim (both vaults)
        ▼
   fund escrow ──swap──► USDC
        │
        ├─ 80% ─► charity  (USDC wallet, or fiat to bank)
        └─ 20% ─► buy $GPM ─► burn
```

## Fee routing is locked on-chain

Each fund gets its own escrow address, set as the coin's creator / fee recipient at launch (or handed over and revoked when registering an existing coin). It cannot be redirected. This worker only ever *executes* the split above.

## Run it

```bash
cp .env.example .env   # fill in the values
npm install
npm run build
npm start
```

Deployed on [Railway](https://railway.app) as an always-on service. Not affiliated with pump.fun.
