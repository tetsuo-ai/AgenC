//! Private task completion with RISC Zero verifier-router verification.

use crate::errors::CoordinationError;
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, validate_completion_prereqs,
    validate_task_dependency,
};
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
use crate::state::{
    AgentRegistration, BindingSpend, NullifierSpend, ProtocolConfig, Task, TaskClaim, TaskEscrow,
    HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{Mint, Token, TokenAccount};
use solana_sha256_hasher::hashv;

const RISC0_JOURNAL_LEN: usize = 192;
const RISC0_SELECTOR_LEN: usize = 4;
const RISC0_IMAGE_ID_LEN: usize = 32;
const RISC0_SEAL_BYTES_LEN: usize = 260;

// Journal field offsets (each field is HASH_SIZE=32 bytes)
const JOURNAL_TASK_PDA_OFFSET: usize = 0;
const JOURNAL_AUTHORITY_OFFSET: usize = HASH_SIZE; // 32
const JOURNAL_CONSTRAINT_OFFSET: usize = 64;
const JOURNAL_COMMITMENT_OFFSET: usize = 96;
const JOURNAL_BINDING_OFFSET: usize = 128;
const JOURNAL_NULLIFIER_OFFSET: usize = 160;
const ROUTER_VERIFY_IX_DISCRIMINATOR: [u8; 8] = [133, 161, 141, 48, 120, 198, 88, 150];
const VERIFIER_ENTRY_DISCRIMINATOR: [u8; 8] = [102, 247, 148, 158, 33, 153, 100, 93];
const VERIFIER_ENTRY_ACCOUNT_LEN: usize = 45;

// Byte offsets within the VerifierEntry account data:
// [0..8]   discriminator
// [8..12]  selector (RISC0_SELECTOR_LEN)
// [12..44] verifier pubkey (32 bytes)
// [44]     estopped flag (1 byte)
const VERIFIER_ENTRY_SELECTOR_OFFSET: usize = 8;
const VERIFIER_ENTRY_VERIFIER_OFFSET: usize = 12;
const VERIFIER_ENTRY_ESTOPPED_OFFSET: usize = 44;

const TRUSTED_RISC0_SELECTOR: [u8; RISC0_SELECTOR_LEN] = [0x52, 0x5a, 0x56, 0x4d];
const TRUSTED_RISC0_ROUTER_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
// SHA-256 digest of the trusted RISC Zero guest ELF used by the remote prover stack.
// This value MUST match TRUSTED_RISC0_IMAGE_ID in sdk/src/constants.ts exactly.
const TRUSTED_RISC0_IMAGE_ID: [u8; RISC0_IMAGE_ID_LEN] = [
    91, 102, 183, 26, 119, 89, 149, 15, 10, 80, 87, 16, 22, 157, 195, 85, 12, 183, 108, 1, 237,
    243, 199, 24, 191, 151, 209, 50, 83, 101, 49, 151,
];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PrivateCompletionPayload {
    pub seal_bytes: Vec<u8>,
    pub journal: Vec<u8>,
    pub image_id: [u8; RISC0_IMAGE_ID_LEN],
    pub binding_seed: [u8; HASH_SIZE],
    pub nullifier_seed: [u8; HASH_SIZE],
}

#[derive(Accounts)]
#[instruction(task_id: u64, proof: PrivateCompletionPayload)]
pub struct CompleteTaskPrivate<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        close = authority,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    /// CHECK: Task creator receives escrow rent - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        init,
        payer = authority,
        space = BindingSpend::SIZE,
        seeds = [b"binding_spend", proof.binding_seed.as_ref()],
        bump
    )]
    pub binding_spend: Box<Account<'info, BindingSpend>>,

    #[account(
        init,
        payer = authority,
        space = NullifierSpend::SIZE,
        seeds = [b"nullifier_spend", proof.nullifier_seed.as_ref()],
        bump
    )]
    pub nullifier_spend: Box<Account<'info, NullifierSpend>>,

    /// CHECK: Treasury account for protocol fees
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: trusted verifier router program account
    #[account(
        executable,
        address = TRUSTED_RISC0_ROUTER_PROGRAM_ID @ CoordinationError::RouterAccountMismatch
    )]
    pub router_program: UncheckedAccount<'info>,

    /// CHECK: router PDA under trusted router program
    #[account(
        seeds = [b"router"],
        bump,
        seeds::program = TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        constraint = router.owner == &TRUSTED_RISC0_ROUTER_PROGRAM_ID @ CoordinationError::RouterAccountMismatch
    )]
    pub router: UncheckedAccount<'info>,

    /// CHECK: verifier-entry PDA for the trusted selector
    #[account(
        seeds = [b"verifier", TRUSTED_RISC0_SELECTOR.as_ref()],
        bump,
        seeds::program = TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        constraint = verifier_entry.owner == &TRUSTED_RISC0_ROUTER_PROGRAM_ID @ CoordinationError::RouterAccountMismatch
    )]
    pub verifier_entry: UncheckedAccount<'info>,

    /// CHECK: trusted verifier program account registered in router
    #[account(
        executable,
        address = TRUSTED_RISC0_VERIFIER_PROGRAM_ID @ CoordinationError::TrustedVerifierProgramMismatch
    )]
    pub verifier_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// CHECK: Validated in handler
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub reward_mint: Option<Account<'info, Mint>>,

    pub token_program: Option<Program<'info, Token>>,
}

