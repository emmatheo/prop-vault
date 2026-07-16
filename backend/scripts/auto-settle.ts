// One command → one real settlement. Run this against your DEPLOYED backend and
// walk away. It watches the live TxLINE feed, opens a market on the first real
// fixture that's actually playing, optionally places a guest stake so there's a
// position, then waits for the keeper to settle it by on-chain proof and prints
// the receipt.
//
//   HOST=https://<your-host> ADMIN_KEY=<key> npm run autosettle
//   HOST=... ADMIN_KEY=... npm run autosettle -- --stake 5     # also place a guest stake
//   HOST=... ADMIN_KEY=... npm run autosettle -- --fixture 18218149   # target a known id
//
// No keypair needed locally — the deployed server signs everything. ADMIN_KEY
// is read from the env, else backend/data/admin-key.txt (only useful on the
// server itself). Everything here is plain HTTP against the endpoints the app
// already exposes.

import fs from "fs";
import path from "path";

const HOST = (process.env.HOST ?? "http://localhost:8787").replace(/\/$/, "");
const args = process.argv.slice(2);
const argVal = (n: string, d?: string) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STAKE = Number(argVal("stake", "0"));            // 0 = don't stake, just settle
const WANT_FIXTURE = Number(argVal("fixture", "0"));   // 0 = auto-pick from live feed
const TIMEOUT_S = Number(argVal("timeout", "5400"));   // 90 min: kickoff→full time→proof
const TEMPLATE = argVal("template", "homeWin")!;

const TERMINAL = new Set([5, 10, 13]);
const PLACEHOLDER = new Set([990001, 990002]); // upcoming.json TBD fixtures — never in the feed

function adminKey(): string {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return fs.readFileSync(path.resolve(process.env.DATA_DIR ?? "data", "admin-key.txt"), "utf8").trim(); }
  catch {
    console.error("Set ADMIN_KEY (find it on the server at data/admin-key.txt, or in the boot log).");
    process.exit(1);
  }
}
const KEY = adminKey();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = { "content-type": "application/json", "x-admin-key": KEY };

async function jget(p: string) {
  const r = await fetch(HOST + p, { headers: { "x-admin-key": KEY } });
  if (!r.ok) throw new Error(`GET ${p} → ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}
async function jpost(p: string, body: any) {
  const r = await fetch(HOST + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}

async function preflight() {
  const h = await jget("/health");
  console.log(`[host] ${HOST} — contract=${h.contract} network=${h.network} stream=${h.stream}`);
  if (String(h.contract).includes("demo")) {
    console.error("Backend is in demo mode (no keypair) — it can't sign settlements. Set KEYPAIR_JSON and redeploy.");
    process.exit(1);
  }
  return h;
}

/** Find a real fixture that is live (has a phase, not yet terminal) or already
 *  streaming a score. Skips the upcoming.json placeholders. */
async function pickLiveFixture(): Promise<{ fixtureId: number; kickoff?: number } | null> {
  if (WANT_FIXTURE) return { fixtureId: WANT_FIXTURE };
  const rows: any[] = await jget("/admin/live-fixtures").catch(() => []);
  const live = rows.filter((r) => {
    const f = Number(r.fixtureId);
    if (!f || PLACEHOLDER.has(f)) return false;
    const ph = r.phase ?? r.score?.phase;
    const started = r.score?.state === "live" || (ph != null && !TERMINAL.has(Number(ph)));
    const hasScore = r.home != null || r.away != null || r.score?.home != null;
    return started || hasScore;
  });
  // prefer the most recently updated
  live.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return live[0] ? { fixtureId: Number(live[0].fixtureId), kickoff: live[0].fixture?.kickoff } : null;
}

async function ensureMarket(fixtureId: number, kickoff?: number): Promise<number> {
  const markets: any[] = await jget("/markets").catch(() => []);
  const existing = markets.find((m) => m.fixtureId === fixtureId && /win|beat/i.test(m.question));
  if (existing) { console.log(`[market] reusing ${existing.marketId} for fixture ${fixtureId}`); return existing.marketId; }
  const kickoffTs = kickoff && kickoff > 0 ? kickoff : Math.floor(Date.now() / 1000); // already live → settle-eligible soon
  const r = await jpost("/admin/markets", { template: TEMPLATE, fixtureId, kickoffTs, label: "Home to win?" });
  console.log(`[market] created ${r.marketId} for fixture ${fixtureId}${r.createTx ? ` (tx ${String(r.createTx).slice(0, 8)}…)` : ""}`);
  return r.marketId;
}

async function maybeStake(marketId: number) {
  if (!(STAKE > 0)) return;
  try {
    const s = await jpost("/guest/session", {});
    console.log(`[guest] ${s.address.slice(0, 6)}… funded (${s.usdc} USDC)`);
    const r = await jpost("/guest/stake", { guestId: s.guestId, marketId, sideYes: true, amount: STAKE });
    console.log(`[guest] staked ${STAKE} YES — tx ${String(r.tx).slice(0, 8)}…`);
  } catch (e: any) { console.warn(`[guest] stake skipped: ${e.message}`); }
}

async function waitForSettle(marketId: number) {
  console.log(`[watch] waiting for on-chain settlement (up to ${Math.round(TIMEOUT_S / 60)} min)…`);
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(15_000);
    let m: any; try { m = await jget(`/markets/${marketId}`); } catch { continue; }
    const line = `status=${m.status} score=${m.score?.home ?? "–"}:${m.score?.away ?? "–"} phase=${m.score?.phase ?? "?"}`;
    if (line !== last) { console.log(`  ${new Date().toLocaleTimeString()} ${line}`); last = line; }
    if (m.status === "settled") return "settled";
    if (m.status === "voided") return "voided";
  }
  return "timeout";
}

async function main() {
  await preflight();
  let target = await pickLiveFixture();
  if (!target) {
    console.log("[watch] no live fixture on the feed yet — polling every 30s. Start me during a match.");
    while (!target) { await sleep(30_000); target = await pickLiveFixture(); }
  }
  console.log(`[watch] target fixture ${target.fixtureId}`);
  const marketId = await ensureMarket(target.fixtureId, target.kickoff);
  await maybeStake(marketId);
  const outcome = await waitForSettle(marketId);

  if (outcome === "settled") {
    const rc = await jget(`/markets/${marketId}/receipt`).catch(() => null);
    console.log(`\n✅ SETTLED BY PROOF.`);
    if (rc) {
      console.log(`   Outcome: ${rc.outcome}`);
      if (rc.settlementTx) console.log(`   Settlement tx: ${rc.explorer}`);
      if (rc.merkleEventStatRoot) console.log(`   Merkle root: ${rc.merkleEventStatRoot}`);
      if (rc.txlineSeq) console.log(`   TxLINE seq: ${rc.txlineSeq}`);
    }
    console.log(`   Receipt: ${HOST}/markets/${marketId}/receipt`);
  } else if (outcome === "voided") {
    console.log(`\n⚠️  Market VOIDED (match abandoned/postponed, or no proof available) — stakes refunded.`);
  } else {
    console.log(`\n⏱️  Timed out. Re-run with --fixture ${target.fixtureId} after full time to resume the watch.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
