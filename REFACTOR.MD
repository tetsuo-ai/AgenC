# REFACTOR EXECUTION ROADMAP

Status: **Live program roadmap and evidence log for `REFACTOR-MASTER-PROGRAM.md`.**
Last synced: `2026-03-16`.

---

## 1. Executive Verdict

- The refactor program is **not complete**.
- Gates 0 through 9 have materially established monorepo modularity and produced the required gate artifacts.
- Gate 10 passed its final exit review on `2026-03-16` for the current split-candidate scope.
- Gate 11 is now `IN PROGRESS` with a recorded split decision: keep the engine private and publish contracts plus extension sockets.
- Gate 11 now has two landed execution waves on `2026-03-16`: Wave 1 `agenc-sdk` extraction cutover and Wave 2 `agenc-protocol` trust-surface bootstrap.
- Gate 12 remains blocked until the Gate 11 repo topology and extraction state are materially stable.
- Standalone `docs/refactor/gate-*.md` planning documents have been retired; gate status and live evidence now belong here.
- Audit note: parallel explorer subagents were attempted on `2026-03-16`, but all failed on model usage limits; this sync is therefore based on direct repository evidence.

---

## 2. Verified Current Facts

### 2.1 Repository Facts Confirmed In Code

- On-chain program:
  - `44` IDL instructions
  - `54` Rust instruction source files under `programs/agenc-coordination/src/instructions/`
  - `24` state structs in `programs/agenc-coordination/src/state.rs`
  - `22` IDL accounts
  - `49` events
  - `200` errors, with runtime decoding coverage at `200/200`
  - `9` fuzz targets
- `runtime/src` currently has:
  - `867` files
  - `32` top-level directories
  - `319` `*.test.ts` files
- The old root `src/` grid-router surface was retired on `2026-03-16`; the repo root no longer carries a separate build-bearing demo package.
- `docs-mcp` currently loads:
  - `docs/**`
  - `runtime/docs/**`
  - `runtime/idl/**`
  - `runtime/benchmarks/**`
  - `scripts/idl/**`
  - root docs `README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md`
  - package `README.md` / `CHANGELOG.md` files
- Package consumers are already on published package coordinates:
  - `web` and `mobile` use `@tetsuo-ai/runtime`
  - `runtime` uses released `@tetsuo-ai/sdk@1.3.1`
  - `mcp` uses `@tetsuo-ai/runtime` and released `@tetsuo-ai/sdk@1.3.1`
  - packaged examples use `@tetsuo-ai/sdk`
  - the root workspace no longer owns `sdk` or `examples/private-task-demo`; those local trees are rollback mirrors only
- Standalone public repos now exist on `main`:
  - `tetsuo-ai/agenc-sdk`
  - `tetsuo-ai/agenc-protocol`

### 2.2 Gate 10 Exit Review Result

Gate 10 is `COMPLETE` for the current split-candidate scope.

Final review findings:

- Publishable split-contract packages now have clean `pack -> install -> smoke` proof:
  - `@tetsuo-ai/sdk`
  - `@tetsuo-ai/desktop-tool-contracts`
  - `@tetsuo-ai/runtime`
  - `@tetsuo-ai/mcp`
  - `@tetsuo-ai/docs-mcp`
- Downstream consumer and tool surfaces were validated against installed/public package contracts rather than sibling `src/` imports:
  - `web`
  - `mobile`
  - `examples/tetsuo-integration`
  - `containers/desktop/server`
  - `examples/private-task-demo`
  - `tools/localnet-social`
  - `tools/zk-admin`
- The five previously tracked root script/demo blockers were reclassified on `2026-03-16` into explicit example/tool packages, and their package-surface verification passed via root forwarding commands and targeted harness checks:
  - [index.ts](/home/tetsuo/git/AgenC/examples/private-task-demo/index.ts)
  - [smoke.ts](/home/tetsuo/git/AgenC/tools/localnet-social/smoke.ts)
  - [bootstrap.ts](/home/tetsuo/git/AgenC/tools/localnet-social/bootstrap.ts)
  - [benchmark-private-e2e.mts](/home/tetsuo/git/AgenC/tools/zk-admin/benchmark-private-e2e.mts)
  - [zk-config-admin.ts](/home/tetsuo/git/AgenC/tools/zk-admin/zk-config-admin.ts)
- A committed clean-environment `npm pack` / `npm install <tarball>` smoke harness now exists in [pack-smoke.mjs](/home/tetsuo/git/AgenC/scripts/pack-smoke.mjs) and is wired into CI via [package-pack-smoke.yml](/home/tetsuo/git/AgenC/.github/workflows/package-pack-smoke.yml); it proves core package entrypoints, the packaged `@tetsuo-ai/sdk/internal/spl-token` subpath, installed bins, runtime subpath exports, the shipped runtime IDL artifact, and the shared desktop tool-contract package while also asserting the public SDK root does not leak internal SPL mutation helpers.
- No split candidate currently relies on repo-relative `runtime/src`, `sdk/src`, `mcp/src`, `docs-mcp/src`, or desktop-server source imports; the final import audit returned no matches.
- No candidate manifest currently relies on `file:` dependencies; the final manifest audit returned no matches.
- The old root `file:patches/npm/bigint-buffer` override is gone, and the `@solana/spl-token` dependency chain is gone.
- Contract-bearing artifact handoff is repo-independent for the split-candidate package scope:
  - shipped runtime IDL
  - shared desktop tool-contract package
  - `@tetsuo-ai/runtime/operator-events`
  - `runtime/dist/bin/agenc-watch.js`
- `docs-mcp` matches the live repository authority model: legacy runtime-roadmap issue/phase surfaces are removed, `REFACTOR.MD` and `REFACTOR-MASTER-PROGRAM.md` are indexed root docs, and runtime-module helpers are explicitly runtime-scoped rather than whole-repo planning authority.
- Root-only local/test surfaces still exist, but they are explicitly outside the current split-candidate scope:
  - [agenc-watch.mjs](/home/tetsuo/git/AgenC/scripts/agenc-watch.mjs) is a local-dev wrapper over the packaged runtime watch surface
  - [agenc-devnet-soak.mjs](/home/tetsuo/git/AgenC/scripts/agenc-devnet-soak.mjs), [setup-verifier-localnet.ts](/home/tetsuo/git/AgenC/scripts/setup-verifier-localnet.ts), and root proof/program tests still consume root-local verifier or `target/*` artifacts as monorepo validation assets
  - those paths do not block Gate 10 unless they are promoted into future split-candidate scope

Registry-backed package distribution under `@tetsuo-ai/*` is proven:
  - `@tetsuo-ai/sdk@1.3.1` published from the standalone `tetsuo-ai/agenc-sdk` repo and installed successfully from clean temp consumers on `2026-03-16`
  - `@tetsuo-ai/runtime@0.1.0`, `@tetsuo-ai/mcp@0.1.0`, and `@tetsuo-ai/docs-mcp@0.1.0` published and installed successfully from clean temp consumers on `2026-03-16`
