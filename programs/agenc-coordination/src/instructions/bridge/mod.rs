//! Cross-chain bridge instructions for AgenC Protocol
//!
//! This module provides cross-chain coordination via Wormhole or other
//! bridge protocols. It enables:
//!
//! - Cross-chain task creation and discovery
//! - Cross-chain agent registration
//! - Cross-chain task claiming and completion
//! - Cross-chain proof verification
//!
//! # Security
//!
//! All cross-chain messages include:
//! - Nonce for replay protection
//! - Chain ID binding
//! - Timestamp for expiration
//! - Message type for routing
//!
//! # Usage
//!
//! ```ignore
//! // Emit a cross-chain task
//! emit_cross_chain_task(ctx, params)?;
//!
//! // Receive a cross-chain claim (via Wormhole VAA)
//! receive_cross_chain_claim(ctx, vaa)?;
//! ```

pub mod bridge_types;
pub mod emit_cross_chain_task;

pub use bridge_types::*;
pub use emit_cross_chain_task::*;
