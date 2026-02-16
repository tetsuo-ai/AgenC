# Tech Debt Report — 2026-02-10 (Session 3)

**Scope:** runtime/src/ after feat/memory-integrated-agent-loop implementation

## Critical (Fix Now)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| (none) | — | — | — |

## High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Duplicate 86_400_000 constant | `llm/executor.ts:74`, `autonomous/agent.ts:39` | TTL change requires editing 2+ files | Extract `DEFAULT_MEMORY_TTL_MS` to shared constants |

## Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Lazy SDK loading pattern duplicated 3x | `llm/grok/adapter.ts`, `llm/anthropic/adapter.ts`, `llm/ollama/adapter.ts` | ~60 lines per adapter; risk of inconsistent error messages | Extract shared `ensureLazyClient()` helper |
| Lazy backend loading pattern duplicated 2x | `memory/sqlite/backend.ts`, `memory/redis/backend.ts` | ~40 lines per backend | Extract shared lazy-backend loader |
| Error.captureStackTrace boilerplate | All 9 error files (~84 instances) | Noise in every error class constructor | Create `BaseError` class with built-in stack capture |
| LLM adapter structural duplication | 3 adapters share identical class shape | Changes to shared behavior require 3-file edits | Consider abstract `BaseLLMAdapter` base class |
| Memory backend structural duplication | 3 backends share `ensureOpen()`, TTL, lifecycle | Changes to shared behavior require 3-file edits | Consider abstract `BaseMemoryBackend` base class |
| Treasury caching duplicated | `autonomous/agent.ts:629-639` + `task/operations.ts` | Protocol config fetch done identically in both | Extract shared treasury-caching helper |

## Duplications Found

| Pattern | Locations | Lines Saved | Refactor To |
|---------|-----------|-------------|-------------|
| `ensureClient()` lazy SDK loading | 3 LLM adapters | ~180 | `llm/lazy-client.ts` helper |
| `ensureDb()`/`ensureClient()` lazy loading | 2 memory backends | ~80 | `memory/lazy-backend.ts` helper |
| `Error.captureStackTrace` boilerplate | 9 error files, ~84 instances | ~84 | `BaseError` class |
| 86_400_000 default TTL | executor.ts + agent.ts | 2 lines | Shared constant |
| Treasury caching | agent.ts + task/operations.ts | ~30 | Shared protocol helper |

## Non-Issues (Verified)

- **`InMemoryBackendConfig` import in builder.ts** — NOT unused (used at lines 70, 392)
- **PDA derivation files** — Already DRY via shared `utils/pda.ts`
- **TODO/FIXME/HACK comments** — None found in source files
- **Deep nesting** — None exceeding 3 levels; effective use of early returns
- **Console.log misuse** — None; all console usage in logger implementation or JSDoc examples
- **Error wrapping patterns** — Consistent across all modules
- **Autonomous agent.ts imports** — All used
- **Builder.ts imports** — All used

## Summary

- **Total actionable items:** 7 (1 high, 6 medium)
- **Files affected:** ~15 (if all medium items addressed)
- **Estimated line savings:** ~376 lines
- **Recommended priority:** Extract `DEFAULT_MEMORY_TTL_MS` to shared constant (high — 2-minute fix, prevents future drift)
- **Tech debt level:** LOW — codebase is well-structured with consistent patterns

## Codebase Health: B+

The main debt is structural duplication in LLM adapters and memory backends (common in adapter/strategy patterns). The new memory integration code follows existing patterns well with no new critical debt introduced.