Resolved on `2026-03-16`:
- The old root `file:patches/npm/bigint-buffer` override is gone.
- The `@solana/spl-token` dependency chain is gone.
- The repo is explicitly npm-based now (`packageManager: npm@11.7.0`), and stale `yarn.lock` files were removed so lockfile/package-manager detection matches the real install path.
- `docs-mcp` no longer registers legacy runtime-roadmap issue/phase tools, prompts, or special `issue-map` / `roadmap` aggregate resources; `REFACTOR.MD` is now part of the indexed root-doc set, and the remaining module helpers are explicitly runtime-scoped and non-authoritative for whole-repo planning.
- An owned bounded classic-SPL helper now lives in [spl-token.ts](/home/tetsuo/git/AgenC/sdk/src/spl-token.ts); repo integration tests consume its built internal subpath `@tetsuo-ai/sdk/internal/spl-token`, and clean reinstall plus verification passed:
  - `npm install`
  - `npm ls bigint-buffer --all`
  - `npm ls @solana/spl-token --all`
  - `npm run typecheck`
  - `npm run test`
  - `npm run test:fast`
  - `npm run pack:smoke`

---

## 3. Gate Status Ledger

| Gate | Purpose | Status | Evidence | Remaining Delta |
|------|---------|--------|----------|-----------------|
| 0 | Repository classification and program lock | COMPLETE | Current-state audit in this roadmap + live repo inventory | Keep counts and ownership maps synchronized when surfaces change |
| 1 | Contract inventory and baseline harness | COMPLETE | Current-state audit in this roadmap + live contract/artifact files | Keep artifact paths and contract counts synchronized |
| 2A | Early consumer and shadow-ownership blocker removal | COMPLETE | Package-manifest state + current import audit summarized here | Do not allow new private source-path imports into apps or package consumers |
| 2B | Contract authority and tooling lock | COMPLETE | Current verification/baseline/codegen ownership state summarized here | Keep build/test/baseline/codegen authority aligned with package map changes |
| 3 | Foundation contract lock | COMPLETE | Protocol/proof/runtime facts summarized here + live code artifacts | Preserve protocol/proof/schema locks and update drift artifacts with any change |
| 4 | First proven runtime seam | COMPLETE | `runtime/src/gateway/tool-handler-factory-contract.test.ts` + current seam summary here | Do not reopen blocked seam candidates without a new scorecard |
| 5 | Runtime control-plane boundary reduction | COMPLETE | Current runtime seam state summarized here | Keep daemon/background-run/approval/subagent seams explicit |
| 6 | Desktop platform contract stabilization | COMPLETE | Current desktop contract state summarized here | Keep runtime/container/server contracts version-aligned |
| 7 | Consumer migration | COMPLETE | Package consumer state + migrated root script/demo imports summarized here | Keep new consumers off private source paths |
| 8 | Verification/docs/tooling convergence | COMPLETE | Current baseline/docs/docs-mcp state summarized here | Keep docs-mcp scope/root-doc coverage aligned with future authority changes |
| 9 | Internal modularization inside the monorepo | COMPLETE | Current monorepo modularity proof summarized here | Preserve the modularity proof that Gate 10 now builds on |
| 10 | Repository split readiness | COMPLETE | Gate 10 verification matrix, execution ledger, and final exit review in this roadmap | Keep candidate-scope proof current if new split candidates are added |
| 11 | Repository split decision and extraction | IN PROGRESS | Gate 11 topology, package policy, and extraction order are now recorded in this roadmap | Execute the split with rollback, CI, and docs authority preserved |
| 12 | Legacy deletion and convergence | BLOCKED | None yet | Cannot start before the Gate 11 decision is stable |

---

## 4. Always-On Rules

1. No document may claim refactor-program completion before Gates 10, 11, and 12 are resolved.
2. No new private source-path imports may be introduced into apps, package consumers, or split candidates.
3. No public-surface, build-graph, or artifact-chain change is complete until the same change updates:
   - API baselines
   - IDL/schema/tool-definition artifacts
   - relevant docs and package docs
   - `docs-mcp` authoritative coverage where applicable
4. No repo split work may proceed on assumption alone; it must be backed by clean-environment packaging proof.
5. `REFACTOR-MASTER-PROGRAM.md`, `REFACTOR.MD`, and active gate evidence docs must be updated in the same change set when new evidence changes program state.

---

## 5. Ordered Roadmap

### 5.1 Immediate Maintenance Layer

These are standing obligations for the remainder of the program:

1. Keep the planning layer truthful.
2. Keep Gate 10 scope and portability guarantees exact.
3. Keep package/baseline/codegen/docs updates coupled.
4. Keep docs-mcp search/resources aligned with the live planning docs, and keep runtime-only helper surfaces explicitly scoped.
5. Do not reopen earlier gates unless an invariant actually regresses.

### 5.2 Gate 10 — Repository Split Readiness

Status: `COMPLETE`

Gate 10 exit review passed on `2026-03-16` for the current split-candidate scope. The requirements below are retained as the acceptance record for the completed gate.

Objective:
- Prove that the candidate split units can be released, installed, and smoke-validated without monorepo-relative paths, local workspace assumptions, or repo-local artifact handoffs.

#### 10.0 Truth Lock

Required work:
1. Update the Gate 10 execution ledger in this roadmap from placeholder state to live evidence.
2. Record pre-mutation command status for:
   - core package build/typecheck/test
   - baseline guards
   - IDL drift
   - benchmark gates relevant to touched surfaces
3. Freeze the active blocker list in both this roadmap and the Gate 10 verification docs before further migrations begin.

Exit signal:
- The Gate 10 log is no longer a scaffold; it is a real evidence ledger.

#### 10.1 Candidate Split Matrix

Required work:
1. Define the candidate split set explicitly:
   - publishable split-contract packages:
     - `sdk`
     - `desktop-tool-contracts`
     - `runtime`
     - `mcp`
     - `docs-mcp`
   - downstream consumer and tool surfaces to validate against installed artifacts:
     - `web`
     - `mobile`
     - `examples/tetsuo-integration`
     - `containers/desktop/server`
     - `examples/private-task-demo`
     - `tools/localnet-social`
     - `tools/zk-admin`
2. For each candidate, define:
   - package or repo name
   - release owner
   - version source
   - required generated artifacts
   - downstream smoke consumers
   - rollback owner
3. Record the matrix in this roadmap and keep it synchronized with live execution results.

Exit signal:
- Every publishable split-contract package has an explicit release contract, and every validated downstream consumer/tool surface has an installed-artifact validation contract.

#### 10.2 Remove Repo-Coupled Consumers

