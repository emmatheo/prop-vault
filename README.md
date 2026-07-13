# Prop Vault — trustless World Cup prop markets, settled in seconds

**Track:** Prediction Markets & Settlement (TxODDS World Cup Hackathon, Superteam Earn)

Stake test-USDC on simple match props ("Spain beat Belgium?"). The moment the
match ends, **anyone** can submit TxLINE's Merkle proof to our Solana program,
which CPIs into TxLINE's `validate_stat` to prove the outcome **on-chain** —
no oracle vote, no dispute window, no trusting our server. Winners split the
losing pool pari-mutuel style, so there is always a counterparty.

## Live deployment (devnet)

| What | Where |
|---|---|
| **App** | *Render URL — see submission form* |
| **prop_vault program** | [`FNs8ZdNpTuAEsVmAwNUW5mhPU5bSukJ698TwF5rq3fgA`](https://explorer.solana.com/address/FNs8ZdNpTuAEsVmAwNUW5mhPU5bSukJ698TwF5rq3fgA?cluster=devnet) |
| **Test USDC mint** | [`FWJiwiotctjZcgqe37sfRRfZh2hqEKZ31syc3GFS4PbU`](https://explorer.solana.com/address/FWJiwiotctjZcgqe37sfRRfZh2hqEKZ31syc3GFS4PbU?cluster=devnet) |
| **TxLINE oracle (devnet)** | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| **Deployment record** | [DEVNET.md](DEVNET.md) · toolchain notes: [BUILD-NOTES.md](BUILD-NOTES.md) |

Try it: open the app → connect Phantom (devnet mode) → **Get test USDC** →
stake YES or NO on an open market → after full time, watch the market flip to
*Settled* and open the receipt (settlement tx, Merkle root, TxLINE sequence).

## The problem

Prediction-market settlement today is the slow, disputed part: centralized
books settle when their trading desk confirms; on-chain markets typically wait
for an oracle vote or an optimistic-challenge window — **two hours to six
days**, and the operator (or token-holder vote) can misresolve.

## The solution

TxLINE anchors a Merkle root of every match statistic on Solana daily. Prop
Vault stores each market's predicate **on-chain at creation** (stat key(s),
comparison, threshold, period, time gates). Settlement is one permissionless
transaction:

1. Anyone fetches the proof bundle from TxLINE (`/api/scores/stat-validation`).
2. They call our `settle` instruction with it.
3. The program **rebuilds the predicate from stored market state** (never from
   caller input), CPIs into `txoracle.validate_stat`, which verifies the
   Merkle proof against the on-chain daily root and returns the outcome.
4. Winners claim: own stake + pro-rata share of the losing pool − 1% fee.

Our keeper does this automatically at full time — but it is a convenience,
not an authority. Kill it and settle with `curl`; the chain doesn't care who
you are. That's the demo's money shot.

## Security design (the stat-substitution attack we closed)

A naive integration lets the settler choose *which stat* to prove — proving a
*corners* count against a *goals* market, or a half-time snapshot against a
full-time market, and still satisfying the predicate. Prop Vault pins
everything at creation and enforces it in `settle`:

- proven `stat_key` / `stat_key2` must equal the market's stored keys
- proven `period` must equal the market's stored period
- the proof's fixture id must match, and its update window must extend past
  match end (`maxTimestamp ≥ settle_after_ts`) — mid-match proofs rejected
- predicate (threshold/comparison/operator) is rebuilt from stored state
- `void_after_ts` opens full refunds for abandoned/postponed fixtures
- one-sided pools auto-void instead of trapping the losing side's funds

Honest trust assumption: TxODDS is the data source. What Prop Vault removes is
trust in **resolution and custody** — the operator cannot misreport an outcome
or freeze funds.

## Architecture

```
TxLINE SSE stream ──► ingest (+ recorder) ──► keeper ──► settle ix ──CPI──► txoracle.validate_stat
        │                                        │                              (Merkle proof vs
        └── REST: stat-validation proofs ────────┘                               daily on-chain root)
recordings (JSONL) ──► replay engine ──► same pipeline, for demos
frontend ◄── /markets /live /markets/:id/receipt ◄── Express API
USDC ◄──► prop_vault program: create / stake / settle / void / claim (pari-mutuel)
```

- **Program** (`programs/prop-vault`, Anchor 0.30.1): `create_market`,
  `stake`, `settle` (CPI + guards above), `void`, `claim`. TxLINE CPI types
  are generated straight from the vendored IDL via `declare_program!` —
  see `idls/txoracle.json`.
- **Backend** (`backend/`, Node/Express/TypeScript): TxLINE free-tier
  onboarding (on-chain subscribe + token activation), SSE ingest with
  auto-reconnect, JSONL recorder, replay engine, keeper, REST API, and the
  static frontend. Runs with **zero configuration** on devnet — every setting
  has a working default, including an auto-generated admin key
  (`data/admin-key.txt`).
- **CI** (`.github/workflows/devnet-deploy.yml`): builds in the official
  Anchor image and deploys the program to devnet; commits `DEVNET.md` with
  the resulting addresses.

## Market templates (scope-disciplined: three)

| Template | Predicate proved on-chain |
|---|---|
| `homeWin` | home goals − away goals > 0 (Subtract + GreaterThan) |
| `cornersOver` | team corners > n |
| `goalsOver` | home goals + away goals > n (Add operator) |

The design is sport-agnostic: any TxLINE stat key can back a market — paid
TxLINE tiers unlock 1000+ leagues with zero code changes.

## API

Public: `GET /markets`, `GET /markets/:id`, `GET /markets/:id/receipt`,
`GET /live` (SSE mirror), `GET /health`, `POST /tx/stake`, `POST /tx/claim`,
`POST /faucet` (test USDC), `GET /positions/:address`.

Admin (header `x-admin-key`): `POST /admin/markets` (create from template),
`GET /admin/live-fixtures` (fixtures currently producing updates),
`GET /admin/txline?path=/api/...` (authenticated TxLINE passthrough).

Create a single market:
```bash
curl -X POST $HOST/admin/markets -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"template":"homeWin","fixtureId":18218149,"kickoffTs":1783710000,"label":"Spain beat Belgium?"}'
```

Seed the **whole board** in one command (all three templates for every fixture
in `upcoming.json`, idempotent — safe to re-run):
```bash
cd backend && npm run seed                 # localhost, ADMIN_KEY read from data/admin-key.txt
HOST=https://<your-host> npm run seed      # against a deployed backend
npm run seed -- --file live                # seed from fixtures currently live on the feed
```

## Run the demo in 60 seconds (no wallet, no credentials)

```bash
cd backend && npm install
REPLAY_FILE=data/recordings/scores-2026-07-09.jsonl npm run dev   # boots standalone
npm run seed                                                      # fills the board
open http://localhost:8787
```
Replay mode streams a recorded match through the exact same pipeline — no
TxLINE onboarding and no deploy wallet required — so the board and live scores
work offline for the demo video. Staking/settlement additionally need the
deployed program + `backend/keypair.json` (see *Deploy your own*).

## TxLINE endpoints used (submission requirement)

- `POST /auth/guest/start` → on-chain `subscribe` (free tier, level 1) → `POST /api/token/activate`
- `GET /api/scores/stream` (SSE live scores)
- `GET /api/fixtures/snapshot` (upcoming fixture metadata → market creation)
- `GET /api/scores/snapshot/{fixtureId}`
- `GET /api/scores/updates/{epochDay}/{hour}/{interval}`
- `GET /api/scores/stat-validation` → Merkle proof bundle → CPI `validate_stat`

## Deploy your own

**Cloud (Render):** New + → *Blueprint* → pick this repo. [`render.yaml`](render.yaml)
configures everything; when prompted, paste the contents of your
`backend/keypair.json` into `KEYPAIR_JSON`. The disk keeps markets,
recordings, and the admin key across restarts.

**Program (devnet):** push to the deploy branch or run the *Deploy to Solana
devnet* GitHub Action — it builds in the official Anchor 0.30.1 image, funds
a cached wallet (manual faucet fallback), deploys, and records addresses in
`DEVNET.md`. Toolchain details and pinned-dependency rationale:
[BUILD-NOTES.md](BUILD-NOTES.md).

**Local:**
```bash
cd backend
npm install                        # Node 20+
# put a funded devnet wallet at backend/keypair.json
npx tsx src/server.ts              # zero further config on devnet
```
Demo replay mode (no live match needed): set `REPLAY_FILE=data/recordings/<file>.jsonl`
and `REPLAY_SPEED=20` in `backend/.env` — recorded events stream through the
exact same pipeline, including settlement.

## Repo map

```
programs/prop-vault/   Anchor program (pari-mutuel vault + CPI settlement)
idls/txoracle.json     vendored TxLINE devnet IDL (drives declare_program!)
backend/               API + keeper + recorder + replay + frontend (public/)
backend/scripts/       setup-wallet.ts, seed-markets.ts (npm run seed)
.github/workflows/     CI: devnet program deploy, wallet export helper
DEVNET.md              deployed addresses (auto-generated by CI)
BUILD-NOTES.md         exact toolchain pairing + why Cargo.lock is pinned
PLAYBOOK.md            build log / operator runbook
```
