import crypto from "crypto";
import { config } from "./config";

// Minimal signed Kraken REST client. Used to (optionally) sell the escrow's USDC
// for USD and withdraw it to the linked bank. Deposits of USDC are made on-chain
// to the address in KRAKEN_USDC_DEPOSIT_ADDRESS (no API needed for that leg).

const API = "https://api.kraken.com";

export function krakenConfigured(): boolean {
  return !!(config.krakenApiKey && config.krakenApiSecret);
}

function sign(path: string, postdata: string, nonce: string): string {
  const secret = Buffer.from(config.krakenApiSecret, "base64");
  const sha256 = crypto.createHash("sha256").update(nonce + postdata).digest();
  return crypto
    .createHmac("sha512", secret)
    .update(Buffer.concat([Buffer.from(path, "utf8"), sha256]))
    .digest("base64");
}

async function priv(method: string, params: Record<string, string> = {}): Promise<any> {
  const path = `/0/private/${method}`;
  const nonce = (Date.now() * 1000).toString();
  const postdata = new URLSearchParams({ nonce, ...params }).toString();
  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "API-Key": config.krakenApiKey,
      "API-Sign": sign(path, postdata, nonce),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postdata,
  });
  const json = (await res.json()) as { error?: string[]; result?: any };
  if (json.error && json.error.length) throw new Error("Kraken: " + json.error.join("; "));
  return json.result;
}

// Balances keyed by Kraken asset code (e.g. USDC, ZUSD).
export async function krakenBalance(): Promise<Record<string, string>> {
  return priv("Balance");
}

// Market-sell USDC for USD. Returns the order txid.
export async function krakenSellUsdcForUsd(volume: string): Promise<string> {
  const r = await priv("AddOrder", { pair: "USDCUSD", type: "sell", ordertype: "market", volume });
  return r?.txid?.[0] || "";
}

// Withdraw USD to the pre-configured bank withdrawal key. Returns the refid.
export async function krakenWithdrawUsd(amount: string): Promise<string> {
  const r = await priv("Withdraw", { asset: "ZUSD", key: config.krakenBankWithdrawKey, amount });
  return r?.refid || "";
}