Required work in order:
1. Confirm the reclassified package surfaces are stable for:
   - [index.ts](/home/tetsuo/git/AgenC/examples/private-task-demo/index.ts)
   - [smoke.ts](/home/tetsuo/git/AgenC/tools/localnet-social/smoke.ts)
   - [bootstrap.ts](/home/tetsuo/git/AgenC/tools/localnet-social/bootstrap.ts)
   - [benchmark-private-e2e.mts](/home/tetsuo/git/AgenC/tools/zk-admin/benchmark-private-e2e.mts)
   - [zk-config-admin.ts](/home/tetsuo/git/AgenC/tools/zk-admin/zk-config-admin.ts)
2. Run post-migration verification so these stop being evidence-pending blockers.
3. Keep the old root patch-path workaround dead:
   - do not reintroduce `file:` dependency forks into split candidates
   - keep token-path consumers on the owned [spl-token.ts](/home/tetsuo/git/AgenC/sdk/src/spl-token.ts) surface instead of `@solana/spl-token`

Hard rule:
- If any of these surfaces must remain repo-local by design, that exception must be written down explicitly and removed from split-candidate scope rather than silently tolerated.

Exit signal:
- No split candidate or required downstream smoke consumer still relies on repo-relative source imports or repo-local patch paths, and the post-migration verification evidence is recorded.

#### 10.3 Split-Pack / Install Harness

Required work:
1. Implement a repeatable clean-environment harness for each candidate package.
2. Required flow per candidate:
   - `npm pack`
   - create empty temp consumer
   - `npm install <tarball>`
   - run candidate-specific build/typecheck/test commands
   - run dependent-consumer smoke/import checks
3. For non-publishable consumer repos or tool surfaces, run clean temp copy validation against installed/public package inputs.
4. Persist pass/fail evidence in this roadmap.

Exit signal:
- Every publishable split-contract package has at least one clean-environment pack/install proof path, and every validated downstream consumer/tool surface has an installed-artifact smoke path.

#### 10.4 Artifact Handoff Closure

Required work:
1. Make artifact contracts repo-independent for:
   - `runtime/idl/agenc_coordination.json`
   - `runtime/src/types/agenc_coordination.ts`
   - `contracts/desktop-tool-contracts/src/index.ts`
   - `@tetsuo-ai/runtime/operator-events`
   - `runtime/dist/bin/agenc-watch.js`
2. Keep root-monorepo verifier/program validation assets explicitly scoped outside split-candidate package contracts unless they are promoted:
   - `scripts/idl/verifier_router.json`
   - `target/idl/**`
   - `target/types/**`
3. Prove that installed or packed consumers can access the artifact they need without repository-relative lookup.
4. Extend drift/codegen documentation and verification steps if artifact ownership changes.

Exit signal:
- Split-candidate contract artifacts can be handed off and consumed without monorepo-relative paths, and root-monorepo validation artifacts are explicitly documented as outside that package/repo scope.

#### 10.5 CI, Docs, And Docs-MCP Synchronization

Required work:
1. Add or map split-readiness jobs in `.github/workflows`.
2. Keep master plan, gate docs, and package docs aligned with Gate 10 status.
3. Keep `docs-mcp` guidance and registrations aligned with the current repository authority so search/resources reflect the live planning docs without reviving legacy runtime-roadmap authority surfaces.
4. Keep `docs-mcp` indexed-corpus coverage aligned with any new split-readiness docs or artifact-contract docs.

Exit signal:
- Split-readiness evidence is machine-runnable and documentation surfaces do not misstate program authority.

#### 10.6 Gate 10 Exit Review

Verdict: `PASS` on `2026-03-16`

Exit criteria satisfied:
1. Every publishable split-contract package has a clean `pack -> install -> smoke` path, and validated downstream consumers/tool surfaces passed installed-artifact smoke checks.
2. No split candidate relies on repo-relative source imports, sibling workspace assumptions, or repo-local patch paths.
3. Contract-bearing artifacts in split-candidate scope have repo-independent handoff paths.
4. Gate 10 verification docs and execution log are fully populated in this roadmap.
5. No active planning doc still claims Gate 10 is open.

Gate 11 may now begin.

### 5.3A Gate 10 Verification Matrix

All four verification layers must be green per candidate:

1. Code integrity checks:
   - `npm run build`
   - `npm run typecheck`
   - `npm run test` or scoped substitute
2. Artifact validation:
   - pack output exists
   - clean install works in empty temp workspace
   - no repo-relative runtime assumptions
3. Consumer smoke:
   - immediate consumers run against installed artifacts
   - no fallback to `runtime/src` or `sdk/src`
4. Contract continuity:
   - API baselines
   - IDL drift
   - desktop tool-definition contract package

Candidate matrix:

Publishable split-contract packages:

| Candidate | Verification owner | Smoke command | Consumer to validate | Status |
|-----------|--------------------|---------------|----------------------|--------|
| `sdk` | Runtime + SDK | clean temp `npm pack` + build/typecheck/test + registry install | `runtime`, benchmark consumers, `examples/tetsuo-integration` | registry pass |
| `desktop-tool-contracts` | Desktop + Runtime | clean temp `npm pack` + build + import smoke | `runtime`, `containers/desktop/server` | pass |
| `runtime` | Runtime | clean temp `npm pack` + build/typecheck/test + registry install | `mcp`, `web`, `mobile`, script consumers | registry pass |
| `mcp` | MCP + Runtime | clean temp `npm pack` + build/typecheck/test + registry install | tool-call consumers | registry pass |
| `docs-mcp` | Docs | clean temp `npm pack` + build + registry install | docs retrieval/tool surfaces | registry pass |

Validated downstream consumers and tool surfaces:

| Consumer Surface | Verification owner | Smoke command | Installed/Public Contract | Status |
|------------------|--------------------|---------------|---------------------------|--------|
| `web` | Web + Runtime | clean temp copy `npm install` + `npm run build` | `@tetsuo-ai/runtime` | pass |
| `mobile` | Mobile + Runtime | clean temp copy `npm install` + `npm run typecheck` | `@tetsuo-ai/runtime` | pass |
| `examples/tetsuo-integration` | Examples + Runtime | clean temp copy `npm install` + `npm run build` | `@tetsuo-ai/sdk`, `@tetsuo-ai/runtime` | pass |
| `containers/desktop/server` | Desktop + Runtime | `npm run test --workspace=@tetsuo-ai/desktop-server` | `@tetsuo-ai/desktop-tool-contracts` | pass |
| `examples/private-task-demo` | Examples + SDK | `npm run start --prefix examples/private-task-demo -- --help` | `@tetsuo-ai/sdk` | pass |
| `tools/localnet-social` | Runtime ops | `npm run localnet:social:bootstrap -- --help` and `npm run localnet:social:smoke -- --help` | `@tetsuo-ai/runtime` | pass |
| `tools/zk-admin` | Protocol + zk admin | `npm run benchmark:private:e2e -- --help`, `npm run zk:config -- --help`, and verifier/localnet validation | `@tetsuo-ai/sdk`, `@tetsuo-ai/runtime` | pass |

Artifact handoff matrix:

