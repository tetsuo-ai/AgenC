# Gate 2B — Verification Matrix And Artifact Ownership

> Produced by the refactor program. Locks contract authority and tooling surfaces for later gates.

---

## 1. Repo-Wide Verification Matrix

### 1.1 Core Package Build Closure (MUST be green at every gate)

| Package | Build | Typecheck | Test | Gate Owner |
|---------|-------|-----------|------|------------|
| SDK | `cd sdk && npm run build` | `cd sdk && npm run typecheck` | `cd sdk && npm run test` | SDK |
| Runtime | `cd runtime && npm run build` | `cd runtime && npm run typecheck` | `cd runtime && npm run test` | Runtime |
| MCP | `cd mcp && npm run build` | `cd mcp && npm run typecheck` | `cd mcp && npm run test` | MCP |
| Docs-MCP | `cd docs-mcp && npm run build` | `cd docs-mcp && npm run typecheck` | N/A | Docs-MCP |

**Orchestrator:** `npm run build` (root) builds all 4 in dependency order.

### 1.2 App Consumer Verification (MUST be green when touched)

| Surface | Build | Typecheck | Test | Gate Owner |
|---------|-------|-----------|------|------------|
| Web | `cd web && npm run build` | via `tsc` in build | `cd web && npm run test` + e2e | Web |
| Mobile | N/A (Expo) | `cd mobile && npm run typecheck` | N/A (minimum gate) | Mobile |
| Demo-App | `cd demo-app && npm run build` | via `tsc` in build | N/A | Demo-App |

### 1.3 Packaged Example Verification (SHOULD be green when touched)

| Example | Build/Run | Deps | Gate Owner |
|---------|----------|------|------------|
| `simple-usage` | `cd examples/simple-usage && npx tsx index.ts` | `@agenc/sdk` (file:) | Examples |
| `tetsuo-integration` | `cd examples/tetsuo-integration && npx tsx index.ts` | `@agenc/sdk` (file:) | Examples |
| `helius-webhook` | `cd examples/helius-webhook && npx tsx index.ts server` | No @agenc deps | Examples |

### 1.4 Platform Verification (MUST be green when touched)

| Surface | Build | Test | Gate Owner |
|---------|-------|------|------------|
| Desktop Server | `cd containers/desktop/server && npm run build` | `cd containers/desktop/server && npm run test` | Desktop Platform |
| Desktop Image | `docker build -t agenc/desktop:latest containers/desktop/` | Health check | Desktop Platform |
| Anchor Program | `anchor build` | `npm run test:fast` (LiteSVM) + `npm run test:anchor` | Protocol |
| zkVM Host | `cargo test --manifest-path zkvm/host/Cargo.toml` | Included in `cargo test` | Proof |

### 1.4 Extended Verification (SHOULD be green, tracked)

| Surface | Command | Gate Owner |
|---------|---------|------------|
| Runtime benchmarks | `cd runtime && npm run benchmark` | Runtime |
| Runtime mutation gates | `cd runtime && npm run mutation:gates` | Runtime |
| Pipeline quality gates | `cd runtime && npm run benchmark:pipeline:gates` | Runtime |
| Background-run quality | `cd runtime && npm run benchmark:background-runs:gates` | Runtime |
| Delegation quality | `cd runtime && npm run benchmark:delegation:gates` | Runtime |
| Fuzz targets (8) | `cargo fuzz run <target>` | Protocol |
| Real-proof e2e | `tests/e2e-real-proof.ts` | Proof |
| Verifier localnet | `scripts/setup-verifier-localnet.sh` | Proof |
| API breaking changes | `scripts/check-breaking-changes.ts` | Operational |
| IDL drift | `runtime/scripts/check-idl-drift.ts` | Operational |

---

## 2. Artifact-Chain Ownership

### 2.1 Anchor IDL / Types Artifact Chain

```
anchor build
  → target/idl/agenc_coordination.json     (generated, source of truth)
  → target/types/agenc_coordination.ts     (generated, camelCase types)
      ↓ runtime/scripts/copy-idl.js
  → runtime/idl/agenc_coordination.json    (copied, runtime-local)
      ↓ manual sync
  → runtime/src/types/agenc_coordination.ts (manual copy, Program<T> generic)
```

