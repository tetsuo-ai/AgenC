## Tech Debt Report - 2026-03-14

Scope: operator console / daemon attach path only (`runtime/src/cli/daemon.ts`, `runtime/src/cli/operator-console.ts`, tests).

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None | n/a | n/a | n/a |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None | n/a | n/a | n/a |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Non-`/proc` platforms still rely on best-effort fallback parsing | `runtime/src/cli/daemon.ts` | Linux now reads true argv from `/proc/<pid>/cmdline`, but environments without that interface still have to infer argv from a flat process string, which can remain ambiguous for some shell encodings. | If cross-platform daemon recovery becomes a priority, move process identity into a sidecar/IPC handshake or a platform-native argv query instead of parsing `ps` output. |
| Duplicate daemon identity checks exist in two layers | `runtime/src/cli/operator-console.ts`, `runtime/src/cli/daemon.ts` | `operator-console` now has both PID-file reuse logic and process-scan recovery, while `runStartCommand` still independently rejects duplicate daemons. The behavior is correct, but the split makes future lifecycle changes easier to drift. | Centralize daemon identity resolution behind one shared helper that returns `reuse | conflict | start-new` decisions for both callers. |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Separate daemon identity decision trees | `operator-console.ts`, `daemon.ts` | ~20-40 lines per path | Shared daemon identity resolver reused by attach/start commands |

### Summary
- Total issues: 2
- Estimated cleanup: 2 files
- Recommended priority: unify daemon identity resolution and only pursue a non-`/proc` sidecar if cross-platform process recovery becomes a real requirement.