| Artifact Contract | Producer | Consumer Path | Baseline Command | Status |
|------------------|----------|---------------|------------------|--------|
| `runtime/idl/agenc_coordination.json` | runtime/program | installed runtime consumers | IDL copy + drift check + pack smoke IDL presence | pass |
| `@tetsuo-ai/desktop-tool-contracts` | desktop-tool-contracts workspace | installed desktop/runtime consumers | package build + compile + pack smoke import | pass |
| `@tetsuo-ai/runtime/operator-events` + `runtime/dist/bin/agenc-watch.js` | runtime | watch/script consumers | runtime build + package-subpath import + operator-console/watch smoke | pass |

Root-monorepo validation assets outside split-candidate package scope:

- `scripts/idl/verifier_router.json`
- `target/idl/**`
- `target/types/**`
- root proof/program/verifier harnesses that intentionally consume those artifacts

### 5.3B Gate 10 Execution Ledger

Preflight snapshot:

| Item | Command/Signal | Status | Notes |
|------|----------------|--------|-------|
| 10L.1 | `git status` | captured | dirty worktree was intentionally present during the refactor execution pass; status was recorded before Gate 10 closeout sync |
| 10L.2 | `npm run build` | pass | root build passed on `2026-03-16`; runtime build regenerated `runtime/idl/agenc_coordination.json` and `runtime/src/types/agenc_coordination.ts` from `target/` |
| 10L.3 | `npm run typecheck` | pass | root typecheck passed after runtime/MCP verification regressions were fixed on `2026-03-16` |
| 10L.4 | `npm run test` | pass | root test passed: SDK `260/260` and runtime `6626/6626` |
| 10L.5 | runtime benchmark gate matrix | pass | pipeline, delegation, background-run, mutation, and autonomy rollout gates passed on `2026-03-16` |
| 10L.6 | IDL drift check | pass | `npm run check-idl-drift` passed |
| 10L.7 | API baseline/breaking-change guard | pass | `check-breaking-changes.ts --check sdk|runtime|mcp` all passed |
| 10L.8 | source-path import audit | pass | known blockers were reclassified into explicit example/tool packages and verified through forwarding-command smoke checks plus targeted runtime/verifier validation |
| 10L.9 | stale-doc sanity scan | pass | active refactor authority docs synchronized to the final Gate 10 verdict on `2026-03-16` |

Decision log:

- `[2026-03-16]` Planning layer reconciled to current codebase state.
- `[2026-03-16]` Standalone gate docs retired from the active tree; gate status and evidence collapsed into `REFACTOR.MD`.
- `[2026-03-16]` The five previously identified root script/demo source-path blockers were migrated to `@tetsuo-ai/sdk` / `@tetsuo-ai/runtime` package-public imports.
- `[2026-03-16]` Core workspace packages adopted the permanent `@tetsuo-ai/*` scope, `mcp` / `docs-mcp` package metadata was aligned to explicit CommonJS tarball outputs, and a checked-in `pack -> install -> require` smoke harness was added and verified locally for `sdk`, `runtime`, `mcp`, and `docs-mcp`.
- `[2026-03-16]` Registry publish under `@tetsuo-ai/*` results:
  - `@tetsuo-ai/sdk@1.3.1` published and installed successfully from the standalone `tetsuo-ai/agenc-sdk` repo
  - `@tetsuo-ai/runtime@0.1.0` published and installed successfully from a clean temp project
  - `@tetsuo-ai/mcp@0.1.0` published and installed successfully from a clean temp project; installed `.bin/agenc-mcp` is present despite npm's noisy publish-time `bin[...] removed` warning
  - `@tetsuo-ai/docs-mcp@0.1.0` published and installed successfully from a clean temp project; the earlier `404` was npm registry propagation lag, not a package-manifest failure
- `[2026-03-16]` Wave 1 `agenc-sdk` extraction cutover landed:
  - standalone repo `tetsuo-ai/agenc-sdk` created with repo-local CI, API baseline check, and pack-smoke validation
  - root workspace ownership removed for `sdk` and `examples/private-task-demo`
  - `mcp/tsup.config.ts`, `scripts/smoke-test-examples.sh`, `containers/desktop/Dockerfile`, `scripts/pack-smoke.mjs`, and `.github/workflows/package-pack-smoke.yml` no longer assume local SDK build ownership
  - the private monorepo validated against released `@tetsuo-ai/sdk@1.3.1` via `npm run build`, `npm run typecheck`, `npm run test`, `npm run test --workspace=@tetsuo-ai/mcp`, `npm run test --workspace=@tetsuo-ai/desktop-server`, and `npm run pack:smoke`
  - local `sdk/` and `examples/private-task-demo/` trees are retained only as de-authorized rollback mirrors and must remain unpublished
- `[2026-03-16]` Wave 2 `agenc-protocol` bootstrap landed:
  - standalone repo `tetsuo-ai/agenc-protocol` exists and bootstrap PR `#1` merged on `main`
  - the public trust-surface bootstrap scope now lives there:
    - `programs/agenc-coordination/**`
    - `programs/agenc-coordination/fuzz/**`
    - `migrations/**`
    - `zkvm/guest/**`
    - `zkvm/Cargo.toml`
    - `zkvm/Cargo.lock`
    - `scripts/idl/verifier_router.json`
    - committed generated artifacts under `artifacts/anchor/`
  - `anchor build`, `npm run artifacts:refresh`, `npm run artifacts:check`, and Rust format checks passed in the standalone repo
  - AgenC has not yet cut runtime, SDK test, or root test consumers over to released protocol artifacts
- `[2026-03-16]` Desktop tool-definition handoff was replaced with the shared `@tetsuo-ai/desktop-tool-contracts` workspace package; runtime and desktop-server now consume the same published contract and desktop-server validates handler/definition parity at startup.
- `[2026-03-16]` Operator-console/watch packaging was moved to a runtime-owned `agenc-watch` bin backed by `runtime/src/watch/`, and operator-event consumers now resolve the `@tetsuo-ai/runtime/operator-events` package subpath instead of repo-relative built-file lookups.
- `[2026-03-16]` `npm run typecheck --workspace=@tetsuo-ai/runtime`, `npm run test --workspace=@tetsuo-ai/runtime -- operator-console`, `npm run test --workspace=@tetsuo-ai/desktop-server`, and `npm run pack:smoke:skip-build` all passed with the shared desktop contract package included in the clean install matrix.
- `[2026-03-16]` The former loose root/demo surfaces were rehomed into explicit ownership buckets:
  - `examples/private-task-demo`
  - `tools/localnet-social`
  - `tools/zk-admin`
  and verified via root forwarding commands (`--help`) plus targeted verifier/localnet validation.
- `[2026-03-16]` Downstream consumer validation from clean temp copies with registry-installed packages:
  - `examples/tetsuo-integration`: `npm install` + `npm run build` passed
  - `web`: `npm install` + `npm run build` passed
  - `mobile`: `npm install` + `npm run typecheck` passed
  - core package aggregate registry install + `require(...)` smoke passed for `sdk`, `runtime`, `mcp`, and `docs-mcp`
