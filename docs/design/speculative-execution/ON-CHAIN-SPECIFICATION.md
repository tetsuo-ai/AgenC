# On-Chain Specification: Speculative Execution System

> **Epic:** [#285](https://github.com/tetsuo-ai/AgenC/issues/285)  
> **Issues:** #259, #273, #275  
> **Status:** Specification Complete  
> **Last Updated:** 2026-01-28

## Overview

This document specifies the on-chain Anchor program components for the Speculative Execution system. It provides complete implementation details for account schemas, instructions, events, and error handling.

---

## 1. Account Schemas

### 1.1 Updated Task Struct

The existing `Task` struct requires modification to support task dependencies.

```rust
/// Task type for dependency relationships
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DependencyType {
    /// No dependency - standalone task
    #[default]
    None = 0,
    /// Hard dependency - task cannot execute until parent is confirmed
    Hard = 1,
    /// Soft dependency - task can speculatively execute before parent confirms
    Soft = 2,
}

/// Task account (V2 - with dependency support)
/// PDA seeds: ["task", creator, task_id]
#[account]
#[derive(InitSpace)]
pub struct Task {
    // === Existing fields (unchanged) ===
    /// Unique task identifier
    pub task_id: [u8; 32],
    /// Task creator (paying party)
    pub creator: Pubkey,
    /// Required capability bitmask
    pub required_capabilities: u64,
    /// Task description or instruction hash
    pub description: [u8; 64],
    /// Constraint hash for private task verification
    pub constraint_hash: [u8; 32],
    /// Reward amount in lamports
    pub reward_amount: u64,
    /// Maximum workers allowed
    pub max_workers: u8,
    /// Current worker count
    pub current_workers: u8,
    /// Task status
    pub status: TaskStatus,
    /// Task type
    pub task_type: TaskType,
    /// Creation timestamp
    pub created_at: i64,
    /// Deadline timestamp (0 = no deadline)
    pub deadline: i64,
    /// Completion timestamp
    pub completed_at: i64,
    /// Escrow account for reward
    pub escrow: Pubkey,
    /// Result data or pointer
    pub result: [u8; 64],
    /// Number of completions (for collaborative tasks)
    pub completions: u8,
    /// Required completions
    pub required_completions: u8,
    /// Bump seed
    pub bump: u8,
    
    // === New dependency fields ===
    /// Parent task this task depends on (Pubkey::default() if none)
    pub depends_on: Pubkey,
    /// Type of dependency relationship
    pub dependency_type: DependencyType,
    /// Depth in the dependency chain (0 = root task, 1 = direct child, etc.)
    pub dependency_depth: u8,
    
    // === Updated reserved (reduced to accommodate new fields) ===
    /// Reserved for future use
    pub _reserved: [u8; 28],
}

impl Task {
    /// Account size calculation
    /// Note: Using manual calculation for backward compatibility
    pub const SIZE: usize = 8 +   // discriminator
        32 +  // task_id
        32 +  // creator
        8 +   // required_capabilities
        64 +  // description
        32 +  // constraint_hash
        8 +   // reward_amount
        1 +   // max_workers
        1 +   // current_workers
        1 +   // status
        1 +   // task_type
        8 +   // created_at
        8 +   // deadline
        8 +   // completed_at
        32 +  // escrow
        64 +  // result
        1 +   // completions
        1 +   // required_completions
        1 +   // bump
        // New fields
        32 +  // depends_on
        1 +   // dependency_type
        1 +   // dependency_depth
        28;   // _reserved (reduced from 32)
    
    /// Maximum allowed dependency depth
    pub const MAX_DEPENDENCY_DEPTH: u8 = 20;
    
    /// Check if task has a dependency
    pub fn has_dependency(&self) -> bool {
        self.depends_on != Pubkey::default() && 
        self.dependency_type != DependencyType::None
    }
    
    /// Check if task allows speculative execution
    pub fn allows_speculation(&self) -> bool {
        self.dependency_type == DependencyType::Soft
    }
}
```

**Size Calculation:**
- Total: 336 bytes (unchanged from current size due to reserved field adjustment)
- New fields consume 34 bytes, reserved reduced by 4 bytes

**PDA Seeds:**
```rust
seeds = [b"task", creator.key().as_ref(), task_id.as_ref()]
```

---

### 1.2 SpeculativeCommitment Account

Records a speculative execution commitment on-chain for cross-agent trust.

```rust
/// Status of a speculative commitment
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum CommitmentStatus {
    /// Commitment is pending - execution claimed but not confirmed
    #[default]
    Pending = 0,
    /// Commitment is confirmed - proof verified on-chain
    Confirmed = 1,
    /// Commitment is voided - rolled back due to ancestor failure
    Voided = 2,
    /// Commitment expired - not confirmed within timeout
    Expired = 3,
}

/// Speculative commitment account
/// Records an agent's commitment to speculatively execute a task
/// 
/// PDA seeds: ["spec_commitment", task, worker]
#[account]
#[derive(InitSpace)]
pub struct SpeculativeCommitment {
    // === Identity ===
    /// The task being speculatively executed
    pub task: Pubkey,
    /// The worker agent making the commitment
    pub worker: Pubkey,
    /// The worker's agent registration
    pub worker_agent: Pubkey,
    
    // === Dependency chain ===
    /// Parent commitment this depends on (Pubkey::default() if root)
    pub parent_commitment: Pubkey,
    /// The task this commitment's task depends on
    pub depends_on_task: Pubkey,
    /// Depth in the speculation chain (0 = first speculative task)
    pub speculation_depth: u8,
    
    // === Commitment data ===
    /// Hash of the speculative result (commitment to output)
    pub result_hash: [u8; 32],
    /// Hash of the input state used for speculation
    pub input_state_hash: [u8; 32],
    /// Estimated computation cost (for slash distribution)
    pub compute_cost_estimate: u64,
    
    // === Timestamps ===
    /// When the commitment was created
    pub created_at: i64,
    /// When the commitment expires if not confirmed
    pub expires_at: i64,
    /// When the commitment was confirmed (0 if not yet)
    pub confirmed_at: i64,
    /// When the commitment was voided (0 if not)
    pub voided_at: i64,
    
    // === State ===
    /// Current status of the commitment
    pub status: CommitmentStatus,
    /// Associated speculation bond (if any)
    pub bond: Pubkey,
    /// Amount of stake locked for this commitment
    pub staked_amount: u64,
    
    // === PDA ===
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Reserved for future use
    pub _reserved: [u8; 32],
}

impl SpeculativeCommitment {
    /// Account size calculation
    pub const SIZE: usize = 8 +   // discriminator
        32 +  // task
        32 +  // worker
        32 +  // worker_agent
        32 +  // parent_commitment
        32 +  // depends_on_task
        1 +   // speculation_depth
        32 +  // result_hash
        32 +  // input_state_hash
        8 +   // compute_cost_estimate
        8 +   // created_at
        8 +   // expires_at
        8 +   // confirmed_at
        8 +   // voided_at
        1 +   // status
        32 +  // bond
        8 +   // staked_amount
        1 +   // bump
        32;   // _reserved
    
    /// Default commitment timeout (24 hours)
    pub const DEFAULT_EXPIRY_DURATION: i64 = 24 * 60 * 60;
    
    /// Maximum speculation depth allowed
    pub const MAX_SPECULATION_DEPTH: u8 = 20;
    
    /// Check if commitment can be confirmed
    pub fn can_confirm(&self, clock: &Clock) -> bool {
        self.status == CommitmentStatus::Pending &&
        clock.unix_timestamp < self.expires_at
    }
    
    /// Check if commitment is expired
    pub fn is_expired(&self, clock: &Clock) -> bool {
        self.status == CommitmentStatus::Pending &&
        clock.unix_timestamp >= self.expires_at
    }
    
    /// Check if commitment is active (pending and not expired)
    pub fn is_active(&self, clock: &Clock) -> bool {
        self.status == CommitmentStatus::Pending &&
        clock.unix_timestamp < self.expires_at
    }
}

impl Default for SpeculativeCommitment {
    fn default() -> Self {
        Self {
            task: Pubkey::default(),
            worker: Pubkey::default(),
            worker_agent: Pubkey::default(),
            parent_commitment: Pubkey::default(),
            depends_on_task: Pubkey::default(),
            speculation_depth: 0,
            result_hash: [0u8; 32],
            input_state_hash: [0u8; 32],
            compute_cost_estimate: 0,
            created_at: 0,
            expires_at: 0,
            confirmed_at: 0,
            voided_at: 0,
            status: CommitmentStatus::default(),
            bond: Pubkey::default(),
            staked_amount: 0,
            bump: 0,
            _reserved: [0u8; 32],
        }
    }
}
```

**Size Calculation:**
- Total: 345 bytes
- Rent-exempt minimum: ~0.00254 SOL

**PDA Seeds:**
```rust
seeds = [b"spec_commitment", task.key().as_ref(), worker.key().as_ref()]
```

---

### 1.3 SpeculationBond Account

Manages stake bonding for speculation with exponential depth scaling.

```rust
/// Status of a speculation bond
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum BondStatus {
    /// Bond is active and available for locking
    #[default]
    Active = 0,
    /// Bond is partially or fully locked in commitments
    Locked = 1,
    /// Bond is being withdrawn (cooldown period)
    Withdrawing = 2,
    /// Bond has been slashed
    Slashed = 3,
}

/// Speculation bond account
/// Holds stake that backs speculative commitments
/// 
/// PDA seeds: ["spec_bond", agent]
#[account]
#[derive(InitSpace)]
pub struct SpeculationBond {
    // === Identity ===
    /// The agent this bond belongs to
    pub agent: Pubkey,
    /// The agent's authority (signer for operations)
    pub authority: Pubkey,
    
    // === Balances ===
    /// Total amount deposited into the bond
    pub total_deposited: u64,
    /// Amount currently available (not locked)
    pub available_balance: u64,
    /// Amount currently locked in active commitments
    pub locked_balance: u64,
    /// Amount pending withdrawal (in cooldown)
    pub pending_withdrawal: u64,
    
    // === Lock tracking ===
    /// Number of active commitment locks
    pub active_locks: u16,
    /// Maximum concurrent locks allowed
    pub max_locks: u16,
    
    // === Withdrawal state ===
    /// Timestamp when withdrawal cooldown ends (0 if not withdrawing)
    pub withdrawal_available_at: i64,
    /// Amount requested for withdrawal
    pub withdrawal_amount: u64,
    
    // === Slash history ===
    /// Total amount slashed historically
    pub total_slashed: u64,
    /// Number of times this bond has been slashed
    pub slash_count: u16,
    /// Timestamp of last slash (for cooldown)
    pub last_slash_at: i64,
    /// Cooldown end timestamp after slash (cannot speculate until then)
    pub slash_cooldown_until: i64,
    
    // === Timestamps ===
    /// When the bond was created
    pub created_at: i64,
    /// Last activity timestamp
    pub last_activity: i64,
    
    // === State ===
    /// Current bond status
    pub status: BondStatus,
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Reserved for future use
    pub _reserved: [u8; 30],
}

impl SpeculationBond {
    /// Account size calculation
    pub const SIZE: usize = 8 +   // discriminator
        32 +  // agent
        32 +  // authority
        8 +   // total_deposited
        8 +   // available_balance
        8 +   // locked_balance
        8 +   // pending_withdrawal
        2 +   // active_locks
        2 +   // max_locks
        8 +   // withdrawal_available_at
        8 +   // withdrawal_amount
        8 +   // total_slashed
        2 +   // slash_count
        8 +   // last_slash_at
        8 +   // slash_cooldown_until
        8 +   // created_at
        8 +   // last_activity
        1 +   // status
        1 +   // bump
        30;   // _reserved
    
    /// Minimum bond deposit
    pub const MIN_DEPOSIT: u64 = 1_000_000; // 0.001 SOL
    
    /// Maximum deposit per bond
    pub const MAX_DEPOSIT: u64 = 1_000_000_000_000; // 1000 SOL
    
    /// Withdrawal cooldown period (1 hour)
    pub const WITHDRAWAL_COOLDOWN: i64 = 60 * 60;
    
    /// Slash cooldown period (5 minutes)
    pub const SLASH_COOLDOWN: i64 = 5 * 60;
    
    /// Default max concurrent locks
    pub const DEFAULT_MAX_LOCKS: u16 = 100;
    
    /// Base bond amount for speculation (exponential: base * 2^depth)
    pub const BASE_SPECULATION_BOND: u64 = 100_000; // 0.0001 SOL
    
    /// Calculate required bond for a given speculation depth
    /// Formula: base_bond × 2^depth
    pub fn calculate_required_bond(depth: u8) -> Result<u64, CoordinationError> {
        if depth > SpeculativeCommitment::MAX_SPECULATION_DEPTH {
            return Err(CoordinationError::SpeculationDepthExceeded);
        }
        
        let multiplier = 1u64
            .checked_shl(depth as u32)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        
        Self::BASE_SPECULATION_BOND
            .checked_mul(multiplier)
            .ok_or(CoordinationError::ArithmeticOverflow)
    }
    
    /// Check if bond can support a lock of the given amount
    pub fn can_lock(&self, amount: u64, clock: &Clock) -> bool {
        self.status == BondStatus::Active &&
        self.available_balance >= amount &&
        self.active_locks < self.max_locks &&
        clock.unix_timestamp >= self.slash_cooldown_until
    }
    
    /// Check if bond is in slash cooldown
    pub fn is_in_cooldown(&self, clock: &Clock) -> bool {
        clock.unix_timestamp < self.slash_cooldown_until
    }
}

impl Default for SpeculationBond {
    fn default() -> Self {
        Self {
            agent: Pubkey::default(),
            authority: Pubkey::default(),
            total_deposited: 0,
            available_balance: 0,
            locked_balance: 0,
            pending_withdrawal: 0,
            active_locks: 0,
            max_locks: Self::DEFAULT_MAX_LOCKS,
            withdrawal_available_at: 0,
            withdrawal_amount: 0,
            total_slashed: 0,
            slash_count: 0,
            last_slash_at: 0,
            slash_cooldown_until: 0,
            created_at: 0,
            last_activity: 0,
            status: BondStatus::default(),
            bump: 0,
            _reserved: [0u8; 30],
        }
    }
}
```

**Size Calculation:**
- Total: 190 bytes
- Rent-exempt minimum: ~0.00143 SOL

**PDA Seeds:**
```rust
seeds = [b"spec_bond", agent.key().as_ref()]
```

---

### 1.4 BondLock Account

Tracks individual stake locks against commitments.

```rust
/// Individual lock record linking a bond to a commitment
/// 
/// PDA seeds: ["bond_lock", bond, commitment]
#[account]
#[derive(InitSpace)]
pub struct BondLock {
    /// The speculation bond this lock is against
    pub bond: Pubkey,
    /// The speculative commitment this lock secures
    pub commitment: Pubkey,
    /// Amount locked
    pub amount: u64,
    /// When the lock was created
    pub created_at: i64,
    /// When the lock was released (0 if still active)
    pub released_at: i64,
    /// Whether the lock is active
    pub is_active: bool,
    /// Bump seed for PDA
    pub bump: u8,
}

impl BondLock {
    pub const SIZE: usize = 8 +   // discriminator
        32 +  // bond
        32 +  // commitment
        8 +   // amount
        8 +   // created_at
        8 +   // released_at
        1 +   // is_active
        1;    // bump
}

impl Default for BondLock {
    fn default() -> Self {
        Self {
            bond: Pubkey::default(),
            commitment: Pubkey::default(),
            amount: 0,
            created_at: 0,
            released_at: 0,
            is_active: false,
            bump: 0,
        }
    }
}
```

**PDA Seeds:**
```rust
seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()]
```

---

### 1.5 ProtocolConfig Updates

Add speculation configuration to the protocol config.

```rust
/// Add to existing ProtocolConfig struct
impl ProtocolConfig {
    // ... existing fields ...
    
    // === Speculation configuration (add to struct) ===
    /// Whether speculation is enabled protocol-wide
    pub speculation_enabled: bool,
    /// Base bond amount for speculation (lamports)
    pub speculation_base_bond: u64,
    /// Maximum speculation depth allowed
    pub max_speculation_depth: u8,
    /// Slash percentage on failed speculation (0-100)
    pub speculation_slash_percentage: u8,
    /// Commitment expiry duration (seconds)
    pub commitment_expiry_duration: i64,
    /// Slash cooldown duration (seconds)
    pub slash_cooldown_duration: i64,
    /// Treasury share of slashed funds (percentage, 0-100)
    pub slash_treasury_share: u8,
}

// Add these constants
impl ProtocolConfig {
    pub const DEFAULT_SPECULATION_BASE_BOND: u64 = 100_000; // 0.0001 SOL
    pub const DEFAULT_MAX_SPECULATION_DEPTH: u8 = 10;
    pub const DEFAULT_SPECULATION_SLASH_PERCENTAGE: u8 = 10;
    pub const DEFAULT_COMMITMENT_EXPIRY: i64 = 24 * 60 * 60; // 24 hours
    pub const DEFAULT_SLASH_COOLDOWN: i64 = 5 * 60; // 5 minutes
    pub const DEFAULT_SLASH_TREASURY_SHARE: u8 = 50; // 50%
}
```

---

## 2. Instructions

### 2.1 create_dependent_task

Creates a new task with a dependency on an existing task.

#### Accounts

```rust
#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateDependentTask<'info> {
    /// The new task to create
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Account<'info, Task>,

    /// Escrow for the new task's reward
    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    /// The parent task this new task depends on
    #[account(
        constraint = parent_task.status != TaskStatus::Cancelled @ CoordinationError::ParentTaskCancelled,
        constraint = parent_task.status != TaskStatus::Disputed @ CoordinationError::ParentTaskDisputed,
    )]
    pub parent_task: Account<'info, Task>,

    /// Protocol configuration
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Creator's agent registration for rate limiting
    #[account(
        mut,
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// The authority that owns the creator_agent
    pub authority: Signer<'info>,

    /// Task creator (payer)
    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateDependentTaskArgs {
    /// Unique task identifier
    pub task_id: [u8; 32],
    /// Required capability bitmask
    pub required_capabilities: u64,
    /// Task description or instruction hash
    pub description: [u8; 64],
    /// Reward amount in lamports
    pub reward_amount: u64,
    /// Maximum workers allowed
    pub max_workers: u8,
    /// Deadline timestamp (0 = no deadline)
    pub deadline: i64,
    /// Task type (0=Exclusive, 1=Collaborative, 2=Competitive)
    pub task_type: u8,
    /// Constraint hash for private task verification
    pub constraint_hash: Option<[u8; 32]>,
    /// Dependency type (1=Hard, 2=Soft)
    pub dependency_type: u8,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<CreateDependentTask>,
    args: CreateDependentTaskArgs,
) -> Result<()> {
    // 1. Validate inputs
    require!(args.max_workers > 0, CoordinationError::InvalidInput);
    require!(args.task_type <= 2, CoordinationError::InvalidTaskType);
    require!(
        args.dependency_type == 1 || args.dependency_type == 2,
        CoordinationError::InvalidDependencyType
    );
    
    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;
    
    check_version_compatible(config)?;
    
    // 2. Validate deadline if set
    if args.deadline > 0 {
        require!(
            args.deadline > clock.unix_timestamp,
            CoordinationError::InvalidInput
        );
    }
    
    // 3. Calculate and validate dependency depth
    let parent_task = &ctx.accounts.parent_task;
    let new_depth = parent_task.dependency_depth
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    require!(
        new_depth <= Task::MAX_DEPENDENCY_DEPTH,
        CoordinationError::DependencyDepthExceeded
    );
    
    // 4. Apply rate limiting (same as create_task)
    apply_rate_limits(&mut ctx.accounts.creator_agent, config, &clock)?;
    
    // 5. Transfer reward to escrow
    if args.reward_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            args.reward_amount,
        )?;
    }
    
    // 6. Initialize task with dependency fields
    let task = &mut ctx.accounts.task;
    task.task_id = args.task_id;
    task.creator = ctx.accounts.creator.key();
    task.required_capabilities = args.required_capabilities;
    task.description = args.description;
    task.constraint_hash = args.constraint_hash.unwrap_or([0u8; 32]);
    task.reward_amount = args.reward_amount;
    task.max_workers = args.max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = TaskType::try_from(args.task_type)?;
    task.created_at = clock.unix_timestamp;
    task.deadline = args.deadline;
    task.completed_at = 0;
    task.escrow = ctx.accounts.escrow.key();
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if args.task_type == 1 { args.max_workers } else { 1 };
    task.bump = ctx.bumps.task;
    
    // Set dependency fields
    task.depends_on = parent_task.key();
    task.dependency_type = DependencyType::try_from(args.dependency_type)?;
    task.dependency_depth = new_depth;
    
    // 7. Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.task = task.key();
    escrow.amount = args.reward_amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = ctx.bumps.escrow;
    
    // 8. Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    protocol_config.total_tasks = protocol_config
        .total_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // 9. Emit event
    emit!(DependentTaskCreated {
        task_id: args.task_id,
        creator: task.creator,
        parent_task: parent_task.key(),
        parent_task_id: parent_task.task_id,
        dependency_type: args.dependency_type,
        dependency_depth: new_depth,
        required_capabilities: args.required_capabilities,
        reward_amount: args.reward_amount,
        task_type: args.task_type,
        deadline: args.deadline,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `InvalidInput` | max_workers is 0 or deadline is in the past |
| `InvalidTaskType` | task_type > 2 |
| `InvalidDependencyType` | dependency_type not 1 or 2 |
| `ParentTaskCancelled` | Parent task status is Cancelled |
| `ParentTaskDisputed` | Parent task status is Disputed |
| `DependencyDepthExceeded` | New depth > MAX_DEPENDENCY_DEPTH |
| `CooldownNotElapsed` | Rate limit cooldown active |
| `RateLimitExceeded` | 24h task limit reached |
| `InsufficientFunds` | Creator lacks funds for reward |

#### Events Emitted

- `DependentTaskCreated`

---

### 2.2 create_speculative_commitment

Creates an on-chain speculative commitment for cross-agent trust.

#### Accounts

```rust
#[derive(Accounts)]
pub struct CreateSpeculativeCommitment<'info> {
    /// The speculative commitment to create
    #[account(
        init,
        payer = worker,
        space = SpeculativeCommitment::SIZE,
        seeds = [b"spec_commitment", task.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// The task being speculatively executed
    #[account(
        constraint = task.status == TaskStatus::InProgress @ CoordinationError::TaskNotInProgress,
        constraint = task.dependency_type == DependencyType::Soft @ CoordinationError::TaskNotSpeculatable,
    )]
    pub task: Account<'info, Task>,

    /// The task this task depends on
    #[account(
        constraint = parent_task.key() == task.depends_on @ CoordinationError::InvalidParentTask,
    )]
    pub parent_task: Account<'info, Task>,

    /// Parent commitment (optional - Pubkey::default() if parent has no commitment)
    /// CHECK: Validated in handler if not default
    pub parent_commitment: UncheckedAccount<'info>,

    /// The worker's task claim (proves they have claimed this task)
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_agent.key().as_ref()],
        bump = task_claim.bump,
        constraint = task_claim.worker == worker_agent.key() @ CoordinationError::NotClaimed,
        constraint = !task_claim.is_completed @ CoordinationError::ClaimAlreadyCompleted,
    )]
    pub task_claim: Account<'info, TaskClaim>,

    /// The worker's agent registration
    #[account(
        seeds = [b"agent", worker_agent.agent_id.as_ref()],
        bump = worker_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub worker_agent: Account<'info, AgentRegistration>,

    /// The worker's speculation bond
    #[account(
        mut,
        seeds = [b"spec_bond", worker_agent.key().as_ref()],
        bump = bond.bump,
        constraint = bond.agent == worker_agent.key() @ CoordinationError::InvalidBond,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// Bond lock account for this commitment
    #[account(
        init,
        payer = worker,
        space = BondLock::SIZE,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// Protocol configuration
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.speculation_enabled @ CoordinationError::SpeculationDisabled,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Worker's authority (signer)
    pub authority: Signer<'info>,

    /// Worker (payer for account creation)
    #[account(mut)]
    pub worker: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateSpeculativeCommitmentArgs {
    /// Hash of the speculative result
    pub result_hash: [u8; 32],
    /// Hash of the input state used
    pub input_state_hash: [u8; 32],
    /// Estimated computation cost (lamports)
    pub compute_cost_estimate: u64,
    /// Custom expiry duration (0 = use default)
    pub expiry_duration: i64,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<CreateSpeculativeCommitment>,
    args: CreateSpeculativeCommitmentArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;
    let task = &ctx.accounts.task;
    let bond = &mut ctx.accounts.bond;
    
    // 1. Calculate speculation depth
    let speculation_depth = if ctx.accounts.parent_commitment.key() == Pubkey::default() {
        0u8
    } else {
        // Validate and deserialize parent commitment
        let parent_data = ctx.accounts.parent_commitment.try_borrow_data()?;
        let parent_commitment = SpeculativeCommitment::try_deserialize(&mut &parent_data[..])?;
        
        require!(
            parent_commitment.task == task.depends_on,
            CoordinationError::InvalidParentCommitment
        );
        require!(
            parent_commitment.status == CommitmentStatus::Pending ||
            parent_commitment.status == CommitmentStatus::Confirmed,
            CoordinationError::ParentCommitmentInvalid
        );
        
        parent_commitment.speculation_depth
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };
    
    require!(
        speculation_depth <= config.max_speculation_depth,
        CoordinationError::SpeculationDepthExceeded
    );
    
    // 2. Calculate required bond using exponential formula
    let required_bond = SpeculationBond::calculate_required_bond(speculation_depth)?;
    
    // 3. Verify bond has sufficient available balance
    require!(
        bond.can_lock(required_bond, &clock),
        CoordinationError::InsufficientBondBalance
    );
    
    // 4. Lock the bond
    bond.available_balance = bond.available_balance
        .checked_sub(required_bond)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.locked_balance = bond.locked_balance
        .checked_add(required_bond)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.available_balance == 0 {
        bond.status = BondStatus::Locked;
    }
    
    // 5. Initialize bond lock
    let bond_lock = &mut ctx.accounts.bond_lock;
    bond_lock.bond = ctx.accounts.bond.key();
    bond_lock.commitment = ctx.accounts.commitment.key();
    bond_lock.amount = required_bond;
    bond_lock.created_at = clock.unix_timestamp;
    bond_lock.released_at = 0;
    bond_lock.is_active = true;
    bond_lock.bump = ctx.bumps.bond_lock;
    
    // 6. Calculate expiry
    let expiry_duration = if args.expiry_duration > 0 {
        args.expiry_duration
    } else {
        config.commitment_expiry_duration
    };
    let expires_at = clock.unix_timestamp
        .checked_add(expiry_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // 7. Initialize commitment
    let commitment = &mut ctx.accounts.commitment;
    commitment.task = task.key();
    commitment.worker = ctx.accounts.worker.key();
    commitment.worker_agent = ctx.accounts.worker_agent.key();
    commitment.parent_commitment = ctx.accounts.parent_commitment.key();
    commitment.depends_on_task = task.depends_on;
    commitment.speculation_depth = speculation_depth;
    commitment.result_hash = args.result_hash;
    commitment.input_state_hash = args.input_state_hash;
    commitment.compute_cost_estimate = args.compute_cost_estimate;
    commitment.created_at = clock.unix_timestamp;
    commitment.expires_at = expires_at;
    commitment.confirmed_at = 0;
    commitment.voided_at = 0;
    commitment.status = CommitmentStatus::Pending;
    commitment.bond = ctx.accounts.bond.key();
    commitment.staked_amount = required_bond;
    commitment.bump = ctx.bumps.commitment;
    
    // 8. Emit event
    emit!(SpeculativeCommitmentCreated {
        commitment: commitment.key(),
        task: task.key(),
        task_id: task.task_id,
        worker: commitment.worker,
        worker_agent: commitment.worker_agent,
        parent_commitment: commitment.parent_commitment,
        speculation_depth,
        result_hash: args.result_hash,
        staked_amount: required_bond,
        expires_at,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `SpeculationDisabled` | Protocol has speculation disabled |
| `TaskNotInProgress` | Task status is not InProgress |
| `TaskNotSpeculatable` | Task dependency_type is not Soft |
| `InvalidParentTask` | Parent task doesn't match task.depends_on |
| `NotClaimed` | Worker hasn't claimed this task |
| `ClaimAlreadyCompleted` | Claim is already completed |
| `InvalidParentCommitment` | Parent commitment doesn't match parent task |
| `ParentCommitmentInvalid` | Parent commitment is voided or expired |
| `SpeculationDepthExceeded` | Depth exceeds maximum allowed |
| `InsufficientBondBalance` | Bond doesn't have enough available balance |
| `BondInCooldown` | Bond is in slash cooldown |

#### Events Emitted

- `SpeculativeCommitmentCreated`

---

### 2.3 confirm_speculative_commitment

Confirms a speculative commitment after all ancestors are confirmed.

#### Accounts

```rust
#[derive(Accounts)]
pub struct ConfirmSpeculativeCommitment<'info> {
    /// The commitment to confirm
    #[account(
        mut,
        seeds = [b"spec_commitment", task.key().as_ref(), commitment.worker.as_ref()],
        bump = commitment.bump,
        constraint = commitment.status == CommitmentStatus::Pending @ CoordinationError::CommitmentNotPending,
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// The task associated with this commitment
    #[account(
        constraint = task.key() == commitment.task @ CoordinationError::InvalidTask,
        constraint = task.status == TaskStatus::Completed @ CoordinationError::TaskNotCompleted,
    )]
    pub task: Account<'info, Task>,

    /// The parent task (must be completed for confirmation)
    #[account(
        constraint = parent_task.key() == commitment.depends_on_task @ CoordinationError::InvalidParentTask,
        constraint = parent_task.status == TaskStatus::Completed @ CoordinationError::ParentTaskNotCompleted,
    )]
    pub parent_task: Account<'info, Task>,

    /// The worker's speculation bond
    #[account(
        mut,
        seeds = [b"spec_bond", commitment.worker_agent.as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The bond lock for this commitment
    #[account(
        mut,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump = bond_lock.bump,
        constraint = bond_lock.is_active @ CoordinationError::BondLockNotActive,
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// Worker's authority or permissionless confirmer
    pub authority: Signer<'info>,
}
```

#### Args

```rust
// No additional args needed - confirmation is based on on-chain state
```

#### Handler Pseudocode

```rust
pub fn handler(ctx: Context<ConfirmSpeculativeCommitment>) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &mut ctx.accounts.commitment;
    let bond = &mut ctx.accounts.bond;
    let bond_lock = &mut ctx.accounts.bond_lock;
    
    // 1. Verify commitment hasn't expired
    require!(
        commitment.can_confirm(&clock),
        CoordinationError::CommitmentExpired
    );
    
    // 2. Update commitment status
    commitment.status = CommitmentStatus::Confirmed;
    commitment.confirmed_at = clock.unix_timestamp;
    
    // 3. Release bond lock
    let locked_amount = bond_lock.amount;
    bond_lock.is_active = false;
    bond_lock.released_at = clock.unix_timestamp;
    
    // 4. Update bond balances
    bond.locked_balance = bond.locked_balance
        .checked_sub(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.available_balance = bond.available_balance
        .checked_add(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.status == BondStatus::Locked && bond.locked_balance == 0 {
        bond.status = BondStatus::Active;
    }
    
    // 5. Emit event
    emit!(SpeculativeCommitmentConfirmed {
        commitment: ctx.accounts.commitment.key(),
        task: commitment.task,
        worker: commitment.worker,
        speculation_depth: commitment.speculation_depth,
        staked_amount: locked_amount,
        confirmed_at: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `CommitmentNotPending` | Commitment is not in Pending status |
| `CommitmentExpired` | Commitment has expired |
| `TaskNotCompleted` | Task is not completed |
| `ParentTaskNotCompleted` | Parent task is not completed |
| `BondLockNotActive` | Bond lock is not active |

#### Events Emitted

- `SpeculativeCommitmentConfirmed`

---

### 2.4 void_speculative_commitment

Voids a commitment due to ancestor failure, triggering rollback.

#### Accounts

```rust
#[derive(Accounts)]
pub struct VoidSpeculativeCommitment<'info> {
    /// The commitment to void
    #[account(
        mut,
        seeds = [b"spec_commitment", commitment.task.as_ref(), commitment.worker.as_ref()],
        bump = commitment.bump,
        constraint = commitment.status == CommitmentStatus::Pending @ CoordinationError::CommitmentNotPending,
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// The failed parent commitment or task that caused the void
    /// CHECK: Validated in handler
    pub failed_ancestor: UncheckedAccount<'info>,

    /// The worker's speculation bond
    #[account(
        mut,
        seeds = [b"spec_bond", commitment.worker_agent.as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The bond lock for this commitment
    #[account(
        mut,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump = bond_lock.bump,
        constraint = bond_lock.is_active @ CoordinationError::BondLockNotActive,
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// Protocol config for slash parameters
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Protocol treasury for slash distribution
    /// CHECK: Validated against protocol_config
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Anyone can call void if ancestor has failed
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct VoidSpeculativeCommitmentArgs {
    /// Reason for voiding (for logging)
    pub reason: VoidReason,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
#[repr(u8)]
pub enum VoidReason {
    /// Parent commitment was voided
    ParentVoided = 0,
    /// Parent task was cancelled
    ParentCancelled = 1,
    /// Parent task failed dispute
    ParentDisputed = 2,
    /// Commitment expired without confirmation
    Expired = 3,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<VoidSpeculativeCommitment>,
    args: VoidSpeculativeCommitmentArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &mut ctx.accounts.commitment;
    let bond = &mut ctx.accounts.bond;
    let bond_lock = &mut ctx.accounts.bond_lock;
    let config = &ctx.accounts.protocol_config;
    
    // 1. Validate void reason based on ancestor state
    let is_valid_void = match args.reason {
        VoidReason::Expired => commitment.is_expired(&clock),
        VoidReason::ParentVoided | VoidReason::ParentCancelled | VoidReason::ParentDisputed => {
            // Validate ancestor state
            validate_ancestor_failure(&ctx.accounts.failed_ancestor, &commitment)?
        }
    };
    
    require!(is_valid_void, CoordinationError::InvalidVoidReason);
    
    // 2. Calculate slash amount
    let locked_amount = bond_lock.amount;
    let slash_amount = locked_amount
        .checked_mul(config.speculation_slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    let return_amount = locked_amount
        .checked_sub(slash_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // 3. Update commitment status
    commitment.status = CommitmentStatus::Voided;
    commitment.voided_at = clock.unix_timestamp;
    
    // 4. Release bond lock (partial - after slash)
    bond_lock.is_active = false;
    bond_lock.released_at = clock.unix_timestamp;
    
    // 5. Update bond balances with slash
    bond.locked_balance = bond.locked_balance
        .checked_sub(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.available_balance = bond.available_balance
        .checked_add(return_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.total_slashed = bond.total_slashed
        .checked_add(slash_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.slash_count = bond.slash_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_slash_at = clock.unix_timestamp;
    bond.slash_cooldown_until = clock.unix_timestamp
        .checked_add(config.slash_cooldown_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.locked_balance == 0 && bond.status == BondStatus::Locked {
        bond.status = BondStatus::Active;
    }
    
    // 6. Distribute slashed funds
    let treasury_share = slash_amount
        .checked_mul(config.slash_treasury_share as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // Transfer treasury share (remaining can go to affected downstream in separate ix)
    if treasury_share > 0 {
        **ctx.accounts.bond.to_account_info().try_borrow_mut_lamports()? -= treasury_share;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += treasury_share;
    }
    
    // 7. Emit event
    emit!(SpeculativeCommitmentVoided {
        commitment: ctx.accounts.commitment.key(),
        task: commitment.task,
        worker: commitment.worker,
        reason: args.reason as u8,
        slashed_amount: slash_amount,
        returned_amount: return_amount,
        treasury_share,
        voided_at: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `CommitmentNotPending` | Commitment is not in Pending status |
| `InvalidVoidReason` | Void reason doesn't match ancestor state |
| `InvalidTreasury` | Treasury doesn't match protocol config |
| `BondLockNotActive` | Bond lock is not active |

#### Events Emitted

- `SpeculativeCommitmentVoided`

---

### 2.5 deposit_speculation_bond

Deposits SOL into a speculation bond account.

#### Accounts

```rust
#[derive(Accounts)]
pub struct DepositSpeculationBond<'info> {
    /// The bond to deposit into (creates if doesn't exist)
    #[account(
        init_if_needed,
        payer = depositor,
        space = SpeculationBond::SIZE,
        seeds = [b"spec_bond", agent.key().as_ref()],
        bump
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The agent this bond belongs to
    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    /// Agent's authority
    pub authority: Signer<'info>,

    /// Depositor (payer)
    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DepositSpeculationBondArgs {
    /// Amount to deposit in lamports
    pub amount: u64,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<DepositSpeculationBond>,
    args: DepositSpeculationBondArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let bond = &mut ctx.accounts.bond;
    
    // 1. Validate deposit amount
    require!(
        args.amount >= SpeculationBond::MIN_DEPOSIT,
        CoordinationError::DepositTooSmall
    );
    
    let new_total = bond.total_deposited
        .checked_add(args.amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    require!(
        new_total <= SpeculationBond::MAX_DEPOSIT,
        CoordinationError::DepositExceedsMax
    );
    
    // 2. Initialize if new bond
    if bond.created_at == 0 {
        bond.agent = ctx.accounts.agent.key();
        bond.authority = ctx.accounts.authority.key();
        bond.created_at = clock.unix_timestamp;
        bond.status = BondStatus::Active;
        bond.max_locks = SpeculationBond::DEFAULT_MAX_LOCKS;
        bond.bump = ctx.bumps.bond;
    }
    
    // 3. Transfer funds
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.bond.to_account_info(),
            },
        ),
        args.amount,
    )?;
    
    // 4. Update balances
    bond.total_deposited = new_total;
    bond.available_balance = bond.available_balance
        .checked_add(args.amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    // 5. Emit event
    emit!(SpeculationBondDeposited {
        bond: ctx.accounts.bond.key(),
        agent: bond.agent,
        depositor: ctx.accounts.depositor.key(),
        amount: args.amount,
        new_total: bond.total_deposited,
        new_available: bond.available_balance,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `DepositTooSmall` | Amount < MIN_DEPOSIT |
| `DepositExceedsMax` | New total > MAX_DEPOSIT |
| `UnauthorizedAgent` | Authority doesn't match agent |
| `InsufficientFunds` | Depositor lacks funds |

#### Events Emitted

- `SpeculationBondDeposited`

---

### 2.6 withdraw_speculation_bond

Initiates withdrawal from a speculation bond (subject to cooldown).

#### Accounts

```rust
#[derive(Accounts)]
pub struct WithdrawSpeculationBond<'info> {
    /// The bond to withdraw from
    #[account(
        mut,
        seeds = [b"spec_bond", agent.key().as_ref()],
        bump = bond.bump,
        constraint = bond.agent == agent.key() @ CoordinationError::InvalidBond,
        constraint = bond.status != BondStatus::Slashed @ CoordinationError::BondSlashed,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The agent this bond belongs to
    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    /// Agent's authority
    pub authority: Signer<'info>,

    /// Recipient of withdrawn funds
    /// CHECK: Can be any account
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawSpeculationBondArgs {
    /// Amount to withdraw (0 = withdraw all available)
    pub amount: u64,
    /// Skip cooldown if true and no active locks
    pub immediate: bool,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<WithdrawSpeculationBond>,
    args: WithdrawSpeculationBondArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let bond = &mut ctx.accounts.bond;
    
    // 1. Determine withdrawal amount
    let withdraw_amount = if args.amount == 0 {
        bond.available_balance
    } else {
        args.amount
    };
    
    require!(withdraw_amount > 0, CoordinationError::NothingToWithdraw);
    require!(
        withdraw_amount <= bond.available_balance,
        CoordinationError::InsufficientBondBalance
    );
    
    // 2. Handle immediate withdrawal vs cooldown
    if args.immediate {
        require!(
            bond.active_locks == 0,
            CoordinationError::HasActiveLocks
        );
        
        // Immediate withdrawal - transfer now
        **ctx.accounts.bond.to_account_info().try_borrow_mut_lamports()? -= withdraw_amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += withdraw_amount;
        
        bond.available_balance = bond.available_balance
            .checked_sub(withdraw_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        bond.total_deposited = bond.total_deposited
            .checked_sub(withdraw_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        
        emit!(SpeculationBondWithdrawn {
            bond: ctx.accounts.bond.key(),
            agent: bond.agent,
            recipient: ctx.accounts.recipient.key(),
            amount: withdraw_amount,
            remaining: bond.available_balance,
            was_immediate: true,
            timestamp: clock.unix_timestamp,
        });
    } else {
        // Initiate cooldown withdrawal
        require!(
            bond.status != BondStatus::Withdrawing,
            CoordinationError::WithdrawalAlreadyPending
        );
        
        bond.status = BondStatus::Withdrawing;
        bond.withdrawal_amount = withdraw_amount;
        bond.withdrawal_available_at = clock.unix_timestamp
            .checked_add(SpeculationBond::WITHDRAWAL_COOLDOWN)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        bond.available_balance = bond.available_balance
            .checked_sub(withdraw_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        bond.pending_withdrawal = withdraw_amount;
        
        emit!(SpeculationBondWithdrawalInitiated {
            bond: ctx.accounts.bond.key(),
            agent: bond.agent,
            amount: withdraw_amount,
            available_at: bond.withdrawal_available_at,
            timestamp: clock.unix_timestamp,
        });
    }
    
    bond.last_activity = clock.unix_timestamp;
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `BondSlashed` | Bond status is Slashed |
| `NothingToWithdraw` | Withdrawal amount is 0 |
| `InsufficientBondBalance` | Amount exceeds available balance |
| `HasActiveLocks` | Immediate withdrawal with active locks |
| `WithdrawalAlreadyPending` | Already have pending withdrawal |

#### Events Emitted

- `SpeculationBondWithdrawn` (immediate)
- `SpeculationBondWithdrawalInitiated` (cooldown)

---

### 2.7 lock_speculation_bond

Locks a portion of bond for a speculative commitment (internal use).

> **Note:** This is typically called internally by `create_speculative_commitment`. Exposed for advanced use cases.

#### Accounts

```rust
#[derive(Accounts)]
pub struct LockSpeculationBond<'info> {
    /// The bond to lock
    #[account(
        mut,
        seeds = [b"spec_bond", agent.key().as_ref()],
        bump = bond.bump,
        constraint = bond.agent == agent.key() @ CoordinationError::InvalidBond,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// Bond lock account
    #[account(
        init,
        payer = payer,
        space = BondLock::SIZE,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// The commitment this lock is for
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// The agent this bond belongs to
    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub agent: Account<'info, AgentRegistration>,

    /// Agent's authority
    pub authority: Signer<'info>,

    /// Payer for lock account
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct LockSpeculationBondArgs {
    /// Amount to lock
    pub amount: u64,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<LockSpeculationBond>,
    args: LockSpeculationBondArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let bond = &mut ctx.accounts.bond;
    
    // 1. Validate lock conditions
    require!(
        bond.can_lock(args.amount, &clock),
        CoordinationError::CannotLockBond
    );
    
    // 2. Update bond balances
    bond.available_balance = bond.available_balance
        .checked_sub(args.amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.locked_balance = bond.locked_balance
        .checked_add(args.amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.available_balance == 0 {
        bond.status = BondStatus::Locked;
    }
    
    // 3. Initialize lock
    let lock = &mut ctx.accounts.bond_lock;
    lock.bond = ctx.accounts.bond.key();
    lock.commitment = ctx.accounts.commitment.key();
    lock.amount = args.amount;
    lock.created_at = clock.unix_timestamp;
    lock.released_at = 0;
    lock.is_active = true;
    lock.bump = ctx.bumps.bond_lock;
    
    // 4. Emit event
    emit!(SpeculationBondLocked {
        bond: ctx.accounts.bond.key(),
        lock: ctx.accounts.bond_lock.key(),
        commitment: ctx.accounts.commitment.key(),
        amount: args.amount,
        remaining_available: bond.available_balance,
        active_locks: bond.active_locks,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `CannotLockBond` | Bond can't lock (insufficient balance, too many locks, or cooldown) |
| `InvalidBond` | Bond doesn't belong to agent |

#### Events Emitted

- `SpeculationBondLocked`

---

### 2.8 release_speculation_bond

Releases a bond lock after commitment confirmation.

#### Accounts

```rust
#[derive(Accounts)]
pub struct ReleaseSpeculationBond<'info> {
    /// The bond to release from
    #[account(
        mut,
        seeds = [b"spec_bond", bond.agent.as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The bond lock to release
    #[account(
        mut,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump = bond_lock.bump,
        constraint = bond_lock.is_active @ CoordinationError::BondLockNotActive,
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// The commitment (must be confirmed)
    #[account(
        constraint = commitment.status == CommitmentStatus::Confirmed @ CoordinationError::CommitmentNotConfirmed,
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// Anyone can release (permissionless once confirmed)
    pub authority: Signer<'info>,
}
```

#### Handler Pseudocode

```rust
pub fn handler(ctx: Context<ReleaseSpeculationBond>) -> Result<()> {
    let clock = Clock::get()?;
    let bond = &mut ctx.accounts.bond;
    let bond_lock = &mut ctx.accounts.bond_lock;
    
    let locked_amount = bond_lock.amount;
    
    // 1. Release the lock
    bond_lock.is_active = false;
    bond_lock.released_at = clock.unix_timestamp;
    
    // 2. Update bond balances
    bond.locked_balance = bond.locked_balance
        .checked_sub(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.available_balance = bond.available_balance
        .checked_add(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.status == BondStatus::Locked && bond.locked_balance == 0 {
        bond.status = BondStatus::Active;
    }
    
    // 3. Emit event
    emit!(SpeculationBondReleased {
        bond: ctx.accounts.bond.key(),
        lock: ctx.accounts.bond_lock.key(),
        commitment: ctx.accounts.commitment.key(),
        amount: locked_amount,
        new_available: bond.available_balance,
        remaining_locks: bond.active_locks,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `BondLockNotActive` | Lock is not active |
| `CommitmentNotConfirmed` | Commitment is not confirmed |

#### Events Emitted

- `SpeculationBondReleased`

---

### 2.9 slash_speculation_bond

Slashes a bond due to failed speculation (called during void or dispute).

#### Accounts

```rust
#[derive(Accounts)]
pub struct SlashSpeculationBond<'info> {
    /// The bond to slash
    #[account(
        mut,
        seeds = [b"spec_bond", bond.agent.as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, SpeculationBond>,

    /// The bond lock being slashed
    #[account(
        mut,
        seeds = [b"bond_lock", bond.key().as_ref(), commitment.key().as_ref()],
        bump = bond_lock.bump,
        constraint = bond_lock.is_active @ CoordinationError::BondLockNotActive,
    )]
    pub bond_lock: Account<'info, BondLock>,

    /// The voided/failed commitment
    #[account(
        constraint = commitment.status == CommitmentStatus::Voided @ CoordinationError::CommitmentNotVoided,
    )]
    pub commitment: Account<'info, SpeculativeCommitment>,

    /// Protocol config for slash parameters
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Protocol treasury
    /// CHECK: Validated against protocol_config
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Affected downstream worker (optional, for compensation)
    /// CHECK: Can be any account
    #[account(mut)]
    pub affected_worker: Option<UncheckedAccount<'info>>,

    /// Authority (protocol authority or automated)
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

#### Args

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SlashSpeculationBondArgs {
    /// Compute cost claimed by affected worker (for proportional compensation)
    pub affected_compute_cost: Option<u64>,
}
```

#### Handler Pseudocode

```rust
pub fn handler(
    ctx: Context<SlashSpeculationBond>,
    args: SlashSpeculationBondArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    let bond = &mut ctx.accounts.bond;
    let bond_lock = &mut ctx.accounts.bond_lock;
    let config = &ctx.accounts.protocol_config;
    
    let locked_amount = bond_lock.amount;
    
    // 1. Calculate slash distribution
    let slash_amount = locked_amount
        .checked_mul(config.speculation_slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    let return_amount = locked_amount
        .checked_sub(slash_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // Treasury gets configured share
    let treasury_share = slash_amount
        .checked_mul(config.slash_treasury_share as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // Affected worker gets remainder
    let worker_share = slash_amount
        .checked_sub(treasury_share)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // 2. Release the lock
    bond_lock.is_active = false;
    bond_lock.released_at = clock.unix_timestamp;
    
    // 3. Update bond with slash
    bond.locked_balance = bond.locked_balance
        .checked_sub(locked_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.available_balance = bond.available_balance
        .checked_add(return_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.total_slashed = bond.total_slashed
        .checked_add(slash_amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.slash_count = bond.slash_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_slash_at = clock.unix_timestamp;
    bond.slash_cooldown_until = clock.unix_timestamp
        .checked_add(config.slash_cooldown_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.active_locks = bond.active_locks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bond.last_activity = clock.unix_timestamp;
    
    if bond.locked_balance == 0 {
        bond.status = BondStatus::Active;
    }
    
    // 4. Transfer slashed funds
    if treasury_share > 0 {
        **ctx.accounts.bond.to_account_info().try_borrow_mut_lamports()? -= treasury_share;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += treasury_share;
    }
    
    if let Some(affected) = &ctx.accounts.affected_worker {
        if worker_share > 0 {
            **ctx.accounts.bond.to_account_info().try_borrow_mut_lamports()? -= worker_share;
            **affected.try_borrow_mut_lamports()? += worker_share;
        }
    }
    
    // 5. Emit event
    emit!(SpeculationBondSlashed {
        bond: ctx.accounts.bond.key(),
        commitment: ctx.accounts.commitment.key(),
        total_slashed: slash_amount,
        treasury_share,
        worker_share,
        affected_worker: ctx.accounts.affected_worker.as_ref().map(|a| a.key()),
        returned_amount: return_amount,
        slash_count: bond.slash_count,
        cooldown_until: bond.slash_cooldown_until,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### Error Conditions

| Error | Condition |
|-------|-----------|
| `BondLockNotActive` | Lock is not active |
| `CommitmentNotVoided` | Commitment is not voided |
| `InvalidTreasury` | Treasury doesn't match protocol config |

#### Events Emitted

- `SpeculationBondSlashed`

---

## 3. Events

### 3.1 Task Events

```rust
/// Emitted when a dependent task is created
#[event]
pub struct DependentTaskCreated {
    /// Task ID
    pub task_id: [u8; 32],
    /// Task creator
    pub creator: Pubkey,
    /// Parent task pubkey
    pub parent_task: Pubkey,
    /// Parent task ID
    pub parent_task_id: [u8; 32],
    /// Dependency type (1=Hard, 2=Soft)
    pub dependency_type: u8,
    /// Depth in dependency chain
    pub dependency_depth: u8,
    /// Required capabilities
    pub required_capabilities: u64,
    /// Reward amount
    pub reward_amount: u64,
    /// Task type
    pub task_type: u8,
    /// Deadline timestamp
    pub deadline: i64,
    /// Event timestamp
    pub timestamp: i64,
}
```

### 3.2 Commitment Events

```rust
/// Emitted when a speculative commitment is created
#[event]
pub struct SpeculativeCommitmentCreated {
    /// Commitment account pubkey
    pub commitment: Pubkey,
    /// Task being executed
    pub task: Pubkey,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker pubkey
    pub worker: Pubkey,
    /// Worker's agent account
    pub worker_agent: Pubkey,
    /// Parent commitment (if any)
    pub parent_commitment: Pubkey,
    /// Speculation depth
    pub speculation_depth: u8,
    /// Hash of speculative result
    pub result_hash: [u8; 32],
    /// Amount staked for this commitment
    pub staked_amount: u64,
    /// When commitment expires
    pub expires_at: i64,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when a speculative commitment is confirmed
#[event]
pub struct SpeculativeCommitmentConfirmed {
    /// Commitment account pubkey
    pub commitment: Pubkey,
    /// Task that was confirmed
    pub task: Pubkey,
    /// Worker who made the commitment
    pub worker: Pubkey,
    /// Speculation depth that was confirmed
    pub speculation_depth: u8,
    /// Amount that was staked
    pub staked_amount: u64,
    /// When confirmed
    pub confirmed_at: i64,
}

/// Emitted when a speculative commitment is voided
#[event]
pub struct SpeculativeCommitmentVoided {
    /// Commitment account pubkey
    pub commitment: Pubkey,
    /// Task that was voided
    pub task: Pubkey,
    /// Worker who made the commitment
    pub worker: Pubkey,
    /// Reason for void (0=ParentVoided, 1=ParentCancelled, 2=ParentDisputed, 3=Expired)
    pub reason: u8,
    /// Amount slashed
    pub slashed_amount: u64,
    /// Amount returned to worker
    pub returned_amount: u64,
    /// Amount sent to treasury
    pub treasury_share: u64,
    /// When voided
    pub voided_at: i64,
}
```

### 3.3 Bond Events

```rust
/// Emitted when SOL is deposited into a speculation bond
#[event]
pub struct SpeculationBondDeposited {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Agent the bond belongs to
    pub agent: Pubkey,
    /// Who made the deposit
    pub depositor: Pubkey,
    /// Amount deposited
    pub amount: u64,
    /// New total deposited
    pub new_total: u64,
    /// New available balance
    pub new_available: u64,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when withdrawal is initiated (cooldown starts)
#[event]
pub struct SpeculationBondWithdrawalInitiated {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Agent the bond belongs to
    pub agent: Pubkey,
    /// Amount being withdrawn
    pub amount: u64,
    /// When withdrawal will be available
    pub available_at: i64,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when withdrawal completes
#[event]
pub struct SpeculationBondWithdrawn {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Agent the bond belongs to
    pub agent: Pubkey,
    /// Recipient of funds
    pub recipient: Pubkey,
    /// Amount withdrawn
    pub amount: u64,
    /// Remaining balance
    pub remaining: u64,
    /// Whether it was immediate (no cooldown)
    pub was_immediate: bool,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when bond is locked for a commitment
#[event]
pub struct SpeculationBondLocked {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Lock account pubkey
    pub lock: Pubkey,
    /// Commitment this lock is for
    pub commitment: Pubkey,
    /// Amount locked
    pub amount: u64,
    /// Remaining available balance
    pub remaining_available: u64,
    /// Total active locks
    pub active_locks: u16,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when bond lock is released
#[event]
pub struct SpeculationBondReleased {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Lock account pubkey
    pub lock: Pubkey,
    /// Commitment that was confirmed
    pub commitment: Pubkey,
    /// Amount released
    pub amount: u64,
    /// New available balance
    pub new_available: u64,
    /// Remaining active locks
    pub remaining_locks: u16,
    /// Event timestamp
    pub timestamp: i64,
}

/// Emitted when bond is slashed
#[event]
pub struct SpeculationBondSlashed {
    /// Bond account pubkey
    pub bond: Pubkey,
    /// Commitment that was voided
    pub commitment: Pubkey,
    /// Total amount slashed
    pub total_slashed: u64,
    /// Amount sent to treasury
    pub treasury_share: u64,
    /// Amount sent to affected worker
    pub worker_share: u64,
    /// Affected worker (if any)
    pub affected_worker: Option<Pubkey>,
    /// Amount returned to bond owner
    pub returned_amount: u64,
    /// Total slash count for this bond
    pub slash_count: u16,
    /// Cooldown end timestamp
    pub cooldown_until: i64,
    /// Event timestamp
    pub timestamp: i64,
}
```

---

## 4. Error Codes

Add the following to `CoordinationError`:

```rust
#[error_code]
pub enum CoordinationError {
    // ... existing errors (6000-6899) ...
    
    // Speculation errors (6900-6999)
    
    #[msg("Speculation is disabled for this protocol")]
    SpeculationDisabled, // 6900

    #[msg("Task does not allow speculative execution")]
    TaskNotSpeculatable, // 6901

    #[msg("Parent task has been cancelled")]
    ParentTaskCancelled, // 6902

    #[msg("Parent task is under dispute")]
    ParentTaskDisputed, // 6903

    #[msg("Dependency depth exceeds maximum allowed")]
    DependencyDepthExceeded, // 6904

    #[msg("Invalid dependency type specified")]
    InvalidDependencyType, // 6905

    #[msg("Speculation depth exceeds maximum allowed")]
    SpeculationDepthExceeded, // 6906

    #[msg("Invalid parent task reference")]
    InvalidParentTask, // 6907

    #[msg("Invalid parent commitment reference")]
    InvalidParentCommitment, // 6908

    #[msg("Parent commitment is in invalid state")]
    ParentCommitmentInvalid, // 6909

    #[msg("Speculative commitment is not in pending status")]
    CommitmentNotPending, // 6910

    #[msg("Speculative commitment has expired")]
    CommitmentExpired, // 6911

    #[msg("Speculative commitment is not confirmed")]
    CommitmentNotConfirmed, // 6912

    #[msg("Speculative commitment is not voided")]
    CommitmentNotVoided, // 6913

    #[msg("Parent task has not been completed")]
    ParentTaskNotCompleted, // 6914

    #[msg("Task has not been completed")]
    TaskNotCompleted, // 6915

    #[msg("Invalid void reason for current state")]
    InvalidVoidReason, // 6916

    // Bond errors (7000-7099)

    #[msg("Invalid speculation bond reference")]
    InvalidBond, // 7000

    #[msg("Insufficient balance in speculation bond")]
    InsufficientBondBalance, // 7001

    #[msg("Bond is currently in slash cooldown")]
    BondInCooldown, // 7002

    #[msg("Bond has been slashed and is inactive")]
    BondSlashed, // 7003

    #[msg("Cannot lock bond - insufficient balance, max locks, or cooldown")]
    CannotLockBond, // 7004

    #[msg("Bond lock is not active")]
    BondLockNotActive, // 7005

    #[msg("Deposit amount is below minimum")]
    DepositTooSmall, // 7006

    #[msg("Deposit would exceed maximum allowed")]
    DepositExceedsMax, // 7007

    #[msg("Nothing available to withdraw")]
    NothingToWithdraw, // 7008

    #[msg("Bond has active locks - cannot perform immediate withdrawal")]
    HasActiveLocks, // 7009

    #[msg("Withdrawal already pending - wait for cooldown")]
    WithdrawalAlreadyPending, // 7010

    #[msg("Invalid treasury account")]
    InvalidTreasury, // 7011
}
```

---

## 5. IDL Changes Summary

### 5.1 New Types

```json
{
  "types": [
    {
      "name": "DependencyType",
      "type": { "kind": "enum", "variants": ["None", "Hard", "Soft"] }
    },
    {
      "name": "CommitmentStatus", 
      "type": { "kind": "enum", "variants": ["Pending", "Confirmed", "Voided", "Expired"] }
    },
    {
      "name": "BondStatus",
      "type": { "kind": "enum", "variants": ["Active", "Locked", "Withdrawing", "Slashed"] }
    },
    {
      "name": "VoidReason",
      "type": { "kind": "enum", "variants": ["ParentVoided", "ParentCancelled", "ParentDisputed", "Expired"] }
    }
  ]
}
```

### 5.2 New Accounts

```json
{
  "accounts": [
    { "name": "SpeculativeCommitment", "size": 345 },
    { "name": "SpeculationBond", "size": 190 },
    { "name": "BondLock", "size": 98 }
  ]
}
```

### 5.3 Modified Accounts

```json
{
  "accounts": [
    {
      "name": "Task",
      "changes": [
        "Added: depends_on (Pubkey)",
        "Added: dependency_type (DependencyType)", 
        "Added: dependency_depth (u8)",
        "Modified: _reserved reduced from 32 to 28 bytes"
      ]
    },
    {
      "name": "ProtocolConfig",
      "changes": [
        "Added: speculation_enabled (bool)",
        "Added: speculation_base_bond (u64)",
        "Added: max_speculation_depth (u8)",
        "Added: speculation_slash_percentage (u8)",
        "Added: commitment_expiry_duration (i64)",
        "Added: slash_cooldown_duration (i64)",
        "Added: slash_treasury_share (u8)"
      ]
    }
  ]
}
```

### 5.4 New Instructions

| Instruction | Accounts | Args |
|-------------|----------|------|
| `create_dependent_task` | 8 | CreateDependentTaskArgs |
| `create_speculative_commitment` | 11 | CreateSpeculativeCommitmentArgs |
| `confirm_speculative_commitment` | 5 | None |
| `void_speculative_commitment` | 7 | VoidSpeculativeCommitmentArgs |
| `deposit_speculation_bond` | 5 | DepositSpeculationBondArgs |
| `withdraw_speculation_bond` | 5 | WithdrawSpeculationBondArgs |
| `lock_speculation_bond` | 7 | LockSpeculationBondArgs |
| `release_speculation_bond` | 4 | None |
| `slash_speculation_bond` | 8 | SlashSpeculationBondArgs |

### 5.5 New Events

- `DependentTaskCreated`
- `SpeculativeCommitmentCreated`
- `SpeculativeCommitmentConfirmed`
- `SpeculativeCommitmentVoided`
- `SpeculationBondDeposited`
- `SpeculationBondWithdrawalInitiated`
- `SpeculationBondWithdrawn`
- `SpeculationBondLocked`
- `SpeculationBondReleased`
- `SpeculationBondSlashed`

### 5.6 SDK Regeneration

After deploying the program update:

```bash
# Regenerate TypeScript SDK
anchor idl fetch <PROGRAM_ID> -o idl/agenc_coordination.json
anchor client gen idl/agenc_coordination.json -o sdk/src/generated

# Regenerate Rust client
anchor-client-gen idl/agenc_coordination.json sdk/rust/src/generated
```

---

## 6. Migration Plan

### 6.1 Account Versioning Strategy

The Task struct modification is **backward compatible** due to these factors:

1. **New fields have defaults**: `depends_on = Pubkey::default()`, `dependency_type = None`, `dependency_depth = 0`
2. **Size unchanged**: Reserved bytes reduced to accommodate new fields
3. **Existing tasks unaffected**: Tasks without dependencies continue to work

### 6.2 Migration Approach

**Phase 1: Deploy with Backward Compatibility**

```rust
// Add version check in handlers
impl Task {
    /// Check if this task uses the new dependency fields
    pub fn is_v2(&self) -> bool {
        self.depends_on != Pubkey::default() || 
        self.dependency_type != DependencyType::None
    }
}
```

**Phase 2: Data Migration (Optional)**

For existing Task accounts, no migration is required. The zeroed reserved bytes will deserialize as:
- `depends_on`: `Pubkey::default()` (all zeros)
- `dependency_type`: `DependencyType::None` (0)
- `dependency_depth`: `0`

**Phase 3: Protocol Config Update**

```rust
// Add instruction to update speculation settings
pub fn update_speculation_config(
    ctx: Context<UpdateProtocolConfig>,
    speculation_enabled: bool,
    speculation_base_bond: u64,
    max_speculation_depth: u8,
    speculation_slash_percentage: u8,
    commitment_expiry_duration: i64,
    slash_cooldown_duration: i64,
    slash_treasury_share: u8,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    
    // Validate parameters
    require!(speculation_slash_percentage <= 100, CoordinationError::InvalidInput);
    require!(slash_treasury_share <= 100, CoordinationError::InvalidInput);
    require!(max_speculation_depth <= 20, CoordinationError::InvalidInput);
    
    config.speculation_enabled = speculation_enabled;
    config.speculation_base_bond = speculation_base_bond;
    config.max_speculation_depth = max_speculation_depth;
    config.speculation_slash_percentage = speculation_slash_percentage;
    config.commitment_expiry_duration = commitment_expiry_duration;
    config.slash_cooldown_duration = slash_cooldown_duration;
    config.slash_treasury_share = slash_treasury_share;
    
    emit!(SpeculationConfigUpdated { ... });
    
    Ok(())
}
```

### 6.3 Rollout Plan

1. **Devnet Deployment**
   - Deploy updated program
   - Run integration tests
   - Verify existing tasks work unchanged

2. **Mainnet Deployment**
   - Deploy during low-traffic period
   - Keep `speculation_enabled = false` initially
   - Verify all existing functionality

3. **Feature Activation**
   - Enable speculation via `update_speculation_config`
   - Start with conservative parameters
   - Monitor metrics and adjust

### 6.4 Rollback Plan

If issues are discovered:

1. **Soft Disable**: Set `speculation_enabled = false`
2. **Existing Commitments**: Allow confirmation/void of existing
3. **Hard Rollback**: Redeploy previous program version if critical

---

## 7. Security Analysis

### 7.1 Reentrancy Considerations

**Risk Level: Low**

The Solana runtime prevents reentrancy by default through its single-threaded execution model. However, CPI (Cross-Program Invocation) chains need consideration:

```rust
// Safe: All state updates happen BEFORE external transfers
pub fn handler(ctx: Context<SlashSpeculationBond>, ...) -> Result<()> {
    // 1. Update bond state (internal)
    bond.locked_balance -= amount;
    bond.total_slashed += slash_amount;
    
    // 2. THEN transfer (external)
    **bond.to_account_info().try_borrow_mut_lamports()? -= treasury_share;
    **treasury.try_borrow_mut_lamports()? += treasury_share;
    
    Ok(())
}
```

**Mitigations:**
- All state mutations complete before any lamport transfers
- Use of Anchor's borrow checking ensures exclusive access
- No external program CPIs that could callback

### 7.2 Signer Validation

**All instructions validate signers appropriately:**

| Instruction | Required Signers | Validation |
|-------------|------------------|------------|
| `create_dependent_task` | creator, authority | `has_one = authority` |
| `create_speculative_commitment` | worker, authority | `has_one = authority` |
| `confirm_speculative_commitment` | authority | Permissionless once conditions met |
| `void_speculative_commitment` | authority | Permissionless once conditions met |
| `deposit_speculation_bond` | depositor, authority | `has_one = authority` |
| `withdraw_speculation_bond` | authority | `has_one = authority` |
| `slash_speculation_bond` | authority | Protocol authority or permissionless |

**Permissionless Operations:**
- `confirm_speculative_commitment`: Safe because requires on-chain proof of task + parent completion
- `void_speculative_commitment`: Safe because requires proof of ancestor failure

### 7.3 PDA Collision Analysis

**PDA Uniqueness Guarantees:**

| Account | Seeds | Collision Risk |
|---------|-------|----------------|
| Task | `["task", creator, task_id]` | None - task_id is 32-byte unique |
| SpeculativeCommitment | `["spec_commitment", task, worker]` | None - one commitment per (task, worker) |
| SpeculationBond | `["spec_bond", agent]` | None - one bond per agent |
| BondLock | `["bond_lock", bond, commitment]` | None - one lock per (bond, commitment) |

**Seed Derivation Security:**
- All seeds include program-owned account pubkeys
- No user-controllable strings that could cause collision
- Bump seeds stored and verified on subsequent access

### 7.4 Economic Attack Vectors

#### 7.4.1 Speculation Spam Attack

**Attack:** Malicious agent creates many speculative commitments to exhaust bonds/resources.

**Mitigations:**
- Exponential bond requirement: `base × 2^depth`
- Maximum concurrent locks per bond (`max_locks`)
- Minimum deposit requirement
- Cooldown after slash

**Cost Analysis:**
```
Depth 0: 0.0001 SOL
Depth 5: 0.0032 SOL  
Depth 10: 0.1024 SOL
Depth 15: 3.2768 SOL
```

#### 7.4.2 Griefing via Void

**Attack:** Attacker intentionally fails ancestor to void downstream commitments.

**Mitigations:**
- Slashing applies to the failed ancestor, not just void target
- Economic loss for attacker: `slash_percentage` of their bond
- Cooldown prevents rapid repeated attacks
- Affected downstream workers receive compensation from slash

#### 7.4.3 Sandwich Attack on Commitments

**Attack:** Front-run commitment creation to manipulate parent state.

**Mitigations:**
- Commitment validates parent state at creation time
- Parent task status checked (not Cancelled/Disputed)
- Result hash commits to specific input state

#### 7.4.4 Withdrawal Race

**Attack:** Withdraw bond while commitment is pending to escape slash.

**Mitigations:**
- Withdrawal requires `active_locks == 0` for immediate
- Cooldown period for non-immediate withdrawals
- Locked balance cannot be withdrawn

#### 7.4.5 Slash Evasion

**Attack:** Create new bond to escape slash history.

**Impact:** Limited - each bond is per-agent, agent reputation persists
**Future Enhancement:** Consider cross-bond reputation tracking

### 7.5 Timestamp Manipulation

**Risk Level: Low**

Solana's `Clock::get()` provides consensus-verified timestamps. Validators cannot arbitrarily manipulate without consensus.

**Protected Operations:**
- Commitment expiry checks
- Slash cooldown calculations
- Rate limiting windows

### 7.6 Integer Overflow Protection

All arithmetic operations use checked math:

```rust
// Example from handler
bond.locked_balance = bond.locked_balance
    .checked_sub(locked_amount)
    .ok_or(CoordinationError::ArithmeticOverflow)?;
```

### 7.7 Access Control Matrix

| Operation | Creator | Worker | Agent Authority | Protocol Authority | Anyone |
|-----------|---------|--------|-----------------|-------------------|--------|
| Create Dependent Task | ✓ | | | | |
| Create Commitment | | ✓ | ✓ | | |
| Confirm Commitment | | | | | ✓* |
| Void Commitment | | | | | ✓* |
| Deposit Bond | | | ✓ | | |
| Withdraw Bond | | | ✓ | | |
| Slash Bond | | | | ✓ | ✓* |

\* Permissionless when on-chain conditions are met

---

## Appendix A: Size Calculations

### Task (Updated)
```
Discriminator:           8
task_id:                32
creator:                32
required_capabilities:   8
description:            64
constraint_hash:        32
reward_amount:           8
max_workers:             1
current_workers:         1
status:                  1
task_type:               1
created_at:              8
deadline:                8
completed_at:            8
escrow:                 32
result:                 64
completions:             1
required_completions:    1
bump:                    1
depends_on:             32  (NEW)
dependency_type:         1  (NEW)
dependency_depth:        1  (NEW)
_reserved:              28  (REDUCED from 32)
----------------------------
TOTAL:                 336 bytes (unchanged)
```

### SpeculativeCommitment
```
Discriminator:           8
task:                   32
worker:                 32
worker_agent:           32
parent_commitment:      32
depends_on_task:        32
speculation_depth:       1
result_hash:            32
input_state_hash:       32
compute_cost_estimate:   8
created_at:              8
expires_at:              8
confirmed_at:            8
voided_at:               8
status:                  1
bond:                   32
staked_amount:           8
bump:                    1
_reserved:              32
----------------------------
TOTAL:                 345 bytes
Rent-exempt: ~0.00254 SOL
```

### SpeculationBond
```
Discriminator:           8
agent:                  32
authority:              32
total_deposited:         8
available_balance:       8
locked_balance:          8
pending_withdrawal:      8
active_locks:            2
max_locks:               2
withdrawal_available_at: 8
withdrawal_amount:       8
total_slashed:           8
slash_count:             2
last_slash_at:           8
slash_cooldown_until:    8
created_at:              8
last_activity:           8
status:                  1
bump:                    1
_reserved:              30
----------------------------
TOTAL:                 190 bytes
Rent-exempt: ~0.00143 SOL
```

### BondLock
```
Discriminator:           8
bond:                   32
commitment:             32
amount:                  8
created_at:              8
released_at:             8
is_active:               1
bump:                    1
----------------------------
TOTAL:                  98 bytes
Rent-exempt: ~0.00089 SOL
```

---

## Appendix B: PDA Derivation Reference

```rust
// Task PDA
let (task_pda, task_bump) = Pubkey::find_program_address(
    &[b"task", creator.as_ref(), task_id.as_ref()],
    &program_id,
);

// Escrow PDA  
let (escrow_pda, escrow_bump) = Pubkey::find_program_address(
    &[b"escrow", task_pda.as_ref()],
    &program_id,
);

// Speculative Commitment PDA
let (commitment_pda, commitment_bump) = Pubkey::find_program_address(
    &[b"spec_commitment", task_pda.as_ref(), worker.as_ref()],
    &program_id,
);

// Speculation Bond PDA
let (bond_pda, bond_bump) = Pubkey::find_program_address(
    &[b"spec_bond", agent_pda.as_ref()],
    &program_id,
);

// Bond Lock PDA
let (lock_pda, lock_bump) = Pubkey::find_program_address(
    &[b"bond_lock", bond_pda.as_ref(), commitment_pda.as_ref()],
    &program_id,
);
```

---

## Appendix C: Gas Cost Estimates

| Operation | Compute Units | Est. Cost (SOL) |
|-----------|---------------|-----------------|
| create_dependent_task | ~50,000 | ~0.00005 |
| create_speculative_commitment | ~75,000 | ~0.000075 |
| confirm_speculative_commitment | ~30,000 | ~0.00003 |
| void_speculative_commitment | ~45,000 | ~0.000045 |
| deposit_speculation_bond | ~35,000 | ~0.000035 |
| withdraw_speculation_bond | ~40,000 | ~0.00004 |
| slash_speculation_bond | ~55,000 | ~0.000055 |

*Estimates based on Solana mainnet average fees. Actual costs may vary.*

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-28 | AgenC Team | Initial specification |
