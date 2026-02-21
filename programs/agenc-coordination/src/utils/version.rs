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

    #[test]
    fn test_check_version_compatible_version_mismatch() {
        // min_supported_version 5 > CURRENT_PROTOCOL_VERSION 1
        let config = make_config(1, 5);
        assert!(check_version_compatible(&config).is_err());
    }
}
