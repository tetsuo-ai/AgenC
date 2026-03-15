# Gate 0 — Repository Ownership Map

> Produced by the refactor program. Classifies every top-level directory and root source-bearing file per Section 4 of REFACTOR-MASTER-PROGRAM.md.

## 1. Core Product and Protocol Domains

| Surface | Path | Classification | Owner Domain |
|---------|------|----------------|--------------|
| On-chain program | `programs/agenc-coordination/` | Core product — Anchor Solana program (44 instructions, 10 helper modules, 200 error codes, 49 events, 24 accounts, 8 fuzz targets) | Protocol |
| TypeScript SDK | `sdk/` | Core product — protocol client library (`@agenc/sdk` v1.3.0) | SDK |
| Agent Runtime | `runtime/` | Core product — agent lifecycle, gateway, LLM, tools, channels, desktop, eval (~223k lines, 32 src dirs, ~6589 tests) | Runtime |
| zkVM | `zkvm/` | Core product — RISC Zero guest (journal schema) + host (prover, seal encoding) | Proof |
| MCP Server | `mcp/` | Core product — protocol operations as MCP tools (`@agenc/mcp` v0.1.0) | MCP |
| Docs MCP Server | `docs-mcp/` | Core product — AI-assisted architecture doc lookups | Docs-MCP |

## 2. App and Consumer Domains

| Surface | Path | Classification | Owner Domain |
|---------|------|----------------|--------------|
| Web app | `web/` | Consumer — Vite + React + Tailwind browser UI | Web |
| Mobile app | `mobile/` | Consumer — Expo React Native app | Mobile |
| Demo app | `demo-app/` | Consumer — React privacy workflow demo | Demo-App |
| Examples | `examples/` | Consumer — 10 runnable example projects (see per-example classification below) | Examples |
| Demo scripts | `demo/` | Consumer — executable demo and smoke scripts (`e2e_devnet_test.ts`, `private_task_demo.ts`) | Demo |
| Demo collateral | `demos/` | Non-architectural — text sample collateral (`demo1.txt`, `demo2.txt`, `demo3.txt`) | Docs/Samples |

### Per-Example Classification

| Example | Has package.json | Import Style | Verification |
|---------|-----------------|--------------|--------------|
| `autonomous-agent/` | Check needed | SDK/runtime consumer | Run check needed |
| `dispute-arbiter/` | Check needed | SDK consumer | Run check needed |
| `event-dashboard/` | Check needed | SDK/runtime consumer | Run check needed |
| `helius-webhook/` | Yes (knip workspace) | SDK consumer | Entry: `index.ts` |
| `llm-agent/` | Check needed | Runtime consumer | Run check needed |
| `memory-agent/` | Check needed | Runtime consumer | Run check needed |
| `risc0-proof-demo/` | Check needed | SDK/proof consumer | Run check needed |
| `simple-usage/` | Yes (knip workspace) | SDK consumer | Entry: `index.ts` |
| `skill-jupiter/` | Check needed | Runtime/skills consumer | Run check needed |
| `tetsuo-integration/` | Yes (knip workspace) | SDK/runtime consumer | Entry: `index.ts` |

## 3. Platform and Operational Domains

| Surface | Path | Classification | Owner Domain |
|---------|------|----------------|--------------|
| Desktop platform — container | `containers/desktop/` | Platform — Docker headless desktop (Ubuntu/XFCE/VNC) + REST API (19 tools) | Desktop Platform |
| Desktop platform — compose | `containers/docker-compose.yml` | Platform — orchestrator config | Desktop Platform |
| Desktop platform — runtime | `runtime/src/desktop/` | Platform — runtime bridge, manager, router, session lifecycle | Desktop Platform |
| Desktop platform — server | `containers/desktop/server/` | Platform — in-container REST server (knip workspace) | Desktop Platform |
| Root integration tests | `tests/` | Verification — LiteSVM, Anchor, verifier, security, integration (knip workspace) | Tests |
| Docs | `docs/` | Operational — architecture docs, roadmap, runbooks, flow docs | Docs |
| Runtime docs | `runtime/docs/` | Operational — runtime-specific runbooks and CLI guidance | Runtime/Docs |
| Scripts | `scripts/` | Operational — 79 files: ~31 watch lib modules, 40+ watch tests, soak/autonomy infra, localnet, security, deployment | Scripts |
| Migrations | `migrations/` | Operational — protocol migration tools (`migration_utils.ts`, `v1_to_v2.rs`, README) | Migrations |
| CI / repo automation | `.github/` | Operational — only `dependabot.yml` + PR template (workflows removed) | CI |

## 4. Root Workspace and Support Surfaces

### 4.1 Root Standalone Tool/App Surface

