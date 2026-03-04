//! Update protocol treasury (multisig gated).
//!
//! This provides a safe recovery path if the original treasury configuration
//! becomes unusable, and allows rotating treasury custody over time.

use crate::errors::CoordinationError;
use crate::events::TreasuryUpdated;
use crate::state::ProtocolConfig;
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Validated in handler.
    /// Must be either:
    /// - program-owned (preferred), or
    /// - a system-owned signer account (legacy compatibility).
    pub new_treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateTreasury>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let new_treasury = &ctx.accounts.new_treasury;
    require!(
        new_treasury.key() != Pubkey::default(),
        CoordinationError::InvalidTreasury
    );

    let is_program_owned = new_treasury.owner == &crate::ID;
    let is_system_owned_signer =
        new_treasury.owner == &system_program::ID && new_treasury.is_signer;
    require!(
        is_program_owned || is_system_owned_signer,
        CoordinationError::TreasuryNotSpendable
    );

    let config = &mut ctx.accounts.protocol_config;
    require!(
        new_treasury.key() != config.treasury,
        CoordinationError::InvalidInput
    );

    let old_treasury = config.treasury;
    config.treasury = new_treasury.key();

    let updated_by = ctx.accounts.authority.key();

    emit!(TreasuryUpdated {
        old_treasury,
        new_treasury: config.treasury,
        updated_by,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