pub fn complete_task_private(
    mut ctx: Context<CompleteTaskPrivate>,
    task_id: u64,
    proof: PrivateCompletionPayload,
) -> Result<()> {
    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let decoded_proof = verify_private_completion_stage(&ctx, &task_key, task_id, &proof, &clock)?;
    settle_private_completion(&mut ctx, &decoded_proof, &clock)
}

#[inline(never)]
fn settle_private_completion(
    ctx: &mut Context<CompleteTaskPrivate>,
    decoded_proof: &DecodedPrivateProof,
    clock: &Clock,
) -> Result<()> {
    record_private_spends(
        ctx.accounts,
        &decoded_proof.parsed_journal,
        clock,
        ctx.bumps.binding_spend,
        ctx.bumps.nullifier_spend,
    );
    let token_accounts = build_token_payment_accounts(ctx.accounts)?;
    finalize_private_completion(
        ctx.accounts,
        decoded_proof.parsed_journal.output_commitment,
        clock,
        token_accounts,
    )
}

#[derive(Clone, Debug)]
struct Risc0Groth16Proof {
    pi_a: [u8; 64],
    pi_b: [u8; 128],
    pi_c: [u8; 64],
}

#[derive(Clone, Debug)]
struct Risc0Seal {
    selector: [u8; RISC0_SELECTOR_LEN],
    proof: Risc0Groth16Proof,
}

#[derive(Clone, Copy, Debug)]
struct ParsedJournal {
    task_pda: [u8; HASH_SIZE],
    agent_authority: [u8; HASH_SIZE],
    constraint_hash: [u8; HASH_SIZE],
    output_commitment: [u8; HASH_SIZE],
    binding: [u8; HASH_SIZE],
    nullifier: [u8; HASH_SIZE],
}

#[derive(Clone, Debug)]
struct DecodedPrivateProof {
    seal: Risc0Seal,
    parsed_journal: ParsedJournal,
    journal_digest: [u8; HASH_SIZE],
}

#[inline(never)]
fn verify_private_completion_stage(
    ctx: &Context<CompleteTaskPrivate>,
    task_key: &Pubkey,
    task_id: u64,
    proof: &PrivateCompletionPayload,
    clock: &Clock,
) -> Result<DecodedPrivateProof> {
    let decoded_proof = decode_private_completion_payload(proof)?;
    validate_completion_inputs(
        &ctx.accounts.task,
        task_key,
        &ctx.accounts.claim,
        &ctx.accounts.protocol_config,
        ctx.remaining_accounts,
        ctx.program_id,
        &ctx.accounts.authority.key(),
        task_id,
        proof,
        &decoded_proof.parsed_journal,
        clock,
    )?;
    invoke_router_verification(ctx.accounts, proof, &decoded_proof)?;
    Ok(decoded_proof)
}

#[inline(never)]
fn decode_private_completion_payload(
    proof: &PrivateCompletionPayload,
) -> Result<DecodedPrivateProof> {
    require!(
        proof.seal_bytes.len() == RISC0_SEAL_BYTES_LEN,
        CoordinationError::InvalidSealEncoding
    );
    let seal = decode_seal_bytes(&proof.seal_bytes)?;
    require!(
        seal.selector == TRUSTED_RISC0_SELECTOR,
        CoordinationError::TrustedSelectorMismatch
    );

    let parsed_journal = parse_and_validate_journal(&proof.journal)?;
    let journal_digest = hashv(&[proof.journal.as_slice()]).to_bytes();

    Ok(DecodedPrivateProof {
        seal,
        parsed_journal,
        journal_digest,
    })
}

#[inline(never)]
fn validate_completion_inputs<'info>(
    task: &Task,
    task_key: &Pubkey,
    claim: &TaskClaim,
    protocol_config: &ProtocolConfig,
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
    authority: &Pubkey,
    task_id: u64,
    proof: &PrivateCompletionPayload,
    parsed_journal: &ParsedJournal,
    clock: &Clock,
) -> Result<()> {
    validate_task_id(task, task_id)?;
    require!(
        task.deadline == 0 || clock.unix_timestamp <= task.deadline,
        CoordinationError::DeadlinePassed
    );

    check_version_compatible(protocol_config)?;
    validate_task_dependency(task, remaining_accounts, program_id)?;
    validate_completion_prereqs(task, claim, clock)?;

    require!(
        task.constraint_hash != [0u8; HASH_SIZE],
        CoordinationError::NotPrivateTask
    );
    validate_parsed_journal(task, task_key, authority, proof, parsed_journal)?;

    Ok(())
}

