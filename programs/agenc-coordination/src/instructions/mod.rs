//! Instruction handlers for AgenC Coordination Protocol
//!
//! # Module Organization
//!
//! Each instruction module exports:
//! - An accounts context struct (e.g., `ClaimTask`) with `#[derive(Accounts)]`
//! - A handler function (usually named `handler`)
//!
//! # Why Glob Re-exports?
//!
//! The `pub use module::*` pattern is intentional here. The Anchor framework's
//! `#[derive(Accounts)]` macro generates additional types (like `__client_accounts_*`)
//! that must be accessible from the crate root for the `#[program]` macro to work
//! correctly. These generated types are not part of the public API but are required
//! for Anchor's code generation.
//!
//! The `#[allow(ambiguous_glob_reexports)]` attributes suppress warnings when
//! multiple modules export items with the same name (e.g., `handler`). These
//! handlers are accessed via their module path (e.g., `claim_task::handler`)
//! rather than directly, so the ambiguity doesn't affect usage.

pub mod completion_helpers;
pub mod constants;
pub mod rate_limit_helpers;
pub mod task_init_helpers;
pub mod validation;

pub mod apply_dispute_slash;
pub mod apply_initiator_slash;
pub mod cancel_dispute;
pub mod cancel_task;
pub mod claim_task;
pub mod complete_task;
pub mod complete_task_private;
pub mod create_dependent_task;
pub mod create_task;
pub mod deregister_agent;
pub mod expire_claim;
pub mod expire_dispute;
pub mod initialize_protocol;
pub mod initiate_dispute;
pub mod migrate;
pub mod register_agent;
pub mod resolve_dispute;
pub mod update_agent;
pub mod update_protocol_fee;
pub mod update_rate_limits;
pub mod update_state;
pub mod vote_dispute;

// Glob re-exports are required for Anchor's #[program] macro to access generated
// types from #[derive(Accounts)]. See module documentation for details.
#[allow(ambiguous_glob_reexports)]
pub use apply_dispute_slash::*;
#[allow(ambiguous_glob_reexports)]
pub use apply_initiator_slash::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_dispute::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_task::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_task::*;
#[allow(ambiguous_glob_reexports)]
pub use complete_task::*;
#[allow(ambiguous_glob_reexports)]
pub use complete_task_private::*;
#[allow(ambiguous_glob_reexports)]
pub use create_dependent_task::*;
pub use create_task::*;
#[allow(ambiguous_glob_reexports)]
pub use deregister_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use expire_claim::*;
pub use expire_dispute::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize_protocol::*;
#[allow(ambiguous_glob_reexports)]
pub use initiate_dispute::*;
#[allow(ambiguous_glob_reexports)]
pub use migrate::*;
#[allow(ambiguous_glob_reexports)]
pub use register_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use resolve_dispute::*;
#[allow(ambiguous_glob_reexports)]
pub use update_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use update_protocol_fee::*;
#[allow(ambiguous_glob_reexports)]
pub use update_rate_limits::*;
#[allow(ambiguous_glob_reexports)]
pub use update_state::*;
#[allow(ambiguous_glob_reexports)]
pub use vote_dispute::*;
