# Internal Security Review Checklist

**Protocol:** AgenC Coordination Protocol
**Review Date:** ____________
**Reviewer(s):** ____________
**Code Commit:** ____________

This document provides a structured checklist for internal security review prior to external audit.

---

## 1. Instruction Review Checklist

### 1.1 initialize_protocol

**Location:** `programs/agenc-coordination/src/instructions/initialize_protocol.rs`

**Description:** One-time protocol setup with multisig configuration

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | authority must sign; multisig owners in remaining_accounts |
| Account ownership validated | [ ] | protocol_config is init with seeds |
| PDA seeds match expected derivation | [ ] | Seeds: `["protocol"]` |
| No arithmetic overflow possible | [ ] | Check multisig_owners_len cast to u8 |
| State transitions are valid | [ ] | N/A (initialization only) |
| Error handling is complete | [ ] | InvalidDisputeThreshold, InvalidProtocolFee, MultisigInvalidSigners, MultisigInvalidThreshold, MultisigDefaultSigner, MultisigDuplicateSigner |
| No unchecked CPI calls | [ ] | No CPI in this instruction |
| Multisig threshold validation | [ ] | threshold > 0 && threshold <= owners.len() |

**Critical Checks:**
- [ ] Cannot be called twice (PDA already exists error)
- [ ] dispute_threshold bounds: 1-100
- [ ] protocol_fee_bps max: 1000 (10%)
- [ ] Duplicate owner detection works correctly

---

### 1.2 update_protocol_fee

**Location:** `programs/agenc-coordination/src/instructions/update_protocol_fee.rs`

**Description:** Modify protocol fee (multisig gated)

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | Requires multisig threshold |
| Account ownership validated | [ ] | protocol_config has_one = authority? |
| PDA seeds match expected derivation | [ ] | Seeds: `["protocol"]` |
| No arithmetic overflow possible | [ ] | protocol_fee_bps is u16, max 1000 |
| State transitions are valid | [ ] | N/A |
| Error handling is complete | [ ] | InvalidProtocolFee |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Multisig signature validation via require_multisig
- [ ] Fee bounds check: protocol_fee_bps <= 1000

---

### 1.3 register_agent

**Location:** `programs/agenc-coordination/src/instructions/register_agent.rs`

**Description:** Register new agent with capabilities and endpoint

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | authority must sign |
| Account ownership validated | [ ] | agent PDA init with seeds |
| PDA seeds match expected derivation | [ ] | Seeds: `["agent", agent_id]` |
| No arithmetic overflow possible | [ ] | Check reputation initialization |
| State transitions are valid | [ ] | New agent starts as Inactive or Active |
| Error handling is complete | [ ] | Endpoint/metadata length checks |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] agent_id collision handling (PDA uniqueness)
- [ ] String length bounds: endpoint <= 128, metadata_uri <= 128
- [ ] Initial reputation = 5000 (per invariant R2)
- [ ] protocol_config.total_agents incremented

---

### 1.4 update_agent

**Location:** `programs/agenc-coordination/src/instructions/update_agent.rs`

**Description:** Modify agent capabilities, endpoint, metadata, or status

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | has_one = authority |
| Account ownership validated | [ ] | Agent authority check |
| PDA seeds match expected derivation | [ ] | Seeds: `["agent", agent_id]` |
| No arithmetic overflow possible | [ ] | N/A |
| State transitions are valid | [ ] | Status changes valid |
| Error handling is complete | [ ] | |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Only agent authority can update (invariant A1)
- [ ] Cannot update another agent's registration

---

### 1.5 deregister_agent

**Location:** `programs/agenc-coordination/src/instructions/deregister_agent.rs`

**Description:** Remove agent registration, reclaim rent

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | has_one = authority |
| Account ownership validated | [ ] | Agent authority check |
| PDA seeds match expected derivation | [ ] | Seeds: `["agent", agent_id]` |
| No arithmetic overflow possible | [ ] | N/A |
| State transitions are valid | [ ] | Account closed |
| Error handling is complete | [ ] | ActiveTasksRemaining |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Cannot deregister with active_tasks > 0 (invariant S2)
- [ ] Rent properly returned to authority
- [ ] protocol_config.total_agents decremented

