## Phase 5 Desktop Process Handle Contract

- **Date:** 2026-03-08
- **Scope:** `containers/desktop/server/src/tools.ts`, `containers/desktop/server/src/tools.test.ts`, generated desktop tool definitions, and desktop prompt guidance in `runtime/src/gateway/daemon.ts`.

### What Was Fixed

- Added first-class `idempotencyKey` support to `desktop.process_start/status/stop` so the desktop managed-process family now matches the durable handle identity model already used by host processes and browser sessions.
- Separated `label` from `idempotencyKey` semantics in the desktop server. `label` is now a stable human-readable handle, while `idempotencyKey` deduplicates repeated start requests.
- Added deterministic lookup ordering for desktop managed processes: `processId` first, then `idempotencyKey`, then `label`, then `pid`.
- Tightened desktop process dedupe/conflict behavior:
  - identical retries with the same `idempotencyKey` reuse the running handle
  - conflicting retries with the same `idempotencyKey` fail explicitly
  - conflicting concurrent starts with the same `label` fail explicitly instead of silently reusing the wrong running process
- Added record/event/response propagation for `idempotencyKey`, plus backward-compatible load behavior for persisted desktop process registries.
- Regenerated `runtime/src/desktop/tool-definitions.ts` and updated daemon desktop guidance so the runtime-visible tool catalog and prompt contract do not drift from the server implementation.

### Validation

- `npm --prefix containers/desktop/server test`
- `npm --prefix runtime test -- src/gateway/background-run-supervisor.test.ts src/gateway/tool-routing.test.ts src/desktop/rest-bridge.test.ts`
- `npm --prefix runtime run typecheck`
- `git diff --check`

### Remaining Debt

- **Medium:** Phase 5 still has broader roadmap debt outside the managed-process/browser families. Downloads/uploads, web servers, remote MCP jobs, code sandboxes, and long-running research handles still need the same durable handle contract.
- **Medium:** The repo still does not have one universal compliance suite that every long-lived tool family must pass across package boundaries. Host/browser and desktop families are now covered, but the full cross-family gate is still roadmap work.
- **Medium:** Resource envelopes and the broader structured error taxonomy are still not standardized across every long-lived tool family.

### Verdict

- No critical or high debt remains in the desktop managed-process contract surface.
- The remaining work is broader Phase 5 roadmap debt, not cleanup debt introduced by this slice.
