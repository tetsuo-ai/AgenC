# Security Audit Report A5: Account Validation

**Auditor:** Clawdbot Security Team  
**Date:** 2025-01-21  
**Scope:** `programs/agenc-coordination/src/instructions/`  
**Focus:** PDA validation, account ownership, and constraint vulnerabilities

---

## Executive Summary

This audit examined 19 instruction files for account validation vulnerabilities. The codebase demonstrates strong security practices overall, with proper PDA derivation, owner checks on UncheckedAccounts, and defense-in-depth validation. However, **one HIGH severity issue** was identified that breaks initiator slashing functionality.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 2 |
| LOW | 1 |
| INFO | 3 |

---

## Findings

### HIGH-001: Broken Initiator Slashing - Wrong Field Comparison

**File:** `apply_initiator_slash.rs:30-33`  
**Severity:** HIGH  
**Status:** Open

#### Description

The initiator slashing validation compares incorrect fields, causing all initiator slash attempts to fail:

```rust
require!(
    initiator_agent.authority == dispute.initiator,
    CoordinationError::UnauthorizedAgent
);
```

In `initiate_dispute.rs`, the `dispute.initiator` is set to the **agent PDA key**:
```rust
dispute.initiator = agent.key();  // This is the AgentRegistration PDA
```

But `initiator_agent.authority` is the **wallet public key** that owns the agent.

These two values will never match because:
- `dispute.initiator` = PDA derived from `["agent", agent_id]`
- `initiator_agent.authority` = Signer's wallet pubkey

#### Impact

- Initiators can **never be slashed** for rejected frivolous disputes
- Economic disincentive for malicious dispute initiation is broken
- Attackers can grief the system with bogus disputes without financial consequences
- Undermines the dispute resolution game theory

#### Recommendation

Fix the comparison to use the correct field:

```rust
require!(
    initiator_agent.key() == dispute.initiator,
    CoordinationError::UnauthorizedAgent
);
```

---

### MEDIUM-001: Unrestricted Rent Recipient in expire_claim

**File:** `expire_claim.rs:25-26`  
**Severity:** MEDIUM  
**Status:** Open

#### Description

The `rent_recipient` account that receives lamports when a claim is closed is an UncheckedAccount with no validation:

```rust
/// CHECK: Receives rent from closed claim account
#[account(mut)]
pub rent_recipient: UncheckedAccount<'info>,
```

#### Impact

- Any caller can direct rent refund to any account
- While the amount is small (rent-exempt minimum ~0.002 SOL), this is unexpected behavior
- Could be used for minor value extraction from claims created by others
- Violates principle of least privilege

#### Recommendation

