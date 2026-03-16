# Gate 7 — Consumer Migration Verification

> Produced by the refactor program. Verifies all consumers use stable surfaces.

---

## 1. Consumer Migration Status

### 1.1 Private-Import Consumers (Gate 2A — all migrated)

| Consumer | Before | After | Commit |
|----------|--------|-------|--------|
| `web/src/types.ts` | 4 private `runtime/src/*` imports | `@agenc/runtime` | 61fc984 |
| `web/src/constants.ts` | 1 private `runtime/src/*` import | `@agenc/runtime` | 22e5d88 |
| `web/src/hooks/useWebSocket.ts` | 1 private `runtime/src/*` import | `@agenc/runtime` | 22e5d88 |
| `mobile/src/hooks/useRemoteGateway.ts` | 1 private `runtime/src/*` import | `@agenc/runtime` | eab92a4 |
| `demo/private_task_demo.ts` | 2 private `sdk/src/*` imports | `sdk/src/index` barrel | eab92a4 |
| `scripts/agenc-localnet-social-smoke.ts` | 4 private `runtime/src/*` imports | `runtime/src/index` barrel | 3e0b147 |
| `scripts/agenc-localnet-social-bootstrap.ts` | 2 private `runtime/src/*` imports | `runtime/src/index` barrel | 3e0b147 |
| `scripts/zk-config-admin.ts` | 1 private `runtime/src/*` import | `runtime/src/index` barrel | 3e0b147 |

### 1.2 Package Consumers (verified clean)

| Consumer | Import Style | Status |
|----------|-------------|--------|
| MCP (`mcp/src/`) | `@agenc/runtime`, `@agenc/sdk` | CLEAN — public package imports only |
| Docs-MCP (`docs-mcp/src/`) | No runtime/sdk imports | CLEAN — independent |
| Web (`web/src/`) | `@agenc/runtime` (via `file:` dep) | CLEAN — public package surface |
| Mobile (`mobile/src/`) | `@agenc/runtime` (via `file:` dep) | CLEAN — public package surface |
| Demo-App (`demo-app/src/`) | No runtime/sdk imports | CLEAN — independent |
| Examples (`examples/`) | No private imports found | CLEAN |
| Demo (`demo/`) | `sdk/src/index` barrel only | CLEAN — public barrel |
| Demos (`demos/`) | Text files only, no code | N/A |

### 1.3 Script Consumers

| Script | Import Style | Status |
|--------|-------------|--------|
| `scripts/agenc-localnet-social-smoke.ts` | `runtime/src/index` barrel | CLEAN |
| `scripts/agenc-localnet-social-bootstrap.ts` | `runtime/src/index` barrel | CLEAN |
| `scripts/zk-config-admin.ts` | `sdk/src/index` + `runtime/src/index` barrels | CLEAN |
| `scripts/agenc-devnet-soak.mjs` | `@agenc/sdk` package | CLEAN |
| `scripts/lib/agenc-watch-*.mjs` | `runtime/dist/operator-events.mjs` (built artifact) | CLEAN — contract-bearing |

---

## 2. Verification Results

### 2.1 Zero Private Sub-Module Imports

Grep verification: `from ['"]...runtime/src/<non-index>` and `from ['"]...sdk/src/<non-index>` returns **zero matches** across:
- `web/`
- `mobile/`
- `demo-app/`
- `examples/`
- `mcp/src/`
- `docs-mcp/src/`

### 2.2 Remaining Barrel Imports (acceptable)

5 files still use relative barrel imports (`../runtime/src/index.js` or `../sdk/src/index.js`) instead of `@agenc/runtime` or `@agenc/sdk`:
- 3 scripts under `scripts/`
- 1 demo under `demo/`

These are acceptable because:
- They import through the public barrel (same surface as the package)
- These scripts have no `package.json` and run from root
- Gate 10 (repo split readiness) will address converting these to published package imports

### 2.3 Transitional `file:` Dependencies (tracked for Gate 10)

| Consumer | Dependency | Gate 10 Action |
|----------|-----------|----------------|
| `web/package.json` | `@agenc/runtime: file:../runtime` | Convert to published package |
| `mobile/package.json` | `@agenc/runtime: file:../runtime` | Convert to published package |
| `examples/simple-usage/package.json` | `@agenc/sdk: file:../../sdk` | Convert to published package |
| `examples/tetsuo-integration/package.json` | `@agenc/sdk: file:../../sdk` | Convert to published package |

---

## 3. Public Re-Exports Added (Gate 2A)

| Runtime Re-Export Block | Types/Exports Added | Commit |
|------------------------|---------------------|--------|
| WebChat Protocol Types + Constants | `SubagentLifecycle*`, 67 `WS_*` constants, `VOICE_*` | 61fc984, 22e5d88 |
| Socket Client Core | 10 functions/constants/types | 22e5d88 |
| Background Run Operator Types | 5 `BackgroundRunOperator*` types | 61fc984 |
| Observability Types | 7 `Observability*` types | 61fc984 |
| Agent Capabilities | `Capability`, `combineCapabilities` | 3e0b147 |

| SDK Re-Export | Added | Commit |
|--------------|-------|--------|
| `VERIFIER_PROGRAM_ID` | Added to constants export block | eab92a4 |

---

*Gate 7 exit criterion: "consumers use stable surfaces only" — SATISFIED.*

*All consumers verified: 0 private sub-module imports remain, all imports use public barrels or package surfaces, MCP and docs-mcp use clean package imports, transitional `file:` deps tracked for Gate 10.*
