// Seed the board in one command.  The judge's "20 minutes of manual curl"
// collapses to:  npm run seed
//
// For every fixture in upcoming.json (or a --file you pass) it creates the
// three shipped market templates — home win, total goals over, team corners
// over — against the running backend's /admin/markets endpoint. Idempotency:
// it first reads /markets and skips any (fixtureId, template) already present,
// so re-running after a crash tops up the board instead of duplicating it.
//
//   npm run seed                       # localhost:8787, upcoming.json
//   HOST=https://prop-vault.onrender.com npm run seed
//   npm run seed -- --file live        # seed from /admin/live-fixtures instead
//   npm run seed -- --goals 2.5 --corners 4
//
// ADMIN_KEY is read from the env, else backend/data/admin-key.txt (the file the
// server prints on first boot). No secrets are hard-coded.

import fs from "fs";
import path from "path";

const HOST = (process.env.HOST ?? "http://localhost:8787").replace(/\/$/, "");
const args = process.argv.slice(2);
const argVal = (name: string, def?: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const useLive = args.includes("--file") && argVal("file") === "live";
const goalsLine = Number(argVal("goals", "2")); // "over N goals" => strictly greater, so 2 = over 2 (3+)
const cornersLine = Number(argVal("corners", "4"));
const cornersTeam = Number(argVal("team", "1")) as 1 | 2;

function adminKey(): string {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  const file = path.resolve(process.env.DATA_DIR ?? "data", "admin-key.txt");
  try { return fs.readFileSync(file, "utf8").trim(); }
  catch {
    console.error(`No ADMIN_KEY env var and no ${file}.\n` +
      `Start the backend once (it prints + saves the key), or export ADMIN_KEY.`);
    process.exit(1);
  }
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "x-admin-key": KEY } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

interface Fixture { fixtureId: number; name1?: string; name2?: string; kickoff?: number }

async function loadFixtures(): Promise<Fixture[]> {
  if (useLive) {
    const rows = await getJson(`${HOST}/admin/live-fixtures`);
    return rows.map((r: any) => ({
      fixtureId: Number(r.fixtureId),
      name1: r.fixture?.name1, name2: r.fixture?.name2, kickoff: r.fixture?.kickoff,
    }));
  }
  const f = argVal("file", "upcoming.json")!;
  const raw = JSON.parse(fs.readFileSync(path.resolve(f), "utf8"));
  return raw.map((u: any) => ({
    fixtureId: Number(u.fixtureId), name1: u.name1, name2: u.name2, kickoff: Number(u.kickoff),
  }));
}

const KEY = adminKey();

async function main() {
  const fixtures = (await loadFixtures()).filter((f) => f.fixtureId > 0);
  if (!fixtures.length) { console.error("No fixtures to seed."); process.exit(1); }

  // What's already on the board, so re-runs don't duplicate.
  let existing: any[] = [];
  try { existing = await getJson(`${HOST}/markets`); } catch { /* empty board */ }
  const has = (fixtureId: number, rx: RegExp) =>
    existing.some((m) => m.fixtureId === fixtureId && rx.test(String(m.question)));

  const kickoffOf = (f: Fixture) =>
    f.kickoff && f.kickoff > 0 ? f.kickoff : Math.floor(Date.now() / 1000) + 3600;
  const side = (f: Fixture) => (f.name1 && !/^tbd/i.test(f.name1) ? f.name1 : `Fixture ${f.fixtureId}`);

  let created = 0, skipped = 0, failed = 0;
  for (const f of fixtures) {
    const kickoffTs = kickoffOf(f);
    const home = side(f);
    const plan: Array<{ template: string; label: string; rx: RegExp; extra?: object }> = [
      { template: "homeWin", label: `${home} to win?`, rx: /win|beat/i },
      { template: "goalsOver", label: `Over ${goalsLine} total goals?`, rx: /total goals/i, extra: { n: goalsLine } },
      { template: "cornersOver", label: `Team ${cornersTeam} over ${cornersLine} corners?`, rx: /corners/i, extra: { team: cornersTeam, n: cornersLine } },
    ];
    for (const p of plan) {
      if (has(f.fixtureId, p.rx)) { skipped++; continue; }
      const body = { template: p.template, fixtureId: f.fixtureId, kickoffTs, label: p.label, ...(p.extra ?? {}) };
      try {
        const r = await fetch(`${HOST}/admin/markets`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-key": KEY },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.status);
        created++;
        console.log(`+ ${p.template.padEnd(11)} fx${f.fixtureId} "${p.label}" -> market ${j.marketId}${j.demo ? " (demo)" : ` tx ${String(j.createTx).slice(0, 8)}…`}`);
      } catch (e: any) {
        failed++;
        console.error(`! ${p.template} fx${f.fixtureId}: ${e.message}`);
      }
    }
  }
  console.log(`\nDone. created ${created}, skipped ${skipped} (already present), failed ${failed}.`);
  console.log(`Board: ${HOST}/markets`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
