# Tech Debt Report - 2026-02-05 (Session 2 - End of Day Scan)

## Executive Summary

Follow-up scan after comprehensive tech debt cleanup (#767) and feature additions (#765, #766) from earlier today.

**Overall Quality Grade:** B+
**Total Issues Found:** 21 (0 critical, 2 high, 8 medium, 11 low)
**No regressions from earlier cleanup.**

---

## Critical (Fix Now)

None. Previous critical issues (path validation, execSync error handling) remain resolved.

---

## High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Unsafe `as unknown as Record` casts in MCP tools | `mcp/src/tools/{inspector,agents,protocol,tasks,disputes}.ts` (12 occurrences) | Runtime crashes if Anchor account format changes | Add runtime validation before field access, or use Anchor's typed account accessors |
| Demo proofs misleading | `examples/tetsuo-integration/index.ts:320-324` | Zero-filled fake proofs could be copied to production | Add prominent `// DEMO ONLY` comments and runtime warning |

---

## Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Long handler: expire_dispute | `expire_dispute.rs` (392 lines) | Hard to review, ~297 non-test lines | Extract refund and worker account processing into helpers |
| Long handler: initiate_dispute | `initiate_dispute.rs` (298 lines) | Hard to review | Extract validation steps into helper functions |
| Large TaskExecutor class | `runtime/src/task/executor.ts` (1186 lines) | Multiple responsibilities in single class | Split into ExecutorCore + DiscoveryLoop + MetricsCollector |
| Inconsistent remaining_accounts validation | `cancel_task.rs`, `resolve_dispute.rs`, `complete_task.rs` | Different patterns for same operation | Create shared `validate_and_borrow_account()` helper |
| Missing runtime integration tests | `runtime/` package (#124) | No e2e tests with validator | Implement per issue tracking |
| Large test file | `tests/coordination-security.ts` (1988 lines) | Slow IDE, hard to navigate | Split into logical groups (auth, funds, state) |
| Demo app Step components duplication | `demo-app/src/components/steps/Step*.tsx` (6 files) | Identical Props interface + processing pattern in all 6 | Extract shared `StepProps` type and `useStepProcessing` hook |
| MCP transaction message manipulation | `mcp/src/tools/inspector.ts:595,612` | Fragile casts for `accountKeys`/`instructions` arrays | Use Solana SDK typed accessors |

---

## Low (Nice to Have)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Commented-out production code | `demo/`, `examples/` | Misleading | Remove or document |
| Test unwraps without messages | `completion_helpers.rs:252-454` (in `#[cfg(test)]`) | Poor failure messages in test output | Add `.expect("description")` |
| Safe unwraps fragile | `resolve_dispute.rs:402-404` | Depends on count check 8 lines earlier | Use `.expect("verified count == 3 above")` |
| Double type assertions in test mocks | `sdk/src/__tests__/queries.test.ts:119+` | Masks type issues | Use properly typed mocks |
| Hardcoded RPC timeout in demo | `demo-app/src/App.tsx:132-134` | Not configurable | Extract to config |
| Incomplete ASCII diagram | `runtime/src/task/dependency-graph.test.ts:729` | Documentation clarity | Complete the diagram |
| Deep nesting in dependency validation | `complete_task.rs:98-133` | Readability | Extract to helper |
| Local PDA helpers in test_1.ts | `tests/test_1.ts:50-76` | 2-arg versions differ from test-utils 3-arg | Deferred - 400+ call sites, too risky |
| Rate limit wrapper functions | `rate_limit_helpers.rs:229-256` | Unnecessary indirection | Keep (intentional backwards compat) |
| Large test file | `tests/test_1.ts` (8272 lines) | Very slow IDE | Consider splitting by instruction category |

---

## Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Task completion flow | `complete_task.rs` + `complete_task_private.rs` | ~120 | Extract `execute_completion()` shared workflow |
| Account owner validation + borrow | `cancel_task.rs`, `resolve_dispute.rs`, `complete_task.rs` | ~24 (8 each) | `validate_and_deserialize<T>()` utility |
| Step component boilerplate | 6 `Step*.tsx` files | ~90 | Shared `StepProps` + `useStepProcessing` hook |
| Local PDA helpers | `test_1.ts` vs `test-utils.ts` | ~27 | Deferred (too many call sites) |

**Previously Resolved Duplications (still resolved):**
- Task init logic -> `task_init_helpers.rs`
- Test constants -> all import from `test-utils.ts`
- Path validation -> `validation.ts`
- Version check duplication -> removed

---

## Code Quality Metrics

| Metric | Count | Threshold | Status | Change |
|--------|-------|-----------|--------|--------|
| Functions >200 lines | 2 | 0 | WARN | No change |
| Functions >50 lines | 3 | <5 | OK | No change |
| Duplicated blocks >10 lines | 3 | 0 | WARN | No change |
| Magic numbers | 4 | 0 | WARN | No change |
| TODO/FIXME comments | 0 | <10 | OK | Clean |
| Dead code (commented blocks) | 4 | 0 | WARN | No change |
| Security vulnerabilities | 0 | 0 | OK | Clean |
| Deep nesting (>3 levels) | 2 | 0 | WARN | No change |

---

## Codebase Health Since Last Scan

**New code added (since session 1):**
- Autonomous agent module (`runtime/src/autonomous/`) - clean, well-structured
- ZK verifying key security improvements - proper mainnet readiness checks
- Tech debt PR #767 merged - comprehensive cleanup

**No new tech debt introduced.** All new code follows established patterns.

---

## Recommended Priority Order

1. **This week:** MCP unsafe type casts (high - 12 occurrences of `as unknown as Record` without validation, runtime crash risk)
2. **This week:** Demo proofs misleading (high - someone could copy to production)
3. **Next sprint:** Long dispute handlers (medium - extract helpers to match resolve_dispute pattern)
4. **Next sprint:** TaskExecutor class split (medium - 1186 lines is unwieldy)
5. **Backlog:** Step component dedup, test file splitting, test_1.ts PDA helpers

---

## Summary

- **Total remaining issues:** 21 (0 critical, 2 high, 8 medium, 11 low)
- **No new tech debt** from today's feature additions
- **Previous cleanup holds** - all 14 previously resolved issues remain resolved
- **Codebase is in good shape** for continued development
