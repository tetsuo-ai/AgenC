//! Complete a task with ZK proof verification (private completion)
//!
//! This instruction allows an agent to prove task completion without revealing
//! the actual output. Uses a Groth16 proof verified via CPI to a Sunspot verifier.

use crate::errors::CoordinationError;
use crate::events::{RewardDistributed, TaskCompleted};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;

/// Sunspot Groth16 verifier program ID (deployed to devnet)
pub const ZK_VERIFIER_PROGRAM_ID: Pubkey = pubkey!("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");

/// ZK proof for private task completion
/// Contains Groth16 proof and public inputs matching the Noir circuit
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PrivateCompletionProof {
    /// Groth16 proof bytes (typically 256 bytes for BN254)
    pub proof_data: Vec<u8>,
    /// Public input: hash of the task constraint
    pub constraint_hash: [u8; 32],
    /// Public input: commitment to the private output (hash(output || salt))
    pub output_commitment: [u8; 32],
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

    /// CHECK: ZK verifier program (deployed Sunspot/Groth16 verifier)
    #[account(
        constraint = zk_verifier.key() == ZK_VERIFIER_PROGRAM_ID @ CoordinationError::InvalidInput
    )]
    pub zk_verifier: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

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

    let protocol_fee_bps = ctx.accounts.protocol_config.protocol_fee_bps;

    // Validate task state
    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );

    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // Verify ZK proof
    verify_completion_proof(
        &ctx.accounts.zk_verifier,
        &proof,
        task.key(),
        worker.authority,
        &task.description, // Using description as constraint reference
    )?;

    // Store commitment as proof hash (output remains private)
    claim.proof_hash = proof.output_commitment;
    claim.result_data = [0u8; 64]; // No result data for private completion
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    // Calculate reward (same as normal completion)
    let reward_per_worker = if task.task_type == TaskType::Collaborative {
        task.reward_amount
            .checked_div(task.required_completions as u64)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        task.reward_amount
    };

    let protocol_fee = reward_per_worker
        .checked_mul(protocol_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10000)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let worker_reward = reward_per_worker
        .checked_sub(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Transfer reward to worker
    if worker_reward > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_reward;
        **ctx
            .accounts
            .authority
            .to_account_info()
            .try_borrow_mut_lamports()? += worker_reward;
    }

    // Transfer protocol fee to treasury
    if protocol_fee > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= protocol_fee;
        **ctx
            .accounts
            .treasury
            .to_account_info()
            .try_borrow_mut_lamports()? += protocol_fee;
    }

    claim.reward_paid = worker_reward;
    escrow.distributed = escrow
        .distributed
        .checked_add(reward_per_worker)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    task.completions = task
        .completions
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let task_completed = task.completions >= task.required_completions;
    if task_completed {
        task.status = TaskStatus::Completed;
        task.completed_at = clock.unix_timestamp;
        task.result = [0u8; 64]; // Private: no result stored on-chain
        escrow.is_closed = true;
    }

    worker.tasks_completed = worker
        .tasks_completed
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.total_earned = worker
        .total_earned
        .checked_add(worker_reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker.active_tasks.saturating_sub(1);
    worker.last_active = clock.unix_timestamp;
    worker.reputation = worker.reputation.saturating_add(100).min(10000);

    if task_completed {
        let config = &mut ctx.accounts.protocol_config;
        config.completed_tasks = config
            .completed_tasks
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        config.total_value_distributed = config
            .total_value_distributed
            .checked_add(reward_per_worker)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
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

/// Number of public inputs in the Groth16 circuit (task_id + 32 agent bytes + constraint_hash + output_commitment)
const NR_PUBLIC_INPUTS: usize = 35;

/// Verify the ZK proof via CPI to the Sunspot/Groth16 verifier
fn verify_completion_proof(
    verifier: &UncheckedAccount,
    proof: &PrivateCompletionProof,
    task_key: Pubkey,
    agent_authority: Pubkey,
    _task_description: &[u8; 64],
) -> Result<()> {
    // Validate proof structure
    require!(
        !proof.proof_data.is_empty(),
        CoordinationError::InvalidInput
    );

    // Log public inputs for transparency
    msg!("Verifying ZK proof for task: {}", task_key);
    msg!("Agent authority: {}", agent_authority);
    msg!("Constraint hash: {:?}", &proof.constraint_hash[..8]);
    msg!("Output commitment: {:?}", &proof.output_commitment[..8]);

    // Build the public witness for the verifier
    // Format: 12-byte header (4 bytes nr_inputs + 4 bytes vector_type + 4 bytes padding)
    //         followed by 35 x 32-byte field elements
    let mut public_witness: Vec<u8> = Vec::with_capacity(12 + NR_PUBLIC_INPUTS * 32);

    // Header: number of public inputs (little-endian u32) + type marker + padding
    public_witness.extend_from_slice(&(NR_PUBLIC_INPUTS as u32).to_le_bytes());
    public_witness.extend_from_slice(&[0u8; 8]); // Type and padding

    // Public input 1: task_id (derived from task key - use first 32 bytes as field element)
    public_witness.extend_from_slice(&task_key.to_bytes());

    // Public inputs 2-33: agent_pubkey as 32 separate field elements (one byte per field)
    for byte in agent_authority.to_bytes().iter() {
        let mut field = [0u8; 32];
        field[31] = *byte; // Put byte value in the least significant position
        public_witness.extend_from_slice(&field);
    }

    // Public input 34: constraint_hash
    public_witness.extend_from_slice(&proof.constraint_hash);

    // Public input 35: output_commitment
    public_witness.extend_from_slice(&proof.output_commitment);

    // Build instruction data: proof bytes + public witness
    let mut instruction_data = proof.proof_data.clone();
    instruction_data.extend_from_slice(&public_witness);

    // Create CPI instruction to the Sunspot verifier
    let ix = Instruction {
        program_id: verifier.key(),
        accounts: vec![],
        data: instruction_data,
    };

    // Execute CPI - verifier will return error if proof is invalid
    invoke(&ix, &[]).map_err(|e| {
        msg!("ZK proof verification failed: {:?}", e);
        CoordinationError::InvalidInput
    })?;

    msg!("ZK proof verified successfully!");
    Ok(())
}
