//! Emit cross-chain task instruction.
//!
//! Allows task creators to emit tasks for execution on other chains.

use anchor_lang::prelude::*;

use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskStatus};

use super::{
    BridgeConfig, BridgeError, ChainId, CrossChainHeader, CrossChainMessage, CrossChainTaskPayload,
};

/// Event emitted when a cross-chain task is created.
#[event]
pub struct CrossChainTaskEmitted {
    /// Hash of the cross-chain message
    pub message_hash: [u8; 32],
    /// Source chain (always Solana for this program)
    pub source_chain: u16,
    /// Target chain for task execution
    pub target_chain: u16,
    /// Original task ID on Solana
    pub task_id: [u8; 32],
    /// Task creator
    pub creator: Pubkey,
    /// Reward amount
    pub reward_amount: u64,
    /// Emission timestamp
    pub timestamp: i64,
}

#[derive(Accounts)]
#[instruction(target_chain: u16, nonce: u64)]
pub struct EmitCrossChainTask<'info> {
    /// The task to emit cross-chain
    #[account(
        constraint = task.status == TaskStatus::Open @ BridgeError::ChainMismatch,
        constraint = task.creator == creator.key() @ BridgeError::ChainMismatch,
    )]
    pub task: Account<'info, Task>,

    /// Bridge configuration
    #[account(
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.is_active @ BridgeError::BridgeInactive,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    /// Creator's agent registration
    #[account(
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ BridgeError::ChainMismatch,
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// Protocol configuration
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Task creator (must sign)
    pub creator: Signer<'info>,

    /// Creator's authority
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Emit a task for cross-chain execution.
///
/// This instruction creates a cross-chain message that can be picked up
/// by bridge relayers and executed on the target chain.
///
/// # Arguments
/// * `target_chain` - The target chain ID (see ChainId enum)
/// * `nonce` - Unique nonce to prevent replay attacks
///
/// # Emits
/// * `CrossChainTaskEmitted` - Contains message hash and task details
pub fn emit_cross_chain_task(
    ctx: Context<EmitCrossChainTask>,
    target_chain: u16,
    nonce: u64,
) -> Result<()> {
    let task = &ctx.accounts.task;
    let bridge_config = &ctx.accounts.bridge_config;
    let clock = Clock::get()?;

    // Validate target chain
    let target = ChainId::from_u16(target_chain).ok_or(BridgeError::InvalidTargetChain)?;

    // Cannot emit to same chain
    require!(target != ChainId::Solana, BridgeError::ChainMismatch);

    // Build cross-chain message
    let header = CrossChainHeader::new(ChainId::Solana, target, nonce);

    let payload = CrossChainTaskPayload {
        task_id: task.task_id,
        creator: ctx.accounts.creator.key().to_bytes(),
        required_capabilities: task.required_capabilities,
        reward_amount: task.reward_amount,
        reward_token: [0u8; 32], // Native SOL
        description_hash: {
            // Fold 64-byte description into 32-byte hash via XOR
            let mut hash = [0u8; 32];
            for i in 0..32 {
                hash[i] = task.description[i] ^ task.description[i + 32];
            }
            hash
        },
        deadline: task.deadline,
        max_workers: task.max_workers,
        task_type: match task.task_type {
            crate::state::TaskType::Exclusive => 0,
            crate::state::TaskType::Collaborative => 1,
            crate::state::TaskType::Competitive => 2,
        },
    };

    let message = CrossChainMessage { header, payload };

    // Validate message size
    require!(
        CrossChainMessage::MAX_SIZE <= bridge_config.max_message_size as usize,
        BridgeError::MessageTooLarge
    );

    // Compute message hash
    let message_hash = message.compute_hash();

    // Emit event for relayers
    emit!(CrossChainTaskEmitted {
        message_hash,
        source_chain: ChainId::Solana as u16,
        target_chain,
        task_id: task.task_id,
        creator: ctx.accounts.creator.key(),
        reward_amount: task.reward_amount,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Cross-chain task emitted: {:?} -> chain {}",
        task.task_id,
        target_chain
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chain_id_conversion() {
        assert_eq!(ChainId::from_u16(1), Some(ChainId::Solana));
        assert_eq!(ChainId::from_u16(2), Some(ChainId::Ethereum));
        assert_eq!(ChainId::from_u16(99), None);
    }

    #[test]
    fn test_message_size() {
        assert!(CrossChainMessage::MAX_SIZE < 1024);
    }
}
