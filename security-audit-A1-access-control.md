# Security Audit A1: Access Control
**Focus:** Authorization and access control vulnerabilities
**Audited Files:** `programs/agenc-coordination/src/instructions/*`
**Date:** 2026-01-28
**Auditor:** Subagent audit-access-control

---

## Executive Summary

This audit reviewed all 19 instruction files in the AgenC Coordination Protocol for access control vulnerabilities. The codebase demonstrates generally strong authorization patterns with consistent use of Anchor's `has_one` constraints and multisig protection for admin functions.

**Findings Summary:**
- **CRITICAL:** 0 new findings
- **HIGH:** 1 new finding (resolve_dispute initiator authorization broken)
- **MEDIUM:** 0 new findings  
- **LOW/INFO:** 2 new findings
- **Previously Reported:** 5 issues confirmed still open

---

## Methodology

For each instruction, I:
1. Listed all accounts and their constraints
2. Identified which accounts SHOULD require authorization
3. Verified authorization is actually enforced
4. Looked for constraint gaps and privilege escalation vectors

---

## Audit Results by Instruction

### 1. initialize_protocol.rs ✅ PASS
**Accounts:**
- `protocol_config` (init, PDA)
- `treasury` (UncheckedAccount)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** Authority is signer who pays for initialization. Multisig validation in remaining_accounts ensures proper setup.

**Status:** Secure - Only callable once (PDA initialization), properly validates multisig threshold during setup.

---

### 2. update_protocol_fee.rs ✅ PASS
**Accounts:**
- `protocol_config` (mut, PDA)

**Authorization:** `require_multisig()` validates threshold of signers from remaining_accounts.

**Status:** Secure - Properly multisig-gated.

---

### 3. update_rate_limits.rs ✅ PASS
**Accounts:**
- `protocol_config` (mut, PDA)

**Authorization:** `require_multisig()` validates threshold of signers.

**Status:** Secure - Properly multisig-gated.

---

### 4. migrate.rs (MigrateProtocol) ✅ PASS
**Accounts:**
- `protocol_config` (mut, PDA)

**Authorization:** `require_multisig()` validates threshold of signers.

**Status:** Secure - Properly multisig-gated.

---

### 5. migrate.rs (UpdateMinVersion) ✅ PASS
**Accounts:**
- `protocol_config` (mut, PDA)

**Authorization:** `require_multisig()` validates threshold of signers.

**Status:** Secure - Properly multisig-gated.

---

### 6. register_agent.rs ✅ PASS
**Accounts:**
- `agent` (init, PDA)
- `protocol_config` (mut, PDA)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** Authority is signer who becomes agent.authority. Anyone can register their own agent.

**Status:** Secure - Self-registration pattern is intentional.

---

### 7. update_agent.rs ✅ PASS
**Accounts:**
- `agent` (mut, PDA, `has_one = authority`)
- `authority` (Signer)

**Authorization:** `has_one = authority` ensures only agent owner can update.

**Special Case:** Setting status to Suspended (3) requires additional protocol authority check via remaining_accounts.

**Status:** Secure - Proper ownership validation.

---

### 8. deregister_agent.rs ✅ PASS
**Accounts:**
- `agent` (mut, close = authority, PDA, `has_one = authority`)
- `protocol_config` (mut, PDA)
- `authority` (Signer, mut)

**Authorization:** `has_one = authority` + `close = authority` ensures only owner can deregister and receive rent.

**Status:** Secure - Proper ownership validation with additional checks (no active tasks, no pending votes).

---

### 9. create_task.rs ✅ PASS
**Accounts:**
- `task` (init, PDA)
- `escrow` (init, PDA)
- `protocol_config` (mut, PDA)
- `creator_agent` (mut, PDA, `has_one = authority`)
- `authority` (Signer)
- `creator` (Signer, mut)
- `system_program`

**Authorization:** `creator_agent.has_one = authority` links agent to signer. Rate limiting applied.

**Status:** Secure - Proper authorization chain.

---

### 10. create_dependent_task.rs ✅ PASS
**Accounts:** Same pattern as create_task.rs with additional parent_task validation.

**Authorization:** Same as create_task.rs - `has_one = authority` on creator_agent.

**Status:** Secure - Proper authorization chain.

---

### 11. claim_task.rs ✅ PASS
**Accounts:**
- `task` (mut, PDA)
- `claim` (init, PDA)
- `protocol_config` (PDA)
- `worker` (mut, PDA, `has_one = authority`)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** `worker.has_one = authority` ensures only agent owner can claim tasks.

**Status:** Secure - Proper ownership validation.

---

