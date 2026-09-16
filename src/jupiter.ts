import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { USDC_MINT } from "./solana";

const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";

type Quote = { outAmount: string; [k: string]: unknown };

async function getQuote(inputMint: string, outputMint: string, amount: number, slippageBps = 100): Promise<Quote> {
  const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status})`);
  return res.json();
}

// Swaps `amountRaw` of inputMint into outputMint from `owner`'s wallet.
// Returns the output amount (raw) and the tx signature.
export async function swap(
  conn: Connection,
  owner: Keypair,
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps = 100
): Promise<{ outAmount: number; signature: string }> {
  const quote = await getQuote(inputMint, outputMint, amountRaw, slippageBps);
  const res = await fetch(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed (${res.status})`);
  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([owner]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await conn.confirmTransaction(signature, "confirmed");
  return { outAmount: Number(quote.outAmount), signature };
}

export function solToUsdc(conn: Connection, owner: Keypair, lamports: number) {
  return swap(conn, owner, SOL_MINT, USDC_MINT.toBase58(), lamports);
}

export function usdcToGpm(conn: Connection, owner: Keypair, usdcRaw: number, gpmMint: string) {
  return swap(conn, owner, USDC_MINT.toBase58(), gpmMint, usdcRaw);
}
