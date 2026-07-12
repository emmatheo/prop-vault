// Settlement keeper. Fully automated:
//   - listens to the score stream (live OR replay — same interface)
//   - tracks game phase per fixture (soccer-feed encoding: F=5 finished,
//     FET=10, FPE=13 also terminal; A=15/C=16/P=19 => void)
//   - on terminal phase: fetch the final-seq Merkle proof from
//     /api/scores/stat-validation and submit our settle instruction
//   - on abandon/cancel/postpone: submit void after the on-chain deadline
//
// Settlement is PERMISSIONLESS on-chain; this keeper is just the first mover.
// If it dies, anyone else can settle with the same public proof. Say that in
// the video — it is the difference between "bot" and "trustless".

import { MarketRegistry } from "./markets.js";
import { ScoreStream, ScoreEvent } from "./txline/stream.js";
import { TxlineClient } from "./txline/client.js";
import { VaultClient } from "./solana/vault.js";

const TERMINAL_PHASES = new Set([5, 10, 13]);      // F, FET, FPE
const VOID_PHASES = new Set([15, 16, 19]);         // A, C, P
const SETTLE_DELAY_MS = 90_000; // let TxLINE's final packets anchor before proving

interface FixtureState { phase?: number; lastSeq?: number; }

export class Keeper {
  private fixtures = new Map<number, FixtureState>();
  private inFlight = new Set<number>();

  constructor(
    private stream: ScoreStream,
    private txline: TxlineClient,
    private vault: VaultClient,
    private registry: MarketRegistry,
  ) {}

  start() {
    this.stream.on("score", (e) => this.onEvent(e).catch((err) =>
      console.error("[keeper] event error:", err.message)));
    console.log("[keeper] running");
  }

  private async onEvent(e: ScoreEvent) {
    // Defensive parsing: exact SSE payload field names to be confirmed on
    // first live connection (day-1 task). We look for common shapes.
    const d = e.data ?? {};
    const fixtureId: number | undefined = d.fixtureId ?? d.fixture_id ?? d.fixture?.id;
    if (!fixtureId) return;

    const st = this.fixtures.get(fixtureId) ?? {};
    if (typeof (d.seq ?? d.sequence) === "number") st.lastSeq = d.seq ?? d.sequence;
    const phase: number | undefined = d.phase ?? d.gamePhase ?? d.phaseId;
    if (typeof phase === "number") st.phase = phase;
    this.fixtures.set(fixtureId, st);

    if (typeof phase !== "number") return;
    const open = this.registry.openMarketsForFixture(fixtureId);
    if (open.length === 0) return;

    if (TERMINAL_PHASES.has(phase)) {
      console.log(`[keeper] fixture ${fixtureId} terminal (phase ${phase}); settling ${open.length} market(s) in ${SETTLE_DELAY_MS / 1000}s`);
      setTimeout(() => void this.settleAll(fixtureId), SETTLE_DELAY_MS);
    } else if (VOID_PHASES.has(phase)) {
      console.log(`[keeper] fixture ${fixtureId} void-phase ${phase}; scheduling voids`);
      for (const m of open) this.registry.markVoidPending(m.spec.marketId);
      // Actual on-chain void is time-gated by the program (void_after_ts);
      // a periodic sweep below handles submission when eligible.
    }
  }

  private async settleAll(fixtureId: number) {
    const st = this.fixtures.get(fixtureId);
    for (const m of this.registry.openMarketsForFixture(fixtureId)) {
      const id = m.spec.marketId;
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      try {
        // Prefer the last streamed seq; fall back to updates search if absent.
        let seq = st?.lastSeq;
        if (seq === undefined) {
          const updates = await this.txline.scoresUpdatesAt(new Date());
          seq = extractLatestSeq(updates, fixtureId);
        }
        if (seq === undefined) throw new Error("no final seq available");

        const proof = await this.txline.statValidation(
          fixtureId, seq, m.spec.statKey, m.spec.statKey2);
        const sig = await this.vault.settle(id, proof);
        const onchain = await this.vault.fetchMarket(id);
        this.registry.markSettled(id, {
          outcomeYes: onchain.outcomeYes ?? onchain.outcome_yes,
          txSig: sig,
          seq,
          proofRoot: proof.eventStatRoot,
          maxTimestamp: proof.summary.updateStats.maxTimestamp,
          settledTs: Number(onchain.settledTs ?? onchain.settled_ts ?? 0),
        });
        console.log(`[keeper] settled market ${id} (${m.spec.question}) tx=${sig}`);
      } catch (err: any) {
        console.error(`[keeper] settle failed for market ${id}: ${err.message} — will retry via sweep`);
        this.inFlight.delete(id);
        return;
      }
      this.inFlight.delete(id);
    }
  }

