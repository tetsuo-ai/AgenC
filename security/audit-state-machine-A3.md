# Security Audit Report: State Machine Integrity (Stream A3)

**Date:** 2025-06-28  
**Auditor:** Automated Security Audit  
**Scope:** State transitions and lifecycle vulnerabilities in AgenC Coordination Protocol

---

## Executive Summary

This audit examined the state machine integrity of the AgenC Coordination Protocol, focusing on:
- Task lifecycle transitions (TaskStatus)
- Dispute lifecycle transitions (DisputeStatus)  
- Agent lifecycle transitions (AgentStatus)
- Counter consistency (active_tasks, active_dispute_votes)
- Deadline enforcement

**Findings:** 3 HIGH, 2 MEDIUM, 1 LOW severity issues identified.

---

## State Machine Mapping

### TaskStatus State Machine

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌──────┐  claim   ┌────────────┐  complete  ┌───────────┐│
│ Open │─────────►│ InProgress │───────────►│ Completed ││
└──────┘          └────────────┘            └───────────┘│
    │                   │                                │
    │                   │ initiate_dispute               │
    │                   ▼                                │
    │              ┌──────────┐                          │
    │              │ Disputed │─────────────────────────►│
    │              └──────────┘  resolve (Complete)      │
    │                   │                                │
    │ cancel            │ expire_dispute / resolve       │
    │                   ▼                                │
    │              ┌───────────┐                         │
    └─────────────►│ Cancelled │◄────────────────────────┘
                   └───────────┘
```

**Valid Transitions Found:**
| From | To | Instruction |
|------|------|-------------|
| - | Open | create_task, create_dependent_task |
| Open | InProgress | claim_task |
| InProgress | InProgress | claim_task (additional workers) |
| InProgress | Completed | complete_task, complete_task_private |
| InProgress | Disputed | initiate_dispute |
| InProgress | Open | expire_claim (when workers = 0) |
| Open | Cancelled | cancel_task |
| InProgress | Cancelled | cancel_task (deadline passed) |
| Disputed | Cancelled | resolve_dispute (Refund/Split/rejected), expire_dispute |
| Disputed | Completed | resolve_dispute (Complete approved) |

### DisputeStatus State Machine

```
┌────────┐  resolve  ┌──────────┐
│ Active │──────────►│ Resolved │
└────────┘           └──────────┘
    │
    │ expire
    ▼
┌─────────┐
│ Expired │
└─────────┘
```

**Valid Transitions Found:**
| From | To | Instruction |
|------|------|-------------|
| - | Active | initiate_dispute |
| Active | Resolved | resolve_dispute |
| Active | Expired | expire_dispute |

### AgentStatus State Machine

```
┌──────────┐  register  ┌────────┐  update   ┌──────────┐
│    -     │───────────►│ Active │◄─────────►│ Inactive │
└──────────┘            └────────┘           └──────────┘
                            │                     ▲
                            │ update              │ update
                            ▼                     │
                        ┌──────┐                  │
                        │ Busy │──────────────────┘
                        └──────┘
                            
                        ┌───────────┐
    protocol authority  │ Suspended │ (can only be set/cleared by authority)
                        └───────────┘
