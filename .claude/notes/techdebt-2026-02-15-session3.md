## Tech Debt Report - 2026-02-15 (Session 3)

**Scope:** Gateway message format (#1051) — `runtime/src/gateway/message.ts` + barrel exports

### Critical (Fix Now)

*None*

### High (Fix This Sprint)

*None*

### Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Validation accumulation pattern duplicated | `config-watcher.ts:57-140` + `message.ts:130-188` | Will triple with Phase 1.3 channel validators | Extract shared validation framework to `utils/validation.ts` before Phase 1.3 |
| Inconsistent error shape between validators | `validateGatewayMessage` returns `{ errors: string[] }`, `validateAttachment` returns `{ reason?: string }` | Minor API inconsistency | Document as design decision (per-element vs aggregate) or align both to `errors[]` |

### Low (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `createOutboundMessage` is pure passthrough | `message.ts:117-119` | No added value over object literal | Add validation or remove; currently harmless as API anchor for future streaming |
| Unsafe `as GatewayConfig` cast after validation | `config-watcher.ts:48` | Type-safe only if validation is exhaustive | Add type predicate `isValidGatewayConfig()` |
| Repeated non-empty string checks | `message.ts:141-159` (5 fields) | Boilerplate | Extract `requireNonEmptyString()` helper (absorbed by validation framework) |

### Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Error accumulation validator | `config-watcher.ts`, `message.ts` | ~140 combined | `utils/validation.ts` framework |
| Null/object type guard | `config-watcher.ts:62`, `message.ts:135` | 2 each | Absorbed by validation framework |
| `{ valid: errors.length === 0, errors }` return | `config-watcher.ts:139`, `message.ts:187` | 1 each | `validationResult()` helper |

### Clean Areas

- Zero TODO/FIXME/HACK comments
- No stale/unused exports
- No circular dependencies (clean DAG)
- Barrel export patterns consistent with memory/proof/dispute modules
- Error classes follow RuntimeError conventions
- Test helpers follow module conventions

### Summary

- **Total issues:** 5
- **Estimated cleanup:** 2-3 files (validation framework extraction)
- **Recommended priority:** Extract validation framework before Phase 1.3 (#1058) adds channel validators
- **Overall grade:** A- (very clean, one moderate abstraction opportunity)
