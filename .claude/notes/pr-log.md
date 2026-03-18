## PR #1482: refactor(repo): close Gate 10 split-readiness
- **Date:** 2026-03-16
- **Files changed:** Gate 10 authority docs, desktop tool-contract packaging, runtime watch ownership, docs-mcp cleanup, example/tool surface reclassification, pack-smoke and split-readiness verification surfaces
- **What worked:** Closing Gate 10 against live evidence forced the package/artifact boundaries, docs-mcp scope, and root script ownership model into one consistent shape.
- **What didn't:** The status story was duplicated across multiple authority sections, so the final sync required updating both `REFACTOR.MD` and `REFACTOR-MASTER-PROGRAM.md` together.
- **Rule added to CLAUDE.md:** no

## PR tetsuo-ai/agenc-sdk#1: feat(repo): bootstrap standalone agenc-sdk
- **Date:** 2026-03-16
- **Files changed:** standalone SDK repo bootstrap, SDK CI/publish workflows, API baseline check, pack smoke harness, curated `private-task-demo` example
- **What worked:** The safest extraction path was mirror first, publish from the new repo, then make the monorepo consume the released `@tetsuo-ai/sdk@1.3.1` artifact instead of a local workspace build.
- **What didn't:** The first local bootstrap left `/home/tetsuo/git/agenc-sdk` as a plain folder instead of a real git worktree, so the repo had to be initialized and pushed before the public links were trustworthy.
- **Rule added to CLAUDE.md:** no

## PR #1483: refactor(repo): extract agenc-sdk and cut monorepo ownership
- **Date:** 2026-03-16
- **Files changed:** root workspace scripts, pack-smoke/CI, Docker build path, consumer package versions, authority docs, SDK mirror de-authorization
- **What worked:** Validating against released `@tetsuo-ai/sdk@1.3.1` before removing workspace ownership kept the monorepo cutover honest.
- **What didn't:** Authority drift included `README`, `AGENTS`, `CLAUDE`, version maps, and example guidance, so the monorepo cleanup touched more docs than the package move itself.
- **Rule added to CLAUDE.md:** no

## PR tetsuo-ai/agenc-protocol#1: feat(repo): bootstrap agenc-protocol trust surface
- **Date:** 2026-03-16
- **Files changed:** standalone protocol repo bootstrap, program source, fuzz suite, migrations, public zkVM guest, committed generated artifacts, artifact sync/check automation, CI
- **What worked:** Mirror-first trust-surface bootstrap avoided runtime/test churn and established the public artifact owner before consumer cutover.
- **What didn't:** Empty-repo bootstrap required initializing `main` before a normal PR flow worked.
- **Rule added to CLAUDE.md:** no

## PR #1484: docs(refactor): record agenc-protocol bootstrap wave
- **Date:** 2026-03-16
- **Files changed:** `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md`, tracked PR log updates
- **What worked:** Recording the standalone protocol bootstrap immediately after the repo launch kept Gate 11 from drifting back into vague “extract protocol next” status language.
- **What didn't:** `.claude/notes` is gitignored in this repo, so the tracked PR log still requires a forced add and the local gotcha/tech-debt notes remain session-local artifacts.
- **Rule added to CLAUDE.md:** no

## PR #1485: refactor(plugin-kit): bootstrap public host ABI
- **Date:** 2026-03-16
- **Files changed:** `plugin-kit/**`, runtime plugin host seam, protocol artifact cutover in runtime/tests, pack-smoke and breaking-change gates, Gate 11 authority docs
- **What worked:** Landing the public `plugin-kit` contract and the private runtime host seam together kept the ABI and the host enforcement rules in one coherent wave.
- **What didn't:** The root `npm run test` gate initially failed because stale runtime IDL validation tests still described the old vendored-artifact model, so the protocol wording and tests had to be synchronized before the branch was truly green.
- **Rule added to CLAUDE.md:** no

