import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { OnlinePumpSdk, PumpSdk, feeSharingConfigPda, type SharingConfig } from "@pump-fun/pump-sdk";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config";
import { connection, escrowKeypair, opsKeypair, USDC_MINT, LAMPORTS } from "./solana";
import { solToUsdc, solToGpm } from "./jupiter";
import { fetchGoFundMe } from "./gofundme";
import { krakenConfigured, krakenBalance } from "./kraken";

const db = createClient(config.supabaseUrl, config.supabaseSecret, {
  auth: { persistSession: false },
});
const USDC_DECIMALS = 6;

function log(...a: unknown[]) {
  console.log(new Date().toISOString(), ...a);
}
async function usdcBalance(owner: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const acc = await getAccount(connection(), ata);
    return Number(acc.amount);
  } catch {
    return 0;
  }
}

// Move SPL tokens owner -> destination (creating the dest ATA if needed).
async function transferToken(
  from: Keypair,
  mint: PublicKey,
  decimals: number,
  to: PublicKey,
  amountRaw: number,
  feePayer: Keypair
) {
  const conn = connection();
  const fromAta = await getAssociatedTokenAddress(mint, from.publicKey);
  const toAta = await getAssociatedTokenAddress(mint, to);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, toAta, to, mint),
    createTransferCheckedInstruction(fromAta, mint, toAta, from.publicKey, amountRaw, decimals)
  );
  const signers = feePayer.publicKey.equals(from.publicKey) ? [from] : [feePayer, from];
  return sendAndConfirmTransaction(conn, tx, signers);
}

// Move native SOL from -> to (feePayer covers the tx fee so an empty `from` works).
async function transferSol(from: Keypair, to: PublicKey, lamports: number, feePayer: Keypair) {
  const conn = connection();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })
  );
  const signers = feePayer.publicKey.equals(from.publicKey) ? [from] : [feePayer, from];
  return sendAndConfirmTransaction(conn, tx, signers);
}

// Record one claim's split to the ledger (shared by the legacy and fee-sharing paths).
async function recordClaim(fund: any, solClaimed: number, charityUsd: number, buybackSol: number, sig: string) {
  await db.from("fee_claims").insert({
    fund_id: fund.id,
    sol_claimed: solClaimed,
    usdc_received: charityUsd,
    buyback_sol: buybackSol,
    tx_signature: sig,
  });
  await db
    .from("funds")
    .update({ raised_usdc: Number(fund.raised_usdc) + charityUsd })
    .eq("id", fund.id);
}

// LEGACY one-time drain: before we hand the creator role to a fee-sharing config,
// claim whatever creator fees already accrued to the escrow's own vault and split
// them the old way, so nothing strands on the escrow's creator vault. No-op for a
// fresh coin (nothing has accrued yet).
async function claimAndSplitLegacy(conn: ReturnType<typeof connection>, online: OnlinePumpSdk, fund: any, escrow: Keypair, ops: Keypair) {
  const escrowPk = escrow.publicKey;
  const vault = await online.getCreatorVaultBalanceBothPrograms(escrowPk).catch(() => null);
  const vaultLamports = vault ? vault.toNumber() : 0;
  if (vaultLamports < config.minClaimSol * LAMPORTS) return;

  const claimIxs = await online.collectCoinCreatorFeeInstructions(escrowPk, ops.publicKey);
  const claimSig = await sendAndConfirmTransaction(conn, new Transaction().add(...claimIxs), [ops, escrow]);
  log(`fund ${fund.slug}: legacy-claimed ~${(vaultLamports / LAMPORTS).toFixed(4)} SOL before migration (${claimSig.slice(0, 8)})`);

  const solBal = await conn.getBalance(escrowPk);
  const swappable = solBal - config.solFeeBuffer * LAMPORTS;
  if (swappable <= 0) return;
  const buybackLamports = Math.floor((swappable * config.buybackBps) / 10000);
  const charityLamports = swappable - buybackLamports;

  let charityUsd = 0;
  if (charityLamports > 0) {
    const { outAmount } = await solToUsdc(conn, escrow, charityLamports);
    charityUsd = outAmount / 10 ** USDC_DECIMALS;
  }
  let buybackSol = 0;
  if (buybackLamports > 0) {
    try {
      await transferSol(escrow, ops.publicKey, buybackLamports, ops);
      buybackSol = buybackLamports / LAMPORTS;
    } catch (e) {
      log(`fund ${fund.slug}: legacy buyback transfer failed`, (e as Error).message);
    }
  }
  await recordClaim(fund, vaultLamports / LAMPORTS, charityUsd, buybackSol, claimSig);
  log(`fund ${fund.slug}: legacy +$${charityUsd.toFixed(2)} to escrow, ${buybackSol.toFixed(4)} SOL to buyback`);
}

