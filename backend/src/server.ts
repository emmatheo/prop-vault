// HTTP API + process entrypoint.
//   GET  /health                 keeper + stream status (judges can hit this)
//   GET  /markets                all markets with pools, odds, status
//   GET  /markets/:id            one market incl. settlement receipt
//   GET  /markets/:id/receipt    the "don't trust, verify" bundle:
//                                settlement tx (explorer link), TxLINE seq,
//                                Merkle root, proof window
//   GET  /live                   SSE relay of the score stream to the frontend
//   POST /admin/markets          create a market from a template
//                                { template: "homeWin"|"cornersOver"|"goalsOver",
//                                  fixtureId, kickoffTs, label, team?, n? }
//   GET  /admin/live-fixtures    fixtures currently emitting updates (seed source)
//   GET  /admin/txline?path=...  authenticated TxLINE passthrough (keys stay server-side)
//   all /admin routes require header  x-admin-key: <data/admin-key.txt>
//
//   seed the whole board in one command:  npm run seed   (backend/scripts/seed-markets.ts)
//
// run:  npm run dev            (live stream, recording on)
//       REPLAY_FILE=data/recordings/scores-2026-07-10.jsonl npm run dev
//                              (same binary, replay mode — for the demo video)

import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { CFG } from "./config.js";
import { TxlineClient } from "./txline/client.js";
import { makeStream, ScoreEvent } from "./txline/stream.js";
import { VaultClient } from "./solana/vault.js";
import { Keeper } from "./keeper.js";
import { MarketRegistry, homeWinProp, teamCornersOverProp, totalGoalsOverProp } from "./markets.js";
import { probeFixtureFeed } from "./fixtures.js";

