//! Shared validation helpers for instruction handlers

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;

/// Validates an agent endpoint URL.
///
/// - Empty strings are allowed (agent may not have a public endpoint)
/// - Non-empty endpoints must start with "http://" or "https://"
/// - Maximum length is 128 characters
pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    // Allow empty (agent may not have public endpoint)
    if endpoint.is_empty() {
        return Ok(());
    }

    // Must start with http:// or https://
    require!(
        endpoint.starts_with("http://") || endpoint.starts_with("https://"),
        CoordinationError::InvalidInput
    );

    // Length check
    require!(endpoint.len() <= 128, CoordinationError::StringTooLong);

    Ok(())
}