---

### 1.6 create_task

**Location:** `programs/agenc-coordination/src/instructions/create_task.rs`

**Description:** Create task with escrow funding

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | creator must sign |
| Account ownership validated | [ ] | Task and escrow PDAs init |
| PDA seeds match expected derivation | [ ] | Task: `["task", creator, task_id]`, Escrow: `["escrow", task]` |
| No arithmetic overflow possible | [ ] | reward_amount transfer |
| State transitions are valid | [ ] | Task starts as Open |
| Error handling is complete | [ ] | |
| No unchecked CPI calls | [ ] | Check SOL transfer |

**Critical Checks:**
- [ ] Escrow receives exact reward_amount (invariant E1)
- [ ] TaskEscrow.amount = reward_amount
- [ ] TaskEscrow.distributed = 0
- [ ] TaskEscrow.is_closed = false
- [ ] protocol_config.total_tasks incremented

---

### 1.7 claim_task

**Location:** `programs/agenc-coordination/src/instructions/claim_task.rs`

**Description:** Agent claims task to work on it

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | worker authority must sign |
| Account ownership validated | [ ] | TaskClaim PDA init |
| PDA seeds match expected derivation | [ ] | Seeds: `["claim", task, worker_agent]` |
| No arithmetic overflow possible | [ ] | current_workers increment |
| State transitions are valid | [ ] | Open -> InProgress (T1) |
| Error handling is complete | [ ] | TaskNotClaimable, CapabilityMismatch, MaxWorkersReached, DeadlinePassed |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Worker has required capabilities
- [ ] current_workers < max_workers before claim (invariant T3)
- [ ] Deadline not passed (invariant T5)
- [ ] Task status is Open
- [ ] Cannot claim own task (if applicable)
- [ ] agent.active_tasks incremented

---

### 1.8 complete_task

**Location:** `programs/agenc-coordination/src/instructions/complete_task.rs`

**Description:** Submit proof and receive reward

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | worker authority must sign |
| Account ownership validated | [ ] | TaskClaim ownership |
| PDA seeds match expected derivation | [ ] | Claim: `["claim", task, worker]` |
| No arithmetic overflow possible | [ ] | Reward calculation, fee deduction |
| State transitions are valid | [ ] | InProgress -> Completed (T1, T2) |
| Error handling is complete | [ ] | TaskNotInProgress, ClaimNotFound, AlreadyCompleted |
| No unchecked CPI calls | [ ] | Check lamport transfer |

**Critical Checks:**
- [ ] TaskClaim.is_completed = false before execution
- [ ] Reward = (TaskEscrow.amount - distributed) / remaining_workers (or similar)
- [ ] Protocol fee calculated correctly: fee = reward * protocol_fee_bps / 10000
- [ ] TaskEscrow.distributed += reward_paid (invariant E2, E3)
- [ ] TaskEscrow.distributed <= TaskEscrow.amount (invariant E3)
- [ ] Reputation increased by 100, capped at 10000 (invariant R1, R3)
- [ ] TaskClaim.is_completed = true (invariant R4)
- [ ] agent.active_tasks decremented
- [ ] agent.tasks_completed incremented
- [ ] agent.total_earned updated

---

### 1.9 cancel_task

**Location:** `programs/agenc-coordination/src/instructions/cancel_task.rs`

**Description:** Creator cancels task, reclaim escrow

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | has_one = creator |
| Account ownership validated | [ ] | Task creator check |
| PDA seeds match expected derivation | [ ] | Task and Escrow PDAs |
| No arithmetic overflow possible | [ ] | Refund calculation |
| State transitions are valid | [ ] | Open/InProgress -> Cancelled (T1, T2) |
| Error handling is complete | [ ] | TaskNotCancellable, CompletionsExist |
| No unchecked CPI calls | [ ] | Check lamport transfer |

**Critical Checks:**
- [ ] Only creator can cancel (invariant A2)
- [ ] Cannot cancel if completions > 0 (or handle partial refund)
- [ ] Refund = TaskEscrow.amount - TaskEscrow.distributed
- [ ] TaskEscrow.is_closed = true after cancel (invariant E4)
- [ ] Task.status = Cancelled (terminal state, invariant T2)

