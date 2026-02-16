# Tech Debt Report - 2026-02-15 Session 4

## Scope: Issue #1078 — Daemon Lifecycle (PID, Signals, Systemd, Crash Recovery)

### Critical (Fix Now)

| # | Issue | Location | Impact | Suggested Fix |
|---|-------|----------|--------|---------------|
| 1 | `__filename` undefined in ESM build | `cli/daemon.ts:36` | `ReferenceError` at runtime when imported as ESM (`.mjs`). tsup builds both CJS and ESM. | Use `import.meta.url` with `fileURLToPath()` — tsup shims it for CJS |
| 2 | `runStopCommand` returns `1` for clean "not running" paths | `cli/daemon.ts:197,214` | CLI exit code `1` for non-error outcomes; semantically wrong. `runRestartCommand` silently ignores stop result. | Return `0` when daemon is genuinely not running (status: 'ok' paths) |

### High (Fix This Sprint)

| # | Issue | Location | Impact | Suggested Fix |
|---|-------|----------|--------|---------------|
| 3 | `sleep()` duplicated 5 times, no shared utility | `cli/daemon.ts:39`, `task/executor.ts:1154`, `workflow/submitter.ts:336`, `autonomous/agent.ts:1426`, `autonomous/verifier.ts:146` | Maintenance burden; any enhancement (abort signal support) must be done 5 times | Add `sleep()` to `utils/async.ts`, export from `utils/index.ts` |
| 4 | `setupSignalHandlers()` is public with no idempotency guard | `gateway/daemon.ts:231` | Double-registration if called directly (method is public). `AgentRuntime` has a `shutdownHandlersRegistered` guard. | Make `private` or add guard flag |
| 5 | Magic number `3000` in `queryControlPlane` | `cli/daemon.ts:335` | Undiscoverable timeout; conflicts with same-value `STARTUP_POLL_TIMEOUT_MS` | Add `CONTROL_PLANE_TIMEOUT_MS = 3_000` constant |
| 6 | Raw `import('ws')` bypasses `ensureLazyModule` pattern | `cli/daemon.ts:322-325` | Inconsistent with `gateway.ts` which uses `ensureLazyModule('ws', ...)` for same package | Use `ensureLazyModule` or document why not |
| 7 | `generateLaunchdPlist` splits `execStart` on spaces | `gateway/daemon.ts:307` | Paths with spaces produce corrupted plist `<string>` entries | Accept `string[]` for program arguments, or document limitation |
| 8 | `nextHeartbeat: 'N/A'` is a dead stub field | `gateway/daemon.ts:142,227` | Exported in `DaemonStatus` interface, always returns 'N/A'. HeartbeatScheduler (#1081) not yet implemented | Remove until #1081 lands, or mark as `nextHeartbeat?: string` |
| 9 | `outputFormat` on daemon option types is never read | `cli/types.ts:151-175` | Dead field on all 4 daemon option interfaces; adds confusion about formatting responsibility | Remove from daemon option types (context already handles formatting) |

### Medium (Backlog)

| # | Issue | Location | Impact | Suggested Fix |
|---|-------|----------|--------|---------------|
| 10 | `CliStatusCode` type duplicated | `cli/daemon.ts:28`, `cli/index.ts:138` | Two independent `type CliStatusCode = 0 \| 1 \| 2` | Move to `cli/types.ts` |
| 11 | `bin/daemon.ts` re-implements arg parsing | `bin/daemon.ts:10-26` | Different parser than `cli/index.ts::parseArgv`; future CLI options must be added in two places | Reuse `parseArgv` or extract shared parser |
| 12 | Two identical poll-deadline loop structures | `cli/daemon.ts:152-168,218-231` | Structural duplication | Could extract `pollUntil(conditionFn, intervalMs, timeoutMs)` utility |
| 13 | `process.exit()` vs `process.exitCode` inconsistency | `bin/daemon.ts:32,52` vs `bin/agenc-runtime.ts:9` | Hard exit truncates in-flight I/O (logger may not flush) | Use `process.exitCode` pattern from agenc-runtime.ts |
| 14 | No XML escaping in `generateLaunchdPlist` | `gateway/daemon.ts:308-335` | Config paths with `&`, `<`, `>` produce malformed plist | Add XML entity escaping for interpolated values |
| 15 | Signal handlers not removed on `stop()` | `gateway/daemon.ts:231-243` | Handlers accumulate if module used in test harness or embedded context | Store handler refs, remove in `stop()` |
| 16 | `error instanceof Error ? error.message : String(error)` duplicated 32x | Various files | Maintenance burden | Add `toErrorMessage(err: unknown): string` to `utils/` |

### Duplications Found

| Pattern | Locations | Instances | Refactor To |
|---------|-----------|-----------|-------------|
| `sleep(ms)` one-liner | cli/daemon, task/executor, workflow/submitter, autonomous/agent, autonomous/verifier | 5 | `utils/async.ts` |
| `CliStatusCode` type alias | cli/daemon, cli/index | 2 | `cli/types.ts` |
| `error instanceof Error ? error.message : String(error)` | 11 files | 32 | `utils/error.ts` |
| Poll-deadline loop | cli/daemon (2 instances) | 2 | `utils/async.ts::pollUntil()` (optional) |

### Notes

- One tracked TODO in `gateway/session.ts:219` — missing compact hook event (#1056)
- No FIXME or HACK comments in any daemon file
- Export consistency verified: `gateway/index.ts` and `src/index.ts` daemon exports are identical and follow existing patterns
- JSON file I/O in daemon code correctly uses async `fs/promises` — consistent with other gateway modules
- `ws` is listed as optional dependency; the try/catch around `import('ws')` in `queryControlPlane` is correct

### Summary

- Total issues: 16
- Critical: 2 (ESM compatibility, wrong exit codes)
- High: 7
- Medium: 7
- Estimated cleanup: 8 files
- Recommended priority: Fix #1 (`__filename` → `import.meta.url`) and #2 (stop exit codes) before committing
