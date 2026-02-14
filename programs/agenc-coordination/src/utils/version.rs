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

/// Check if the protocol version is compatible (boolean version)
///
/// Returns true if:
/// - Account's min_supported_version is at least the global MIN_SUPPORTED_VERSION
/// - Account's protocol_version is at least its min_supported_version (current >= min_required)
/// - Account's protocol_version does not exceed CURRENT_PROTOCOL_VERSION
#[inline]
pub fn is_version_compatible(config: &ProtocolConfig) -> bool {
    config.min_supported_version >= MIN_SUPPORTED_VERSION
        && config.protocol_version >= config.min_supported_version
        && config.protocol_version <= CURRENT_PROTOCOL_VERSION
}

/// Log version information for debugging
pub fn log_version_info(config: &ProtocolConfig) {
    msg!("Protocol Version Info:");
    msg!("  Account version: {}", config.protocol_version);
    msg!("  Program version: {}", CURRENT_PROTOCOL_VERSION);
    msg!("  Min supported: {}", MIN_SUPPORTED_VERSION);
    msg!("  Account min supported: {}", config.min_supported_version);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(protocol_version: u8, min_supported_version: u8) -> ProtocolConfig {
        ProtocolConfig {
            protocol_version,
            min_supported_version,
            ..ProtocolConfig::default()
        }
    }

    #[test]
    fn test_current_version_is_compatible() {
        let config = make_config(1, 1);
        assert!(is_version_compatible(&config));
    }

    #[test]
    fn test_version_0_is_too_old() {
        // min_supported_version (0) < MIN_SUPPORTED_VERSION (1) -> incompatible
        let config = make_config(0, 0);
        assert!(!is_version_compatible(&config));
    }

    #[test]
    fn test_version_2_is_too_new() {
        // protocol_version 2 > CURRENT_PROTOCOL_VERSION 1
        let config = make_config(2, 1);
        assert!(!is_version_compatible(&config));
    }

    #[test]
    fn test_version_255_is_too_new() {
        let config = make_config(255, 1);
        assert!(!is_version_compatible(&config));
    }

    #[test]
    fn test_min_supported_exceeds_current() {
        // min_supported_version 5 > CURRENT_PROTOCOL_VERSION 1
        let config = make_config(1, 5);
        assert!(!is_version_compatible(&config));
    }

    #[test]
    fn test_protocol_version_below_own_min() {
        // protocol_version 1 but min_supported 2 -> min_supported > CURRENT
        let config = make_config(1, 2);
        assert!(!is_version_compatible(&config));
    }

    #[test]
    fn test_version_status_current() {
        let config = make_config(1, 1);
        assert_eq!(get_version_status(&config), VersionStatus::Current);
    }

    #[test]
    fn test_version_status_too_new() {
        let config = make_config(5, 1);
        assert_eq!(get_version_status(&config), VersionStatus::TooNew);
    }

    #[test]
    fn test_version_status_too_old() {
        // protocol_version < min_supported_version
        let config = make_config(0, 1);
        assert_eq!(get_version_status(&config), VersionStatus::TooOld);
    }

    #[test]
    fn test_check_version_compatible_ok() {
        let config = make_config(1, 1);
        assert!(check_version_compatible(&config).is_ok());
    }

    #[test]
    fn test_check_version_compatible_too_new() {
        let config = make_config(2, 1);
        assert!(check_version_compatible(&config).is_err());
    }

    #[test]
    fn test_check_version_compatible_too_old() {
        // protocol_version < min_supported_version
        let config = make_config(0, 1);
        assert!(check_version_compatible(&config).is_err());
    }
}