- `[2026-03-16]` Additional verification rerun results:
  - `npm run test --workspace=@tetsuo-ai/mcp` failed:
    - runtime dist import error: `@coral-xyz/anchor` no longer exports `BN` in the way the built MCP replay tests expect
    - replay schema stability hashes are all collapsing to the same value and no longer match pinned hashes
  - `npm run test:fast` failed with `ERR_MODULE_NOT_FOUND` for `tests/test-utils`
  - `npm run typecheck` failed in `runtime` with broad type drift
  - `web` build failed due browser bundling against the patched `bigint-buffer` surface
  - `web` unit and e2e tests failed
  - `mobile` typecheck passed
  - `demo-app` build passed
  - `examples/tetsuo-integration` build failed with broad TypeScript configuration/test-scope bleed
  - `anchor build` passed
- `[2026-03-16]` Subsequent remediation cleared the previously red verification items that were in touched scope:
  - `npm run typecheck` passed
  - `npm run test --workspace=@tetsuo-ai/mcp -- --runInBand` passed
  - `npm run test:fast` passed
  - `npm --prefix web run build` passed
  - `npm --prefix web run test` passed
  - `npm --prefix web run test:e2e` passed
  - `npm --prefix examples/tetsuo-integration run build` passed
- `[2026-03-16]` The repo-local `bigint-buffer` override and the `@solana/spl-token` dependency chain were removed:
  - token consumers now use the owned bounded classic-SPL helper in [spl-token.ts](/home/tetsuo/git/AgenC/sdk/src/spl-token.ts)
  - `npm install` completed cleanly after deleting the local patch package
  - `npm ls bigint-buffer --all` returned an empty tree
  - `npm ls @solana/spl-token --all` returned an empty tree
  - `npm run typecheck`, `npm run test`, `npm run test:fast`, and `npm run pack:smoke` all passed after the removal
  - `pack-smoke.mjs` now verifies the packaged `@tetsuo-ai/sdk/internal/spl-token` subpath, asserts the public SDK root does not leak internal SPL helpers, verifies installed runtime subpath exports, and checks the shipped `runtime/idl/agenc_coordination.json` payload
- `[2026-03-16]` Final Gate 10 exit-review verification:
  - `npm run pack:smoke:skip-build` passed
  - `npm run build --workspace=@tetsuo-ai/runtime` passed
  - `npm run test:watch-node --workspace=@tetsuo-ai/runtime` passed
  - `npm run build --workspace=@tetsuo-ai/docs-mcp` passed
  - `npm run typecheck --workspace=@tetsuo-ai/docs-mcp` passed
  - `npm run build --workspace=@tetsuo-ai/desktop-tool-contracts` passed
  - `npm run test --workspace=@tetsuo-ai/desktop-server` passed
  - `npm --prefix web run build` passed
  - `npm --prefix mobile run typecheck` passed
  - `npm --prefix examples/tetsuo-integration run build` passed
  - `npm run test --workspace=@tetsuo-ai/mcp -- --runInBand` passed
  - split-candidate source-import audit returned no matches for private `src/` or built-file path coupling
  - split-candidate manifest audit returned no `file:` dependencies
  - Gate 10 verdict recorded as `PASS` for the current split-candidate scope

### 5.3 Gate 11 — Repository Split Decision And Extraction

Status: `IN PROGRESS`

Decision recorded on `2026-03-16`:
- `SPLIT`
- Keep the engine private.
- Publish contracts and extension sockets.

Gate 10 is green. Gate 11 now moves from "should we split?" to "how do we split without leaking the moat or creating cross-repo dependency hell?"

#### 11.1 Architecture Verdict

The future-proof operating model is:
1. Public repos expose trust surfaces, SDK surfaces, and narrow extension contracts.
2. Private repos keep orchestration, routing, operator UX, policy, ranking, evaluation, marketplace logic, proving operations, and hosted-control-plane behavior.
3. Third parties build **for** AgenC, not **inside** the private runtime kernel.
4. Cross-repo dependency is allowed only through released contracts, versioned artifacts, or explicit APIs. No repo may depend on another repo's source tree, private file layout, or hidden build order.

Chosen topology:
- Public:
  - `agenc-sdk`
  - `agenc-protocol`
  - `agenc-plugin-kit` (new)
- Private:
  - `agenc-core`
  - `agenc-prover` or `agenc-cloud`

Non-goals for Gate 11:
- do not publish the main runtime as the public extension model
- do not treat `mcp`, `docs-mcp`, or desktop control-plane contracts as ecosystem ABI
- do not let third-party plugins import private runtime internals directly

#### 11.2 Target Repository Topology

| Target repo | Visibility | Current ownership | Purpose | Explicit non-goals |
|-------------|------------|-------------------|---------|--------------------|
| `agenc-sdk` | Public | `sdk/` plus SDK-only starter examples | Stable TypeScript integration surface for builders | No runtime orchestration, operator tooling, or private control-plane code |
| `agenc-protocol` | Public | `programs/agenc-coordination/`, `zkvm/guest/`, protocol migrations, public IDL and generated contract artifacts | Public trust surface, on-chain semantics, proof journal schema, generated artifacts | No host-side prover ops, no runtime kernel |
| `agenc-plugin-kit` | Public | new repo/package extracted from current internal registry patterns | Narrow extension ABI: manifests, capability model, lifecycle hooks, certification harness, starter templates | No broad runtime types, no orchestration internals, no desktop/session-router internals |
| `agenc-core` | Private | `runtime/`, `mcp/`, `docs-mcp/`, `contracts/desktop-tool-contracts/`, `containers/desktop/server/`, `web/`, `mobile/`, `demo-app/`, internal examples, runtime-owned tools/scripts | Private kernel, operator stack, desktop control plane, apps, marketplace logic, policy/eval/orchestration | Not a public plugin SDK; not a general public runtime repo |
| `agenc-prover` or `agenc-cloud` | Private | `zkvm/host/`, remote prover services, benchmark/prover ops, hosted control-plane surfaces, proving deployment/auth/quota logic | Private proving moat and cloud/control-plane operations | No public trust ABI; no direct third-party extension surface |

#### 11.3 Current Path To Target Repo Map

This map is the canonical ownership plan for the current tree. Mixed folders must be drained into owner repos; they do not survive as mixed roots.

