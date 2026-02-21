//! Register a new skill on-chain

use crate::errors::CoordinationError;
use crate::events::SkillRegistered;
use crate::instructions::constants::MIN_SKILL_PRICE;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig, SkillRegistration};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(skill_id: [u8; 32])]
pub struct RegisterSkill<'info> {
    #[account(
        init,
        payer = authority,
        space = SkillRegistration::SIZE,
        seeds = [b"skill", author.key().as_ref(), skill_id.as_ref()],
        bump
    )]
    pub skill: Account<'info, SkillRegistration>,

    #[account(
        seeds = [b"agent", author.agent_id.as_ref()],
        bump = author.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub author: Account<'info, AgentRegistration>,

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
    ctx: Context<RegisterSkill>,
    skill_id: [u8; 32],
    name: [u8; 32],
    content_hash: [u8; 32],
    price: u64,
    price_mint: Option<Pubkey>,
    tags: [u8; 64],
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let author = &ctx.accounts.author;
    require!(
        author.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(skill_id != [0u8; 32], CoordinationError::SkillInvalidId);
    require!(name != [0u8; 32], CoordinationError::SkillInvalidName);
    require!(
        content_hash != [0u8; 32],
        CoordinationError::SkillInvalidContentHash
    );
    require!(
        price >= MIN_SKILL_PRICE,
        CoordinationError::SkillPriceBelowMinimum
    );

    let clock = Clock::get()?;
    let skill = &mut ctx.accounts.skill;

    skill.author = ctx.accounts.author.key();
    skill.skill_id = skill_id;
    skill.name = name;
    skill.content_hash = content_hash;
    skill.price = price;
    skill.price_mint = price_mint;
    skill.tags = tags;
    skill.total_rating = 0;
    skill.rating_count = 0;
    skill.download_count = 0;
    skill.version = 1;
    skill.is_active = true;
    skill.created_at = clock.unix_timestamp;
    skill.updated_at = clock.unix_timestamp;
    skill.bump = ctx.bumps.skill;
    skill._reserved = [0u8; 8];

    emit!(SkillRegistered {
        skill: skill.key(),
        author: author.key(),
        skill_id,
        name,
        content_hash,
        price,
        price_mint,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
