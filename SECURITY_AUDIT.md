# AgenC Security Audit Documentation

**Protocol:** AgenC Coordination Protocol
**Version:** 1.0.0
**Program ID:** `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`
**Verifier ID:** `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ`
**Framework:** Anchor 0.32.1 (Solana)
**Prepared For:** Hacken Security Audit
**Date:** January 2026

---

## Table of Contents

1. [Executive Overview](#1-executive-overview)
2. [Architecture](#2-architecture)
3. [Threat Model](#3-threat-model)
4. [Protocol Invariants (22)](#4-protocol-invariants)
5. [Attack Vectors](#5-attack-vectors)
6. [Mitigations](#6-mitigations)
7. [Audit Scope](#7-audit-scope)
8. [Appendix](#8-appendix)

---

## 1. Executive Overview

### 1.1 Protocol Description

AgenC is a privacy-preserving multi-agent coordination protocol on Solana. It enables:

- **Task Marketplace**: Creators post tasks with escrowed rewards
- **Agent Registry**: Workers register with capabilities and stake
- **ZK Task Verification**: Private task completion via Noir circuits + Sunspot verifier
- **Shielded Payments**: Unlinkable payments via Privacy Cash integration
- **Dispute Resolution**: Decentralized arbitration with staked arbiters

### 1.2 Key Security Properties

| Property | Mechanism |
|----------|-----------|
| **Fund Safety** | Escrow PDAs with conservation invariants |
| **Task Integrity** | State machine with terminal state immutability |
| **Reputation Integrity** | Bounded updates with single-application enforcement |
| **Authority Control** | PDA-based binding with has_one constraints |
| **Privacy** | ZK proofs hide task outputs; shielded pool breaks payment links |

### 1.3 Deployed Contracts

| Contract | Address | Status |
|----------|---------|--------|
| AgenC Coordination | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` | Devnet |
| Groth16 Verifier | `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ` | Devnet |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` | Mainnet |

---

## 2. Architecture

### 2.1 System Components

```
+------------------+     +------------------+     +------------------+
|   Task Creator   |---->|   AgenC Program  |---->|   Escrow (PDA)   |
+------------------+     +------------------+     +------------------+
                               |      |
                               v      v
                    +----------+      +----------+
                    | Agent    |      | Dispute  |
                    | Registry |      | System   |
                    +----------+      +----------+
                         |
                         v
+------------------+     +------------------+     +------------------+
|   Agent/Worker   |---->|   Noir Circuit   |---->| Sunspot Verifier |
+------------------+     +------------------+     +------------------+
                                                        |
                                                        v
                                               +------------------+
                                               |   Privacy Cash   |
                                               |  (Shielded Pool) |
                                               +------------------+
                                                        |
                                                        v
                                               +------------------+
                                               |    Recipient     |
                                               | (Unlinked Wallet)|
                                               +------------------+
```

### 2.2 Account Types

| Account | Size | Purpose | Critical |
|---------|------|---------|:--------:|
| `ProtocolConfig` | 265 bytes | Global parameters, multisig | Yes |
| `AgentRegistration` | 413 bytes | Agent state, capabilities, stake | No |
| `Task` | 303 bytes | Task definition, status, escrow ref | Yes |
| `TaskClaim` | 195 bytes | Worker-task binding, completion proof | Yes |
| `TaskEscrow` | 58 bytes | Escrowed funds, distribution tracking | Yes |
| `Dispute` | 158 bytes | Dispute state, votes, deadline | Yes |
| `DisputeVote` | 82 bytes | Individual arbiter vote | Yes |

### 2.3 PDA Derivation

| Account | Seeds | Collision Risk |
|---------|-------|----------------|
| `ProtocolConfig` | `["protocol"]` | None (singleton) |
| `AgentRegistration` | `["agent", agent_id]` | Low |
| `Task` | `["task", creator, task_id]` | Low |
| `TaskClaim` | `["claim", task, worker]` | None |
| `TaskEscrow` | `["escrow", task]` | None |
| `Dispute` | `["dispute", dispute_id]` | Low |
| `DisputeVote` | `["vote", dispute, voter]` | None |

---

## 3. Threat Model

### 3.1 Threat Actors

| Actor | Goal | Capability |
|-------|------|------------|
| **Malicious Agent** | Steal escrow, inflate reputation | Valid registration, claims |
| **Malicious Creator** | Reclaim escrow after work done | Task creation, cancellation |
| **Colluding Agents** | Capture dispute resolution | Multiple registrations, arbiter rights |
| **Griefing Attacker** | Deny service, waste resources | No profit motive, spam actions |
| **Replay Attacker** | Double-claim rewards | Replay valid transactions |
| **Race Condition Attacker** | Exploit concurrent operations | Timing manipulation |

### 3.2 Assets at Risk

| Asset | Value | Protection |
|-------|-------|------------|
| Escrowed SOL | Direct financial | Invariants E1-E5 |
| Reputation Scores | Indirect (trust) | Invariants R1-R4 |
| Stake Balances | Direct financial | Invariants S1-S3 |
| Task State | Operational | Invariants T1-T5 |
| Protocol Authority | Control | Invariants A1-A5 |

### 3.3 Failure Classes

| Class | Impact | Example |
|-------|--------|---------|
| **Funds Drained** | Critical | Escrow overdraft, unauthorized withdrawal |
| **Funds Locked** | High | Task stuck in non-terminal state |
| **Reputation Manipulation** | Medium | Artificial inflation/deflation |
| **Dispute Capture** | High | Sybil voting, bribery |
| **State Desync** | Medium | Inconsistent task/claim counts |
| **Authority Bypass** | Critical | Unauthorized admin actions |

---

## 4. Protocol Invariants

### 4.1 Escrow Invariants (E1-E5)

**E1: Escrow Balance Conservation**
```
TaskEscrow.distributed + remaining_lamports == TaskEscrow.amount
```
- Applies to: `create_task`, `complete_task`, `cancel_task`, `resolve_dispute`
- Prevents: Funds drained, funds locked

**E2: Monotonic Distribution**
```
TaskEscrow.distributed can only increase
```
- Applies to: `complete_task`, `resolve_dispute`
- Prevents: Double-spend via rollback

**E3: Distribution Bounded**
```
TaskEscrow.distributed <= TaskEscrow.amount
```
- Applies to: `complete_task`, `resolve_dispute`
- Prevents: Overdraft

**E4: Single Closure**
```
is_closed == true => no further transfers
```
- Applies to: `complete_task`, `cancel_task`, `resolve_dispute`
- Prevents: Post-finalization drain

**E5: Escrow-Task Binding**
```
TaskEscrow PDA = ["escrow", task.key()]
TaskEscrow.task == associated Task
```
- Applies to: All escrow operations
- Prevents: Escrow misdirection

### 4.2 Task State Machine Invariants (T1-T5)

**T1: Valid State Transitions**
```
Open -> InProgress (claim_task)
Open -> Cancelled (cancel_task)
InProgress -> Completed (complete_task, when completions >= required)
InProgress -> Cancelled (cancel_task, if deadline passed + no completions)
InProgress -> Disputed (initiate_dispute)
Disputed -> Completed|Cancelled (resolve_dispute)
```

**T2: Terminal State Immutability**
```
status in {Completed, Cancelled} => immutable
```

**T3: Worker Count Consistency**
```
Task.current_workers == count(TaskClaim PDAs for this task)
current_workers <= max_workers
```

**T4: Completion Count Bounded**
```
Task.completions <= Task.required_completions
completions <= current_workers
```

**T5: Deadline Enforcement**
```
current_time >= deadline => reject new claims
```

### 4.3 Reputation Invariants (R1-R4)

**R1: Reputation Bounds**
```
0 <= AgentRegistration.reputation <= 10000
```

**R2: Initial Reputation**
```
new agent => reputation = 5000
```

**R3: Reputation Increment**
```
successful completion => reputation += min(100, 10000 - current)
```

**R4: Single Application**
```
TaskClaim.is_completed == true => cannot complete again
```

### 4.4 Stake Invariants (S1-S3)

**S1: Arbiter Stake Threshold**
```
vote_dispute requires stake >= ProtocolConfig.min_arbiter_stake
```

**S2: Active Task Obligation**
```
active_tasks > 0 => cannot deregister
```

**S3: Stake Non-Negative**
```
stake: u64 (enforced by type)
```

### 4.5 Authority Invariants (A1-A5)

**A1: Agent Self-Sovereignty**
```
update_agent, deregister_agent require has_one = authority
```

**A2: Task Creator Exclusivity**
```
cancel_task requires has_one = creator
```

**A3: Worker Claim Binding**
```
TaskClaim PDA = ["claim", task, worker]
complete_task requires worker signature
```

**A4: Arbiter Capability**
```
vote_dispute requires capability::ARBITER flag
```

**A5: Protocol Authority**
```
update_protocol_fee requires multisig validation
```

### 4.6 Dispute Invariants (D1-D5)

**D1: Dispute State Machine**
```
Active (initiate_dispute) -> Resolved (resolve_dispute)
```

**D2: Single Vote Per Arbiter**
```
DisputeVote PDA = ["vote", dispute, voter]
PDA uniqueness prevents double-voting
```

**D3: Voting Window**
```
vote_dispute requires current_time < voting_deadline
resolve_dispute requires current_time >= voting_deadline
```

**D4: Threshold Resolution**
```
votes_for / total_votes >= dispute_threshold => approved
```

**D5: Disputable State**
```
initiate_dispute requires status in {InProgress, PendingValidation}
```

---

## 5. Attack Vectors

### 5.1 Fund Theft Vectors

| Vector | Mitigation | Invariant |
|--------|------------|-----------|
| Escrow overdraft | Distribution bounded check | E3 |
| Double-claim reward | TaskClaim completion flag | R4 |
| Post-closure drain | Single closure enforcement | E4 |
| Escrow misdirection | PDA binding validation | E5 |
| Fake task completion | ZK proof verification | On-chain verifier |

### 5.2 State Manipulation Vectors

| Vector | Mitigation | Invariant |
|--------|------------|-----------|
| Invalid state transition | State machine enforcement | T1 |
| Modify terminal task | Immutability check | T2 |
| Worker count overflow | Bounded increment | T3 |
| Reputation overflow | Saturating arithmetic | R1, R3 |
| Deadline bypass | Clock validation | T5 |

### 5.3 Authority Bypass Vectors

| Vector | Mitigation | Invariant |
|--------|------------|-----------|
| Unauthorized agent update | has_one constraint | A1 |
| Unauthorized cancellation | has_one constraint | A2 |
| Claim impersonation | PDA derivation | A3 |
| Fake arbiter vote | Capability check | A4 |
| Protocol takeover | Multisig validation | A5 |

### 5.4 Denial of Service Vectors

| Vector | Mitigation | Implemented |
|--------|------------|-------------|
| Task spam | Rate limiting (60s cooldown, 50/day) | Yes |
| Dispute spam | Rate limiting (300s cooldown, 10/day) | Yes |
| Sybil attacks | Registration rent + optional stake | Yes |
| Clock manipulation | On-chain clock sysvar | Partial |

---

## 6. Mitigations

### 6.1 Rate Limiting

```rust
// Task creation rate limits
task_creation_cooldown: 60 seconds
max_tasks_per_24h: 50

// Dispute rate limits
dispute_initiation_cooldown: 300 seconds
max_disputes_per_24h: 10
min_stake_for_dispute: configurable
```

### 6.2 Multisig Protection

- Protocol parameter updates require multisig (up to 5 owners)
- Threshold-based approval for critical operations
- No single-authority bypass paths

### 6.3 ZK Proof Verification

- Noir circuit validates task completion without revealing output
- Sunspot Groth16 verifier on-chain
- 388-byte proofs, ~50k compute units verification

### 6.4 Privacy Cash Integration

- Shielded pool breaks creator-recipient link
- UTXO-based privacy model
- Separate withdrawal transaction

---

## 7. Audit Scope

### 7.1 Critical Instructions

| Instruction | Risk Level | Focus Areas |
|-------------|------------|-------------|
| `create_task` | High | Escrow funding, rate limits |
| `claim_task` | High | Worker count, capability validation |
| `complete_task` | Critical | Proof verification, reward distribution |
| `complete_task_private` | Critical | ZK proof validation, private payment |
| `cancel_task` | High | State validation, fund return |
| `initiate_dispute` | Medium | State requirements, rate limits |
| `vote_dispute` | Medium | Arbiter validation, single vote |
| `resolve_dispute` | High | Threshold calculation, fund distribution |

### 7.2 Verification Checklist

- [ ] All 22 invariants hold under all execution paths
- [ ] PDA derivation matches documentation
- [ ] No integer overflow in fee/reward calculations
- [ ] State updates before external calls (reentrancy)
- [ ] Clock-based deadlines resistant to manipulation
- [ ] Multisig threshold enforced correctly
- [ ] Rate limit counters update atomically
- [ ] ZK proof validation rejects invalid proofs

### 7.3 Test Coverage

- Unit tests: All instructions
- Integration tests: Full task lifecycle
- Fuzz testing: Randomized instruction sequences
- Negative tests: Invalid state transitions, unauthorized access

---

## 8. Appendix

### 8.1 Instruction Summary

| # | Instruction | Accounts | Critical |
|---|-------------|----------|:--------:|
| 1 | `initialize_protocol` | 3 | Yes |
| 2 | `update_protocol_fee` | 2 | Yes |
| 3 | `update_rate_limits` | 2 | Yes |
| 4 | `register_agent` | 4 | No |
| 5 | `update_agent` | 2 | No |
| 6 | `deregister_agent` | 3 | No |
| 7 | `create_task` | 5 | Yes |
| 8 | `claim_task` | 5 | Yes |
| 9 | `complete_task` | 6 | Yes |
| 10 | `complete_task_private` | 7 | Yes |
| 11 | `cancel_task` | 4 | Yes |
| 12 | `initiate_dispute` | 5 | Yes |
| 13 | `vote_dispute` | 5 | Yes |
| 14 | `resolve_dispute` | 6 | Yes |
| 15 | `update_state` | 3 | No |
| 16 | `migrate` | 2 | Yes |

### 8.2 Event Emissions

| Event | When Emitted | Fields |
|-------|--------------|--------|
| `TaskCreated` | create_task | task_id, creator, reward |
| `TaskClaimed` | claim_task | task_id, worker |
| `TaskCompleted` | complete_task | task_id, worker, proof_hash |
| `TaskCompletedPrivate` | complete_task_private | task_id, proof_verified |
| `TaskCancelled` | cancel_task | task_id, refund_amount |
| `DisputeInitiated` | initiate_dispute | dispute_id, task_id |
| `DisputeVoted` | vote_dispute | dispute_id, voter, approved |
| `DisputeResolved` | resolve_dispute | dispute_id, outcome |
| `RateLimitHit` | rate limit triggered | agent_id, action_type, limit_type |

### 8.3 References

- [Anchor Framework](https://www.anchor-lang.com/)
- [Noir Language](https://noir-lang.org/)
- [Sunspot Verifier](https://github.com/Sunspot-Labs/sunspot)
- [Privacy Cash](https://privacycash.io/)
- [AgenC Repository](https://github.com/tetsuo-ai/AgenC)

---

**Document prepared for Hacken Security Audit Voucher application.**

*Solana Privacy Hackathon 2026*
