Deploy wallet PUBLIC ADDRESS (safe to publish — this is NOT a secret key):

  FDuYyyncAGpvrkTdNaVr1Sb8qtdy43NQWw99BSZBshcM

This is the base58 public key of the devnet deploy wallet, which is also the
backend signer and the test-USDC mint authority. A public address is meant to
be shared — it is what you paste into a block explorer. It cannot sign
transactions or move funds.

The matching PRIVATE key is NEVER committed. It lives only in:
  - the CI run's 'devnet-keys' artifact (Actions tab, 5-day retention), and
  - your local backend/keypair.json (gitignored — see .gitignore).

Verify for yourself: a Solana secret key is 64 bytes (an 88-char base58 string
or a [n,n,...] JSON array of 64 numbers). The value above decodes to exactly
32 bytes — the length of a public key. Explorer:
https://explorer.solana.com/address/FDuYyyncAGpvrkTdNaVr1Sb8qtdy43NQWw99BSZBshcM?cluster=devnet
