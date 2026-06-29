// Bindings for calling into TxLINE's own on-chain program.
//
// IMPORTANT: read this comment before changing anything here.
//
// TxLINE already runs its own Merkle proof checker on chain, through an
// instruction called validateStat. Their docs show calling it like this
// off chain (see /documentation/examples/onchain-validation):
//
//   program.methods.validateStat(
//     targetTs, fixtureSummary, fixtureProof, mainTreeProof,
//     predicate, stat1, stat2, op
//   ).accounts({ dailyScoresMerkleRoots: dailyScoresPda }).view()
//
// That is a read only simulation call from a client. We need the same
// check to happen inside our own settle_market instruction, so our
// program calls validateStat through a real cross program invocation
// instead of a client side simulation.
//
// What is CONFIRMED from TxLINE's published docs (as of writing this):
//   - Program ID, mainnet: 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA
//   - Program ID, devnet:  6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
//   - The daily_scores_roots PDA seeds: ["daily_scores_roots", epochDay as u16 le bytes]
//   - The instruction name: validateStat
//   - The argument order: targetTs, fixtureSummary, fixtureProof,
//     mainTreeProof, predicate, stat1, stat2 (optional), op (optional)
//   - The shape of FixtureSummary, ProofNode, Predicate, StatToProve,
//     Comparison, and Op, taken from the same example
//   - Soccer stat key encoding: period * 1000 + base_key, see
//     /documentation/scores/soccer-feed
//
// What is NOT fully confirmed and needs checking once you have Codespaces
// open with real devnet access:
//   - The exact Anchor account list validateStat expects beyond
//     dailyScoresMerkleRoots. Their example only shows one account in
//     the .accounts({...}) call, but a real CPI also needs the program
//     id account itself and possibly a sysvar account for clock or
//     instruction introspection. Pull the real IDL from
//     /documentation/programs/devnet and slot in the exact accounts.
//   - The precise byte layout Anchor generates for the instruction
//     discriminator. The download_idl.sh script in scripts/ fetches
//     the real IDL so you can regenerate this file with anchor's own
//     CPI crate instead of the hand written version below.
//
// Treat everything below as a strongly informed draft, not gospel.
// The fastest fix once you are in Codespaces: run scripts/download_idl.sh,
// then swap this hand rolled module for the generated txline_cpi crate
// anchor builds from that IDL. The instruction call in lib.rs
// (txline::cpi_validate_stat) is written so that swap only touches
// this one file.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

pub const TXLINE_PROGRAM_ID_MAINNET: &str = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
pub const TXLINE_PROGRAM_ID_DEVNET: &str = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateStats {
    pub update_count: u32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FixtureSummary {
    pub fixture_id: u64,
    pub update_stats: UpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    Equal,
    GreaterThanOrEqual,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Predicate {
    pub threshold: i64,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatToProve {
    pub stat_key: u32,
    pub value: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatProof {
    pub stat_to_prove: StatToProve,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Op {
    Subtract,
    Add,
}

/// Calls TxLINE's validateStat instruction through a real CPI and
/// returns the bool result.
///
/// This function builds the instruction by hand right now because we
/// do not have TxLINE's generated CPI crate vendored yet. Once
/// scripts/download_idl.sh has been run, replace the body of this
/// function with a call through their generated cpi module, it will
/// be safer than the hand built version below.
pub fn cpi_validate_stat<'info>(
    txline_program: &UncheckedAccount<'info>,
    daily_scores_merkle_roots: &UncheckedAccount<'info>,
    target_unix_time: i64,
    fixture_summary: FixtureSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: Predicate,
    stat1: StatProof,
    stat2: Option<StatProof>,
    op: Option<Op>,
) -> Result<bool> {
    // Anchor instruction discriminator is the first 8 bytes of
    // sha256("global:validate_stat"). This is Anchor's standard scheme.
    // Confirm this matches the real deployed program once you have the
    // IDL, in case TxLINE used a custom discriminator.
    let mut data = anchor_lang::solana_program::hash::hash(b"global:validate_stat")
        .to_bytes()[..8]
        .to_vec();

    target_unix_time.serialize(&mut data)?;
    fixture_summary.serialize(&mut data)?;
    fixture_proof.serialize(&mut data)?;
    main_tree_proof.serialize(&mut data)?;
    predicate.serialize(&mut data)?;
    stat1.serialize(&mut data)?;
    stat2.serialize(&mut data)?;
    op.serialize(&mut data)?;

    let instruction = Instruction {
        program_id: txline_program.key(),
        accounts: vec![AccountMeta::new_readonly(daily_scores_merkle_roots.key(), false)],
        data,
    };

    invoke(
        &instruction,
        &[
            daily_scores_merkle_roots.to_account_info(),
            txline_program.to_account_info(),
        ],
    )?;

    // NOTE: reading a bool return value back from a CPI call is not as
    // simple as a normal function return in Solana, the callee does not
    // hand a value back up the call stack the way a normal Rust call
    // does. TxLINE's own client code reads this through .view(), which
    // simulates the transaction and reads the return data set by the
    // program through solana_program::program::set_return_data.
    //
    // On the real CPI path, anchor_lang::solana_program::program::get_return_data()
    // reads exactly that value right after the invoke call above, as
    // long as TxLINE's program sets return data before returning, which
    // is the standard pattern for Anchor instructions that return a value.
    // This is marked clearly because it is the single most important
    // thing to verify first when you start integration testing.
    match anchor_lang::solana_program::program::get_return_data() {
        Some((_program_id, bytes)) if !bytes.is_empty() => Ok(bytes[0] != 0),
        _ => Err(error!(crate::ProofballError::Overflow)),
    }
}
