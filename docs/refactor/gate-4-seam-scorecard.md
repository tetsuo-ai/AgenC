# Gate 4 — Seam Scorecard And First Proven Seam

> Produced by the refactor program. Scores every viable seam candidate and selects the first proven seam.

---

## 1. Seam Scorecard

Per Gate 4 requirements, each candidate is scored on: callers, consumer exposure, test coverage, rollback/compatibility path, build/verification blast radius, and schema/state migration risk.

### Blocked Candidates (Gate 4 forbids starting with these)

| Candidate | Reason Blocked |
|-----------|---------------|
| `daemon.ts` decomposition | "must not begin with daemon extraction" |
| `desktop/manager.ts` or `session-router.ts` | "must not begin with desktop extraction" |
| `gateway/approvals.ts` | "must not begin with approvals extraction" |
| `gateway/background-run-*.ts` | "must not begin with background-run extraction" |

### Viable Candidates

| # | Candidate | Lines | Callers | Consumer Exposure | Tests | Rollback Path | Blast Radius | Schema Risk | Score |
|---|-----------|-------|---------|------------------|-------|---------------|-------------|-------------|-------|
| 1 | `tool-handler-factory.ts` | 1,719 | 2 (daemon, voice-bridge) | None (internal gateway) | 71 tests (3,244 lines) | Re-inline factory call | LOW | None | **A** |
| 2 | `workflow/pipeline.ts` (PipelineExecutor) | 511 | 6 (daemon, subagent, executor, types, barrel ×2) | Public export | 26 tests (493 lines) | Keep current import path | MEDIUM | Checkpoint KV schema | **B+** |
| 3 | `chat-executor-planner.ts` | 4,331 | 5 (executor, verifier, verifier-loop, normalization, normalization.test) | None (LLM-internal) | 52 tests (2,152 lines) | Keep current import path | HIGH (4.3k lines) | None | **B** |
| 4 | `chat-executor-types.ts` | 918 | 19 importers | Public types via barrel | 0 (pure types) | N/A | N/A | N/A | **N/A** (types-only, no extraction needed) |
| 5 | `tool-handler-factory-delegation.ts` | 615 | 1 (factory only) | None | 0 tests | Depends on #1 | LOW | None | **C** (blocked by #1) |
| 6 | `background-run-operator.ts` | 285 | 8 | Public export | 5 tests | — | — | — | **BLOCKED** |

### Scoring Criteria

- **A**: Ready now — clean contract, good test coverage, minimal callers, low blast radius, no schema risk
- **B+**: Ready with care — clean contract, good tests, moderate callers, some blast radius
- **B**: Viable but large — clean contract, good tests, but large module means more risk
- **C**: Dependent — requires prerequisite extraction first
- **BLOCKED**: Gate 4 explicitly forbids

---

## 2. Selected Seam: `createSessionToolHandler`

### Why This Seam

| Criterion | Assessment |
|-----------|-----------|
| **Callers** | 2 (daemon.ts, voice-bridge.ts) — minimal blast radius |
| **Consumer exposure** | Internal only — no public-package consumers |
| **Test coverage** | 71 tests (3,244 lines) — strongest of all candidates |
| **Contract** | `SessionToolHandlerConfig` interface (28 typed fields) — explicit, verified |
| **Rollback** | Trivial — re-inline the factory function call |
| **Blast radius** | LOW — only 2 files consume, both already use the contract |
| **Schema/state risk** | NONE — no persistent state, no schema |
| **Already extracted** | Yes (PR #1305) — this is not speculative, it's proven |

### What "Proving The Seam" Means

The seam already exists as code (`createSessionToolHandler` function + `SessionToolHandlerConfig` interface). To "prove" it per Gate 4:

1. **Contract test** — Add a test that validates the `SessionToolHandlerConfig` contract independently of daemon internals
2. **Import verification** — Confirm both consumers (daemon, voice-bridge) use the contract interface, not factory internals
3. **Compatibility check** — Confirm the factory can be called with a minimal config subset without breaking

### What This Gate Does NOT Do

- Does NOT move `tool-handler-factory.ts` to a new package
- Does NOT split it from the gateway directory
- Does NOT change any public exports
- Does NOT introduce new abstractions

It only adds a contract test to prove the seam is real.

---

## 3. Validation Plan

### 3.1 Contract Test

Add `gateway/tool-handler-factory-contract.test.ts` that:
- Imports only `createSessionToolHandler` and `SessionToolHandlerConfig`
- Creates a minimal valid config with mock dependencies
- Verifies the returned `ToolHandler` has the expected shape
- Verifies tool execution flows through the handler correctly
- Does NOT depend on daemon, voice-bridge, or other gateway internals

### 3.2 Import Verification

Grep-verify that both consumers import through the contract:
- `daemon.ts` → `import { createSessionToolHandler, ... } from "./tool-handler-factory.js"`
- `voice-bridge.ts` → `import { createSessionToolHandler, ... } from "./tool-handler-factory.js"`

### 3.3 Rollback Plan

If the contract test reveals problems with the seam:
- Delete the contract test
- Log the failure in REFACTOR-PROGRESS.md
- Fall back to candidate #2 (PipelineExecutor)

---

*Scorecard complete. Seam selected: `createSessionToolHandler`. Next step: add contract test.*
