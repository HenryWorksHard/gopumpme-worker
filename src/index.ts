import {
  Keypair,
  PublicKey,
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
import { solToUsdc, usdcToGpm } from "./jupiter";

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

// One fund: claim accrued creator fees, swap to USDC, split 80/20, and pay out
// if verified + over threshold.
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

  // 3. swap the escrow's SOL (minus a fee buffer) to USDC
  const solBal = await conn.getBalance(escrowPk);
  const swappable = solBal - config.solFeeBuffer * LAMPORTS;
  if (swappable <= 0) return;
  const { outAmount: usdcOut } = await solToUsdc(conn, escrow, swappable);

  // 4. split: 20% -> ops (buyback treasury), 80% stays in escrow for the charity
  const buybackUsdc = Math.floor((usdcOut * config.buybackBps) / 10000);
  const charityUsdc = usdcOut - buybackUsdc;
  if (buybackUsdc > 0) {
    await transferToken(escrow, USDC_MINT, USDC_DECIMALS, ops.publicKey, buybackUsdc, escrow).catch((e) =>
      log(`fund ${fund.slug}: buyback transfer failed`, (e as Error).message)
    );
  }

  const charityUsd = charityUsdc / 10 ** USDC_DECIMALS;
  // 5. ledger
  await db.from("fee_claims").insert({
    fund_id: fund.id,
    sol_claimed: vaultLamports / LAMPORTS,
    usdc_received: charityUsd,
    buyback_usdc: buybackUsdc / 10 ** USDC_DECIMALS,
    tx_signature: claimSig,
  });
  await db
    .from("funds")
    .update({ raised_usdc: Number(fund.raised_usdc) + charityUsd })
    .eq("id", fund.id);
  log(`fund ${fund.slug}: +$${charityUsd.toFixed(2)} to escrow, $${(buybackUsdc / 1e6).toFixed(2)} to buyback`);
}

// Pay out verified funds whose escrow balance has passed the threshold (crypto
// now; fiat is recorded pending for the offramp partner).
async function processPayouts(ops: Keypair) {
  const { data: funds } = await db
    .from("funds")
    .select("*, fund_escrow_keys(encrypted_secret)")
    .eq("status", "active")
    .eq("owner_verified", true);
  for (const fund of funds || []) {
    try {
      const owed = Number(fund.raised_usdc) - Number(fund.paid_usdc);
      if (owed < Number(fund.next_threshold_usdc)) continue;
      if (!fund.payout_destination) continue;

      if (fund.payout_method === "fiat") {
        await db.from("payouts").insert({
          fund_id: fund.id,
          amount_usdc: owed,
          method: "fiat",
          destination: fund.payout_destination,
          status: "pending",
        });
        await db.from("funds").update({ paid_usdc: Number(fund.paid_usdc) + owed }).eq("id", fund.id);
        log(`fund ${fund.slug}: $${owed.toFixed(2)} queued for fiat payout`);
        continue;
      }

      // crypto: send escrow USDC to the charity wallet
      const key = Array.isArray(fund.fund_escrow_keys) ? fund.fund_escrow_keys[0] : fund.fund_escrow_keys;
      const escrow = escrowKeypair(key.encrypted_secret);
      const bal = await usdcBalance(escrow.publicKey);
      const amountRaw = Math.min(bal, Math.round(owed * 10 ** USDC_DECIMALS));
      if (amountRaw <= 0) continue;
      const sig = await transferToken(escrow, USDC_MINT, USDC_DECIMALS, new PublicKey(fund.payout_destination), amountRaw, escrow);
      await db.from("payouts").insert({
        fund_id: fund.id,
        amount_usdc: amountRaw / 10 ** USDC_DECIMALS,
        method: "crypto",
        destination: fund.payout_destination,
        tx_signature: sig,
        status: "sent",
      });
      await db.from("funds").update({ paid_usdc: Number(fund.paid_usdc) + amountRaw / 10 ** USDC_DECIMALS }).eq("id", fund.id);
      log(`fund ${fund.slug}: paid $${(amountRaw / 1e6).toFixed(2)} to charity (${sig.slice(0, 8)})`);
    } catch (e) {
      log(`payout error ${fund.slug}:`, (e as Error).message);
    }
  }
}

// Buy back $GPM with the ops wallet's accumulated USDC and burn it.
// The mint comes from platform_config (single source of truth shared with the
// web app), falling back to the GPM_MINT env if set.
async function buybackAndBurn(ops: Keypair) {
  const { data: cfg } = await db.from("platform_config").select("gpm_mint").eq("id", 1).single();
  const gpmMint = ((cfg?.gpm_mint as string) || config.gpmMint || "").trim();
  if (!gpmMint) return;
  const conn = connection();
  const usdc = await usdcBalance(ops.publicKey);
  if (usdc < 1 * 10 ** USDC_DECIMALS) return; // wait for at least ~$1
  const gpm = new PublicKey(gpmMint);
  const { outAmount, signature: buySig } = await usdcToGpm(conn, ops, usdc, gpmMint);
  const mintInfo = await getMint(conn, gpm);
  const ata = await getAssociatedTokenAddress(gpm, ops.publicKey);
  const burnTx = new Transaction().add(
    createBurnCheckedInstruction(ata, gpm, ops.publicKey, BigInt(outAmount), mintInfo.decimals)
  );
  const burnSig = await sendAndConfirmTransaction(conn, burnTx, [ops]);
  await db.from("buybacks").insert({
    usdc_spent: usdc / 10 ** USDC_DECIMALS,
    gpm_burned: outAmount,
    buy_signature: buySig,
    burn_signature: burnSig,
  });
  log(`buyback: spent $${(usdc / 1e6).toFixed(2)}, burned ${outAmount} $GPM (${burnSig.slice(0, 8)})`);
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
  await processPayouts(ops);
  await buybackAndBurn(ops).catch((e) => log("buyback error:", (e as Error).message));
}

async function main() {
  const once = process.argv.includes("--once");
  log(`GoPumpMe worker starting (poll ${config.pollSeconds}s, split ${config.charityBps / 100}/${config.buybackBps / 100})`);
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
