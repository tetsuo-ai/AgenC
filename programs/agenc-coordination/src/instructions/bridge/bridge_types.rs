//! Cross-chain bridge types and message encoding.
//!
//! Defines the message format for cross-chain task coordination.

use anchor_lang::prelude::*;

/// Supported chain identifiers.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum ChainId {
    Solana = 1,
    Ethereum = 2,
    Polygon = 3,
    Arbitrum = 4,
    Base = 5,
}

impl ChainId {
    pub fn from_u16(value: u16) -> Option<Self> {
        match value {
            1 => Some(ChainId::Solana),
            2 => Some(ChainId::Ethereum),
            3 => Some(ChainId::Polygon),
            4 => Some(ChainId::Arbitrum),
            5 => Some(ChainId::Base),
            _ => None,
        }
    }

    pub fn is_supported(&self) -> bool {
        matches!(self, ChainId::Solana)
    }
}

/// Cross-chain message header.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CrossChainHeader {
    /// Protocol version for compatibility
    pub version: u8,
    /// Source chain identifier
    pub source_chain: u16,
    /// Target chain identifier
    pub target_chain: u16,
    /// Unique nonce to prevent replay
    pub nonce: u64,
    /// Unix timestamp of message creation
    pub timestamp: i64,
}

impl CrossChainHeader {
    pub const SIZE: usize = 1 + 2 + 2 + 8 + 8; // 21 bytes

    pub fn new(source_chain: ChainId, target_chain: ChainId, nonce: u64) -> Self {
        Self {
            version: 1,
            source_chain: source_chain as u16,
            target_chain: target_chain as u16,
            nonce,
            timestamp: Clock::get().unwrap().unix_timestamp,
        }
    }
}

/// Cross-chain task payload.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CrossChainTaskPayload {
    /// Original task ID on source chain
    pub task_id: [u8; 32],
    /// Task creator's address (chain-agnostic format)
    pub creator: [u8; 32],
    /// Required agent capabilities bitmask
    pub required_capabilities: u64,
    /// Reward amount in smallest unit
    pub reward_amount: u64,
    /// Reward token address (zero for native)
    pub reward_token: [u8; 32],
    /// Hash of task description
    pub description_hash: [u8; 32],
    /// Task deadline (unix timestamp)
    pub deadline: i64,
    /// Maximum number of workers
    pub max_workers: u8,
    /// Task type (exclusive, collaborative, competitive)
    pub task_type: u8,
}

impl CrossChainTaskPayload {
    pub const SIZE: usize = 32 + 32 + 8 + 8 + 32 + 32 + 8 + 1 + 1; // 154 bytes
}

/// Complete cross-chain message.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CrossChainMessage {
    pub header: CrossChainHeader,
    pub payload: CrossChainTaskPayload,
}

impl CrossChainMessage {
    pub const MAX_SIZE: usize = CrossChainHeader::SIZE + CrossChainTaskPayload::SIZE;

    /// Compute the message hash for signing/verification.
    pub fn compute_hash(&self) -> [u8; 32] {
        let mut data = Vec::with_capacity(Self::MAX_SIZE);
        self.serialize(&mut data).unwrap();
        // Fold serialized data into 32-byte hash via XOR
        let mut hash = [0u8; 32];
        for (i, byte) in data.iter().enumerate() {
            hash[i % 32] ^= byte;
        }
        hash
    }
}

/// Relayer registration for cross-chain message relay.
#[account]
#[derive(Debug)]
pub struct RelayerRegistration {
    /// Relayer authority
    pub authority: Pubkey,
    /// Staked amount
    pub stake: u64,
    /// Number of successful relays
    pub successful_relays: u64,
    /// Number of failed relays
    pub failed_relays: u64,
    /// Registration timestamp
    pub registered_at: i64,
    /// Last relay timestamp
    pub last_relay_at: i64,
    /// Is active
    pub is_active: bool,
    /// Account bump
    pub bump: u8,
}

impl RelayerRegistration {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

/// Cross-chain message receipt for tracking.
#[account]
#[derive(Debug)]
pub struct MessageReceipt {
    /// Message hash
    pub message_hash: [u8; 32],
    /// Source chain
    pub source_chain: u16,
    /// Target chain
    pub target_chain: u16,
    /// Original task ID
    pub original_task_id: [u8; 32],
    /// Local task ID (if created)
    pub local_task_id: [u8; 32],
    /// Relayer who submitted
    pub relayer: Pubkey,
    /// Receipt timestamp
    pub received_at: i64,
    /// Processing status
    pub status: MessageStatus,
    /// Account bump
    pub bump: u8,
}

impl MessageReceipt {
    pub const SIZE: usize = 8 + 32 + 2 + 2 + 32 + 32 + 32 + 8 + 1 + 1;
}

/// Message processing status.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageStatus {
    Pending,
    Processed,
    Failed,
    Expired,
}

/// Bridge configuration account.
#[account]
#[derive(Debug)]
pub struct BridgeConfig {
    /// Protocol authority
    pub authority: Pubkey,
    /// Minimum relayer stake
    pub min_relayer_stake: u64,
    /// Relay timeout in seconds
    pub relay_timeout: i64,
    /// Required confirmations for consensus
    pub required_confirmations: u8,
    /// Maximum message size
    pub max_message_size: u16,
    /// Is bridge active
    pub is_active: bool,
    /// Total messages sent
    pub total_messages_sent: u64,
    /// Total messages received
    pub total_messages_received: u64,
    /// Account bump
    pub bump: u8,
}

impl BridgeConfig {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 1 + 2 + 1 + 8 + 8 + 1;
}

/// Bridge-specific errors.
#[error_code]
pub enum BridgeError {
    #[msg("Target chain is not supported")]
    InvalidTargetChain,

    #[msg("Message exceeds maximum size")]
    MessageTooLarge,

    #[msg("Relayer stake is below minimum")]
    InsufficientRelayerStake,

    #[msg("Relay timeout exceeded")]
    RelayTimeout,

    #[msg("Invalid message signature")]
    InvalidSignature,

    #[msg("Nonce has already been used")]
    NonceReused,

    #[msg("Chain ID mismatch")]
    ChainMismatch,

    #[msg("Bridge is not active")]
    BridgeInactive,

    #[msg("Relayer is not registered")]
    RelayerNotRegistered,

    #[msg("Relayer is not active")]
    RelayerNotActive,

    #[msg("Message already processed")]
    MessageAlreadyProcessed,
}
