//! Shared SPL token transfer helpers for token-denominated task rewards.
//!
//! These functions handle token CPI calls (transfer, close) with PDA-signed contexts.
//! The escrow PDA acts as the token authority for all token operations.

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

/// Transfer tokens from escrow ATA to a recipient ATA using PDA-signed CPI.
///
/// # Arguments
/// * `token_escrow` - The escrow's associated token account (source)
/// * `recipient_ata` - The recipient's associated token account (destination)
/// * `escrow_authority` - The escrow PDA that owns the token account
/// * `amount` - Number of tokens to transfer
/// * `escrow_seeds` - PDA signer seeds: `[b"escrow", task_key, &[bump]]`
/// * `token_program` - SPL Token program
pub fn transfer_tokens_from_escrow<'info>(
    token_escrow: &Account<'info, TokenAccount>,
    recipient_ata: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    amount: u64,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: token_escrow.to_account_info(),
                to: recipient_ata.clone(),
                authority: escrow_authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

/// Close an escrow token account, returning rent to `rent_recipient` via PDA-signed CPI.
///
/// # Arguments
/// * `token_escrow` - The escrow's associated token account to close
/// * `rent_recipient` - Account to receive the rent-exempt lamports
/// * `escrow_authority` - The escrow PDA that owns the token account
/// * `escrow_seeds` - PDA signer seeds: `[b"escrow", task_key, &[bump]]`
/// * `token_program` - SPL Token program
pub fn close_token_escrow<'info>(
    token_escrow: &Account<'info, TokenAccount>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: token_escrow.to_account_info(),
            destination: rent_recipient.clone(),
            authority: escrow_authority.clone(),
        },
        signer_seeds,
    ))
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

/// Validate that a token account has the expected mint and owner.
pub fn validate_token_account(
    token_account: &TokenAccount,
    expected_mint: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<()> {
    require!(
        token_account.mint == *expected_mint,
        CoordinationError::InvalidTokenMint
    );
    require!(
        token_account.owner == *expected_owner,
        CoordinationError::InvalidTokenEscrow
    );
    Ok(())
}
