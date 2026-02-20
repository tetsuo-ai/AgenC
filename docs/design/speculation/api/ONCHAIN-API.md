# AgenC Speculative Execution - On-Chain API Specification

> Solana program interfaces for the speculative execution system.

## Table of Contents

1. [Program Overview](#program-overview)
2. [Account Structures](#account-structures)
3. [Instructions](#instructions)
4. [PDA Derivation](#pda-derivation)
5. [Events](#events)
6. [Error Codes](#error-codes)
7. [Security Considerations](#security-considerations)

---

## Program Overview

The speculation module extends the AgenC Coordination Program with speculative execution capabilities. It enables agents to make cryptographic commitments about future task outputs, allowing dependent tasks to execute speculatively before prerequisites complete.

### Program ID

```
PROGRAM_ID: EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ
```

### Module Seeds

```rust
pub mod speculation_seeds {
    pub const SPECULATION_CONFIG: &[u8] = b"speculation_config";
    pub const SPECULATIVE_COMMITMENT: &[u8] = b"speculative_commitment";
    pub const STAKE_ESCROW: &[u8] = b"stake_escrow";
    pub const SLASH_DISTRIBUTION: &[u8] = b"slash_distribution";
    pub const SLASH_CLAIM: &[u8] = b"slash_claim";
    pub const DEPENDENT_TASK: &[u8] = b"dependent_task";
}
```

---

## Account Structures

### SpeculationConfig

Global configuration for the speculation system. Single instance per program.

```rust
/// Global speculation configuration.
/// PDA: [b"speculation_config"]
#[account]
#[derive(InitSpace)]
pub struct SpeculationConfig {
    /// Bump seed for PDA derivation.
    pub bump: u8,
    
    /// Authority that can update configuration.
    pub authority: Pubkey,
    
    /// Minimum stake as percentage of dependent task escrow (0-100).
    /// e.g., 10 = 10% of escrow must be staked.
    pub min_stake_percent: u8,
    
    /// Maximum stake allowed in lamports.
    /// Prevents excessive concentration risk.
    pub max_stake_lamports: u64,
    
    /// Minimum stake required in lamports.
    pub min_stake_lamports: u64,
    
    /// Maximum commitment duration in seconds.
    pub max_commitment_duration: i64,
    
    /// Minimum commitment duration in seconds.
    pub min_commitment_duration: i64,
    
    /// Grace period after task completion before finalization (seconds).
    /// Allows time for fraud proofs to be submitted.
    pub finalization_grace_period: i64,
    
    /// Percentage of slashed stake going to protocol treasury (0-100).
    pub slash_protocol_fee_percent: u8,
    
    /// Percentage of slashed stake going to whistleblower (0-100).
    pub slash_whistleblower_percent: u8,
    
    /// Whether the speculation system is paused.
    pub paused: bool,
    
    /// Total number of commitments created (for statistics).
    pub total_commitments: u64,
    
    /// Total amount currently staked across all commitments.
    pub total_staked: u64,
    
    /// Total amount slashed historically.
    pub total_slashed: u64,
    
    /// Reserved for future use.
    #[max_len(64)]
    pub _reserved: Vec<u8>,
}

impl SpeculationConfig {
    /// Space required for account (with InitSpace).
    pub const SPACE: usize = 8 + // discriminator
        1 +   // bump
        32 +  // authority
        1 +   // min_stake_percent
        8 +   // max_stake_lamports
        8 +   // min_stake_lamports
        8 +   // max_commitment_duration
        8 +   // min_commitment_duration
        8 +   // finalization_grace_period
        1 +   // slash_protocol_fee_percent
        1 +   // slash_whistleblower_percent
        1 +   // paused
        8 +   // total_commitments
        8 +   // total_staked
        8 +   // total_slashed
        4 + 64; // _reserved (vec length + data)
}
```

**Default Values:**

| Field | Default | Min | Max |
|-------|---------|-----|-----|
| `min_stake_percent` | 10 | 1 | 100 |
| `max_stake_lamports` | 100 SOL | 0.1 SOL | - |
| `min_stake_lamports` | 0.01 SOL | 0 | - |
| `max_commitment_duration` | 86400 (24h) | 3600 | 604800 |
| `min_commitment_duration` | 300 (5min) | 60 | 86400 |
| `finalization_grace_period` | 600 (10min) | 60 | 3600 |
| `slash_protocol_fee_percent` | 10 | 0 | 50 |
| `slash_whistleblower_percent` | 20 | 0 | 50 |

---

### SpeculativeCommitment

Represents a cryptographic commitment to a future task output.

```rust
/// A speculative commitment made by an agent about a task's output.
/// PDA: [b"speculative_commitment", task_id.to_le_bytes(), committer.key()]
#[account]
#[derive(InitSpace)]
pub struct SpeculativeCommitment {
    /// Bump seed for PDA derivation.
    pub bump: u8,
    
    /// ID of the task this commitment is for.
    pub task_id: u64,
    
    /// Agent who made the commitment.
    pub committer: Pubkey,
    
    /// SHA-256 hash of the predicted output.
    /// H(output_data) where output_data is the predicted task result.
    #[max_len(32)]
    pub output_hash: [u8; 32],

    /// Cryptographic commitment hiding the prediction.
    /// commit(output_hash, salt, committer) using SHA-256.
    #[max_len(32)]
    pub commitment: [u8; 32],
    
    /// Amount staked in lamports as collateral.
    pub stake_amount: u64,
    
    /// Current state of the commitment.
    pub state: SpeculativeCommitmentStatus,
    
    /// Unix timestamp when commitment was created.
    pub created_at: i64,
    
    /// Unix timestamp when commitment expires.
    pub expires_at: i64,
    
    /// Confidence score (0-100) provided by committer.
    /// Higher confidence may affect reputation scoring.
    pub confidence: u8,
    
    /// ID of dependent task relying on this commitment (if any).
    pub dependent_task_id: Option<u64>,
    
    /// Slot number when state last changed.
    pub last_updated_slot: u64,
    
    /// Reserved for future use.
    #[max_len(32)]
    pub _reserved: Vec<u8>,
}

/// Status enum for speculative commitments.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum SpeculativeCommitmentStatus {
    /// Initial state - commitment created, awaiting stake bond.
    Pending = 0,
    /// Stake bonded, speculation active.
    Active = 1,
    /// Dependent task completed, awaiting finalization.
    PendingFinalization = 2,
    /// Commitment fulfilled successfully, stake released.
    Fulfilled = 3,
    /// Commitment failed, stake slashed.
    Slashed = 4,
    /// Commitment cancelled before activation.
    Cancelled = 5,
    /// Commitment expired without resolution.
    Expired = 6,
}

impl SpeculativeCommitment {
    pub const SPACE: usize = 8 + // discriminator
        1 +   // bump
        8 +   // task_id
        32 +  // committer
        32 +  // output_hash
        32 +  // commitment
        8 +   // stake_amount
        1 +   // state
        8 +   // created_at
        8 +   // expires_at
        1 +   // confidence
        1 + 8 + // Option<dependent_task_id>
        8 +   // last_updated_slot
        4 + 32; // _reserved
    
    /// Check if commitment can be slashed.
    pub fn is_slashable(&self, current_time: i64) -> bool {
        self.state == SpeculativeCommitmentStatus::Active 
            && current_time < self.expires_at
    }
    
    /// Check if commitment has expired.
    pub fn is_expired(&self, current_time: i64) -> bool {
        current_time >= self.expires_at 
            && self.state == SpeculativeCommitmentStatus::Active
    }
    
    /// Check if stake can be released.
    pub fn is_releasable(&self) -> bool {
        self.state == SpeculativeCommitmentStatus::Fulfilled
    }
}
```

---

### SlashDistribution

Tracks the distribution of slashed stake to affected parties.

```rust
/// Distribution of slashed stake from a failed speculation.
/// PDA: [b"slash_distribution", commitment.key()]
#[account]
#[derive(InitSpace)]
pub struct SlashDistribution {
    /// Bump seed for PDA derivation.
    pub bump: u8,
    
    /// Commitment that was slashed.
    pub commitment_id: Pubkey,
    
    /// Total amount slashed in lamports.
    pub total_slashed: u64,
    
    /// Amount allocated to protocol treasury.
    pub protocol_share: u64,
    
    /// Amount allocated to whistleblower (if any).
    pub whistleblower_share: u64,
    
    /// Whistleblower address (who submitted fraud proof).
    pub whistleblower: Option<Pubkey>,
    
    /// Amount remaining for affected parties.
    pub affected_parties_pool: u64,
    
    /// Number of claimants registered.
    pub num_claimants: u16,
    
    /// Number of claims processed.
    pub claims_processed: u16,
    
    /// Whether all claims have been processed.
    pub finalized: bool,
    
    /// Slot when slash occurred.
    pub slash_slot: u64,
    
    /// Unix timestamp when slash occurred.
    pub slash_timestamp: i64,
    
    /// Reason for the slash.
    pub slash_reason: SlashReason,
    
    /// Reserved for future use.
    #[max_len(32)]
    pub _reserved: Vec<u8>,
}

/// Reasons for slashing a commitment.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum SlashReason {
    /// Actual output did not match speculated output.
    OutputMismatch = 0,
    /// Prerequisite task failed or was cancelled.
    TaskFailed = 1,
    /// Fraud proof submitted by whistleblower.
    FraudProof = 2,
    /// Commitment timed out without resolution.
    Timeout = 3,
}

impl SlashDistribution {
    pub const SPACE: usize = 8 + // discriminator
        1 +   // bump
        32 +  // commitment_id
        8 +   // total_slashed
        8 +   // protocol_share
        8 +   // whistleblower_share
        1 + 32 + // Option<whistleblower>
        8 +   // affected_parties_pool
        2 +   // num_claimants
        2 +   // claims_processed
        1 +   // finalized
        8 +   // slash_slot
        8 +   // slash_timestamp
        1 +   // slash_reason
        4 + 32; // _reserved
}
```

---

### SlashClaim

Individual claim record for an affected party.

```rust
/// Individual claim in a slash distribution.
/// PDA: [b"slash_claim", distribution.key(), claimant.key()]
#[account]
#[derive(InitSpace)]
pub struct SlashClaim {
    /// Bump seed for PDA derivation.
    pub bump: u8,
    
    /// Distribution this claim belongs to.
    pub distribution: Pubkey,
    
    /// Claimant address.
    pub claimant: Pubkey,
    
    /// Amount claimable in lamports.
    pub amount: u64,
    
    /// Whether claim has been collected.
    pub claimed: bool,
    
    /// Reason for entitlement.
    pub claim_reason: SlashClaimReason,
    
    /// Task ID that was affected (if applicable).
    pub affected_task_id: Option<u64>,
    
    /// Slot when claim was registered.
    pub registered_slot: u64,
    
    /// Slot when claim was collected (if claimed).
    pub claimed_slot: Option<u64>,
}

/// Reasons for entitlement to slash distribution.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum SlashClaimReason {
    /// Creator of dependent task that was invalidated.
    DependentTaskCreator = 0,
    /// Worker who wasted effort on invalidated task.
    AffectedWorker = 1,
    /// Protocol treasury.
    ProtocolFee = 2,
    /// Whistleblower who submitted fraud proof.
    Whistleblower = 3,
}

impl SlashClaim {
    pub const SPACE: usize = 8 + // discriminator
        1 +   // bump
        32 +  // distribution
        32 +  // claimant
        8 +   // amount
        1 +   // claimed
        1 +   // claim_reason
        1 + 8 + // Option<affected_task_id>
        8 +   // registered_slot
        1 + 8; // Option<claimed_slot>
}
```

---

### DependentTaskMetadata

Extended metadata for tasks with speculative dependencies.

```rust
/// Metadata for a task that depends on speculative output.
/// PDA: [b"dependent_task", task_id.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct DependentTaskMetadata {
    /// Bump seed for PDA derivation.
    pub bump: u8,
    
    /// Task ID of the dependent task.
    pub task_id: u64,
    
    /// Task ID of the prerequisite task.
    pub prerequisite_task_id: u64,
    
    /// Speculative commitment this task relies on.
    pub commitment_id: Pubkey,
    
    /// Hash of the speculated input being used.
    /// Must match the commitment's output_hash.
    #[max_len(32)]
    pub speculated_input_hash: [u8; 32],
    
    /// Whether speculation has been validated.
    pub speculation_validated: bool,
    
    /// Whether task was invalidated due to speculation failure.
    pub invalidated: bool,
    
    /// Reason for invalidation (if invalidated).
    pub invalidation_reason: Option<SpeculationInvalidationReason>,
    
    /// Failure policy for this task.
    pub failure_policy: SpeculationFailurePolicy,
    
    /// Whether to auto-invalidate on speculation failure.
    pub auto_invalidate: bool,
    
    /// Slot when validation/invalidation occurred.
    pub resolution_slot: Option<u64>,
    
    /// Reserved for future use.
    #[max_len(32)]
    pub _reserved: Vec<u8>,
}

/// Reasons for invalidation of speculative execution.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum SpeculationInvalidationReason {
    /// Prerequisite task produced different output.
    OutputMismatch = 0,
    /// Prerequisite task failed or was cancelled.
    PrerequisiteFailed = 1,
    /// Speculative commitment expired.
    CommitmentExpired = 2,
    /// Committer was slashed for fraud.
    CommitterSlashed = 3,
    /// Manual cancellation by task creator.
    ManualCancellation = 4,
}

/// Policy for handling speculation failure.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
#[repr(u8)]
pub enum SpeculationFailurePolicy {
    /// Full refund to task creator.
    #[default]
    Refund = 0,
    /// Partial refund, rest to worker for effort.
    PartialRefund = 1,
    /// Worker keeps full payment regardless.
    WorkerKeeps = 2,
    /// Creator claims from slash distribution.
    SlashClaim = 3,
}

impl DependentTaskMetadata {
    pub const SPACE: usize = 8 + // discriminator
        1 +   // bump
        8 +   // task_id
        8 +   // prerequisite_task_id
        32 +  // commitment_id
        32 +  // speculated_input_hash
        1 +   // speculation_validated
        1 +   // invalidated
        1 + 1 + // Option<invalidation_reason>
        1 +   // failure_policy
        1 +   // auto_invalidate
        1 + 8 + // Option<resolution_slot>
        4 + 32; // _reserved
}
```

---

## Instructions

### initialize_speculation_config

Initialize the global speculation configuration. Called once during program deployment.

```rust
/// Initialize speculation system configuration.
///
/// # Accounts
/// - `authority` - Signer who will be the config authority
/// - `config` - SpeculationConfig PDA to initialize
/// - `system_program` - System program
///
/// # Arguments
/// - `params` - Initial configuration parameters
#[derive(Accounts)]
pub struct InitializeSpeculationConfig<'info> {
    /// Authority that will control the configuration.
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// Speculation config PDA.
    #[account(
        init,
        payer = authority,
        space = SpeculationConfig::SPACE,
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    /// Protocol treasury for receiving slashed funds.
    /// CHECK: Validated as existing account.
    pub treasury: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeSpeculationConfigParams {
    pub min_stake_percent: u8,
    pub max_stake_lamports: u64,
    pub min_stake_lamports: u64,
    pub max_commitment_duration: i64,
    pub min_commitment_duration: i64,
    pub finalization_grace_period: i64,
    pub slash_protocol_fee_percent: u8,
    pub slash_whistleblower_percent: u8,
}
```

**Validation:**
- `authority` must be a signer
- `min_stake_percent` in [1, 100]
- `max_stake_lamports` >= `min_stake_lamports`
- `max_commitment_duration` >= `min_commitment_duration`
- `slash_protocol_fee_percent` + `slash_whistleblower_percent` <= 100

---

### create_speculative_commitment

Create a new speculative commitment for a task.

```rust
/// Create a speculative commitment for a task's output.
///
/// # Accounts
/// - `committer` - Agent making the commitment (signer)
/// - `task` - Task to speculate on
/// - `commitment` - SpeculativeCommitment PDA to create
/// - `config` - SpeculationConfig PDA
/// - `system_program` - System program
///
/// # Arguments
/// - `params` - Commitment parameters
///
/// # Errors
/// - `SpeculationError::SystemPaused` - System is paused
/// - `SpeculationError::InvalidPrerequisiteTask` - Task invalid
/// - `SpeculationError::CommitmentAlreadyExists` - Already committed
/// - `SpeculationError::DurationOutOfRange` - Invalid duration
#[derive(Accounts)]
#[instruction(params: CreateCommitmentParams)]
pub struct CreateSpeculativeCommitment<'info> {
    /// Agent making the speculative commitment.
    #[account(mut)]
    pub committer: Signer<'info>,
    
    /// Task being speculated on.
    /// Must be in Open or InProgress state.
    #[account(
        constraint = task.state == TaskStatus::Open || 
                     task.state == TaskStatus::InProgress
            @ SpeculationError::InvalidPrerequisiteTask
    )]
    pub task: Account<'info, Task>,
    
    /// Speculative commitment PDA.
    #[account(
        init,
        payer = committer,
        space = SpeculativeCommitment::SPACE,
        seeds = [
            speculation_seeds::SPECULATIVE_COMMITMENT,
            params.task_id.to_le_bytes().as_ref(),
            committer.key().as_ref()
        ],
        bump
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// Speculation configuration.
    #[account(
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump,
        constraint = !config.paused @ SpeculationError::SystemPaused
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    pub system_program: Program<'info, System>,
    
    /// Clock for timestamp.
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateCommitmentParams {
    /// Task ID to speculate on.
    pub task_id: u64,
    /// SHA-256 hash of predicted output.
    pub output_hash: [u8; 32],
    /// Hiding commitment: commit(output_hash, salt, committer).
    pub commitment: [u8; 32],
    /// Amount to stake in lamports.
    pub stake_amount: u64,
    /// Expiration as Unix timestamp.
    pub expires_at: i64,
    /// Confidence level (0-100).
    pub confidence: u8,
}
```

**Preconditions:**
- System not paused
- Task exists and is in Open or InProgress state
- No existing commitment from this committer for this task
- Duration within configured bounds
- Stake amount within configured bounds
- `output_hash` is non-zero

**Postconditions:**
- Commitment account created with `Pending` state
- `config.total_commitments` incremented
- `CommitmentCreated` event emitted

---

### bond_speculation_stake

Deposit stake to activate a pending commitment.

```rust
/// Bond stake to activate a speculative commitment.
///
/// # Accounts
/// - `committer` - Commitment owner (signer)
/// - `commitment` - SpeculativeCommitment to activate
/// - `stake_escrow` - Escrow PDA for holding stake
/// - `config` - SpeculationConfig PDA
/// - `system_program` - System program
///
/// # Errors
/// - `SpeculationError::InvalidCommitmentState` - Not Pending
/// - `SpeculationError::StakeAlreadyBonded` - Already bonded
/// - `InsufficientFunds` - Committer lacks balance
#[derive(Accounts)]
pub struct BondSpeculationStake<'info> {
    /// Commitment owner.
    #[account(mut)]
    pub committer: Signer<'info>,
    
    /// Speculative commitment.
    #[account(
        mut,
        seeds = [
            speculation_seeds::SPECULATIVE_COMMITMENT,
            commitment.task_id.to_le_bytes().as_ref(),
            committer.key().as_ref()
        ],
        bump = commitment.bump,
        constraint = commitment.committer == committer.key()
            @ SpeculationError::UnauthorizedAccess,
        constraint = commitment.state == SpeculativeCommitmentStatus::Pending
            @ SpeculationError::InvalidCommitmentState
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// Stake escrow PDA.
    #[account(
        init_if_needed,
        payer = committer,
        space = 0,
        seeds = [
            speculation_seeds::STAKE_ESCROW,
            commitment.key().as_ref()
        ],
        bump
    )]
    /// CHECK: Just holds lamports.
    pub stake_escrow: AccountInfo<'info>,
    
    /// Speculation configuration.
    #[account(
        mut,
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    pub system_program: Program<'info, System>,
    
    pub clock: Sysvar<'info, Clock>,
}
```

**Preconditions:**
- Commitment in `Pending` state
- Caller is the committer
- Committer has balance >= `stake_amount`
- Commitment not expired

**Postconditions:**
- `stake_amount` transferred from committer to escrow PDA
- Commitment state changed to `Active`
- `config.total_staked` increased by `stake_amount`
- `CommitmentActivated` event emitted

---

### slash_speculation_stake

Slash a commitment that provided incorrect speculation.

```rust
/// Slash a speculative commitment for incorrect speculation.
///
/// # Accounts
/// - `slasher` - Account submitting the slash (signer)
/// - `commitment` - SpeculativeCommitment to slash
/// - `stake_escrow` - Escrow holding the stake
/// - `distribution` - SlashDistribution PDA to create
/// - `task` - The completed task with actual output
/// - `config` - SpeculationConfig PDA
/// - `treasury` - Protocol treasury for fee
/// - `system_program` - System program
///
/// # Arguments
/// - `actual_output_hash` - Hash of actual task output
/// - `fraud_proof` - Optional ZK fraud proof
///
/// # Errors
/// - `SpeculationError::CommitmentNotActive` - Not active
/// - `SpeculationError::AlreadySlashed` - Already slashed
/// - `SpeculationError::InvalidFraudProof` - Bad proof
/// - `SpeculationError::SlashWindowExpired` - Too late
#[derive(Accounts)]
pub struct SlashSpeculationStake<'info> {
    /// Account submitting the slash.
    /// Could be task completer or whistleblower with fraud proof.
    #[account(mut)]
    pub slasher: Signer<'info>,
    
    /// Speculative commitment to slash.
    #[account(
        mut,
        seeds = [
            speculation_seeds::SPECULATIVE_COMMITMENT,
            commitment.task_id.to_le_bytes().as_ref(),
            commitment.committer.as_ref()
        ],
        bump = commitment.bump,
        constraint = commitment.state == SpeculativeCommitmentStatus::Active
            @ SpeculationError::CommitmentNotActive
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// Stake escrow.
    #[account(
        mut,
        seeds = [
            speculation_seeds::STAKE_ESCROW,
            commitment.key().as_ref()
        ],
        bump
    )]
    /// CHECK: Escrow account.
    pub stake_escrow: AccountInfo<'info>,
    
    /// Slash distribution PDA to create.
    #[account(
        init,
        payer = slasher,
        space = SlashDistribution::SPACE,
        seeds = [
            speculation_seeds::SLASH_DISTRIBUTION,
            commitment.key().as_ref()
        ],
        bump
    )]
    pub distribution: Account<'info, SlashDistribution>,
    
    /// The completed task with actual output.
    #[account(
        constraint = task.id == commitment.task_id
            @ SpeculationError::TaskMismatch,
        constraint = task.state == TaskStatus::Completed
            @ SpeculationError::PrerequisiteNotCompleted
    )]
    pub task: Account<'info, Task>,
    
    /// Speculation configuration.
    #[account(
        mut,
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    /// Protocol treasury.
    #[account(mut)]
    /// CHECK: Treasury account for fees.
    pub treasury: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SlashParams {
    /// SHA-256 hash of the actual task output.
    pub actual_output_hash: [u8; 32],
    /// Optional ZK fraud proof (for whistleblowers).
    pub fraud_proof: Option<Vec<u8>>,
}
```

**Validation Logic:**
```rust
// In processor:
pub fn process_slash(
    ctx: Context<SlashSpeculationStake>,
    params: SlashParams
) -> Result<()> {
    let commitment = &ctx.accounts.commitment;
    let config = &ctx.accounts.config;
    let clock = &ctx.accounts.clock;
    
    // Verify output mismatch
    require!(
        params.actual_output_hash != commitment.output_hash,
        SpeculationError::OutputMatchesCommitment
    );
    
    // Verify within slash window
    require!(
        clock.unix_timestamp < commitment.expires_at + config.finalization_grace_period,
        SpeculationError::SlashWindowExpired
    );
    
    // If slasher is not the task completer, require fraud proof
    let task = &ctx.accounts.task;
    let is_task_completer = task.completed_by == Some(ctx.accounts.slasher.key());
    
    if !is_task_completer {
        require!(
            params.fraud_proof.is_some(),
            SpeculationError::FraudProofRequired
        );
        // Verify fraud proof (ZK verification)
        verify_fraud_proof(&params.fraud_proof.unwrap())?;
    }
    
    // Calculate distribution
    let total_slashed = commitment.stake_amount;
    let protocol_share = total_slashed * config.slash_protocol_fee_percent as u64 / 100;
    let whistleblower_share = if !is_task_completer {
        total_slashed * config.slash_whistleblower_percent as u64 / 100
    } else {
        0
    };
    let affected_parties_pool = total_slashed - protocol_share - whistleblower_share;
    
    // Update accounts and emit event
    // ...
    
    Ok(())
}
```

**Preconditions:**
- Commitment in `Active` state
- Actual output hash differs from committed output hash
- Within slash window (before `expires_at + finalization_grace_period`)
- Valid fraud proof (if slasher is not task completer)

**Postconditions:**
- Commitment state changed to `Slashed`
- SlashDistribution account created
- Protocol share transferred to treasury
- Whistleblower share transferred (if applicable)
- Remaining funds held for affected party claims
- `config.total_slashed` increased
- `config.total_staked` decreased
- `CommitmentSlashed` event emitted

---

### claim_slash_distribution

Claim entitlement from a slash distribution.

```rust
/// Claim share from a slash distribution.
///
/// # Accounts
/// - `claimant` - Account claiming (signer)
/// - `distribution` - SlashDistribution PDA
/// - `claim` - SlashClaim PDA
/// - `stake_escrow` - Escrow holding remaining funds
/// - `system_program` - System program
///
/// # Errors
/// - `SpeculationError::ClaimNotFound` - No entitlement
/// - `SpeculationError::ClaimAlreadyProcessed` - Already claimed
#[derive(Accounts)]
pub struct ClaimSlashDistribution<'info> {
    /// Claimant.
    #[account(mut)]
    pub claimant: Signer<'info>,
    
    /// Slash distribution.
    #[account(
        mut,
        seeds = [
            speculation_seeds::SLASH_DISTRIBUTION,
            distribution.commitment_id.as_ref()
        ],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, SlashDistribution>,
    
    /// Claim record.
    #[account(
        mut,
        seeds = [
            speculation_seeds::SLASH_CLAIM,
            distribution.key().as_ref(),
            claimant.key().as_ref()
        ],
        bump = claim.bump,
        constraint = claim.claimant == claimant.key()
            @ SpeculationError::UnauthorizedAccess,
        constraint = !claim.claimed
            @ SpeculationError::ClaimAlreadyProcessed
    )]
    pub claim: Account<'info, SlashClaim>,
    
    /// Escrow holding funds.
    #[account(
        mut,
        seeds = [
            speculation_seeds::STAKE_ESCROW,
            distribution.commitment_id.as_ref()
        ],
        bump
    )]
    /// CHECK: Escrow account.
    pub stake_escrow: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    
    pub clock: Sysvar<'info, Clock>,
}
```

**Preconditions:**
- Distribution exists
- Claim record exists for claimant
- Claim not already processed
- Sufficient funds in escrow

**Postconditions:**
- Claim amount transferred from escrow to claimant
- Claim marked as `claimed = true`
- `distribution.claims_processed` incremented
- If all claims processed, `distribution.finalized = true`
- `SlashClaimed` event emitted

---

### release_speculation_stake

Release stake from a fulfilled commitment.

```rust
/// Release stake from a fulfilled speculative commitment.
///
/// # Accounts
/// - `committer` - Commitment owner (signer)
/// - `commitment` - SpeculativeCommitment to release
/// - `stake_escrow` - Escrow holding the stake
/// - `config` - SpeculationConfig PDA
/// - `system_program` - System program
///
/// # Errors
/// - `SpeculationError::InvalidCommitmentState` - Not Fulfilled
/// - `SpeculationError::StakeNotBonded` - No stake to release
#[derive(Accounts)]
pub struct ReleaseSpeculationStake<'info> {
    /// Commitment owner.
    #[account(mut)]
    pub committer: Signer<'info>,
    
    /// Speculative commitment.
    #[account(
        mut,
        seeds = [
            speculation_seeds::SPECULATIVE_COMMITMENT,
            commitment.task_id.to_le_bytes().as_ref(),
            committer.key().as_ref()
        ],
        bump = commitment.bump,
        constraint = commitment.committer == committer.key()
            @ SpeculationError::UnauthorizedAccess,
        constraint = commitment.state == SpeculativeCommitmentStatus::Fulfilled
            @ SpeculationError::InvalidCommitmentState,
        close = committer
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// Stake escrow.
    #[account(
        mut,
        seeds = [
            speculation_seeds::STAKE_ESCROW,
            commitment.key().as_ref()
        ],
        bump
    )]
    /// CHECK: Escrow account.
    pub stake_escrow: AccountInfo<'info>,
    
    /// Speculation configuration.
    #[account(
        mut,
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    pub system_program: Program<'info, System>,
}
```

**Preconditions:**
- Commitment in `Fulfilled` state
- Caller is the committer
- Stake escrow has balance

**Postconditions:**
- Stake transferred from escrow to committer
- Commitment account closed (rent returned)
- Escrow account closed
- `config.total_staked` decreased
- `StakeReleased` event emitted

---

### create_dependent_task

Create a task that depends on speculative output.

```rust
/// Create a task that depends on speculative output from another task.
///
/// # Accounts
/// - `creator` - Task creator (signer)
/// - `prerequisite_task` - Task providing speculative input
/// - `commitment` - SpeculativeCommitment to rely on
/// - `task` - New Task PDA to create
/// - `dependent_metadata` - DependentTaskMetadata PDA
/// - `escrow` - Task escrow PDA
/// - `protocol_state` - Protocol state PDA
/// - `config` - SpeculationConfig PDA
/// - `system_program` - System program
///
/// # Arguments
/// - `params` - Task creation parameters
///
/// # Errors
/// - `SpeculationError::CommitmentNotActive` - Commitment not active
/// - `SpeculationError::SpeculatedInputMismatch` - Hash mismatch
/// - `SpeculationError::CircularDependency` - Would create cycle
#[derive(Accounts)]
#[instruction(params: CreateDependentTaskParams)]
pub struct CreateDependentTask<'info> {
    /// Task creator.
    #[account(mut)]
    pub creator: Signer<'info>,
    
    /// Prerequisite task.
    #[account(
        constraint = prerequisite_task.id == params.prerequisite_task_id
            @ SpeculationError::InvalidPrerequisiteTask
    )]
    pub prerequisite_task: Account<'info, Task>,
    
    /// Speculative commitment to rely on.
    #[account(
        constraint = commitment.task_id == params.prerequisite_task_id
            @ SpeculationError::CommitmentTaskMismatch,
        constraint = commitment.state == SpeculativeCommitmentStatus::Active
            @ SpeculationError::CommitmentNotActive,
        constraint = commitment.output_hash == params.speculated_input_hash
            @ SpeculationError::SpeculatedInputMismatch
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// New task to create.
    #[account(
        init,
        payer = creator,
        space = Task::SPACE,
        seeds = [
            b"task",
            protocol_state.next_task_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub task: Account<'info, Task>,
    
    /// Dependent task metadata.
    #[account(
        init,
        payer = creator,
        space = DependentTaskMetadata::SPACE,
        seeds = [
            speculation_seeds::DEPENDENT_TASK,
            protocol_state.next_task_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub dependent_metadata: Account<'info, DependentTaskMetadata>,
    
    /// Task escrow.
    #[account(
        init,
        payer = creator,
        space = 0,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    /// CHECK: Escrow account.
    pub escrow: AccountInfo<'info>,
    
    /// Protocol state for next_task_id.
    #[account(
        mut,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_state: Account<'info, ProtocolState>,
    
    /// Speculation configuration.
    #[account(
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump,
        constraint = !config.paused @ SpeculationError::SystemPaused
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    pub system_program: Program<'info, System>,
    
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateDependentTaskParams {
    /// Task description.
    pub description: String,
    /// Escrow amount in lamports.
    pub escrow_lamports: u64,
    /// Deadline as Unix timestamp.
    pub deadline: i64,
    /// Prerequisite task ID.
    pub prerequisite_task_id: u64,
    /// Hash of speculated input (must match commitment.output_hash).
    pub speculated_input_hash: [u8; 32],
    /// Constraint hash for ZK verification (optional).
    pub constraint_hash: Option<[u8; 32]>,
    /// Required skills (optional).
    pub required_skills: Option<Vec<String>>,
    /// Auto-invalidate on speculation failure.
    pub auto_invalidate: bool,
    /// Failure handling policy.
    pub failure_policy: SpeculationFailurePolicy,
}
```

**Preconditions:**
- Speculation system not paused
- Commitment is in `Active` state
- `speculated_input_hash` matches `commitment.output_hash`
- No circular dependency (task does not depend on itself transitively)
- Creator has balance >= `escrow_lamports`
- Minimum stake requirements met (checked against commitment.stake_amount)

**Postconditions:**
- Task account created
- DependentTaskMetadata account created
- Escrow funded with `escrow_lamports`
- Commitment's `dependent_task_id` updated
- `protocol_state.next_task_id` incremented
- `DependentTaskCreated` event emitted

---

### validate_speculation

Validate that speculation was correct after prerequisite completes.

```rust
/// Validate speculation after prerequisite task completes.
///
/// # Accounts
/// - `validator` - Account triggering validation (signer)
/// - `dependent_task` - Task to validate
/// - `dependent_metadata` - DependentTaskMetadata PDA
/// - `prerequisite_task` - Completed prerequisite task
/// - `commitment` - SpeculativeCommitment
/// - `config` - SpeculationConfig PDA
///
/// # Arguments
/// - `actual_output_hash` - Hash of actual prerequisite output
///
/// # Errors
/// - `SpeculationError::PrerequisiteNotCompleted` - Not done
/// - `SpeculationError::AlreadyValidated` - Already validated
#[derive(Accounts)]
pub struct ValidateSpeculation<'info> {
    /// Validator (could be task completer or automated).
    pub validator: Signer<'info>,
    
    /// Dependent task.
    #[account(
        mut,
        constraint = dependent_task.id == dependent_metadata.task_id
            @ SpeculationError::TaskMismatch
    )]
    pub dependent_task: Account<'info, Task>,
    
    /// Dependent task metadata.
    #[account(
        mut,
        seeds = [
            speculation_seeds::DEPENDENT_TASK,
            dependent_metadata.task_id.to_le_bytes().as_ref()
        ],
        bump = dependent_metadata.bump,
        constraint = !dependent_metadata.speculation_validated
            @ SpeculationError::AlreadyValidated
    )]
    pub dependent_metadata: Account<'info, DependentTaskMetadata>,
    
    /// Completed prerequisite task.
    #[account(
        constraint = prerequisite_task.id == dependent_metadata.prerequisite_task_id
            @ SpeculationError::TaskMismatch,
        constraint = prerequisite_task.state == TaskStatus::Completed
            @ SpeculationError::PrerequisiteNotCompleted
    )]
    pub prerequisite_task: Account<'info, Task>,
    
    /// Speculative commitment.
    #[account(
        mut,
        constraint = commitment.key() == dependent_metadata.commitment_id
            @ SpeculationError::CommitmentMismatch
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,
    
    /// Speculation configuration.
    #[account(
        seeds = [speculation_seeds::SPECULATION_CONFIG],
        bump = config.bump
    )]
    pub config: Account<'info, SpeculationConfig>,
    
    pub clock: Sysvar<'info, Clock>,
}
```

**Validation Logic:**
```rust
pub fn process_validate_speculation(
    ctx: Context<ValidateSpeculation>,
    actual_output_hash: [u8; 32]
) -> Result<()> {
    let metadata = &mut ctx.accounts.dependent_metadata;
    let commitment = &mut ctx.accounts.commitment;
    
    let is_valid = actual_output_hash == metadata.speculated_input_hash;
    
    if is_valid {
        // Speculation was correct!
        metadata.speculation_validated = true;
        commitment.state = SpeculativeCommitmentStatus::PendingFinalization;
        
        emit!(DependentTaskValidated {
            task_id: metadata.task_id,
            commitment_id: commitment.key(),
        });
    } else {
        // Speculation was incorrect
        metadata.invalidated = true;
        metadata.invalidation_reason = Some(SpeculationInvalidationReason::OutputMismatch);
        
        // Handle based on failure policy
        match metadata.failure_policy {
            SpeculationFailurePolicy::Refund => {
                // Trigger refund to creator
            },
            SpeculationFailurePolicy::SlashClaim => {
                // Register creator as claimant in slash distribution
            },
            // ...
        }
        
        emit!(DependentTaskInvalidated {
            task_id: metadata.task_id,
            commitment_id: commitment.key(),
            reason: SpeculationInvalidationReason::OutputMismatch,
        });
    }
    
    metadata.resolution_slot = Some(Clock::get()?.slot);
    
    Ok(())
}
```

---

## PDA Derivation

### Formulas

| Account | Seeds | Bump |
|---------|-------|------|
| SpeculationConfig | `["speculation_config"]` | Stored in account |
| SpeculativeCommitment | `["speculative_commitment", task_id (8 bytes LE), committer]` | Stored in account |
| StakeEscrow | `["stake_escrow", commitment_pubkey]` | Canonical |
| SlashDistribution | `["slash_distribution", commitment_pubkey]` | Stored in account |
| SlashClaim | `["slash_claim", distribution_pubkey, claimant]` | Stored in account |
| DependentTaskMetadata | `["dependent_task", task_id (8 bytes LE)]` | Stored in account |

### TypeScript Derivation

```typescript
import { PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ');

export function deriveSpeculationConfigPda(
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('speculation_config')],
    programId
  );
}

export function deriveCommitmentPda(
  taskId: number,
  committer: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const taskIdBuffer = Buffer.alloc(8);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));
  
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('speculative_commitment'),
      taskIdBuffer,
      committer.toBuffer(),
    ],
    programId
  );
}

export function deriveStakeEscrowPda(
  commitmentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake_escrow'), commitmentPda.toBuffer()],
    programId
  );
}

export function deriveSlashDistributionPda(
  commitmentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('slash_distribution'), commitmentPda.toBuffer()],
    programId
  );
}

export function deriveSlashClaimPda(
  distributionPda: PublicKey,
  claimant: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('slash_claim'),
      distributionPda.toBuffer(),
      claimant.toBuffer(),
    ],
    programId
  );
}

export function deriveDependentTaskMetadataPda(
  taskId: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const taskIdBuffer = Buffer.alloc(8);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));
  
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dependent_task'), taskIdBuffer],
    programId
  );
}
```

---

## Events

### Event Structures

```rust
/// Emitted when a speculative commitment is created.
#[event]
pub struct CommitmentCreated {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Task ID.
    pub task_id: u64,
    /// Committer public key.
    pub committer: Pubkey,
    /// Hash of speculated output.
    pub output_hash: [u8; 32],
    /// Stake amount in lamports.
    pub stake_amount: u64,
    /// Expiration timestamp.
    pub expires_at: i64,
    /// Confidence score.
    pub confidence: u8,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a commitment is activated (stake bonded).
#[event]
pub struct CommitmentActivated {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Stake amount bonded.
    pub stake_amount: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a commitment is fulfilled successfully.
#[event]
pub struct CommitmentFulfilled {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Task ID.
    pub task_id: u64,
    /// Hash that was correctly predicted.
    pub output_hash: [u8; 32],
    /// Stake amount to be returned.
    pub stake_returned: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a commitment is slashed.
#[event]
pub struct CommitmentSlashed {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Task ID.
    pub task_id: u64,
    /// Speculated hash (incorrect).
    pub speculated_hash: [u8; 32],
    /// Actual hash from task.
    pub actual_hash: [u8; 32],
    /// Amount slashed.
    pub slashed_amount: u64,
    /// Account that submitted slash.
    pub slasher: Pubkey,
    /// Reason for slash.
    pub reason: SlashReason,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a commitment is cancelled.
#[event]
pub struct CommitmentCancelled {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Task ID.
    pub task_id: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a commitment expires.
#[event]
pub struct CommitmentExpired {
    /// Commitment public key.
    pub commitment_id: Pubkey,
    /// Task ID.
    pub task_id: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a dependent task is created.
#[event]
pub struct DependentTaskCreated {
    /// Dependent task ID.
    pub task_id: u64,
    /// Prerequisite task ID.
    pub prerequisite_task_id: u64,
    /// Commitment being relied upon.
    pub commitment_id: Pubkey,
    /// Task creator.
    pub creator: Pubkey,
    /// Escrow amount.
    pub escrow_lamports: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a dependent task's speculation is validated.
#[event]
pub struct DependentTaskValidated {
    /// Task ID.
    pub task_id: u64,
    /// Commitment ID.
    pub commitment_id: Pubkey,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when a dependent task is invalidated.
#[event]
pub struct DependentTaskInvalidated {
    /// Task ID.
    pub task_id: u64,
    /// Commitment ID.
    pub commitment_id: Pubkey,
    /// Reason for invalidation.
    pub reason: SpeculationInvalidationReason,
    /// Refund amount (if applicable).
    pub refund_amount: u64,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when slash distribution is claimed.
#[event]
pub struct SlashClaimed {
    /// Distribution public key.
    pub distribution_id: Pubkey,
    /// Claimant.
    pub claimant: Pubkey,
    /// Amount claimed.
    pub amount: u64,
    /// Claim reason.
    pub reason: SlashClaimReason,
    /// Slot number.
    pub slot: u64,
}

/// Emitted when configuration is updated.
#[event]
pub struct SpeculationConfigUpdated {
    /// Field that was updated.
    pub field: String,
    /// Old value (as u64 for numeric fields).
    pub old_value: u64,
    /// New value.
    pub new_value: u64,
    /// Authority that made the change.
    pub authority: Pubkey,
    /// Slot number.
    pub slot: u64,
}
```

---

## Error Codes

```rust
/// Error codes for speculation module.
/// Range: 6000-6099
#[error_code]
pub enum SpeculationError {
    // =========================================================================
    // Commitment Errors (6000-6019)
    // =========================================================================
    
    /// Speculative commitment not found.
    #[msg("Speculative commitment not found")]
    CommitmentNotFound = 6000,
    
    /// Commitment already exists for this task and committer.
    #[msg("Commitment already exists for this task and committer")]
    CommitmentAlreadyExists = 6001,
    
    /// Commitment has expired.
    #[msg("Commitment has expired")]
    CommitmentExpired = 6002,
    
    /// Commitment is not in active state.
    #[msg("Commitment is not in active state")]
    CommitmentNotActive = 6003,
    
    /// Commitment has already been finalized.
    #[msg("Commitment has already been finalized")]
    CommitmentAlreadyFinalized = 6004,
    
    /// Invalid commitment state for this operation.
    #[msg("Invalid commitment state for this operation")]
    InvalidCommitmentState = 6005,
    
    /// Provided hash does not match commitment.
    #[msg("Provided hash does not match commitment")]
    CommitmentHashMismatch = 6006,
    
    /// Commitment task ID does not match.
    #[msg("Commitment task ID does not match")]
    CommitmentTaskMismatch = 6007,
    
    /// Commitment mismatch.
    #[msg("Commitment does not match expected")]
    CommitmentMismatch = 6008,
    
    /// Output matches commitment (cannot slash).
    #[msg("Output matches commitment, cannot slash")]
    OutputMatchesCommitment = 6009,
    
    // =========================================================================
    // Stake Errors (6020-6039)
    // =========================================================================
    
    /// Stake amount is insufficient.
    #[msg("Stake amount is insufficient")]
    InsufficientStake = 6020,
    
    /// Stake amount exceeds maximum allowed.
    #[msg("Stake amount exceeds maximum allowed")]
    StakeExceedsMaximum = 6021,
    
    /// Stake amount is below minimum required.
    #[msg("Stake amount is below minimum required")]
    StakeBelowMinimum = 6022,
    
    /// Stake has already been bonded.
    #[msg("Stake has already been bonded")]
    StakeAlreadyBonded = 6023,
    
    /// Stake has not been bonded yet.
    #[msg("Stake has not been bonded yet")]
    StakeNotBonded = 6024,
    
    /// Stake is locked and cannot be withdrawn.
    #[msg("Stake is locked and cannot be withdrawn")]
    StakeLocked = 6025,
    
    // =========================================================================
    // Task Dependency Errors (6040-6059)
    // =========================================================================
    
    /// Invalid prerequisite task.
    #[msg("Invalid prerequisite task specified")]
    InvalidPrerequisiteTask = 6040,
    
    /// Prerequisite task has not been completed.
    #[msg("Prerequisite task has not been completed")]
    PrerequisiteNotCompleted = 6041,
    
    /// Circular task dependency detected.
    #[msg("Circular task dependency detected")]
    CircularDependency = 6042,
    
    /// Maximum number of dependencies exceeded.
    #[msg("Maximum number of dependencies exceeded")]
    DependencyLimitExceeded = 6043,
    
    /// Speculated input does not match commitment output.
    #[msg("Speculated input does not match commitment output")]
    SpeculatedInputMismatch = 6044,
    
    /// Task mismatch.
    #[msg("Task does not match expected")]
    TaskMismatch = 6045,
    
    /// Already validated.
    #[msg("Speculation already validated")]
    AlreadyValidated = 6046,
    
    // =========================================================================
    // Slash Errors (6060-6079)
    // =========================================================================
    
    /// Not authorized to slash this commitment.
    #[msg("Not authorized to slash this commitment")]
    SlashNotAuthorized = 6060,
    
    /// Commitment has already been slashed.
    #[msg("Commitment has already been slashed")]
    AlreadySlashed = 6061,
    
    /// Slash window has expired.
    #[msg("Slash window has expired")]
    SlashWindowExpired = 6062,
    
    /// Provided fraud proof is invalid.
    #[msg("Provided fraud proof is invalid")]
    InvalidFraudProof = 6063,
    
    /// Slash distribution claim not found.
    #[msg("Slash distribution claim not found")]
    ClaimNotFound = 6064,
    
    /// Claim has already been processed.
    #[msg("Claim has already been processed")]
    ClaimAlreadyProcessed = 6065,
    
    /// Fraud proof required for non-completer.
    #[msg("Fraud proof required for non-task-completer")]
    FraudProofRequired = 6066,
    
    // =========================================================================
    // Configuration Errors (6080-6099)
    // =========================================================================
    
    /// Speculation system is paused.
    #[msg("Speculation system is currently paused")]
    SystemPaused = 6080,
    
    /// Invalid configuration parameter.
    #[msg("Invalid configuration parameter")]
    InvalidConfiguration = 6081,
    
    /// Not authorized to update configuration.
    #[msg("Not authorized to update configuration")]
    UnauthorizedConfigUpdate = 6082,
    
    /// Commitment duration is out of allowed range.
    #[msg("Commitment duration is out of allowed range")]
    DurationOutOfRange = 6083,
    
    /// Unauthorized access.
    #[msg("Unauthorized access")]
    UnauthorizedAccess = 6084,
}
```

---

## Security Considerations

### Stake Security

1. **Minimum Stake Enforcement**: Minimum stake prevents spam and ensures economic alignment
2. **Maximum Stake Cap**: Prevents concentration risk and limits protocol exposure
3. **Escrow Isolation**: Each commitment has its own escrow PDA, preventing cross-contamination
4. **Slash Window**: Time-bounded slashing prevents indefinite liability

### Fraud Prevention

1. **Hiding Commitment**: SHA-256 commitment hides prediction until reveal
2. **Fraud Proofs**: ZK proofs enable trustless verification of misprediction
3. **Whistleblower Incentive**: Percentage of slash rewards fraud detection
4. **Grace Period**: Time window after completion allows fraud detection

### Access Control

1. **Committer-Only Operations**: Only committer can bond, cancel, or release stake
2. **Authority-Gated Config**: Only authority can update configuration
3. **PDA Derivation**: Deterministic addresses prevent account confusion
4. **State Machine Guards**: Operations validated against current state

### Economic Security

1. **Stake Proportionality**: Stake scales with dependent task value
2. **Distribution Fairness**: Slash distribution formula is transparent and auditable
3. **Finalization Delay**: Prevents premature stake release

---

## References

- [Runtime API](./RUNTIME-API.md)
- [SDK API](./SDK-API.md)
- [AgenC Architecture](../../architecture.md)
- [Anchor Documentation](https://www.anchor-lang.com/)
