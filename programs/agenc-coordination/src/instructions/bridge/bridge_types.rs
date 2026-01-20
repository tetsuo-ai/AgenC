//! Cross-chain bridge message types for AgenC Protocol
//!
//! These types define the message format for cross-chain coordination
//! via Wormhole or other bridge protocols.

use anchor_lang::prelude::*;

/// Wormhole chain IDs
pub mod chain_ids {
    pub const SOLANA: u16 = 1;
    pub const ETHEREUM: u16 = 2;
    pub const TERRA: u16 = 3;
    pub const BSC: u16 = 4;
    pub const POLYGON: u16 = 5;
    pub const AVALANCHE: u16 = 6;
    pub const OASIS: u16 = 7;
    pub const ALGORAND: u16 = 8;
    pub const AURORA: u16 = 9;
    pub const FANTOM: u16 = 10;
    pub const KARURA: u16 = 11;
    pub const ACALA: u16 = 12;
    pub const KLAYTN: u16 = 13;
    pub const CELO: u16 = 14;
    pub const NEAR: u16 = 15;
    pub const MOONBEAM: u16 = 16;
    pub const NEON: u16 = 17;
    pub const TERRA2: u16 = 18;
    pub const INJECTIVE: u16 = 19;
    pub const OSMOSIS: u16 = 20;
    pub const SUI: u16 = 21;
    pub const APTOS: u16 = 22;
    pub const ARBITRUM: u16 = 23;
    pub const OPTIMISM: u16 = 24;
    pub const GNOSIS: u16 = 25;
    pub const BASE: u16 = 30;
}

/// Cross-chain message types
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CrossChainMessageType {
    /// Task created on source chain, available for cross-chain workers
    TaskCreated = 0,
    /// Worker on another chain claimed the task
    TaskClaimed = 1,
    /// Worker completed task, proof ready for verification
    TaskCompleted = 2,
    /// Task cancelled by creator
    TaskCancelled = 3,
    /// Agent registered for cross-chain work
    AgentRegistered = 4,
    /// Dispute initiated (cross-chain arbitration)
    DisputeInitiated = 5,
    /// Dispute resolved
    DisputeResolved = 6,
}

/// Cross-chain task creation message
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainTaskCreated {
    /// Protocol version for compatibility
    pub version: u8,
    /// Source chain ID (Wormhole chain ID)
    pub source_chain: u16,
    /// Task ID (32 bytes, unique across all chains)
    pub task_id: [u8; 32],
    /// Task creator address (32 bytes, padded for non-32-byte addresses)
    pub creator: [u8; 32],
    /// Required capabilities bitmask
    pub required_capabilities: u64,
    /// Task description hash (not full description to save space)
    pub description_hash: [u8; 32],
    /// Reward amount in source chain's smallest unit
    pub reward_amount: u64,
    /// Deadline (unix timestamp, 0 = no deadline)
    pub deadline: i64,
    /// Task type (0 = exclusive, 1 = collaborative, 2 = competitive)
    pub task_type: u8,
    /// Constraint hash for private tasks (all zeros for public)
    pub constraint_hash: [u8; 32],
    /// Maximum workers allowed
    pub max_workers: u8,
    /// Nonce for replay protection
    pub nonce: u64,
    /// Timestamp of creation
    pub created_at: i64,
}

impl CrossChainTaskCreated {
    pub const VERSION: u8 = 1;

    /// Serialize to bytes for Wormhole message
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        bytes.push(CrossChainMessageType::TaskCreated as u8);
        bytes.extend_from_slice(&self.try_to_vec().unwrap_or_default());
        bytes
    }

    /// Size in bytes (approximate)
    pub const SIZE: usize = 1 + // version
        2 + // source_chain
        32 + // task_id
        32 + // creator
        8 + // required_capabilities
        32 + // description_hash
        8 + // reward_amount
        8 + // deadline
        1 + // task_type
        32 + // constraint_hash
        1 + // max_workers
        8 + // nonce
        8; // created_at
}

/// Cross-chain task claim message
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainTaskClaimed {
    /// Protocol version
    pub version: u8,
    /// Chain where task was created
    pub source_chain: u16,
    /// Chain where worker is registered
    pub worker_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker address (32 bytes, padded)
    pub worker: [u8; 32],
    /// Worker's agent ID on their chain
    pub worker_agent_id: [u8; 32],
    /// Claim expiration timestamp
    pub expires_at: i64,
    /// Nonce for replay protection
    pub nonce: u64,
    /// Timestamp of claim
    pub claimed_at: i64,
}

impl CrossChainTaskClaimed {
    pub const VERSION: u8 = 1;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        bytes.push(CrossChainMessageType::TaskClaimed as u8);
        bytes.extend_from_slice(&self.try_to_vec().unwrap_or_default());
        bytes
    }

    pub const SIZE: usize = 1 + // version
        2 + // source_chain
        2 + // worker_chain
        32 + // task_id
        32 + // worker
        32 + // worker_agent_id
        8 + // expires_at
        8 + // nonce
        8; // claimed_at
}

/// Cross-chain task completion message
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainTaskCompleted {
    /// Protocol version
    pub version: u8,
    /// Chain where task was created (for reward distribution)
    pub source_chain: u16,
    /// Chain where worker completed
    pub worker_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker address
    pub worker: [u8; 32],
    /// For public tasks: proof hash
    /// For private tasks: ZK proof expected_binding
    pub proof_binding: [u8; 32],
    /// Output commitment (for private tasks)
    pub output_commitment: [u8; 32],
    /// Result data hash
    pub result_hash: [u8; 32],
    /// Full ZK proof data (if private task)
    /// Empty for public tasks
    pub proof_data: Vec<u8>,
    /// Timestamp of completion
    pub completed_at: i64,
    /// Nonce for replay protection
    pub nonce: u64,
}

