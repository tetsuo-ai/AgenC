# Gate 5 — Runtime Control-Plane Boundary Reduction

> Produced by the refactor program. Maps real control-plane seams after the first proven seam (Gate 4).

---

## 1. Gateway ↔ LLM Seam

### 1.1 Current Coupling

`daemon.ts` constructs `ChatExecutor` with `ChatExecutorConfig` (~30 fields). The construction spans ~50 lines and depends on local variables from `wireWebChat()`. Two construction sites exist (webchat channel and text channel fallback).

### 1.2 Seam Status

| Surface | Contract | Verified |
|---------|----------|----------|
| `ChatExecutorConfig` | Explicit interface in `chat-executor-types.ts` (line 346) | Yes (Gate 3) |
| `ChatExecutor.execute()` | `ChatExecuteParams` + `ChatExecutorResult` | Yes (Gate 3) |
| Planner pipeline | `PlannerPipelineVerifierLoopInput` | Yes (Gate 3) — planner modules type-only |
| Tool handler | `SessionToolHandlerConfig` → `ToolHandler` | Yes (Gate 4) — 6 contract tests |

### 1.3 Reduction Decision

**No extraction needed now.** The coupling is already mediated by explicit config interfaces. Extracting a factory would just move ~50 lines of config construction into another file — marginal value with real risk (daemon.ts is 10.7k lines). The config interface IS the seam.

**Gate 9 action:** If daemon decomposition proceeds, the config construction can be lifted into a factory at that point.

---

## 2. Approval Transport vs Policy Evaluation

### 2.1 Current State

| Module | Lines | Tests | Responsibility |
|--------|-------|-------|---------------|
| `gateway/approvals.ts` | 971 | 90 tests (979 lines) | ApprovalEngine: request lifecycle, transport, persistence |
| `policy/engine.ts` | Part of policy module | Policy tests | PolicyEngine: budget enforcement, RBAC, tool policies |
| `tool-handler-factory.ts` | 1,719 | 71 tests | Session tool handler: approval gating via ApprovalEngine |

### 2.2 Seam Status

The split already exists:
- **Policy evaluation** lives in `policy/engine.ts` — runs at `tool:before` hook priority 3
- **Approval transport** lives in `gateway/approvals.ts` — runs in tool-handler-factory after hooks pass
- **Tool handler** mediates via `SessionToolHandlerConfig.approvalEngine?` (optional dependency)

### 2.3 Reduction Decision

**Already split.** Policy and approval are separate modules with separate test files. The tool handler factory consumes ApprovalEngine through its config contract (verified in Gate 4 contract tests). No further split needed.

---

## 3. Background-Run Control-Plane Contract

### 3.1 Current State

| Module | Lines | Tests | Responsibility |
|--------|-------|-------|---------------|
| `background-run-supervisor.ts` | 7,625 | 5,678 lines | State machine, supervisor loop, wake logic |
| `background-run-store.ts` | 3,273 | Tests in supervisor | Persistence layer for run state |
| `background-run-control.ts` | ~200 | 118 lines | Control actions (pause, resume, cancel) |
| `background-run-notifier.ts` | 331 | Tests exist | Progress/status notifications |
| `background-run-operator.ts` | 285 | 81 lines (5 tests) | Operator-facing read model |
| `background-run-wake-bus.ts` | ~200 | 196 lines | Wake event distribution |
| `background-run-wake-adapters.ts` | ~200 | Tests exist | Wake source adapters |
| `agent-run-contract.ts` | ~200 | 120 lines | Agent↔run contract types |

### 3.2 Seam Status

The background-run subsystem is already decomposed into 7 modules with dedicated test files:
- Supervisor (state machine) is separate from store (persistence)
- Control actions are separate from supervision
- Notifications are separate from state transitions
- Wake bus and adapters are separate from supervisor logic

### 3.3 Reduction Decision

