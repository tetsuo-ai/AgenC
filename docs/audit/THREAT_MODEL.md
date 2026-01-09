Threat Model 



Actors

Malicious agent

Malicious task creator

Colluding agents

Griefing attackers (no profit motive)

Honest-but-buggy clients

Replay / race-condition attackers

Assets at Risk

Escrowed SOL

Reputation scores

Stake balances

Task state integrity

Liveness guarantees

Failure Classes

Funds drained

Funds locked forever

Reputation manipulation

Dispute capture

Task state desync

Authority bypass

Governance / Authority Threats

Single authority key compromise (pre-multisig)

Misconfigured governance parameters without multisig gating

Residual risk during transition from single-authority to multisig enforcement

## Protocol Invariants

### Escrow Invariants

**E1: Escrow Balance Conservation**
- Statement: The sum of `TaskEscrow.distributed` plus remaining lamports in the escrow account must equal `TaskEscrow.amount` at all times (prior to account closure).
- Applies to: `create_task`, `complete_task`, `cancel_task`, `resolve_dispute`
- Prevents: Funds drained, funds locked forever

**E2: Monotonic Distribution**
- Statement: `TaskEscrow.distributed` can only increase, never decrease.
- Applies to: `complete_task`, `resolve_dispute`
- Prevents: Double-spend via distribution rollback

**E3: Distribution Bounded by Deposit**
- Statement: `TaskEscrow.distributed <= TaskEscrow.amount` must always hold.
- Applies to: `complete_task`, `resolve_dispute`
- Prevents: Funds drained (overdraft)

**E4: Single Closure**
- Statement: Once `TaskEscrow.is_closed == true`, no further lamport transfers can occur from the escrow.
- Applies to: `complete_task`, `cancel_task`, `resolve_dispute`
- Prevents: Funds drained after task finalization

**E5: Escrow-Task Binding**
- Statement: Each `TaskEscrow` is derived via PDA seeds `["escrow", task.key()]` and its `task` field must match the associated Task account.
- Applies to: `create_task`, `complete_task`, `cancel_task`, `resolve_dispute`
- Prevents: Escrow misdirection, funds drained

### Task State Machine Invariants

**T1: Valid State Transitions**
- Statement: Task status transitions must follow the valid state machine:
  - `Open` → `InProgress` (via `claim_task`)
  - `Open` → `Cancelled` (via `cancel_task`)
  - `InProgress` → `Completed` (via `complete_task` when `completions >= required_completions`)
  - `InProgress` → `Cancelled` (via `cancel_task` if deadline passed and no completions)
  - `InProgress` → `Disputed` (via `initiate_dispute`)
  - `Disputed` → `Completed` or `Cancelled` (via `resolve_dispute`)
- Applies to: `claim_task`, `complete_task`, `cancel_task`, `initiate_dispute`, `resolve_dispute`
- Prevents: Task state desync, authority bypass

**T2: Terminal State Immutability**
- Statement: Once a task reaches `Completed` or `Cancelled` status, no instruction can modify its state.
- Applies to: All task-modifying instructions (`claim_task`, `complete_task`, `cancel_task`, `initiate_dispute`)
- Prevents: Task state desync, double-spend

**T3: Worker Count Consistency**
- Statement: `Task.current_workers` must equal the number of `TaskClaim` accounts referencing this task, and `current_workers <= max_workers`.
- Applies to: `claim_task`
- Prevents: Task state desync, resource exhaustion

**T4: Completion Count Bounded**
- Statement: `Task.completions <= Task.required_completions` and `completions <= current_workers`.
- Applies to: `complete_task`
- Prevents: Funds drained (over-payment), task state desync

**T5: Deadline Enforcement**
- Statement: If `Task.deadline > 0` and `current_time >= deadline`, new claims are rejected via `claim_task`.
- Applies to: `claim_task`
- Prevents: Liveness abuse, stale task claims

### Reputation Invariants

**R1: Reputation Bounds**
- Statement: `AgentRegistration.reputation` is always in range [0, 10000] (representing 0-100% with two decimal precision).
- Applies to: `register_agent`, `complete_task`
- Prevents: Reputation manipulation (overflow/underflow)

