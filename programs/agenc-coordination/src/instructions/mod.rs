//! Instruction handlers for AgenC Coordination Protocol

pub mod register_agent;
pub mod update_agent;
pub mod deregister_agent;
pub mod create_task;
pub mod claim_task;
pub mod complete_task;
pub mod cancel_task;
pub mod update_state;
pub mod initiate_dispute;
pub mod vote_dispute;
pub mod resolve_dispute;
pub mod initialize_protocol;

pub use register_agent::*;
pub use update_agent::*;
pub use deregister_agent::*;
pub use create_task::*;
pub use claim_task::*;
pub use complete_task::*;
pub use cancel_task::*;
pub use update_state::*;
pub use initiate_dispute::*;
pub use vote_dispute::*;
pub use resolve_dispute::*;
pub use initialize_protocol::*;