  /** Call every ~60s: retries missed settlements and submits eligible voids. */
  async sweep() {
    const now = Math.floor(Date.now() / 1000);
    for (const m of this.registry.all()) {
      if (m.status === "open" && now > m.spec.settleAfterTs) {
        const st = this.fixtures.get(m.spec.fixtureId) ?? {};
        if (st.phase === undefined || (!TERMINAL_PHASES.has(st.phase) && !VOID_PHASES.has(st.phase))) {
          // The stream can miss the final whistle (restart, dropped SSE) and
          // then the market sits "open" forever with winners unpaid. Past the
          // scheduled end, ask the REST snapshot where the fixture really is.
          const snap = await this.snapshotState(m.spec.fixtureId);
          if (snap.phase !== undefined) st.phase = snap.phase;
          if (st.lastSeq === undefined && snap.seq !== undefined) st.lastSeq = snap.seq;
          this.fixtures.set(m.spec.fixtureId, st);
        }
        if (st.phase !== undefined && TERMINAL_PHASES.has(st.phase)) {
          await this.settleAll(m.spec.fixtureId);
        } else if (st.phase !== undefined && VOID_PHASES.has(st.phase)) {
          this.registry.markVoidPending(m.spec.marketId);
        }
      }
      if ((m.status === "void-pending" || m.status === "open") && now > m.spec.voidAfterTs) {
        try {
          const sig = await this.vault.void(m.spec.marketId);
          this.registry.markVoided(m.spec.marketId, sig);
          console.log(`[keeper] voided market ${m.spec.marketId} tx=${sig}`);
        } catch (e: any) {
          console.error(`[keeper] void failed ${m.spec.marketId}: ${e.message}`);
        }
      }
    }
  }

  /** Phase + latest seq for a fixture from the REST snapshot, shape-tolerant. */
  private async snapshotState(fixtureId: number): Promise<{ phase?: number; seq?: number }> {
    try {
      const snap: any = await this.txline.scoresSnapshot(fixtureId);
      const out: { phase?: number; seq?: number } = {};
      for (const o of [snap, snap?.data, snap?.summary, snap?.snapshot]) {
        if (!o || typeof o !== "object") continue;
        const ph = o.phase ?? o.gamePhase ?? o.phaseId;
        if (out.phase === undefined && typeof ph === "number") out.phase = ph;
        const sq = o.seq ?? o.sequence ?? o.lastSeq ?? o.latestSeq;
        if (out.seq === undefined && typeof sq === "number") out.seq = sq;
      }
      if (out.phase !== undefined) {
        console.log(`[keeper] snapshot fallback: fixture ${fixtureId} phase=${out.phase} seq=${out.seq ?? "?"}`);
      }
      return out;
    } catch (e: any) {
      console.warn(`[keeper] snapshot fallback failed for ${fixtureId}: ${e.message}`);
      return {};
    }
  }
}

function extractLatestSeq(updates: any, fixtureId: number): number | undefined {
  const rows: any[] = Array.isArray(updates) ? updates : updates?.updates ?? [];
  const mine = rows.filter((r) => (r.fixtureId ?? r.fixture_id) === fixtureId);
  const seqs = mine.map((r) => r.seq ?? r.sequence).filter((s) => typeof s === "number");
  return seqs.length ? Math.max(...seqs) : undefined;
}
