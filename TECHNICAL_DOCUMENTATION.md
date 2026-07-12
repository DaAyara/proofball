# Proofball - Technical Documentation

TxODDS Prediction Markets and Settlement Track
Live app: https://daayara.github.io/proofball
Repo: https://github.com/DaAyara/proofball

---

## Core Idea

Proofball is a pooled prediction market on Solana for World Cup stat conditions. Fans pick a market like "total corners in Argentina vs Switzerland greater than 9", put any amount of devnet USDC on yes or no, and an on chain vault holds all funds until the match ends. Settlement happens through a cross-program invocation directly into TxLINE's deployed validate_stat instruction, which checks a cryptographic Merkle proof of the match stat on chain. No oracle, no admin override, no dispute step. The proof either passes or it does not. Winners claim a proportional share of the whole pool automatically.

TxLINE already ships a one to one trade system (create_trade, settle_trade), but both traders must agree on exact stakes before anything exists. Proofball is the pooled version - you bet any amount against everyone else on the other side, with TxLINE's own cryptographic proof as the settlement engine.

---

## Architecture

- **On-chain program:** Anchor/Rust, deployed on Solana devnet at `7JNc8D9Pt87apERHFsXoTnibWEvxF9n5wCJJinJopaPv`
- **Frontend:** Vanilla HTML/JS, reads market state directly from chain on load, sends real transactions through connected wallet
- **Settlement:** Cross-program invocation into TxLINE's validate_stat instruction using their published Merkle proof data

---

## TxLINE Integration

### Endpoints Used
- `POST /auth/guest/start` - guest JWT for API calls
- `GET /api/fixtures/snapshot` - pulled upcoming World Cup fixture IDs for market creation

### On-Chain CPI
The core integration is a Cross-Program Invocation into TxLINE's deployed Solana program during settlement. The `settle_market` instruction:

1. Takes proof data from TxLINE's `GET /api/scores/stat-validation` endpoint
2. Builds a CPI call into TxLINE's `validate_stat` instruction using the real discriminator `[107, 197, 232, 90, 191, 136, 105, 185]` from their IDL
3. Passes the Merkle proof, fixture summary, stat terms, and predicate directly to TxLINE's program
4. Reads the boolean result back through `get_return_data()`
5. Settles the market yes or no based on that result with no admin involvement

---

## Program Instructions

### create_market
Creates a new pooled market on a stat condition for a specific TxLINE fixture. Parameters: fixture_id, stat_key_a, stat_key_b, op (add/subtract), comparison (greater than/less than/equal to), threshold, and close_unix_time. Initializes a PDA market account and a PDA token vault.

### place_position
Moves user funds into the market vault and records their position (yes or no, amount). Users can add to the same side multiple times before close time. Switching sides from one account is blocked on-chain to prevent pool manipulation.

### settle_market
Called after close_unix_time passes. Makes the CPI into TxLINE's validate_stat, reads the result, and writes yes or no to the market account. Does not move any funds - just records the result.

### claim_payout
Called by each winning position after settlement. Payout is proportional: `payout = position.amount * total_pool / winning_pool`. Losing positions cannot claim anything. Double-claiming is blocked on-chain.

---

## Live Markets on Devnet

Three markets created with real TxLINE fixture IDs:

| Market | Fixture ID | Condition | PDA |
|--------|-----------|-----------|-----|
| Argentina vs Switzerland | 18222446 | Total corners > 9 | BpVuZMm3pz9pmbAcTWEzApiZdWgKQzXdpv7hkR1uqL6k |
| France vs Spain | 18237038 | Total yellow cards > 4 | 6s1ufwxVcQ1dA3hP25uBZVbwHYbAnKMekgGR6vXFCUy5 |
| England vs Argentina | 18241006 | Total goals > 2 | GjyVpoBamxXsimAo6v5dJg7QdBc5HxQaD6gu2JVKnLyL |

Test token mint: `DdYyoRtiQiBd9dB7wg7DbSzN6WCWV35nBZSRCW7akkU5`

---

## Core User Flow

1. Fan opens the app and sees open markets with live pool sizes read from chain
2. Fan connects Solflare or Phantom wallet (devnet)
3. Fan enters an amount and clicks BET YES or BET NO
4. Transaction calls place_position on-chain, funds move into the PDA vault
5. After the match closes, anyone calls settle_market with TxLINE's Merkle proof data
6. TxLINE's validate_stat CPI runs on-chain and returns the result
7. Winning fans call claim_payout and receive their proportional share of the pool

---

## Security Properties

- Funds are held in program-derived token accounts, not any admin wallet
- Settlement cannot be faked - it requires a valid TxLINE Merkle proof accepted by TxLINE's own deployed program
- Side-switching is blocked on-chain per position account
- Double-claiming is blocked on-chain via a claimed boolean on each position
- close_unix_time is enforced on-chain for both placing positions and settlement timing