**Classification: SEPARATE TOOL — not canonical AgenC product code.**

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 65 | Headless autopilot demo for `grid-router-ts` |
| `src/cli.ts` | 95 | CLI for grid-router (BFS/Dijkstra/A*) |
| `src/grid-router.ts` | 163 | Grid pathfinding algorithms (imports from `gridRouter.ts`) |
| `src/gridRouter.ts` | 197 | Grid pathfinding core (Position, Tile, SolveResult types) |

- `package.json` names the root package `grid-router-ts` with `bin.grid-router`
- `tsconfig.json` roots at `src/` and `tests/` — separate from AgenC packages
- **Duplicate router implementations:** `grid-router.ts` imports from `gridRouter.ts`; both define pathfinding logic
- **Build:** `tsc` outputs to `dist/`; `tsx src/index.ts` for dev
- **Decision needed:** Isolate into its own workspace, retire, or move to `examples/`

### 4.2 Root Source Utilities and Config Files

| File | Classification | Owner Domain |
|------|----------------|--------------|
| `agenc-eval-test.cjs` | Test utility — eval test harness (sends prompts to daemon via WebSocket) | Scripts/Eval |
| `ansi2png.py` | Support utility — converts ANSI art to PNG (Python/PIL) | Support |
| `chains.json` | Support data — DeFi chain registry (~7.3MB, DeFiLlama-style) | Support/Legacy |
| `solana_protocols.json` | Support data — Solana protocol registry | Support/Legacy |
| `F722pphA2Sdn9Fg1C8XkzdSjyNaRF1dGvDVB2kqTDrGZ.json` | Support data — Solana keypair/account data (64-byte array) | Support/Legacy |
| `autonomy_stage2.txt` | Support data — autonomy test prompt/config | Support/Eval |
| `prompt.txt` | Support data — prompt template | Support |
| `knip.json` | Build config — dead code analysis workspace config | Build |
| `Anchor.toml` | Build config — Anchor framework config (v0.32.1, Solana v3.0.13) | Protocol/Build |
| `tsconfig.json` | Build config — root TypeScript config (for `grid-router-ts`) | Root Tool |
| `package.json` | Build config — root package (`grid-router-ts`, not AgenC orchestrator) | Root Tool |
| `package-lock.json` | Build config — npm lock file | Build |
| `yarn.lock` | Build config — yarn lock file (possibly stale) | Build |

### 4.3 Root Assets and Media

| File | Classification | Owner Domain |
|------|----------------|--------------|
| `assets/banner.jpg` | Media — project banner image | Docs/Brand |
| `image` | Media — UTF-8 text (base64 or data URI, 1184 chars) | Support/Legacy |
| `image.jpg` | Media — 400x400 JPEG | Support/Legacy |
| `img2` | Media — ASCII text (730 chars) | Support/Legacy |

### 4.4 Root Policy and Meta Files

| File | Classification | Owner Domain |
|------|----------------|--------------|
| `README.md` | Repo policy — project README | Docs |
| `CLAUDE.md` | Repo policy — Claude Code instructions (indexed by docs-mcp) | Docs/Meta |
| `CODEX.md` | Repo policy — Codex instructions | Docs/Meta |
| `codex.md` | Repo policy — duplicate/variant Codex instructions (lowercase) | Docs/Meta |
| `AGENTS.md` | Repo policy — agents config | Docs/Meta |
| `.mcp.json` | Repo config — MCP server definitions | Build/Config |
| `.gitignore` | Repo config — git ignore rules | Build/Config |
| `.gitattributes` | Repo config — git attributes | Build/Config |
| `.trivyignore` | Repo config — security scan ignore rules | Build/Config |
| `LICENSE` | Legal — project license | Legal |
| `REFACTOR-MASTER-PROGRAM.md` | Repo policy — canonical refactor plan | Refactor |
| `REFACTOR-PROGRESS.md` | Repo policy — refactor progress tracker | Refactor |
| `TODO.MD` | Repo policy — task tracking | Docs/Meta |
| `CHAT.MD` | Repo policy — chat/notes | Docs/Meta |
| `INTERVIEW_PREP.md` | Non-architectural — interview preparation notes | Non-architectural |
| `security_best_practices_report.md` | Docs — security audit report | Docs/Security |

### 4.5 Build and Artifact Directories

| Directory | Classification | Notes |
|-----------|----------------|-------|
| `dist/` | Generated output — root `grid-router-ts` build | Non-architectural |
| `target/` | Generated output — Anchor/Cargo build | Contract-bearing (`target/idl/`, `target/types/`) |
| `test-ledger/` | Generated output — Solana test validator ledger | Non-architectural |
| `logs/` | Operational output — daily log files | Non-architectural |
| `node_modules/` | Generated output — npm dependencies | Non-architectural |
| `.tmp/` | Generated output — temporary files | Non-architectural |
| `.anchor/` | Generated output — Anchor cache | Non-architectural |

### 4.6 Hidden Config Directories