fn validate_task_id(task: &Task, task_id: u64) -> Result<()> {
    let task_id_bytes: [u8; 8] = task.task_id[..8]
        .try_into()
        .map_err(|_| error!(CoordinationError::CorruptedData))?;
    let expected_task_id = u64::from_le_bytes(task_id_bytes);
    require!(task_id == expected_task_id, CoordinationError::TaskNotFound);
    Ok(())
}

fn validate_parsed_journal(
    task: &Task,
    task_key: &Pubkey,
    authority: &Pubkey,
    proof: &PrivateCompletionPayload,
    parsed_journal: &ParsedJournal,
) -> Result<()> {
    require!(
        parsed_journal.task_pda == task_key.to_bytes(),
        CoordinationError::InvalidJournalTask
    );
    require!(
        parsed_journal.agent_authority == authority.to_bytes(),
        CoordinationError::InvalidJournalAuthority
    );
    require!(
        parsed_journal.constraint_hash == task.constraint_hash,
        CoordinationError::ConstraintHashMismatch
    );
    require!(
        parsed_journal.binding == proof.binding_seed,
        CoordinationError::InvalidJournalBinding
    );
    require!(
        parsed_journal.nullifier == proof.nullifier_seed,
        CoordinationError::InvalidNullifier
    );
    require!(
        proof.image_id == TRUSTED_RISC0_IMAGE_ID,
        CoordinationError::InvalidImageId
    );
    Ok(())
}

#[inline(never)]
fn invoke_router_verification<'info>(
    accounts: &CompleteTaskPrivate<'info>,
    proof: &PrivateCompletionPayload,
    decoded_proof: &DecodedPrivateProof,
) -> Result<()> {
    validate_verifier_entry(&accounts.verifier_entry, &accounts.verifier_program)?;
    let router_program_key = validate_router_program_accounts(accounts)?;
    let verify_ix =
        build_and_validate_router_verify_ix(accounts, proof, decoded_proof, &router_program_key)?;
    invoke_router_verify_ix(accounts, &verify_ix)
}

fn validate_router_program_accounts<'info>(
    accounts: &CompleteTaskPrivate<'info>,
) -> Result<Pubkey> {
    let router_program_key = accounts.router_program.key();
    require!(
        router_program_key == TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        CoordinationError::RouterAccountMismatch
    );
    require!(
        accounts.verifier_program.key() == TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
        CoordinationError::TrustedVerifierProgramMismatch
    );
    Ok(router_program_key)
}

fn build_and_validate_router_verify_ix<'info>(
    accounts: &CompleteTaskPrivate<'info>,
    proof: &PrivateCompletionPayload,
    decoded_proof: &DecodedPrivateProof,
    router_program_key: &Pubkey,
) -> Result<Instruction> {
    let verify_ix = build_router_verify_ix(
        router_program_key,
        &accounts.router.key(),
        &accounts.verifier_entry.key(),
        &accounts.verifier_program.key(),
        &accounts.system_program.key(),
        &decoded_proof.seal,
        proof.image_id,
        decoded_proof.journal_digest,
    )?;
    validate_router_verify_ix(
        &verify_ix,
        &accounts.router.key(),
        &accounts.verifier_entry.key(),
        &accounts.verifier_program.key(),
        &accounts.system_program.key(),
    )?;
    Ok(verify_ix)
}

fn invoke_router_verify_ix<'info>(
    accounts: &CompleteTaskPrivate<'info>,
    verify_ix: &Instruction,
) -> Result<()> {
    invoke(
        verify_ix,
        &[
            accounts.router.to_account_info(),
            accounts.verifier_entry.to_account_info(),
            accounts.verifier_program.to_account_info(),
            accounts.system_program.to_account_info(),
            accounts.router_program.to_account_info(),
        ],
    )
    .map_err(|err| {
        msg!("router verification CPI failed: {:?}", err);
        error!(CoordinationError::ZkVerificationFailed)
    })?;
    Ok(())
}

fn build_router_verify_ix(
    router_program_key: &Pubkey,
    router: &Pubkey,
    verifier_entry: &Pubkey,
    verifier_program: &Pubkey,
    system_program: &Pubkey,
    seal: &Risc0Seal,
    image_id: [u8; RISC0_IMAGE_ID_LEN],
    journal_digest: [u8; HASH_SIZE],
) -> Result<Instruction> {
    let mut cpi_data = Vec::with_capacity(332);
    cpi_data.extend_from_slice(&ROUTER_VERIFY_IX_DISCRIMINATOR);
    append_router_verify_args(&mut cpi_data, seal, image_id, journal_digest);

    Ok(Instruction {
        program_id: *router_program_key,
        accounts: vec![
            AccountMeta::new_readonly(*router, false),
            AccountMeta::new_readonly(*verifier_entry, false),
            AccountMeta::new_readonly(*verifier_program, false),
            AccountMeta::new_readonly(*system_program, false),
        ],
        data: cpi_data,
    })
}

