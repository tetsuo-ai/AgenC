//! Initialize protocol configuration

use crate::errors::CoordinationError;
use crate::events::ProtocolInitialized;
use crate::instructions::constants::{MAX_PERCENT, MAX_PROTOCOL_FEE_BPS};
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::validate_multisig_owners;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SIZE,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Treasury account to receive protocol fees
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// Second multisig signer required at initialization to prevent single-party setup.
    /// Must be different from authority and must be in multisig_owners.
    /// This ensures at least two parties are involved in protocol initialization (fix #556).
    pub second_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Minimum reasonable stake value (0.001 SOL in lamports)
const MIN_REASONABLE_STAKE: u64 = 1_000_000;

pub fn handler(
    ctx: Context<InitializeProtocol>,
    dispute_threshold: u8,
    protocol_fee_bps: u16,
    min_stake: u64,
    multisig_threshold: u8,
    multisig_owners: Vec<Pubkey>,
) -> Result<()> {
    // Validate parameters BEFORE writing any config
    require!(
        dispute_threshold > 0 && dispute_threshold <= MAX_PERCENT,
        CoordinationError::InvalidDisputeThreshold
    );
    require!(
        protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
        CoordinationError::InvalidProtocolFee
    );
    // Ensure minimum stake is sensible (fixes #586)
    require!(
        min_stake >= MIN_REASONABLE_STAKE,
        CoordinationError::StakeTooLow
    );
    require!(
        !multisig_owners.is_empty(),
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        multisig_owners.len() <= ProtocolConfig::MAX_MULTISIG_OWNERS,
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        multisig_threshold > 0 && (multisig_threshold as usize) <= multisig_owners.len(),
        CoordinationError::MultisigInvalidThreshold
    );

    // Validate multisig owners BEFORE writing config (fix #61)
    validate_multisig_owners(&multisig_owners)?;

    // Fix #556: Require second_signer to be different from authority
    // This prevents a single party from initializing the protocol alone
    require!(
        ctx.accounts.authority.key() != ctx.accounts.second_signer.key(),
        CoordinationError::MultisigDuplicateSigner
    );

    // Both authority and second_signer must be in multisig_owners
    require!(
        multisig_owners.contains(&ctx.accounts.authority.key()),
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        multisig_owners.contains(&ctx.accounts.second_signer.key()),
        CoordinationError::MultisigInvalidSigners
    );

    // Count signers: authority + second_signer + any additional in remaining_accounts
    let mut valid_signers = 2usize; // authority and second_signer are always counted

    // Add any additional signers from remaining_accounts
    for acc in ctx.remaining_accounts.iter() {
        if acc.is_signer
            && multisig_owners.contains(acc.key)
            && acc.key != &ctx.accounts.authority.key()
            && acc.key != &ctx.accounts.second_signer.key()
        {
            valid_signers += 1;
        }
    }

    require!(
        valid_signers >= multisig_threshold as usize,
        CoordinationError::MultisigNotEnoughSigners
    );

    // Now safe to write config
    let config = &mut ctx.accounts.protocol_config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.treasury.key();
    config.dispute_threshold = dispute_threshold;
    config.protocol_fee_bps = protocol_fee_bps;
    config.min_arbiter_stake = min_stake;
    config.min_agent_stake = min_stake;
    config.max_claim_duration = ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION;
    config.max_dispute_duration = ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION;
    config.total_agents = 0;
    config.total_tasks = 0;
    config.completed_tasks = 0;
    config.total_value_distributed = 0;
    config.bump = ctx.bumps.protocol_config;
    config.multisig_threshold = multisig_threshold;
    config.multisig_owners_len = multisig_owners.len() as u8;
    // Rate limiting defaults (can be updated post-deployment via update instruction)
    config.task_creation_cooldown = 60; // 60 seconds between task creations
    config.max_tasks_per_24h = 50; // 50 tasks per 24h window
    config.dispute_initiation_cooldown = 300; // 5 minutes between disputes
    config.max_disputes_per_24h = 10; // 10 disputes per 24h window
    config.min_stake_for_dispute = 0; // No stake required by default
    config.slash_percentage = ProtocolConfig::DEFAULT_SLASH_PERCENTAGE;
    // Versioning
    config.protocol_version = CURRENT_PROTOCOL_VERSION;
    config.min_supported_version = MIN_SUPPORTED_VERSION;
    config._padding = [0u8; 2];
    config.multisig_owners = [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS];
    for (index, owner) in multisig_owners.iter().enumerate() {
        config.multisig_owners[index] = *owner;
    }

    emit!(ProtocolInitialized {
        authority: config.authority,
        treasury: config.treasury,
        dispute_threshold,
        protocol_fee_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