### 12. complete_task.rs ✅ PASS
**Accounts:**
- `task` (mut, PDA)
- `claim` (mut, PDA, constraint: `claim.task == task.key()`)
- `escrow` (mut, PDA)
- `worker` (mut, PDA, `has_one = authority`)
- `protocol_config` (mut, PDA)
- `treasury` (UncheckedAccount, constrained to protocol_config.treasury)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** `worker.has_one = authority` + claim validation ensures only the claiming worker can complete.

**Status:** Secure - Proper authorization chain.

---

### 13. complete_task_private.rs ✅ PASS
**Accounts:** Same authorization pattern as complete_task.rs.

**Additional Security:** ZK proof verification binds proof to (task_id, agent_pubkey, output_commitment).

**Status:** Secure - Strong authorization with cryptographic proof binding.

---

### 14. cancel_task.rs ✅ PASS
**Accounts:**
- `task` (mut, PDA, `has_one = creator`)
- `escrow` (mut, PDA)
- `creator` (Signer, mut)
- `system_program`

**Authorization:** `has_one = creator` ensures only task creator can cancel.

**Status:** Secure - Proper ownership validation.

---

### 15. initiate_dispute.rs ✅ PASS
**Accounts:**
- `dispute` (init, PDA)
- `task` (mut, PDA)
- `agent` (mut, PDA, `has_one = authority`)
- `protocol_config` (PDA)
- `initiator_claim` (optional, PDA)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** `agent.has_one = authority` + check that initiator is task participant (creator or has claim).

**Status:** Secure - Proper participation validation.

---

### 16. vote_dispute.rs ✅ PASS
**Accounts:**
- `dispute` (mut, PDA)
- `vote` (init, PDA)
- `authority_vote` (init, PDA) - Sybil protection
- `arbiter` (mut, PDA, `has_one = authority`)
- `protocol_config` (PDA)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** `arbiter.has_one = authority` + arbiter capability check + stake requirement.

**Sybil Protection:** AuthorityDisputeVote PDA prevents same wallet from voting twice via different agents.

**Status:** Secure - Strong authorization with Sybil resistance.

---

### 17. resolve_dispute.rs ⚠️ HIGH - FINDING
**Accounts:**
- `dispute` (mut, PDA)
- `task` (mut, PDA)
- `escrow` (mut, PDA)
- `protocol_config` (PDA)
- `resolver` (Signer, constrained)
- `creator` (UncheckedAccount, constrained to task.creator)
- `worker_claim` (optional, PDA)
- `worker` (optional, UncheckedAccount)
- `worker_authority` (optional, UncheckedAccount)
- `system_program`

**Authorization Issue:**
```rust
#[account(
    constraint = resolver.key() == protocol_config.authority
        || resolver.key() == dispute.initiator
        @ CoordinationError::UnauthorizedResolver
)]
pub resolver: Signer<'info>,
```

**Analysis:** The constraint `resolver.key() == dispute.initiator` is **broken**:
- `dispute.initiator` stores the AgentRegistration PDA key (set in initiate_dispute.rs:181 as `agent.key()`)
- `resolver` is a Signer (wallet/EOA)
- A wallet key can **never** equal a PDA key

**Impact:** The dispute initiator cannot resolve their own dispute after voting ends. Only `protocol_config.authority` can trigger resolution.

**Note:** This may be intentional design (centralized resolution trigger), but the code structure suggests initiators should be able to resolve their disputes.

---

### 18. expire_dispute.rs ℹ️ INFO - Permissionless by Design
**Accounts:**
- `dispute` (mut, PDA)
- `task` (mut, PDA)
- `escrow` (mut, PDA)
- `protocol_config` (PDA)
- `creator` (UncheckedAccount, constrained to task.creator)
- `worker_claim` (optional, PDA)
- `worker` (optional, UncheckedAccount)

**Authorization:** None required - permissionless after expiration time.

**Known Issue:** Does not decrement arbiters' `active_dispute_votes` (see #328).

**Status:** Permissionless by design for protocol liveness.

---

### 19. expire_claim.rs ℹ️ INFO - Permissionless with Minor Issue
**Accounts:**
- `task` (mut, PDA)
- `claim` (mut, close = rent_recipient, PDA)
- `worker` (mut, PDA)
- `rent_recipient` (UncheckedAccount, mut)

**Authorization:** None required - permissionless after claim expiration.

**Minor Issue:** `rent_recipient` is unchecked - anyone can direct the claim's rent to any account.

**Status:** See #331 - Minor griefing vector.

---

### 20. apply_dispute_slash.rs ℹ️ INFO - Permissionless by Design
**Accounts:**
- `dispute` (mut, PDA)
- `task` (PDA)
- `worker_claim` (PDA)
- `worker_agent` (mut, PDA)
- `protocol_config` (PDA)

