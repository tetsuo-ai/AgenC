//! Create a governance proposal

use crate::errors::CoordinationError;
use crate::events::ProposalCreated;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::state::{
    AgentRegistration, AgentStatus, GovernanceConfig, Proposal, ProposalStatus, ProposalType,
    ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Maximum rate limit value (matches update_rate_limits.rs)
const MAX_RATE_LIMIT: u64 = 1000;

/// Maximum cooldown value: 1 week in seconds (matches update_rate_limits.rs)
const MAX_COOLDOWN: i64 = 86400 * 7;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateProposal<'info> {
    #[account(
        init,
        payer = authority,
        space = Proposal::SIZE,
        seeds = [b"proposal", proposer.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        seeds = [b"agent", proposer.agent_id.as_ref()],
        bump = proposer.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub proposer: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"governance"],
        bump = governance_config.bump
    )]
    pub governance_config: Box<Account<'info, GovernanceConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateProposal>,
    nonce: u64,
    proposal_type: u8,
    title_hash: [u8; 32],
    description_hash: [u8; 32],
    payload: [u8; 64],
    voting_period: i64,
) -> Result<()> {
    let proposer = &ctx.accounts.proposer;
    let config = &ctx.accounts.protocol_config;
    let governance = &mut ctx.accounts.governance_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify proposer is active
    require!(
        proposer.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Require minimum stake to create proposals
    require!(
        proposer.stake >= governance.min_proposal_stake,
        CoordinationError::ProposalInsufficientStake
    );

    // Validate proposal type
    let prop_type = match proposal_type {
        0 => ProposalType::ProtocolUpgrade,
        1 => ProposalType::FeeChange,
        2 => ProposalType::TreasurySpend,
        3 => ProposalType::RateLimitChange,
        _ => return Err(error!(CoordinationError::InvalidProposalType)),
    };

    // Validate payload at creation time for typed proposals
    match prop_type {
        ProposalType::FeeChange => {
            let fee_bps = u16::from_le_bytes([payload[0], payload[1]]);
            require!(
                fee_bps <= MAX_PROTOCOL_FEE_BPS,
                CoordinationError::InvalidProposalPayload
            );
        }
        ProposalType::RateLimitChange => {
            // Same bounds as execute_proposal.rs and update_rate_limits.rs
            let task_creation_cooldown = i64::from_le_bytes(
                payload[0..8]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_tasks_per_24h = payload[8];
            let dispute_initiation_cooldown = i64::from_le_bytes(
                payload[9..17]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );
            let max_disputes_per_24h = payload[17];

            require!(
                (0..=MAX_COOLDOWN).contains(&task_creation_cooldown),
                CoordinationError::InvalidProposalPayload
            );
            require!(
                (0..=MAX_COOLDOWN).contains(&dispute_initiation_cooldown),
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
        }
        _ => {}
    }

    // Compute quorum: min_proposal_stake * max(total_agents * quorum_bps / 10000, 2)
    // Minimum quorum_factor of 2 ensures at least two independent vote-weights are
    // needed to pass a proposal, preventing solo proposal execution.
    let quorum_factor = config
        .total_agents
        .checked_mul(governance.quorum_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10000)
        .unwrap_or(0)
        .max(2);
    let quorum = governance
        .min_proposal_stake
        .checked_mul(quorum_factor)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Voting period: use governance config value (capped at MAX), or provided value
    let effective_voting_period = if voting_period > 0 {
        voting_period.min(GovernanceConfig::MAX_VOTING_PERIOD)
    } else {
        governance.voting_period
    };

    let voting_deadline = clock
        .unix_timestamp
        .checked_add(effective_voting_period)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let execution_after = voting_deadline
        .checked_add(governance.execution_delay)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.proposer_authority = ctx.accounts.authority.key();
    proposal.nonce = nonce;
    proposal.proposal_type = prop_type;
    proposal.title_hash = title_hash;
    proposal.description_hash = description_hash;
    proposal.payload = payload;
    proposal.status = ProposalStatus::Active;
    proposal.created_at = clock.unix_timestamp;
    proposal.voting_deadline = voting_deadline;
    proposal.execution_after = execution_after;
    proposal.executed_at = 0;
    proposal.votes_for = 0;
    proposal.votes_against = 0;
    proposal.total_voters = 0;
    proposal.quorum = quorum;
    proposal.bump = ctx.bumps.proposal;
    proposal._reserved = [0u8; 64];

    // Increment governance proposal counter
    governance.total_proposals = governance
        .total_proposals
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(ProposalCreated {
        proposer: proposer.key(),
        proposal_type,
        title_hash,
        voting_deadline,
        quorum,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
