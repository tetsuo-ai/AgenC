//! Withdraw SOL from reputation stake after cooldown

use crate::errors::CoordinationError;
use crate::events::ReputationStakeWithdrawn;
use crate::state::{AgentRegistration, ReputationStake};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct WithdrawReputationStake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"reputation_stake", agent.key().as_ref()],
        bump = reputation_stake.bump,
    )]
    pub reputation_stake: Account<'info, ReputationStake>,
}

pub fn handler(ctx: Context<WithdrawReputationStake>, amount: u64) -> Result<()> {
    require!(amount > 0, CoordinationError::ReputationStakeAmountTooLow);

    let clock = Clock::get()?;
    let stake = &mut ctx.accounts.reputation_stake;
    let agent = &ctx.accounts.agent;

    // Check cooldown has passed
    require!(
        clock.unix_timestamp >= stake.locked_until,
        CoordinationError::ReputationStakeLocked
    );

    // Check no pending disputes as defendant
    require!(
        agent.disputes_as_defendant == 0,
        CoordinationError::ReputationDisputesPending
    );

    // Check sufficient balance
    require!(
        amount <= stake.staked_amount,
        CoordinationError::ReputationStakeInsufficientBalance
    );

    // Transfer lamports from PDA to authority (program-owned account manipulation)
    let stake_info = stake.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();

    **stake_info.try_borrow_mut_lamports()? = stake_info
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    **authority_info.try_borrow_mut_lamports()? = authority_info
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    stake.staked_amount = stake
        .staked_amount
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(ReputationStakeWithdrawn {
        agent: ctx.accounts.agent.key(),
        amount,
        remaining_staked: stake.staked_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
