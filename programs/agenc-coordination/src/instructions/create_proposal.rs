//! Create a governance proposal

use crate::errors::CoordinationError;
use crate::events::ProposalCreated;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::state::{
    AgentRegistration, AgentStatus, Proposal, ProposalStatus, ProposalType, ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Maximum voting period: 7 days
const MAX_VOTING_PERIOD: i64 = 7 * 24 * 60 * 60;

/// Default voting period: 3 days
const DEFAULT_VOTING_PERIOD: i64 = 3 * 24 * 60 * 60;

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
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify proposer is active
    require!(
        proposer.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Require minimum stake to create proposals
    require!(
        proposer.stake >= config.min_arbiter_stake,
        CoordinationError::ProposalInsufficientStake
    );

    // Validate proposal type
    let prop_type = match proposal_type {
        0 => ProposalType::ProtocolUpgrade,
        1 => ProposalType::FeeChange,
        2 => ProposalType::TreasurySpend,
        _ => return Err(error!(CoordinationError::InvalidProposalType)),
    };

    // Validate payload for specific types
    if prop_type == ProposalType::FeeChange {
        let fee_bps = u16::from_le_bytes([payload[0], payload[1]]);
        require!(
            fee_bps <= MAX_PROTOCOL_FEE_BPS as u16,
            CoordinationError::InvalidProposalPayload
        );
    }

    // Compute quorum: min_arbiter_stake * max(total_agents / 10, 1)
    let divisor = config.total_agents.checked_div(10).unwrap_or(1).max(1);
    let quorum = config
        .min_arbiter_stake
        .checked_mul(divisor)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Voting period: use provided value (capped at MAX_VOTING_PERIOD), or default
    let effective_voting_period = if voting_period > 0 {
        voting_period.min(MAX_VOTING_PERIOD)
    } else {
        DEFAULT_VOTING_PERIOD
    };

    let voting_deadline = clock
        .unix_timestamp
        .checked_add(effective_voting_period)
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
    proposal.executed_at = 0;
    proposal.votes_for = 0;
    proposal.votes_against = 0;
    proposal.total_voters = 0;
    proposal.quorum = quorum;
    proposal.bump = ctx.bumps.proposal;

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
