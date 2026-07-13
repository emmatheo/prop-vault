// Dry-run the whole money path against your live devnet deployment, so match
// day is a rehearsal you have already done — not a first attempt on camera.
// This is the judge's "one real settlement" proven end to end:
//
//   two wallets stake opposite sides  ->  the match ends  ->  the keeper
//   settles by on-chain proof  ->  the winner claims  ->  USDC lands.
//
// It never fabricates a settlement: it stakes, then WAITS for the real keeper
// (or any permissionless cranker) to settle the market on-chain, then claims.
// Point it at a market whose fixture is about to finish and let it watch.
//
//   cd backend
//   npm run rehearse -- --market <marketId>            # 5 USDC each side
//   npm run rehearse -- --market <id> --amount 10 --timeout 2400
//   npm run rehearse -- --market <id> --skip-stake     # already staked; just watch+claim
//
// Needs backend/keypair.json (the deploy wallet = USDC mint authority) exactly
// like the server. Two throwaway wallets are generated once and cached in
// data/rehearsal-*.json so re-runs reuse them. Devnet only.

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { CFG } from "../src/config.js";
import { VaultClient } from "../src/solana/vault.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes("--" + n);
const val = (n: string, d?: string) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const MARKET = Number(val("market", "0"));
const AMOUNT = Number(val("amount", "5"));
const TIMEOUT_S = Number(val("timeout", "1800"));
const SKIP_STAKE = flag("skip-stake");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = new Connection(CFG.solana.rpcUrl, "confirmed");
const usdcMint = new PublicKey(CFG.solana.usdcMint);

function loadOrMakeWallet(name: string): Keypair {
  const p = path.resolve(CFG.dataDir, `rehearsal-${name}.json`);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  const kp = Keypair.generate();
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  new rehearsal wallet ${name}: ${kp.publicKey.toBase58()} (saved ${p})`);
  return kp;
}

async function ensureSol(kp: Keypair, who: string) {
  if ((await conn.getBalance(kp.publicKey)) >= 0.05 * LAMPORTS_PER_SOL) return;
  console.log(`  airdropping SOL to ${who}…`);
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } catch (e: any) {
    console.log(`  airdrop failed (${e.message}). Fund ${kp.publicKey.toBase58()} at https://faucet.solana.com (devnet), then re-run.`);
    process.exit(1);
  }
}

async function usdcBalance(owner: PublicKey): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(usdcMint, owner);
    return Number((await conn.getTokenAccountBalance(ata)).value.uiAmount ?? 0);
  } catch { return 0; }
}

/** Mint test USDC to a wallet using the deploy wallet (the mint authority). */
async function fundUsdc(payer: Keypair, to: PublicKey, amount: number) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, usdcMint, to);
  await mintTo(conn, payer, usdcMint, ata.address, payer, Math.round(amount * 1e6));
}

function statusOf(m: any): string {
  const s = Number(m.state ?? m.status ?? 0);
  return ["open", "settled", "voided", "void-pending"][s] ?? `state:${s}`;
}

async function main() {
  if (!MARKET) { console.error("Pass --market <marketId>. Find ids at GET /markets."); process.exit(1); }
  if (CFG.network !== "devnet") { console.error("Rehearsal is devnet-only."); process.exit(1); }

  let vault: VaultClient;
  try { vault = new VaultClient(); }
  catch (e: any) { console.error(`Contract client unavailable (${e.message}). This needs backend/keypair.json + a deployed program.`); process.exit(1); }

  console.log(`\n=== Prop Vault settlement rehearsal — market ${MARKET} ===`);
  let market: any;
  try { market = await vault.fetchMarket(MARKET); }
  catch { console.error(`Market ${MARKET} not found on-chain. Create/seed it first (npm run seed).`); process.exit(1); }
  console.log(`Market status: ${statusOf(market)}`);

  const alice = loadOrMakeWallet("a"), bob = loadOrMakeWallet("b");

  if (!SKIP_STAKE) {
    if (statusOf(market) !== "open") {
      console.log(`Market is ${statusOf(market)}, not open — skipping staking, will watch + claim.`);
    } else {
      console.log(`\n[1/4] Funding two wallets (SOL + ${AMOUNT} test USDC each)…`);
      await ensureSol(alice, "A"); await ensureSol(bob, "B");
      await fundUsdc(vault.payer, alice.publicKey, AMOUNT + 1);
      await fundUsdc(vault.payer, bob.publicKey, AMOUNT + 1);
      console.log(`  A USDC=${await usdcBalance(alice.publicKey)}  B USDC=${await usdcBalance(bob.publicKey)}`);

      console.log(`\n[2/4] Staking opposite sides (${AMOUNT} USDC each)…`);
      const yTx = await vault.stake(MARKET, true, AMOUNT, alice);
      console.log(`  A staked YES: ${yTx}`);
      const nTx = await vault.stake(MARKET, false, AMOUNT, bob);
      console.log(`  B staked NO:  ${nTx}`);
      const pools = await vault.fetchPools(MARKET);
      console.log(`  pools now: YES ${pools?.yesPool} / NO ${pools?.noPool} USDC`);
    }
  }

  console.log(`\n[3/4] Waiting for on-chain settlement (keeper or any cranker), up to ${TIMEOUT_S}s…`);
  console.log(`  The match must reach full time; settlement is permissionless — this only WATCHES.`);
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let final: any = market, settled = false, voided = false;
  while (Date.now() < deadline) {
    await sleep(15_000);
    try { final = await vault.fetchMarket(MARKET); } catch { continue; }
    const st = statusOf(final);
    process.stdout.write(`  ${new Date().toLocaleTimeString()} status=${st}\r`);
    if (st === "settled") { settled = true; break; }
    if (st === "voided") { voided = true; break; }
  }
  console.log();

  if (!settled && !voided) {
    console.log(`\nTimed out — market still ${statusOf(final)}. The fixture likely hasn't finished.`);
    console.log(`Re-run with --skip-stake after full time to resume from the watch step.`);
    return;
  }

  console.log(`\n[4/4] ${settled ? "Settled" : "Voided"} on-chain. Claiming…`);
  const outcomeYes = Boolean(final.outcomeYes ?? final.outcome_yes);
  const winner = voided ? null : (outcomeYes ? { kp: alice, side: "YES" } : { kp: bob, side: "NO" });

  const claimFor = async (kp: Keypair, label: string) => {
    const before = await usdcBalance(kp.publicKey);
    try {
      const sig = await vault.claim(MARKET, kp);
      const after = await usdcBalance(kp.publicKey);
      console.log(`  ${label} claim ${sig}`);
      console.log(`  ${label} USDC ${before} -> ${after}  (+${(after - before).toFixed(2)})`);
    } catch (e: any) { console.log(`  ${label} claim: ${e.message}`); }
  };

  if (voided) { await claimFor(alice, "A refund"); await claimFor(bob, "B refund"); }
  else if (winner) {
    console.log(`  Outcome: ${outcomeYes ? "YES" : "NO"} won — ${winner.side} wallet collects.`);
    await claimFor(winner.kp, `Winner (${winner.side})`);
  }

  console.log(`\nDone. Receipt: GET /markets/${MARKET}/receipt`);
  console.log(`Explorer (market): https://explorer.solana.com/address/${vault.marketPda(MARKET).toBase58()}?cluster=devnet`);
}

main().catch((e) => { console.error(e); process.exit(1); });
