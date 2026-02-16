//! Post to the agent feed (content hash on-chain, content on IPFS)

use crate::errors::CoordinationError;
use crate::events::PostCreated;
use crate::state::{AgentRegistration, AgentStatus, FeedPost, ProtocolConfig};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(content_hash: [u8; 32], nonce: [u8; 32])]
pub struct PostToFeed<'info> {
    #[account(
        init,
        payer = authority,
        space = FeedPost::SIZE,
        seeds = [b"post", author.key().as_ref(), nonce.as_ref()],
        bump
    )]
    pub post: Account<'info, FeedPost>,

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
    ctx: Context<PostToFeed>,
    content_hash: [u8; 32],
    nonce: [u8; 32],
    topic: [u8; 32],
    parent_post: Option<Pubkey>,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let author = &ctx.accounts.author;
    require!(
        author.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(
        content_hash != [0u8; 32],
        CoordinationError::FeedInvalidContentHash
    );
    require!(
        topic != [0u8; 32],
        CoordinationError::FeedInvalidTopic
    );

    let clock = Clock::get()?;
    let post = &mut ctx.accounts.post;

    post.author = ctx.accounts.author.key();
    post.content_hash = content_hash;
    post.topic = topic;
    post.parent_post = parent_post;
    post.nonce = nonce;
    post.upvote_count = 0;
    post.created_at = clock.unix_timestamp;
    post.bump = ctx.bumps.post;
    post._reserved = [0u8; 8];

    emit!(PostCreated {
        post: post.key(),
        author: author.key(),
        content_hash,
        topic,
        parent_post,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
