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