**Owner:** Protocol (generation) + Runtime (consumption)
**Gate:** `runtime/scripts/check-idl-drift.ts` detects divergence
**Rule:** After `anchor build`, run `npm run prebuild` in runtime to sync

### 2.2 Verifier-Router IDL

```
External: boundless-xyz/risc0-solana tag v3.0.0
  → scripts/idl/verifier_router.json      (pinned copy)
  → scripts/setup-verifier-localnet.sh     (uses it for localnet bootstrap)
  → scripts/setup-verifier-localnet.ts     (TypeScript bootstrap)
  → tests/mock-router/                     (mock program for testing)
```

**Owner:** Proof
**Gate:** Pinned at tag v3.0.0. Update requires explicit version bump + re-test
**Rule:** Changes require `tests/e2e-real-proof.ts` and mock-router rebuild

### 2.3 Desktop Tool Definitions Codegen

```
containers/desktop/server/src/toolDefinitions.ts  (SOURCE OF TRUTH - 19 tools)
      ↓ runtime/scripts/generate-desktop-tool-definitions.ts
runtime/src/desktop/tool-definitions.ts            (GENERATED MIRROR)
```

**Owner:** Desktop Platform
**Gate:** Codegen script must be run after toolDefinitions.ts changes
**Rule:** Never edit `runtime/src/desktop/tool-definitions.ts` directly

### 2.4 API Baselines

```
docs/api-baseline/sdk.json      (875 lines)
docs/api-baseline/runtime.json  (3841 lines)
docs/api-baseline/mcp.json      (7 lines)
      ↑ scripts/check-breaking-changes.ts
```

**Owner:** Operational (cross-cutting)
**Gate:** `scripts/check-breaking-changes.ts` checks for drift
**Rule:** Any public export change must update the relevant baseline

### 2.5 Runtime Operator-Event Built Artifact

```
runtime/src/channels/webchat/operator-events.ts   (source)
      ↓ npm run build (runtime)
runtime/dist/operator-events.mjs                   (BUILT ARTIFACT)
      ↓ dynamic import via agenc-watch-runtime.mjs
scripts/lib/agenc-watch-*.mjs                      (consumers)
```

**Owner:** Runtime (source) + Scripts/Watch (consumer)
**Gate:** Runtime build must precede watch TUI usage
**Required exports:** `normalizeOperatorMessage`, `shouldIgnoreOperatorMessage`, `projectOperatorSurfaceEvent`

---

## 3. Canonical Workspace/Build Authority

### 3.1 Root Package Identity

The root `package.json` is `grid-router-ts` — a SEPARATE TOOL, not the AgenC orchestrator.

**AgenC build orchestration** is handled by:
- Root `npm run build` → delegates to `npm run build --prefix sdk && npm run build --prefix runtime && npm run build --prefix mcp && npm run build --prefix docs-mcp` (defined as npm script, not workspace)
- Root `npm run test` → same delegation pattern
- Root `npm run typecheck` → same delegation pattern

**Rule:** The root `package.json` scripts for `build`, `test`, `typecheck` are the canonical AgenC orchestrator commands even though the root package name is `grid-router-ts`.

### 3.2 Build Dependency Order

```
1. sdk (no internal deps)
2. runtime (depends on sdk via file:../sdk)
3. mcp (depends on sdk + runtime)
4. docs-mcp (no runtime/sdk deps at package level)
```

### 3.3 CI Contract

Current enforcement is entirely through local scripts and package commands. `.github/workflows/` has been removed. CI gates live in:
- Package build/test/typecheck scripts
- `scripts/check-breaking-changes.ts`
- `runtime/scripts/check-idl-drift.ts`
- `runtime/scripts/check-mutation-gates.ts`
- `runtime/scripts/check-pipeline-gates.ts`
- `runtime/scripts/check-background-run-gates.ts`

---

## 4. Ownership Clarifications

### 4.1 Desktop Tool-Routing and Session-Service

