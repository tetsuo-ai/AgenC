## PR #1541: fix(concordia): restore planned session and checkpoint flow
- **Date:** 2026-04-01
- **Files changed:** `agenc-plugin-concordia` bridge/session/memory lifecycle surfaces, Concordia Python runner/checkpoint engine surfaces, Concordia bridge tests, root tech-debt notes
- **What worked:** restoring deterministic sessions, request-correlated routing, semantic memory integration, and checkpoint/resume support brought the live implementation back in line with the original Concordia source-of-truth without giving up the better direct-plugin integration and observation fixes
- **What didn't:** the current bridge/orchestration surface is still too concentrated in `agenc-plugin-concordia/src/adapter.ts`, and the sequential/simultaneous engine restoration logic still has duplicated maintenance points
- **Rule added to CLAUDE.md:** no