**R2: Initial Reputation**
- Statement: New agents start with `reputation = 5000` (50%) via `register_agent`.
- Applies to: `register_agent`
- Prevents: Reputation manipulation (artificial inflation at registration)

**R3: Reputation Increment Rules**
- Statement: Reputation increases by 100 per successful task completion, capped at 10000 (`saturating_add(100).min(10000)`).
- Applies to: `complete_task`
- Prevents: Reputation manipulation

**R4: Single Application Per Completion**
- Statement: Each `TaskClaim` can only trigger one reputation increment. Once `TaskClaim.is_completed == true`, the claim cannot be completed again.
- Applies to: `complete_task`
- Prevents: Reputation manipulation via replay

### Stake Invariants

**S1: Arbiter Stake Threshold**
- Statement: Agents voting on disputes must have `AgentRegistration.stake >= ProtocolConfig.min_arbiter_stake`.
- Applies to: `vote_dispute`
- Prevents: Dispute capture (sybil voting)

**S2: Active Task Obligation**
- Statement: Agents with `active_tasks > 0` cannot be deregistered via `deregister_agent`.
- Applies to: `deregister_agent`
- Prevents: Task state desync, funds locked (abandonment)

**S3: Stake Non-Negative**
- Statement: `AgentRegistration.stake >= 0` (enforced by u64 type).
- Applies to: All stake-related operations
- Prevents: Arithmetic underflow

### Authority Invariants

**A1: Agent Self-Sovereignty**
- Statement: Only the `AgentRegistration.authority` signer can modify agent state via `update_agent` or close the account via `deregister_agent`. Enforced by `has_one = authority` constraint.
- Applies to: `update_agent`, `deregister_agent`
- Prevents: Authority bypass

**A2: Task Creator Exclusivity**
- Statement: Only the `Task.creator` signer can cancel a task via `cancel_task`. Enforced by `has_one = creator` constraint.
- Applies to: `cancel_task`
- Prevents: Authority bypass, funds drained

**A3: Worker Claim Binding**
- Statement: Task completion requires the worker's authority signature, and the `TaskClaim` must be derived from `["claim", task.key(), worker.key()]`.
- Applies to: `claim_task`, `complete_task`
- Prevents: Authority bypass, impersonation

**A4: Arbiter Capability Requirement**
- Statement: Only agents with `capability::ARBITER` flag set can vote on disputes.
- Applies to: `vote_dispute`
- Prevents: Dispute capture, authority bypass

**A5: Protocol Authority Exclusivity**
- Statement: Only `ProtocolConfig.authority` can modify global protocol parameters (currently set at initialization). Governance changes are intended to be multisig-gated; until multisig enforcement is active, single-authority compromise remains a residual risk.
- Applies to: `initialize_protocol`
- Prevents: Authority bypass, protocol takeover (with residual risk prior to multisig)

### Dispute Invariants

**D1: Dispute State Machine**
- Statement: Dispute status transitions must follow:
  - `Active` (created via `initiate_dispute`)
  - `Active` → `Resolved` (via `resolve_dispute` after voting deadline)
- Applies to: `initiate_dispute`, `vote_dispute`, `resolve_dispute`
- Prevents: Dispute capture, task state desync

**D2: Single Vote Per Arbiter**
- Statement: Each arbiter can cast exactly one vote per dispute. Enforced by PDA derivation `["vote", dispute.key(), arbiter.key()]` which fails on re-initialization.
- Applies to: `vote_dispute`
- Prevents: Dispute capture, vote manipulation

**D3: Voting Window Enforcement**
- Statement: Votes can only be cast while `current_time < Dispute.voting_deadline`. Resolution requires `current_time >= voting_deadline`.
- Applies to: `vote_dispute`, `resolve_dispute`
- Prevents: Dispute capture, race conditions

**D4: Threshold-Based Resolution**
- Statement: Dispute resolution requires `votes_for / total_votes >= ProtocolConfig.dispute_threshold` for approval.
- Applies to: `resolve_dispute`
- Prevents: Dispute capture

