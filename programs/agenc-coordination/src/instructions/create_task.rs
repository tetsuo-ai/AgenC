//! Create a new task with reward escrow

use crate::errors::CoordinationError;
use crate::events::TaskCreated;
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskEscrow};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use super::rate_limit_helpers::check_task_creation_rate_limits;
use super::task_init_helpers::{init_escrow_fields, init_task_fields, increment_total_tasks, validate_deadline, validate_task_params};

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

    /// Creator's agent registration for rate limiting (required)
    #[account(
        mut,
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// The authority that owns the creator_agent
    pub authority: Signer<'info>,

    /// The creator who pays for and owns the task
    /// Must match authority to prevent social engineering attacks (#375)
    #[account(
        mut,
        constraint = creator.key() == authority.key() @ CoordinationError::CreatorAuthorityMismatch
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===

    /// SPL token mint for reward denomination (optional)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// Creator's token account holding reward tokens (optional)
    #[account(mut)]
    pub creator_token_account: Option<Account<'info, TokenAccount>>,

    /// Escrow's associated token account for holding reward tokens (optional).
    /// Created via ATA CPI during handler if token task.
    /// CHECK: Validated in handler via ATA derivation check
    #[account(mut)]
    pub token_escrow_ata: Option<UncheckedAccount<'info>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    /// Associated Token Account program (optional, required for token tasks)
    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
}

/// Creates a new task.
///
/// # Parameters
/// - `task_type`: Task execution type (0=Exclusive, 1=Collaborative, 2=Competitive)
///   Validated to be in range 0-2.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
    constraint_hash: Option<[u8; 32]>,
    min_reputation: u16,
    reward_mint: Option<Pubkey>,
) -> Result<()> {
    validate_task_params(&task_id, &description, required_capabilities, max_workers, task_type, min_reputation)?;
    // Validate reward is not zero (#540) - not in shared validator since dependent tasks allow zero
    require!(reward_amount > 0, CoordinationError::InvalidReward);

    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Validate deadline - must be set and in the future (#575)
    validate_deadline(deadline, &clock, true)?;

    let creator_agent = &mut ctx.accounts.creator_agent;

    // Check rate limits and update agent state
    check_task_creation_rate_limits(creator_agent, config, &clock)?;

    if reward_mint.is_some() {
        // Token path: validate required token accounts are provided
        require!(
            ctx.accounts.reward_mint.is_some()
                && ctx.accounts.creator_token_account.is_some()
                && ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.token_program.is_some()
                && ctx.accounts.associated_token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = ctx.accounts.reward_mint.as_ref().unwrap();
        let creator_ta = ctx.accounts.creator_token_account.as_ref().unwrap();
        let token_escrow_ata = ctx.accounts.token_escrow_ata.as_ref().unwrap();
        let token_program = ctx.accounts.token_program.as_ref().unwrap();
        let ata_program = ctx.accounts.associated_token_program.as_ref().unwrap();

        // Validate mint matches the provided reward_mint
        require!(
            mint.key() == reward_mint.unwrap(),
            CoordinationError::InvalidTokenMint
        );

        // Create escrow ATA via CPI (payer = creator)
        anchor_spl::associated_token::create(CpiContext::new(
            ata_program.to_account_info(),
            anchor_spl::associated_token::Create {
                payer: ctx.accounts.creator.to_account_info(),
                associated_token: token_escrow_ata.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
                mint: mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program.to_account_info(),
            },
        ))?;

        // Transfer tokens from creator ATA to escrow ATA
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: creator_ta.to_account_info(),
                    to: token_escrow_ata.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            reward_amount,
        )?;
    } else {
        // SOL path: existing lamport transfer (unchanged)
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
    init_task_fields(
        task,
        task_id,
        ctx.accounts.creator.key(),
        required_capabilities,
        description,
        constraint_hash,
        reward_amount,
        max_workers,
        task_type,
        deadline,
        ctx.accounts.escrow.key(),
        ctx.bumps.task,
        config.protocol_fee_bps,
        clock.unix_timestamp,
        min_reputation,
        reward_mint,
    )?;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    init_escrow_fields(escrow, task.key(), reward_amount, ctx.bumps.escrow);

    // Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    increment_total_tasks(protocol_config)?;

    emit!(TaskCreated {
        task_id,
        creator: task.creator,
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        min_reputation,
        reward_mint,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