## PR tetsuo-ai/agenc-plugin-kit#1: feat(repo): bootstrap standalone agenc-plugin-kit
- **Date:** 2026-03-16
- **Files changed:** standalone plugin-kit package source, compatibility matrix, certification tests, API baseline script, pack-smoke script, CI/publish workflows
- **What worked:** Bootstrapping the public repo before cutting AgenC over kept the contract owner and the private host implementation properly separated.
- **What didn't:** The repo already existed with only an auto-init README, so the bootstrap had to adopt that state instead of assuming a clean repo creation path.
- **Rule added to CLAUDE.md:** no

## PR tetsuo-ai/agenc-plugin-kit#3: docs(repo): add plugin-kit starter and changelog
- **Date:** 2026-03-16
- **Files changed:** `CHANGELOG.md`, `templates/channel-adapter-starter/**`, README starter guidance, CODEOWNERS
- **What worked:** Adding a narrow starter template and release-history surface early made the public repo feel like a maintained product surface instead of a raw extracted package.
- **What didn't:** The follow-up hardening commit initially landed on local `main`, so it had to be moved onto a dedicated feature branch before pushing.
- **Rule added to CLAUDE.md:** no

## PR tetsuo-ai/agenc-prover#25: feat(admin-tools): bootstrap prover admin slice
- **Date:** 2026-03-16
- **Files changed:** `admin-tools/**`, private repo CI, boundary check, README/.gitignore/.dockerignore hardening
- **What worked:** Bootstrapping only the approved admin slice into the existing private prover repo kept the Rust proving service intact while establishing a real private home for zk config admin and devnet preflight tooling.
- **What didn't:** The first merge attempt failed because `agenc-prover/main` had moved and the README had picked up a newer operator runbook, so the branch had to be rebased and the bootstrap section merged cleanly into the newer doc.
- **Rule added to CLAUDE.md:** no

## PR #1488: refactor(kernel): de-authorize prover admin and wire private registry
- **Date:** 2026-03-17
- **Files changed:** `tools/proof-harness/**`, private-kernel package manifests/docs, `scripts/private-registry-*.mjs`, `scripts/private-kernel-distribution*.mjs`, `containers/private-registry/**`, `.github/workflows/private-kernel-registry.yml`, proof-harness boundary workflow/docs
- **What worked:** Treating the private registry as a real supply-chain boundary forced the right fixes: volume ownership for the non-root Verdaccio container, deterministic service-account bootstrap, authenticated dry-run, and live publish/install rehearsal for the staged private packages.
- **What didn't:** The first bootstrap attempt was aimed at npm prompt automation, but the actual root cause was server-side `EACCES` on the auth volume and the rehearsal initially measured the wrong failure because the fixture version was a prerelease and the workflow order ran dry-run after live publish.
- **Rule added to CLAUDE.md:** no

## PR #1489: build(registry): wire private kernel to cloudsmith
- **Date:** 2026-03-17
- **Files changed:** canonical private-kernel distribution config, Cloudsmith hosted workflow/docs, private-kernel distribution probe logic, private registry rehearsal path, Verdaccio service hardening
- **What worked:** Keeping Verdaccio as the always-on reference backend while wiring Cloudsmith as the protected hosted backend let the repo gain the permanent registry contract without reopening the local/CI supply-chain proof.
- **What didn't:** GitHub cannot dispatch a brand-new `workflow_dispatch` workflow until the workflow file exists on the default branch, and the Verdaccio service still had a hidden host-permission bug because directly mounted config files could be unreadable to the non-root container user under a restrictive local `umask`.
- **Rule added to CLAUDE.md:** no

## PR #1491: fix(runtime): restore packaged private-kernel bin entries
- **Date:** 2026-03-17
- **Files changed:** `runtime/src/bin/*.ts`, `runtime/tsup.config.ts`, `runtime/scripts/check-package-entrypoints.mjs`, `runtime/package.json`, `scripts/private-registry-rehearsal.mjs`, `scripts/private-registry-rehearsal.test.mjs`, `docs/PRIVATE_REGISTRY_SETUP.md`
- **What worked:** The fix stayed at the real contracts: track the runtime bin sources that had been swallowed by the broad `bin/` ignore rule, make the build explicitly use the tsup config, enforce the packaged entrypoint contract in CI, and give Cloudsmith hosted rehearsal a bounded retry window for fresh publish reads. The final hosted workflow passed on run `23223356319`.
- **What didn't:** The first hosted runs exposed two separate false assumptions: Cloudsmith should behave like the Verdaccio reference backend for public-scope publish denial, and successful publish should imply immediate hosted `npm view` consistency. Both assumptions had to be removed from the rehearsal contract.
- **Rule added to CLAUDE.md:** no

