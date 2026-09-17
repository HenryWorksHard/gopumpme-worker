import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { USDC_MINT } from "./solana";

// Jupiter's free "Swap API" (the old quote-api.jup.ag/v6 host was retired).
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";

type Quote = { outAmount: string; [k: string]: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The free lite-api rate-limits hard, and the worker now fires many swaps per
// tick (a charity leg per coin + the buyback), so retry 429/5xx with backoff.
async function jup(url: string, init?: RequestInit, tries = 5): Promise<any> {
  let lastErr: unknown = new Error("Jupiter request failed");
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Jupiter ${res.status} (rate limited/unavailable)`);
        await sleep(500 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Jupiter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 140)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<Quote> {
  return jup(`${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
}

// Swaps `amountRaw` of inputMint into outputMint from `owner`'s wallet. Sends with
// a real priority fee and re-broadcasts until the signature confirms (or 60s), so
// it lands even when the RPC / network is congested. Returns the quote's expected
// out amount and the signature; callers that need the exact received amount should
// read the token account after this resolves.
export async function swap(
  conn: Connection,
  owner: Keypair,
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps = 100
): Promise<{ outAmount: number; signature: string }> {
  const quote = await getQuote(inputMint, outputMint, amountRaw, slippageBps);
  const built = await jup(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: "veryHigh" } },
    }),
  });
  if (!built.swapTransaction) throw new Error(`Jupiter returned no swapTransaction: ${JSON.stringify(built).slice(0, 140)}`);

  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
  tx.sign([owner]);
  const raw = tx.serialize();

  const signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const st = await conn.getSignatureStatuses([signature]).catch(() => null);
    const s = st?.value?.[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      if (s.err) throw new Error(`swap failed on-chain: ${JSON.stringify(s.err)}`);
      return { outAmount: Number(quote.outAmount), signature };
    }
    // re-broadcast (same blockhash) to survive drops under congestion
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(() => {});
  }
  throw new Error(`swap not confirmed in 60s (${signature})`);
}

export function solToUsdc(conn: Connection, owner: Keypair, lamports: number) {
  return swap(conn, owner, SOL_MINT, USDC_MINT.toBase58(), lamports);
}

export function usdcToGpm(conn: Connection, owner: Keypair, usdcRaw: number, gpmMint: string) {
  return swap(conn, owner, USDC_MINT.toBase58(), gpmMint, usdcRaw);
}

// Buy $Donate directly with SOL (the 20% buyback leg). One hop against SOL. A wider
// slippage than the charity leg because $Donate is a fresh, volatile coin.
export function solToGpm(conn: Connection, owner: Keypair, lamports: number, gpmMint: string) {
  return swap(conn, owner, SOL_MINT, gpmMint, lamports, 300);
}
