# ADR-001: Durable Task Runtime Contract

- **Status:** Accepted
- **Date:** 2026-03-07
- **Owners:** Runtime / Gateway
- **Related code:** `runtime/src/gateway/agent-run-contract.ts`, `runtime/src/gateway/background-run-store.ts`, `runtime/src/gateway/background-run-supervisor.ts`
- **Related roadmap:** [`REFACTOR.MD`](../../../REFACTOR.MD), [`REFACTOR-MASTER-PROGRAM.md`](../../../REFACTOR-MASTER-PROGRAM.md)

## Context

AgenC already has a durable background-run supervisor and persisted run store, but the contract had been implicit and partially split across code paths:

- run state definitions lived in `background-run-store.ts`
- lifecycle behavior lived in `background-run-supervisor.ts`
- shutdown/recovery semantics were mostly conventional rather than explicitly codified
- `blocked` behavior was inconsistent with a recoverable durable-run model

That made it too easy for later phases to add behavior without a stable definition of:

- what a run is
- which states are terminal
- which states are recoverable
- which transitions are valid
- which invariants must hold across restart and recovery

## Decision

We define the durable runtime around a canonical `AgentRun` contract.

### Canonical Run States

- `pending`: accepted by the runtime but not yet executing a cycle
- `running`: actively executing a bounded cycle
- `working`: waiting for the next scheduled verification or wake event
- `paused`: intentionally halted by an operator/user
- `blocked`: waiting for an external precondition, approval, or operator signal
- `suspended`: parked for runtime recovery or worker/daemon shutdown
- `completed`: objective satisfied
- `failed`: objective could not be completed safely
- `cancelled`: explicitly stopped

### Terminal States

- `completed`
- `failed`
- `cancelled`

All other states are recoverable.

### Lifecycle Semantics

- `pause` means the run should remain durable but not execute until resumed.
- `blocked` means the run should remain durable and await a new signal or intervention.
- `suspend` means the runtime is intentionally parking a live run during shutdown, drain, or worker handoff.
- `cancel` is terminal and user/operator initiated.
- `fail` is terminal and runtime/verifier initiated.
- `complete` is terminal and must be grounded in deterministic evidence or a typed verifier.

### Runtime Ownership

The model may propose progress or completion, but the runtime owns state transitions.

### Structured Contract

Every run contract must define:

- `kind`
- `successCriteria`
- `completionCriteria`
- `blockedCriteria`
- `nextCheckMs`
- optional `heartbeatMs`
- `requiresUserStop`
- optional `managedProcessPolicy`

## Invariants

1. A run may only transition along the canonical state-transition graph.
2. Terminal runs are not recoverable.
3. `blocked` is recoverable and must not be silently discarded on restart.
4. `suspended` exists to make shutdown/recovery explicit rather than overloading `working`.
5. Persisted run records and recent snapshots must conform to the canonical schema version.
6. Invalid run contracts or persisted records must be rejected locally.

## Consequences

### Positive

- Later phases now have a stable contract to build on.
- Shutdown and recovery semantics become explicit.
- `blocked` runs can remain durable and resume from signals instead of being treated as terminal noise.
- Contract drift between store and supervisor becomes easier to detect in tests.

### Tradeoffs

- The runtime now enforces more validation at persistence boundaries.
- `suspended` adds another state that operators and tests must understand.
- Some legacy assumptions that equated `blocked` with terminal failure are no longer valid.

## Follow-On Work

This ADR unlocks the next phases in [`REFACTOR.MD`](../../../REFACTOR.MD) and [`REFACTOR-MASTER-PROGRAM.md`](../../../REFACTOR-MASTER-PROGRAM.md):

- durable kernel hardening
- event-driven wake plane
- typed run domains and deterministic verifiers
- provider-native compaction and long-horizon context control
