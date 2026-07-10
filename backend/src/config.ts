// All environment wiring in one place. Copy .env.example -> .env and fill in.

import "dotenv/config";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const network = (process.env.NETWORK ?? "devnet") as "devnet" | "mainnet";

const TXLINE = {
  devnet: {
    apiOrigin: "https://txline-dev.txodds.com",
    programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
    txlMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
    rpcUrl: "https://api.devnet.solana.com",
  },
  mainnet: {
    apiOrigin: "https://txline.txodds.com",
    programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    txlMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
}[network];

const dataDir = process.env.DATA_DIR ?? path.resolve("data");

// ADMIN_KEY is optional: without it, generate one on first boot and persist
// it to data/admin-key.txt so the server works with zero .env configuration.
function loadOrCreateAdminKey(): string {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  const file = path.join(dataDir, "admin-key.txt");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const key = crypto.randomBytes(12).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key + "\n");
  console.log(`ADMIN KEY (also saved to ${file}): ${key}`);
  return key;
}

export const CFG = {
  network,
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  keypairPath: process.env.KEYPAIR_PATH ?? path.resolve("keypair.json"),
  adminKey: loadOrCreateAdminKey(),
  replayFile: process.env.REPLAY_FILE || null,
  replaySpeed: Number(process.env.REPLAY_SPEED ?? 1),
  txline: {
    ...TXLINE,
    // Free World Cup tiers: 1 = 60s delay (devnet+mainnet), 12 = realtime (mainnet).
    serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL ?? 1),
    idlPath: process.env.TXORACLE_IDL ?? path.resolve("../idls/txoracle.json"),
  },
  solana: {
    rpcUrl: process.env.RPC_URL ?? TXLINE.rpcUrl,
    // Default: the devnet test-USDC mint created by the CI deploy (DEVNET.md).
    usdcMint: process.env.USDC_MINT ??
      (network === "devnet" ? "FWJiwiotctjZcgqe37sfRRfZh2hqEKZ31syc3GFS4PbU" : ""),
  },
  vault: {
    // Default: the committed IDL copy generated at the deployed program id.
    idlPath: process.env.VAULT_IDL ?? path.resolve("target-idl/prop_vault.json"),
  },
};
