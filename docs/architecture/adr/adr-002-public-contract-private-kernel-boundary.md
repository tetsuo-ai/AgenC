# ADR-002: Public Contract And Private Kernel Boundary

- **Status:** Accepted
- **Date:** 2026-03-16
- **Owners:** Repository / Platform Architecture
- **Related roadmap:** [REFACTOR.MD](../../../REFACTOR.MD), [REFACTOR-MASTER-PROGRAM.md](../../../REFACTOR-MASTER-PROGRAM.md)
- **Supersedes:** none

## Context

AgenC completed Gate 10 split-readiness proof, but Gate 11 exposed a harder problem than simple repo extraction:

- the desired public/private boundary was described in planning docs
- the live repo and package surfaces did not fully enforce that boundary
- runtime-side packages were still published or documented as if they were long-term public products
- the ecosystem-facing extension model had not yet been reduced to a narrow, durable ABI

That left the project in a risky middle state:

- public contracts existed
- moat-bearing kernel code still existed in a public repo/package posture
- third-party builders did not yet have a stable extension socket that avoided private runtime coupling

This ADR defines the durable boundary for Gate 11 and beyond.

## Decision

### Repository Roles

Public repos are limited to:

- `agenc-sdk`
- `agenc-protocol`
- `agenc-plugin-kit`

Private repos are limited to:

- `agenc-core`
- `agenc-prover` or `agenc-cloud`

### Kernel Baseline

The current `AgenC` repo is the frozen baseline for the future private `agenc-core`.

The kernel is kept together first. It is **not** exploded into many repos at the start of Gate 11.

Kernel ownership includes:

- `runtime/`
- `mcp/`
- `docs-mcp/`
- `contracts/desktop-tool-contracts/`
- `containers/desktop/server/`
- `web/`
- `mobile/`
- `demo-app/`
- runtime-owned tools, scripts, and internal examples

### Public Contract Surface

Only these surfaces are first-class public builder targets:

- SDK contracts from `agenc-sdk`
- protocol/trust-surface contracts from `agenc-protocol`
- narrow extension contracts from `agenc-plugin-kit`

Third parties build **for** AgenC through those contracts. They do **not** build inside the private runtime kernel.

### Private Runtime-Side Packages

The following package identities are not permanent public contracts:

- `@tetsuo-ai/runtime`
- `@tetsuo-ai/mcp`
- `@tetsuo-ai/docs-mcp`
- `@tetsuo-ai/desktop-tool-contracts`
- `@tetsuo-ai/desktop-server`

Already-published runtime-side package names must be treated as transitional public artifacts, not as the long-term public product model.

Private packages must move to a dedicated internal distribution path that is distinct from public npm package identities. The exact backend may be validated during implementation, but the policy is fixed:

- private package distribution must have explicit access control
- private package names must not rely on already-public runtime identities as trusted internal identifiers
- public runtime-side package names must receive explicit deprecation and migration handling before visibility tightening

### Plugin-Kit Host ABI

`agenc-plugin-kit` is the only intended public extension ABI.

It must target a frozen host adapter implemented by `agenc-core`, not direct kernel internals.

The host ABI must be versioned explicitly:

- `plugin_api_version`
- `host_api_version`

The host adapter may expose only:

- manifest validation
- capability negotiation
- config validation
- scoped state/storage APIs
- logging/telemetry APIs
- healthcheck APIs
- lifecycle hooks
- bounded registration hooks for approved plugin classes

The following are explicitly **not** public ABI:

- internal registries
- internal service locators
- internal database schemas
- orchestration internals
- policy/eval/ranking engines
- desktop/session-router internals

### Plugin-Kit Scope

Allowed first-party extension classes:

- tool packs
- provider adapters
- connector/channel adapters

Explicitly out of scope:

- orchestration
- policy engine
- evaluation/replay engine
- marketplace ranking
- approvals
- subagent runtime
- broad runtime object graphs

## Consequences

### Positive

- the moat stays in the kernel, operator stack, and proving/control-plane surfaces
- the public ecosystem gets a clear build target
- repo extraction can proceed without turning the runtime into a public API accident
- public/private enforcement can be validated in code, docs, packaging, and CI

### Tradeoffs

- runtime-side packages require a managed deprecation path rather than an instant visibility flip
- `plugin-kit` must be built as a real product surface before runtime visibility is tightened
- some current docs and package metadata now need to be treated as transitional and corrected in later Gate 11 phases

## Required Follow-On Work

1. Finish `agenc-protocol` consumer cutover so the public trust surface is actually authoritative.
2. Build `agenc-plugin-kit` with a versioned host compatibility matrix and certification harness.
3. Move private packages to a dedicated internal distribution path with validated auth for developers, CI, containers, and deployment.
4. Add deprecation notices, support-window policy, and migration docs for already-public runtime-side packages.
5. Rewrite public docs so builders are directed to SDK, protocol, and plugin-kit only.
