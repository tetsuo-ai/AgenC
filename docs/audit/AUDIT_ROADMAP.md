# SOLANA AUDIT ROADMAP

This document defines the pre audit and pre hardening roadmap for the AgenC Solana on chain coordination program. This is the phase where development pauses and the protocol is treated as critical infrastructure.

This program is the trust layer for AgenC. It holds funds in escrow, distributes rewards, resolves disputes, and tracks agent reputation and stake. A single vulnerability at this layer would compromise funds and permanently damage trust in the system.

The goal of this roadmap is to make the program correct, predictable, and audit ready before mainnet deployment or SDK integration.


## Guiding principle

No new features are added until correctness is proven. This phase is about reducing risk, not increasing surface area. The program should become boring to read and impossible to surprise.


## Phase 0 Feature freeze and threat modeling

All feature development stops. Only testing, refactoring for safety, and documentation changes are allowed.

The threat model is written down explicitly. This includes who can steal funds, who can lock funds, who can manipulate reputation, and how liveness could be broken. Protocol invariants are defined in plain language and mapped to specific instructions.

Deliverables for this phase are a written threat model, a list of invariants, and an explicit feature freeze acknowledgment.


## Phase 1 Instruction level test coverage

Every instruction in the program must have exhaustive Anchor tests. These tests should cover both expected behavior and invalid edge cases.

The task lifecycle state machine is tested explicitly. All valid transitions must succeed and all invalid transitions must fail. Terminal states must be immutable.

Authority and signer checks are tested for every instruction. Tests must confirm that incorrect signers, missing signers, incorrect PDAs, and incorrect PDA seeds are all rejected.

Escrow behavior is tested with balance snapshots before and after each instruction. Lamport movement must be exact. No instruction may leak funds, double spend escrow, or withdraw without authority.


## Phase 2 Dispute system correctness

The dispute system is tested as its own critical subsystem.

Dispute initiation is tested to ensure it is only allowed from valid task states, only by authorized actors, and only within the correct time window.

Voting logic is tested for double voting, voting by unauthorized accounts, voting after resolution, and any stake or eligibility constraints.

All dispute resolution outcomes are tested. Refund, payout, and split paths must each move the correct amount of funds, update reputation exactly once, and move the task into a terminal state.


## Phase 3 Reputation and stake safety

Reputation logic is tested for underflow, overflow, and double application. Reputation must never become negative or exceed defined bounds.

Stake logic is tested for slashing limits, withdrawal timing, and invalid withdrawal attempts. Agents must not be able to unregister or withdraw stake while they have active obligations.


## Phase 4 Concurrency and race conditions

The program is tested under simulated concurrent conditions. This includes multiple agents attempting to claim the same task, claim and cancel in the same slot, and complete and dispute in close succession.

Replay attempts and duplicate transaction submission are tested to ensure deterministic outcomes.


## Phase 5 Fuzzing and invariant validation

Simple fuzzing is applied to instruction inputs, ordering, and boundary values. The goal is to detect panics, invariant violations, or silent incorrect state transitions.

All fuzz failures must be investigated and either fixed or explicitly ruled out with documented reasoning.


## Phase 6 Static analysis and manual review

Automated tools are run including cargo audit, cargo clippy, and cargo geiger. Unsafe code usage must be justified or removed.

A manual review is performed instruction by instruction. All arithmetic must use checked operations. All PDAs must be explicitly validated. All assumptions must be enforced with explicit checks.


## Phase 7 Upgrade authority and deployment planning

The upgrade authority model is decided before mainnet. This includes whether the program is governed by a multisig, time locked upgrades, or eventual immutability.

Deployment steps are simulated on devnet and documented end to end.


## Phase 8 Observability and monitoring

All critical state transitions emit events. This includes escrow funding, escrow release, dispute creation, dispute resolution, and reputation updates.

These events form the basis for monitoring, analytics, and future SDK integration.


## Exit criteria

This roadmap phase is complete when all tests pass, all invariants are enforced, static analysis is clean, and any external audit feedback is resolved. Only after this point should SDK integration or new feature development resume.

