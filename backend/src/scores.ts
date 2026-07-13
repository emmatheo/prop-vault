// Score + phase extraction from the TxLINE scores feed, in ONE place, tolerant
// of every shape the feed and the REST snapshot use. Two encodings exist:
//
//   1. direct fields:  { homeScore, awayScore, phase }  (and snake_case / nested)
//   2. stat pairs:     [{ key, value, period }]  — the on-chain ScoreStat shape.
//      Goals are stat key 1 (participant1) and key 2 (participant2) at period 0
//      (see markets.ts: homeWinProp uses statKey 1 vs 2). This is what the REST
//      /api/scores/snapshot returns, which the old code never parsed — so ended
//      matches showed no score.
//
// Phase encoding (soccer feed): 5/10/13 = finished (F/FET/FPE); 15/16/19 =
// abandoned/cancelled/postponed => void. Anything else that's in-play = live.

export const TERMINAL_PHASES = new Set([5, 10, 13]);
export const VOID_PHASES = new Set([15, 16, 19]);

export interface FixtureScore {
  home?: number;
  away?: number;
  phase?: number;
  seq?: number;
}

const num = (x: any): number | undefined => {
  if (x === null || x === undefined || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

/** Pull home/away goals, phase and seq out of any snapshot/stream payload. */
export function parseScorePayload(raw: any): FixtureScore {
  const out: FixtureScore = {};
  const set = (k: keyof FixtureScore, v: number | undefined) => {
    if (v !== undefined && out[k] === undefined) out[k] = v;
  };

  // 1) direct/nested scalar fields
  const containers = [raw, raw?.data, raw?.snapshot, raw?.summary, raw?.fixture, raw?.state, raw?.scores];
  for (const o of containers) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    set("home", num(o.homeScore ?? o.home_score ?? o.homeGoals ?? o.home_goals ?? o.score?.home ?? o.goals?.home ?? o.p1 ?? o.participant1Score));
    set("away", num(o.awayScore ?? o.away_score ?? o.awayGoals ?? o.away_goals ?? o.score?.away ?? o.goals?.away ?? o.p2 ?? o.participant2Score));
    set("phase", num(o.phase ?? o.gamePhase ?? o.phaseId ?? o.game_phase ?? o.status));
    set("seq", num(o.seq ?? o.sequence ?? o.lastSeq ?? o.latestSeq ?? o.updateSeq));
  }

  // 2) ScoreStat arrays: goals are key 1 (home/participant1) and 2 (away/p2), period 0
  const arrays = [raw?.stats, raw?.scoreStats, raw?.score_stats, raw?.data?.stats,
    raw?.snapshot?.stats, Array.isArray(raw) ? raw : undefined].filter(Array.isArray) as any[][];
  for (const arr of arrays) {
    for (const s of arr) {
      const key = num(s?.key ?? s?.statKey ?? s?.stat_key);
      const val = num(s?.value ?? s?.val);
      const period = num(s?.period) ?? 0;
      if (period !== 0 || val === undefined) continue;
      if (key === 1) set("home", val);
      if (key === 2) set("away", val);
    }
  }
  return out;
}

export type MatchState = "upcoming" | "live" | "finished" | "void";

/** Classify a fixture for the UI from its phase, scores, kickoff and settlement. */
export function matchState(opts: {
  phase?: number; home?: number; away?: number; kickoff?: number; settled?: boolean; voided?: boolean; nowSec?: number;
}): MatchState {
  const now = opts.nowSec ?? Date.now() / 1000;
  if (opts.voided) return "void";
  if (opts.settled) return "finished";
  if (opts.phase !== undefined) {
    if (TERMINAL_PHASES.has(opts.phase)) return "finished";
    if (VOID_PHASES.has(opts.phase)) return "void";
    return "live"; // any other reported phase means the match is in play
  }
  // no phase from the feed: fall back to kickoff + whether we have a score
  if (opts.home !== undefined || opts.away !== undefined) return "live";
  if (opts.kickoff && now >= opts.kickoff) return "live";
  return "upcoming";
}
