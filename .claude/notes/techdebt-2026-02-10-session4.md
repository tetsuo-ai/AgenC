# Tech Debt Report - 2026-02-10 (Session 4)

**Context:** Post speculative-execution wiring (PR in progress on `feat/speculative-execution-wiring`)
**Scope:** `runtime/src/` — focused on changed files + broad scan

## Critical (Fix Now)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| LE bigint encoding duplicated 3x | `agent.ts:916-934`, `speculation-adapter.ts:142-164`, `response-converter.ts:22-32` | Maintenance burden, divergence risk | Extract `bigintsToProofHash()` to `utils/encoding.ts` |

## High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `claimAndProcess()` is 90 lines | `autonomous/agent.ts:612-703` | Hard to reason about, test, modify | Split into `verifyClaim()`, `executeSequential()`, `executeSpeculative()` |
| Type cast breaks AgentManager encapsulation | `autonomous/agent.ts:211` | Fragile coupling to internals | Add `getConnection()` / `getProgramId()` to AgentManager |
| Uint8Array → number[] cast repeated | `task/operations.ts:353`, `dispute/operations.ts:258`, `agent.ts` | Inconsistent conversion pattern | Create `toAnchorNumberArray()` in `utils/encoding.ts` |

## Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| LLM adapter structural duplication (~150 lines x3) | `llm/grok/adapter.ts`, `llm/anthropic/adapter.ts`, `llm/ollama/adapter.ts` | Maintenance cost | Extract `BaseLLMProvider` abstract class |
| Memory backend query filtering repeated 3x | `memory/*/backend.ts` | Minor maintenance cost | Extract filter predicate builder |
| `Date.now() / 1000` repeated 25+ times | Multiple files | Minor readability | Add `getCurrentUnixTime()` to `utils/encoding.ts` |
| Type gymnastics in builder | `builder.ts:387-391` | Type safety gap | Use discriminated union with type guards |
| `start()` is 77 lines | `autonomous/agent.ts:204-281` | Complexity | Extract speculation init into `initSpeculation()` |

## Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| LE bigint encoding (3-way) | agent.ts, speculation-adapter.ts, response-converter.ts | ~25 each | `utils/encoding.ts:bigintsToProofHash()` |
| LLM adapter structure | grok/, anthropic/, ollama/ adapters | ~150 each | `llm/base-provider.ts` abstract class |
| Memory query filtering | in-memory, sqlite, redis backends | ~30 each | `memory/query-builder.ts` helper |
| Retry with backoff | agent.ts, proof-pipeline.ts | ~15 each | `utils/retry.ts` (only if 3rd consumer appears) |

## Positive Findings

- 0 TODO/FIXME/HACK comments
- 0 dead code / unreachable branches
- 0 console.log in production code
- Comprehensive error handling with typed error classes
- Shared helpers already exist: `ensureLazyImport()`, `ensureLazyBackend()`, `fetchTreasury()`
- Good constant usage (most magic numbers already extracted)
- Clean test isolation (1718 tests passing)

## Summary

- **Total issues:** 9 (1 critical, 3 high, 5 medium)
- **Estimated cleanup:** 8-10 files
- **Recommended priority:** Extract LE bigint encoding (critical dup introduced by this PR)
- **Overall debt level:** LOW-MEDIUM (well-maintained codebase)
