## PR #1041: feat(runtime): add incident role policy and hash-chained audit trail
- **Date:** 2026-02-15
- **Files changed:**
  - runtime/src/policy/incident-roles.ts
  - runtime/src/policy/incident-roles.test.ts
  - runtime/src/policy/audit-trail.ts
  - runtime/src/policy/audit-trail.test.ts
  - runtime/src/policy/index.ts
  - runtime/src/index.ts
  - runtime/src/cli/types.ts
  - runtime/src/cli/index.ts
  - mcp/src/server.ts
  - runtime/docs/replay-cli.md
  - mcp/README.md
- **What worked:** Opt-in enforcement (`--role` / `MCP_OPERATOR_ROLE`) avoided breaking existing workflows; hash-chaining verification tests were straightforward and stable.
- **What didn't:** No persistence/export path for audit entries yet; only in-memory append is implemented.
- **Rule added to CLAUDE.md:** no

## PR #1042: feat(runtime): add operator onboarding and health commands
- **Date:** 2026-02-15
- **Files changed:**
  - runtime/src/cli/onboard.ts
  - runtime/src/cli/onboard.test.ts
  - runtime/src/cli/health.ts
  - runtime/src/cli/health.test.ts
  - runtime/src/cli/index.ts
  - runtime/src/cli/types.ts
  - runtime/docs/replay-cli.md
- **What worked:** Check aggregation + deterministic exit codes kept behavior predictable; mocking `Connection.getSlot()` made RPC reachability tests fast and reliable.
- **What didn't:** Config path resolution is duplicated across CLI modules (minor drift risk).
- **Rule added to CLAUDE.md:** no

