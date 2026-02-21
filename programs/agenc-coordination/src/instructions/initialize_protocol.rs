//! Initialize protocol configuration
//!
//! # Parameters
//!
//! - `dispute_threshold`: Minimum percentage of arbiter votes needed to resolve a dispute.
//!   Must be in range 1-99 (inclusive). A value of 50 means majority vote required.
//!   100% is disallowed as it makes disputes impossible to approve.
//! - `protocol_fee_bps`: Fee charged on task completions in basis points (max 1000 = 10%).
//! - `min_stake`: Minimum stake required for agent/arbiter registration.
//! - `min_stake_for_dispute`: Minimum stake required to initiate a dispute (must be > 0).
//! - `multisig_threshold`: Number of signatures required for multisig operations.
//! - `multisig_owners`: List of authorized multisig signers.

use crate::errors::CoordinationError;
use crate::events::ProtocolInitialized;
use crate::instructions::constants::{
    DEFAULT_DISPUTE_INITIATION_COOLDOWN, DEFAULT_MAX_DISPUTES_PER_24H,
    DEFAULT_MAX_TASKS_PER_24H, DEFAULT_TASK_CREATION_COOLDOWN, MAX_PROTOCOL_FEE_BPS,
};
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::validate_multisig_owners;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

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
    // NOTE: remaining_accounts[0] must be the program's ProgramData account (fix #839).
    // Validated in handler: PDA derivation + owner check + upgrade authority match.
}

/// Minimum reasonable stake value (0.001 SOL in lamports)
const MIN_REASONABLE_STAKE: u64 = 1_000_000;

