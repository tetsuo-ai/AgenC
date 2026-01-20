//! Emit a cross-chain task creation message
//!
//! This instruction creates a task that is available for workers on other
//! chains to claim. It emits a Wormhole-compatible message that can be
//! relayed to supported destination chains.

use crate::errors::CoordinationError;
use crate::events::TaskCreated;
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskEscrow, TaskStatus, TaskType};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use super::bridge_types::{chain_ids, CrossChainTaskCreated};

/// Event emitted when a cross-chain task is created
#[event]
pub struct CrossChainTaskEmitted {
    /// Task ID
    pub task_id: [u8; 32],
    /// Creator
    pub creator: Pubkey,
    /// Serialized message for bridge relay
    pub message: Vec<u8>,
    /// Message nonce
    pub nonce: u64,
    /// Timestamp
    pub timestamp: i64,
}

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct EmitCrossChainTask<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Creator's agent registration
    #[account(
        mut,
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// Authority that owns the creator_agent
    pub authority: Signer<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Parameters for cross-chain task creation
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainTaskParams {
    /// Task ID (must be unique)
    pub task_id: [u8; 32],
    /// Required capabilities
    pub required_capabilities: u64,
    /// Task description (stored on-chain)
    pub description: [u8; 64],
    /// Reward amount in lamports
    pub reward_amount: u64,
    /// Maximum workers
    pub max_workers: u8,
    /// Deadline (0 = no deadline)
    pub deadline: i64,
    /// Task type (0 = exclusive, 1 = collaborative, 2 = competitive)
    pub task_type: u8,
    /// Constraint hash for private tasks
    pub constraint_hash: Option<[u8; 32]>,
    /// Allowed destination chains (empty = all chains)
    pub allowed_chains: Vec<u16>,
}

pub fn handler(ctx: Context<EmitCrossChainTask>, params: CrossChainTaskParams) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Validate inputs
    require!(params.max_workers > 0, CoordinationError::InvalidInput);
    require!(params.task_type <= 2, CoordinationError::InvalidTaskType);

    if params.deadline > 0 {
        require!(
            params.deadline > clock.unix_timestamp,
            CoordinationError::InvalidInput
        );
    }

    // For cross-chain tasks, enforce minimum reward to cover gas
    // This is a soft check; actual minimum is chain-dependent
    const MIN_CROSS_CHAIN_REWARD: u64 = 10_000_000; // 0.01 SOL
    require!(
        params.reward_amount >= MIN_CROSS_CHAIN_REWARD,
        CoordinationError::InsufficientFunds
    );

    let creator_agent = &mut ctx.accounts.creator_agent;

    // Update agent activity
    creator_agent.last_active = clock.unix_timestamp;

    // Transfer reward to escrow
    if params.reward_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            params.reward_amount,
        )?;
    }

    // Initialize task
    let task = &mut ctx.accounts.task;
    task.task_id = params.task_id;
    task.creator = ctx.accounts.creator.key();
    task.required_capabilities = params.required_capabilities;
    task.description = params.description;
    task.constraint_hash = params.constraint_hash.unwrap_or([0u8; 32]);
    task.reward_amount = params.reward_amount;
    task.max_workers = params.max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = match params.task_type {
        0 => TaskType::Exclusive,
        1 => TaskType::Collaborative,
        2 => TaskType::Competitive,
        _ => return Err(CoordinationError::InvalidTaskType.into()),
    };
    task.created_at = clock.unix_timestamp;
    task.deadline = params.deadline;
    task.completed_at = 0;
    task.escrow = ctx.accounts.escrow.key();
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if params.task_type == 1 {
        params.max_workers
    } else {
        1
    };
    task.bump = ctx.bumps.task;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.task = task.key();
    escrow.amount = params.reward_amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = ctx.bumps.escrow;

    // Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    protocol_config.total_tasks = protocol_config
        .total_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Generate nonce from task creation
    let nonce = clock.unix_timestamp as u64;

    // Use first 32 bytes of description as the hash for cross-chain message
    // Full description is stored on-chain, this is just for cross-chain routing
    let mut description_hash = [0u8; 32];
    description_hash.copy_from_slice(&params.description[..32]);

    // Create cross-chain message
    let cross_chain_msg = CrossChainTaskCreated {
        version: CrossChainTaskCreated::VERSION,
        source_chain: chain_ids::SOLANA,
        task_id: params.task_id,
        creator: ctx.accounts.creator.key().to_bytes(),
        required_capabilities: params.required_capabilities,
        description_hash,
        reward_amount: params.reward_amount,
        deadline: params.deadline,
        task_type: params.task_type,
        constraint_hash: task.constraint_hash,
        max_workers: params.max_workers,
        nonce,
        created_at: clock.unix_timestamp,
    };

    // Emit standard task created event
    emit!(TaskCreated {
        task_id: params.task_id,
        creator: task.creator,
        required_capabilities: params.required_capabilities,
        reward_amount: params.reward_amount,
        task_type: params.task_type,
        deadline: params.deadline,
        timestamp: clock.unix_timestamp,
    });

    // Emit cross-chain message for relayers
    emit!(CrossChainTaskEmitted {
        task_id: params.task_id,
        creator: ctx.accounts.creator.key(),
        message: cross_chain_msg.to_bytes(),
        nonce,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
