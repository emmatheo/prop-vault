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
//
// run:  npm run dev            (live stream, recording on)
//       REPLAY_FILE=data/recordings/scores-2026-07-10.jsonl npm run dev
//                              (same binary, replay mode — for the demo video)

import express from "express";
import cors from "cors";
import { CFG } from "./config.js";
import { TxlineClient } from "./txline/client.js";
import { makeStream, ScoreEvent } from "./txline/stream.js";
import { VaultClient } from "./solana/vault.js";
import { Keeper } from "./keeper.js";
import { MarketRegistry, homeWinProp, teamCornersOverProp, totalGoalsOverProp } from "./markets.js";

async function main() {
  const txline = await new TxlineClient().init();
  const vault = new VaultClient();
  const registry = MarketRegistry.load();
  const stream = makeStream(txline);
  const keeper = new Keeper(stream, txline, vault, registry);

  let streamStatus = "starting";
  stream.on("status", (s) => { streamStatus = s; console.log(`[stream] ${s}`); });

  const app = express();
  app.use(cors(), express.json());

  // Serve the built frontend from backend/public — one process, one URL.
  // Build the frontend (vite build / next export) and copy its output here.
  app.use(express.static("public"));

  app.get("/health", (_req, res) => res.json({
    ok: true,
    mode: CFG.replayFile ? "replay" : "live",
    stream: streamStatus,
    network: CFG.network,
    markets: registry.all().length,
  }));

  // On-chain pool cache: avoids hammering the RPC on every page load.
  const poolCache = new Map<number, { data: any; ts: number }>();
  async function pools(marketId: number) {
    const hit = poolCache.get(marketId);
    if (hit && Date.now() - hit.ts < 10_000) return hit.data;
    const data = await vault.fetchPools(marketId);
    poolCache.set(marketId, { data, ts: Date.now() });
    return data;
  }

  app.get("/markets", async (_req, res) => {
    const out = await Promise.all(registry.all().map(async (m) => ({
      ...publicView(m),
      pools: await pools(m.spec.marketId),
    })));
    res.json(out);
  });

  app.get("/markets/:id", async (req, res) => {
    const m = registry.get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: "not found" });
    res.json({ ...publicView(m), pools: await pools(m.spec.marketId) });
  });

  // Unsigned transactions: server builds, Phantom signs in the browser.
  app.post("/tx/stake", async (req, res) => {
    try {
      const { address, marketId, sideYes, amount } = req.body;
      if (!address || !marketId || typeof sideYes !== "boolean" || !(amount > 0)) {
        return res.status(400).json({ error: "need address, marketId, sideYes, amount > 0" });
      }
      const m = registry.get(Number(marketId));
      if (!m || m.status !== "open") return res.status(409).json({ error: "market is not open" });
      if (Date.now() / 1000 >= m.spec.lockTs) return res.status(409).json({ error: "market locked at kickoff" });
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await vault.buildStakeTx(new PublicKey(address), Number(marketId), sideYes, Number(amount));
      res.json({ tx });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/tx/claim", async (req, res) => {
    try {
      const { address, marketId } = req.body;
      if (!address || !marketId) return res.status(400).json({ error: "need address, marketId" });
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await vault.buildClaimTx(new PublicKey(address), Number(marketId));
      res.json({ tx });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Browser signs, we send: routes the raw tx to OUR devnet RPC so the
  // user's wallet network setting can never swallow a transaction.
  app.post("/tx/submit", async (req, res) => {
    try {
      const { signedTx } = req.body;
      if (!signedTx) return res.status(400).json({ error: "need signedTx (base64)" });
      const sig = await vault.submitSignedTx(String(signedTx));
      res.json({ signature: sig });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // A wallet's positions across all markets, with honest payout math.
  app.get("/positions/:address", async (req, res) => {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const user = new PublicKey(req.params.address);
      const rows = [];
      for (const m of registry.all()) {
        const pos = await vault.fetchPosition(m.spec.marketId, user);
        if (!pos || (pos.yes === 0 && pos.no === 0)) continue;
        const p = await pools(m.spec.marketId);
        rows.push({
          marketId: m.spec.marketId,
          question: m.spec.question,
          status: m.status,
          outcome: m.receipt ? (m.receipt.outcomeYes ? "YES" : "NO") : null,
          yes: pos.yes, no: pos.no, claimed: pos.claimed, pools: p,
        });
      }
      res.json(rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/markets/:id/receipt", (req, res) => {
    const m = registry.get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: "not found" });
    if (!m.receipt) return res.status(409).json({ error: "not settled yet" });
    res.json({
      question: m.spec.question,
      outcome: m.receipt.outcomeYes ? "YES" : "NO",
      settlementTx: m.receipt.txSig,
      settledTs: m.receipt.settledTs ?? null,
      explorer: `https://explorer.solana.com/tx/${m.receipt.txSig}?cluster=${CFG.network}`,
      txlineSeq: m.receipt.seq,
      merkleEventStatRoot: m.receipt.proofRoot,
      proofWindowEndsMs: m.receipt.maxTimestamp,
      note: "Outcome was proven on-chain via CPI into TxLINE validate_stat against the daily Merkle root. No oracle vote, no dispute window, no trust in this server.",
    });
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

  // List fixtureIds TxLINE is currently reporting: scans the last N 5-minute
  // update buckets (default 24 = two hours). A fixture only appears here once
  // its match is being played, so use it at/after kickoff to grab the id.
  app.get("/admin/live-fixtures", async (req, res) => {
    try {
      if (req.get("x-admin-key") !== CFG.adminKey) return res.status(401).json({ error: "bad admin key" });
      const buckets = Math.min(Number(req.query.buckets ?? 24), 100);
      const seen = new Map<number, { updates: number; lastSeen: number }>();
      for (let i = 0; i < buckets; i++) {
        const when = new Date(Date.now() - i * 5 * 60_000);
        try {
          const data: any = await txline.scoresUpdatesAt(when);
          const list: any[] = Array.isArray(data) ? data : data?.fixtures ?? data?.summaries ?? [];
          for (const f of list) {
            const id = Number(f.fixtureId ?? f.fixture_id ?? f.id);
            if (!id) continue;
            const cur = seen.get(id) ?? { updates: 0, lastSeen: 0 };
            cur.updates += Number(f.updateStats?.updateCount ?? f.update_stats?.update_count ?? 1);
            cur.lastSeen = Math.max(cur.lastSeen, when.getTime());
            seen.set(id, cur);
          }
        } catch {} // empty bucket -> skip
      }
      res.json([...seen.entries()].map(([fixtureId, v]) => ({ fixtureId, ...v })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Authenticated passthrough to any TxLINE GET endpoint, for exploring the
  // API (e.g. the fixtures endpoints) without writing code. GET-only and
  // admin-key gated; path must stay under /api/.
  app.get("/admin/txline", async (req, res) => {
    try {
      if (req.get("x-admin-key") !== CFG.adminKey) return res.status(401).json({ error: "bad admin key" });
      const apiPath = String(req.query.path ?? "");
      if (!apiPath.startsWith("/api/")) return res.status(400).json({ error: "path must start with /api/" });
      const { path: _p, ...params } = req.query as Record<string, string>;
      const out = await txline.rawGet(apiPath, params);
      res.status(out.status).json(out.data ?? null);
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
      const tx = await vault.createMarket(spec);
      registry.add(spec, tx);
      res.json({ marketId: id, createTx: tx });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // SPA fallback: any non-API route serves the app shell.
  app.get(/^\/(?!markets|live|health|admin).*/, (_req, res) =>
    res.sendFile("index.html", { root: "public" }, (err) => err && res.status(404).end()));

  app.listen(CFG.port, () => console.log(`[api] listening on :${CFG.port}`));
  await stream.start();
  keeper.start();
  setInterval(() => void keeper.sweep(), 60_000);
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