// Point a coin's fee-sharing config at the agent (ops) wallet, 100%. pump.fun then
// shows the agent as the creator-rewards recipient. Only the escrow (the config
// admin) can do this; it signs, ops pays gas.
async function routeSharesToOps(conn: ReturnType<typeof connection>, sdk: PumpSdk, mint: PublicKey, escrow: Keypair, ops: Keypair, cfg: SharingConfig): Promise<SharingConfig> {
  const opsShare = cfg.shareholders.length === 1 && cfg.shareholders[0].address.equals(ops.publicKey) && cfg.shareholders[0].shareBps === 10000;
  if (opsShare) return cfg;
  if (cfg.adminRevoked) {
    log(`config ${mint.toBase58().slice(0, 8)} is locked with non-agent shares; leaving as-is`);
    return cfg;
  }
  const updIx = await sdk.updateFeeShares({
    authority: escrow.publicKey,
    mint,
    currentShareholders: cfg.shareholders.map((s) => s.address),
    newShareholders: [{ address: ops.publicKey, shareBps: 10000 }],
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(updIx), [ops, escrow]);
  log(`migrate: routed 100% of ${mint.toBase58().slice(0, 8)} creator fees to the agent wallet (${sig.slice(0, 8)})`);
  const info = await conn.getAccountInfo(feeSharingConfigPda(mint));
  return info ? sdk.decodeSharingConfig(info) : cfg;
}

// Create the pump fee-sharing config for a coin (escrow is the current creator +
// signs), then route 100% to the agent wallet. Creating it replaces the coin's
// on-chain creator with the config PDA - future creator fees accrue to the config
// vault and are paid out to shareholders via distributeCreatorFees.
async function ensureFeeSharing(conn: ReturnType<typeof connection>, sdk: PumpSdk, mint: PublicKey, escrow: Keypair, ops: Keypair): Promise<boolean> {
  const configPda = feeSharingConfigPda(mint);
  const createIx = await sdk.createFeeSharingConfig({ creator: escrow.publicKey, mint, pool: null });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [ops, escrow]);
  log(`migrate: created fee-sharing config for ${mint.toBase58().slice(0, 8)} (${sig.slice(0, 8)})`);
  const info = await conn.getAccountInfo(configPda);
  if (!info) return false;
  await routeSharesToOps(conn, sdk, mint, escrow, ops, sdk.decodeSharingConfig(info));
  return true;
}

// Move any USDC sitting on a fund's escrow to the agent (ops) wallet - legacy
// funds converted their charity leg inside the escrow; under fee sharing the agent
// holds it, and payouts sweep from there. No-op once the escrow is empty.
async function drainEscrowUsdc(conn: ReturnType<typeof connection>, escrow: Keypair, ops: Keypair) {
  const bal = await usdcBalance(escrow.publicKey);
  if (bal <= 0) return;
  await transferToken(escrow, USDC_MINT, USDC_DECIMALS, ops.publicKey, bal, ops);
  log(`drained ${(bal / 10 ** USDC_DECIMALS).toFixed(2)} USDC from escrow ${escrow.publicKey.toBase58().slice(0, 8)} to agent`);
}

