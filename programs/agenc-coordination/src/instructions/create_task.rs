//! Create a new task with reward escrow

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{Task, TaskStatus, TaskType, TaskEscrow, ProtocolConfig};
use crate::errors::CoordinationError;
use crate::events::TaskCreated;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateTask<'info> {
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

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
) -> Result<()> {
    require!(max_workers > 0, CoordinationError::InvalidInput);
    require!(task_type <= 2, CoordinationError::InvalidTaskType);

    let clock = Clock::get()?;

    // Validate deadline if set
    if deadline > 0 {
        require!(
            deadline > clock.unix_timestamp,
            CoordinationError::InvalidInput
        );
    }

    // Transfer reward to escrow
    if reward_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            reward_amount,
        )?;
    }

    // Initialize task
    let task = &mut ctx.accounts.task;
    task.task_id = task_id;
    task.creator = ctx.accounts.creator.key();
    task.required_capabilities = required_capabilities;
    task.description = description;
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
    task.created_at = clock.unix_timestamp;
    task.deadline = deadline;
    task.completed_at = 0;
    task.escrow = ctx.accounts.escrow.key();
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if task_type == 1 { max_workers } else { 1 };
    task.bump = ctx.bumps.task;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.task = task.key();
    escrow.amount = reward_amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = ctx.bumps.escrow;

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_tasks = config.total_tasks.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(TaskCreated {
        task_id,
        creator: task.creator,
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
