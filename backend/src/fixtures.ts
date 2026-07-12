// Optional fixture-metadata enrichment from TxLINE.
// The score stream itself only carries fixtureId + stats — no team names or
// crests — so display metadata normally comes from hand-edited upcoming.json.
// TxLINE's docs only promise the scores endpoints, but if this node's token
// can read a fixtures listing we use it: probed at boot and every 6h, and the
// result (or its absence) is reported on /health so nothing is faked.

import { TxlineClient } from "./txline/client.js";

const CANDIDATE_PATHS = [
  "/api/fixtures/upcoming",
  "/api/fixtures",
  "/api/scores/fixtures",
];

export interface FixtureRow {
  fixtureId: number;
  name1?: string;
  name2?: string;
  kickoff?: number;   // unix seconds
  code1?: string;     // ISO country code if the feed provides one
  code2?: string;
  league?: string;
}

export async function probeFixtureFeed(
  txline: TxlineClient,
): Promise<{ source: string; rows: FixtureRow[] } | null> {
  for (const p of CANDIDATE_PATHS) {
    try {
      const { status, data } = await txline.rawGet(p);
      if (status !== 200) continue;
      const rows = normalize(data);
      if (rows.length) {
        console.log(`[fixtures] TxLINE ${p} returned ${rows.length} fixture(s)`);
        return { source: p, rows };
      }
    } catch { /* try the next candidate */ }
  }
  console.log("[fixtures] TxLINE exposes no fixture listing on this token — upcoming.json is the source of truth");
  return null;
}

function normalize(data: unknown): FixtureRow[] {
  const arr: any[] = Array.isArray(data) ? data
    : Array.isArray((data as any)?.fixtures) ? (data as any).fixtures
    : Array.isArray((data as any)?.data) ? (data as any).data
    : [];
  const out: FixtureRow[] = [];
  for (const f of arr) {
    if (!f || typeof f !== "object") continue;
    const id = Number(f.fixtureId ?? f.fixture_id ?? f.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const home = f.homeTeam ?? f.home_team ?? f.home ?? f.team1 ?? f.competitors?.[0];
    const away = f.awayTeam ?? f.away_team ?? f.away ?? f.team2 ?? f.competitors?.[1];
    const nameOf = (t: any) => typeof t === "string" ? t : t?.name ?? t?.teamName ?? undefined;
    const codeOf = (t: any) => typeof t === "object" ? (t?.countryCode ?? t?.country_code ?? t?.code) : undefined;
    out.push({
      fixtureId: id,
      name1: nameOf(home),
      name2: nameOf(away),
      kickoff: toUnixSec(f.kickoff ?? f.kickoffTs ?? f.kickoff_ts ?? f.startTime ?? f.start_time ?? f.date),
      code1: codeOf(home),
      code2: codeOf(away),
      league: nameOf(f.league ?? f.competition),
    });
  }
  return out.filter((r) => r.name1 || r.name2 || r.kickoff);
}

function toUnixSec(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : Math.round(t / 1000);
}
