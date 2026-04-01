# Repository Guidelines

## Repo Role

`/home/tetsuo/git/AgenC` is the live AgenC umbrella repo and the local
workspace root.

This repo currently contains:

- nested canonical repos:
  - `agenc-core/`
  - `agenc-protocol/`
  - `agenc-sdk/`
  - `agenc-plugin-kit/`
  - `agenc-prover/`
- the public umbrella surface at the root

The root currently owns:

- public landing docs
- repository topology and contributor routing
- bootstrap scripts
- public-safe examples

It does not own the private engine, prover code, or protocol source-of-truth.

## Current-state notes

Use the root note set for current context:

- `.claude/notes/workspace-map.md`
- `.claude/notes/architecture-current-state.md`
- `.claude/notes/folder-inventory.md`
- `.claude/notes/package-command-inventory.md`
- `.claude/notes/repo-deep-dive.md`
- `.claude/notes/module-surface-map.md`
- `.claude/notes/decisions.md`
- `.claude/notes/patterns.md`
- `.claude/notes/gotchas.md`

Use `.claude/history/umbrella-repo-notes/` for refactor-era historical notes.

## Canonical Repos

- `agenc-sdk` -> public SDK
- `agenc-protocol` -> public protocol/trust surface
- `agenc-plugin-kit` -> public plugin ABI
- `agenc-core` -> private engine, runtime, MCP, apps, internal tools
- `agenc-prover` -> private prover, admin, ops

## Project Structure

- root `examples/`: retained public examples only
- root `docs/`: umbrella docs and pointer docs
- root `scripts/`: bootstrap and boundary checks only
- root `assets/`: public media/support assets
- nested repos: canonical ownership by repo listed above

## Commands

- `npm install --no-fund`
- `npm run validate:umbrella`
- `npm run check:public-contract-boundary`
- `npm run check:umbrella-boundary`
- `npm run check:public-examples`
- `./scripts/bootstrap-agenc-repos.sh --root <dir> [--private]`

## Working Rules

- This root is the actual umbrella git repo again.
- Use plain `git ...` at the root for umbrella work.
- Use `git -C <nested-repo> ...` for sibling repo work.
- Do not reintroduce private-kernel or protocol-owned code into the root umbrella surface.
- Do not add root workspaces beyond the retained public examples.
- Do not add root scripts or workflows that assume local `runtime`, `mcp`, `programs`, or prover trees.
- When doing a workspace-wide crawl, prefer the root note set first; subagent crawling may be quota-blocked and should not stop local analysis.
- SDK changes belong in `agenc-sdk`.
- Protocol changes belong in `agenc-protocol`.
- Plugin ABI changes belong in `agenc-plugin-kit`.
- Private runtime, app, desktop, and operator work belongs in `agenc-core`.
- Prover and admin work belongs in `agenc-prover`.

## Learned Rules

### Runtime Budgets: Check hardcoded economics ceilings, not just exposed LLM limits
- **Trigger:** A user asks for unlimited or maxed runtime/planner budgets in AgenC
- **Correct approach:** Inspect both `llm.*` config limits and the runtime economics policy wiring. If economics mode is still hardcoded to `enforce`, expose or override it instead of assuming timeout/token knobs are sufficient.
- **Learned:** 2026-03-26

### Concordia Simulation: Fix the contract failure, not the output symptom
- **Trigger:** Concordia action/observation turns degrade, repeat, or echo instructions
- **Correct approach:** Trace the exact bridge, executor, and GM contract first. Do not add canned fallback actions, generic text substitution, or other output-masking patches in the live simulation path. Prefer fixing prompt/response contracts, retry behavior, model routing, or component wiring at the source.
- **Learned:** 2026-04-01

### Concordia Simulation: Carry explicit simulation turn metadata and in-world framing
- **Trigger:** Concordia turns are routed through the generic daemon path and start inheriting exact-response coercion, slow reasoning routing, or tool-using assistant behavior
- **Correct approach:** Mark Concordia agent turns with explicit runtime turn-contract metadata, route them through the direct non-planner/tool-suppressed path, prefer the fast non-reasoning model route, and prepend simulation-specific in-world context so agents never talk about tools, files, prompts, or runtime internals.
- **Learned:** 2026-04-01

### Concordia Context: Verify live code and git history before claiming Concordia architecture details
- **Trigger:** A user asks about current Concordia wiring, ownership, or runtime behavior in this workspace
- **Correct approach:** Inspect the live repo state, relevant `.claude/notes`, and actual git/GitHub history before answering. Do not assume old notes or partial memory reflect the current Concordia architecture.
- **Learned:** 2026-04-01
