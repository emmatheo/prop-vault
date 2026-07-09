// Record-only mode: onboards with TxLINE (free tier) and records the live
// score stream to data/recordings/*.jsonl. Does NOT need our smart contract
// deployed — this exists so recording can start before Anchor is set up.
// Run from the backend folder:  npx tsx src/record.ts

import { TxlineClient } from "./txline/client.js";
import { LiveScoreStream } from "./txline/stream.js";

async function main() {
  console.log("[record] onboarding with TxLINE (guest JWT -> subscribe -> activate)...");
  const client = await new TxlineClient().init();
  console.log("[record] onboarded. Connecting to score stream...");

  const stream = new LiveScoreStream(client, true);
  let count = 0;
  stream.on("status", (s) => console.log(`[record] stream: ${s}`));
  stream.on("score", (e) => {
    count++;
    if (count <= 10) {
      // Print the first 10 raw events — PASTE THESE BACK TO CLAUDE so the
      // keeper's field parsing (fixtureId / phase / seq) can be locked down.
      console.log(`[record] RAW EVENT #${count}:`, JSON.stringify(e).slice(0, 500));
    } else if (count % 50 === 0) {
      console.log(`[record] ${count} events recorded...`);
    }
  });
  await stream.start();
  console.log("[record] recording. Leave this window open during matches. Ctrl+C to stop.");
}

main().catch((e) => {
  console.error("[record] FAILED:", e?.response?.data ?? e.message ?? e);
  console.error("Paste the error above back to Claude.");
  process.exit(1);
});
