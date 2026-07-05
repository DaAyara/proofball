# Proofball

A betting market that settles itself using TxLINE's own proof checker, with no admin key and no vote.

## What this is

Proofball allows anyone create a yes or no market on a stat from a football match, like "total corners in the match is more than 9" or "team A gets more yellow cards than team B." People put money on yes or no. When the match is done, anyone can call settle and the program asks TxLINE's own on-chain program to check the stat using the Merkle proof TxLINE already publishes. If the condition is true, the yes side wins. If not, the no side wins. Money pays out automatically based on that result.

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

## Status on the TxLINE integration

Update: the IDL has been pulled and checked. `programs/proofball/src/txline.rs` now uses the actual discriminator, field names, and types from TxLINE's published program, not guesses from doc examples. Specifically:

- `validate_stat` takes exactly one account, `daily_scores_merkle_roots`, no signer needed for it
- The real discriminator is hardcoded from the IDL, not computed from a hash guess
- Real type names: `TraderPredicate`, `StatTerm`, `ScoresBatchSummary`, `BinaryExpression`, matching their IDL exactly, not the slightly different names used in their doc examples
- `Comparison` only has 3 variants (`greater_than`, `less_than`, `equal_to`), and stat values and thresholds are `i32`, not `i64`

One thing confirmed by reading TxLINE's own IDL: their program already ships a full one-to-one trade system (`create_trade`, `settle_trade`), but it needs both traders to sign before a trade exists, with fixed stakes agreed up front between two named wallets. There is no pooled market where many people can each put in different amounts on yes or no without already having found a matched counterparty. That is the gap Proofball fills, confirmed against their actual account list, not assumed.

What still needs a live test before the demo, since it cannot be confirmed by reading the IDL alone:

1. Whether `validate_stat`'s result comes back through Solana's return data mechanism when called as a real CPI (not just through `.view()` simulation, which is the only way TxLINE's own docs show calling it)
2. The exact leaf hashing format used inside `ScoreStat`, needed for the independent verify script in `verify/` to recompute the Merkle root by hand

Both are marked clearly in code comments at the exact spot that needs the live check.

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

**TxLINE endpoints and accounts used:**

- `POST /auth/guest/start` to get a guest JWT
- `POST /api/token/activate` to exchange an on-chain subscription for an API token
- `GET /api/scores/snapshot` for match score data
- `GET /api/scores/stat-validation` for Merkle proof data to pass into `settle_market`
- `validateStat` instruction on TxLINE's deployed program, called through CPI from our Anchor program
- `daily_scores_roots` PDA, seeded as `["daily_scores_roots", epochDay as u16]`
- `pricing_matrix` PDA, seeded as `["pricing_matrix"]`
- `token_treasury_v2` PDA and its associated Token-2022 account for the subscription flow

**What worked well:**

The stat key encoding (`period * 1000 + base_key`) is clean and easy to build markets around. Once you understand the scheme you can construct any prop condition from a fixture without guessing. Having `validateStat` already handle two-stat combinations on-chain (add or subtract, then compare against a threshold) saved us from writing our own comparison logic. The Merkle proof structure in the IDL is clearly laid out once you find the real IDL file. The discriminator for `validateStat` being published directly in the IDL (`[107, 197, 232, 90, 191, 136, 105, 185]`) was very helpful, it meant we could build the CPI call without guessing at the Anchor hash.

The fact that TxLINE's own program already does one-to-one matched trades (`create_trade`, `settle_trade`) and Proofball fills the gap with pooled markets is a real architectural story, not a forced one. Reading the IDL and seeing both programs' trade-offs clearly made the submission stronger.

**Where we hit friction:**

The API access flow for hackathon participants was the biggest source of friction. The guest JWT alone returns `403 Missing API Token` on every data endpoint. You need two headers (`Authorization` and `X-Api-Token`), but the path to getting the second one requires an on-chain subscription plus a call to `/api/token/activate`. None of this is in the quickstart. A single page for hackathon builders titled "get your free API token in 5 steps" would have saved us several hours.

The subscription itself had undocumented constraints. The `weeks` argument must be a multiple of 4, which you only discover from the on-chain error message. The PDA seed for the treasury is `"token_treasury_v2"` but there is no mention of this in the docs and the IDL does not show seed definitions for this account. We got it from Discord. The treasury vault is the ATA of that PDA using Token-2022, also not documented anywhere.

The IDL download link on the documentation page returns "Asset not found". The only way to get the real IDL is to copy it manually from the IDL tab in the browser. This is a small thing but it cost time.

The download button for the IDL also applies to the Anchor IDL format specifically. The camelCase version of the IDL (in the second tab on the docs page) is what the Anchor client actually needs, but the snake_case version is what you see first and the difference is not called out.

We used the Discord dev channel to resolve the treasury PDA seed and the activation error. The team was responsive and helpful there, which is appreciated.


## What we left out on purpose

No order book, no AMM, no liquidity pool design. Single pool, proportional payout, two sides. The point of this project is the settlement trust model, not building another exchange. Wider market types and better odds mechanics are an easy add later once the core settlement path is proven solid.