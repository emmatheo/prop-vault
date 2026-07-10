// Client wrappers for our prop_vault program.
// The interesting part is buildSettleTx: it converts a TxLINE stat-validation
// JSON bundle into the exact arg shapes the on-chain CPI expects, derives the
// daily_scores_roots PDA (seed: "daily_scores_roots" + u16-LE epochDay — per
// docs example), and attaches a 1.4M CU budget because validate_stat is heavy.

import * as anchor from "@coral-xyz/anchor";
// Node ESM cannot named-import BN from anchor's CJS bundle; take it off the
// namespace object instead.
const { BN } = anchor;
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import { CFG } from "../config.js";
import { StatValidation, ProofNodeJson } from "../txline/client.js";

export interface PropSpec {
  marketId: number;
  fixtureId: number;
  statKey: number;        // soccer-feed keys: 1/2 goals, 3-6 cards, 7/8 corners
  statKey2?: number;
  period?: number;        // ScoreStat.period (0 = full match)
  op?: "subtract" | "add";
  threshold: number;
  cmp: "greaterThan" | "lessThan";
  lockTs: number;         // unix seconds — kickoff
  settleAfterTs: number;  // unix seconds — scheduled end + buffer (e.g. kickoff + 2h15m)
  voidAfterTs: number;    // unix seconds — e.g. kickoff + 48h
  question: string;       // <= 64 bytes utf8
}

export class VaultClient {
  program: anchor.Program;
  provider: anchor.AnchorProvider;
  payer: Keypair;

