//! Update multisig owners and threshold (multisig gated).
//!
//! Hardening goals:
//! - Allow signer rotation to recover from key loss/compromise.
//! - Prevent accidental lockouts by validating new signer set thoroughly.

use crate::errors::CoordinationError;
use crate::events::MultisigUpdated;
use crate::state::ProtocolConfig;
use crate::utils::multisig::{require_multisig, validate_multisig_owners};
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use std::collections::BTreeSet;

#[derive(Accounts)]
pub struct UpdateMultisig<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn handler(
    ctx: Context<UpdateMultisig>,
    new_threshold: u8,
    new_owners: Vec<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    require_multisig(config, ctx.remaining_accounts)?;

    require!(
        !new_owners.is_empty(),
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        new_owners.len() <= ProtocolConfig::MAX_MULTISIG_OWNERS,
        CoordinationError::MultisigInvalidSigners
    );
    // Keep the same safety invariant used during protocol initialization:
    // threshold must be strictly less than owner count to preserve recovery
    // capacity if one key is lost.
    require!(
        new_threshold >= 2 && (new_threshold as usize) < new_owners.len(),
        CoordinationError::MultisigInvalidThreshold
    );
    validate_multisig_owners(&new_owners)?;

    // Additional hardening: require that enough signers from the *new* set are
    // present in this update transaction. This prevents rotating to an
    // unreachable signer set due to typo/misconfiguration.
    let mut counted = BTreeSet::new();
    let mut new_set_approvals = 0usize;
    for account in ctx.remaining_accounts {
        if account.is_signer
            && account.owner == &system_program::ID
            && new_owners.contains(account.key)
            && !counted.contains(account.key)
        {
            counted.insert(*account.key);
            new_set_approvals += 1;
        }
    }
    require!(
        new_set_approvals >= new_threshold as usize,
        CoordinationError::MultisigNotEnoughSigners
    );

    let old_threshold = config.multisig_threshold;
    let old_owner_count = config.multisig_owners_len;

    config.multisig_threshold = new_threshold;
    config.multisig_owners_len = new_owners.len() as u8;
    config.multisig_owners = [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS];
    for (index, owner) in new_owners.iter().enumerate() {
        config.multisig_owners[index] = *owner;
    }

    let updated_by = ctx
        .remaining_accounts
        .iter()
        .find(|account| account.is_signer)
        .map(|account| account.key())
        .unwrap_or_default();

    emit!(MultisigUpdated {
        old_threshold,
        new_threshold,
        old_owner_count,
        new_owner_count: config.multisig_owners_len,
        updated_by,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
