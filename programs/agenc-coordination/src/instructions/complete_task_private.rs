//! Private task completion with ZK proof verification.
//!
//! Enables agents to prove task completion without revealing outputs.
//! Uses Groth16 proofs verified via CPI to the Sunspot verifier.
//!
//! # Security Model
//!
//! The circuit enforces binding of proof to (task_id, agent_pubkey, output_commitment).
//! On-chain, we build the public witness with task_id and agent_pubkey from actual accounts,
//! preventing replay attacks even without computing the binding hash on-chain.
//!
//! # External Dependencies
//!
//! **IMPORTANT**: This module depends on the Sunspot Groth16 verifier program at
//! `ZK_VERIFIER_PROGRAM_ID`. For production deployment:
//! 1. Ensure the verifier program has been audited
//! 2. Verify the deployed verifier matches the expected bytecode
//! 3. The verifier must support the BN254 curve with the circuit's verification key
//!
//! # Public Witness Encoding
//!
//! The witness format matches Noir's public input encoding for `pub [u8; 32]`:
//! - Each byte becomes a separate 32-byte big-endian field element
//! - This results in 32 field elements per pubkey (not 1 field from byte conversion)
//! - The SDK's `pubkeyToField` is only used for computing binding hashes, not witness encoding
//! - Actual witness generation is handled by nargo/sunspot during proof creation

use crate::errors::CoordinationError;
use crate::events::{RewardDistributed, TaskCompleted};
use crate::instructions::completion_helpers::{
    calculate_reward_split, transfer_rewards, update_claim_state, update_protocol_stats,
    update_task_state, update_worker_state,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
    HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;

/// Sunspot Groth16 verifier program ID (BN254 curve).
/// SECURITY: This program must be audited before production use.
/// The verification key embedded in this program must match the task_completion circuit.
pub const ZK_VERIFIER_PROGRAM_ID: Pubkey = pubkey!("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");

// ZK witness format constants
// 32 (task_id bytes) + 32 (agent bytes) + 1 (constraint_hash) + 1 (output_commitment) + 1 (expected_binding)
const PUBLIC_INPUTS_COUNT: usize = 67;
const FIELD_SIZE: usize = HASH_SIZE;
const WITNESS_HEADER_SIZE: usize = 12;
const WITNESS_HEADER_PADDING: usize = 8;

/// Expected Groth16 proof size in bytes (2 G1 points + 1 G2 point on BN254)
const EXPECTED_PROOF_SIZE: usize = 388;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PrivateCompletionProof {
    pub proof_data: Vec<u8>,
    pub constraint_hash: [u8; HASH_SIZE],
    pub output_commitment: [u8; HASH_SIZE],
    pub expected_binding: [u8; HASH_SIZE],
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CompleteTaskPrivate<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Treasury account for protocol fees
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: ZK verifier program
    #[account(
        constraint = zk_verifier.key() == ZK_VERIFIER_PROGRAM_ID @ CoordinationError::InvalidInput
    )]
    pub zk_verifier: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Complete a task with private ZK proof verification.
