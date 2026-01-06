//! Update protocol fee (multisig gated)

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::ProtocolConfig;
use crate::utils::multisig::require_multisig;

#[derive(Accounts)]
pub struct UpdateProtocolFee<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn handler(
    ctx: Context<UpdateProtocolFee>,
    protocol_fee_bps: u16,
) -> Result<()> {
    require!(
        protocol_fee_bps <= 1000,
        CoordinationError::InvalidProtocolFee
    );

    require_multisig(&ctx.accounts.protocol_config, ctx.remaining_accounts)?;

    let config = &mut ctx.accounts.protocol_config;
    config.protocol_fee_bps = protocol_fee_bps;

    Ok(())
}