fn decode_seal_bytes(seal_bytes: &[u8]) -> Result<Risc0Seal> {
    require!(
        seal_bytes.len() == RISC0_SEAL_BYTES_LEN,
        CoordinationError::InvalidSealEncoding
    );

    let selector = seal_bytes[0..RISC0_SELECTOR_LEN]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidSealEncoding))?;
    let pi_a = seal_bytes[RISC0_SELECTOR_LEN..RISC0_SELECTOR_LEN + 64]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidSealEncoding))?;
    let pi_b = seal_bytes[RISC0_SELECTOR_LEN + 64..RISC0_SELECTOR_LEN + 64 + 128]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidSealEncoding))?;
    let pi_c = seal_bytes[RISC0_SELECTOR_LEN + 64 + 128..RISC0_SEAL_BYTES_LEN]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidSealEncoding))?;

    Ok(Risc0Seal {
        selector,
        proof: Risc0Groth16Proof { pi_a, pi_b, pi_c },
    })
}

fn append_router_verify_args(
    out: &mut Vec<u8>,
    seal: &Risc0Seal,
    image_id: [u8; RISC0_IMAGE_ID_LEN],
    journal_digest: [u8; HASH_SIZE],
) {
    out.extend_from_slice(&seal.selector);
    out.extend_from_slice(&seal.proof.pi_a);
    out.extend_from_slice(&seal.proof.pi_b);
    out.extend_from_slice(&seal.proof.pi_c);
    out.extend_from_slice(&image_id);
    out.extend_from_slice(&journal_digest);
}

fn record_private_spends<'info>(
    accounts: &mut CompleteTaskPrivate<'info>,
    parsed_journal: &ParsedJournal,
    clock: &Clock,
    binding_spend_bump: u8,
    nullifier_spend_bump: u8,
) {
    let task_key = accounts.task.key();
    let worker_key = accounts.worker.key();

    let binding_spend = &mut accounts.binding_spend;
    binding_spend.binding = parsed_journal.binding;
    binding_spend.task = task_key;
    binding_spend.agent = worker_key;
    binding_spend.spent_at = clock.unix_timestamp;
    binding_spend.bump = binding_spend_bump;

    let nullifier_spend = &mut accounts.nullifier_spend;
    nullifier_spend.nullifier = parsed_journal.nullifier;
    nullifier_spend.task = task_key;
    nullifier_spend.agent = worker_key;
    nullifier_spend.spent_at = clock.unix_timestamp;
    nullifier_spend.bump = nullifier_spend_bump;
}

#[inline(never)]
fn finalize_private_completion<'info>(
    accounts: &mut CompleteTaskPrivate<'info>,
    output_commitment: [u8; HASH_SIZE],
    clock: &Clock,
    token_accounts: Option<TokenPaymentAccounts<'info>>,
) -> Result<()> {
    let task = &mut accounts.task;
    let claim = &mut accounts.claim;
    let escrow = &mut accounts.escrow;
    let worker = &mut accounts.worker;

    claim.proof_hash = output_commitment;
    claim.result_data = [0u8; RESULT_DATA_SIZE];
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    let protocol_fee_bps = calculate_fee_with_reputation(task.protocol_fee_bps, worker.reputation);
    execute_completion_rewards(
        task,
        claim,
        escrow,
        worker,
        &mut accounts.protocol_config,
        &accounts.authority.to_account_info(),
        &accounts.treasury.to_account_info(),
        &accounts.creator.to_account_info(),
        protocol_fee_bps,
        None,
        clock,
        token_accounts,
    )
}

#[inline(never)]
fn build_token_payment_accounts<'info>(
    accounts: &CompleteTaskPrivate<'info>,
) -> Result<Option<TokenPaymentAccounts<'info>>> {
    let task = &accounts.task;
    if task.reward_mint.is_none() {
        return Ok(None);
    }

    let required_accounts = extract_required_token_accounts(accounts)?;
    let token_payment_accounts =
        build_validated_token_payment_accounts(accounts, required_accounts)?;
    Ok(Some(token_payment_accounts))
}

struct RequiredTokenAccounts<'a, 'info> {
    mint: &'a Account<'info, Mint>,
    token_escrow: &'a Account<'info, TokenAccount>,
    worker_token_account: &'a UncheckedAccount<'info>,
    treasury_ta: &'a Account<'info, TokenAccount>,
    token_program: &'a Program<'info, Token>,
    expected_mint: Pubkey,
}

