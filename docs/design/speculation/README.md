# Speculative Execution with Optimistic Proof Deferral

> **Epic:** [#285](https://github.com/tetsuo-ai/AgenC/issues/285)  
> **Status:** Design Phase  
> **Authors:** AgenC Team  
> **Last Updated:** 2026-01-28

## Overview

This directory contains the complete software engineering documentation for implementing Speculative Execution in AgenC. This feature enables downstream task execution before ancestor proofs are confirmed on-chain, reducing end-to-end pipeline latency by 2-3x.

## Document Index

### Core Design

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Master architecture document — start here |
| [DECISION-LOG.md](./DECISION-LOG.md) | Architectural decisions and rationale |

### Diagrams

| Document | Description |
|----------|-------------|
| [diagrams/CLASS-DIAGRAMS.md](./diagrams/CLASS-DIAGRAMS.md) | UML class diagrams for all components |
| [diagrams/SEQUENCE-DIAGRAMS.md](./diagrams/SEQUENCE-DIAGRAMS.md) | Interaction sequence diagrams |
| [diagrams/SWIMLANE-DIAGRAMS.md](./diagrams/SWIMLANE-DIAGRAMS.md) | Cross-component responsibility flows |
| [diagrams/STATE-MACHINES.md](./diagrams/STATE-MACHINES.md) | State machine specifications |
| [diagrams/DATA-FLOW.md](./diagrams/DATA-FLOW.md) | C4 and data flow diagrams |
| [diagrams/COMPONENT-INTERACTIONS.md](./diagrams/COMPONENT-INTERACTIONS.md) | Component interaction matrix |

### API Specifications

| Document | Description |
|----------|-------------|
| [api/RUNTIME-API.md](./api/RUNTIME-API.md) | TypeScript runtime interfaces |
| [api/ONCHAIN-API.md](./api/ONCHAIN-API.md) | Solana program interfaces |
| [api/SDK-API.md](./api/SDK-API.md) | Client SDK methods |

### Testing

| Document | Description |
|----------|-------------|
| [testing/TEST-PLAN.md](./testing/TEST-PLAN.md) | Comprehensive test strategy and cases |
| [testing/TEST-DATA.md](./testing/TEST-DATA.md) | Test data and fixtures |

### Operations

| Document | Description |
|----------|-------------|
| [operations/CONFIGURATION.md](./operations/CONFIGURATION.md) | Configuration guide |
| [operations/MONITORING.md](./operations/MONITORING.md) | Metrics, dashboards, alerts |
| [operations/RUNBOOK.md](./operations/RUNBOOK.md) | Operational procedures |
| [operations/DEPLOYMENT.md](./operations/DEPLOYMENT.md) | Deployment guide |

## Implementation Roadmap

### Phase 0: Prerequisites
- [ ] #259 — Add task dependency field

### Phase 1: Core Runtime
- [ ] #261 — DependencyGraph
- [ ] #264 — ProofDeferralManager
- [ ] #266 — CommitmentLedger
- [ ] #269 — RollbackController
- [ ] #271 — SpeculativeTaskScheduler

### Phase 2: On-Chain
- [ ] #273 — SpeculativeCommitment accounts
- [ ] #275 — Stake bonding and slashing

### Phase 3: Quality
- [ ] #278 — Metrics and observability
- [ ] #282 — Comprehensive test suite

## Quick Links

- [GitHub Epic](https://github.com/tetsuo-ai/AgenC/issues/285)
- [Original Design Discussion](https://github.com/tetsuo-ai/AgenC/issues/245)
- [AgenC Documentation](../../README.md)

## Contributing

When updating these documents:
1. Update the "Last Updated" date
2. Log significant changes in DECISION-LOG.md
3. Keep diagrams in sync with implementation
4. Run diagram validation before committing
