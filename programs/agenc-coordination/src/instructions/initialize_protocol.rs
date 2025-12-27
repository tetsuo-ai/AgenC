//! Initialize protocol configuration

use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::errors::CoordinationError;
use crate::events::ProtocolInitialized;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SIZE,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Treasury account to receive protocol fees
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeProtocol>,
    dispute_threshold: u8,
    protocol_fee_bps: u16,
    min_stake: u64,
) -> Result<()> {
    require!(
        dispute_threshold > 0 && dispute_threshold <= 100,
        CoordinationError::InvalidDisputeThreshold
    );
    require!(
        protocol_fee_bps <= 1000, // Max 10%
        CoordinationError::InvalidProtocolFee
    );

    let config = &mut ctx.accounts.protocol_config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.treasury.key();
    config.dispute_threshold = dispute_threshold;
    config.protocol_fee_bps = protocol_fee_bps;
    config.min_arbiter_stake = min_stake;
    config.total_agents = 0;
    config.total_tasks = 0;
    config.completed_tasks = 0;
    config.total_value_distributed = 0;
    config.bump = ctx.bumps.protocol_config;

    emit!(ProtocolInitialized {
        authority: config.authority,
        treasury: config.treasury,
        dispute_threshold,
        protocol_fee_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
