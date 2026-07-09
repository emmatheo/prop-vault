# PROP VAULT — THE COMPLETE PLAYBOOK
### From zero to submitted. Follow in order. Do not skip gates.
### Wherever you see 📋 PASTE — copy that output and send it to Claude.

Deadline: **July 19**. Winners: July 29. Track: Prediction Markets & Settlement ($18K).

---

## GATE 0 — Backend alive + recording (TODAY, ~30 min, your Windows PC)

**0.1** Download `prop-vault.zip` from the chat. Extract to `C:\dev\prop-vault`.
Check the folder contains: `backend/`, `programs/`, `idls/txoracle.json`, `README.md`.

**0.2** Open PowerShell:
```powershell
cd C:\dev\prop-vault\backend
node -v        # should print v18+ — if not, install Node LTS from nodejs.org
npm install
```

**0.3** Create wallet + get free devnet SOL:
```powershell
npx tsx scripts/setup-wallet.ts
```
If the airdrop fails: copy the printed address → https://faucet.solana.com → pick
DEVNET → request → re-run the script until balance ≥ 0.5 SOL.

**0.4** Config:
```powershell
copy .env.example .env
notepad .env
```
Set `ADMIN_KEY` to anything secret. Save. Leave everything else as-is for now.

**0.5** Start recording:
```powershell
npx tsx src/record.ts
```
✅ Success = `onboarded` then `stream: connected`.
📋 PASTE the full output to Claude — especially the `RAW EVENT` lines (or the error).
**Leave this window open during every match from now on.** The JSONL files it
writes in `backend/data/recordings/` ARE your demo video footage.

> If a match is live and no events print after several minutes, tell Claude —
> that means the payload parsing needs adjusting from your paste.

---

## GATE 1 — Smart contract on devnet (Day 2, ~2 hrs, in the browser)

We use GitHub Codespaces: a Linux machine in your browser. No Windows toolchain
pain, and you need the public GitHub repo for the submission anyway.

**1.1** Create a GitHub account (github.com) if needed. Create a new **public**
repository named `prop-vault`. Do NOT add a README (we have one).

**1.2** Push the project. In PowerShell:
```powershell
cd C:\dev\prop-vault
git init
git add .
git commit -m "prop vault: trustless WC prop markets on TxLINE"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/prop-vault.git
git push -u origin main
```
(If `git` is missing, install from git-scm.com, reopen PowerShell.)
The `.gitignore` already keeps `keypair.json` and `.env` off GitHub. Verify on
the GitHub page that neither file is visible before continuing.

**1.3** On the repo page: green **Code** button → **Codespaces** tab →
**Create codespace on main**. Wait for the browser VS Code to load.