impl CrossChainTaskCompleted {
    pub const VERSION: u8 = 1;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(CrossChainMessageType::TaskCompleted as u8);
        bytes.extend_from_slice(&self.try_to_vec().unwrap_or_default());
        bytes
    }

    /// Base size without proof_data
    pub const BASE_SIZE: usize = 1 + // version
        2 + // source_chain
        2 + // worker_chain
        32 + // task_id
        32 + // worker
        32 + // proof_binding
        32 + // output_commitment
        32 + // result_hash
        8 + // completed_at
        8; // nonce
}

/// Cross-chain task cancellation message
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainTaskCancelled {
    /// Protocol version
    pub version: u8,
    /// Source chain
    pub source_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Creator who cancelled
    pub creator: [u8; 32],
    /// Refund amount
    pub refund_amount: u64,
    /// Timestamp
    pub cancelled_at: i64,
    /// Nonce
    pub nonce: u64,
}

impl CrossChainTaskCancelled {
    pub const VERSION: u8 = 1;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(CrossChainMessageType::TaskCancelled as u8);
        bytes.extend_from_slice(&self.try_to_vec().unwrap_or_default());
        bytes
    }
}

/// Cross-chain agent registration message
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrossChainAgentRegistered {
    /// Protocol version
    pub version: u8,
    /// Chain where agent is registered
    pub home_chain: u16,
    /// Agent ID
    pub agent_id: [u8; 32],
    /// Agent authority address
    pub authority: [u8; 32],
    /// Capabilities bitmask
    pub capabilities: u64,
    /// Reputation score (0-10000)
    pub reputation: u16,
    /// Chains this agent can work on (empty = all chains)
    pub supported_chains: Vec<u16>,
    /// Registration timestamp
    pub registered_at: i64,
    /// Nonce
    pub nonce: u64,
}

impl CrossChainAgentRegistered {
    pub const VERSION: u8 = 1;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(CrossChainMessageType::AgentRegistered as u8);
        bytes.extend_from_slice(&self.try_to_vec().unwrap_or_default());
        bytes
    }
}

/// Bridge configuration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct BridgeConfig {
    /// Whether cross-chain is enabled
    pub enabled: bool,
    /// Minimum reward for cross-chain tasks (covers gas)
    pub min_cross_chain_reward: u64,
    /// Maximum message size in bytes
    pub max_message_size: u32,
    /// VAA expiration in seconds
    pub vaa_expiration_seconds: i64,
    /// Required confirmations before processing
    pub required_confirmations: u8,
    /// Wormhole core bridge address (if applicable)
    pub wormhole_bridge: [u8; 32],
    /// List of allowed destination chains (empty = all)
    pub allowed_chains: Vec<u16>,
}

impl BridgeConfig {
    /// Default minimum reward (0.1 SOL equivalent)
    pub const DEFAULT_MIN_REWARD: u64 = 100_000_000; // 0.1 SOL in lamports

    /// Default VAA expiration (24 hours)
    pub const DEFAULT_VAA_EXPIRATION: i64 = 86400;

    /// Default required confirmations
    pub const DEFAULT_CONFIRMATIONS: u8 = 32;
}

/// Nonce tracker for replay protection
#[account]
pub struct CrossChainNonce {
    /// Source chain ID
    pub source_chain: u16,
    /// Task ID this nonce is for
    pub task_id: [u8; 32],
    /// Last processed nonce
    pub last_nonce: u64,
    /// Bump seed
    pub bump: u8,
}

impl CrossChainNonce {
    pub const SIZE: usize = 8 + // discriminator
        2 + // source_chain
        32 + // task_id
        8 + // last_nonce
        1; // bump

    /// PDA seeds: ["xchain_nonce", source_chain, task_id]
    pub fn seeds<'a>(source_chain: &'a [u8], task_id: &'a [u8; 32]) -> [&'a [u8]; 3] {
        [b"xchain_nonce", source_chain, task_id]
    }
}

/// Pending cross-chain claim (waiting for finality)
#[account]
pub struct PendingCrossChainClaim {
    /// Source chain
    pub source_chain: u16,
    /// Worker chain
    pub worker_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker address
    pub worker: [u8; 32],
    /// VAA hash for verification
    pub vaa_hash: [u8; 32],
    /// Expiration timestamp
    pub expires_at: i64,
    /// Whether this claim has been processed
    pub processed: bool,
    /// Bump seed
    pub bump: u8,
}

impl PendingCrossChainClaim {
    pub const SIZE: usize = 8 + // discriminator
        2 + // source_chain
        2 + // worker_chain
        32 + // task_id
        32 + // worker
        32 + // vaa_hash
        8 + // expires_at
        1 + // processed
        1; // bump
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_created_serialization() {
        let msg = CrossChainTaskCreated {
            version: 1,
            source_chain: chain_ids::SOLANA,
            task_id: [1u8; 32],
            creator: [2u8; 32],
            required_capabilities: 5,
            description_hash: [3u8; 32],
            reward_amount: 1_000_000_000,
            deadline: 0,
            task_type: 0,
            constraint_hash: [0u8; 32],
            max_workers: 1,
            nonce: 1,
            created_at: 1700000000,
        };

        let bytes = msg.to_bytes();
        assert!(!bytes.is_empty());
        assert_eq!(bytes[0], CrossChainMessageType::TaskCreated as u8);
    }

    #[test]
    fn test_chain_ids() {
        assert_eq!(chain_ids::SOLANA, 1);
        assert_eq!(chain_ids::ETHEREUM, 2);
        assert_eq!(chain_ids::BASE, 30);
    }
}