fn extract_required_token_accounts<'a, 'info>(
    accounts: &'a CompleteTaskPrivate<'info>,
) -> Result<RequiredTokenAccounts<'a, 'info>> {
    let mint = accounts
        .reward_mint
        .as_ref()
        .ok_or(CoordinationError::MissingTokenAccounts)?;
    let token_escrow = accounts
        .token_escrow_ata
        .as_ref()
        .ok_or(CoordinationError::MissingTokenAccounts)?;
    let worker_token_account = accounts
        .worker_token_account
        .as_ref()
        .ok_or(CoordinationError::MissingTokenAccounts)?;
    let treasury_ta = accounts
        .treasury_token_account
        .as_ref()
        .ok_or(CoordinationError::MissingTokenAccounts)?;
    let token_program = accounts
        .token_program
        .as_ref()
        .ok_or(CoordinationError::MissingTokenAccounts)?;
    let expected_mint = accounts
        .task
        .reward_mint
        .ok_or(CoordinationError::InvalidTokenMint)?;

    Ok(RequiredTokenAccounts {
        mint,
        token_escrow,
        worker_token_account,
        treasury_ta,
        token_program,
        expected_mint,
    })
}

fn build_validated_token_payment_accounts<'a, 'info>(
    accounts: &'a CompleteTaskPrivate<'info>,
    required_accounts: RequiredTokenAccounts<'a, 'info>,
) -> Result<TokenPaymentAccounts<'info>> {
    let RequiredTokenAccounts {
        mint,
        token_escrow,
        worker_token_account,
        treasury_ta,
        token_program,
        expected_mint,
    } = required_accounts;

    require!(
        mint.key() == expected_mint,
        CoordinationError::InvalidTokenMint
    );
    validate_token_account(token_escrow, &mint.key(), &accounts.escrow.key())?;
    validate_token_account(treasury_ta, &mint.key(), &accounts.protocol_config.treasury)?;
    let token_escrow_starting_amount =
        anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
            .map_err(|_| CoordinationError::TokenTransferFailed)?;
    validate_unchecked_token_mint(
        &worker_token_account.to_account_info(),
        &mint.key(),
        &accounts.authority.key(),
    )?;

    Ok(TokenPaymentAccounts {
        token_escrow_ata: token_escrow.to_account_info(),
        token_escrow_starting_amount,
        worker_token_account: worker_token_account.to_account_info(),
        treasury_token_account: treasury_ta.to_account_info(),
        token_program: token_program.to_account_info(),
        escrow_authority: accounts.escrow.to_account_info(),
        escrow_bump: accounts.escrow.bump,
        task_key: accounts.task.key(),
    })
}

fn parse_and_validate_journal(journal: &[u8]) -> Result<ParsedJournal> {
    require!(
        journal.len() == RISC0_JOURNAL_LEN,
        CoordinationError::InvalidJournalLength
    );

    let task_pda = read_journal_field(journal, JOURNAL_TASK_PDA_OFFSET)?;
    let agent_authority = read_journal_field(journal, JOURNAL_AUTHORITY_OFFSET)?;
    let constraint_hash = read_journal_field(journal, JOURNAL_CONSTRAINT_OFFSET)?;
    let output_commitment = read_journal_field(journal, JOURNAL_COMMITMENT_OFFSET)?;
    let binding = read_journal_field(journal, JOURNAL_BINDING_OFFSET)?;
    let nullifier = read_journal_field(journal, JOURNAL_NULLIFIER_OFFSET)?;

    require!(
        output_commitment != [0u8; HASH_SIZE],
        CoordinationError::InvalidOutputCommitment
    );
    require!(
        binding != [0u8; HASH_SIZE],
        CoordinationError::InvalidJournalBinding
    );
    require!(
        nullifier != [0u8; HASH_SIZE],
        CoordinationError::InvalidNullifier
    );

    // Entropy check: SHA-256 outputs have ~28 distinct byte values on average
    // for 32 bytes. Require at least 8 distinct values to reject trivially
    // predictable seeds (e.g. constant fill, short repeating patterns).
    require!(
        has_sufficient_byte_diversity(&binding),
        CoordinationError::InsufficientSeedEntropy
    );
    require!(
        has_sufficient_byte_diversity(&nullifier),
        CoordinationError::InsufficientSeedEntropy
    );

    Ok(ParsedJournal {
        task_pda,
        agent_authority,
        constraint_hash,
        output_commitment,
        binding,
        nullifier,
    })
}

fn read_journal_field(journal: &[u8], start: usize) -> Result<[u8; HASH_SIZE]> {
    let end = start
        .checked_add(HASH_SIZE)
        .ok_or(error!(CoordinationError::InvalidJournalLength))?;
    let src = journal
        .get(start..end)
        .ok_or(error!(CoordinationError::InvalidJournalLength))?;
    let mut out = [0u8; HASH_SIZE];
    out.copy_from_slice(src);
    Ok(out)
}