// One fund. First sight: drain the escrow vault (legacy) and migrate the coin to a
// fee-sharing config paying the agent wallet. Thereafter: distribute the config's
// accrued creator fees to the agent (permissionless), split 80/20, convert the 80%
// charity leg to USDC (held by the agent) and pool the 20% SOL for the $Fund buyback.
async function processFund(fund: any, ops: Keypair) {
  const conn = connection();
  const online = new OnlinePumpSdk(conn);
  const sdk = new PumpSdk();
  const escrow = escrowKeypair(fund.__key.encrypted_secret);
  const mint = new PublicKey(fund.__mint);
  const configPda = feeSharingConfigPda(mint);

  const cfgInfo = await conn.getAccountInfo(configPda);
  if (!cfgInfo) {
    await claimAndSplitLegacy(conn, online, fund, escrow, ops);
    const ok = await ensureFeeSharing(conn, sdk, mint, escrow, ops);
    if (ok) await drainEscrowUsdc(conn, escrow, ops);
    return; // fees accrued after migration are distributed on the next tick
  }

  const cfg = await routeSharesToOps(conn, sdk, mint, escrow, ops, sdk.decodeSharingConfig(cfgInfo));

  // 1. distributable creator fees now sit on the config's vault
  const vault = await online.getCreatorVaultBalanceBothPrograms(configPda).catch(() => null);
  const vaultLamports = vault ? vault.toNumber() : 0;
  if (vaultLamports < config.minClaimSol * LAMPORTS) return;

  // 2. distribute to shareholders (agent = 100%). Permissionless; ops pays gas.
  const distIx = await sdk.distributeCreatorFees({ mint, sharingConfig: cfg, sharingConfigAddress: configPda });
  let distSig: string;
  try {
    distSig = await sendAndConfirmTransaction(conn, new Transaction().add(distIx), [ops]);
  } catch (e) {
    log(`fund ${fund.slug}: distribute skipped - ${(e as Error).message}`);
    return;
  }
  log(`fund ${fund.slug}: distributed ~${(vaultLamports / LAMPORTS).toFixed(4)} SOL to the agent (${distSig.slice(0, 8)})`);

  // 3. split what the agent just received: 20% pooled for the $Fund buyback (stays
  //    in ops as SOL), 80% converted to USDC (held by the agent for the payout).
  const buybackLamports = Math.floor((vaultLamports * config.buybackBps) / 10000);
  const charityLamports = vaultLamports - buybackLamports;
  let charityUsd = 0;
  if (charityLamports > 0) {
    const { outAmount } = await solToUsdc(conn, ops, charityLamports);
    charityUsd = outAmount / 10 ** USDC_DECIMALS;
  }
  const buybackSol = buybackLamports / LAMPORTS;

  await recordClaim(fund, vaultLamports / LAMPORTS, charityUsd, buybackSol, distSig);
  log(`fund ${fund.slug}: +$${charityUsd.toFixed(2)} agent USDC, ${buybackSol.toFixed(4)} SOL to buyback`);
}

