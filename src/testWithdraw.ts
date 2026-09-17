// One-off bank-send test, run manually by the operator (NOT by the loop).
// Withdraws a small USD amount from Kraken to the configured bank withdrawal key,
// exercising the exact code path the worker uses. Run it yourself:
//   railway run npm run test:withdraw -- 10
import { config } from "./config";
import { krakenConfigured, krakenBalance, krakenWithdrawUsd } from "./kraken";

async function main() {
  const amount = process.argv[2];
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    console.error("usage: npm run test:withdraw -- <amountUSD>   (e.g. 10)");
    process.exit(1);
  }
  if (!krakenConfigured()) {
    console.error("Kraken is not configured (KRAKEN_API_KEY/SECRET missing).");
    process.exit(1);
  }
  if (!config.krakenBankWithdrawKey) {
    console.error("KRAKEN_BANK_WITHDRAW_KEY is not set.");
    process.exit(1);
  }
  const bal = await krakenBalance();
  const usd = Number(bal.ZUSD || bal.USD || 0);
  console.log(`Kraken USD balance: $${usd.toFixed(2)}`);
  if (usd < Number(amount)) {
    console.error(`Not enough USD to withdraw $${amount}.`);
    process.exit(1);
  }
  console.log(`Withdrawing $${amount} to bank key "${config.krakenBankWithdrawKey}"...`);
  const refid = await krakenWithdrawUsd(String(amount));
  console.log(`Withdrawal submitted. Kraken refid: ${refid || "(none returned)"}`);
  console.log("Check Kraken -> Funding -> Withdraw history to confirm it reaches your bank.");
}

main().catch((e) => {
  console.error("Withdraw test failed:", (e as Error).message);
  process.exit(1);
});