/// Minimum number of distinct byte values required in a 32-byte seed.
/// SHA-256 outputs average ~28 distinct values; 8 is a conservative floor
/// that rejects constant-fill, short-period, and arithmetic-sequence patterns.
const MIN_DISTINCT_BYTES: usize = 8;

/// Returns true if the 32-byte value contains at least `MIN_DISTINCT_BYTES`
/// distinct byte values, indicating it was likely produced by a cryptographic
/// hash rather than a trivial or low-entropy construction.
fn has_sufficient_byte_diversity(value: &[u8; HASH_SIZE]) -> bool {
    let mut seen = [false; 256];
    let mut count: usize = 0;
    for &b in value.iter() {
        if !seen[b as usize] {
            seen[b as usize] = true;
            count += 1;
            if count >= MIN_DISTINCT_BYTES {
                return true;
            }
        }
    }
    false
}

fn validate_verifier_entry(
    verifier_entry: &UncheckedAccount,
    verifier_program: &UncheckedAccount,
) -> Result<()> {
    let data = verifier_entry.try_borrow_data()?;
    validate_verifier_entry_data(data.as_ref(), &verifier_program.key())
}

fn validate_router_verify_ix(
    verify_ix: &Instruction,
    router: &Pubkey,
    verifier_entry: &Pubkey,
    verifier_program: &Pubkey,
    system_program: &Pubkey,
) -> Result<()> {
    require!(
        verify_ix.program_id == TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        CoordinationError::RouterAccountMismatch
    );
    require!(
        verify_ix.accounts.len() == 4,
        CoordinationError::RouterAccountMismatch
    );

    let expected_keys = [*router, *verifier_entry, *verifier_program, *system_program];
    for (meta, expected_key) in verify_ix.accounts.iter().zip(expected_keys.iter()) {
        require!(
            meta.pubkey == *expected_key,
            CoordinationError::RouterAccountMismatch
        );
        require!(!meta.is_signer, CoordinationError::RouterAccountMismatch);
        require!(!meta.is_writable, CoordinationError::RouterAccountMismatch);
    }

    Ok(())
}

fn validate_verifier_entry_data(data: &[u8], verifier_program_key: &Pubkey) -> Result<()> {
    require!(
        data.len() == VERIFIER_ENTRY_ACCOUNT_LEN,
        CoordinationError::RouterAccountMismatch
    );
    validate_verifier_entry_discriminator(data)?;
    validate_verifier_entry_selector(data)?;
    validate_verifier_program_binding(data, verifier_program_key)?;
    validate_verifier_entry_not_estopped(data)?;

    Ok(())
}

fn validate_verifier_entry_discriminator(data: &[u8]) -> Result<()> {
    let discriminator = data
        .get(0..8)
        .ok_or(error!(CoordinationError::RouterAccountMismatch))?;
    require!(
        discriminator == VERIFIER_ENTRY_DISCRIMINATOR.as_ref(),
        CoordinationError::RouterAccountMismatch
    );
    Ok(())
}

fn validate_verifier_entry_selector(data: &[u8]) -> Result<()> {
    let selector_slice = data
        .get(VERIFIER_ENTRY_SELECTOR_OFFSET..VERIFIER_ENTRY_VERIFIER_OFFSET)
        .ok_or(error!(CoordinationError::RouterAccountMismatch))?;
    let mut selector = [0u8; RISC0_SELECTOR_LEN];
    selector.copy_from_slice(selector_slice);
    require!(
        selector == TRUSTED_RISC0_SELECTOR,
        CoordinationError::TrustedSelectorMismatch
    );
    Ok(())
}

fn validate_verifier_program_binding(data: &[u8], verifier_program_key: &Pubkey) -> Result<()> {
    let verifier_pubkey = parse_verifier_entry_program(data)?;
    require!(
        verifier_pubkey == TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
        CoordinationError::TrustedVerifierProgramMismatch
    );
    require!(
        verifier_pubkey == *verifier_program_key,
        CoordinationError::TrustedVerifierProgramMismatch
    );
    Ok(())
}

fn parse_verifier_entry_program(data: &[u8]) -> Result<Pubkey> {
    let verifier_slice = data
        .get(VERIFIER_ENTRY_VERIFIER_OFFSET..VERIFIER_ENTRY_ESTOPPED_OFFSET)
        .ok_or(error!(CoordinationError::RouterAccountMismatch))?;
    let verifier_bytes: [u8; 32] = verifier_slice
        .try_into()
        .map_err(|_| error!(CoordinationError::RouterAccountMismatch))?;
    Ok(Pubkey::new_from_array(verifier_bytes))
}

