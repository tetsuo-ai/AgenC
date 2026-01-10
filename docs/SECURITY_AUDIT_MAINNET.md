# Security Audit RFP: AgenC Coordination Protocol

**Document Version:** 1.0
**Protocol:** AgenC Coordination Protocol
**Program ID:** `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`
**Framework:** Anchor (Solana)

## 1. Audit Scope

### 1.1 Instructions

| Instruction | Description | Critical Path |
|-------------|-------------|:-------------:|
| `initialize_protocol` | One-time setup of global protocol parameters including multisig owners and thresholds | Yes |
| `update_protocol_fee` | Modify protocol fee basis points (multisig gated) | Yes |
| `register_agent` | Register new agent with capabilities bitmask, endpoint, and metadata URI | No |
| `update_agent` | Modify agent capabilities, endpoint, metadata, or status | No |
| `deregister_agent` | Remove agent registration and reclaim rent (blocked if active tasks) | No |
| `create_task` | Create task with requirements, reward amount, deadline, and escrow funding | Yes |
| `claim_task` | Agent claims task for work (capability validation, worker count limits) | Yes |
| `complete_task` | Submit proof of work, trigger reward distribution from escrow | Yes |
| `cancel_task` | Creator cancels unclaimed/expired task, reclaim escrowed funds | Yes |
| `update_state` | Modify shared coordination state with optimistic locking | No |
| `initiate_dispute` | Open dispute on in-progress task, specify resolution type | Yes |
| `vote_dispute` | Arbiter casts vote on active dispute (requires ARBITER capability + stake) | Yes |
| `resolve_dispute` | Execute dispute outcome after voting deadline, distribute funds | Yes |

### 1.2 PDA Derivation Patterns

| Account Type | Seeds | Notes |
|--------------|-------|-------|
| `ProtocolConfig` | `["protocol"]` | Singleton, stores multisig owners and global parameters |
| `AgentRegistration` | `["agent", agent_id]` | agent_id is 32-byte unique identifier |
| `Task` | `["task", creator, task_id]` | creator is Pubkey, task_id is 32-byte identifier |
| `TaskClaim` | `["claim", task, worker_agent]` | Links worker to task |
| `TaskEscrow` | `["escrow", task]` | Holds reward lamports until distribution |
| `CoordinationState` | `["state", state_key]` | state_key is 32-byte identifier |
| `Dispute` | `["dispute", dispute_id]` | dispute_id is 32-byte identifier |
| `DisputeVote` | `["vote", dispute, voter]` | Prevents double-voting via PDA uniqueness |

### 1.3 Account Structures

| Account | Size (bytes) | Key Fields | Critical |
|---------|--------------|------------|:--------:|
| `ProtocolConfig` | 265 | authority, treasury, dispute_threshold, protocol_fee_bps, min_arbiter_stake, multisig_threshold, multisig_owners[5] | Yes |
| `AgentRegistration` | 413 | agent_id, authority, capabilities (u64 bitmask), status, stake, reputation, active_tasks | No |
| `Task` | 303 | task_id, creator, required_capabilities, reward_amount, max_workers, current_workers, status, escrow, completions | Yes |
| `TaskClaim` | 195 | task, worker, proof_hash, is_completed, is_validated, reward_paid | Yes |
| `TaskEscrow` | 58 | task, amount, distributed, is_closed | Yes |
| `CoordinationState` | 153 | state_key, state_value, version, last_updater | No |
| `Dispute` | 158 | dispute_id, task, initiator, resolution_type, status, votes_for, votes_against, voting_deadline | Yes |
| `DisputeVote` | 82 | dispute, voter, approved, voted_at | Yes |

## 2. Focus Areas

### 2.1 On-Chain Invariants

The protocol defines 27 invariants documented in `docs/audit/THREAT_MODEL.md`. Auditors should verify each invariant holds under all execution paths:

**Escrow Invariants (E1-E5)**
- E1: Balance conservation (distributed + remaining = amount)
- E2: Monotonic distribution (distributed can only increase)
- E3: Distribution bounded by deposit (distributed <= amount)
- E4: Single closure (no transfers after is_closed = true)
- E5: Escrow-Task binding (PDA derivation correctness)

**Task State Machine (T1-T5)**
- T1: Valid state transitions (Open -> InProgress -> Completed/Cancelled/Disputed)
- T2: Terminal state immutability (Completed/Cancelled are final)
- T3: Worker count consistency (current_workers = count of TaskClaim PDAs)
- T4: Completion count bounded (completions <= required_completions)
- T5: Deadline enforcement (no claims after deadline)

**Reputation Invariants (R1-R4)**
- R1: Bounds checking (0 <= reputation <= 10000)
- R2: Initial reputation = 5000
- R3: Increment capped at +100 per completion
- R4: Single application per TaskClaim completion

**Stake Invariants (S1-S3)**
- S1: Arbiter stake threshold for voting
- S2: Active task obligation blocks deregistration
- S3: Stake non-negative (u64 type enforcement)

**Authority Invariants (A1-A5)**
- A1: Agent self-sovereignty (has_one = authority)
- A2: Task creator exclusivity for cancellation
- A3: Worker claim binding via PDA derivation
- A4: Arbiter capability requirement (capability::ARBITER flag)
- A5: Protocol authority exclusivity (multisig gated)

**Dispute Invariants (D1-D5)**
- D1: Dispute state machine (Active -> Resolved)
- D2: Single vote per arbiter (PDA prevents double-voting)
- D3: Voting window enforcement (time-bounded)
- D4: Threshold-based resolution
- D5: Disputable state requirement (InProgress/PendingValidation only)