| Directory | Classification | Notes |
|-----------|----------------|-------|
| `.claude/` | IDE config — Claude Code settings, skills, rules, memory | Non-architectural (local) |
| `.codex/` | IDE config — Codex settings, agents, notes, rules, skills | Non-architectural (local) |
| `.github/` | CI — dependabot + PR template only (workflows removed) | CI |
| `.git/` | VCS — git repository | Non-architectural |

### 4.7 Patches

| Directory | Classification | Notes |
|-----------|----------------|-------|
| `patches/npm/` | Build config — npm package patches | Build |

## 5. Known Private-Import Consumers

Per Section 5.4 of the master program:

| Consumer | Import Target | Type |
|----------|--------------|------|
| `web/src/types.ts` | `runtime/src/*` | Private runtime import |
| `web/src/constants.ts` | `runtime/src/*` | Private runtime import |
| `web/src/hooks/useWebSocket.ts` | `runtime/src/*` | Private runtime import |
| `mobile/src/hooks/useRemoteGateway.ts` | `runtime/src/*` | Private runtime import |
| `demo/private_task_demo.ts` | `sdk/src/*` | Private SDK import |
| `scripts/agenc-localnet-social-smoke.ts` | `runtime/src/*` | Private runtime import |
| `scripts/agenc-localnet-social-bootstrap.ts` | `runtime/src/*` | Private runtime import |
| `scripts/zk-config-admin.ts` | `runtime/src/*` or `sdk/src/*` | Private import |

## 6. Active Generated Artifacts and Codegen Pipelines

| Artifact | Source | Consumer | Contract-Bearing |
|----------|--------|----------|-----------------|
| `target/idl/agenc_coordination.json` | `anchor build` | `runtime/scripts/copy-idl.js` | Yes |
| `target/types/agenc_coordination.ts` | `anchor build` | `runtime/src/types/` | Yes |
| `runtime/idl/agenc_coordination.json` | `runtime/scripts/copy-idl.js` | Runtime IDL loader | Yes |
| `runtime/src/types/agenc_coordination.ts` | Manual sync from `target/types/` | Runtime Program generics | Yes |
| `runtime/src/desktop/tool-definitions.ts` | `runtime/scripts/generate-desktop-tool-definitions.ts` | Runtime desktop bridge | Yes |
| `containers/desktop/server/src/toolDefinitions.ts` | Source of truth | Desktop server + codegen script | Yes |
| `docs/api-baseline/runtime.json` | `scripts/check-breaking-changes.ts` | API compatibility gates | Yes |
| `docs/api-baseline/sdk.json` | `scripts/check-breaking-changes.ts` | API compatibility gates | Yes |
| `docs/api-baseline/mcp.json` | `scripts/check-breaking-changes.ts` | API compatibility gates | Yes |
| `runtime/dist/operator-events.mjs` | `runtime build` | `scripts/lib/agenc-watch-*.mjs` | Yes |
| `scripts/idl/verifier_router.json` | External (boundless-xyz/risc0-solana) | Verifier bootstrap scripts | Yes |

## 7. Operator-Console/Watch Subsystem Inventory

| Component | Path | Role |
|-----------|------|------|
| CLI entrypoint | `scripts/agenc-watch.mjs` | Thin CLI launcher |
| Composition root | `scripts/lib/agenc-watch-app.mjs` | Real app root (oversized — decomposition target) |
| Watch lib modules | `scripts/lib/agenc-watch-*.mjs` (~31 files) | Modularized subsystem |
| Watch tests | `scripts/agenc-watch-*.test.mjs` (~40+ files) | Test coverage |
| Runtime coupling | `runtime/dist/operator-events.mjs` | Built runtime artifact used as compatibility input |
| Runtime source | `runtime/src/cli/operator-console.ts` | Runtime CLI command that launches watch |

## 8. Unclassified Surface Audit

All surfaces have been classified above. No unclassified major domain remains.

**Decision items requiring human judgment (logged, not blocking):**

1. **Root `grid-router-ts` surface:** Recommend isolating to `tools/grid-router/` or retiring. Currently occupies root `package.json`, `tsconfig.json`, `src/`, and `dist/`. Has duplicate implementations (`grid-router.ts` vs `gridRouter.ts`).

2. **Large support data files:** `chains.json` (~7.3MB), `solana_protocols.json`, `F722...json` — recommend moving to `.data/` or retiring if unused by any active code path.

3. **Stale media files:** `image`, `img2` — text-encoded image references with no clear consumer. Recommend retiring.

4. **Duplicate Codex files:** `CODEX.md` vs `codex.md` — recommend consolidating.

5. **`INTERVIEW_PREP.md`:** Non-architectural personal notes. Recommend `.gitignore` or removing from repo.

---

*Gate 0 exit criterion: "there is no unclassified major domain" — SATISFIED.*