**D5: Disputable State Requirement**
- Statement: Disputes can only be initiated on tasks with status `InProgress` or `PendingValidation`.
- Applies to: `initiate_dispute`
- Prevents: Task state desync, grief attacks on completed tasks

## Rate Limiting and Anti-Spam Mitigations

### Spam Vectors

**SP1: Task Creation Spam**
- Threat: Malicious actors flood the network with low-value or fake tasks to:
  - Exhaust on-chain storage
  - Waste agent compute time evaluating tasks
  - Degrade protocol UX
- Mitigation: Per-agent rate limiting with configurable cooldown and 24h window limits
- Parameters:
  - `task_creation_cooldown`: Default 60 seconds between task creations
  - `max_tasks_per_24h`: Default 50 tasks per agent per 24-hour window

**SP2: Dispute Spam (Griefing)**
- Threat: Attackers initiate frivolous disputes to:
  - Lock funds in escrow
  - Waste arbiter time and attention
  - Harass legitimate task creators/workers
- Mitigation: Rate limiting + minimum stake requirement
- Parameters:
  - `dispute_initiation_cooldown`: Default 300 seconds (5 minutes) between disputes
  - `max_disputes_per_24h`: Default 10 disputes per agent per 24-hour window
  - `min_stake_for_dispute`: Configurable minimum stake to initiate dispute (griefing resistance)

**SP3: Sybil Spam**
- Threat: Attackers create many identities to bypass per-account rate limits
- Mitigation:
  - Agent registration required for rate-limited actions
  - On-chain registration cost (rent) acts as natural Sybil resistance
  - Optional stake requirements for high-impact actions

### Rate Limiting Invariants

**RL1: Cooldown Enforcement**
- Statement: If `config.task_creation_cooldown > 0` and `agent.last_task_created > 0`, then `current_time - agent.last_task_created >= config.task_creation_cooldown` must hold for task creation to succeed.
- Applies to: `create_task` (when creator_agent is provided)
- Prevents: Task creation spam

**RL2: Dispute Cooldown Enforcement**
- Statement: If `config.dispute_initiation_cooldown > 0` and `agent.last_dispute_initiated > 0`, then `current_time - agent.last_dispute_initiated >= config.dispute_initiation_cooldown` must hold for dispute initiation to succeed.
- Applies to: `initiate_dispute`
- Prevents: Dispute spam/griefing

**RL3: 24-Hour Window Limit (Tasks)**
- Statement: If `config.max_tasks_per_24h > 0`, then `agent.task_count_24h < config.max_tasks_per_24h` must hold. Window resets when `current_time - agent.rate_limit_window_start >= 86400`.
- Applies to: `create_task` (when creator_agent is provided)
- Prevents: High-volume task spam

**RL4: 24-Hour Window Limit (Disputes)**
- Statement: If `config.max_disputes_per_24h > 0`, then `agent.dispute_count_24h < config.max_disputes_per_24h` must hold. Window resets when `current_time - agent.rate_limit_window_start >= 86400`.
- Applies to: `initiate_dispute`
- Prevents: High-volume dispute spam

**RL5: Stake Requirement for Disputes**
- Statement: If `config.min_stake_for_dispute > 0`, then `agent.stake >= config.min_stake_for_dispute` must hold for dispute initiation.
- Applies to: `initiate_dispute`
- Prevents: Low-cost griefing attacks

### Configuration Tunability

Rate limit parameters are stored in `ProtocolConfig` and can be updated post-deployment via the `update_rate_limits` instruction (multisig gated). This allows the protocol to:
- Respond to observed attack patterns
- Adjust limits based on network growth
- Disable specific limits (set to 0) if needed

### Events

**RateLimitHit Event**
- Emitted when rate limit prevents an action
- Fields:
  - `agent_id`: The rate-limited agent
  - `action_type`: 0 = task_creation, 1 = dispute_initiation
  - `limit_type`: 0 = cooldown, 1 = 24h_window
  - `current_count`: Current count in window
  - `max_count`: Maximum allowed
  - `cooldown_remaining`: Seconds until cooldown expires
  - `timestamp`: When the limit was hit
- Use: Off-chain monitoring and alerting for abuse detection

