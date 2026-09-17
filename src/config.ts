function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

export const config = {
  rpcUrl: req("SOLANA_RPC_URL"),
  supabaseUrl: req("SUPABASE_URL"),
  supabaseSecret: req("SUPABASE_SECRET_KEY"),
  walletEncryptionKey: req("WALLET_ENCRYPTION_KEY"),
  opsWalletSecret: process.env.OPS_WALLET_SECRET || "",
  gpmMint: process.env.GPM_MINT || "",
  charityBps: num("CHARITY_BPS", 8000),
  buybackBps: num("BUYBACK_BPS", 2000),
  minClaimSol: num("MIN_CLAIM_SOL", 0.02),
  solFeeBuffer: num("SOL_FEE_BUFFER", 0.01),
  pollSeconds: num("POLL_SECONDS", 300),
  // Payout scheduling: minimum USD in a fund's escrow before a payout is queued
  // for the admin to donate on GoFundMe.
  minPayoutUsd: num("MIN_PAYOUT_USD", 25),
  payoutIntervalSeconds: num("PAYOUT_INTERVAL_SECONDS", 3600),
  gofundmeRefreshSeconds: num("GOFUNDME_REFRESH_SECONDS", 1800),
  // Kraken (crypto -> USD -> your bank). Auto-convert stays OFF until you have
  // run a supervised test - the scheduler still queues payouts without it.
  krakenApiKey: process.env.KRAKEN_API_KEY || "",
  krakenApiSecret: process.env.KRAKEN_API_SECRET || "",
  krakenBankWithdrawKey: process.env.KRAKEN_BANK_WITHDRAW_KEY || "",
  // Your Kraken USDC (Solana) deposit address, copied from Kraken's Funding page.
  // Escrow USDC is swept here when auto-convert is on.
  krakenUsdcDepositAddress: process.env.KRAKEN_USDC_DEPOSIT_ADDRESS || "",
  krakenAutoConvert: (process.env.KRAKEN_AUTO_CONVERT || "").toLowerCase() === "true",
};
