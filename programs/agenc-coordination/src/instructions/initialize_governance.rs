//! Initialize governance configuration
//!
//! Creates the GovernanceConfig PDA that controls proposal creation parameters,
//! voting periods, execution delays, and quorum thresholds.
//!
//! Must be called by the protocol authority (matches ProtocolConfig.authority).

use crate::errors::CoordinationError;
use crate::events::GovernanceInitialized;
use crate::state::{GovernanceConfig, ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(
        init,
        payer = authority,
        space = GovernanceConfig::SIZE,
        seeds = [b"governance"],
        bump
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = authority.key() == protocol_config.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeGovernance>,
    voting_period: i64,
    execution_delay: i64,
    quorum_bps: u16,
    approval_threshold_bps: u16,
    min_proposal_stake: u64,
) -> Result<()> {
    // Validate voting period
    require!(
        voting_period > 0 && voting_period <= GovernanceConfig::MAX_VOTING_PERIOD,
        CoordinationError::InvalidGovernanceParam
    );

    // Validate execution delay
    require!(
        execution_delay >= 0 && execution_delay <= GovernanceConfig::MAX_EXECUTION_DELAY,
        CoordinationError::InvalidGovernanceParam
    );

    // Validate quorum (1-10000 bps)
    require!(
        quorum_bps > 0 && quorum_bps <= 10000,
        CoordinationError::InvalidGovernanceParam
    );

    // Validate approval threshold (1-10000 bps, typically 5000+ for majority)
    require!(
        approval_threshold_bps > 0 && approval_threshold_bps <= 10000,
        CoordinationError::InvalidGovernanceParam
    );

    // Validate min proposal stake
    require!(
        min_proposal_stake > 0,
        CoordinationError::InvalidGovernanceParam
    );

    let governance = &mut ctx.accounts.governance_config;
    governance.authority = ctx.accounts.authority.key();
    governance.min_proposal_stake = min_proposal_stake;
    governance.voting_period = voting_period;
    governance.execution_delay = execution_delay;
    governance.quorum_bps = quorum_bps;
    governance.approval_threshold_bps = approval_threshold_bps;
    governance.total_proposals = 0;
    governance.bump = ctx.bumps.governance_config;
    governance._reserved = [0u8; 64];

    let clock = Clock::get()?;
    emit!(GovernanceInitialized {
        authority: governance.authority,
        voting_period,
        execution_delay,
        quorum_bps,
        approval_threshold_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