Restrict `rent_recipient` to the original claim creator (worker's authority):

```rust
/// Worker's authority receives rent refund
#[account(
    mut,
    constraint = rent_recipient.key() == worker.authority @ CoordinationError::InvalidRentRecipient
)]
pub rent_recipient: UncheckedAccount<'info>,
```

Alternatively, if the task creator should receive the rent:
```rust
constraint = rent_recipient.key() == task.creator @ CoordinationError::InvalidRentRecipient
```

---

### MEDIUM-002: Missing PDA Validation on parent_task

**File:** `create_dependent_task.rs:38-41`  
**Severity:** MEDIUM  
**Status:** Open

#### Description

The `parent_task` account is validated only with status constraints but lacks PDA seed verification:

```rust
/// The parent task this new task depends on
#[account(
    constraint = parent_task.status != TaskStatus::Cancelled @ CoordinationError::ParentTaskCancelled,
    constraint = parent_task.status != TaskStatus::Disputed @ CoordinationError::ParentTaskDisputed,
)]
pub parent_task: Account<'info, Task>,
```

#### Impact

- Any valid Task account can be passed as parent_task
- While Anchor's discriminator check ensures it's a Task, the specific task isn't cryptographically verified
- Potential for confusion or unexpected dependency chains
- Defense-in-depth principle suggests validating PDA derivation

#### Recommendation

Add explicit PDA validation or document the intentional design decision:

Option A - Add seeds validation (if parent task creator/id are instruction args):
```rust
#[account(
    seeds = [b"task", parent_creator.as_ref(), parent_task_id.as_ref()],
    bump = parent_task.bump,
    constraint = parent_task.status != TaskStatus::Cancelled @ ...,
)]
pub parent_task: Account<'info, Task>,
```

Option B - If any valid task should be allowed, add documentation:
```rust
/// The parent task this new task depends on
/// Note: Accepts any valid Task account by design - allows cross-creator dependencies
#[account(...)]
pub parent_task: Account<'info, Task>,
```

---

### LOW-001: Handler-Based Validation Instead of Constraint

**File:** `apply_dispute_slash.rs:42-45`  
**Severity:** LOW  
**Status:** Open

#### Description

The worker_agent to worker_claim relationship is validated in the handler rather than in account constraints:

```rust
// In handler, line 42:
require!(
    worker_agent.key() == ctx.accounts.worker_claim.worker,
    CoordinationError::UnauthorizedAgent
);
```

#### Impact

- Minor: Error occurs later in execution (more compute used before failing)
- Inconsistent with patterns used elsewhere in the codebase
- Harder to reason about invariants from account struct alone

#### Recommendation

Move validation to account constraints for consistency and earlier error detection:

```rust
#[account(
    mut,
    seeds = [b"agent", worker_agent.agent_id.as_ref()],
    bump = worker_agent.bump,
    constraint = worker_agent.key() == worker_claim.worker @ CoordinationError::UnauthorizedAgent
)]
pub worker_agent: Account<'info, AgentRegistration>,
```

---

### INFO-001: Proper UncheckedAccount Validation Pattern

**File:** Multiple files  
**Severity:** INFO (Positive Finding)

#### Description

The codebase demonstrates excellent patterns for validating UncheckedAccounts:

1. **Treasury validation** (`complete_task.rs`):
```rust
#[account(
    mut,
    constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
)]
pub treasury: UncheckedAccount<'info>,
```

2. **Worker authority validation** (`resolve_dispute.rs`):
```rust
// Owner check before deserialization
require!(
    worker.owner == &crate::ID,
    CoordinationError::InvalidAccountOwner
);
let worker_data = worker.try_borrow_data()?;
let worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
require!(
    worker_authority.key() == worker_reg.authority,
    CoordinationError::UnauthorizedAgent
);
```

3. **remaining_accounts validation** (`resolve_dispute.rs`):
```rust
require!(
    vote_info.owner == &crate::ID,
    CoordinationError::InvalidAccountOwner
);
require!(
    arbiter_info.owner == &crate::ID,
    CoordinationError::InvalidAccountOwner
);
```

#### Assessment

These patterns correctly prevent:
- Account substitution attacks
- Fake account injection
- Owner confusion attacks

---

### INFO-002: Proper Sybil Attack Prevention

**File:** `vote_dispute.rs`  
**Severity:** INFO (Positive Finding)

#### Description

The implementation correctly prevents Sybil attacks in dispute voting through dual-account tracking:

```rust
#[account(
    init,
    payer = authority,
    space = DisputeVote::SIZE,
    seeds = [b"vote", dispute.key().as_ref(), arbiter.key().as_ref()],
    bump
)]
pub vote: Account<'info, DisputeVote>,

/// Authority-level vote tracking to prevent Sybil attacks (fix #101)
#[account(
    init,
    payer = authority,
    space = AuthorityDisputeVote::SIZE,
    seeds = [b"authority_vote", dispute.key().as_ref(), authority.key().as_ref()],
    bump
)]
pub authority_vote: Account<'info, AuthorityDisputeVote>,
```

#### Assessment

This prevents an authority from voting multiple times via multiple agent accounts they control.

---

### INFO-003: Consistent PDA Seed Patterns

**File:** All instruction files  
**Severity:** INFO (Positive Finding)

#### Description

All PDA seeds match the documented patterns in `state.rs`:

| Account | Expected Seeds | Verified |
|---------|---------------|----------|
| agent | `["agent", agent_id]` | ✅ |
| task | `["task", creator, task_id]` | ✅ |
| escrow | `["escrow", task]` | ✅ |
| claim | `["claim", task, worker]` | ✅ |
| dispute | `["dispute", dispute_id]` | ✅ |
| vote | `["vote", dispute, voter]` | ✅ |
| authority_vote | `["authority_vote", dispute, authority]` | ✅ |
| state | `["state", state_key]` | ✅ |
| protocol | `["protocol"]` | ✅ |

#### Assessment

All bump seeds are correctly stored and validated, preventing bump manipulation attacks.

---

## Audit Checklist Results

| Check | Status | Notes |
|-------|--------|-------|
| Missing owner checks | ✅ PASS | All UncheckedAccounts validated |
| PDA seed confusion | ⚠️ PARTIAL | parent_task missing seeds |
| Bump manipulation | ✅ PASS | All bumps properly stored/validated |
| Account type confusion | ✅ PASS | Anchor discriminators protect |
| Missing constraints | ⚠️ PARTIAL | rent_recipient unvalidated |
| remaining_accounts | ✅ PASS | Owner checks before deserialize |

---

## Files Audited

| File | Lines | Issues |
|------|-------|--------|
| register_agent.rs | 91 | 0 |
| update_agent.rs | 80 | 0 |
| deregister_agent.rs | 62 | 0 |
| create_task.rs | 175 | 0 |
| claim_task.rs | 117 | 0 |
| complete_task.rs | 116 | 0 |
| complete_task_private.rs | 211 | 0 |
| cancel_task.rs | 70 | 0 |
| expire_claim.rs | 73 | 1 (MEDIUM) |
| initiate_dispute.rs | 181 | 0 |
| vote_dispute.rs | 111 | 0 |
| resolve_dispute.rs | 205 | 0 |
| expire_dispute.rs | 98 | 0 |
| apply_dispute_slash.rs | 95 | 1 (LOW) |
| apply_initiator_slash.rs | 75 | 1 (HIGH) |
| update_state.rs | 76 | 0 |
| initialize_protocol.rs | 103 | 0 |
| update_protocol_fee.rs | 24 | 0 |
| update_rate_limits.rs | 38 | 0 |
| migrate.rs | 121 | 0 |
| create_dependent_task.rs | 166 | 1 (MEDIUM) |
| completion_helpers.rs | 220 | 0 |

---

## Recommendations Summary

1. **CRITICAL ACTION:** Fix HIGH-001 immediately - initiator slashing is completely broken
2. **SHORT-TERM:** Address MEDIUM issues for defense-in-depth
3. **BEST PRACTICE:** Consider moving handler validations to constraints (LOW-001)

---

## Appendix: Validation Patterns Used

### Good Pattern: Constraint-based UncheckedAccount Validation
```rust
#[account(
    mut,
    constraint = account.key() == expected_key @ Error
)]
pub account: UncheckedAccount<'info>,
```

### Good Pattern: Handler-based Owner Check Before Deserialize
```rust
require!(account.owner == &crate::ID, Error);
let data = account.try_borrow_data()?;
let state = State::try_deserialize(&mut &**data)?;
```

### Good Pattern: PDA with Stored Bump Validation
```rust
#[account(
    mut,
    seeds = [b"seed", key.as_ref()],
    bump = account.bump
)]
pub account: Account<'info, State>,
```
