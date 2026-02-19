# Tech Debt Report - 2026-02-10 (Session 5)

## Critical (Fix Now)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Fire-and-forget promises untracked | `runtime/src/autonomous/agent.ts:482,574,605` | Silent error swallowing in background tasks | Add `pendingOperations` set to track + surface errors |
| External tool exec without pre-validation | `sdk/src/privacy.ts:271-301` | Runtime crash if risc0-host-prover/risc0-host-prover missing | Always call `checkToolsAvailable()` before `execSync()` |

## High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Task completion logic duplicated 80+ lines | `complete_task.rs` vs `complete_task_private.rs` | Bug risk from diverging copies | Extract `execute_task_completion()` shared helper |
| Task creation logic duplicated 70+ lines | `create_task.rs` vs `create_dependent_task.rs` | Bug risk from diverging copies | Create parametrizable `create_task_internal()` helper |
| PDA derivation duplicated across 4 modules | `test-utils.ts`, `agent/pda.ts`, `task/pda.ts`, `dispute/pda.ts` | 40+ duplicated lines | Centralize in single barrel, import from runtime in tests |
| AutonomousAgent god object (1035 lines) | `runtime/src/autonomous/agent.ts` | Hard to test/maintain | Split into coordinator + ProofManager + TaskExecutionOrchestrator |
| SpeculativeExecutor complexity (840 lines) | `runtime/src/task/speculative-executor.ts` | Complex multi-level speculation hard to maintain | Extract concern-specific helpers |
| Poll loop error handling too permissive | `runtime/src/autonomous/agent.ts:544-546` | Failed cycles silently logged, no escalation | Add failure counter + backoff + event emission |

## Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Account owner validation repeated | 3 Rust instruction files | 12+ duplicated lines | Extract `validate_account_owner()` helper |
| Account data borrow/deser/drop pattern | 3 Rust instruction files | 30+ duplicated lines | Extract `deserialize_account_data<T>()` wrapper |
| Fee/reputation constants scattered | `completion_helpers.rs`, `slash_helpers.rs` | Constants defined in multiple places | Consolidate in `constants.rs` |
| Deep nesting in `handleDiscoveredTask` | `runtime/src/autonomous/agent.ts:552-576` | Readability | Extract `isTaskAlreadyTracked()` and `canExecutorHandleTask()` |
| Deep nesting in dispute resolution | `resolve_dispute.rs:200-350` | Readability | Extract `process_votes()` and `process_payments()` |
| Magic placeholder task object | `runtime/src/autonomous/agent.ts:414-436` | Fragile hardcoded zeros | Extract `createPlaceholderTask()` factory |
| Task priority via sort on every cycle | `runtime/src/autonomous/agent.ts:588-590` | O(n log n) per poll when priority queue is O(log n) | Replace Map+sort with PriorityQueue |
| Inconsistent PDA derivation patterns | Various instruction + test files | 3 different patterns | Enforce runtime SDK helpers everywhere |
| Dynamic account access with type cast | `sdk/src/privacy.ts:395` | Type safety bypassed | Use typed `program.account.task.fetch()` |
| Optional deps not pre-validated | `runtime/src/memory/sqlite/`, `redis/` | Confusing runtime error if dep missing | Already mitigated with lazy import + try/catch (OK) |
| Hardcoded `DEFAULT_MEMORY_TTL_MS` | `runtime/src/autonomous/agent.ts:49` | Not aligned with SDK constants | Import from centralized constants |

## Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Task completion flow (fee calc, reward split, state updates, events) | `complete_task.rs`, `complete_task_private.rs` | ~80 | `execute_task_completion()` in `completion_helpers.rs` |
| Task creation flow (version check, rate limit, escrow transfer, init) | `create_task.rs`, `create_dependent_task.rs` | ~70 | `create_task_internal()` in `task_init_helpers.rs` |
| PDA derive/find wrapper pairs | `test-utils.ts`, `agent/pda.ts`, `task/pda.ts`, `dispute/pda.ts` | ~40 | Centralize + re-export from barrel |
| Account data borrow-deser-drop-borrow_mut-ser | `complete_task.rs`, `dispute_helpers.rs` (x2) | ~30 | `deserialize_account_data()` + `update_account_data()` |
| Account owner validation (`require!(owner == &crate::ID)`) | `complete_task.rs`, `dispute_helpers.rs` (x2) | ~12 | `validate_account_owner()` |
| Capability constants | `test-utils.ts`, `runtime/capabilities.ts` | ~10 | Import from `@agenc/runtime` in tests |
| Error validation blocks (task state, competitive check, claim check) | `complete_task.rs`, `complete_task_private.rs` | ~30 | Extract `validate_task_ready_for_completion()` |

## Positive Findings

- **No TODO/FIXME/HACK comments** in production code
- **No commented-out code** blocks
- **No unused imports** detected
- **No dead code** (beyond one minor placeholder pattern)
- **Existing dedup work** (PR #779-782) successfully eliminated many prior duplications
- **`test-setup.ts`** already centralizes most test infrastructure
- **Lazy loading pattern** consistently applied across optional deps
- **Error classes** well-structured with specific RuntimeErrorCodes

## Summary

- **Total issues:** 19 (2 critical, 6 high, 11 medium)
- **Total duplicated lines:** ~380+
- **Estimated cleanup:** ~15 files
- **Recommended priority:** Task completion/creation dedup in Rust (highest bug risk from diverging copies)

## Comparison with Previous Reports

Previous tech debt items **resolved since last report:**
- Memory-integrated agent loop shipped (PR #782)
- Shared helpers (`ensureLazyImport`, `ensureLazyBackend`, `fetchTreasury`) consolidated
- `RuntimeError` base class `captureStackTrace` fixed
- Duplicate `TaskExecutor` export resolved

**Recurring items** (still open from earlier reports):
- Task completion/creation Rust duplication (flagged since session 3)
- AutonomousAgent size (growing - was ~800 lines, now 1035)
- PDA derivation duplication across test/runtime boundaries
