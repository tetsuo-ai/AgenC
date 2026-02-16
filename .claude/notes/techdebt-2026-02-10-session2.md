# Tech Debt Report - 2026-02-10 (Post AgentBuilder)

Scope: `runtime/src/` — focused on builder.ts changes + surrounding modules.

## Critical (Fix Now)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `build()` method is 108 lines | `builder.ts:276-383` | Hard to test individual concerns, SRP violation | Extract `buildToolRegistry()`, `buildExecutor()`, `buildMemoryBackend()` private helpers |

## High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Wallet conversion duplicated 3x | `runtime.ts:98`, `agent.ts:147`, `builder.ts:289` | Changes need 3 edits | Add `ensureWallet()` to `types/wallet.ts` |
| Lazy SDK loading duplicated 5x | `grok/adapter.ts:132`, `anthropic/adapter.ts:135`, `ollama/adapter.ts:113`, `sqlite/backend.ts:276`, `redis/backend.ts:279` | ~100 lines repeated | Create `utils/lazy-loader.ts` factory |
| Treasury caching duplicated | `task/operations.ts:465`, `dispute/operations.ts:563` | Identical pattern, 2 files | Extract shared `ProtocolConfigCache` utility |
| LLM error mapping duplicated 3x | `grok/adapter.ts:212`, `anthropic/adapter.ts:258`, `ollama/adapter.ts:187` | ~75 lines repeated, Grok+Anthropic 100% identical | Extract `mapLLMError()` to `llm/errors.ts` |
| AutonomousAgent treasury has no caching | `agent.ts:693-695` | Extra RPC call per private completion | Reuse treasury caching pattern from TaskOperations |
| Magic numbers for timeouts/retries | `agent.ts:137-144`, `agent.ts:218` | Scattered defaults, no single source of truth | Create constants: `DEFAULT_SCAN_INTERVAL_MS`, `TASK_SHUTDOWN_TIMEOUT_MS`, etc. |

## Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `claimAndProcess()` 67 lines | `agent.ts:444-510` | Mixes claim/execute/complete/stats/callbacks | Extract `recordSuccess()`, `recordFailure()` helpers |
| `completeTaskPrivate()` 66 lines | `agent.ts:652-717` | Complex conditional (ProofEngine vs SDK) | Consider extracting `generateProofForTask()` |
| Retry wrapper boilerplate | `agent.ts:515-531` | 3 trivial wrappers delegating to `withRetry()` | Remove wrappers, call `withRetry()` directly |
| PDA caching inconsistent | task/operations vs dispute/operations vs agent | Lazy vs eager vs none | Standardize on constructor-time for static PDAs |
| Streaming methods in LLM adapters | `anthropic/adapter.ts:48` (71 lines), `grok/adapter.ts:58` (63 lines) | Complex but stable vendor protocol code | Acceptable for now; extract if adding more providers |

## Duplications Found

| Pattern | Locations | Dup Lines | Refactor To |
|---------|-----------|-----------|-------------|
| `isKeypair(w) ? keypairToWallet(w) : w` | runtime.ts, agent.ts, builder.ts | ~18 | `ensureWallet()` in wallet.ts |
| `ensureClient()` / `ensureDb()` lazy import | 3 LLM adapters + 2 memory backends | ~100 | `lazyLoadSDK()` in utils/ |
| Treasury cache + fetch | task/operations.ts, dispute/operations.ts | ~20 | Shared `ProtocolConfigCache` |
| `mapError()` in LLM adapters | grok, anthropic, ollama | ~75 | `mapLLMError()` in llm/errors.ts |
| memcmp query pattern | task/operations.ts, dispute/operations.ts | 0 (already abstracted via `queryWithFallback`) | N/A |

## Clean Areas

- Zero TODO/FIXME/HACK comments
- Zero dead code / unused exports
- Zero missing error handling
- All test files pass (1691 tests)
- New builder.test.ts has 36 tests with error resilience coverage

## Summary

- **Total issues:** 12 (1 critical, 6 high, 5 medium)
- **Estimated duplicated lines:** ~213
- **Lines saved after refactor:** ~110-140
- **Estimated cleanup effort:** 2-3 hours across 11 files
- **Recommended priority:** Extract `ensureWallet()` (15 min, highest ROI)

## What's New Since Last Report

- `builder.ts` `build()` method is longest new function at 108 lines — should be split
- Wallet conversion pattern now appears 3x (was 2x before builder)
- ProofEngine integration adds conditional branching in `completeTaskPrivate()`
- No new TODO/FIXME/dead code introduced
