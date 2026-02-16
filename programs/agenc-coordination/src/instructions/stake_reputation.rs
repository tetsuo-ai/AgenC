//! Stake SOL on agent reputation

use crate::errors::CoordinationError;
use crate::events::ReputationStaked;
use crate::state::{AgentRegistration, AgentStatus, ReputationStake};
use anchor_lang::prelude::*;

use super::constants::REPUTATION_STAKING_COOLDOWN;

#[derive(Accounts)]
pub struct StakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ReputationStake::SIZE,
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump
    )]
    pub reputation_stake: Account<'info, ReputationStake>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<StakeReputation>, amount: u64) -> Result<()> {
    require!(amount > 0, CoordinationError::ReputationStakeAmountTooLow);

    let agent = &ctx.accounts.agent;
    require!(
        agent.status == AgentStatus::Active,
        CoordinationError::ReputationAgentNotActive
    );

    let clock = Clock::get()?;
    let stake = &mut ctx.accounts.reputation_stake;

    // Initialize on first use
    if stake.agent == Pubkey::default() {
        stake.agent = ctx.accounts.agent.key();
        stake.created_at = clock.unix_timestamp;
        stake.bump = ctx.bumps.reputation_stake;
    }

    // Transfer SOL from authority to stake PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: stake.to_account_info(),
            },
        ),
        amount,
    )?;

    stake.staked_amount = stake
        .staked_amount
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    stake.locked_until = clock
        .unix_timestamp
        .checked_add(REPUTATION_STAKING_COOLDOWN)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(ReputationStaked {
        agent: ctx.accounts.agent.key(),
        amount,
        total_staked: stake.staked_amount,
        locked_until: stake.locked_until,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