| Current path | Target repo | Visibility | Rule |
|--------------|-------------|------------|------|
| `sdk/**` | `agenc-sdk` | Public | Primary public builder surface |
| `examples/private-task-demo/**` | `agenc-sdk` | Public | Curated SDK-only starter example for the first extraction wave |
| `programs/agenc-coordination/**` | `agenc-protocol` | Public | Canonical on-chain program source |
| `zkvm/guest/**` | `agenc-protocol` | Public | Public proof/journal semantics and trust surface |
| `migrations/**` | `agenc-protocol` | Public | Protocol migration ownership belongs with the on-chain trust surface |
| `runtime/idl/**` | `agenc-protocol` | Public | Canonical generated protocol artifacts must move out of private core and be consumed as released artifacts |
| `runtime/src/types/agenc_coordination.ts` | `agenc-protocol` | Public generated artifact | Generated client artifact; `agenc-core` may consume it but must not own canonical truth |
| `runtime/**` except protocol-generated artifacts | `agenc-core` | Private | Private kernel and operator stack stay together |
| `mcp/**` | `agenc-core` | Private | Operator/control-plane surface, not public plugin ABI |
| `docs-mcp/**` | `agenc-core` | Private | Internal documentation/control-plane helper server |
| `contracts/desktop-tool-contracts/**` | `agenc-core` | Private | Internal runtime/desktop-server contract; may stay separately packaged but only for internal distribution |
| `containers/desktop/server/**` | `agenc-core` | Private | Desktop control-plane server remains part of the kernel |
| `web/**` | `agenc-core` | Private | Product UI, not public contract surface |
| `mobile/**` | `agenc-core` | Private | Product app, not public contract surface |
| `demo-app/**` | `agenc-core` | Private | Internal/demo product surface |
| `examples/**` other than `examples/private-task-demo/**` | `agenc-core` by default | Private unless rewritten | Additional SDK-only examples may be promoted later, but only after explicit ownership and verification are assigned |
| `tools/localnet-social/**` | `agenc-core` | Private | Runtime/operator bootstrap and smoke tooling |
| `tools/zk-admin/**` | `agenc-prover` | Private | Prover/protocol admin and benchmark ops remain private in v1 |
| `zkvm/host/**` | `agenc-prover` | Private | Host-side proof generation and proving operations |
| `benchmarks/**` | `agenc-prover` | Private | Benchmark evidence stays with proving/control-plane ops unless an explicit public benchmark program is created |
| `tests/**` | Drain by owner repo | Mixed transitional | Do not preserve a shared cross-repo root test tree; move tests into the repo that owns the contract being verified |
| `scripts/idl/**` | `agenc-protocol` | Public/internal-to-protocol | Protocol codegen and IDL support must follow protocol ownership |
| `scripts/**` remaining | Drain by owner repo | Mixed transitional | Runtime/watch/dev wrappers -> `agenc-core`; prover/deploy/benchmark ops -> `agenc-prover`; no mixed `scripts/` root after extraction |
| `docs/**` and root `README.md` / `REFACTOR*.md` | Drain by owner repo | Mixed transitional | Package/protocol/runtime docs move with the owning repo; whole-program split docs remain internal until extraction stabilizes |

#### 11.4 Public And Private Package Policy

Long-term public packages:
- `@tetsuo-ai/sdk`
- protocol artifact packages published from `agenc-protocol`
- `@tetsuo-ai/plugin-kit` plus any narrow companion packages needed for manifests, validation, or certification

Long-term private packages:
- `@tetsuo-ai/runtime`
- `@tetsuo-ai/mcp`
- `@tetsuo-ai/docs-mcp`
- `@tetsuo-ai/desktop-tool-contracts`
- `@tetsuo-ai/desktop-server`
- private proving/control-plane packages published from `agenc-prover`

Distribution rules:
1. Public packages may continue on public npm.
2. Private packages move to a private registry or private git distribution flow with explicit access control.
3. Already-published runtime-side packages are not treated as permanent public contracts; Gate 11 must add deprecation and migration notes before any visibility tightening.
4. No new public package may be created just because an internal seam exists. Public exposure requires a declared external use case, versioning policy, and compatibility harness.

#### 11.5 Plugin-Kit v1 Contract

`agenc-plugin-kit` is the public extension surface. It must start narrow.

Allowed extension classes in v1:
- tool packs
- provider adapters
- connector/channel adapters

Explicitly out of scope for v1:
- orchestration
- policy engine
- evaluation/replay engine
- marketplace ranking
- approvals
- subagent runtime
- desktop/session-router internals
- broad runtime object graphs or internal service locators

Required manifest contract:
- `plugin_id`
- `version`
- `api_version`
- `plugin_type`
- `declared_capabilities`
- `required_permissions`
- `config_schema`
- `storage_namespace`
- `migration_hooks`
- `healthcheck_contract`
- `resource_limits`

Required lifecycle contract:
- `register`
- `validateConfig`
- `start`
- `healthcheck`
- `drain`
- `stop`
- `migrate`
- `uninstall`

Enforcement rules:
1. Plugins may not import private `agenc-core` internals.
2. Plugins may access state only through host-provided APIs with plugin-owned namespaces.
3. Plugins must be enableable and disableable per tenant or workspace.
4. Plugin artifacts must be signed or allowlisted before activation.
5. Compatibility checks must run before activation, upgrade, or rollback.
6. Core must support kill switch and quarantine flows for faulty plugins.
7. Plugin removal must not corrupt core state or require code surgery in the kernel.

#### 11.6 Install / Enable / Disable / Remove Lifecycle

Enterprise plugin operations must follow this sequence:
1. `Submit`: receive plugin artifact plus manifest and provenance metadata.
2. `Verify`: validate signature/allowlist, manifest schema, `api_version`, and declared permissions.
3. `Certify`: run compatibility harness, contract tests, and policy checks before activation.
4. `Stage`: install artifact in a disabled state; no implicit enable on install.
5. `Configure`: validate tenant/workspace config against `config_schema`.
6. `Enable`: enable the plugin explicitly for a tenant/workspace/environment.
7. `Start`: start plugin runtime hooks with bounded resources and audit logging.
8. `Health`: require ongoing health checks and an operator-visible status surface.
9. `Disable`: stop new work admission without deleting plugin-owned state.
10. `Drain`: allow in-flight work to finish or expire safely.
11. `Stop`: terminate plugin execution and release resources.
12. `Uninstall`: run uninstall hooks, archive or delete plugin-owned state per policy, and detach the plugin cleanly.
13. `Rollback`: restore prior plugin version only after migration compatibility checks and state rollback validation pass.

Removal rule:
- If a plugin cannot be disabled, drained, stopped, and removed through this lifecycle, it is not an enterprise plugin boundary yet.

#### 11.7 Extraction Order

The extraction sequence is intentionally conservative:
1. Lock this boundary map and package policy in the authority docs.
2. Freeze the current repo as the future `agenc-core` baseline; do not begin by exploding the private kernel into many repos.
3. Extract `agenc-sdk` first, including SDK-only examples and release/docs authority for the public builder surface.
4. Extract `agenc-protocol` second, including:
   - `programs/agenc-coordination`
   - `zkvm/guest`
   - public IDL/generated artifacts
   - protocol migrations
5. Create `agenc-plugin-kit` third as a narrow public extension repo with certification harness and starter templates.
6. Extract `agenc-prover` fourth, including:
   - `zkvm/host`
   - proving services
   - `tools/zk-admin`
   - benchmark/proving ops