**Authorization:** None required - permissionless after dispute resolution. Proper validation that `worker_agent.key() == worker_claim.worker`.

**Status:** Permissionless by design - anyone can trigger slashing after conditions are met.

---

### 21. apply_initiator_slash.rs ✅ PASS (Fixed)
**Accounts:**
- `dispute` (mut, PDA)
- `initiator_agent` (mut, PDA)
- `protocol_config` (PDA)

**Authorization:** Permissionless but validates `initiator_agent.key() == dispute.initiator`.

**Historical Note:** Previously had broken comparison (issue #326, fixed in commit 3a46b34).

**Status:** Secure after fix.

---

### 22. update_state.rs ✅ PASS
**Accounts:**
- `state` (init_if_needed, PDA)
- `agent` (mut, PDA, `has_one = authority`)
- `authority` (Signer, mut)
- `system_program`

**Authorization:** `agent.has_one = authority` + agent must be Active status.

**Status:** Secure - Proper authorization with rate limiting.

---

## New Findings

## [HIGH] Broken Initiator Authorization in resolve_dispute

**File:** `programs/agenc-coordination/src/instructions/resolve_dispute.rs:42-46`

**Issue:** The resolver constraint allows the dispute initiator to resolve their own dispute:
```rust
constraint = resolver.key() == protocol_config.authority
    || resolver.key() == dispute.initiator
```
However, `dispute.initiator` stores the AgentRegistration PDA key (not the wallet address), so this check can never pass for a wallet signer.

**Impact:** 
- Dispute initiators cannot trigger resolution of their own disputes after voting ends
- Only protocol authority can resolve disputes, creating centralization risk
- If protocol authority key is lost/compromised, disputes may become unresolvable

**Fix:** Change the check to compare against the initiator's authority wallet:
```rust
// Option 1: Store initiator authority in dispute struct
constraint = resolver.key() == protocol_config.authority
    || resolver.key() == dispute.initiator_authority

// Option 2: Fetch from agent account in remaining_accounts
// (more complex, requires validation)
```

---

## [LOW] Unrestricted Rent Recipient in expire_claim

**File:** `programs/agenc-coordination/src/instructions/expire_claim.rs:34`

**Issue:** The `rent_recipient` account is unchecked - anyone who expires a claim can direct the rent to any account.

**Impact:** Minor economic griefing - the rent from closed claim accounts goes to caller instead of worker.

**Status:** Already tracked as #331.

---

## [INFO] Permissionless Operations by Design

The following operations are intentionally permissionless for protocol liveness:
- `expire_dispute` - Anyone can expire after deadline
- `expire_claim` - Anyone can expire stale claims
- `apply_dispute_slash` - Anyone can trigger slashing after resolution
- `apply_initiator_slash` - Anyone can trigger slashing after rejection

This is **not a vulnerability** but should be documented for operators.

---

## Previously Reported Issues (Still Open)

| Issue | Severity | Title | Status |
|-------|----------|-------|--------|
| #328 | CRITICAL | Arbiter active_dispute_votes not decremented on dispute expiration | OPEN |
| #327 | CRITICAL | Worker active_tasks counter not decremented on task cancellation | OPEN |
| #325 | CRITICAL | Broken initiator slash validation - wrong pubkey comparison | OPEN (may be dup of fixed #326) |
| #331 | MEDIUM | Unrestricted Rent Recipient in expire_claim | OPEN |
| #333 | HIGH | Worker active_tasks counter corrupted on disputed tasks | OPEN |

---

## Access Control Pattern Summary

### Strong Patterns Used ✅
1. **has_one constraints** - Consistently used for ownership validation
2. **Multisig protection** - All admin functions properly gated
3. **PDA validation** - Seeds and bumps validated throughout
4. **Sybil resistance** - AuthorityDisputeVote prevents multi-agent voting abuse
5. **Capability checks** - Arbiter capability required for voting
6. **Stake requirements** - Minimum stake enforced for sensitive operations

### Areas for Improvement ⚠️
1. **Initiator reference storage** - Store authority wallet, not agent PDA, in dispute.initiator
2. **Rent recipient validation** - Consider constraining to worker or protocol treasury
3. **Counter consistency** - Ensure all state transitions properly update counters

---

## Conclusion

The AgenC Coordination Protocol demonstrates mature access control patterns with consistent use of Anchor's constraint system. The one new HIGH finding (broken initiator authorization in resolve_dispute) should be addressed to match the apparent design intent.

The codebase shows evidence of previous security audits with fixes for similar issues (e.g., #326 for apply_initiator_slash), suggesting the same pattern issue exists in resolve_dispute but was missed.

**Recommendation:** Create a GitHub issue for the resolve_dispute finding and apply a consistent fix pattern across the codebase.
