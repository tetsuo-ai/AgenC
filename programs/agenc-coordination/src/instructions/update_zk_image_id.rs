//! Rotate the trusted ZK image ID.

use crate::errors::CoordinationError;
use crate::events::ZkImageIdUpdated;
use crate::instructions::zk_config_helpers::require_nonzero_image_id;
use crate::state::{ProtocolConfig, ZkConfig, HASH_SIZE};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateZkImageId<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        has_one = authority @ CoordinationError::UnauthorizedProtocolAuthority
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"zk_config"],
        bump = zk_config.bump
    )]
    pub zk_config: Account<'info, ZkConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateZkImageId>, new_image_id: [u8; HASH_SIZE]) -> Result<()> {
    require_nonzero_image_id(&new_image_id)?;

    let zk_config = &mut ctx.accounts.zk_config;
    require!(
        zk_config.active_image_id != new_image_id,
        CoordinationError::InvalidInput
    );

    let old_image_id = zk_config.active_image_id;
    zk_config.active_image_id = new_image_id;

    emit!(ZkImageIdUpdated {
        old_image_id,
        new_image_id,
        updated_by: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