```

**Valid Transitions Found:**
| From | To | Instruction |
|------|------|-------------|
| - | Active | register_agent |
| Any (except Suspended) | Any | update_agent (self) |
| Any | Suspended | update_agent (authority only) |
| Any | Deregistered | deregister_agent (closes account) |

---

## Findings

### HIGH Severity

#### H-01: Broken Initiator Slash Validation
**Issue:** [#325](https://github.com/tetsuo-ai/AgenC/issues/325)  
**Location:** `apply_initiator_slash.rs:35-38`

The validation `initiator_agent.authority == dispute.initiator` compares a wallet pubkey to an agent PDA pubkey, which can never match. This makes initiator slashing completely non-functional.

**Impact:** Economic griefing attacks possible - malicious actors can spam frivolous disputes with no penalty.

---

#### H-02: Worker active_tasks Not Decremented on Task Cancel
**Issue:** [#327](https://github.com/tetsuo-ai/AgenC/issues/327)  
**Location:** `cancel_task.rs`

When a task is cancelled while workers have active claims (InProgress → Cancelled), worker `active_tasks` counters are not decremented.

**Impact:** Workers permanently blocked from claiming new tasks or deregistering. DoS attack vector.

---

#### H-03: Arbiter active_dispute_votes Not Decremented on Dispute Expire
**Issue:** [#328](https://github.com/tetsuo-ai/AgenC/issues/328)  
**Location:** `expire_dispute.rs`

When a dispute expires (rather than being resolved), arbiter `active_dispute_votes` counters are not decremented.

**Impact:** Arbiters who voted on expired disputes cannot deregister or recover stake. DoS attack vector.

---

### MEDIUM Severity

#### M-01: PendingValidation is Dead State
**Location:** `state.rs:47`, `initiate_dispute.rs:81`

The `TaskStatus::PendingValidation` enum variant is defined and checked in `initiate_dispute`, but **no instruction ever sets this state**. Tasks can never reach this state.

**Impact:** 
- Dead code / potential confusion
- `initiate_dispute` accepts PendingValidation tasks but none exist
- Future code changes may incorrectly assume this state is used

**Recommendation:** Either:
1. Remove `PendingValidation` from the enum and update `initiate_dispute`
2. Implement the validation flow that uses this state

---

#### M-02: Competitive Task Race Condition Window
**Location:** `complete_task.rs`, `complete_task_private.rs`

For competitive tasks, the check `task.completions == 0` happens at instruction start, but multiple transactions checking simultaneously could theoretically both pass before either commits.

While Solana's single-threaded execution per account prevents true races, the ordering of transactions in a block is not guaranteed. Two workers submitting completion in the same slot could both see `completions == 0` at validation time.

**Actual Risk:** LOW - Solana's account locking prevents this in practice, but the pattern is worth noting.

**Impact:** Theoretical edge case where two workers both believe they're the winner.

---

### LOW Severity

#### L-01: Inconsistent initiator Field Usage
**Location:** `initiate_dispute.rs:127`, `apply_initiator_slash.rs:35`

The `dispute.initiator` field stores the agent PDA key (`agent.key()`), but the naming suggests it might be the initiating authority. This inconsistency led to bug H-01.

**Recommendation:** Add documentation clarifying that `initiator` is the AgentRegistration PDA, not the authority wallet:

```rust
/// Agent who initiated the dispute (AgentRegistration PDA, not authority wallet)
pub initiator: Pubkey,
```

---

### INFORMATIONAL

#### I-01: AgentStatus::Busy Never Set Programmatically
The `Busy` status exists but is only settable via manual `update_agent` calls. No instruction automatically sets an agent to Busy. This may be intentional for future use.

#### I-02: Comprehensive State Checks Present
The codebase generally has good state validation:
- `claim_task` correctly checks `Open || InProgress`
- `complete_task` correctly requires `InProgress`
- `initiate_dispute` correctly requires `InProgress || PendingValidation`
- `expire_claim` correctly prevents reopening non-InProgress tasks (zombie task fix)

#### I-03: Deadline Enforcement Consistent
All deadline-related instructions properly use `Clock::get()?.unix_timestamp` for comparisons. Deadline bypass is not possible.

---

## Counter Consistency Analysis

| Counter | Increment | Decrement | Issues |
|---------|-----------|-----------|--------|
| `active_tasks` | claim_task | complete_task, expire_claim, resolve_dispute, expire_dispute | **Missing: cancel_task** |
| `active_dispute_votes` | vote_dispute | resolve_dispute | **Missing: expire_dispute** |
| `task_count_24h` | create_task, create_dependent_task | (auto-reset after 24h) | ✓ OK |
| `dispute_count_24h` | initiate_dispute | (auto-reset after 24h) | ✓ OK |
| `total_agents` | register_agent | deregister_agent | ✓ OK |
| `total_tasks` | create_task, create_dependent_task | (never decremented) | ✓ OK (monotonic) |

---

## Recommendations Summary

1. **Immediate (Critical):**
   - Fix H-01: Change `initiator_agent.authority == dispute.initiator` to `initiator_agent.key() == dispute.initiator`
   - Fix H-02: Add worker account handling to `cancel_task` or restrict cancellation to Open tasks only
   - Fix H-03: Add arbiter vote counter decrement logic to `expire_dispute`

2. **Short-term:**
   - Address M-01: Remove or implement PendingValidation state
   - Add comprehensive unit tests for state transitions
   - Document intended state machine in code comments

3. **Long-term:**
   - Consider adding a state transition event log for auditability
   - Implement invariant assertions in tests (e.g., sum of all active_tasks across agents should match claims)

---

## Files Audited

- `programs/agenc-coordination/src/state.rs`
- `programs/agenc-coordination/src/instructions/claim_task.rs`
- `programs/agenc-coordination/src/instructions/complete_task.rs`
- `programs/agenc-coordination/src/instructions/complete_task_private.rs`
- `programs/agenc-coordination/src/instructions/cancel_task.rs`
- `programs/agenc-coordination/src/instructions/initiate_dispute.rs`
- `programs/agenc-coordination/src/instructions/resolve_dispute.rs`
- `programs/agenc-coordination/src/instructions/expire_dispute.rs`
- `programs/agenc-coordination/src/instructions/expire_claim.rs`
- `programs/agenc-coordination/src/instructions/vote_dispute.rs`
- `programs/agenc-coordination/src/instructions/register_agent.rs`
- `programs/agenc-coordination/src/instructions/deregister_agent.rs`
- `programs/agenc-coordination/src/instructions/update_agent.rs`
- `programs/agenc-coordination/src/instructions/apply_dispute_slash.rs`
- `programs/agenc-coordination/src/instructions/apply_initiator_slash.rs`
- `programs/agenc-coordination/src/instructions/create_task.rs`
- `programs/agenc-coordination/src/instructions/create_dependent_task.rs`
- `programs/agenc-coordination/src/instructions/completion_helpers.rs`
- `programs/agenc-coordination/src/errors.rs`