---

### 1.10 update_state

**Location:** `programs/agenc-coordination/src/instructions/update_state.rs`

**Description:** Update shared coordination state with optimistic locking

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | Agent must sign |
| Account ownership validated | [ ] | CoordinationState PDA |
| PDA seeds match expected derivation | [ ] | Seeds: `["state", state_key]` |
| No arithmetic overflow possible | [ ] | Version increment |
| State transitions are valid | [ ] | Version check |
| Error handling is complete | [ ] | VersionMismatch |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Optimistic lock: expected_version == current_version
- [ ] Version incremented after update
- [ ] last_updater set to signer

---

### 1.11 initiate_dispute

**Location:** `programs/agenc-coordination/src/instructions/initiate_dispute.rs`

**Description:** Open dispute on in-progress task

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | Initiator must sign |
| Account ownership validated | [ ] | Dispute PDA init |
| PDA seeds match expected derivation | [ ] | Seeds: `["dispute", dispute_id]` |
| No arithmetic overflow possible | [ ] | voting_deadline calculation |
| State transitions are valid | [ ] | Task: InProgress -> Disputed (T1, D5) |
| Error handling is complete | [ ] | TaskNotDisputable |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Task status must be InProgress or PendingValidation (invariant D5)
- [ ] Dispute.status = Active
- [ ] voting_deadline set correctly
- [ ] Task.status = Disputed

---

### 1.12 vote_dispute

**Location:** `programs/agenc-coordination/src/instructions/vote_dispute.rs`

**Description:** Arbiter casts vote on dispute

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | Arbiter must sign |
| Account ownership validated | [ ] | DisputeVote PDA init |
| PDA seeds match expected derivation | [ ] | Seeds: `["vote", dispute, voter]` |
| No arithmetic overflow possible | [ ] | Vote count increment |
| State transitions are valid | [ ] | Dispute still Active |
| Error handling is complete | [ ] | NotArbiter, VotingClosed, AlreadyVoted |
| No unchecked CPI calls | [ ] | No CPI |

**Critical Checks:**
- [ ] Voter has ARBITER capability (invariant A4)
- [ ] Voter stake >= min_arbiter_stake (invariant S1)
- [ ] Dispute.status == Active
- [ ] current_time < voting_deadline (invariant D3)
- [ ] DisputeVote PDA prevents double voting (invariant D2)
- [ ] votes_for or votes_against incremented correctly

---

### 1.13 resolve_dispute

**Location:** `programs/agenc-coordination/src/instructions/resolve_dispute.rs`

**Description:** Execute dispute resolution after voting

| Check | Status | Notes |
|-------|:------:|-------|
| All signers verified correctly | [ ] | Anyone can call after deadline |
| Account ownership validated | [ ] | Dispute, Task, Escrow |
| PDA seeds match expected derivation | [ ] | All related PDAs |
| No arithmetic overflow possible | [ ] | Threshold calculation, fund distribution |
| State transitions are valid | [ ] | Dispute: Active -> Resolved (D1) |
| Error handling is complete | [ ] | VotingNotEnded, NoQuorum |
| No unchecked CPI calls | [ ] | Check lamport transfers |

**Critical Checks:**
- [ ] current_time >= voting_deadline (invariant D3)
- [ ] Threshold check: votes_for * 100 / total_votes >= dispute_threshold (invariant D4)
- [ ] Resolution actions based on resolution_type:
  - Refund: Return escrow to creator
  - Complete: Pay worker(s)
  - Split: Divide between parties
- [ ] TaskEscrow.is_closed = true after resolution (invariant E4)
- [ ] Dispute.status = Resolved (invariant D1)
- [ ] Task.status updated based on outcome

---

## 2. State Account Review

### 2.1 ProtocolConfig

**Location:** `programs/agenc-coordination/src/state.rs:76-145`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | authority: Pubkey, treasury: Pubkey, dispute_threshold: u8, protocol_fee_bps: u16, etc. |
| Space calculation is correct | [ ] | SIZE = 265 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default impl provided |

