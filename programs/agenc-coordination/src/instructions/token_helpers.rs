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

/// Close an escrow token account, first sweeping any residual token dust to a
/// validated destination token account.
///
/// This hardens all close paths against unsolicited-token griefing where extra
/// inbound tokens would otherwise make `close_account` fail and revert the flow.
pub fn close_token_escrow_account_info<'info>(
    token_escrow: &AccountInfo<'info>,
    expected_residual_amount: u64,
    dust_recipient_ata: &AccountInfo<'info>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    // Sweep full live balance at close-time, not just caller-computed residuals.
    // This prevents close-account failures from unsolicited token deposits.
    let live_balance = token::accessor::amount(token_escrow)
        .map_err(|_| CoordinationError::TokenTransferFailed)?;
    if live_balance != expected_residual_amount {
        msg!(
            "token escrow close residual mismatch: expected {}, live {}",
            expected_residual_amount,
            live_balance
        );
    }

    if live_balance > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: token_escrow.clone(),
                    to: dust_recipient_ata.clone(),
                    authority: escrow_authority.clone(),
                },
                signer_seeds,
            ),
            live_balance,
        )
        .map_err(|_| CoordinationError::TokenTransferFailed)?;
    }

    token::close_account(CpiContext::new_with_signer(
        token_program.clone(),
        CloseAccount {
            account: token_escrow.clone(),
            destination: rent_recipient.clone(),
            authority: escrow_authority.clone(),
        },
        signer_seeds,
    ))
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

/// Close an escrow token account, returning rent to `rent_recipient` via PDA-signed CPI.
///
/// # Arguments
/// * `token_escrow` - The escrow's associated token account to close
/// * `residual_amount` - Known residual balance to sweep before close
/// * `dust_recipient_ata` - Token account that receives any residual token dust
/// * `rent_recipient` - Account to receive the rent-exempt lamports
/// * `escrow_authority` - The escrow PDA that owns the token account
/// * `escrow_seeds` - PDA signer seeds: `[b"escrow", task_key, &[bump]]`
/// * `token_program` - SPL Token program
pub fn close_token_escrow<'info>(
    token_escrow: &Account<'info, TokenAccount>,
    residual_amount: u64,
    dust_recipient_ata: &AccountInfo<'info>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    close_token_escrow_account_info(
        &token_escrow.to_account_info(),
        residual_amount,
        dust_recipient_ata,
        rent_recipient,
        escrow_authority,
        escrow_seeds,
        &token_program.to_account_info(),
    )
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

/// Validate an UncheckedAccount is a valid SPL token account with the expected mint
/// and authority (SPL token account owner).
///
/// Used for worker_token_account which is UncheckedAccount to allow flexible
/// destination, but must still be a valid token account with the correct mint
/// and must be owned by the expected authority to prevent reward theft.
///
/// SPL TokenAccount layout (first 72 bytes):
/// - bytes  0..32: mint pubkey
/// - bytes 32..64: owner (authority) pubkey
/// - bytes 64..72: amount (u64 LE)
pub fn validate_unchecked_token_mint(
    account: &AccountInfo,
    expected_mint: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<()> {
    require!(
        account.owner == &anchor_spl::token::ID,
        CoordinationError::InvalidTokenEscrow
    );
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, CoordinationError::InvalidTokenEscrow);

    // Validate mint (bytes 0..32)
    let mint_bytes: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    let mint = Pubkey::new_from_array(mint_bytes);
    require!(mint == *expected_mint, CoordinationError::InvalidTokenMint);

    // Validate token account authority (bytes 32..64)
    let owner_bytes: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    let owner = Pubkey::new_from_array(owner_bytes);
    require!(
        owner == *expected_owner,
        CoordinationError::InvalidTokenAccountOwner
    );

    Ok(())
}
