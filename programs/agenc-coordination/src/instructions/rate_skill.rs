//! Rate a skill (reputation-weighted, one rating per agent per skill)

use crate::errors::CoordinationError;
use crate::events::SkillRated;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig, SkillRating, SkillRegistration};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RateSkill<'info> {
    #[account(
        mut,
        seeds = [b"skill", skill.author.as_ref(), skill.skill_id.as_ref()],
        bump = skill.bump
    )]
    pub skill: Account<'info, SkillRegistration>,

    #[account(
        init,
        payer = authority,
        space = SkillRating::SIZE,
        seeds = [b"skill_rating", skill.key().as_ref(), rater.key().as_ref()],
        bump
    )]
    pub rating_account: Account<'info, SkillRating>,

    #[account(
        seeds = [b"agent", rater.agent_id.as_ref()],
        bump = rater.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub rater: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RateSkill>,
    rating: u8,
    review_hash: Option<[u8; 32]>,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let rater = &ctx.accounts.rater;
    require!(
        rater.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(
        rating >= 1 && rating <= 5,
        CoordinationError::SkillInvalidRating
    );

    let skill = &ctx.accounts.skill;
    require!(
        skill.is_active,
        CoordinationError::SkillNotActive
    );

    require!(
        rater.key() != skill.author,
        CoordinationError::SkillSelfRating
    );

    let clock = Clock::get()?;

    // Reputation-weighted rating: rating * rater_reputation
    let weighted = (rating as u64)
        .checked_mul(rater.reputation as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let skill = &mut ctx.accounts.skill;
    skill.total_rating = skill
        .total_rating
        .checked_add(weighted)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    skill.rating_count = skill
        .rating_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Record rating
    let rating_account = &mut ctx.accounts.rating_account;
    rating_account.skill = skill.key();
    rating_account.rater = rater.key();
    rating_account.rating = rating;
    rating_account.review_hash = review_hash;
    rating_account.rater_reputation = rater.reputation;
    rating_account.timestamp = clock.unix_timestamp;
    rating_account.bump = ctx.bumps.rating_account;
    rating_account._reserved = [0u8; 4];

    emit!(SkillRated {
        skill: skill.key(),
        rater: rater.key(),
        rating,
        rater_reputation: rater.reputation,
        new_total_rating: skill.total_rating,
        new_rating_count: skill.rating_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