fn validate_verifier_entry_not_estopped(data: &[u8]) -> Result<()> {
    let estopped = data
        .get(VERIFIER_ENTRY_ESTOPPED_OFFSET)
        .ok_or(error!(CoordinationError::RouterAccountMismatch))?;
    require!(*estopped == 0, CoordinationError::RouterAccountMismatch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_name(err: anchor_lang::error::Error, name: &str) {
        let message = format!("{err:?}");
        assert!(
            message.contains(name),
            "expected error containing '{name}', got '{message}'"
        );
    }

    fn sample_journal(
        task_pda: [u8; HASH_SIZE],
        authority: [u8; HASH_SIZE],
        constraint_hash: [u8; HASH_SIZE],
        output_commitment: [u8; HASH_SIZE],
        binding: [u8; HASH_SIZE],
        nullifier: [u8; HASH_SIZE],
    ) -> Vec<u8> {
        [
            task_pda.as_slice(),
            authority.as_slice(),
            constraint_hash.as_slice(),
            output_commitment.as_slice(),
            binding.as_slice(),
            nullifier.as_slice(),
        ]
        .concat()
    }

    fn verifier_entry_bytes(selector: [u8; 4], verifier: Pubkey, estopped: u8) -> Vec<u8> {
        let mut data = Vec::with_capacity(VERIFIER_ENTRY_ACCOUNT_LEN);
        data.extend_from_slice(&VERIFIER_ENTRY_DISCRIMINATOR);
        data.extend_from_slice(&selector);
        data.extend_from_slice(verifier.as_ref());
        data.push(estopped);
        data
    }

    #[test]
    fn journal_rejects_invalid_length() {
        let err = parse_and_validate_journal(&[0u8; RISC0_JOURNAL_LEN.saturating_sub(1)])
            .expect_err("must fail");
        assert_error_name(err, "InvalidJournalLength");
    }

    /// Build a 32-byte value with high byte diversity (sequential bytes 0..31 offset by base).
    fn diverse_bytes(base: u8) -> [u8; HASH_SIZE] {
        let mut out = [0u8; HASH_SIZE];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = base.wrapping_add(i as u8);
        }
        out
    }

    #[test]
    fn journal_parses_fixed_offsets() {
        let task = diverse_bytes(10);
        let authority = diverse_bytes(50);
        let constraint = diverse_bytes(90);
        let output = diverse_bytes(130);
        let binding = diverse_bytes(170);
        let nullifier = diverse_bytes(210);

        let journal = sample_journal(task, authority, constraint, output, binding, nullifier);
        let parsed = parse_and_validate_journal(&journal).expect("valid journal");

        assert_eq!(parsed.task_pda, task);
        assert_eq!(parsed.agent_authority, authority);
        assert_eq!(parsed.constraint_hash, constraint);
        assert_eq!(parsed.output_commitment, output);
        assert_eq!(parsed.binding, binding);
        assert_eq!(parsed.nullifier, nullifier);
    }

    #[test]
    fn verifier_entry_rejects_bad_length() {
        let err = validate_verifier_entry_data(&[0u8; 7], &TRUSTED_RISC0_VERIFIER_PROGRAM_ID)
            .expect_err("must fail");
        assert_error_name(err, "RouterAccountMismatch");
    }

    #[test]
    fn verifier_entry_rejects_bad_selector() {
        let mut selector = TRUSTED_RISC0_SELECTOR;
        selector[0] ^= 1;
        let data = verifier_entry_bytes(selector, TRUSTED_RISC0_VERIFIER_PROGRAM_ID, 0);
        let err = validate_verifier_entry_data(&data, &TRUSTED_RISC0_VERIFIER_PROGRAM_ID)
            .expect_err("must fail");
        assert_error_name(err, "TrustedSelectorMismatch");
    }

    #[test]
    fn verifier_entry_rejects_wrong_verifier_program() {
        let wrong_verifier = Pubkey::new_unique();
        let data = verifier_entry_bytes(TRUSTED_RISC0_SELECTOR, wrong_verifier, 0);
        let err = validate_verifier_entry_data(&data, &wrong_verifier).expect_err("must fail");
        assert_error_name(err, "TrustedVerifierProgramMismatch");
    }

    #[test]
    fn verifier_entry_rejects_estopped_entry() {
        let data =
            verifier_entry_bytes(TRUSTED_RISC0_SELECTOR, TRUSTED_RISC0_VERIFIER_PROGRAM_ID, 1);
        let err = validate_verifier_entry_data(&data, &TRUSTED_RISC0_VERIFIER_PROGRAM_ID)
            .expect_err("must fail");
        assert_error_name(err, "RouterAccountMismatch");
    }

    fn sample_router_ix(
        program_id: Pubkey,
        router: Pubkey,
        verifier_entry: Pubkey,
        verifier_program: Pubkey,
        system_program: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new_readonly(router, false),
                AccountMeta::new_readonly(verifier_entry, false),
                AccountMeta::new_readonly(verifier_program, false),
                AccountMeta::new_readonly(system_program, false),
            ],
            data: vec![],
        }
    }

    #[test]
    fn router_verify_ix_accepts_expected_shape() {
        let router = Pubkey::new_unique();
        let verifier_entry = Pubkey::new_unique();
        let verifier_program = Pubkey::new_unique();
        let system_program = anchor_lang::system_program::ID;
        let ix = sample_router_ix(
            TRUSTED_RISC0_ROUTER_PROGRAM_ID,
            router,
            verifier_entry,
            verifier_program,
            system_program,
        );

        validate_router_verify_ix(
            &ix,
            &router,
            &verifier_entry,
            &verifier_program,
            &system_program,
        )
        .expect("must pass");
    }

    #[test]
    fn router_verify_ix_rejects_wrong_program_id() {
        let router = Pubkey::new_unique();
        let verifier_entry = Pubkey::new_unique();
        let verifier_program = Pubkey::new_unique();
        let system_program = anchor_lang::system_program::ID;
        let ix = sample_router_ix(
            Pubkey::new_unique(),
            router,
            verifier_entry,
            verifier_program,
            system_program,
        );

        let err = validate_router_verify_ix(
            &ix,
            &router,
            &verifier_entry,
            &verifier_program,
            &system_program,
        )
        .expect_err("must fail");
        assert_error_name(err, "RouterAccountMismatch");
    }

    #[test]
    fn router_verify_ix_rejects_writable_meta() {
        let router = Pubkey::new_unique();
        let verifier_entry = Pubkey::new_unique();
        let verifier_program = Pubkey::new_unique();
        let system_program = anchor_lang::system_program::ID;
        let mut ix = sample_router_ix(
            TRUSTED_RISC0_ROUTER_PROGRAM_ID,
            router,
            verifier_entry,
            verifier_program,
            system_program,
        );
        ix.accounts[0] = AccountMeta::new(router, false);

        let err = validate_router_verify_ix(
            &ix,
            &router,
            &verifier_entry,
            &verifier_program,
            &system_program,
        )
        .expect_err("must fail");
        assert_error_name(err, "RouterAccountMismatch");
    }

    // ---------------------------------------------------------------
    // Byte diversity (entropy) tests
    // ---------------------------------------------------------------

    #[test]
    fn byte_diversity_accepts_sha256_like_output() {
        // 32 sequential bytes have 32 distinct values — well above the threshold
        let value = diverse_bytes(0);
        assert!(has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn byte_diversity_rejects_constant_fill() {
        // All same byte → 1 distinct value
        let value = [0xAA_u8; HASH_SIZE];
        assert!(!has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn byte_diversity_rejects_two_byte_pattern() {
        // Alternating 2 bytes → 2 distinct values
        let mut value = [0u8; HASH_SIZE];
        for (i, slot) in value.iter_mut().enumerate() {
            *slot = if i % 2 == 0 { 0x01 } else { 0x02 };
        }
        assert!(!has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn byte_diversity_rejects_short_period_pattern() {
        // 4-byte repeating pattern → only 4 distinct values
        let mut value = [0u8; HASH_SIZE];
        for (i, slot) in value.iter_mut().enumerate() {
            *slot = (i % 4) as u8;
        }
        assert!(!has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn byte_diversity_accepts_exactly_min_distinct() {
        // Exactly MIN_DISTINCT_BYTES distinct values should pass
        let mut value = [0u8; HASH_SIZE];
        for (i, slot) in value.iter_mut().enumerate() {
            *slot = (i % MIN_DISTINCT_BYTES) as u8;
        }
        assert!(has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn byte_diversity_rejects_just_below_threshold() {
        // MIN_DISTINCT_BYTES - 1 distinct values should fail
        let mut value = [0u8; HASH_SIZE];
        for (i, slot) in value.iter_mut().enumerate() {
            *slot = (i % (MIN_DISTINCT_BYTES - 1)) as u8;
        }
        assert!(!has_sufficient_byte_diversity(&value));
    }

    #[test]
    fn journal_rejects_low_entropy_binding() {
        let task = diverse_bytes(10);
        let authority = diverse_bytes(50);
        let constraint = diverse_bytes(90);
        let output = diverse_bytes(130);
        let binding = [0xAA_u8; HASH_SIZE]; // constant fill — low entropy
        let nullifier = diverse_bytes(210);

        let journal = sample_journal(task, authority, constraint, output, binding, nullifier);
        let err = parse_and_validate_journal(&journal).expect_err("must fail");
        assert_error_name(err, "InsufficientSeedEntropy");
    }

    #[test]
    fn journal_rejects_low_entropy_nullifier() {
        let task = diverse_bytes(10);
        let authority = diverse_bytes(50);
        let constraint = diverse_bytes(90);
        let output = diverse_bytes(130);
        let binding = diverse_bytes(170);
        let nullifier = [0xBB_u8; HASH_SIZE]; // constant fill — low entropy

        let journal = sample_journal(task, authority, constraint, output, binding, nullifier);
        let err = parse_and_validate_journal(&journal).expect_err("must fail");
        assert_error_name(err, "InsufficientSeedEntropy");
    }
}
