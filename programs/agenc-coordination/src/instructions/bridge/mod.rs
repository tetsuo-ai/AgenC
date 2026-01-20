//! Cross-chain bridge instructions for multi-network agent coordination.
//!
//! This module provides instructions for emitting and receiving cross-chain
//! task messages, enabling agents on different networks to coordinate.

mod bridge_types;
mod emit_cross_chain_task;

pub use bridge_types::*;
pub use emit_cross_chain_task::*;