// Schedule GoFundMe payouts. Under fee sharing every cause's charity USDC is held
// by the agent (ops) wallet and tracked per-cause in the DB. For each active fund
// that has accumulated enough, sweep that much USDC from the agent wallet to Kraken
// (crypto -> USD -> your bank happens there) and queue a pending payout for the
// admin to donate on GoFundMe and upload the receipt. GATED: nothing moves until
// KRAKEN_AUTO_CONVERT is enabled (after a supervised test) and a deposit address is
// set - so no real funds move on an untested config.
async function schedulePayouts(ops: Keypair) {
  const { data: funds } = await db
    .from("funds")
    .select("*")
    .eq("status", "active")
    .not("gofundme_url", "is", null);
  for (const fund of funds || []) {
    try {
      const { data: pend } = await db.from("payouts").select("amount_usdc").eq("fund_id", fund.id).eq("status", "pending");
      const pendingSum = (pend || []).reduce((a, p) => a + Number(p.amount_usdc), 0);
      const owed = Number(fund.raised_usdc) - Number(fund.paid_usdc) - pendingSum;
      if (owed < config.minPayoutUsd) continue;

      if (!config.krakenAutoConvert || !config.krakenUsdcDepositAddress) {
        log(`fund ${fund.slug}: $${owed.toFixed(2)} ready, but Kraken auto-convert is off - not scheduling`);
        continue;
      }

      // the cause's USDC lives in the agent wallet (commingled, DB-tracked); sweep
      // this cause's owed share of it to the Kraken deposit address (ops pays gas)
      const bal = await usdcBalance(ops.publicKey);
      const amountRaw = Math.min(bal, Math.round(owed * 10 ** USDC_DECIMALS));
      if (amountRaw <= 0) continue;

      const sig = await transferToken(ops, USDC_MINT, USDC_DECIMALS, new PublicKey(config.krakenUsdcDepositAddress), amountRaw, ops);
      const usd = amountRaw / 10 ** USDC_DECIMALS;
      await db.from("payouts").insert({
        fund_id: fund.id,
        amount_usdc: usd,
        method: "gofundme",
        destination: fund.gofundme_url,
        kraken_ref: sig,
        status: "pending",
        scheduled_for: new Date().toISOString(),
      });
      log(`fund ${fund.slug}: swept $${usd.toFixed(2)} USDC to Kraken, payout queued (${sig.slice(0, 8)})`);
    } catch (e) {
      log(`schedule error ${fund.slug}:`, (e as Error).message);
    }
  }
}

// Refresh cached GoFundMe display data (title/image/goal/raised) for active funds.
async function refreshGoFundMe() {
  const cutoff = new Date(Date.now() - config.gofundmeRefreshSeconds * 1000).toISOString();
  const { data: funds } = await db
    .from("funds")
    .select("id, slug, gofundme_url, gofundme_synced_at")
    .eq("status", "active")
    .not("gofundme_url", "is", null);
  for (const f of funds || []) {
    try {
      if (f.gofundme_synced_at && f.gofundme_synced_at > cutoff) continue;
      const c = await fetchGoFundMe(f.gofundme_url as string);
      if (!c) continue;
      await db.from("funds").update({
        gofundme_title: c.title ?? null,
        gofundme_image: c.image ?? null,
        gofundme_goal: c.goal ?? null,
        gofundme_raised: c.raised ?? null,
        gofundme_synced_at: new Date().toISOString(),
      }).eq("id", f.id);
    } catch (e) {
      log(`gofundme refresh error ${f.slug}:`, (e as Error).message);
    }
  }
}

// Buy back $Fund with the pooled buyback SOL (the 20% split off from each claim)
// and burn it. Buying with SOL directly is a single hop - $Fund trades against SOL.
// The mint comes from platform_config (single source of truth shared with the
// web app), falling back to the GPM_MINT env if set.
async function buybackAndBurn(ops: Keypair) {
  const { data: cfg } = await db.from("platform_config").select("gpm_mint").eq("id", 1).single();
  const gpmMint = ((cfg?.gpm_mint as string) || config.gpmMint || "").trim();
  if (!gpmMint) return;
  const conn = connection();

  // How much buyback SOL has pooled but isn't yet burned: recorded split-offs
  // minus what previous buybacks already spent.
  const { data: pending } = await db.rpc("pending_buyback_sol");
  const pendingLamports = Math.floor(Number(pending || 0) * LAMPORTS);
  if (pendingLamports <= 0) return;

  // Never dip into the gas reserve - the ops wallet also pays for every claim
  // and sweep - so cap the buy at whatever SOL is spare above that reserve.
  const opsBal = await conn.getBalance(ops.publicKey);
  const spendable = Math.min(pendingLamports, opsBal - Math.floor(config.gasReserveSol * LAMPORTS));
  if (spendable < config.minBuybackSol * LAMPORTS) return;

  const gpm = new PublicKey(gpmMint);
  const { outAmount, signature: buySig } = await solToGpm(conn, ops, spendable, gpmMint);
  const mintInfo = await getMint(conn, gpm);
  const ata = await getAssociatedTokenAddress(gpm, ops.publicKey);
  const burnTx = new Transaction().add(
    createBurnCheckedInstruction(ata, gpm, ops.publicKey, BigInt(outAmount), mintInfo.decimals)
  );
  const burnSig = await sendAndConfirmTransaction(conn, burnTx, [ops]);
  await db.from("buybacks").insert({
    sol_spent: spendable / LAMPORTS,
    gpm_burned: outAmount,
    buy_signature: buySig,
    burn_signature: burnSig,
  });
  log(`buyback: spent ${(spendable / LAMPORTS).toFixed(4)} SOL, burned ${outAmount} $Fund (${burnSig.slice(0, 8)})`);
}

