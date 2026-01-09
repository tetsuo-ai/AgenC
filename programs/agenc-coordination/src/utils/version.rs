//! Version checking utilities for protocol upgrades

use crate::errors::CoordinationError;
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use anchor_lang::prelude::*;

/// Check that the protocol version is compatible with the current program
///
/// # Arguments
/// * `config` - The protocol configuration account
///
/// # Returns
/// * `Ok(())` if version is compatible
/// * `Err(CoordinationError::AccountVersionTooOld)` if account needs migration
/// * `Err(CoordinationError::AccountVersionTooNew)` if program needs upgrade
/// * `Err(CoordinationError::VersionMismatchProtocol)` if config is inconsistent
pub fn check_version_compatible(config: &ProtocolConfig) -> Result<()> {
    // Check if account version is below its minimum supported version
    if config.protocol_version < config.min_supported_version {
        msg!(
            "Account version {} is below its minimum supported {}",
            config.protocol_version,
            config.min_supported_version
        );
        return Err(CoordinationError::AccountVersionTooOld.into());
    }

    // Check if account version is too new (program needs upgrade)
    if config.protocol_version > CURRENT_PROTOCOL_VERSION {
        msg!(
            "Account version {} is newer than program version {}",
            config.protocol_version,
            CURRENT_PROTOCOL_VERSION
        );
        return Err(CoordinationError::AccountVersionTooNew.into());
    }

    // Check for invalid minimum supported version
    if config.min_supported_version < MIN_SUPPORTED_VERSION
        || config.min_supported_version > CURRENT_PROTOCOL_VERSION
    {
        msg!(
            "Account min_supported_version {} is outside supported range {}-{}",
            config.min_supported_version,
            MIN_SUPPORTED_VERSION,
            CURRENT_PROTOCOL_VERSION
        );
        return Err(CoordinationError::VersionMismatchProtocol.into());
    }

    Ok(())
}

/// Check version and return detailed status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionStatus {
    /// Version is current
    Current,
    /// Version is compatible but not the latest
    CompatibleOld,
    /// Version is too old, migration required
    TooOld,
    /// Version is too new, program upgrade required
    TooNew,
}

pub fn get_version_status(config: &ProtocolConfig) -> VersionStatus {
    if config.protocol_version < config.min_supported_version {
        VersionStatus::TooOld
    } else if config.protocol_version > CURRENT_PROTOCOL_VERSION {
        VersionStatus::TooNew
    } else if config.protocol_version < CURRENT_PROTOCOL_VERSION {
        VersionStatus::CompatibleOld
    } else {
        VersionStatus::Current
    }
}

/// Log version information for debugging
pub fn log_version_info(config: &ProtocolConfig) {
    msg!("Protocol Version Info:");
    msg!("  Account version: {}", config.protocol_version);
    msg!("  Program version: {}", CURRENT_PROTOCOL_VERSION);
    msg!("  Min supported: {}", MIN_SUPPORTED_VERSION);
    msg!("  Account min supported: {}", config.min_supported_version);
}