///
/// # Arguments
/// * `_task_id` - Required by Anchor's instruction macro for deserialization,
///   but the actual task is identified by the task account PDA
/// * `proof` - The ZK proof containing proof_data, constraint_hash, output_commitment, and expected_binding
pub fn complete_task_private(
    ctx: Context<CompleteTaskPrivate>,
    _task_id: u64,
    proof: PrivateCompletionProof,
) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let claim = &mut ctx.accounts.claim;
    let escrow = &mut ctx.accounts.escrow;
    let worker = &mut ctx.accounts.worker;
    let clock = Clock::get()?;

    check_version_compatible(&ctx.accounts.protocol_config)?;

    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // CRITICAL: Verify this is a private task (has a non-zero constraint_hash)
    // Tasks without constraint_hash should use complete_task, not complete_task_private
    require!(
        task.constraint_hash != [0u8; HASH_SIZE],
        CoordinationError::NotPrivateTask
    );

    // CRITICAL: Verify the proof's constraint_hash matches the task's stored constraint_hash
    // This prevents attackers from proving an arbitrary constraint they can satisfy
    require!(
        proof.constraint_hash == task.constraint_hash,
        CoordinationError::ConstraintHashMismatch
    );

    // CRITICAL: For competitive tasks, ensure no one else has completed (fix: double-reward vulnerability)
    // This check must happen BEFORE proof verification to prevent wasted compute on invalid completions
    if task.task_type == TaskType::Competitive {
        require!(
            task.completions == 0,
            CoordinationError::CompetitiveTaskAlreadyWon
        );
    }

    verify_zk_proof(
        &ctx.accounts.zk_verifier,
        &proof,
        task.key(),
        worker.authority,
    )?;

    claim.proof_hash = proof.output_commitment;
    // Private completions don't store result data on-chain (privacy preserved)
    claim.result_data = [0u8; RESULT_DATA_SIZE];
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    let (worker_reward, protocol_fee) =
        calculate_reward_split(task, ctx.accounts.protocol_config.protocol_fee_bps)?;

    transfer_rewards(
        escrow,
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        worker_reward,
        protocol_fee,
    )?;

    update_claim_state(claim, escrow, worker_reward, task.reward_amount)?;
    // Pass None for result_data to preserve privacy
    let task_completed = update_task_state(task, clock.unix_timestamp, escrow, None)?;
    update_worker_state(worker, worker_reward, clock.unix_timestamp)?;

    if task_completed {
        update_protocol_stats(&mut ctx.accounts.protocol_config, task.reward_amount)?;
    }

    emit!(TaskCompleted {
        task_id: task.task_id,
        worker: worker.key(),
        proof_hash: proof.output_commitment,
        reward_paid: worker_reward,
        timestamp: clock.unix_timestamp,
    });

    emit!(RewardDistributed {
        task_id: task.task_id,
        recipient: worker.key(),
        amount: worker_reward,
        protocol_fee,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// ZK Proof Verification Helpers
// ============================================================================

/// Encode a pubkey as 32 separate field elements (one per byte) for the ZK witness.
/// Each byte becomes a 32-byte field element with the byte in the last position.
fn append_pubkey_as_field_elements(witness: &mut Vec<u8>, pubkey: &Pubkey) {
    for byte in pubkey.to_bytes() {
        let mut field = [0u8; FIELD_SIZE];
        field[FIELD_SIZE - 1] = byte;
        witness.extend_from_slice(&field);
    }
}

fn build_public_witness(task_key: &Pubkey, agent: &Pubkey, proof: &PrivateCompletionProof) -> Vec<u8> {
    let capacity = WITNESS_HEADER_SIZE + PUBLIC_INPUTS_COUNT * FIELD_SIZE;
    let mut witness = Vec::with_capacity(capacity);

    // Header: count (4 bytes LE) + padding (8 bytes) - Sunspot verifier format
    witness.extend_from_slice(&(PUBLIC_INPUTS_COUNT as u32).to_le_bytes());
    witness.extend_from_slice(&[0u8; WITNESS_HEADER_PADDING]);

    // Public inputs 1-32: task_id (each byte as separate field element)
    append_pubkey_as_field_elements(&mut witness, task_key);

    // Public inputs 33-64: agent_pubkey (each byte as separate field element)
    append_pubkey_as_field_elements(&mut witness, agent);

    // Public input 65: constraint_hash
    witness.extend_from_slice(&proof.constraint_hash);

    // Public input 66: output_commitment
    witness.extend_from_slice(&proof.output_commitment);

    // Public input 67: expected_binding
    witness.extend_from_slice(&proof.expected_binding);

    witness
}

fn verify_zk_proof(
    verifier: &UncheckedAccount,
    proof: &PrivateCompletionProof,
    task_key: Pubkey,
    agent: Pubkey,
) -> Result<()> {
    // Validate proof size matches expected Groth16 proof format
    require!(
        proof.proof_data.len() == EXPECTED_PROOF_SIZE,
        CoordinationError::InvalidProofSize
    );

    let witness = build_public_witness(&task_key, &agent, proof);

    let mut instruction_data = proof.proof_data.clone();
    instruction_data.extend_from_slice(&witness);

    let ix = Instruction {
        program_id: verifier.key(),
        accounts: vec![],
        data: instruction_data,
    };

    invoke(&ix, &[]).map_err(|e| {
        msg!("ZK proof verification failed: {:?}", e);
        CoordinationError::ZkVerificationFailed
    })?;

    Ok(())
}
