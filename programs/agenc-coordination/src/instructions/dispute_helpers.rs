//! Shared helper functions for dispute resolution logic.
//!
//! Used by both `resolve_dispute` and `expire_dispute` instructions.
//!
//! # Why These Helpers Exist
//!
//! Both resolve_dispute and expire_dispute need to:
//! - Validate and process arbiter (vote, arbiter) pairs from remaining_accounts
//! - Validate and process worker (claim, worker) pairs for collaborative tasks
//! - Check for duplicate arbiters
//! - Decrement counters on AgentRegistration accounts
//!
//! Extracting this logic reduces duplication and ensures consistent validation.

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::state::{AgentRegistration, DisputeVote, TaskClaim};
use anchor_lang::prelude::*;

/// Configuration for how to decrement arbiter vote counters.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DecrementMode {
    /// Use checked_sub and return error on underflow (resolve_dispute)
    Checked,
    /// Use saturating_sub, clamping to 0 on underflow (expire_dispute)
    Saturating,
}

/// Configuration for processing worker accounts.
#[derive(Clone, Copy)]
pub struct WorkerProcessingOptions {
    /// Whether to also decrement disputes_as_defendant counter
    pub decrement_disputes_as_defendant: bool,
}

impl Default for WorkerProcessingOptions {
    fn default() -> Self {
        Self {
            decrement_disputes_as_defendant: false,
        }
    }
}