**Owner:** Desktop Platform (runtime/src/desktop/)
- `session-router.ts` (1257 lines) — tool routing across desktop, Playwright, MCP
- `manager.ts` (1072 lines) — container lifecycle
- Both require Gate 6 contract stabilization before decomposition

### 4.2 App-Facing Read Models

**Owner:** Runtime (public exports via Gate 2A migration)
- Gateway status, background-run, observability types now re-exported from `@agenc/runtime`
- Web and mobile consume through public package surface
- Approval read models: `ApprovalEngine` in `gateway/approvals.ts`

### 4.3 Mobile Adapter Contract

**Owner:** Mobile
- Current minimum gate: `typecheck` only
- No unit tests, no build step beyond Expo
- Stronger validation plan deferred to Gate 8

### 4.4 Operator-Console/Watch Subsystem

**Owner:** Scripts/Watch
- Composition root: `scripts/lib/agenc-watch-app.mjs` (3018 lines, decomposition target)
- Runtime coupling: built `runtime/dist/operator-events.mjs` artifact
- Test coverage: ~40 test files under `scripts/agenc-watch-*.test.mjs`
- Runtime CLI coupling: `runtime/src/cli/operator-console.ts` launches watch

### 4.5 Docs-MCP Scope

**Indexed corpus (confirmed in `docs-mcp/src/server.ts` scope manifest):**
- `docs/**/*.md` and `docs/**/*.json` (architecture docs, API baselines)
- `runtime/docs/**/*.md` (runtime-specific docs)
- `runtime/idl/**/*.json` (IDL artifacts)
- `runtime/benchmarks/**/*.json` (benchmark manifests)
- `scripts/idl/**/*.json` (verifier IDL)
- Package-local docs and changelogs under top-level packages, apps, platforms, programs, migrations, and `examples/**`
- Root docs: `README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR-MASTER-PROGRAM.md`

**Scope expansion: DELIVERED.** All items are already indexed by docs-mcp loader (verified in `server.ts` lines 51-60).

**Legacy surfaces labeled:**
- Issue/phase helpers explicitly labeled "legacy runtime-roadmap" in tool descriptions and scope manifest caveat (lines 65-66)
- Module helpers still runtime-specific

### 4.6 Fuzz, Mock-Router, Real-Proof Gates

| Surface | Owner | Gate Command |
|---------|-------|-------------|
| 8 fuzz targets | Protocol | `cargo fuzz run <target>` |
| Mock verifier router | Proof | `scripts/build-mock-verifier-router.sh` |
| Real Groth16 proof fixture | Proof | `tests/e2e-real-proof.ts` |
| Verifier localnet bootstrap | Proof | `scripts/setup-verifier-localnet.sh` |

### 4.7 Benchmark/Gate Ownership

| Gate | Owner | Command |
|------|-------|---------|
| Benchmark corpus | Runtime | `npm run benchmark` |
| Mutation regression | Runtime | `npm run mutation:gates` |
| Pipeline quality | Runtime | `npm run benchmark:pipeline:gates` |
| Background-run quality | Runtime | `npm run benchmark:background-runs:gates` |
| Delegation quality | Runtime | `npm run benchmark:delegation:gates` |

---

## 5. Synchronization Rules

### 5.1 Docs ↔ Architecture Changes

Every gate that changes architecture must update affected docs in the same commit:
- `docs/architecture/` for structural changes
- `docs/refactor/` for refactor deliverables
- Package-local READMEs for public surface changes

### 5.2 API Baseline ↔ Public Export Changes

Every change to public exports must update `docs/api-baseline/*.json` via `scripts/check-breaking-changes.ts`.

### 5.3 IDL ↔ Program Changes

Every `anchor build` must be followed by `runtime/scripts/copy-idl.js` and `runtime/scripts/check-idl-drift.ts`.

### 5.4 Desktop Codegen ↔ Tool Catalog Changes

Every change to `containers/desktop/server/src/toolDefinitions.ts` must be followed by `runtime/scripts/generate-desktop-tool-definitions.ts`.

---

*Gate 2B exit criterion: "later package or seam work is no longer blocked by shared tooling or authority ambiguity" — SATISFIED. All contract surfaces from Gates 0-2A have explicit owners, validation strategies, and synchronization rules.*
