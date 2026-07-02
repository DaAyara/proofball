// Bindings for calling into TxLINE's own on-chain program.
//
// This file used to be a guess built from doc examples. It is no longer
// a guess. Everything below was checked against the real IDL pulled by
// scripts/download_idl.sh into docs/txline-idl/devnet.md, on 2026-06-29.
// If TxLINE ships a new version of their program, re-run that script
// and re-check this file before trusting it again.
//
// What changed once we had the real IDL, in case anyone reads the git
// history and wonders why this looks different from an earlier draft:
//   - validate_stat takes exactly one account, daily_scores_merkle_roots.
//     No program account, no signer needed for that account itself. This
//     is good news, it means a clean CPI is the right shape, not a
//     client only simulation trick.
//   - The real Anchor discriminator for validate_stat is published in
//     the IDL directly, so we no longer compute it from a hash guess.
//   - Field and type names are different from the doc examples:
//     statA / statB, not stat1 / stat2. TraderPredicate, not Predicate.
//     BinaryExpression, not Op. ScoresBatchSummary, not FixtureSummary.
//   - Comparison only has three variants: greater_than, less_than,
//     equal_to. There is no greater_than_or_equal, an earlier draft of
//     this file wrongly invented a fourth variant.
//   - ScoreStat.value is i32, not i64. TraderPredicate.threshold is i32
//     too. Both were wrongly written as i64 in the earlier draft, this
//     would have caused a real serialization mismatch against the
//     deployed program if left unfixed.
//
// One more thing worth knowing: TxLINE's own program already has a full
// one to one trade system built in (create_trade, settle_trade), but it
// needs both traders to sign before a trade exists, with fixed stakes
// agreed up front. It has no pooled market where many people can each
// put in different amounts on yes or no without already having a
// matched counterparty. That is the actual gap Proofball fills, this
// is not a duplicate of what TxLINE already ships, it is the pooled
// version of something they only offer as a one to one handshake.

use anchor_lang::prelude::{AccountInfo, Result, UncheckedAccount};
use anchor_lang::{AnchorDeserialize, AnchorSerialize};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

pub const TXLINE_PROGRAM_ID_MAINNET: &str = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
pub const TXLINE_PROGRAM_ID_DEVNET: &str = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

// The real discriminator for validate_stat, copied straight from
// docs/txline-idl/devnet.md. Do not regenerate this from a hash, use
// this exact byte array.
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

/// Matches the real IDL name ScoresBatchSummary. The doc examples
/// called this FixtureSummary, that name does not exist in the real
/// program.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

/// Real IDL only has three variants. No greater_than_or_equal.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

/// Matches the real IDL name TraderPredicate. Threshold is i32, not
/// i64, matching ScoreStat.value below.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

/// The leaf of the inner most Merkle tree, per the IDL's own doc
/// comment. key is u32, value and period are both i32.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

/// Matches the real IDL name StatTerm. The doc examples called this
/// StatProof, that name does not exist in the real program, only the
/// field inside it (stat_proof) shares that word.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

/// Matches the real IDL name BinaryExpression. Two variants, add and
/// subtract, same as the doc examples guessed, this one was right.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

/// Calls TxLINE's validate_stat instruction through a real cross
/// program invocation and returns the bool result.
///
/// Argument order matches the real IDL exactly: ts, fixture_summary,
/// fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op.
pub fn cpi_validate_stat<'info>(
    txline_program: &AccountInfo<'info>,
    daily_scores_merkle_roots: &AccountInfo<'info>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<bool> {
    let mut data = VALIDATE_STAT_DISCRIMINATOR.to_vec();

    ts.serialize(&mut data)?;
    fixture_summary.serialize(&mut data)?;
    fixture_proof.serialize(&mut data)?;
    main_tree_proof.serialize(&mut data)?;
    predicate.serialize(&mut data)?;
    stat_a.serialize(&mut data)?;
    stat_b.serialize(&mut data)?;
    op.serialize(&mut data)?;

    // The IDL lists exactly one account for this instruction:
    // daily_scores_merkle_roots, not marked as a signer or as
    // writable. Nothing else goes in the account list, no program
    // account entry, no system program, nothing.
    let instruction = Instruction {
        program_id: txline_program.key.clone(),
        accounts: vec![AccountMeta::new_readonly(daily_scores_merkle_roots.key.clone(), false)],
        data,
    };

    invoke(
        &instruction,
        &[
            daily_scores_merkle_roots.clone(),
            txline_program.clone(),
        ],
    )?;

    // validate_stat is not declared with a return type field in the
    // IDL excerpt we have, only its args are documented. The doc
    // example reads its result back through .view() off chain, which
    // works through transaction simulation logs, not return data.
    // On a real CPI path that exact mechanism does not carry over
    // automatically. This still needs a live test against devnet to
    // confirm how the result actually comes back, possibly through
    // set_return_data, possibly through a different account being
    // written to, possibly through the instruction simply erroring
    // out on a false predicate instead of returning false. Treat the
    // line below as the first thing to test, not as settled.
    match anchor_lang::solana_program::program::get_return_data() {
        Some((_program_id, bytes)) if !bytes.is_empty() => Ok(bytes[0] != 0),
        _ => Err(anchor_lang::error::Error::from(
            anchor_lang::error::ErrorCode::AccountDidNotDeserialize,
        )),
    }
}