**1.4** In the Codespace terminal, install the toolchain (one block, ~10 min):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.30.1 && avm use 0.30.1
solana --version && anchor --version
```
📋 PASTE the two version lines (or any error).

**1.5** Wallet inside the Codespace (upload your `backend/keypair.json` via
drag-and-drop into the `backend/` folder in the file explorer — it's gitignored,
so it stays private), then:
```bash
cd /workspaces/prop-vault
solana config set --url devnet --keypair backend/keypair.json
solana balance
```

**1.6** Build + deploy:
```bash
anchor keys sync
anchor build
anchor deploy
```
📋 PASTE whatever this prints. Expect compile errors on the first `anchor build`
— the `declare_program!` glue may need small fixes. That is normal: paste the
errors, Claude patches, you rebuild. Loop until `Deploy success`.

**1.7** Create the test USDC mint (stake currency):
```bash
spl-token create-token --decimals 6
```
Copy the printed mint address into `backend/.env` as `USDC_MINT=...`
(on your PC too — both copies of `.env`).

---

## GATE 2 — The decisive test: one real settlement (Day 2–3)

**2.1** Run the backend in the Codespace (or your PC):
```bash
cd backend && npm install && npx tsx src/server.ts
```
Open the forwarded port URL (Codespaces pops a notification) — you should see
the Prop Vault app with "No markets yet."

**2.2** Pick a real upcoming fixture (Claude will give you the fixtureId and
kickoff timestamp from the recorded feed). Create a market:
```bash
curl -X POST localhost:8787/admin/markets \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"template":"homeWin","fixtureId":FIXTURE_ID,"kickoffTs":KICKOFF_UNIX,"label":"Home team to win?"}'
```

**2.3** In the app: connect Phantom (devnet mode ON in Phantom settings), tap
**Get test USDC**, stake YES from one wallet and NO from another (create a
second Phantom account for this).

**2.4** Let the match finish. Watch the server logs: the keeper should print
`fixture ... terminal`, `settled market ... tx=...`.
📋 PASTE the settle log lines — success OR failure. This is the compute-unit
verdict. If it fails on CU, Claude ships the two-transaction fallback same day.

✅ Gate 2 green = the product provably works end-to-end. Everything after this
is packaging.

---

## GATE 3 — Public URL (Day 3–4)

**3.1** railway.app → Login with GitHub → New Project → Deploy from repo →
pick `prop-vault`.

**3.2** Settings → Root Directory: `backend`. Build command: `npm install`.
Start command: `npx tsx src/server.ts`.

**3.3** Variables — add every line from your `.env`, PLUS:
- `KEYPAIR_JSON` = the entire contents of `keypair.json` (the `[12,34,...]` array)
- `VAULT_IDL` = `./target-idl/prop_vault.json` — and copy the file
  `target/idl/prop_vault.json` from the Codespace into `backend/target-idl/`
  in the repo (this one IS committed), push again.
- `TXORACLE_IDL` = `../idls/txoracle.json`

**3.4** Settings → attach a **Volume** mounted at `/app/data`, and set
`DATA_DIR=/app/data` so markets + recordings survive restarts.

**3.5** Settings → Networking → Generate Domain. Open it.
✅ You now have the judge-facing URL. 📋 PASTE it to Claude for a remote audit.

---

## GATE 4 — Make it look alive (Day 4–5)

- Create markets for every remaining fixture (3rd-place match + final at minimum;
  Claude generates the exact curl commands from the schedule).
- Stake from two wallets so pools show real numbers.
- Ensure at least one market settles publicly before recording the demo —
  the receipt ticker must have a real entry.
- Run the replay mode once end-to-end: stop the server, set `REPLAY_FILE` in
  `.env` to a recording, restart, confirm the DEMO REPLAY pill shows and
  scores stream.

---

## GATE 5 — Demo video + submission (Days 8–10, but script it now)

Video (≤5 min, Loom or YouTube), structure per the judges' own template:
1. 0:00–0:30 Problem: settlement elsewhere takes 2 hours to 6 days and gets disputed.
2. 0:30–1:30 Live walkthrough: connect, faucet, stake YES and NO from two wallets.
3. 1:30–3:00 The money shot: replay mode on screen — final whistle → keeper logs
   → settle transaction → receipt ticket opens. Mention the stat-substitution
   attack we closed (judges love a security story).
4. 3:00–4:00 Kill the keeper live; settle another market with curl:
   "anyone can settle — that's what trustless means."
5. 4:00–5:00 Architecture + honest TxLINE API feedback.

Submission checklist (Superteam Earn form):
- [ ] Demo video link
- [ ] Public repo link (github.com/YOU/prop-vault)
- [ ] Application access: the Railway URL
- [ ] Tech doc: core idea, pari-mutuel design, list of TxLINE endpoints used
      (it's in README.md), the stat-key guard story
- [ ] API feedback: your running notes of every point of friction

---

## IF YOU FALL BEHIND — cut lines, in order
1. Drop the goalsOver template (two prop types still demo fine).
2. Drop Gate 4 seeding breadth (one seeded match is enough).
3. NEVER cut: Gate 2's test settle, replay mode, the receipt page, the video.

## STANDING RULES
- Recorder runs during every match. No exceptions.
- Every error goes to Claude verbatim. Errors are information, not failure.
- Keep the API-friction notes file open at all times (submission requirement).
