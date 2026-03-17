# REFACTOR EXECUTION ROADMAP

Status: **Live program roadmap and evidence log for `REFACTOR-MASTER-PROGRAM.md`.**
Last synced: `2026-03-16`.

---

## 1. Executive Verdict

- The refactor program is **not complete**.
- Gates 0 through 9 have materially established monorepo modularity and produced the required gate artifacts.
- Gate 10 passed its final exit review on `2026-03-16` for the current split-candidate scope.
- Gate 11 is now ready to start.
- Gate 12 remains blocked until the Gate 11 split/no-split decision is materially stable.
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
  - `runtime` uses `@tetsuo-ai/sdk`
  - `mcp` uses `@tetsuo-ai/runtime` and `@tetsuo-ai/sdk`
  - packaged examples use `@tetsuo-ai/sdk`

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

Temporary npm publish under `@tetsuo-ai/*` is proven:
  - `@tetsuo-ai/sdk@1.3.0`, `@tetsuo-ai/runtime@0.1.0`, `@tetsuo-ai/mcp@0.1.0`, and `@tetsuo-ai/docs-mcp@0.1.0` all published and installed successfully from clean temp consumers on `2026-03-16`
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
| 11 | Optional repository split | READY | Gate 10 exit review passed in this roadmap | Choose split/no-split topology and define rollback/documentation ownership |
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
| `examples/private-task-demo` | Examples + Runtime | `npm run demo:private-task -- --help` | `@tetsuo-ai/sdk`, `@tetsuo-ai/runtime` | pass |
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
- `[2026-03-16]` Temporary registry publish under `@tetsuo-ai/*` results:
  - `@tetsuo-ai/sdk@1.3.0` published and installed successfully from a clean temp project
  - `@tetsuo-ai/runtime@0.1.0` published and installed successfully from a clean temp project
  - `@tetsuo-ai/mcp@0.1.0` published and installed successfully from a clean temp project; installed `.bin/agenc-mcp` is present despite npm's noisy publish-time `bin[...] removed` warning
  - `@tetsuo-ai/docs-mcp@0.1.0` published and installed successfully from a clean temp project; the earlier `404` was npm registry propagation lag, not a package-manifest failure
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

### 5.3 Gate 11 — Optional Repository Split

Status: `READY`

Gate 10 is green. Gate 11 can now start.

Required decision:
1. Decide whether the repo should actually split.
2. If **no split**, record that monorepo modularity is the chosen steady state and move directly to Gate 12 cleanup.
3. If **split**, produce a topology plan covering:
   - target repos
   - release sequencing
   - consumer install-path migration
   - docs authority migration
   - CI migration
   - rollback path back to the monorepo release topology

Exit signal:
- The split/no-split decision is explicit, documented, and reversible.

### 5.4 Gate 12 — Legacy Deletion And Convergence

Status: `BLOCKED`

Starts only after Gate 10 is green and the Gate 11 decision is stable.

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
