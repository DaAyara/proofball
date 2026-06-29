# Build plan

Just a checklist for me to follow. Not part of the submission.

## Week 1, on chain core

- [ ] Open repo in Codespaces, run setup, confirm `anchor build` works with a placeholder program id
- [ ] Run `scripts/download_idl.sh`, read `docs/txline-idl/devnet.md`
- [ ] Fix `programs/proofball/src/txline.rs` to match the real `validateStat` instruction (accounts, argument order, return value)
- [ ] Get a real devnet program id, swap it into `Anchor.toml`, `lib.rs` declare_id, and `verify/verify.ts` default
- [ ] Deploy to devnet, confirm `create_market` and `place_position` work with a test SPL token first (not real USDT yet)
- [ ] Get a real fixture id and real proof data from TxLINE's API for one finished match, call `settle_market` for real and see if it works

## Week 2, verification trail and frontend

- [ ] Fix the leaf hashing function in `verify/verify.ts` to match TxLINE's real leaf format (check this against real proof data from week 1)
- [ ] Get the verify CLI to fully check a real settled market end to end
- [ ] Build a small frontend, just enough to: list open markets, place a bet, show settled markets with a link to run the verify script against them
- [ ] Pick 2 or 3 real markets to set up using real World Cup matches, ideally ones that already finished so settlement can be demoed live

## Week 3, polish and submission

- [ ] Record the demo video, script below
- [ ] Write the feedback section in README for real, not placeholder text
- [ ] Double check public repo is actually public
- [ ] Submit on Superteam Earn before July 19 23:59 UTC

## Demo video rough script, keep this under 5 minutes

1. 30 seconds: what the problem is. Sports prop markets need someone to decide what happened, and that someone is usually a person, which means trust issues or slow disputes
2. 1 minute: show creating a market on a real match stat, place a bet from two wallets
3. 1 minute: settle the market, show the program calling TxLINE's validateStat live
4. 1.5 minutes: the actual differentiator, open a terminal, run the verify script against the settled market, walk through it printing the Merkle root check and the threshold check, show it matching what the program recorded
5. 30 seconds: what is left out on purpose and what would come next (more market types, better odds, mainnet)

## Things to not lose track of

- The submission needs a public repo link, a working deployed link or devnet endpoint, a demo video, and the technical doc. All four, the brief says missing the video fails initial screening on its own
- Keep it to 2 or 3 working markets rather than a flexible market builder, finished beats ambitious here
- If `validateStat` turns out to only work through client side `.view()` simulation and not a real CPI, that changes settle_market a lot, this is the single biggest open risk in the whole plan and should be the very first thing tested in week 1, not week 2