7. Keep `agenc-core` together as the private kernel:
   - `runtime`
   - `mcp`
   - `docs-mcp`
   - `contracts/desktop-tool-contracts`
   - `containers/desktop/server`
   - apps and internal examples/tools
8. Drain mixed roots (`scripts/`, `tests/`, `docs/`, `examples/`) into owner repos; do not preserve mixed top-level catch-all folders after extraction.
9. Migrate CI, release automation, docs authority, and package distribution only after the extracted repo proves build/test/pack/install independence.

#### 11.8 Rollback Points

Every extraction phase must be reversible.

Required rollback controls:
1. Tag the monorepo before each extraction wave.
2. Keep the monorepo release path authoritative until the extracted repo proves:
   - green build/test/typecheck
   - pack/install smoke
   - downstream consumer smoke on released artifacts
3. Mirror first, cut over second:
   - copy code into the new repo
   - stand up CI and release automation
   - verify consumers against released artifacts
   - only then delete or de-authoritize the monorepo copy
4. Do not delete a package surface from the monorepo until its replacement repo has passed at least one full release-quality validation cycle.
5. Keep migration notes and deprecation notices for any package moving from public to private distribution.

Rollback signal:
- If any extracted repo requires source-tree imports, hidden build-order assumptions, or emergency monorepo-only patches to stay green, cut back to the last monorepo tag and reopen the extraction phase rather than papering it over.

#### 11.9 Wave 1 — `agenc-sdk` Extraction Checklist

Wave 1 exists to prove the split on the safest public boundary before touching protocol or core extraction.

Wave 1 scope:
- Move to the new `agenc-sdk` repo:
  - `sdk/package.json`
  - `sdk/tsconfig.json`
  - `sdk/src/**`
  - `sdk/README.md`
  - `sdk/CHANGELOG.md`
  - `docs/api-baseline/sdk.json`
  - `examples/private-task-demo/**`
- Do **not** move in Wave 1:
  - `sdk/dist/**`
  - `sdk/node_modules/**`
  - protocol-owned generated artifacts
  - runtime-owned docs, scripts, or package contracts
  - uncurated SDK-only examples such as `examples/simple-usage/**` and `examples/risc0-proof-demo/**` until they have explicit public-example ownership and verification

Wave 1 new-repo bootstrap:
1. Create `agenc-sdk` as a standalone repo under the org.
2. Copy the Wave 1 scope into that repo without bringing `dist/` or `node_modules/`.
3. Generate a repo-local lockfile and CI.
4. Move the SDK package metadata to the new repo authority:
   - update `repository`
   - update `homepage`
   - update `bugs`
   - remove monorepo `directory` assumptions if introduced
5. Keep package identity stable:
   - package name remains `@tetsuo-ai/sdk`
   - consumer import paths do not change
6. Move SDK release authority into the new repo:
   - `CHANGELOG.md`
   - package publishing provenance
   - version tagging and release notes

Wave 1 test-authority fence:
1. `sdk/src/__tests__/idl-alignment.test.ts` currently reads `target/idl/agenc_coordination.json` from the monorepo.
2. That test may not move into the standalone SDK repo unchanged.
3. Before cutover, choose one of:
   - move the IDL-alignment contract test to `agenc-protocol`
   - rewrite it to consume a released protocol artifact/package
   - keep it as a cross-repo integration job owned outside the SDK repo
4. No SDK repo test may depend on monorepo `target/` paths after extraction.

Wave 1 release gates in the new repo:
1. `npm ci`
2. `npm run build`
3. `npm run typecheck`
4. `npm run test`
5. `npm pack`
6. clean temp `npm install <tarball>` smoke
7. SDK API baseline check against the moved `docs/api-baseline/sdk.json`
8. publish-provenance/release workflow check for the new repo authority

Current monorepo hazards that must be removed during cutover:
1. Root workspace orchestration still assumes local SDK ownership:
   - `package.json` `build`
   - `package.json` `build:sdk`
   - `package.json` `test`
   - `package.json` `typecheck`
2. MCP build config still aliases the SDK to a monorepo-local built file:
   - `mcp/tsup.config.ts`
3. Example smoke tooling still assumes `sdk/dist` and `./sdk/node_modules` exist locally:
   - `scripts/smoke-test-examples.sh`
4. Desktop container build still copies the monorepo SDK tree into the image:
   - `containers/desktop/Dockerfile`
5. SDK package metadata still points at the monorepo issue/repo surface:
   - `sdk/package.json`
6. Root docs and package inventory still link the SDK to the monorepo path as if it were permanently local:
   - `README.md`
   - package/version maps and release docs
7. Current pack-smoke and CI path filters still treat the SDK as a monorepo-owned package:
   - `scripts/pack-smoke.mjs`
   - `.github/workflows/package-pack-smoke.yml`
8. Fixed-version consumers will need a coordinated release bump once the first SDK release comes from the new repo:
   - `runtime/package.json`
   - `mcp/package.json`
   - `tools/localnet-social/package.json`
   - `tools/zk-admin/package.json`
   - SDK-dependent example `package.json` files

Wave 1 cutover sequence:
1. Mirror first:
   - create `agenc-sdk`
   - stand up CI/release/pack-smoke there
   - publish a release from the new repo
2. Cut root workspace authority second:
   - remove `sdk` from the root workspace list only after the new repo release is green
   - rewrite root `build` / `test` / `typecheck` scripts so the private repo no longer treats SDK as a local workspace owner
   - regenerate the root lockfile after removing workspace ownership
3. Remediate build/path assumption consumers:
   - remove the `mcp/tsup.config.ts` alias to `../sdk/dist/index.js`
   - replace desktop image `COPY sdk/` with install of the released `@tetsuo-ai/sdk` package or prepacked SDK artifact
   - rewrite `scripts/smoke-test-examples.sh` so it no longer requires `sdk/dist` or `./sdk/node_modules/esbuild`
   - convert root pack-smoke and package-pack-smoke CI from local SDK packing to released-SDK or transitional mirror validation, then remove SDK from the monorepo smoke matrix once cutover is complete
4. Cut downstream package consumers:
   - keep imports on `@tetsuo-ai/sdk`
   - bump pinned SDK versions to the first extraction release where needed
   - keep runtime/core code importing the package name only
5. Validate the private monorepo against the released SDK artifact:
   - `npm run build`
   - `npm run typecheck`
   - `npm run test`
   - `npm run pack:smoke`
   - `npm run test --workspace=@tetsuo-ai/mcp`
   - `npm run test --workspace=@tetsuo-ai/runtime`
   - `npm run test --workspace=@tetsuo-ai/desktop-server`
   - downstream example/tool smokes that depend on `@tetsuo-ai/sdk`
6. Update authority docs after cutover:
   - root `README.md`
   - version/doc maps
   - any package inventory still presenting SDK as monorepo-local
7. Only after one full green release-quality cycle:
   - de-authorize the monorepo copy of `sdk/`
   - remove SDK ownership from the monorepo workspace list
   - point root docs to the new repo as canonical SDK authority

