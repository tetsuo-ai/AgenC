# Project Gotchas

Pitfalls and patterns discovered during AgenC development.

## 2026-02-18

### PR Cleanup Discipline
Before cleaning local files, check whether they are in the PR diff first:
1. `gh pr view <number> --json files`
2. Remove only files that appear in the PR file list
3. Leave local-only notes and scratch files untouched

### Replay Test Environment Drift
MCP replay tests can fail from environment/runtime import mismatches (for example `@coral-xyz/anchor` `BN` export differences) even when code changes are unrelated. Verify dependency alignment before attributing failures to new patches.


## 2026-02-18
- For anti-spam controls, prefer shared validation helpers instead of duplicating reputation/account-age gates across instructions.

## 2026-02-21

### Desktop Sandbox Module Patterns
- `execFileAsync()` exists in both `gateway/sandbox.ts` and `desktop/manager.ts` — next time extract to `utils/exec.ts` before duplicating
- Container port numbers (9990, 6080) should always be constants, not inline strings in Docker args and port parsing
- When splitting array initializers into `const arr = [...]; arr.push(...)`, watch for `];` vs `);` — the push call needs parenthesis, not bracket
- `err instanceof Error ? err.message : err` pattern repeated 10+ times across desktop module — always extract to a shared `getErrorMessage()` helper early
- Void fire-and-forget promises (e.g. `void this.destroy(id)` in timer callbacks) should always have `.catch()` logging to prevent silent container leaks