  constructor() {
    this.payer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(CFG.keypairPath, "utf8"))));
    const connection = new Connection(CFG.solana.rpcUrl, "confirmed");
    this.provider = new anchor.AnchorProvider(
      connection, new anchor.Wallet(this.payer), { commitment: "confirmed" });
    const idl = JSON.parse(fs.readFileSync(CFG.vault.idlPath, "utf8"));
    this.program = new anchor.Program(idl, this.provider);
  }

  marketPda(marketId: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), new BN(marketId).toArrayLike(Buffer, "le", 8)],
      this.program.programId)[0];
  }

  positionPda(market: PublicKey, user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
      this.program.programId)[0];
  }

  async createMarket(spec: PropSpec): Promise<string> {
    const question = Buffer.alloc(64);
    question.write(spec.question.slice(0, 64), "utf8");
    return this.program.methods
      .createMarket(
        new BN(spec.marketId), new BN(spec.fixtureId),
        spec.statKey, spec.statKey2 ?? null,
        spec.op === "add" ? 2 : spec.op === "subtract" ? 1 : 0,
        spec.threshold,          // i32 in program (TraderPredicate.threshold)
        spec.period ?? 0,        // i32
        spec.cmp === "greaterThan" ? 0 : 1,
        new BN(spec.lockTs), new BN(spec.settleAfterTs), new BN(spec.voidAfterTs),
        Array.from(question))
      .accounts({
        market: this.marketPda(spec.marketId),
        usdcMint: new PublicKey(CFG.solana.usdcMint),
        authority: this.payer.publicKey,
      })
      .rpc();
  }

  async stake(marketId: number, sideYes: boolean, amountUsdc: number, user = this.payer): Promise<string> {
    const market = this.marketPda(marketId);
    const userUsdc = getAssociatedTokenAddressSync(
      new PublicKey(CFG.solana.usdcMint), user.publicKey);
    return this.program.methods
      .stake(sideYes, new BN(Math.round(amountUsdc * 1e6)))
      .accounts({ market, position: this.positionPda(market, user.publicKey), userUsdc, user: user.publicKey })
      .signers(user === this.payer ? [] : [user])
      .rpc();
  }

  /** Convert TxLINE validation JSON -> on-chain settle instruction and send. */
  async settle(marketId: number, v: StatValidation): Promise<string> {
    const targetTs = v.summary.updateStats.minTimestamp; // ms, per docs example
    const epochDay = Math.floor(targetTs / 86_400_000);
    const [dailyScoresRoots] = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
      new PublicKey(CFG.txline.programId));

    // Shapes follow the verified txoracle IDL v1.5.2 (ScoresBatchSummary / StatTerm).
    const fixtureSummary = {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
    };
    const toStatTerm = (statToProve: any, proof: ProofNodeJson[]) => ({
      statToProve: {
        key: Number(statToProve.key),
        value: Number(statToProve.value),
        period: Number(statToProve.period ?? 0),
      },
      eventStatRoot: toBytes32(v.eventStatRoot),
      statProof: toProofNodes(proof),
    });
    const statA = toStatTerm(v.statToProve, v.statProof);
    const statB = v.statToProve2 ? toStatTerm(v.statToProve2, v.statProof2!) : null;

    return this.program.methods
      .settle(new BN(targetTs), fixtureSummary,
        toProofNodes(v.subTreeProof), toProofNodes(v.mainTreeProof), statA, statB)
      .accounts({
        market: this.marketPda(marketId),
        dailyScoresMerkleRoots: dailyScoresRoots,
        txoracleProgram: new PublicKey(CFG.txline.programId),
        cranker: this.payer.publicKey,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .rpc();
  }

  async void(marketId: number): Promise<string> {
    return this.program.methods.void()
      .accounts({ market: this.marketPda(marketId), cranker: this.payer.publicKey })
      .rpc();
  }

  async claim(marketId: number, user = this.payer): Promise<string> {
    const market = this.marketPda(marketId);
    const userUsdc = getAssociatedTokenAddressSync(
      new PublicKey(CFG.solana.usdcMint), user.publicKey);
    return this.program.methods.claim()
      .accounts({ market, position: this.positionPda(market, user.publicKey), userUsdc, user: user.publicKey })
      .signers(user === this.payer ? [] : [user])
      .rpc();
  }

  async fetchMarket(marketId: number): Promise<any> {
    return (this.program.account as any).market.fetch(this.marketPda(marketId));
  }

  // ---- frontend support: unsigned txs (Phantom signs in the browser) ----

  private async toUnsignedBase64(tx: anchor.web3.Transaction, feePayer: PublicKey): Promise<string> {
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await this.provider.connection.getLatestBlockhash()).blockhash;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  }

  async buildStakeTx(user: PublicKey, marketId: number, sideYes: boolean, amountUsdc: number): Promise<string> {
    const market = this.marketPda(marketId);
    const userUsdc = getAssociatedTokenAddressSync(new PublicKey(CFG.solana.usdcMint), user);
    const tx = await this.program.methods
      .stake(sideYes, new BN(Math.round(amountUsdc * 1e6)))
      .accounts({ market, position: this.positionPda(market, user), userUsdc, user })
      .transaction();
    return this.toUnsignedBase64(tx, user);
  }

  async buildClaimTx(user: PublicKey, marketId: number): Promise<string> {
    const market = this.marketPda(marketId);
    const userUsdc = getAssociatedTokenAddressSync(new PublicKey(CFG.solana.usdcMint), user);
    const tx = await this.program.methods
      .claim()
      .accounts({ market, position: this.positionPda(market, user), userUsdc, user })
      .transaction();
    return this.toUnsignedBase64(tx, user);
  }

  /** On-chain pool sizes + state for one market (USDC display units). */
  async fetchPools(marketId: number): Promise<{ yesPool: number; noPool: number; state: number; outcomeYes: boolean; settledTs: number } | null> {
    try {
      const m = await this.fetchMarket(marketId);
      return {
        yesPool: Number(m.yesPool ?? m.yes_pool) / 1e6,
        noPool: Number(m.noPool ?? m.no_pool) / 1e6,
        state: Number(m.state),
        outcomeYes: Boolean(m.outcomeYes ?? m.outcome_yes),
        settledTs: Number(m.settledTs ?? m.settled_ts ?? 0),
      };
    } catch { return null; }
  }

  /** A wallet's position in one market, or null if none. */
  async fetchPosition(marketId: number, user: PublicKey): Promise<{ yes: number; no: number; claimed: boolean } | null> {
    try {
      const p = await (this.program.account as any).position.fetch(
        this.positionPda(this.marketPda(marketId), user));
      return {
        yes: Number(p.yesAmount ?? p.yes_amount) / 1e6,
        no: Number(p.noAmount ?? p.no_amount) / 1e6,
        claimed: Boolean(p.claimed),
      };
    } catch { return null; }
  }
}

// ---- shape helpers (mirror docs' toBytes32 / toProofNodes) ----

export function toBytes32(value: string | number[] | Uint8Array): number[] {
  const bytes = Array.isArray(value) ? Uint8Array.from(value)
    : value instanceof Uint8Array ? value
    : value.startsWith("0x") ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return Array.from(bytes);
}

export function toProofNodes(nodes: ProofNodeJson[]) {
  return nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));
}
