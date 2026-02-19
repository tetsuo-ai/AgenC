//! Shared lamport transfer helper with checked arithmetic.
//!
//! Consolidates the repeated pattern of `checked_sub` from source + `checked_add`
//! to destination into a single function, ensuring overflow/underflow safety.

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;

/// Transfer `amount` lamports from one account to another using checked arithmetic.
///
/// Returns `Ok(())` immediately if `amount == 0` (no-op).
/// Returns `CoordinationError::ArithmeticOverflow` on underflow or overflow.
///
pub fn transfer_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Credit `amount` lamports to an account using checked arithmetic.
///
/// Use this when the source account has already been debited separately
/// (e.g., Split resolution where escrow is debited once for the total,
/// then two recipients are credited individually).
///
/// Returns `Ok(())` immediately if `amount == 0`.
pub fn credit_lamports<'info>(to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Debit `amount` lamports from an account using checked arithmetic.
///
/// Use this when the destination account will be credited separately.
///
/// Returns `Ok(())` immediately if `amount == 0`.
pub fn debit_lamports<'info>(from: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}