/// Validates the structure of remaining_accounts for dispute processing.
///
/// # Arguments
/// * `remaining_accounts` - The remaining accounts from the instruction context
/// * `total_voters` - Number of arbiters who voted (from dispute.total_voters)
///
/// # Returns
/// * Number of accounts dedicated to arbiters (total_voters * 2)
///
/// # Errors
/// * `InvalidInput` if there aren't enough accounts for arbiters
/// * `InvalidInput` if extra accounts (workers) aren't in pairs
/// * `ArithmeticOverflow` if total_voters * 2 overflows
pub fn validate_remaining_accounts_structure(
    remaining_accounts: &[AccountInfo],
    total_voters: u8,
) -> Result<usize> {
    let arbiter_accounts = total_voters
        .checked_mul(2)
        .ok_or(CoordinationError::ArithmeticOverflow)? as usize;

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

/// Checks for duplicate arbiters in remaining_accounts.
///
/// Arbiters are at odd indices (1, 3, 5, ...) within the arbiter_accounts range.
///
/// # Errors
/// * `DuplicateArbiter` if the same arbiter appears multiple times
pub fn check_duplicate_arbiters(
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

/// Processes arbiter (vote, arbiter) pairs from remaining_accounts.
///
/// For each pair:
/// 1. Validates account ownership (must be owned by this program)
/// 2. Validates vote belongs to the dispute
/// 3. Validates vote.voter matches arbiter account
/// 4. Decrements arbiter's active_dispute_votes counter
///
/// # Arguments
/// * `remaining_accounts` - The remaining accounts from instruction context
/// * `arbiter_accounts` - Number of accounts for arbiters (from validate_remaining_accounts_structure)
/// * `dispute_key` - The dispute's public key for validation
/// * `decrement_mode` - Whether to use checked or saturating subtraction
/// * `program_id` - This program's ID for ownership validation
pub fn process_arbiter_pairs<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    arbiter_accounts: usize,
    dispute_key: Pubkey,
    decrement_mode: DecrementMode,
    program_id: &Pubkey,
) -> Result<()> {
    for i in (0..arbiter_accounts).step_by(2) {
        let vote_info = &remaining_accounts[i];
        let arbiter_info = &remaining_accounts[i + 1];

        // CRITICAL: Validate account ownership before deserialization
        // Without this check, attackers could pass fake accounts not owned by this program
        require!(
            vote_info.owner == program_id,
            CoordinationError::InvalidAccountOwner
        );
        require!(
            arbiter_info.owner == program_id,
            CoordinationError::InvalidAccountOwner
        );

        // Validate vote account
        let vote_data = vote_info.try_borrow_data()?;
        let vote = DisputeVote::try_deserialize(&mut &**vote_data)?;
        require!(vote.dispute == dispute_key, CoordinationError::InvalidInput);
        require!(
            vote.voter == arbiter_info.key(),
            CoordinationError::InvalidInput
        );
        drop(vote_data);

        require!(arbiter_info.is_writable, CoordinationError::InvalidInput);

        // Decrement active_dispute_votes on arbiter
        let mut arbiter_data = arbiter_info.try_borrow_mut_data()?;
        let mut arbiter = AgentRegistration::try_deserialize(&mut &**arbiter_data)?;

        arbiter.active_dispute_votes = match decrement_mode {
            DecrementMode::Checked => arbiter
                .active_dispute_votes
                .checked_sub(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?,
            DecrementMode::Saturating => arbiter.active_dispute_votes.saturating_sub(1),
        };

        // Serialize back, skipping discriminator (already validated during deserialize)
        arbiter.try_serialize(&mut &mut arbiter_data[8..])?;
    }

    Ok(())
}

/// Processes worker (claim, worker) pairs from remaining_accounts.
///
/// For collaborative tasks, multiple workers may have claimed the task.
/// This function decrements their active_tasks counters.
///
/// # Arguments
/// * `remaining_accounts` - The remaining accounts from instruction context
/// * `arbiter_accounts` - Starting index for worker pairs (end of arbiter pairs)
/// * `task_key` - The task's public key for validation
/// * `options` - Processing options (e.g., whether to decrement disputes_as_defendant)
/// * `program_id` - This program's ID for ownership validation
pub fn process_worker_pairs<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    arbiter_accounts: usize,
    task_key: Pubkey,
    options: WorkerProcessingOptions,
    program_id: &Pubkey,
) -> Result<()> {
    for i in (arbiter_accounts..remaining_accounts.len()).step_by(2) {
        let claim_info = &remaining_accounts[i];
        let worker_info = &remaining_accounts[i + 1];

        // Validate account ownership
        require!(
            claim_info.owner == program_id,
            CoordinationError::InvalidAccountOwner
        );
        require!(
            worker_info.owner == program_id,
            CoordinationError::InvalidAccountOwner
        );

        // Validate claim belongs to this task
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
        require!(claim.task == task_key, CoordinationError::InvalidInput);
        require!(
            claim.worker == worker_info.key(),
            CoordinationError::InvalidInput
        );
        drop(claim_data);

        // Decrement worker's active_tasks (and optionally disputes_as_defendant)
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
        worker_reg.active_tasks = worker_reg.active_tasks.saturating_sub(1);

        if options.decrement_disputes_as_defendant {
            worker_reg.disputes_as_defendant = worker_reg.disputes_as_defendant.saturating_sub(1);
        }

        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

    Ok(())
}

/// Processes all remaining_accounts for dispute resolution/expiration.
///
/// This is a convenience function that combines all validation and processing steps:
/// 1. Validates remaining_accounts structure
/// 2. Checks for duplicate arbiters
/// 3. Processes arbiter pairs
/// 4. Processes worker pairs
///
/// # Arguments
/// * `remaining_accounts` - The remaining accounts from instruction context
/// * `total_voters` - Number of arbiters who voted
/// * `dispute_key` - The dispute's public key
/// * `task_key` - The task's public key
/// * `decrement_mode` - Checked (error on underflow) or Saturating (clamp to 0)
/// * `worker_options` - Options for processing worker accounts
/// * `program_id` - This program's ID for ownership validation
pub fn process_remaining_accounts<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    total_voters: u8,
    dispute_key: Pubkey,
    task_key: Pubkey,
    decrement_mode: DecrementMode,
    worker_options: WorkerProcessingOptions,
    program_id: &Pubkey,
) -> Result<()> {
    let arbiter_accounts =
        validate_remaining_accounts_structure(remaining_accounts, total_voters)?;

    check_duplicate_arbiters(remaining_accounts, arbiter_accounts)?;

    process_arbiter_pairs(
        remaining_accounts,
        arbiter_accounts,
        dispute_key,
        decrement_mode,
        program_id,
    )?;

    process_worker_pairs(
        remaining_accounts,
        arbiter_accounts,
        task_key,
        worker_options,
        program_id,
    )?;

    Ok(())
}
