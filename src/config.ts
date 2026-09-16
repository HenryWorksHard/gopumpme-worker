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
};