**Field-by-Field Review:**
- [ ] `authority` (Pubkey, 32 bytes)
- [ ] `treasury` (Pubkey, 32 bytes)
- [ ] `dispute_threshold` (u8, 1 byte) - range 1-100
- [ ] `protocol_fee_bps` (u16, 2 bytes) - range 0-1000
- [ ] `min_arbiter_stake` (u64, 8 bytes)
- [ ] `total_agents` (u64, 8 bytes)
- [ ] `total_tasks` (u64, 8 bytes)
- [ ] `completed_tasks` (u64, 8 bytes)
- [ ] `total_value_distributed` (u64, 8 bytes)
- [ ] `bump` (u8, 1 byte)
- [ ] `multisig_threshold` (u8, 1 byte)
- [ ] `multisig_owners_len` (u8, 1 byte)
- [ ] `_padding` ([u8; 6], 6 bytes)
- [ ] `multisig_owners` ([Pubkey; 5], 160 bytes)

---

### 2.2 AgentRegistration

**Location:** `programs/agenc-coordination/src/state.rs:147-201`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 413 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default derive |

**Field-by-Field Review:**
- [ ] `agent_id` ([u8; 32], 32 bytes)
- [ ] `authority` (Pubkey, 32 bytes)
- [ ] `capabilities` (u64, 8 bytes) - bitmask
- [ ] `status` (AgentStatus, 1 byte)
- [ ] `endpoint` (String, 4+128 bytes)
- [ ] `metadata_uri` (String, 4+128 bytes)
- [ ] `registered_at` (i64, 8 bytes)
- [ ] `last_active` (i64, 8 bytes)
- [ ] `tasks_completed` (u64, 8 bytes)
- [ ] `total_earned` (u64, 8 bytes)
- [ ] `reputation` (u16, 2 bytes) - range 0-10000
- [ ] `active_tasks` (u8, 1 byte)
- [ ] `stake` (u64, 8 bytes)
- [ ] `bump` (u8, 1 byte)
- [ ] `_reserved` ([u8; 32], 32 bytes)

---

### 2.3 Task

**Location:** `programs/agenc-coordination/src/state.rs:203-290`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 303 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default impl provided |

**Field-by-Field Review:**
- [ ] `task_id` ([u8; 32], 32 bytes)
- [ ] `creator` (Pubkey, 32 bytes)
- [ ] `required_capabilities` (u64, 8 bytes)
- [ ] `description` ([u8; 64], 64 bytes)
- [ ] `reward_amount` (u64, 8 bytes)
- [ ] `max_workers` (u8, 1 byte)
- [ ] `current_workers` (u8, 1 byte)
- [ ] `status` (TaskStatus, 1 byte)
- [ ] `task_type` (TaskType, 1 byte)
- [ ] `created_at` (i64, 8 bytes)
- [ ] `deadline` (i64, 8 bytes)
- [ ] `completed_at` (i64, 8 bytes)
- [ ] `escrow` (Pubkey, 32 bytes)
- [ ] `result` ([u8; 64], 64 bytes)
- [ ] `completions` (u8, 1 byte)
- [ ] `required_completions` (u8, 1 byte)
- [ ] `bump` (u8, 1 byte)
- [ ] `_reserved` ([u8; 32], 32 bytes)

---

### 2.4 TaskClaim

**Location:** `programs/agenc-coordination/src/state.rs:292-347`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 195 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default impl provided |

---

### 2.5 TaskEscrow

**Location:** `programs/agenc-coordination/src/state.rs:466-490`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 58 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default derive |

**Critical Fields:**
- [ ] `task` (Pubkey) - must match associated task
- [ ] `amount` (u64) - initial deposit, immutable after creation
- [ ] `distributed` (u64) - monotonically increasing
- [ ] `is_closed` (bool) - terminal flag

---

### 2.6 CoordinationState

**Location:** `programs/agenc-coordination/src/state.rs:349-388`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 153 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default impl provided |

---

### 2.7 Dispute

**Location:** `programs/agenc-coordination/src/state.rs:390-438`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 158 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default derive |

---

### 2.8 DisputeVote

**Location:** `programs/agenc-coordination/src/state.rs:440-464`

| Check | Status | Notes |
|-------|:------:|-------|
| All fields have appropriate types | [ ] | |
| Space calculation is correct | [ ] | SIZE = 82 bytes (verify) |
| Discriminator handled properly | [ ] | 8-byte Anchor discriminator |
| No uninitialized reads possible | [ ] | Default derive |

