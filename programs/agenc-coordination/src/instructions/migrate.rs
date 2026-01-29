//! Protocol migration instruction
//!
//! Handles state migration between protocol versions.
//! Only callable by the upgrade authority (multisig gated).

use crate::errors::CoordinationError;
use crate::events::{MigrationCompleted, ProtocolVersionUpdated};
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::require_multisig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct MigrateProtocol<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

/// Migrate protocol configuration to a new version
/// This instruction handles state changes required when upgrading the program
///
/// # Arguments
/// * `target_version` - The version to migrate to
///
/// # Migration Flow
/// 1. Verify caller has upgrade authority (multisig)
/// 2. Validate source and target versions
/// 3. Apply version-specific migrations
/// 4. Update version fields
/// 5. Emit migration event
pub fn handler(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Require multisig approval for migrations
    require_multisig(config, ctx.remaining_accounts)?;

    let current_version = config.protocol_version;

    // Validate migration path
    require!(
        target_version > current_version,
        CoordinationError::InvalidMigrationTarget
    );
    require!(
        target_version <= CURRENT_PROTOCOL_VERSION,
        CoordinationError::InvalidMigrationTarget
    );
    require!(
        current_version >= MIN_SUPPORTED_VERSION,
        CoordinationError::InvalidMigrationSource
    );

    // Apply migrations sequentially
    for version in (current_version + 1)..=target_version {
        apply_migration(config, version)?;
    }

    // Update version
    let old_version = config.protocol_version;
    config.protocol_version = target_version;

    // Only emit MigrationCompleted if there was an authority in remaining_accounts
    if let Some(authority_account) = ctx.remaining_accounts.first() {
        emit!(MigrationCompleted {
            from_version: old_version,
            to_version: target_version,
            authority: authority_account.key(),
            timestamp: clock.unix_timestamp,
        });
    }

    emit!(ProtocolVersionUpdated {
        old_version,
        new_version: target_version,
        min_supported_version: config.min_supported_version,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Apply migration for a specific version
/// Add new version handlers here as the protocol evolves
///
/// # Arguments
/// * `_config` - Protocol configuration to mutate. Currently unused but reserved
///   for future migrations that will need to initialize new fields or transform
///   existing data (e.g., `config.new_field = default_value`).
/// * `version` - Target version to migrate to
fn apply_migration(_config: &mut ProtocolConfig, version: u8) -> Result<()> {
    match version {
        1 => {
            // Version 1 is the initial version, no migration needed
            Ok(())
        }
        // Version 2 migration is intentionally a no-op
        // Placeholder for future schema changes
        2 => {
            // No-op: Reserved for future use
            Ok(())
        }
        _ => {
            // Unknown version - this shouldn't happen if validation is correct
            Err(CoordinationError::InvalidMigrationTarget.into())
        }
    }
}

/// Update minimum supported version (for deprecating old versions)
#[derive(Accounts)]
pub struct UpdateMinVersion<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn update_min_version_handler(
    ctx: Context<UpdateMinVersion>,
    new_min_version: u8,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Require multisig approval
    require_multisig(config, ctx.remaining_accounts)?;

    // Validate new minimum version
    require!(
        new_min_version >= MIN_SUPPORTED_VERSION && new_min_version <= CURRENT_PROTOCOL_VERSION,
        CoordinationError::InvalidMigrationTarget
    );

    // Ensure min_version does not exceed current protocol version
    require!(
        new_min_version <= config.protocol_version,
        CoordinationError::InvalidMinVersion
    );

    let old_min = config.min_supported_version;
    config.min_supported_version = new_min_version;

    emit!(ProtocolVersionUpdated {
        old_version: config.protocol_version,
        new_version: config.protocol_version,
        min_supported_version: new_min_version,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Updated min_supported_version from {} to {}",
        old_min,
        new_min_version
    );

    Ok(())
}
