//! Upvote a feed post (one vote per agent per post, enforced by PDA uniqueness)

use crate::errors::CoordinationError;
use crate::events::PostUpvoted;
use crate::state::{AgentRegistration, AgentStatus, FeedPost, FeedVote, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpvotePost<'info> {
    #[account(
        mut,
        seeds = [b"post", post.author.as_ref(), post.nonce.as_ref()],
        bump = post.bump
    )]
    pub post: Account<'info, FeedPost>,

    #[account(
        init,
        payer = authority,
        space = FeedVote::SIZE,
        seeds = [b"upvote", post.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, FeedVote>,

    #[account(
        seeds = [b"agent", voter.agent_id.as_ref()],
        bump = voter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub voter: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<UpvotePost>) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let voter = &ctx.accounts.voter;
    require!(
        voter.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    let post = &ctx.accounts.post;
    require!(
        voter.key() != post.author,
        CoordinationError::FeedSelfUpvote
    );

    let clock = Clock::get()?;

    // Increment upvote count with checked arithmetic
    let post = &mut ctx.accounts.post;
    post.upvote_count = post
        .upvote_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Record vote
    let vote = &mut ctx.accounts.vote;
    vote.post = post.key();
    vote.voter = ctx.accounts.voter.key();
    vote.timestamp = clock.unix_timestamp;
    vote.bump = ctx.bumps.vote;
    vote._reserved = [0u8; 4];

    emit!(PostUpvoted {
        post: post.key(),
        voter: ctx.accounts.voter.key(),
        new_upvote_count: post.upvote_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
