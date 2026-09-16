import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createDecipheriv } from "crypto";
import bs58 from "bs58";
import { config } from "./config";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const LAMPORTS = 1_000_000_000;

export function connection(): Connection {
  return new Connection(config.rpcUrl, "confirmed");
}

// Decrypts a per-fund escrow secret (AES-256-GCM, same format the web app writes).
export function decryptSecret(payload: string): Uint8Array {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const key = Buffer.from(config.walletEncryptionKey, "hex");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]));
}

export function escrowKeypair(encryptedSecret: string): Keypair {
  return Keypair.fromSecretKey(decryptSecret(encryptedSecret));
}

export function opsKeypair(): Keypair {
  if (!config.opsWalletSecret) throw new Error("OPS_WALLET_SECRET not set");
  return Keypair.fromSecretKey(bs58.decode(config.opsWalletSecret));
}