**Already well-separated.** The background-run subsystem has 8 modules totaling ~12k lines with comprehensive test coverage (~6k lines of tests). Internal boundaries are real and tested. No further reduction needed before Gate 9.

---

## 4. Subagent Orchestration Contract

### 4.1 Current State

| Module | Lines | Tests | Responsibility |
|--------|-------|-------|---------------|
| `subagent-orchestrator.ts` | 5,959 | 6,965 lines | Orchestration: spawn, supervise, collect results |
| `delegation-runtime.ts` | 260 | Tests exist | DelegationPolicyEngine + SubAgentLifecycleEmitter |
| `delegation-scope.ts` | 271 | 210 lines | Tool/scope delegation rules |
| `delegation-tool.ts` | 344 | Tests exist | Delegation tool bridge |
| `delegation-timeout.ts` | 121 | Tests exist | Timeout policy for delegated work |
| `durable-subrun-orchestrator.ts` | 741 | Tests exist | Durable run orchestration |
| `subrun-contract.ts` | 322 | Tests exist | Sub-run contract types |
| `sub-agent.ts` | ~500 | Tests exist | SubAgentManager (spawn/lifecycle) |

### 4.2 Seam Status

The subagent subsystem is decomposed into 8 modules:
- Orchestration (control) is separate from delegation (policy)
- Scope rules are separate from timeout policy
- Tool bridge is separate from lifecycle management
- Durable sub-runs are separate from ephemeral sub-agents

### 4.3 Reduction Decision

**Already well-separated.** The orchestrator itself (5.9k lines) is large but its dependencies are through explicit contracts. It's a Gate 9 decomposition target, not a Gate 5 seam issue.

---

## 5. Daemon Decomposition Readiness

### 5.1 Prerequisites Check

| Prerequisite | Status |
|-------------|--------|
| Gateway ↔ LLM seam exists | YES — `ChatExecutorConfig` contract |
| Approval transport vs policy split | YES — separate modules |
| Background-run control-plane contract | YES — 8 modules, ~6k test lines |
| Subagent orchestration contract | YES — 8 modules, ~7k test lines |
| First proven seam | YES — `createSessionToolHandler` (Gate 4) |

### 5.2 Decomposition Assessment

`daemon.ts` (10,696 lines) is the composition root. It wires:
- Channel plugins
- ChatExecutor construction
- Tool handler factory
- Session management
- Approval engine
- Background-run supervisor
- Subagent orchestrator
- Memory pipeline
- Hooks dispatcher
- Cron scheduler
- Voice bridge
- Config watcher
- Health/status endpoints

**Recommendation:** Daemon decomposition is a Gate 9 activity. The prerequisite seams now exist (Gates 4-5 verified). The decomposition should extract wiring responsibilities into focused wiring functions or a builder, not split daemon into separate packages.

---

## 6. Control-Plane Boundary Summary

| Boundary | Seam Type | Status | Decomposition Gate |
|----------|-----------|--------|-------------------|
| Gateway ↔ LLM | Config interface (`ChatExecutorConfig`) | Locked (Gate 3) | Gate 9 |
| Gateway ↔ Tool Handler | Factory contract (`SessionToolHandlerConfig`) | Proven (Gate 4) | Done |
| Approval ↔ Policy | Separate modules | Already split | Done |
| Background-run | 8 modules with tests | Already decomposed | Gate 9 (supervisor) |
| Subagent orchestration | 8 modules with tests | Already decomposed | Gate 9 (orchestrator) |
| Daemon composition | Composition root | Seams exist | Gate 9 |

---

*Gate 5 exit criterion: "runtime control-plane package or internal-boundary planning is based on real seams" — SATISFIED.*

*All control-plane boundaries mapped. All seams verified as real (config interfaces, separate modules, dedicated tests). Daemon decomposition prerequisites met. Internal-boundary planning can proceed in Gate 9 based on these proven seams.*
