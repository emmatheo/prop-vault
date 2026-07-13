# Prop Vault — 5-minute demo script

The single screening requirement and the judge's #4. Record in one take if you
can; a few cuts are fine. Target **4:30–5:00**. Everything below is already
runnable — no slideware.

**Before you hit record**
- Backend deployed and warm (hit `/health`, confirm `"contract":"connected"`).
- Board seeded: `HOST=<host> npm run seed` → open the site, markets are visible.
- Phantom on **Devnet**, funded (SOL + tap **Get test USDC**).
- Have a terminal ready with `HOST` and `ADMIN_KEY` exported.
- Sound on — the app has live stadium ambience; it reads well on video.

---

### 0:00 – 0:25 · The one-sentence thesis
On the live board (Matches tab).
> "Prop Vault is USDC prop betting on live football that settles itself the
> moment the match ends — no oracle vote, no dispute window, no trust in us.
> Let me show you, then prove it."

Show the fixture cards: flags, live/upcoming chips, win-probability rings.

### 0:25 – 1:15 · Stake, on-chain, in the browser
- Connect Phantom (popup → approve). Point out the header holdings pill.
- Open a market, stake YES, approve in Phantom.
- Open the tx in Explorer from the toast. "That's real, on devnet, right now."
- Switch to **My stakes**: the position shows, holdings updated.

### 1:15 – 2:15 · The proof, not the promise
Cut to a market whose match is finishing (or your replay).
> "Here's the part everyone else hand-waves: settlement."
- When full time hits, the card flips to **FULL TIME — settling by proof**.
- Seconds later it becomes **settled**; open the **Receipt**.
- Read the receipt aloud: settlement tx, **TxLINE sequence**, **Merkle root**,
  proof window. Click **Verify it yourself** → Explorer.
> "The outcome was proven on-chain by CPI into TxLINE's `validate_stat` against
> the daily Merkle root. No one voted. The program checked the math."

### 2:15 – 3:15 · Trustless, demonstrated (the money shot)
Terminal.
> "Our keeper submitted that — but it has no special power. Watch me kill it
> and settle the next market by hand."
- Stop the keeper (Ctrl-C on the server, or scale the worker to zero).
- Settle a finished market with a raw `curl` proof submission (or
  `npm run rehearse -- --market <id> --skip-stake` to claim as any wallet).
- Winner's USDC balance goes up on screen.
> "Settlement is permissionless. If we vanish, anyone finishes the job with the
> same public proof. That's the difference between a bot and trustless."

### 3:15 – 4:15 · Why it can't be gamed
Cut to README's guard list (or narrate over code).
> "A naive version could be fooled by feeding a corners proof to a goals
> market, or a half-time snapshot to a full-time market."
- Show the on-chain checks: `stat_key`/`stat_key2`, `period`, and freshness
  must equal the market's stored predicate — rebuilt from chain state, never
  from the caller.

### 4:15 – 5:00 · Close
- One line on the stack: Anchor program + CPI proof verification, Express
  keeper/recorder, same binary replays recordings for reproducibility.
- End on the settled receipt.
> "Back your call. Settled at the whistle. Verified by anyone. Thanks."

---

## Fallback: no live match before the deadline
Replay is legal and reproducible — say so on camera.
```bash
REPLAY_FILE=data/recordings/<match>.jsonl REPLAY_SPEED=20 npm run dev
npm run seed
```
The recording streams through the identical pipeline, including settlement, so
every beat above still happens — just say "this is a recorded match replayed
through the exact same code," and let the keeper settle it live on screen.

## The three commands you'll actually type
```bash
HOST=<host> npm run seed                              # board is never empty
npm run rehearse -- --market <id>                     # full stake→settle→claim dry run
curl -s $HOST/markets/<id>/receipt | jq               # the proof bundle, on demand
```
