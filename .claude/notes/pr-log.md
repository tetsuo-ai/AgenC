## PR #1541: fix(concordia): restore planned session and checkpoint flow
- **Date:** 2026-04-01
- **Files changed:** `agenc-plugin-concordia` bridge/session/memory lifecycle surfaces, Concordia Python runner/checkpoint engine surfaces, Concordia bridge tests, root tech-debt notes
- **What worked:** restoring deterministic sessions, request-correlated routing, semantic memory integration, and checkpoint/resume support brought the live implementation back in line with the original Concordia source-of-truth without giving up the better direct-plugin integration and observation fixes
- **What didn't:** the current bridge/orchestration surface is still too concentrated in `agenc-plugin-concordia/src/adapter.ts`, and the sequential/simultaneous engine restoration logic still has duplicated maintenance points
- **Rule added to CLAUDE.md:** no

## PR #1543: fix(concordia): remove broken cjs plugin build path
- **Date:** 2026-04-02
- **Files changed:** `agenc-plugin-concordia/package.json`, root note updates
- **What worked:** the runtime only loads channel plugins via dynamic `import()`, so shipping `@tetsuo-ai/plugin-concordia` as ESM-only removed the `import.meta.url` CJS build warning cleanly without changing runtime loading behavior
- **What didn't:** there is still follow-up refactor debt in the Concordia adapter/memory-wiring modules, but not in the packaging path
- **Rule added to CLAUDE.md:** no

## PR #1545: fix(concordia): restore simulation launch path
- **Date:** 2026-04-02
- **Files changed:** `concordia_bridge` sequential/simultaneous engine surfaces, Concordia Python tests, root gotchas/tech-debt notes
- **What worked:** aligning the simultaneous engine with the runner's shared `scenes` input and restoring Concordia's exact observation prompt contract removed the launch-time 500 and let fresh simulations survive setup plus the first real observation/action turn
- **What didn't:** scene lifecycle handling is still duplicated between the sequential and simultaneous engines, and Concordia turn routing still logs `send() missing request_id` during live runs
- **Rule added to CLAUDE.md:** no

## PR #1549: fix(concordia): accept labeled GM choice responses
- **Date:** 2026-04-03
- **Files changed:** `concordia_bridge/runner.py`, `concordia_bridge/tests/test_runner.py`, root tech-debt notes
- **What worked:** normalizing and parsing labeled multiple-choice replies in the Concordia runner removed the brittle exact-match failure that was crashing GM resolution on valid answers like `(a) Yes`
- **What didn't:** this verifies the parser path and engine tests, but a fresh live sim replay is still the best follow-up for full runtime confidence
- **Rule added to CLAUDE.md:** no