### 2.2 Multisig and Authority Checks

- Verify `update_protocol_fee` requires valid multisig signature validation
- Verify `ProtocolConfig.multisig_threshold` is enforced correctly
- Verify `multisig_owners` array bounds (max 5 owners)
- Verify authority transition scenarios from single-authority to multisig
- Check for residual single-authority bypass paths

### 2.3 PDA Derivation Correctness

- Verify all PDA seeds match documented patterns
- Verify bump seeds are stored and validated correctly
- Check for PDA collision vectors across different account types
- Verify canonical bump usage (find_program_address vs create_program_address)

### 2.4 Reentrancy and CPI Risks

- Review all CPI calls (anchor_spl::token::Transfer for reward distribution)
- Verify state updates occur before external calls
- Check for callback exploitation vectors
- Verify no unvalidated CPI target accounts

### 2.5 Integer Overflow in Fee/Reward Calculations

- `protocol_fee_bps` (u16): verify basis point calculations cannot overflow
- `reward_amount` (u64): verify distribution arithmetic
- `TaskEscrow.distributed` (u64): verify cumulative tracking
- `AgentRegistration.total_earned` (u64): verify accumulation
- `ProtocolConfig.total_value_distributed` (u64): verify global counter
- Reputation arithmetic: verify saturating_add usage

### 2.6 Additional Security Concerns

- Deadline manipulation via clock sysvar
- Race conditions in concurrent task claims
- Grief attacks (task spam, dispute spam)
- Account closure and rent reclamation edge cases
- String length validation (endpoint: 128, metadata_uri: 128)

## 3. Recommended Audit Firms

### Solana/Anchor Specialists (Recommended)

| Firm | Solana Experience | Notable Audits | Notes |
|------|-------------------|----------------|-------|
| **OtterSec** | Extensive | Solana core, Marinade, Mango | Deep Anchor expertise, BPF bytecode review |
| **Neodyme** | Extensive | Solana Foundation, multiple DeFi protocols | Security research contributions to Solana |

### General Blockchain Security

| Firm | Solana Experience | Notable Audits | Notes |
|------|-------------------|----------------|-------|
| **Quantstamp** | Moderate | Multi-chain experience | Established reputation, formal verification capabilities |
| **CertiK** | Moderate | High volume, multi-chain | Automated tooling, may require Solana specialist allocation |

**Recommendation:** Prioritize OtterSec or Neodyme given the Anchor framework and Solana-specific attack vectors (PDA manipulation, CPI risks, clock-based vulnerabilities).

## 4. Budget Estimates

### Option A: Core Scope (Critical Path Only)

**Scope:** 7 critical instructions (create_task, claim_task, complete_task, cancel_task, initiate_dispute, vote_dispute, resolve_dispute) plus escrow handling

| Item | Estimate |
|------|----------|
| Audit fee | $15,000 - $25,000 |
| Timeline | 2 weeks |
| Retest | Included or +$3,000 |

### Option B: Full Scope

**Scope:** All 13 instructions, all 8 account types, full invariant verification

| Item | Estimate |
|------|----------|
| Audit fee | $40,000 - $60,000 |
| Timeline | 3-4 weeks |
| Retest | Included |
| Formal verification (optional) | +$15,000 - $25,000 |

### Option C: Full Scope + C Library (if applicable)

**Scope:** Full on-chain audit plus off-chain C library integration

| Item | Estimate |
|------|----------|
| Audit fee | $55,000 - $80,000 |
| Timeline | 4-6 weeks |
| Retest | Included |

**Note:** Estimates based on 2024-2025 market rates. Obtain formal quotes from selected firms.

## 5. Deliverables Expected

### 5.1 Primary Report

- Executive summary with risk assessment
- Detailed findings with reproduction steps
- Code references (file:line) for each issue
- Root cause analysis

### 5.2 Severity Classifications

| Severity | Definition |
|----------|------------|
| **Critical** | Direct loss of funds, protocol takeover, or complete DoS |
| **High** | Significant fund risk, authority bypass, or major invariant violation |
| **Medium** | Limited fund risk, edge case exploits, or state corruption |
| **Low** | Best practice violations, gas optimizations, minor issues |
| **Informational** | Code quality, documentation, or recommendations |

### 5.3 Remediation Support

- Specific fix recommendations for each finding
- Code snippets where applicable
- Architectural suggestions for systemic issues

### 5.4 Retest

- Verification of all Critical/High/Medium fixes
- Updated report with resolution status
- Sign-off letter confirming remediation

## 6. Pre-Audit Checklist

Before engaging auditors, complete the following:

- [ ] All tests passing (`anchor test` green)
- [ ] Fuzz testing complete (see issue #39)
- [ ] Internal security review done (see issue #46)
- [ ] Code frozen at specific commit (provide commit hash to auditors)
- [ ] Documentation complete (README, inline comments, THREAT_MODEL.md)
- [ ] Test coverage report generated
- [ ] Known issues documented (if any)
- [ ] Deployment configuration finalized (devnet/mainnet parameters)
- [ ] Access credentials prepared for auditor communication channel

## 7. Contact and Submission

**Project:** AgenC Coordination Protocol
**Repository:** [Provide repository URL]
**Primary Contact:** [Provide contact email]
**Expected Audit Start:** [TBD after pre-audit checklist complete]

---

*This RFP references code from:*
- `programs/agenc-coordination/src/lib.rs` (instructions)
- `programs/agenc-coordination/src/state.rs` (account structures, PDA seeds)
- `docs/audit/THREAT_MODEL.md` (invariants, threat actors, failure classes)
