# Build notes — anchor 0.30.1 toolchain

`anchor build` is green on this branch. Artifacts produced:

- `target/deploy/prop_vault.so` (program binary, ~332 KB)
- `target/idl/prop_vault.json` (also committed at `backend/target-idl/prop_vault.json` for the Railway deploy, per PLAYBOOK Gate 3.3)
- `target/types/prop_vault.ts`
- Program ID (auto-synced into `declare_id!` and `Anchor.toml` by `anchor keys sync` semantics on first build): `AudqCpevyJj4FFXnJQsdkFaj1FMFqMhYNZ9SEN37Cc9q`
  - The keypair for this ID lives in `target/deploy/prop_vault-keypair.json` and is **not** committed. If you rebuild on a fresh machine, `anchor build`/`anchor keys sync` will mint a new ID — that's fine, just deploy with whatever ID your machine generates.

## Toolchain that works (June-2024 era pairing)

| Component | Version |
|---|---|
| solana CLI / cargo-build-sbf | 1.18.17 (platform-tools v1.41, SBF rustc 1.75) |
| anchor-cli | 0.30.1 |
| host rustc for the IDL step | nightly-2024-06-19 (any mid-2024 nightly works) |

The IDL-generation step of anchor 0.30.1 needs a 2024-era **nightly** host
toolchain: `anchor-syn 0.30.1` uses `proc_macro2::Span::source_file()`, which
requires `proc-macro2 <= 1.0.86` under `--cfg procmacro2_semver_exempt`, and
that combination only compiles on rustc versions where the underlying
unstable `proc_macro` API still exists (removed around rustc 1.88).

## Why Cargo.lock is pinned

A fresh `cargo generate-lockfile` in 2026 resolves many transitive crates to
versions that need rustc ≥ 1.77 / edition-2024, which the SBF toolchain
(rustc 1.75) cannot parse or compile. The committed `Cargo.lock` pins:

- `blake3 1.5.5`, `indexmap 2.5.0`, `bytemuck 1.16.3 (+derive 1.7.1)`,
  `borsh 1.5.1 (+derive 1.5.1)`, `bitflags 2.6.0`, `serde 1.0.210`,
  `serde_json 1.0.128`, `serde_bytes 0.11.15`, `syn 2.0.77`,
  `proc-macro2 1.0.86`, `thiserror 1.0.63`, `zeroize_derive 1.4.2`,
  `unicode-segmentation 1.11.0`, `proc-macro-crate 3.1.0`,
  `jobserver 0.1.32`, `rayon 1.10.0`, wasm-bindgen family `0.2.92`.

**Do not run `cargo update` without re-checking the build** — it will float
these back to versions the SBF toolchain rejects.

Two small source-adjacent fixes were needed (no behavior change):

1. `idls/txoracle.json`: removed the two `pubkey`-typed constants
   (`TXLINE_MINT`, `USDT_MINT`). anchor 0.30.1's `declare_program!` generates
   invalid Rust for pubkey constants (emits the base58 value unquoted). The
   program never referenced them; the mint addresses remain available in
   TxLINE's published IDL.
2. `programs/prop-vault/src/lib.rs`: `Program<'info, AssociatedToken>` with a
   `use anchor_spl::associated_token::AssociatedToken;` import instead of the
   fully-qualified path inline — anchor 0.30.1's IDL generator cannot resolve
   fully-qualified paths inside `Program<...>`.

## Deploying (Gate 1.6)

Deploy was **not** possible from the sandboxed CI environment this branch was
built in (its egress policy blocks all Solana devnet RPC endpoints and the
faucet). From Codespaces or any normal machine:

```bash
solana config set --url devnet --keypair backend/keypair.json
solana balance                  # needs ≥ ~2.5 SOL for deploy; faucet.solana.com
anchor build
anchor deploy
```

If you want to reproduce this exact toolchain in Codespaces, the fastest path
is the official Anchor build image, which ships all three components
preinstalled: `docker pull backpackapp/build:v0.30.1`.
