#![allow(unexpected_cfgs)]
//! AgenC Coordination Protocol
//!
//! A decentralized multi-agent coordination layer for the AgenC framework.
//! Enables trustless task distribution, state synchronization, and resource
//! allocation across edge computing agents.

use anchor_lang::prelude::*;

declare_id!("EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

#[program]
pub mod agenc_coordination {
    use super::*;

    /// Register a new agent on-chain with its capabilities and metadata.
    /// Creates a unique PDA for the agent that serves as its on-chain identity.
    ///
    /// # Arguments
    /// * `ctx` - Context containing agent account and signer
    /// * `agent_id` - Unique 32-byte identifier for the agent
    /// * `capabilities` - Bitmask of agent capabilities (see AgentCapability)
    /// * `endpoint` - Network endpoint for off-chain communication
    /// * `metadata_uri` - Optional URI to extended metadata (IPFS/Arweave)
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: [u8; 32],
        capabilities: u64,
        endpoint: String,
        metadata_uri: Option<String>,
        stake_amount: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(
            ctx,
            agent_id,
            capabilities,
            endpoint,
            metadata_uri,
            stake_amount,
        )
    }

    /// Update an existing agent's registration data.
    /// Only the agent's authority can modify its registration.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        capabilities: Option<u64>,
        endpoint: Option<String>,
        metadata_uri: Option<String>,
        status: Option<u8>,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, capabilities, endpoint, metadata_uri, status)
    }

    /// Deregister an agent and reclaim rent.
    /// Agent must have no active tasks.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        instructions::deregister_agent::handler(ctx)
    }

    /// Create a new task with requirements and optional reward.
    /// Tasks are stored in a PDA derived from the creator and task ID.
    ///
    /// # Arguments
    /// * `ctx` - Context with task account and creator
    /// * `task_id` - Unique identifier for the task
    /// * `required_capabilities` - Bitmask of required agent capabilities
    /// * `description` - Task description or instruction hash
    /// * `reward_amount` - SOL or token reward for completion
    /// * `max_workers` - Maximum number of agents that can work on this task
    /// * `deadline` - Unix timestamp deadline (0 = no deadline)
    /// * `task_type` - 0=exclusive (single worker), 1=collaborative (multi-worker)
    /// * `constraint_hash` - For private tasks: hash of expected output (None for non-private)
    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        max_workers: u8,
        deadline: i64,
        task_type: u8,
        constraint_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::create_task::handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            max_workers,
            deadline,
            task_type,
            constraint_hash,
        )
    }

    /// Claim a task to signal intent to work on it.
    /// Agent must have required capabilities and task must be claimable.
    pub fn claim_task(ctx: Context<ClaimTask>) -> Result<()> {
        instructions::claim_task::handler(ctx)
    }

    /// Expire a stale claim to free up task slot.
    /// Can only be called after claim.expires_at has passed.
    pub fn expire_claim(ctx: Context<ExpireClaim>) -> Result<()> {
        instructions::expire_claim::handler(ctx)
    }

    /// Submit proof of work and mark task portion as complete.
    /// For collaborative tasks, multiple completions may be needed.
    ///
    /// # Arguments
    /// * `ctx` - Context with task, worker claim, and reward accounts
    /// * `proof_hash` - 32-byte hash of the proof of work
    /// * `result_data` - Optional result data or pointer
    pub fn complete_task(
        ctx: Context<CompleteTask>,
        proof_hash: [u8; 32],
        result_data: Option<[u8; 64]>,
    ) -> Result<()> {
        instructions::complete_task::handler(ctx, proof_hash, result_data)
    }

    /// Complete a task with private proof verification.
    pub fn complete_task_private(
        ctx: Context<CompleteTaskPrivate>,
        task_id: u64,
        proof: PrivateCompletionProof,
    ) -> Result<()> {
        instructions::complete_task_private::complete_task_private(ctx, task_id, proof)
    }

    /// Cancel an unclaimed or expired task and reclaim funds.
    pub fn cancel_task(ctx: Context<CancelTask>) -> Result<()> {
        instructions::cancel_task::handler(ctx)
    }

    /// Update shared coordination state.
    /// Used for broadcasting state changes to other agents.
    ///
    /// # Arguments
    /// * `ctx` - Context with coordination PDA
    /// * `state_key` - Key identifying the state variable
    /// * `state_value` - New value for the state
    /// * `version` - Expected current version (for optimistic locking)
    pub fn update_state(
        ctx: Context<UpdateState>,
        state_key: [u8; 32],
        state_value: [u8; 64],
        version: u64,
    ) -> Result<()> {
        instructions::update_state::handler(ctx, state_key, state_value, version)
    }

    /// Initiate a conflict resolution process.
    /// Creates a dispute that requires multi-sig consensus to resolve.
    ///
    /// # Arguments
    /// * `ctx` - Context with dispute account
    /// * `dispute_id` - Unique identifier for the dispute
    /// * `task_id` - Related task ID
    /// * `evidence_hash` - Hash of evidence supporting the dispute
    /// * `resolution_type` - 0=refund, 1=complete, 2=split
    pub fn initiate_dispute(
        ctx: Context<InitiateDispute>,
        dispute_id: [u8; 32],
        task_id: [u8; 32],
        evidence_hash: [u8; 32],
        resolution_type: u8,
        evidence: String,
    ) -> Result<()> {
        instructions::initiate_dispute::handler(
            ctx,
            dispute_id,
            task_id,
            evidence_hash,
            resolution_type,
            evidence,
        )
    }

    /// Vote on a dispute resolution.
    /// Arbiters must be registered agents with arbitration capability.
    pub fn vote_dispute(ctx: Context<VoteDispute>, approve: bool) -> Result<()> {
        instructions::vote_dispute::handler(ctx, approve)
    }

    /// Execute the resolved dispute outcome.
    /// Requires sufficient votes to meet threshold.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>) -> Result<()> {
        instructions::resolve_dispute::handler(ctx)
    }

    /// Apply slashing to a worker after losing a dispute.
    pub fn apply_dispute_slash(ctx: Context<ApplyDisputeSlash>) -> Result<()> {
        instructions::apply_dispute_slash::handler(ctx)
    }

    /// Expire a dispute after the maximum duration has passed.
    pub fn expire_dispute(ctx: Context<ExpireDispute>) -> Result<()> {
        instructions::expire_dispute::handler(ctx)
    }

    /// Initialize the protocol configuration.
    /// Called once to set up global parameters.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        dispute_threshold: u8,
        protocol_fee_bps: u16,
        min_stake: u64,
        multisig_threshold: u8,
        multisig_owners: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(
            ctx,
            dispute_threshold,
            protocol_fee_bps,
            min_stake,
            multisig_threshold,
            multisig_owners,
        )
    }

    /// Update the protocol fee (multisig gated).
    pub fn update_protocol_fee(
        ctx: Context<UpdateProtocolFee>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        instructions::update_protocol_fee::handler(ctx, protocol_fee_bps)
    }

    /// Update rate limiting configuration (multisig gated).
    /// Parameters can be tuned post-deployment without program upgrade.
    ///
    /// # Arguments
    /// * `task_creation_cooldown` - Seconds between task creations (0 = disabled)
    /// * `max_tasks_per_24h` - Maximum tasks per agent per 24h (0 = unlimited)
    /// * `dispute_initiation_cooldown` - Seconds between disputes (0 = disabled)
    /// * `max_disputes_per_24h` - Maximum disputes per agent per 24h (0 = unlimited)
    /// * `min_stake_for_dispute` - Minimum stake required to initiate dispute
    pub fn update_rate_limits(
        ctx: Context<UpdateRateLimits>,
        task_creation_cooldown: i64,
        max_tasks_per_24h: u8,
        dispute_initiation_cooldown: i64,
        max_disputes_per_24h: u8,
        min_stake_for_dispute: u64,
    ) -> Result<()> {
        instructions::update_rate_limits::handler(
            ctx,
            task_creation_cooldown,
            max_tasks_per_24h,
            dispute_initiation_cooldown,
            max_disputes_per_24h,
            min_stake_for_dispute,
        )
    }

    /// Migrate protocol to a new version (multisig gated).
    /// Handles state migration when upgrading the program.
    ///
    /// # Arguments
    /// * `target_version` - The version to migrate to
    pub fn migrate_protocol(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
        instructions::migrate::handler(ctx, target_version)
    }

    /// Update minimum supported protocol version (multisig gated).
    /// Used to deprecate old versions after migration grace period.
    ///
    /// # Arguments
    /// * `new_min_version` - The new minimum supported version
    pub fn update_min_version(ctx: Context<UpdateMinVersion>, new_min_version: u8) -> Result<()> {
        instructions::migrate::update_min_version_handler(ctx, new_min_version)
    }
}
