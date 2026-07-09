# Prop Vault — trustless World Cup prop markets, settled in seconds

**Track:** Prediction Markets & Settlement (TxODDS World Cup Hackathon, Superteam Earn)

Stake USDC on simple match props. The moment the match ends, anyone can submit
TxLINE's Merkle proof to our Solana program, which CPIs into TxLINE's
`validate_stat` to prove the outcome **on-chain** — no oracle vote, no 2-hour
dispute window, no trusting our server. Winners split the losing pool
pari-mutuel style, so there is always a counterparty.

Elsewhere, prediction-market settlement takes a minimum of two hours and can
stretch to days in disputes. Here it takes one transaction, and every market
page shows the receipt: settlement tx, TxLINE sequence, Merkle root.

## Architecture

```
TxLINE SSE stream ──► ingest (+ recorder) ──► keeper ──► settle ix ──CPI──► txoracle.validate_stat
        │                                        │                              (Merkle proof vs
        └── REST: stat-validation proofs ────────┘                               daily on-chain root)
recordings (JSONL) ──► replay engine ──► same pipeline, for demos
frontend ◄── /markets /live /markets/:id/receipt ◄── Express API
USDC ◄──► prop_vault program: create / stake / settle / void / claim (pari-mutuel)
```

## TxLINE endpoints used (for the submission doc)
- `POST /auth/guest/start`, on-chain `subscribe` (free tier level 1), `POST /api/token/activate`
- `GET /api/scores/stream` (SSE)
- `GET /api/scores/snapshot/{fixtureId}`
- `GET /api/scores/updates/{epochDay}/{hour}/{interval}`
- `GET /api/scores/stat-validation` → Merkle proof bundle → CPI `validate_stat`

## Setup

```bash
# 1. wallet + devnet SOL
solana-keygen new -o backend/keypair.json && solana airdrop 2 -k backend/keypair.json --url devnet

# 2. TxLINE devnet IDL -> idls/txoracle.json
#    https://txline.txodds.com/documentation/programs/devnet

# 3. test USDC on devnet
spl-token create-token --decimals 6      # put mint in backend/.env USDC_MINT
spl-token create-account <MINT> && spl-token mint <MINT> 1000

# 4. build + deploy program
anchor keys sync && anchor build && anchor deploy   # updates declare_id + Anchor.toml

# 5. backend
cd backend && cp .env.example .env  # fill in
npm i && npm run dev
```

Create a market:
```bash
curl -X POST localhost:8787/admin/markets -H 'x-admin-key: ...' -H 'content-type: application/json' \
  -d '{"template":"homeWin","fixtureId":17952170,"kickoffTs":1752170400,"label":"France beat Brazil?"}'
```

## Verification status
1. ~~txoracle IDL field names~~ **CLOSED** — devnet IDL v1.5.2 fetched from official
   docs and vendored at idls/txoracle.json; lib.rs/vault.ts reconciled
   (ScoresBatchSummary, StatTerm, TraderPredicate(i32), daily_scores_merkle_roots).
2. ~~`add` operator~~ **CLOSED** — BinaryExpression = {Add, Subtract}; goalsOver is
   viable. Comparison also has EqualTo (draw markets possible later).
   Also added on-chain guards pinning proven stat key + period to market params
   (prevents proving corners against a goals market).
3. **CU headroom** — docs budget 1.4M CU for `validate_stat` alone (the tx max).
   Test a real settle on devnet immediately. If our wrapper overhead overflows:
   fallback A = pass a smaller proof (fewer nodes late in the day tree);
   fallback B = split settle into `record_validation` (CPI only, stores bool in a
   scratch PDA) + `finalize` (reads scratch, pays) — two txs, still trustless.
4. **ScoreStat period code for full match** — templates assume 0; confirm the first
   time a real proof is fetched (print statToProve.period) and adjust markets.ts.
5. **SSE payload field names** — connect once, print raw events, fix the
   defensive parsing in `keeper.ts` (`fixtureId`/`phase`/`seq`).
6. **Timestamp units** — proofs use ms in docs; program compares against unix
   seconds `settle_after_ts`. Normalize once confirmed (assert in `settle`).
7. **Start recording matches TODAY** (`npm run dev` records by default).
   The demo video depends on having at least one full recorded match.

## Security notes (put a short version in the submission)
- Settlement is permissionless; the predicate is stored at market creation and
  cannot be swapped by the caller. The proof is verified against TxLINE's
  on-chain daily Merkle root — the keeper is a convenience, not an authority.
- Mid-match proof injection is blocked two ways: time gate (`settle_after_ts`)
  and proof-window assertion (`maxTimestamp` must extend past match end).
- Abandoned/cancelled/postponed matches: `void_after_ts` opens full refunds.
- One-sided pools auto-void instead of trapping funds.
- Trust assumption stated honestly: TxODDS is the data source. What's removed
  is trust in *resolution and custody* — the operator (us) cannot misreport an
  outcome or freeze funds.

## Demo video script (≤5 min, judges score heavily on this)
1. (30s) Problem: settlement elsewhere = 2 hours to 6 days + disputes.
2. (60s) Stake USDC on "France beat Brazil?" from two wallets, YES and NO.
3. (90s) Replay mode on-screen: goals stream in, phase flips to F, keeper logs
   proof fetch, settle tx lands. Stopwatch overlay: full-time → settled.
4. (60s) Receipt page: explorer link, Merkle root, TxLINE seq. Claim payout.
5. (30s) Kill the keeper live, settle another market manually with curl —
   "anyone can settle; that's what trustless means."
6. (30s) Architecture slide + honest TxLINE API feedback.
