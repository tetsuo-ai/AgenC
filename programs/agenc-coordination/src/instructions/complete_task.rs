//! Complete a task and claim reward

use crate::errors::CoordinationError;
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, load_task_claim_or_not_claimed,
    validate_completion_prereqs, validate_task_dependency,
};
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskEscrow, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::compute_budget::log_compute_units;
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct CompleteTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// CHECK: Claim PDA is validated by seeds and loaded in the handler so a missing
    /// claim can surface `NotClaimed` instead of Anchor's `AccountNotInitialized`.
    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub claim: UncheckedAccount<'info>,

    /// Note: Escrow account is closed conditionally after the final completion.
    /// For collaborative tasks with multiple workers, it stays open until all complete.
    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    /// CHECK: Task creator receives escrow rent - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Treasury account for protocol fees - validated against protocol_config
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    /// Token escrow ATA holding reward tokens (optional)
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Worker's token account to receive reward (optional)
    /// CHECK: Validated in handler; ATA created via CPI if needed
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    /// Treasury's token account for protocol fees (optional, must pre-exist)
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CompleteTask<'info>>,
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    handle_complete_task(
        ctx.accounts,
        ctx.remaining_accounts,
        ctx.program_id,
        proof_hash,
        result_data,
    )
}

fn handle_complete_task<'info>(
    accounts: &mut CompleteTask<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    log_compute_units("complete_task_start");

    let task_key = accounts.task.key();
    let mut claim = load_task_claim_or_not_claimed(&accounts.claim, &task_key)?;
    let bid_settlement = load_bid_task_completion_meta(
        accounts.task.as_ref(),
        &task_key,
        &claim,
        remaining_accounts,
    )?;
    let reward_amount_override = bid_settlement
        .as_ref()
        .map(|settlement| settlement.accepted_bid_price);
    let task = &mut accounts.task;
    let escrow = &mut accounts.escrow;
    let worker = &mut accounts.worker;
    let clock = Clock::get()?;

    check_version_compatible(&accounts.protocol_config)?;

    // If task has a proof dependency, verify parent task is completed (shared helper)
    validate_task_dependency(task, remaining_accounts, program_id)?;

    // Use the protocol fee locked at task creation (#479), with reputation discount
    let protocol_fee_bps = calculate_fee_with_reputation(task.protocol_fee_bps, worker.reputation);

    // Validate proof_hash is not zero
    require!(proof_hash != [0u8; 32], CoordinationError::InvalidProofHash);

    // Validate result_data is not all zeros (when provided)
    if let Some(ref data) = result_data {
        require!(
            data.iter().any(|&b| b != 0),
            CoordinationError::InvalidResultData
        );
    }

    // Shared validation: status, transition, deadline, claim, competitive guard
    validate_completion_prereqs(task, &claim, &clock)?;

    // CRITICAL: Private tasks MUST use complete_task_private (ZK proof verification).
    // Without this guard, an attacker could bypass ZK proof requirements by calling
    // the public completion path on a task with a non-zero constraint_hash.
    require!(
        task.constraint_hash == [0u8; HASH_SIZE],
        CoordinationError::PrivateTaskRequiresZkProof
    );

    // Build optional token payment accounts
    let token_accounts = if task.reward_mint.is_some() {
        require!(
            accounts.token_escrow_ata.is_some()
                && accounts.worker_token_account.is_some()
                && accounts.treasury_token_account.is_some()
                && accounts.reward_mint.is_some()
                && accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = accounts
            .reward_mint
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_escrow = accounts
            .token_escrow_ata
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let treasury_ta = accounts
            .treasury_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = task
            .reward_mint
            .ok_or(CoordinationError::InvalidTokenMint)?;

        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );

        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
        validate_token_account(treasury_ta, &mint.key(), &accounts.protocol_config.treasury)?;
        let token_escrow_starting_amount =
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?;

        let worker_ta_info = accounts
            .worker_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?
            .to_account_info();
        validate_unchecked_token_mint(&worker_ta_info, &mint.key(), &accounts.authority.key())?;

        Some(TokenPaymentAccounts {
            token_escrow_ata: token_escrow.to_account_info(),
            token_escrow_starting_amount,
            worker_token_account: worker_ta_info,
            treasury_token_account: treasury_ta.to_account_info(),
            token_program: accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?
                .to_account_info(),
            escrow_authority: escrow.to_account_info(),
            escrow_bump: escrow.bump,
            task_key: task.key(),
        })
    } else {
        None
    };

    // Update claim fields (must be set before execute_completion_rewards)
    let claim_result_data = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
    claim.proof_hash = proof_hash;
    claim.result_data = claim_result_data;
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    log_compute_units("complete_task_validated");

    // Execute reward transfer, state updates, event emissions, and conditional escrow closure
    execute_completion_rewards(
        task,
        &mut claim,
        escrow,
        worker,
        &mut accounts.protocol_config,
        &accounts.authority.to_account_info(),
        &accounts.treasury.to_account_info(),
        &accounts.creator.to_account_info(),
        protocol_fee_bps,
        reward_amount_override,
        Some(claim_result_data),
        &clock,
        token_accounts,
    )?;

    if let Some(settlement) = &bid_settlement {
        finalize_bid_task_completion(
            remaining_accounts,
            &task_key,
            &claim,
            settlement,
            clock.unix_timestamp,
        )?;
    }

    claim.close(accounts.authority.to_account_info())?;

    log_compute_units("complete_task_done");

    Ok(())
}
