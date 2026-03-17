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