---

## 3. Authority Matrix

| Instruction | Required Signers | Can Modify | Risk Level |
|-------------|------------------|------------|:----------:|
| `initialize_protocol` | Initial authority + multisig owners | ProtocolConfig | Critical |
| `update_protocol_fee` | Multisig threshold | ProtocolConfig.protocol_fee_bps | High |
| `register_agent` | Agent authority | AgentRegistration (new), ProtocolConfig.total_agents | Low |
| `update_agent` | Agent authority (has_one) | AgentRegistration | Low |
| `deregister_agent` | Agent authority (has_one) | AgentRegistration (close), ProtocolConfig.total_agents | Low |
| `create_task` | Task creator | Task (new), TaskEscrow (new), ProtocolConfig.total_tasks | Medium |
| `claim_task` | Worker authority | Task, TaskClaim (new), AgentRegistration | Medium |
| `complete_task` | Worker authority | Task, TaskClaim, TaskEscrow, AgentRegistration | Critical |
| `cancel_task` | Task creator (has_one) | Task, TaskEscrow | High |
| `update_state` | Any agent | CoordinationState | Low |
| `initiate_dispute` | Dispute initiator | Dispute (new), Task | High |
| `vote_dispute` | Arbiter (capability + stake) | Dispute, DisputeVote (new) | Medium |
| `resolve_dispute` | Anyone (permissionless after deadline) | Dispute, Task, TaskEscrow | Critical |

---

## 4. C Library Review

**Files:**
- `src/communication/solana/src/solana_comm.c`
- `src/communication/solana/src/agenc_solana.c`
- `src/communication/solana/src/solana_rpc.c`
- `src/communication/solana/src/solana_status.c`
- `src/communication/solana/src/solana_utils.c`

### 4.1 Memory Safety

| Check | Status | Notes |
|-------|:------:|-------|
| No buffer overflows | [ ] | Review all memcpy, strcpy, strncpy |
| Bounds checking on arrays | [ ] | Check queue operations, fixed-size buffers |
| No use-after-free | [ ] | Review destroy functions |
| No double-free | [ ] | Check cleanup paths |
| Memory properly freed | [ ] | All malloc/calloc have corresponding free |
| No memory leaks | [ ] | Check error paths |

### 4.2 Specific Concerns

**solana_comm.c:**
- [ ] `impl_send_message`: payload malloc at line 247, freed in destroy?
- [ ] `impl_receive_message`: ownership transfer at line 285, caller must free
- [ ] Queue wraparound: lines 237-258, verify atomic operations are correct
- [ ] `solana_comm_destroy`: lines 196-206, iterates queue to free payloads

**agenc_solana.c:**
- [ ] `agenc_agent_create`: Multiple allocation paths, all freed on error?
- [ ] Lines 108-109: Pointer stored in reserved bytes - very fragile, 16-bit truncation on 64-bit systems
- [ ] `agenc_generate_task_id`/`agenc_generate_agent_id`: Uses rand(), NOT cryptographically secure
- [ ] `strncpy` at line 206: null termination ensured?

### 4.3 Error Handling

| Check | Status | Notes |
|-------|:------:|-------|
| All error codes checked | [ ] | Review all function calls |
| Errors propagated correctly | [ ] | No silent failures |
| Resources cleaned up on error | [ ] | Check early return paths |

### 4.4 Security

| Check | Status | Notes |
|-------|:------:|-------|
| No hardcoded secrets | [ ] | No API keys, private keys |
| No sensitive data in logs | [ ] | Review printf/logging |
| Secure random generation | [ ] | rand() is NOT secure, document risk |
| Input validation | [ ] | NULL checks, bounds checks |

### 4.5 Thread Safety

| Check | Status | Notes |
|-------|:------:|-------|
| Atomic operations correct | [ ] | Queue head/tail/count |
| No data races | [ ] | Review shared state access |
| Lock ordering (if mutexes used) | [ ] | N/A if atomic-only |

---

## 5. Known Issues Log

Use this section to track findings during internal review.

### Issue Template