Wave 1 execution status (`2026-03-16`):
- completed:
  - standalone repo `tetsuo-ai/agenc-sdk` exists
  - `@tetsuo-ai/sdk@1.3.1` was published from that repo
  - root workspace ownership was removed for `sdk` and `examples/private-task-demo`
  - the concrete cutover blockers in `mcp/tsup.config.ts`, `scripts/smoke-test-examples.sh`, `containers/desktop/Dockerfile`, `scripts/pack-smoke.mjs`, and `.github/workflows/package-pack-smoke.yml` were removed
  - the private monorepo validated against the released SDK artifact instead of a sibling workspace build
  - root docs now point at `tetsuo-ai/agenc-sdk` as canonical SDK authority
- intentionally retained:
  - local `sdk/` and `examples/private-task-demo/` copies remain only as de-authorized rollback mirrors while Gate 11 continues
- non-blocking note:
  - `scripts/smoke-test-examples.sh` still reports pre-existing runtime-heavy example bundling failures unrelated to the SDK cutover; SDK-dependent examples passed and the Wave 1 package proofs are green

Wave 1 rollback:
1. Tag the monorepo before creating the extraction branch.
2. Keep the monorepo SDK copy as the fallback until:
   - the new repo publishes successfully
   - the private monorepo validates against the released package
   - no build/test/container flow still expects local `sdk/`
3. If any consumer still requires `../sdk`, `sdk/dist`, or local-copy image assembly to stay green, cut back to the monorepo tag and reopen Wave 1 instead of papering over the dependency.

Wave 1 exit signal:
- `agenc-sdk` builds, tests, packs, and publishes independently
- the private monorepo consumes the released SDK artifact without local path assumptions
- the curated public SDK example lives with the SDK repo
- the SDK API baseline and package docs have moved with the SDK repo

#### 11.10 Wave 2 — `agenc-protocol` Bootstrap Checklist

Wave 2 exists to establish a standalone public trust-surface owner before consumer cutover starts inside the private monorepo.

Wave 2 bootstrap scope:
- moved to the new `agenc-protocol` repo:
  - `programs/agenc-coordination/**`
  - `programs/agenc-coordination/fuzz/**`
  - `migrations/**`
  - `zkvm/guest/**`
  - `zkvm/Cargo.toml`
  - `zkvm/Cargo.lock`
  - `scripts/idl/verifier_router.json`
- committed generated artifacts owned by the new repo:
  - `artifacts/anchor/idl/agenc_coordination.json`
  - `artifacts/anchor/types/agenc_coordination.ts`
  - `artifacts/anchor/manifest.json`

Wave 2 completed:
1. `tetsuo-ai/agenc-protocol` exists and PR `#1` merged on `main`.
2. The standalone repo bootstraps the public trust surface without pulling in private runtime/core ownership.
3. Repo-local artifact automation exists via `scripts/sync-anchor-artifacts.mjs`.
4. The protocol repo validated with:
   - `anchor build`
   - `npm run artifacts:refresh`
   - `npm run artifacts:check`
   - `cargo fmt --manifest-path programs/agenc-coordination/Cargo.toml --all --check`
   - `cargo fmt --manifest-path zkvm/guest/Cargo.toml --all --check`

Not yet cut over inside AgenC:
- `runtime/idl/**`
- `runtime/src/types/agenc_coordination.ts`
- `runtime/scripts/copy-idl.js`
- root `tests/**` imports from `target/idl/**` or `target/types/**`
- `sdk/src/__tests__/idl-alignment.test.ts`

Next-slice blockers:
- `runtime/scripts/copy-idl.js`
- `runtime/src/idl.ts`
- `runtime/src/events/idl-drift-check.ts`
- `runtime/src/types/agenc_coordination.ts`
- `sdk/src/__tests__/idl-alignment.test.ts`
- root tests importing `target/types/agenc_coordination.ts`

Wave 2 exit signal:
- `agenc-protocol` owns the public trust-surface bootstrap, committed generated artifacts, and repo-local refresh/check automation
- AgenC is ready to start consumer cutover against released protocol artifacts without ambiguity about source-of-truth ownership

#### 11.11 Gate 11 Exit Signal

Gate 11 is complete only when:
1. The public/private repo topology is implemented, not merely described.
2. Public packages and private packages follow the declared distribution policy.
3. `agenc-plugin-kit` exists as a narrow certified extension ABI rather than a vague promise.
4. No extracted repo depends on another repo's private source tree, local file layout, or undocumented build order.
5. Mixed root folders have been drained into owner repos or explicitly retained with documented ownership.
6. Docs authority, release automation, and CI reflect the extracted topology.

### 5.4 Gate 12 — Legacy Deletion And Convergence

Status: `BLOCKED`

Starts only after the Gate 11 public/private boundary and extraction topology are materially stable.

Required work:
1. Remove transitional compatibility shims that are now dead.
2. Remove stale gate/status language from older docs.
3. Delete or isolate dead demos/examples/scripts that no longer belong in the architecture.
4. Collapse temporary Gate 10 execution artifacts into canonical long-term docs where appropriate.
5. Close any remaining docs-mcp helper-semantics drift against the master program.

Required proof:
1. Every deletion has search evidence.
2. Every public-surface change has matching baseline/IDL/docs updates.
3. Release notes or migration notes exist for any consumer-visible removal.
4. No plan-vs-code mismatch remains in active refactor docs.

Exit signal:
- The planning layer, codebase, generated artifacts, and documentation all tell the same story without transitional scaffolding.

---

## 6. Dependency-Safe Execution Order

1. Keep Gates 0 through 9 locked and truthful.
2. Execute Gate 10 in this order:
   - 10.0 Truth lock
   - 10.1 Candidate split matrix
   - 10.2 Remove repo-coupled consumers
   - 10.3 Split-pack/install harness
   - 10.4 Artifact handoff closure
   - 10.5 CI/docs/docs-mcp synchronization
   - 10.6 Exit review
3. Only after Gate 10 passes, execute Gate 11.
4. Only after the Gate 11 decision is stable, execute Gate 12.

---

## 7. Forbidden Shortcuts

1. Do not claim split readiness before clean-environment packaging proof exists.
2. Do not treat root scripts/demo as “close enough” while they still use repo-relative source imports.
3. Do not defer baseline, IDL drift, codegen, benchmark, or docs updates to a later cleanup gate.
4. Do not let `docs-mcp` helper semantics remain the de facto authority for refactor sequencing while they still model the legacy runtime roadmap.
5. Do not reactivate stale trackers or stale completion language.

---

## 8. Definition Of Done

This roadmap is complete only when:

1. `REFACTOR-MASTER-PROGRAM.md` and active gate evidence docs reflect the codebase as it actually exists.
2. Gate 10 is fully green.
3. Gate 11 is explicitly resolved.
4. Gate 12 removes transitional debt without breaking verified surfaces.
5. The completion criteria in `REFACTOR-MASTER-PROGRAM.md` Section 14 are satisfied in full.
