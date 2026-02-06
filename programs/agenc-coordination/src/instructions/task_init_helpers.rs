//! Shared helpers for task initialization (create_task + create_dependent_task)

use crate::errors::CoordinationError;
use crate::instructions::constants::MAX_REPUTATION;
use crate::state::{DependencyType, ProtocolConfig, Task, TaskEscrow, TaskStatus, TaskType};
use anchor_lang::prelude::*;

/// Validates common task parameters shared between create_task and create_dependent_task.
///
/// Does NOT validate reward_amount (differs: create_task requires > 0, dependent tasks allow 0).
pub fn validate_task_params(
    task_id: &[u8; 32],
    description: &[u8; 64],
    required_capabilities: u64,
    max_workers: u8,
    task_type: u8,
    min_reputation: u16,
) -> Result<()> {
    // Validate task_id is not zero (#367)
    require!(*task_id != [0u8; 32], CoordinationError::InvalidTaskId);
    // Validate description is not empty (#369)
    require!(
        *description != [0u8; 64],
        CoordinationError::InvalidDescription
    );
    // Validate required_capabilities is not zero (#413)
    require!(
        required_capabilities != 0,
        CoordinationError::InvalidRequiredCapabilities
    );
    // Validate max_workers bounds (#412)
    require!(
        max_workers > 0 && max_workers <= 100,
        CoordinationError::InvalidMaxWorkers
    );
    require!(task_type <= 2, CoordinationError::InvalidTaskType);
    require!(
        min_reputation <= MAX_REPUTATION,
        CoordinationError::InvalidMinReputation
    );

    Ok(())
}

/// Initializes common task fields. Sets `dependency_type = None` and `depends_on = None`
/// by default; callers should override these after if the task has dependencies.
pub fn init_task_fields(
    task: &mut Task,
    task_id: [u8; 32],
    creator: Pubkey,
    required_capabilities: u64,
    description: [u8; 64],
    constraint_hash: Option<[u8; 32]>,
    reward_amount: u64,
    max_workers: u8,
    task_type: u8,
    deadline: i64,
    escrow_key: Pubkey,
    bump: u8,
    protocol_fee_bps: u16,
    timestamp: i64,
    min_reputation: u16,
) -> Result<()> {
    task.task_id = task_id;
    task.creator = creator;
    task.required_capabilities = required_capabilities;
    task.description = description;
    task.constraint_hash = constraint_hash.unwrap_or([0u8; 32]);
    task.reward_amount = reward_amount;
    task.max_workers = max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = match task_type {
        0 => TaskType::Exclusive,
        1 => TaskType::Collaborative,
        2 => TaskType::Competitive,
        _ => return Err(CoordinationError::InvalidTaskType.into()),
    };
    task.created_at = timestamp;
    task.deadline = deadline;
    task.completed_at = 0;
    task.escrow = escrow_key;
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if task_type == 1 { max_workers } else { 1 };
    task.bump = bump;
    task.protocol_fee_bps = protocol_fee_bps;
    task.dependency_type = DependencyType::None;
    task.depends_on = None;
    task.min_reputation = min_reputation;

    Ok(())
}

/// Initializes escrow account fields.
pub fn init_escrow_fields(
    escrow: &mut TaskEscrow,
    task_key: Pubkey,
    amount: u64,
    bump: u8,
) {
    escrow.task = task_key;
    escrow.amount = amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = bump;
}

/// Increments protocol_config.total_tasks with checked arithmetic.
pub fn increment_total_tasks(protocol_config: &mut ProtocolConfig) -> Result<()> {
    protocol_config.total_tasks = protocol_config
        .total_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}