async function main() {
  // Replay/demo mode replays a recording through the same pipeline and needs
  // no TxLINE credentials or wallet — so the demo video and judges can run the
  // whole app standalone. Live mode still onboards TxLINE as before.
  const txline = new TxlineClient();
  if (CFG.replayFile) {
    console.log(`[demo-mode] replay from ${CFG.replayFile} — TxLINE onboarding skipped (no credentials needed)`);
  } else {
    try { await txline.init(); }
    catch (e: any) { console.warn(`[txline] onboarding failed (${e.message}) — live feed unavailable; set REPLAY_FILE to run the demo without credentials`); }
  }
  let vault: VaultClient | null = null;
  try { vault = new VaultClient(); }
  catch (e: any) { console.warn("[demo-mode] contract client disabled (" + e.message + ") — UI and live data run; staking is off until deploy."); }
  const registry = MarketRegistry.load();

  // Fixture metadata (team names, kickoff) from upcoming.json — same pattern
  // as SHARP. Edit that file as real fixtures/teams are confirmed.
  let fixtureMeta = new Map<number, any>();
  try {
    for (const u of JSON.parse(fs.readFileSync("upcoming.json", "utf8")))
      fixtureMeta.set(Number(u.fixtureId), u);
    console.log(`[fixtures] loaded ${fixtureMeta.size} fixture(s) from upcoming.json`);
  } catch { console.log("[fixtures] no upcoming.json (optional)"); }
  const meta = (f: number) => fixtureMeta.get(f) ?? null;

  // If TxLINE's API exposes a fixtures listing (team names, kickoffs, country
  // codes), merge it over the hand-edited file — the feed wins on names since
  // upcoming.json ships with TBD placeholders. /health reports which source won.
  let fixtureSource = "upcoming.json";
  const stripUndef = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const enrichFixtures = async () => {
    const found = await probeFixtureFeed(txline).catch(() => null);
    if (!found) return;
    fixtureSource = `txline ${found.source}`;
    for (const row of found.rows) {
      fixtureMeta.set(row.fixtureId, { ...fixtureMeta.get(row.fixtureId), ...stripUndef(row) });
    }
  };
  void enrichFixtures();
  setInterval(() => void enrichFixtures(), 6 * 3600_000);
  const stream = makeStream(txline);
  const keeper = vault ? new Keeper(stream, txline, vault, registry) : null;

  let streamStatus = "starting";
  stream.on("status", (s) => { streamStatus = s; console.log(`[stream] ${s}`); });

  // Track which fixtures are currently emitting updates (for /admin/live-fixtures).
  const liveFixtures = new Map<number, { home?: number; away?: number; phase?: number; lastSeen: number }>();
  stream.on("score", (e) => {
    const d = e.data ?? {};
    const f = Number(d.fixtureId ?? d.fixture_id ?? d.fixture?.id);
    if (!f) return;
    const cur = liveFixtures.get(f) ?? { lastSeen: 0 };
    const h = d.homeScore ?? d.home_score ?? d.score?.home;
    const a = d.awayScore ?? d.away_score ?? d.score?.away;
    const ph = d.phase ?? d.gamePhase ?? d.phaseId;
    if (h != null) cur.home = Number(h);
    if (a != null) cur.away = Number(a);
    if (ph != null) cur.phase = Number(ph);
    cur.lastSeen = Date.now();
    liveFixtures.set(f, cur);
  });

  const app = express();
  app.use(cors(), express.json());

  // Serve the built frontend from backend/public — one process, one URL.
  // index.html must revalidate on every load: users kept hitting stale cached
  // scripts after frontend fixes, which looks like "the fix didn't work".
  app.use(express.static("public", {
    setHeaders: (res, p) => { if (p.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache"); },
  }));

  app.get("/health", (_req, res) => res.json({
    ok: true,
    mode: CFG.replayFile ? "replay" : "live",
    contract: vault ? "connected" : "demo-mode (deploy pending)",
    stream: streamStatus,
    network: CFG.network,
    markets: registry.all().length,
    fixtureSource,
  }));

  // Every known fixture (with or without markets) so the UI shows the slate.
  app.get("/fixtures", (_req, res) => res.json([...fixtureMeta.values()]));

  // Wallet holdings: SOL + USDC, so users watch the payout actually land.
  app.get("/balance/:address", async (req, res) => {
    try {
      const { PublicKey, Connection } = await import("@solana/web3.js");
      const spl = await import("@solana/spl-token");
      const owner = new PublicKey(req.params.address);
      const conn = vault ? vault.provider.connection : new Connection(CFG.solana.rpcUrl, "confirmed");
      const sol = (await conn.getBalance(owner)) / 1e9;
      let usdc = 0;
      if (CFG.solana.usdcMint) {
        try {
          const ata = spl.getAssociatedTokenAddressSync(new PublicKey(CFG.solana.usdcMint), owner);
          usdc = Number((await conn.getTokenAccountBalance(ata)).value.uiAmount ?? 0);
        } catch { /* no USDC account yet = 0 */ }
      }
      res.json({ sol, usdc });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // On-chain pool cache: avoids hammering the RPC on every page load.
  const poolCache = new Map<number, { data: any; ts: number }>();
  async function pools(marketId: number) {
    if (!vault) return null;
    const hit = poolCache.get(marketId);
    if (hit && Date.now() - hit.ts < 10_000) return hit.data;
    const data = await vault.fetchPools(marketId);
    poolCache.set(marketId, { data, ts: Date.now() });
    await reconcile(marketId, data); // chain is truth — flip registry if it settled elsewhere
    return data;
  }

  // Best-effort recovery of the settlement tx signature for a market that was
  // settled by someone other than this node, so the receipt still links to it.
  async function recoverSettleTx(marketId: number): Promise<string> {
    try {
      if (!vault) return "";
      const sigs = await vault.provider.connection.getSignaturesForAddress(
        vault.marketPda(marketId), { limit: 1 });
      return sigs[0]?.signature ?? "";
    } catch { return ""; }
  }

  // Reconcile registry status with on-chain state (settled/voided) when the
  // keeper wasn't the settler. Runs at most once per market per transition.
  const reconciling = new Set<number>();
  async function reconcile(marketId: number, data: any) {
    if (!data) return;
    const m = registry.get(marketId);
    if (!m) return;
    const settledOnChain = data.state === 1 && m.status !== "settled";
    const voidedOnChain = data.state === 2 && m.status !== "voided";
    if ((!settledOnChain && !voidedOnChain) || reconciling.has(marketId)) return;
    reconciling.add(marketId);
    try {
      const txSig = await recoverSettleTx(marketId);
      const changed = registry.reconcileFromChain(marketId, {
        state: data.state, outcomeYes: data.outcomeYes, settledTs: data.settledTs, txSig,
      });
      if (changed) console.log(`[reconcile] market ${marketId} -> ${registry.get(marketId)?.status} from on-chain state (settled outside this keeper)`);
    } finally { reconciling.delete(marketId); }
  }

  app.get("/markets", async (_req, res) => {
    const out = await Promise.all(registry.all().map(async (m) => {
      const p = await pools(m.spec.marketId);      // reconciles first
      return { ...publicView(registry.get(m.spec.marketId) ?? m), pools: p, fixture: meta(m.spec.fixtureId) };
    }));
    res.json(out);
  });

  app.get("/markets/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!registry.get(id)) return res.status(404).json({ error: "not found" });
    const p = await pools(id);                      // reconciles first
    const m = registry.get(id)!;
    res.json({ ...publicView(m), pools: p, fixture: meta(m.spec.fixtureId) });
  });

  // Unsigned transactions: server builds, Phantom signs in the browser.
  app.post("/tx/stake", async (req, res) => {
    try {
      const { address, marketId, sideYes, amount } = req.body;
      if (!address || !marketId || typeof sideYes !== "boolean" || !(amount > 0)) {
        return res.status(400).json({ error: "need address, marketId, sideYes, amount > 0" });
      }
      if (!vault) return res.status(503).json({ error: "staking opens when the contract finishes deploying" });
      const m = registry.get(Number(marketId));
      if (!m || m.status !== "open") return res.status(409).json({ error: "market is not open" });
      if (Date.now() / 1000 >= m.spec.lockTs) return res.status(409).json({ error: "market locked at kickoff" });
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await vault.buildStakeTx(new PublicKey(address), Number(marketId), sideYes, Number(amount));
      res.json({ tx });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Fallback for wallets that can sign but not send (no signAndSendTransaction):
  // browser signs, we submit through OUR RPC so wallet network settings never matter.
  app.post("/tx/submit", async (req, res) => {
    try {
      if (!vault) return res.status(503).json({ error: "submitting opens when the contract finishes deploying" });
      const { tx } = req.body;
      if (!tx || typeof tx !== "string") return res.status(400).json({ error: "need tx (base64 signed transaction)" });
      const sig = await vault.submitSignedTx(tx);
      res.json({ ok: true, tx: sig });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/tx/claim", async (req, res) => {
    try {
      const { address, marketId } = req.body;
      if (!vault) return res.status(503).json({ error: "claims open when the contract finishes deploying" });
      if (!address || !marketId) return res.status(400).json({ error: "need address, marketId" });
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await vault.buildClaimTx(new PublicKey(address), Number(marketId));
      res.json({ tx });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // A wallet's positions across all markets, with honest payout math.
  app.get("/positions/:address", async (req, res) => {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      if (!vault) return res.json([]);
      const user = new PublicKey(req.params.address);
      const rows = [];
      for (const m of registry.all()) {
        const pos = await vault.fetchPosition(m.spec.marketId, user);
        if (!pos || (pos.yes === 0 && pos.no === 0)) continue;
        const p = await pools(m.spec.marketId);
        rows.push({
          marketId: m.spec.marketId,
          fixtureId: m.spec.fixtureId,
          question: m.spec.question,
          status: m.status,
          outcome: m.receipt ? (m.receipt.outcomeYes ? "YES" : "NO") : null,
          yes: pos.yes, no: pos.no, claimed: pos.claimed, pools: p,
          lockTs: m.spec.lockTs,
          settleAfterTs: m.spec.settleAfterTs,
          fixture: meta(m.spec.fixtureId),
        });
      }
      res.json(rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/markets/:id/receipt", async (req, res) => {
    const id = Number(req.params.id);
    if (!registry.get(id)) return res.status(404).json({ error: "not found" });
    await pools(id); // reconcile: a market settled by another cranker still yields a receipt
    const m = registry.get(id)!;
    if (!m.receipt) return res.status(409).json({ error: "not settled yet" });
    const r = m.receipt;
    const marketAddr = vault ? vault.marketPda(id).toBase58() : null;
    res.json({
      question: m.spec.question,
      outcome: r.outcomeYes ? "YES" : "NO",
      settlementTx: r.txSig || null,
      settledTs: r.settledTs ?? null,
      explorer: r.txSig
        ? `https://explorer.solana.com/tx/${r.txSig}?cluster=${CFG.network}`
        : (marketAddr ? `https://explorer.solana.com/address/${marketAddr}?cluster=${CFG.network}` : null),
      txlineSeq: r.seq || null,
      merkleEventStatRoot: r.proofRoot || null,
      proofWindowEndsMs: r.maxTimestamp || null,
      external: !!r.external,
      note: r.external
        ? "Settled on-chain by a permissionless cranker other than this node — that is the point: anyone can settle with the same public proof. This node didn't capture the Merkle bundle, but the on-chain market state and settlement transaction are authoritative and verifiable at the link above."
        : "Outcome was proven on-chain via CPI into TxLINE validate_stat against the daily Merkle root. No oracle vote, no dispute window, no trust in this server.",
    });
  });

  // Verified match archive: scans this node's TxLINE recordings for fixtures
  // that reached a terminal phase. Real data only — empty until matches are
  // recorded; that honesty is stated in the UI.
  app.get("/archive", (_req, res) => {
    try {
      const dir = path.join(CFG.dataDir, "recordings");
      const done = new Map<number, any>();
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir).filter((f) => f.startsWith("scores-"))) {
          for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
            if (!line.trim()) continue;
            let e: any; try { e = JSON.parse(line); } catch { continue; }
            const d = e.data ?? {};
            const f = d.fixtureId ?? d.fixture_id; if (!f) continue;
            const r = done.get(f) ?? { fixtureId: f };
            const h = d.homeScore ?? d.home_score ?? d.score?.home;
            const a = d.awayScore ?? d.away_score ?? d.score?.away;
            if (h != null) r.h = Number(h);
            if (a != null) r.a = Number(a);
            const ph = d.phase ?? d.gamePhase ?? d.phaseId;
            if (ph != null && [5, 10, 13].includes(Number(ph))) { r.final = true; r.endedAt = e.receivedAt; }
            done.set(f, r);
          }
        }
      }
      res.json([...done.values()].filter((r) => r.final)
        .map((r) => ({ ...r, fixture: meta(r.fixtureId) }))
        .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0)));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // SSE relay so the frontend never touches TxLINE credentials.
  const sseClients = new Set<express.Response>();
  app.get("/live", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });
  stream.on("score", (e: ScoreEvent) => {
    const payload = `event: score\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of sseClients) c.write(payload);
  });

  // Devnet-only faucet: mints 100 test USDC to any wallet. Judges connect,
  // tap "Get test USDC" in the UI, and can stake within seconds. Our keeper
  // wallet is the mint authority because it created the test mint.
  app.post("/faucet", async (req, res) => {
    try {
      if (!vault) return res.status(503).json({ error: "faucet opens when the contract finishes deploying" });
      if (CFG.network !== "devnet") return res.status(403).json({ error: "faucet is devnet-only" });
      const to = new (await import("@solana/web3.js")).PublicKey(req.body.address);
      const spl = await import("@solana/spl-token");
      const mint = new (await import("@solana/web3.js")).PublicKey(CFG.solana.usdcMint);
      const conn = vault.provider.connection;
      const ata = await spl.getOrCreateAssociatedTokenAccount(conn, vault.payer, mint, to);
      const sig = await spl.mintTo(conn, vault.payer, mint, ata.address, vault.payer, 100_000_000); // 100 USDC
      res.json({ ok: true, tx: sig, amount: 100 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/admin/markets", async (req, res) => {
    try {
      if (req.get("x-admin-key") !== CFG.adminKey) return res.status(401).json({ error: "bad admin key" });
      const { template, fixtureId, kickoffTs, label, team, n } = req.body;
      const id = registry.nextId();
      const spec =
        template === "homeWin" ? homeWinProp(id, fixtureId, kickoffTs, label) :
        template === "cornersOver" ? teamCornersOverProp(id, fixtureId, kickoffTs, team ?? 1, n ?? 5, label) :
        template === "goalsOver" ? totalGoalsOverProp(id, fixtureId, kickoffTs, n ?? 2, label) :
        null;
      if (!spec) return res.status(400).json({ error: "unknown template" });
      if (vault) {
        const tx = await vault.createMarket(spec);
        registry.add(spec, tx);
        return res.json({ marketId: id, createTx: tx });
      }
      registry.add(spec); // demo-mode: registry only; goes on-chain after deploy
      res.json({ marketId: id, demo: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fixtures currently producing live updates on this node's stream — the
  // convenient source of (fixtureId, kickoff) for seeding markets on match day.
  app.get("/admin/live-fixtures", (req, res) => {
    if (req.get("x-admin-key") !== CFG.adminKey) return res.status(401).json({ error: "bad admin key" });
    res.json([...liveFixtures.entries()]
      .map(([fixtureId, v]) => ({ fixtureId, ...v, fixture: meta(fixtureId) }))
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)));
  });

  // Authenticated TxLINE passthrough: proxy an arbitrary /api path using this
  // node's credentials, so operators can inspect the feed without leaking keys.
  app.get("/admin/txline", async (req, res) => {
    if (req.get("x-admin-key") !== CFG.adminKey) return res.status(401).json({ error: "bad admin key" });
    const apiPath = String(req.query.path ?? "");
    if (!apiPath.startsWith("/api/")) return res.status(400).json({ error: "path must start with /api/" });
    try {
      const r = await txline.rawGet(apiPath);
      res.status(r.status).json(r.data);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // SPA fallback: any non-API route serves the app shell.
  app.get(/^\/(?!markets|live|health|admin).*/, (_req, res) =>
    res.sendFile("index.html", { root: "public", headers: { "Cache-Control": "no-cache" } },
      (err) => err && res.status(404).end()));

  app.listen(CFG.port, () => console.log(`[api] listening on :${CFG.port}`));
  await stream.start();
  if (keeper) { keeper.start(); setInterval(() => void keeper.sweep(), 60_000); }
}

function publicView(m: ReturnType<MarketRegistry["all"]>[number]) {
  return {
    marketId: m.spec.marketId,
    fixtureId: m.spec.fixtureId,
    question: m.spec.question,
    lockTs: m.spec.lockTs,
    settleAfterTs: m.spec.settleAfterTs,
    status: m.status,
    outcome: m.receipt ? (m.receipt.outcomeYes ? "YES" : "NO") : null,
    settledTs: m.receipt?.settledTs ?? null,
    receiptAvailable: !!m.receipt,
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
