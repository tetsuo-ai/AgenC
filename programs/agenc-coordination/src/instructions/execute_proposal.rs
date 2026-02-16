//! Execute an approved governance proposal after voting period

use crate::errors::CoordinationError;
use crate::events::ProposalExecuted;
use crate::instructions::constants::MAX_PROTOCOL_FEE_BPS;
use crate::state::{Proposal, ProposalStatus, ProposalType, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

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

    /// Executor can be anyone (permissionless after voting ends)
    pub executor: Signer<'info>,

    /// CHECK: Treasury account for TreasurySpend proposals.
    /// Validated to match protocol_config.treasury in handler.
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

    // Check quorum: total votes must meet minimum threshold
    let total_votes = proposal
        .votes_for
        .checked_add(proposal.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        total_votes >= proposal.quorum,
        CoordinationError::ProposalInsufficientQuorum
    );

    // Check majority: more votes for than against
    require!(
        proposal.votes_for > proposal.votes_against,
        CoordinationError::ProposalNotApproved
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
            // Extract recipient (bytes 0-31) and amount (bytes 32-39) from payload
            let recipient_bytes: [u8; 32] = proposal.payload[0..32]
                .try_into()
                .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?;
            let recipient_key = Pubkey::from(recipient_bytes);
            let amount = u64::from_le_bytes(
                proposal.payload[32..40]
                    .try_into()
                    .map_err(|_| error!(CoordinationError::InvalidProposalPayload))?,
            );

            // Validate treasury and recipient accounts are provided
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

            // Transfer lamports from treasury to recipient
            require!(
                treasury.lamports() >= amount,
                CoordinationError::TreasuryInsufficientBalance
            );

            **treasury.try_borrow_mut_lamports()? = treasury
                .lamports()
                .checked_sub(amount)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            **recipient.try_borrow_mut_lamports()? = recipient
                .lamports()
                .checked_add(amount)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
        }
        ProposalType::ProtocolUpgrade => {
            // Protocol upgrade is a marker — actual upgrade handled externally
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