```
### ISSUE-XXX: [Title]

**Severity:** Critical / High / Medium / Low / Info
**Location:** [file:line]
**Status:** Open / In Progress / Fixed / Won't Fix

**Description:**
[Describe the issue]

**Impact:**
[What could go wrong]

**Recommendation:**
[How to fix]

**Notes:**
[Additional context]
```

---

### ISSUE-001: [Example - Remove after use]

**Severity:** Medium
**Location:** `src/communication/solana/src/agenc_solana.c:108-109`
**Status:** Open

**Description:**
Internal pointer stored in 2 bytes of reserved space, causing truncation on 64-bit systems.

**Impact:**
Memory corruption, crashes on 64-bit platforms.

**Recommendation:**
Store pointer in a proper field or use a separate lookup table.

**Notes:**
```c
agent->registration._reserved[0] = (uint8_t)((uintptr_t)internal & 0xFF);
agent->registration._reserved[1] = (uint8_t)(((uintptr_t)internal >> 8) & 0xFF);
```
This only captures 16 bits of a 64-bit pointer.

---

### ISSUE-002: Insecure Random Number Generation

**Severity:** Medium
**Location:** `src/communication/solana/src/agenc_solana.c:639-650`
**Status:** Open

**Description:**
`agenc_generate_task_id` and `agenc_generate_agent_id` use `rand()` seeded with `time(NULL)`.

**Impact:**
Predictable IDs could lead to front-running or collision attacks.

**Recommendation:**
Use platform-specific CSPRNG (e.g., `getrandom()` on Linux, `BCryptGenRandom` on Windows).

---

## 6. Review Sign-Off

| Reviewer | Date | Sections Reviewed | Signature |
|----------|------|-------------------|-----------|
| | | | |
| | | | |

---

## Appendix: Invariant Cross-Reference

Map each invariant from `docs/audit/THREAT_MODEL.md` to the instructions that must enforce it:

| Invariant | Instructions | Verified |
|-----------|--------------|:--------:|
| E1: Escrow Balance Conservation | create_task, complete_task, cancel_task, resolve_dispute | [ ] |
| E2: Monotonic Distribution | complete_task, resolve_dispute | [ ] |
| E3: Distribution Bounded | complete_task, resolve_dispute | [ ] |
| E4: Single Closure | complete_task, cancel_task, resolve_dispute | [ ] |
| E5: Escrow-Task Binding | create_task, complete_task, cancel_task, resolve_dispute | [ ] |
| T1: Valid State Transitions | claim_task, complete_task, cancel_task, initiate_dispute, resolve_dispute | [ ] |
| T2: Terminal State Immutability | all task-modifying instructions | [ ] |
| T3: Worker Count Consistency | claim_task | [ ] |
| T4: Completion Count Bounded | complete_task | [ ] |
| T5: Deadline Enforcement | claim_task | [ ] |
| R1: Reputation Bounds | register_agent, complete_task | [ ] |
| R2: Initial Reputation | register_agent | [ ] |
| R3: Reputation Increment Rules | complete_task | [ ] |
| R4: Single Application Per Completion | complete_task | [ ] |
| S1: Arbiter Stake Threshold | vote_dispute | [ ] |
| S2: Active Task Obligation | deregister_agent | [ ] |
| S3: Stake Non-Negative | (type enforcement) | [ ] |
| A1: Agent Self-Sovereignty | update_agent, deregister_agent | [ ] |
| A2: Task Creator Exclusivity | cancel_task | [ ] |
| A3: Worker Claim Binding | claim_task, complete_task | [ ] |
| A4: Arbiter Capability Requirement | vote_dispute | [ ] |
| A5: Protocol Authority Exclusivity | initialize_protocol, update_protocol_fee | [ ] |
| D1: Dispute State Machine | initiate_dispute, vote_dispute, resolve_dispute | [ ] |
| D2: Single Vote Per Arbiter | vote_dispute | [ ] |
| D3: Voting Window Enforcement | vote_dispute, resolve_dispute | [ ] |
| D4: Threshold-Based Resolution | resolve_dispute | [ ] |
| D5: Disputable State Requirement | initiate_dispute | [ ] |

---

*Document Version: 1.0*
*Last Updated: [DATE]*