/// Initialize the protocol configuration with the given parameters.
///
/// # Arguments
///
/// * `dispute_threshold` - Minimum percentage of arbiter votes needed to resolve a dispute.
///   Valid range: 1-99 (inclusive). For example, 50 requires majority consensus,
///   67 requires supermajority. 100% is disallowed as it makes disputes impossible to approve.
/// * `protocol_fee_bps` - Protocol fee in basis points (0-1000, where 1000 = 10%).
/// * `min_stake` - Minimum stake required for registration (must be >= 0.001 SOL).
/// * `min_stake_for_dispute` - Minimum stake required to initiate a dispute (must be > 0).
/// * `multisig_threshold` - Number of signatures required for multisig operations.
/// * `multisig_owners` - List of authorized multisig signers.
///
/// # Errors
///
/// Returns [`CoordinationError::InvalidDisputeThreshold`] if dispute_threshold is 0 or >= 100.
/// Returns [`CoordinationError::InvalidMinStake`] if min_stake_for_dispute is 0.
pub fn handler(
    ctx: Context<InitializeProtocol>,
    dispute_threshold: u8,
    protocol_fee_bps: u16,
    min_stake: u64,
    min_stake_for_dispute: u64,
    multisig_threshold: u8,
    multisig_owners: Vec<Pubkey>,
) -> Result<()> {
    // Verify the caller is the program's upgrade authority (fix #839)
    // The ProgramData account must be passed as remaining_accounts[0]
    let program_data_info = ctx
        .remaining_accounts
        .first()
        .ok_or(CoordinationError::UnauthorizedUpgrade)?;

    // Verify the ProgramData PDA matches: findProgramAddress([program_id], bpf_loader_upgradeable)
    let (expected_program_data, _) =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::id());
    require!(
        program_data_info.key() == expected_program_data,
        CoordinationError::UnauthorizedUpgrade
    );

    // Verify the account is owned by BPF Loader Upgradeable
    require!(
        program_data_info.owner == &bpf_loader_upgradeable::id(),
        CoordinationError::InvalidAccountOwner
    );

    // Deserialize ProgramData and verify upgrade authority matches signer
    let data = program_data_info.try_borrow_data()?;
    // ProgramData layout: 4 bytes (enum tag) + 8 bytes (slot) + 1 byte (option tag) + 32 bytes (authority)
    // Total offset to authority option: 12, authority pubkey at: 13
    require!(data.len() >= 45, CoordinationError::CorruptedData);
    let has_authority = data[12];
    require!(has_authority == 1, CoordinationError::UnauthorizedUpgrade); // Must have upgrade authority
    let authority_bytes: [u8; 32] = data[13..45]
        .try_into()
        .map_err(|_| error!(CoordinationError::CorruptedData))?;
    let upgrade_authority = Pubkey::new_from_array(authority_bytes);
    require!(
        upgrade_authority == ctx.accounts.authority.key(),
        CoordinationError::UnauthorizedUpgrade
    );
    drop(data);

    // Threshold must be 1-99, not 100
    // 100% makes disputes impossible to approve (fixes #484)
    require!(
        dispute_threshold > 0 && dispute_threshold < 100,
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
    // Require min_stake_for_dispute > 0 (fixes #499)
    require!(
        min_stake_for_dispute > 0,
        CoordinationError::InvalidMinStake
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
        // Fix #505: Require threshold < owners count to ensure protocol remains
        // operational even if one key is lost. This prevents lockout scenarios.
        multisig_threshold > 0 && (multisig_threshold as usize) < multisig_owners.len(),
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

    // Fix #822: Track counted keys to prevent duplicate signer entries from inflating the count
    let mut counted_keys = std::collections::BTreeSet::new();
    counted_keys.insert(ctx.accounts.authority.key());
    counted_keys.insert(ctx.accounts.second_signer.key());

    // Add any additional signers from remaining_accounts (skip [0] which is ProgramData)
    for acc in ctx.remaining_accounts.iter().skip(1) {
        // Fix #840: Match require_multisig validation — only system-owned accounts
        // can be valid multisig signers. This prevents PDAs that are signers via CPI
        // from being counted during initialization but rejected during runtime operations.
        if acc.is_signer
            && acc.owner == &anchor_lang::system_program::ID
            && multisig_owners.contains(acc.key)
            && !counted_keys.contains(acc.key)
        {
            counted_keys.insert(*acc.key);
            valid_signers += 1;
        }
    }

    require!(
        valid_signers >= multisig_threshold as usize,
        CoordinationError::MultisigNotEnoughSigners
    );

    // Fix #448: Validate treasury is not the default pubkey
    require!(
        ctx.accounts.treasury.key() != Pubkey::default(),
        CoordinationError::InvalidTreasury
    );
    // Hardening: treasury must be either protocol-owned (PDA/account owned by this
    // program) or a system account. This prevents misconfiguration to arbitrary
    // third-party program accounts that cannot be governed by this protocol.
    let treasury_is_program_owned = ctx.accounts.treasury.owner == &crate::ID;
    let treasury_is_system_owned = ctx.accounts.treasury.owner == &anchor_lang::system_program::ID;
    require!(
        treasury_is_program_owned || treasury_is_system_owned,
        CoordinationError::InvalidTreasury
    );
    // System-account treasuries are only valid if they sign at initialization,
    // guaranteeing the configured address is actively controlled.
    if treasury_is_system_owned {
        require!(
            ctx.accounts.treasury.is_signer,
            CoordinationError::TreasuryNotSpendable
        );
    }

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
    config.task_creation_cooldown = DEFAULT_TASK_CREATION_COOLDOWN;
    config.max_tasks_per_24h = DEFAULT_MAX_TASKS_PER_24H;
    config.dispute_initiation_cooldown = DEFAULT_DISPUTE_INITIATION_COOLDOWN;
    config.max_disputes_per_24h = DEFAULT_MAX_DISPUTES_PER_24H;
    config.min_stake_for_dispute = min_stake_for_dispute;
    config.slash_percentage = ProtocolConfig::DEFAULT_SLASH_PERCENTAGE;
    config.voting_period = ProtocolConfig::DEFAULT_VOTING_PERIOD;
    // Versioning
    config.protocol_version = CURRENT_PROTOCOL_VERSION;
    config.min_supported_version = MIN_SUPPORTED_VERSION;
    config._padding = [0u8; 2];
    // Fix #497: Explicitly zero all slots before populating to ensure no data leakage.
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
