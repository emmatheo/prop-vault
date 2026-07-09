// Off-chain registry mapping on-chain markets to display metadata + receipts.
// Persisted to a JSON file; the chain remains the source of truth for money.

import fs from "fs";
import path from "path";
import { CFG } from "./config.js";
import { PropSpec } from "./solana/vault.js";

export type MarketStatus = "open" | "settled" | "voided" | "void-pending";

export interface Receipt {
  outcomeYes: boolean;
  txSig: string;          // the settlement transaction — the on-chain receipt
  seq: number;            // TxLINE update sequence proven
  proofRoot: string;      // eventStatRoot from the Merkle bundle
  maxTimestamp: number;   // proof window end (ms)
  settledTs?: number;     // on-chain settlement time (unix sec) — real, not staged
}

export interface MarketRecord {
  spec: PropSpec;
  status: MarketStatus;
  receipt?: Receipt;
  voidTx?: string;
  createTx?: string;
}

const FILE = () => path.join(CFG.dataDir, "markets.json");

export class MarketRegistry {
  private markets = new Map<number, MarketRecord>();

  static load(): MarketRegistry {
    const r = new MarketRegistry();
    if (fs.existsSync(FILE())) {
      for (const m of JSON.parse(fs.readFileSync(FILE(), "utf8")) as MarketRecord[]) {
        r.markets.set(m.spec.marketId, m);
      }
    }
    return r;
  }

  private save() {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(this.all(), null, 2));
  }

  add(spec: PropSpec, createTx?: string) {
    this.markets.set(spec.marketId, { spec, status: "open", createTx });
    this.save();
  }

  all(): MarketRecord[] { return [...this.markets.values()]; }
  get(id: number) { return this.markets.get(id); }
  openMarketsForFixture(fixtureId: number): MarketRecord[] {
    return this.all().filter((m) => m.spec.fixtureId === fixtureId && m.status === "open");
  }
  markSettled(id: number, receipt: Receipt) {
    const m = this.markets.get(id); if (!m) return;
    m.status = "settled"; m.receipt = receipt; this.save();
  }
  markVoidPending(id: number) {
    const m = this.markets.get(id); if (!m) return;
    if (m.status === "open") { m.status = "void-pending"; this.save(); }
  }
  markVoided(id: number, txSig: string) {
    const m = this.markets.get(id); if (!m) return;
    m.status = "voided"; m.voidTx = txSig; this.save();
  }
  nextId(): number {
    return this.all().reduce((mx, m) => Math.max(mx, m.spec.marketId), 0) + 1;
  }
}

// ---- prop templates: the ONLY three we ship (scope discipline) ----

/** "Will {home} beat {away}?"  goals_P1 - goals_P2 > 0 */
export function homeWinProp(marketId: number, fixtureId: number, kickoffTs: number, label: string): PropSpec {
  return base(marketId, fixtureId, kickoffTs, label, {
    statKey: 1, statKey2: 2, op: "subtract", threshold: 0, cmp: "greaterThan",
  });
}

/** "Over {n} total corners for {team}?"  corners_Pi > n   (single-stat: no operator risk) */
export function teamCornersOverProp(marketId: number, fixtureId: number, kickoffTs: number, team: 1 | 2, n: number, label: string): PropSpec {
  return base(marketId, fixtureId, kickoffTs, label, {
    statKey: team === 1 ? 7 : 8, threshold: n, cmp: "greaterThan",
  });
}

/** "Over {n} total goals?"  goals_P1 + goals_P2 > n
 *  DEPENDS on the `add` operator existing in the txoracle IDL. Verify day 1;
 *  if absent, do not create these — the other two templates carry the demo. */
export function totalGoalsOverProp(marketId: number, fixtureId: number, kickoffTs: number, n: number, label: string): PropSpec {
  return base(marketId, fixtureId, kickoffTs, label, {
    statKey: 1, statKey2: 2, op: "add", threshold: n, cmp: "greaterThan",
  });
}

function base(marketId: number, fixtureId: number, kickoffTs: number, question: string,
  pred: Pick<PropSpec, "statKey" | "statKey2" | "op" | "threshold" | "cmp">): PropSpec {
  return {
    marketId, fixtureId, question,
    period: 0, // full match; per-period props are a post-hackathon extension
    lockTs: kickoffTs,
    settleAfterTs: kickoffTs + (2 * 3600 + 15 * 60), // 90' + HT + stoppage buffer
    voidAfterTs: kickoffTs + 48 * 3600,
    ...pred,
  };
}
