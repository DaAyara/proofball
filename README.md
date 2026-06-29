# Proofball

A betting market that settles itself using TxLINE's own proof checker, with no admin key and no vote.

## What this is

Proofball lets anyone create a yes or no market on a stat from a football match, like "total corners in the match is more than 9" or "team A gets more yellow cards than team B." People put money on yes or no. When the match is done, anyone can call settle and the program asks TxLINE's own on-chain program to check the stat using the Merkle proof TxLINE already publishes. If the condition is true, the yes side wins. If not, the no side wins. Money pays out automatically based on that result.

There is no admin override anywhere in this program. Nobody can decide the outcome by hand. The only way a market settles is by passing TxLINE's own proof check.

## Why this is different from a normal betting app

Most prediction markets on Solana settle through a price oracle (Pyth) or through a vote (UMA style dispute systems). Sports stats are not a clean price feed and a vote takes time and can be wrong. TxLINE solves the data problem already, it timestamps every match stat and anchors a Merkle root on chain, with proofs you can check yourself. Proofball is built specifically to use that, not to build another generic oracle on top.

The other thing we built on purpose: a way to check a settled market without trusting our own website. That is the `verify/` folder. It is a small script that pulls the same proof data straight from TxLINE's API and TxLINE's program and rebuilds the Merkle root by hand. You do not need our frontend to believe a market settled correctly, you can run the script yourself.

## How settlement actually works

1. Someone creates a market tied to a fixture id and one or two stat keys (using TxLINE's own encoding, see their soccer feed docs)
2. People place positions, yes or no, before the close time
3. After the match, anyone calls `settle_market` with the proof data pulled from TxLINE's `GET /api/scores/stat-validation` endpoint
4. Our program does not check the proof itself. It calls TxLINE's own `validateStat` instruction through a cross program call and reads back true or false
5. The market is marked settled with that result
6. Winners call `claim_payout` and get their share of the pool

We never touch the actual cryptography. TxLINE wrote that code, audited it presumably, and runs it on chain already. We just call it.

## What TxLINE endpoints and accounts we use

- `GET /api/scores/stat-validation` - the off chain endpoint that returns the proof data for a stat
- `validateStat` instruction on TxLINE's own program, called through CPI
- `daily_scores_roots` PDA, derived the same way TxLINE's docs show, seeds `["daily_scores_roots", epochDay as u16]`
- Soccer stat key encoding from `/documentation/scores/soccer-feed`, the `period * 1000 + base_key` formula

Program IDs we point at:

- Devnet: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Mainnet: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`

## What is still a draft and needs checking against the real IDL

Being honest here because this matters for code quality. The exact byte layout of the CPI call to `validateStat` in `programs/proofball/src/txline.rs` is built from the example code in TxLINE's docs, not from a downloaded IDL, because I could not pull the full Anchor IDL file directly while writing this. Before you trust this for the real demo:

1. Run `scripts/download_idl.sh` first thing in Codespaces, it pulls TxLINE's real devnet IDL
2. Open `docs/txline-idl/devnet.md` and check the real `validateStat` account list and argument order against `programs/proofball/src/txline.rs`
3. If anything differs, fix `txline.rs`. The rest of the program does not need to change, settlement logic only touches that one file
4. Same goes for how `validateStat` returns its result. The current code assumes it uses Solana's return data mechanism, this needs confirming with a real test call

I left clear comments at each spot in the code where this matters.

## Project layout

```
programs/proofball/   the Anchor program, market creation, positions, settlement, payout
verify/                stand alone script that checks a settled market without our frontend
scripts/               setup helpers, including the IDL download script
tests/                 Anchor test for the full create, bet, settle, claim flow
docs/                  notes and the fetched TxLINE IDL once you run the download script
```

## Running this in Codespaces

```bash
# one time setup
avm install latest
avm use latest
solana-keygen new --no-bip39-passphrase

# get a bit of devnet SOL
solana airdrop 2 --url devnet

# pull TxLINE's real IDL before touching settlement code
bash scripts/download_idl.sh

# build and test the program
anchor build
anchor test

# run the independent verification CLI against a settled market
cd verify
npm install
npm run verify -- <market pubkey>
```

## What we used TxLINE for, and where we hit friction

Filling this in properly during the build, this section is for the submission's required feedback piece.

What worked well: the stat key encoding is simple once you read the soccer feed page, `period * 1000 + base_key` is easy to build markets around. The `validateStat` instruction already doing two stat comparisons (subtract or add, then compare against a threshold) saved us from writing our own comparison logic on chain.

Where we hit friction: the full Anchor IDL for `validateStat` was not easy to find through normal search and fetch, only the usage example in the on chain validation guide was reachable. A direct link to the raw IDL json from the main quickstart page would save people a step. Also unclear from the docs alone whether `validateStat` is meant to be called through a real CPI from another program or only simulated client side with `.view()`, since every example in the docs uses the client side path. We are treating it as CPI safe since cross program calls are the entire point of building settlement on top of it, but a line in the docs confirming this would help.

## What we left out on purpose

No order book, no AMM, no liquidity pool design. Single pool, proportional payout, two sides. The point of this project is the settlement trust model, not building another exchange. Wider market types and better odds mechanics are an easy add later once the core settlement path is proven solid.
