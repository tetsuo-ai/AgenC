//! Update protocol fee (multisig gated)

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::ProtocolFeeUpdated;
use crate::state::ProtocolConfig;
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};

#[derive(Accounts)]
pub struct UpdateProtocolFee<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateProtocolFee>, protocol_fee_bps: u16) -> Result<()> {
    require!(
        protocol_fee_bps <= 1000,
        CoordinationError::InvalidProtocolFee
    );
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let config = &mut ctx.accounts.protocol_config;
    let old_fee_bps = config.protocol_fee_bps;
    config.protocol_fee_bps = protocol_fee_bps;

    emit!(ProtocolFeeUpdated {
        old_fee_bps,
        new_fee_bps: protocol_fee_bps,
        updated_by: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
