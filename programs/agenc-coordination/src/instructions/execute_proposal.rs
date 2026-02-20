//! Execute a governance proposal after voting period + timelock
//!
//! Dual outcome: if quorum or majority not met, the proposal is marked Defeated.
//! If quorum + majority are met and the timelock has elapsed, the proposal is executed.

use crate::errors::CoordinationError;
use crate::events::ProposalExecuted;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::state::{GovernanceConfig, Proposal, ProposalStatus, ProposalType, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Maximum rate limit value (matches update_rate_limits.rs)
const MAX_RATE_LIMIT: u64 = 1000;

/// Maximum cooldown value: 1 week in seconds (matches update_rate_limits.rs)
const MAX_COOLDOWN: i64 = 86400 * 7;

/// Minimum dispute stake to prevent free dispute spam (matches update_rate_limits.rs)
const MIN_DISPUTE_STAKE: u64 = 1000;

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref(), proposal.nonce.to_le_bytes().as_ref()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"governance"],
        bump = governance_config.bump
    )]
    pub governance_config: Box<Account<'info, GovernanceConfig>>,

    /// Executor can be anyone (permissionless after voting ends)
    pub executor: Signer<'info>,

    /// CHECK: Treasury account for TreasurySpend proposals.
    /// Must match protocol_config.treasury. Spend path supports:
    /// - program-owned treasury (direct lamport mutation), or
    /// - system-owned treasury when this account signs.
    #[account(mut)]
    pub treasury: Option<UncheckedAccount<'info>>,

    /// CHECK: Recipient for TreasurySpend proposals.
    /// Validated from proposal payload in handler.
    #[account(mut)]
    pub recipient: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let config = &mut ctx.accounts.protocol_config;
    let governance = &ctx.accounts.governance_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify proposal is active
    require!(
        proposal.status == ProposalStatus::Active,
        CoordinationError::ProposalNotActive
    );

    // Verify voting period has ended
    require!(
        clock.unix_timestamp >= proposal.voting_deadline,
        CoordinationError::ProposalVotingNotEnded
    );

    // Check quorum and approval — if not met, mark as Defeated
    let total_votes = proposal
        .votes_for
        .checked_add(proposal.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let quorum_met = total_votes >= proposal.quorum;

    // Approval threshold check: votes_for * 10000 > total_votes * threshold_bps
    let approval_met = if total_votes > 0 {
        let lhs = (proposal.votes_for as u128)
            .checked_mul(10000)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let rhs = (total_votes as u128)
            .checked_mul(governance.approval_threshold_bps as u128)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        lhs > rhs
    } else {
        false
    };

    if !quorum_met || !approval_met {
        proposal.status = ProposalStatus::Defeated;
        proposal.executed_at = clock.unix_timestamp;

        emit!(ProposalExecuted {
            proposal: proposal.key(),
            proposal_type: proposal.proposal_type as u8,
            votes_for: proposal.votes_for,
            votes_against: proposal.votes_against,
            total_voters: proposal.total_voters,
            timestamp: clock.unix_timestamp,
        });

        return Ok(());
    }

    // Verify execution timelock has elapsed
    require!(
        clock.unix_timestamp >= proposal.execution_after,
        CoordinationError::TimelockNotElapsed
    );

    // Execute based on proposal type
    match proposal.proposal_type {
        ProposalType::FeeChange => {
            let new_fee_bps = u16::from_le_bytes([proposal.payload[0], proposal.payload[1]]);
            require!(
                new_fee_bps <= MAX_PROTOCOL_FEE_BPS as u16,
                CoordinationError::InvalidProposalPayload
            );
            config.protocol_fee_bps = new_fee_bps;
        }
        ProposalType::TreasurySpend => {
            let recipient_bytes: [u8; 32] = proposal.payload[0..32]
                .try_into()
                .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?;
            let recipient_key = Pubkey::from(recipient_bytes);

            // Reject zero-pubkey recipient to prevent sending SOL to an unspendable address
            require!(
                recipient_key != Pubkey::default(),
                CoordinationError::InvalidProposalPayload
            );

            let amount = u64::from_le_bytes(
                proposal.payload[32..40]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );

            let treasury = ctx
                .accounts
                .treasury
                .as_ref()
                .ok_or(error!(CoordinationError::InvalidProposalPayload))?;
            let recipient = ctx
                .accounts
                .recipient
                .as_ref()
                .ok_or(error!(CoordinationError::InvalidProposalPayload))?;

            require!(
                treasury.key() == config.treasury,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                recipient.key() == recipient_key,
                CoordinationError::InvalidProposalPayload
            );

            require!(
                treasury.lamports() >= amount,
                CoordinationError::TreasuryInsufficientBalance
            );

            if treasury.owner == &crate::ID {
                // Program-owned treasury: mutate lamports directly.
                transfer_lamports(
                    &treasury.to_account_info(),
                    &recipient.to_account_info(),
                    amount,
                )?;
            } else if treasury.owner == &system_program::ID && treasury.is_signer {
                // System-owned treasury fallback: requires treasury signer at execution.
                // This keeps governance operable for legacy/system-wallet treasury setups.
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: treasury.to_account_info(),
                            to: recipient.to_account_info(),
                        },
                    ),
                    amount,
                )?;
            } else {
                return Err(CoordinationError::TreasuryNotSpendable.into());
            }
        }
        ProposalType::RateLimitChange => {
            // Payload layout:
            // [0..8]   task_creation_cooldown (i64 LE)
            // [8]      max_tasks_per_24h (u8)
            // [9..17]  dispute_initiation_cooldown (i64 LE)
            // [17]     max_disputes_per_24h (u8)
            // [18..26] min_stake_for_dispute (u64 LE)
            let task_creation_cooldown = i64::from_le_bytes(
                proposal.payload[0..8]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_tasks_per_24h = proposal.payload[8];
            let dispute_initiation_cooldown = i64::from_le_bytes(
                proposal.payload[9..17]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_disputes_per_24h = proposal.payload[17];
            let min_stake_for_dispute = u64::from_le_bytes(
                proposal.payload[18..26]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );

            // Validate bounds (same as update_rate_limits.rs)
            require!(
                task_creation_cooldown >= 0 && task_creation_cooldown <= MAX_COOLDOWN,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                dispute_initiation_cooldown >= 0 && dispute_initiation_cooldown <= MAX_COOLDOWN,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (max_tasks_per_24h as u64) <= MAX_RATE_LIMIT,
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (max_disputes_per_24h as u64) <= MAX_RATE_LIMIT,
                CoordinationError::InvalidProposalPayload
            );

            // Enforce minimum dispute stake (matches update_rate_limits.rs)
            require!(
                min_stake_for_dispute >= MIN_DISPUTE_STAKE,
                CoordinationError::InvalidProposalPayload
            );

            config.task_creation_cooldown = task_creation_cooldown;
            config.max_tasks_per_24h = max_tasks_per_24h;
            config.dispute_initiation_cooldown = dispute_initiation_cooldown;
            config.max_disputes_per_24h = max_disputes_per_24h;
            config.min_stake_for_dispute = min_stake_for_dispute;
        }
        ProposalType::ProtocolUpgrade => {
            // Protocol upgrade is a signaling marker — actual upgrade handled externally
        }
    }

    proposal.status = ProposalStatus::Executed;
    proposal.executed_at = clock.unix_timestamp;

    emit!(ProposalExecuted {
        proposal: proposal.key(),
        proposal_type: proposal.proposal_type as u8,
        votes_for: proposal.votes_for,
        votes_against: proposal.votes_against,
        total_voters: proposal.total_voters,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
