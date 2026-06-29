// Proofball
//
// A small Solana program for parametric prop markets on football matches.
// A market is a simple yes or no bet on a stat condition, like
// "total corners in the match is more than 9".
//
// We do not run our own oracle and we do not vote on what happened in
// a match. We ask TxLINE's own on-chain program to check the stat for us,
// using the Merkle proof it already publishes. If TxLINE says the
// condition is true, we pay out. If not, we don't. There is no admin
// override and no dispute step, because the stat check is mechanical.
//
// This file only handles money and market state. It never touches
// the proof math itself, that work is fully delegated to TxLINE
// through a cross program call.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("PFbaLLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

// Import TxLINE's own types so our CPI call has to match their real
// instruction shape. These mirror what is published in their IDL.
// See programs/proofball/src/txline.rs for the full definitions and
// a note on where each type came from.
pub mod txline;
use txline::{Comparison, Op, Predicate, StatProof};

#[program]
pub mod proofball {
    use super::*;

    /// Create a new market on a single match.
    ///
    /// stat_key_a and stat_key_b follow TxLINE's soccer stat encoding,
    /// see their docs at /documentation/scores/soccer-feed. If the
    /// market only checks one stat, pass stat_key_b as 0 and op as None.
    ///
    /// Example: "Team A total corners > 5" is stat_key_a = 7
    /// (Participant 1 Total Corners), no second stat, comparison
    /// greater than, threshold 5.
    ///
    /// Example: "Combined corners > 9" needs two stats added together,
    /// which TxLINE's validator does not do directly, see the note
    /// in txline.rs about the add_combined helper market type.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        fixture_id: u64,
        stat_key_a: u32,
        stat_key_b: u32,
        op: u8,
        comparison: u8,
        threshold: i64,
        close_unix_time: i64,
    ) -> Result<()> {
        require!(close_unix_time > Clock::get()?.unix_timestamp, ProofballError::CloseTimeInPast);
        require!(comparison <= 3, ProofballError::BadComparison);
        require!(op <= 2, ProofballError::BadOp);

        let market = &mut ctx.accounts.market;
        market.creator = ctx.accounts.creator.key();
        market.market_id = market_id;
        market.fixture_id = fixture_id;
        market.stat_key_a = stat_key_a;
        market.stat_key_b = stat_key_b;
        market.op = op;
        market.comparison = comparison;
        market.threshold = threshold;
        market.close_unix_time = close_unix_time;
        market.status = MarketStatus::Open as u8;
        market.yes_pool = 0;
        market.no_pool = 0;
        market.settled_result = SettledResult::Unsettled as u8;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;

        emit!(MarketCreated {
            market_id,
            fixture_id,
            stat_key_a,
            stat_key_b,
            op,
            comparison,
            threshold,
            close_unix_time,
        });

        Ok(())
    }

    /// Put money on yes or no. Funds move into the market vault and
    /// sit there untouched until settlement.
    pub fn place_position(
        ctx: Context<PlacePosition>,
        amount: u64,
        side_is_yes: bool,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open as u8, ProofballError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.close_unix_time,
            ProofballError::MarketClosed
        );
        require!(amount > 0, ProofballError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let position = &mut ctx.accounts.position;

        // Guard against switching sides. If position.amount is already
        // above zero, this account was initialized before, so check the
        // side matches. Without this check, a user could bet yes then
        // bet no and the two amounts would get added together under
        // one side_is_yes value, which would corrupt the payout math.
        if position.amount > 0 {
            require!(position.side_is_yes == side_is_yes, ProofballError::CannotSwitchSides);
        } else {
            position.side_is_yes = side_is_yes;
        }

        position.market = market.key();
        position.owner = ctx.accounts.user.key();
        position.amount = position.amount.checked_add(amount).ok_or(ProofballError::Overflow)?;
        position.claimed = false;
        position.bump = ctx.bumps.position;

        if side_is_yes {
            market.yes_pool = market.yes_pool.checked_add(amount).ok_or(ProofballError::Overflow)?;
        } else {
            market.no_pool = market.no_pool.checked_add(amount).ok_or(ProofballError::Overflow)?;
        }

        emit!(PositionPlaced {
            market_id: market.market_id,
            owner: position.owner,
            side_is_yes,
            amount,
        });

        Ok(())
    }

    /// Settle the market by asking TxLINE's program to check the stat
    /// condition for us through a cross program call.
    ///
    /// All the proof data (fixture_summary, fixture_proof, main_tree_proof,
    /// stat1, stat2) comes straight from TxLINE's
    /// GET /api/scores/stat-validation endpoint. We do not build or
    /// touch the Merkle proof ourselves, we just pass it through.
    ///
    /// This only writes market.settled_result, it does not move money.
    /// Call claim_payout separately for each winning position.
    pub fn settle_market<'info>(
        ctx: Context<'_, '_, '_, 'info, SettleMarket<'info>>,
        target_unix_time: i64,
        fixture_summary: txline::FixtureSummary,
        fixture_proof: Vec<txline::ProofNode>,
        main_tree_proof: Vec<txline::ProofNode>,
        stat1: StatProof,
        stat2: Option<StatProof>,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open as u8, ProofballError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= market.close_unix_time,
            ProofballError::MarketStillOpen
        );

        let predicate = Predicate {
            threshold: market.threshold,
            comparison: comparison_from_u8(market.comparison),
        };
        let op = if market.stat_key_b == 0 {
            None
        } else {
            Some(op_from_u8(market.op))
        };

        // This is the actual call into TxLINE's deployed program.
        // It is a read only simulation (their docs call it with .view()
        // off chain) but here we need the real instruction result on
        // chain, so we CPI into it directly and read back the bool.
        let result = txline::cpi_validate_stat(
            &ctx.accounts.txline_program,
            &ctx.accounts.daily_scores_merkle_roots,
            target_unix_time,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            predicate,
            stat1,
            stat2,
            op,
        )?;

        market.status = MarketStatus::Settled as u8;
        market.settled_result = if result {
            SettledResult::Yes as u8
        } else {
            SettledResult::No as u8
        };

        emit!(MarketSettled {
            market_id: market.market_id,
            fixture_id: market.fixture_id,
            result_is_yes: result,
            settled_at: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Pay out a winning position. Losing positions get nothing, there
    /// is nothing to claim for them. Payout is proportional: each
    /// winner gets their share of the whole pool (yes_pool + no_pool)
    /// based on how much they put into the winning side.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Settled as u8, ProofballError::NotSettled);

        let position = &mut ctx.accounts.position;
        require!(!position.claimed, ProofballError::AlreadyClaimed);

        let won = (market.settled_result == SettledResult::Yes as u8) == position.side_is_yes;
        require!(won, ProofballError::PositionLost);

        let winning_pool = if position.side_is_yes { market.yes_pool } else { market.no_pool };
        require!(winning_pool > 0, ProofballError::EmptyPool);

        let total_pool = market.yes_pool.checked_add(market.no_pool).ok_or(ProofballError::Overflow)?;

        // payout = position.amount * total_pool / winning_pool
        let payout = (position.amount as u128)
            .checked_mul(total_pool as u128)
            .ok_or(ProofballError::Overflow)?
            .checked_div(winning_pool as u128)
            .ok_or(ProofballError::Overflow)? as u64;

        position.claimed = true;

        let market_id_bytes = market.market_id.to_le_bytes();
        let seeds = &[b"vault", market_id_bytes.as_ref(), &[market.vault_bump]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;

        emit!(PayoutClaimed {
            market_id: market.market_id,
            owner: position.owner,
            amount: payout,
        });

        Ok(())
    }
}

fn comparison_from_u8(v: u8) -> Comparison {
    match v {
        0 => Comparison::GreaterThan,
        1 => Comparison::LessThan,
        2 => Comparison::Equal,
        _ => Comparison::GreaterThanOrEqual,
    }
}

fn op_from_u8(v: u8) -> Op {
    match v {
        0 => Op::Subtract,
        1 => Op::Add,
        _ => Op::Subtract,
    }
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = Market::SPACE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = creator,
        token::mint = stake_mint,
        token::authority = vault,
        seeds = [b"vault", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub stake_mint: anchor_spl::token::Mint,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlacePosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [b"vault", market.market_id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    // init_if_needed on purpose: a user can add to the same side more
    // than once before close time, and we just add the new amount on
    // top of what is already there. This is safe here because Anchor
    // only skips re-running init logic, it does not wipe existing
    // data, and place_position only ever increases position.amount,
    // it never resets it. If you ever add a way to change sides after
    // the first bet, revisit this, mixing yes and no into one amount
    // field would break payout math.
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    /// The daily_scores_roots PDA on TxLINE's own program. We pass this
    /// in as a plain account, TxLINE's program reads it during the CPI.
    /// CHECK: ownership and contents are checked by TxLINE's program
    /// during the CPI call, not by us. We only need the address.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: this must equal txline::TXLINE_PROGRAM_ID, checked in code
    pub txline_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [b"vault", market.market_id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = owner @ ProofballError::NotPositionOwner,
    )]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
}

// ---------- state ----------

#[account]
pub struct Market {
    pub creator: Pubkey,
    pub market_id: u64,
    pub fixture_id: u64,
    pub stat_key_a: u32,
    pub stat_key_b: u32,
    pub op: u8,
    pub comparison: u8,
    pub threshold: i64,
    pub close_unix_time: i64,
    pub status: u8,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub settled_result: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    // discriminator (8) + fields, with a small pad for future use
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + 4 + 1 + 1 + 8 + 8 + 1 + 8 + 8 + 1 + 1 + 1 + 16;
}

#[account]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side_is_yes: bool,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 1 + 1 + 8;
}

#[repr(u8)]
pub enum MarketStatus {
    Open = 0,
    Settled = 1,
}

#[repr(u8)]
pub enum SettledResult {
    Unsettled = 0,
    Yes = 1,
    No = 2,
}

// ---------- events ----------
// These exist so the verify CLI and the frontend can rebuild the full
// history of a market without us keeping our own off chain database.

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub fixture_id: u64,
    pub stat_key_a: u32,
    pub stat_key_b: u32,
    pub op: u8,
    pub comparison: u8,
    pub threshold: i64,
    pub close_unix_time: i64,
}

