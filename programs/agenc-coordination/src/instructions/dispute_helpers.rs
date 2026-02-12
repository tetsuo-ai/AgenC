//! Shared helper functions for dispute resolution and expiration.
//!
//! These helpers process `remaining_accounts` for both `resolve_dispute` and
//! `expire_dispute` instructions, avoiding code duplication across the two
//! instruction handlers.

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::instructions::validation::validate_account_owner;
use crate::state::{AgentRegistration, DisputeVote, TaskClaim};
use anchor_lang::prelude::*;

/// Validates the structure of remaining_accounts for dispute processing.
///
/// Ensures:
/// - At least `total_voters * 2` accounts are present (vote, arbiter pairs)
/// - Any extra accounts come in pairs (claim, worker)
///
/// Returns the number of arbiter accounts (total_voters * 2).
pub(crate) fn validate_remaining_accounts_structure(
    remaining_accounts: &[AccountInfo],
    total_voters: u8,
) -> Result<usize> {
    let arbiter_accounts = (total_voters as usize)
        .checked_mul(2)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Validate we have at least enough accounts for arbiters
    require!(
        remaining_accounts.len() >= arbiter_accounts,
        CoordinationError::InvalidInput
    );

    // Additional accounts must come in pairs (claim, worker)
    let extra_accounts = remaining_accounts.len() - arbiter_accounts;
    require!(extra_accounts % 2 == 0, CoordinationError::InvalidInput);

    Ok(arbiter_accounts)
}

/// Checks for duplicate arbiters in remaining_accounts (fix #583).
///
/// Iterates over (vote, arbiter) pairs and ensures no arbiter appears twice.
pub(crate) fn check_duplicate_arbiters(
    remaining_accounts: &[AccountInfo],
    arbiter_accounts: usize,
) -> Result<()> {
    let mut seen_arbiters: HashSet<Pubkey> = HashSet::new();
    for i in (0..arbiter_accounts).step_by(2) {
        let arbiter_key = remaining_accounts[i + 1].key();
        require!(
            seen_arbiters.insert(arbiter_key),
            CoordinationError::DuplicateArbiter
        );
    }
    Ok(())
}

/// Checks for duplicate workers in remaining_accounts (fix #826).
///
/// Iterates over (claim, worker) pairs and ensures no worker appears twice.
/// This prevents `active_tasks` over-decrement via repeated `saturating_sub(1)`.
pub(crate) fn check_duplicate_workers(
    remaining_accounts: &[AccountInfo],
    arbiter_accounts: usize,
    primary_worker: Option<Pubkey>,
) -> Result<()> {
    let mut seen_workers: HashSet<Pubkey> = HashSet::new();
    if let Some(worker_key) = primary_worker {
        seen_workers.insert(worker_key);
    }
    for i in (arbiter_accounts..remaining_accounts.len()).step_by(2) {
        let worker_key = remaining_accounts[i + 1].key();
        require!(
            seen_workers.insert(worker_key),
            CoordinationError::InvalidInput
        );
    }
    Ok(())
}

/// Processes a single (vote, arbiter) pair from remaining_accounts.
///
/// Validates ownership, deserializes the vote, verifies it belongs to the dispute
/// and matches the arbiter, then decrements the arbiter's active_dispute_votes counter.
pub(crate) fn process_arbiter_vote_pair(
    vote_info: &AccountInfo,
    arbiter_info: &AccountInfo,
    dispute_key: &Pubkey,
) -> Result<()> {
    validate_account_owner(vote_info)?;
    validate_account_owner(arbiter_info)?;

    let vote_data = vote_info.try_borrow_data()?;
    let vote = DisputeVote::try_deserialize(&mut &**vote_data)?;
    require!(
        vote.dispute == *dispute_key,
        CoordinationError::InvalidInput
    );
    require!(
        vote.voter == arbiter_info.key(),
        CoordinationError::InvalidInput
    );
    drop(vote_data);

    require!(arbiter_info.is_writable, CoordinationError::InvalidInput);
    let mut arbiter_data = arbiter_info.try_borrow_mut_data()?;
    let mut arbiter = AgentRegistration::try_deserialize(&mut &**arbiter_data)?;
    // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
    arbiter.active_dispute_votes = arbiter.active_dispute_votes.saturating_sub(1);
    arbiter.try_serialize(&mut &mut arbiter_data[8..])?;

    Ok(())
}

/// Processes a single (claim, worker) pair from remaining_accounts.
///
/// Validates ownership, deserializes the claim, verifies it belongs to the task
/// and matches the worker, then decrements the worker's active_tasks counter.
/// Used for collaborative tasks where multiple workers claimed the task.
pub(crate) fn process_worker_claim_pair(
    claim_info: &AccountInfo,
    worker_info: &AccountInfo,
    task_key: &Pubkey,
) -> Result<()> {
    validate_account_owner(claim_info)?;
    validate_account_owner(worker_info)?;

    let claim_data = claim_info.try_borrow_data()?;
    let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
    require!(claim.task == *task_key, CoordinationError::InvalidInput);
    require!(
        claim.worker == worker_info.key(),
        CoordinationError::InvalidInput
    );
    drop(claim_data);

    require!(worker_info.is_writable, CoordinationError::InvalidInput);
    let mut worker_data = worker_info.try_borrow_mut_data()?;
    let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
    // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
    worker_reg.active_tasks = worker_reg.active_tasks.saturating_sub(1);
    worker_reg.try_serialize(&mut &mut worker_data[8..])?;

    Ok(())
}