async function tick() {
  if (!config.opsWalletSecret) {
    log("OPS_WALLET_SECRET not set — idle. Provide the ops wallet to start claiming.");
    return;
  }
  const ops = opsKeypair();
  const { data: funds } = await db
    .from("funds")
    .select("*, coins!inner(mint, creator_verified), fund_escrow_keys(encrypted_secret)")
    .eq("status", "active")
    .eq("coins.creator_verified", true);

  for (const fund of funds || []) {
    try {
      const key = Array.isArray(fund.fund_escrow_keys) ? fund.fund_escrow_keys[0] : fund.fund_escrow_keys;
      const coin = Array.isArray(fund.coins) ? fund.coins[0] : fund.coins;
      if (!key || !coin?.mint) continue;
      await processFund({ ...fund, __key: key, __mint: coin.mint }, ops);
    } catch (e) {
      log(`fund error ${fund.slug}:`, (e as Error).message);
    }
  }

  const now = Date.now();
  if (now - lastGoFundMeRefresh > config.gofundmeRefreshSeconds * 1000) {
    lastGoFundMeRefresh = now;
    await refreshGoFundMe().catch((e) => log("gofundme refresh error:", (e as Error).message));
  }
  if (now - lastPayoutRun > config.payoutIntervalSeconds * 1000) {
    lastPayoutRun = now;
    await schedulePayouts(ops).catch((e) => log("payout schedule error:", (e as Error).message));
  }
  await buybackAndBurn(ops).catch((e) => log("buyback error:", (e as Error).message));
}

let lastPayoutRun = 0;
let lastGoFundMeRefresh = 0;

// Read-only Kraken auth check (no trade, no transfer) so we can confirm the keys
// work from the logs without exposing any secret.
async function krakenStartupCheck() {
  if (!krakenConfigured()) {
    log("Kraken: not configured (KRAKEN_API_KEY/SECRET unset)");
    return;
  }
  try {
    const bal = await krakenBalance();
    const usd = Number(bal.ZUSD || bal.USD || 0);
    const usdc = Number(bal.USDC || 0);
    log(
      `Kraken: auth OK - USD $${usd.toFixed(2)}, USDC ${usdc.toFixed(2)} | auto-convert ${config.krakenAutoConvert} | deposit ${config.krakenUsdcDepositAddress ? "set" : "UNSET"} | bank key ${config.krakenBankWithdrawKey ? "set" : "UNSET"}`
    );
  } catch (e) {
    log(`Kraken: auth FAILED - ${(e as Error).message}`);
  }
}

async function main() {
  const once = process.argv.includes("--once");
  log(`GoPumpMe worker starting (poll ${config.pollSeconds}s, split ${config.charityBps / 100}/${config.buybackBps / 100})`);
  await krakenStartupCheck();
  do {
    try {
      await tick();
    } catch (e) {
      log("tick error:", (e as Error).message);
    }
    if (!once) await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  } while (!once);
}

main();