#[event]
pub struct PositionPlaced {
    pub market_id: u64,
    pub owner: Pubkey,
    pub side_is_yes: bool,
    pub amount: u64,
}

#[event]
pub struct MarketSettled {
    pub market_id: u64,
    pub fixture_id: u64,
    pub result_is_yes: bool,
    pub settled_at: i64,
}

#[event]
pub struct PayoutClaimed {
    pub market_id: u64,
    pub owner: Pubkey,
    pub amount: u64,
}

// ---------- errors ----------

#[error_code]
pub enum ProofballError {
    #[msg("close time must be in the future")]
    CloseTimeInPast,
    #[msg("comparison value out of range")]
    BadComparison,
    #[msg("op value out of range")]
    BadOp,
    #[msg("market is not open")]
    MarketNotOpen,
    #[msg("market has already closed for new positions")]
    MarketClosed,
    #[msg("market has not reached close time yet")]
    MarketStillOpen,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("market has not been settled yet")]
    NotSettled,
    #[msg("this position was already claimed")]
    AlreadyClaimed,
    #[msg("this position did not win")]
    PositionLost,
    #[msg("winning pool is empty, this should not happen")]
    EmptyPool,
    #[msg("number overflow")]
    Overflow,
    #[msg("signer does not own this position")]
    NotPositionOwner,
    #[msg("cannot bet on both sides of the same market from one account")]
    CannotSwitchSides,
}
