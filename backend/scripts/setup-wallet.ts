// Creates backend/keypair.json and funds it with devnet SOL — no Solana CLI needed.
// Run from the backend folder:  npx tsx scripts/setup-wallet.ts

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const KEYPAIR = path.resolve("keypair.json");

async function main() {
  let kp: Keypair;
  if (fs.existsSync(KEYPAIR)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR, "utf8"))));
    console.log("Existing wallet found.");
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(KEYPAIR, JSON.stringify(Array.from(kp.secretKey)));
    console.log("New wallet created and saved to keypair.json");
  }
  console.log("Address:", kp.publicKey.toBase58());

  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const balance = await conn.getBalance(kp.publicKey);
  console.log("Devnet balance:", balance / LAMPORTS_PER_SOL, "SOL");

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.log("Requesting devnet airdrop...");
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      console.log("Airdrop OK. New balance:", (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL, "SOL");
    } catch (e: any) {
      console.log("Airdrop failed (devnet rate limits are common):", e.message);
      console.log("No problem — go to https://faucet.solana.com , paste your address above,");
      console.log("pick DEVNET, request SOL, then re-run this script to confirm the balance.");
    }
  } else {
    console.log("Balance is enough. You're set.");
  }
}
main();
