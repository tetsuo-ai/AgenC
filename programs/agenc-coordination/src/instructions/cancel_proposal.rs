//! Cancel a governance proposal before any votes are cast
//!
//! Only the proposer's authority can cancel, and only if no votes have been cast yet.
//! Follows the same pattern as cancel_dispute.rs.

use crate::errors::CoordinationError;
use crate::events::ProposalCancelled;
use crate::state::{Proposal, ProposalStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref(), proposal.nonce.to_le_bytes().as_ref()],
        bump = proposal.bump,
        constraint = proposal.status == ProposalStatus::Active @ CoordinationError::ProposalNotActive
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        constraint = authority.key() == proposal.proposer_authority @ CoordinationError::ProposalUnauthorizedCancel
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<CancelProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let clock = Clock::get()?;

    // Can only cancel if no votes have been cast
    require!(
        proposal.total_voters == 0,
        CoordinationError::ProposalVotingEnded
    );

    proposal.status = ProposalStatus::Cancelled;
    proposal.executed_at = clock.unix_timestamp;

    emit!(ProposalCancelled {
        proposal: proposal.key(),
        proposer: proposal.proposer,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