## PR #1492: docs(refactor): lock proof-harness ownership in agenc-core
- **Date:** 2026-03-17
- **Files changed:** `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md`, `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md`, `docs/PRIVATE_KERNEL_DISTRIBUTION.md`, `docs/architecture/adr/adr-002-public-contract-private-kernel-boundary.md`, runtime-side package READMEs, `README.md`, `docs/VERSION_DOCS_MAP.md`, `tools/proof-harness/{README.md,package.json}`
- **What worked:** The decision was grounded in current code, not aspiration: `tools/proof-harness` is coupled to AgenC-local bootstrap scripts, root proof tests, and local fixtures, so making it a permanent `agenc-core` validation harness removed a fake shared-contract seam and simplified the Gate 11 closeout checklist.
- **What didn't:** The support-window language had drifted across multiple docs and had to be split into distinct authority docs for distribution mechanics versus deprecation/support policy before the proof-harness decision could be encoded cleanly.
- **Rule added to CLAUDE.md:** no

## PR #1493: docs(refactor): close Gate 11 exit review
- **Date:** 2026-03-17
- **Files changed:** `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md`, `docs/architecture/guides/integration-points.md`, `docs/architecture/guides/type-conventions.md`, `docs/architecture/phases/phase-01-gateway.md`, `docs/architecture/runtime-layers.md`, `docs/design/speculative-execution/{API-SPECIFICATION.md,DESIGN-DOCUMENT.md,IMPLEMENTATION-GUIDE.md}`
- **What worked:** The closeout stayed evidence-driven: the exit review was rerun on the live repo, the authority docs now record the exact verification matrix that passed, and the remaining internal runtime/design docs were reframed so they cannot be mistaken for the public builder API.
- **What didn't:** A first verification attempt produced a false `mcp` typecheck failure because root `build` and root `typecheck` were run in parallel while `runtime/dist` was being rebuilt, which looked like a package-boundary regression until the checks were rerun sequentially.
- **Rule added to CLAUDE.md:** no

## PR #1494: refactor(repo): close Gate 12 convergence
- **Date:** 2026-03-17
- **Files changed:** deleted `sdk/**`, `plugin-kit/**`, and `examples/private-task-demo/**`; added `docs/SDK.md`; renamed `scripts/check-plugin-kit-extraction-boundary.mjs` to `scripts/check-public-contract-boundary.mjs`; updated `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md`, private-kernel/docs-mcp docs, workflow wiring, and final convergence notes
- **What worked:** Treating Gate 12 as an evidence-driven convergence pass avoided fake cleanup. The local public-package mirrors were removed, the broadened boundary guard was renamed to match its real scope, the retained compatibility seams were explicitly classified, and the final verification matrix stayed green end to end.
- **What didn't:** The dead-surface audit did not justify another large deletion wave, so the only safe code cleanup beyond mirror removal was two unused exports in retained tooling. A sloppy search command also hit zsh backtick parsing during the closeout audit and had to be rerun cleanly before trusting the result.
- **Rule added to CLAUDE.md:** no

## PR #1495: docs(topology): add agenc-core umbrella bootstrap
- **Date:** 2026-03-17
- **Files changed:** `README.md`, `package.json`, `docs/REPOSITORY_TOPOLOGY.md`, `scripts/bootstrap-agenc-repos.sh`
- **What worked:** Splitting the work into a real private `agenc-core` bootstrap plus a small umbrella-side topology/bootstrap PR kept the public entrypoint stable while making the new repo layout explicit and runnable for contributors.
- **What didn't:** The first core mirror omitted `tests/` and `containers/private-registry/`, which surfaced immediately in `agenc-core` validation. Runtime LiteSVM suites also had to be split into an explicit `test:cross-repo-integration` target because they depend on protocol workspace fixtures rather than the standalone core package graph alone.
- **Rule added to CLAUDE.md:** no
