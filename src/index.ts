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
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
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

// One fund: claim accrued creator fees, split the raw SOL 80/20, convert the 80%
// charity leg to USDC (held in escrow), and pool the 20% SOL for the $Fund buyback.
async function processFund(fund: any, ops: Keypair) {
  const conn = connection();
  const online = new OnlinePumpSdk(conn);
  const escrow = escrowKeypair(fund.__key.encrypted_secret);
  const escrowPk = escrow.publicKey;

  // 1. how much is claimable across both vaults
  const vault = await online.getCreatorVaultBalanceBothPrograms(escrowPk).catch(() => null);
  const vaultLamports = vault ? vault.toNumber() : 0;
  if (vaultLamports < config.minClaimSol * LAMPORTS) return;

  // 2. claim (ops wallet pays the fee so an empty escrow still works)
  const claimIxs = await online.collectCoinCreatorFeeInstructions(escrowPk, ops.publicKey);
  const claimTx = new Transaction().add(...claimIxs);
  const claimSig = await sendAndConfirmTransaction(conn, claimTx, [ops, escrow]);
  log(`fund ${fund.slug}: claimed ~${(vaultLamports / LAMPORTS).toFixed(4)} SOL (${claimSig.slice(0, 8)})`);

  // 3. split the raw SOL FIRST (minus a fee buffer): 20% for the $Fund buyback,
  //    80% for the charity. The split has to happen in SOL, before any USDC
  //    conversion, so the buyback leg can buy $Fund directly with SOL (one hop)
  //    instead of paying a needless SOL -> USDC -> $Fund round trip.
  const solBal = await conn.getBalance(escrowPk);
  const swappable = solBal - config.solFeeBuffer * LAMPORTS;
  if (swappable <= 0) return;
  const buybackLamports = Math.floor((swappable * config.buybackBps) / 10000);
  const charityLamports = swappable - buybackLamports;

  // 4a. charity 80%: SOL -> USDC, kept in escrow (later swept to Kraken -> bank)
  let charityUsd = 0;
  if (charityLamports > 0) {
    const { outAmount: usdcOut } = await solToUsdc(conn, escrow, charityLamports);
    charityUsd = usdcOut / 10 ** USDC_DECIMALS;
  }

  // 4b. buyback 20%: move the SOL to the ops wallet, where it pools until the
  //     buyback+burn step swaps it straight to $Fund. Ops pays the transfer fee.
  let buybackSol = 0;
  if (buybackLamports > 0) {
    try {
      await transferSol(escrow, ops.publicKey, buybackLamports, ops);
      buybackSol = buybackLamports / LAMPORTS;
    } catch (e) {
      log(`fund ${fund.slug}: buyback SOL transfer failed`, (e as Error).message);
    }
  }

  // 5. ledger
  await db.from("fee_claims").insert({
    fund_id: fund.id,
    sol_claimed: vaultLamports / LAMPORTS,
    usdc_received: charityUsd,
    buyback_sol: buybackSol,
    tx_signature: claimSig,
  });
  await db
    .from("funds")
    .update({ raised_usdc: Number(fund.raised_usdc) + charityUsd })
    .eq("id", fund.id);
  log(`fund ${fund.slug}: +$${charityUsd.toFixed(2)} to escrow, ${buybackSol.toFixed(4)} SOL to buyback`);
}

// Schedule GoFundMe payouts. For each active fund whose escrow has accumulated
// enough, sweep the cause's USDC to Kraken (crypto -> USD -> your bank happens
// there) and queue a pending payout for the admin to donate on GoFundMe and
// upload the receipt. GATED: nothing moves until KRAKEN_AUTO_CONVERT is enabled
// (after a supervised test) and a deposit address is set - so no real funds move
// on an untested config.
async function schedulePayouts(ops: Keypair) {
  const { data: funds } = await db
    .from("funds")
    .select("*, fund_escrow_keys(encrypted_secret)")
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

      const key = Array.isArray(fund.fund_escrow_keys) ? fund.fund_escrow_keys[0] : fund.fund_escrow_keys;
      if (!key) continue;
      const escrow = escrowKeypair(key.encrypted_secret);
      const bal = await usdcBalance(escrow.publicKey);
      const amountRaw = Math.min(bal, Math.round(owed * 10 ** USDC_DECIMALS));
      if (amountRaw <= 0) continue;

      // sweep the cause's USDC to the Kraken deposit address (ops pays gas)
      const sig = await transferToken(escrow, USDC_MINT, USDC_DECIMALS, new PublicKey(config.krakenUsdcDepositAddress), amountRaw, ops);
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
    .select("*, coins!inner(creator_verified), fund_escrow_keys(encrypted_secret)")
    .eq("status", "active")
    .eq("coins.creator_verified", true);

  for (const fund of funds || []) {
    try {
      const key = Array.isArray(fund.fund_escrow_keys) ? fund.fund_escrow_keys[0] : fund.fund_escrow_keys;
      if (!key) continue;
      await processFund({ ...fund, __key: key }, ops);
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
