# REFACTOR MASTER PROGRAM — AgenC Single Source Of Truth

> The canonical whole-repository refactor plan for AgenC.
>
> This is the only planning document that is allowed to define refactor scope, sequencing, acceptance gates, rollback expectations, and completion criteria for the codebase.
>
> All prior refactor planning documents have been retired from the active tree. This file is the program of record.

---

## 1. Mandate

This repository is not undergoing a runtime cleanup. It is undergoing a whole-codebase refactor program.

The requirement is not:

- make the package map cleaner
- split things because the diagram looks nice
- optimize for speed
- stop when the runtime feels modular enough

The requirement is:

- cover every meaningful source-bearing and build-bearing surface in the repository
- remove false seams and create real ones
- preserve correctness and operability during transition
- keep the repository buildable and testable at every gated milestone
- allow the refactor to take as long as needed

Nothing is exempt because it is awkward, legacy, large, cross-language, or hard.

---

## 2. Success Definition

The refactor is successful only when all of the following are true:

1. Every major domain in the repository has an explicit contract boundary and owner.
2. Runtime control plane, runtime execution domains, protocol, SDK, zkVM, desktop platform, MCP servers, app consumers, docs tooling, scripts, and tests are all planned and migrated under the same program.
3. No major consumer depends on private source-path imports across domain boundaries.
4. Generated artifacts, codegen pipelines, container image expectations, and CI gates are treated as first-class architecture.
5. The core package build closure remains closed over the repo surfaces it owns.
6. Transitional compatibility layers are deliberate, documented, and removed only when truly dead.
7. Repository splits, if any, happen only after modularity is proven inside the monorepo.
8. The final architecture is simpler, more explicit, and easier to operate than the current one.

If any of those are false, the program is incomplete.

---

## 3. Single-Source Rule

This file is the refactor source of truth.

Rules:

1. No other refactor-planning markdown file is allowed to compete with this document in the active tree.
2. `REFACTOR.MD` is the executable gate-level roadmap and evidence log, and must be kept synchronized with this document.
3. If new evidence changes the plan, this document must be updated directly.
4. The repository must converge on one plan, not a stack of competing plans.

---

## 4. Full Repository Inventory

The refactor program covers the whole repository, not only the runtime-heavy directories.

### 4.1 Core Product and Protocol Domains

| Surface | Current Path | What It Is | Refactor Requirement |
|---------|--------------|------------|----------------------|
| On-chain program | `programs/agenc-coordination/` | Anchor Solana program (44 IDL instructions, 54 Rust instruction files, 200 error codes, 49 events, 22 IDL accounts, 9 fuzz targets), instruction handlers, state/event logic including `ZkConfig` governance | Refactor instruction/state/event ownership without breaking protocol semantics |
| SDK | `sdk/` (transitional rollback mirror; canonical repo is `tetsuo-ai/agenc-sdk`) | TypeScript SDK for protocol, proofs, tokens, transactions, program access, prover backends (`prover.ts`), process identity (`process-identity.ts`) | Separate public API from internal implementation and generated/client plumbing, then move canonical release ownership to the standalone SDK repo |
| Runtime | `runtime/` (~392k lines, 32 src directories, ~319 test files, ~6,427 test cases) | agent runtime, daemon, gateway (70+ source files), llm (ChatExecutor split into 15+ modules), workflow, tools, channels, desktop layer, evaluation, observability, init workflow, delegation infrastructure | Refactor around real contracts, not folder mythology |
| zkVM | `zkvm/`, proof/prover integration in `sdk/` and `scripts/` | guest crate plus proof/prover integration surfaces for private task verification | Establish explicit proof schemas, artifact chains, and verifier contracts |
| MCP server | `mcp/` | protocol/runtime consumer exposed as MCP tools | Make it a thin consumer over stable contracts |
| Docs MCP | `docs-mcp/` | repository documentation and contract-artifact MCP server | Keep it in lockstep with the actual architecture and sequencing model |

### 4.2 App and Consumer Domains

| Surface | Current Path | What It Is | Refactor Requirement |
|---------|--------------|------------|----------------------|
| Web app | `web/` | browser UI for chat, tasks, observability, desktop, voice | Remove direct private imports and depend only on stable surfaces |
| Mobile app | `mobile/` | Expo / React Native app | Same requirement as web, with explicit mobile-safe contracts |
| Demo app | `demo-app/` | React privacy / workflow demo | Convert to thin consumer over stable public surfaces |
| Examples | `examples/` | runnable and packaged example projects, some with their own manifests and script entrypoints | Reclassify each example by owning domain, contract surface, and verification expectations |
| Example and operator tools | `examples/private-task-demo/`, `tools/localnet-social/`, `tools/proof-harness/` | runnable example, localnet bootstrap/smoke harnesses, and shared proof-harness utilities | Treat as explicit consumer/tool surfaces with owned verification commands and package/public imports only |

### 4.3 Platform and Operational Domains

| Surface | Current Path | What It Is | Refactor Requirement |
|---------|--------------|------------|----------------------|
| Desktop platform | `containers/desktop/`, `containers/docker-compose.yml`, `runtime/src/desktop/` | image build, entrypoint/hardening artifacts, desktop server, bridge, auth, managed-process lifecycle, health and events | Treat as one platform contract, not separate planning afterthoughts |
| Root integration tests | `tests/` | LiteSVM, Anchor, verifier, integration, security, localnet, matrix-style tests | Refactor test ownership and keep top-level verification whole |
| Runtime and SDK tests | `runtime/src/**/*.test.ts`, `sdk/src/**/*.test.ts` | co-located verification and regression coverage | Move with the code they validate |
| Docs | `docs/` | architecture docs, roadmap, runbooks, flow docs, sequencing references | Keep authoritative and synchronized with implementation and docs-mcp |
| Runtime operational docs | `runtime/docs/` | runtime-specific runbooks, replay docs, observability docs, operational CLI guidance | Keep synchronized with runtime behavior and docs-mcp indexing |
| Package-local docs and changelogs | `programs/agenc-coordination/README.md`, `runtime/README.md`, `runtime/CHANGELOG.md`, `sdk/README.md`, `sdk/CHANGELOG.md`, `mcp/README.md`, `mcp/CHANGELOG.md`, `docs-mcp/README.md`, `migrations/README.md`, `examples/**/README.md`, plus top-level package/app/platform `README.md` and `CHANGELOG.md` files when present | package-level contracts, release notes, usage docs, migration notes, example-level guidance | Keep aligned with public surfaces and docs-mcp indexing |
| Contract artifacts and codegen surfaces | `docs/api-baseline/`, `runtime/benchmarks/`, `runtime/scripts/check-idl-drift.ts`, `contracts/desktop-tool-contracts/`, `scripts/idl/`, `target/idl/`, `target/types/`, `runtime/src/types/agenc_coordination.ts`, and the released `@tetsuo-ai/protocol` artifact surface | machine-readable baselines, IDL/schema artifacts, verifier-router artifacts, benchmark manifests, drift scripts, compatibility shims, and shared contract packages | Treat as first-class architecture and verification surfaces |
| Scripts | `scripts/` (operational utilities, soak/autonomy infra, deployment/security validation, wrappers), `runtime/src/watch/`, and `runtime/tests/watch/` | setup, validation, benchmarking, migration, build, runtime-owned watch implementation, and package-local watch regression coverage | Convert into explicit build/release/test ownership surfaces |
| Benchmarks | `benchmarks/` | benchmark evidence output for private-proof and related verification runs (`latest.md`, `latest.json`, `index.html`) | Keep benchmark outputs explicit and aligned to verification scope |
| Migrations | `migrations/` | protocol and data migration support | Version, test, and align with dependency-gated rollout order |
| CI / repo automation | `.github/`, root scripts, package scripts | release, validation, pipeline gates, workflow orchestration | Must be updated as part of the architecture, not after it |

### 4.4 Root Workspace and Support Surfaces

| Surface | Current Path | What It Is | Refactor Requirement |
|---------|--------------|------------|----------------------|
| Workspace config | `package.json`, `package-lock.json`, `tsconfig.json`, `knip.json` | build graph, dependencies, npm workspace/package-manager behavior, and TypeScript behavior | Keep the workspace coherent through every dependency gate |
| Root standalone tool surface | `package.json`, root CLI/build scripts | workspace-level control surface; the former root `src/` grid-router demo package was retired on `2026-03-16` | Keep the root workspace coherent without reintroducing a second build-bearing app surface |
| Root source utilities and JSON/config files | `ansi2png.py`, root JSON/config files | root-level helper code, fixtures, and support configuration | Classify each as product code, test utility, fixture, generated file, or local artifact |
| Local tool cache | `.codebase-index-cache.pkl` | generated cache for local repository graph tooling | Non-architectural local artifact |
| Build and artifact dirs | `**/dist/`, `**/target/`, `test-ledger/`, `logs/`, `.tmp/`, `.anchor/` | generated or operational outputs | Keep out of architecture decisions except where generation is contract-bearing |
| Assets and support data | `assets/`, `image*`, `chains.json`, `solana_protocols.json` | media, config, support data, or legacy artifacts | Classify and either attach to owning domains or mark as non-architectural support |
| Repo policy/meta | `README.md`, `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.mcp.json`, `.gitignore`, `.gitattributes`, `.trivyignore` | repository contract and developer workflow surfaces | Keep consistent with the live architecture and refactor rollout |
| Repo metadata/tooling artifacts | `.git/` | VCS metadata and local repo history artifacts | Non-architectural |

Any surface not named here must still be classified before the Gate 0 exit gate.

---

## 5. Current-State Facts That The Plan Must Respect

The plan is constrained by current facts. These are not optional.

### 5.1 Core Build Closure And Repo-Wide Verification Matrix

The repository currently has two different verification realities:

1. a minimum core package build closure across:
   - `sdk`
   - `runtime`
   - `mcp`
   - `docs-mcp`
2. a wider repo verification surface that also includes build-bearing or test-bearing consumers and platforms such as:
   - `web`
   - `mobile`
   - `demo-app`
   - packaged or runnable examples under `examples/**`
   - `tests`
   - `containers/desktop/server`
   - Anchor program builds
   - zkVM and verifier paths

Direct evidence:

- `sdk/package.json`, `runtime/package.json`, `mcp/package.json`, and `docs-mcp/package.json` each define the build-bearing scripts for the core TypeScript packages
- `web/package.json`, `mobile/package.json`, `demo-app/package.json`, `containers/desktop/server/package.json`, and multiple `examples/**/package.json` files define additional build-bearing or launch-bearing surfaces
- root guidance treats those as core TypeScript packages built and tested independently
- the root workspace no longer carries the separate grid-router demo surface, and it does not authoritatively encode the AgenC package build graph
- the repo also contains package-bearing consumers and platform builds outside that minimum closure

Implications:

- no dependency gate is allowed to “park” `mcp` or `docs-mcp` while still claiming the core package build closure is green
- no dependency gate may claim the repository is green unless the repo-wide verification matrix for the affected surfaces is also green
- Gate 0 must classify whether root package scripts are canonical repo entrypoints, legacy leftovers, or a separate tool surface before any plan relies on them

### 5.2 Runtime Is Large, Documented, and Already Layered

The runtime is not an unstructured blank slate. It already has:

- layered architecture docs
- chat pipeline docs
- subagent orchestration docs
- durable background-run ADRs
- benchmark and mutation gates

Implication:

- the refactor must reconcile those contracts with the live code rather than pretending the runtime begins from zero

### 5.3 Desktop Is A Platform, Not A Leaf Package

Desktop currently spans:

- runtime desktop manager and router
- runtime build/test code generation
- container image build
- in-container desktop server
- per-container auth/identity tokens and headers
- managed-process registry, logs, tails, and exit events
- watchdog recovery and container reclamation policy
- bridge event and health semantics

Implication:

- desktop cannot be planned as a simple early low-risk extraction

### 5.4 Consumer And Script Safety Is Mostly Remediated

Most public consumers are now on public package surfaces. The previously identified
root-level demo/script source-path blockers were migrated in code to package/public
surfaces on `2026-03-16`, and Gate 10 exit review passed the same day once clean-environment packaging,
artifact handoff, and split-readiness smoke validation were proven for the current split-candidate scope.

Reclassified former blockers:

- `examples/private-task-demo/index.ts`
- `tools/localnet-social/smoke.ts`
- `tools/localnet-social/bootstrap.ts`
- private prover admin cutover via `agenc-prover/admin-tools`
- `tools/proof-harness/benchmark-private-e2e.mts`

Implication:

- these known files are no longer Gate 10 blockers; any future blocker must be a new split-candidate regression rather than leftover source-path cleanup.

### 5.5 Docs Are Part Of The Runtime Of The Team

`docs-mcp` is a live documentation surface used during planning and implementation, but it is only trustworthy to the extent that its indexed corpus matches the repo's current docs and contract artifacts.

Current facts:

- `docs-mcp` must cover whole-repo docs, runtime docs, the master refactor program, API baselines, IDL/schema artifacts, and benchmark manifests if it is cited as architecture authority
- package-local docs and changelogs are also part of the authoritative documentation surface when they define public usage, migration, or release behavior
- `docs-mcp` currently loads `docs/**`, `runtime/docs/**`, `runtime/idl/**`, `runtime/benchmarks/**`, `scripts/idl/**`, selected root docs (`README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR.MD`, and `REFACTOR-MASTER-PROGRAM.md`), and package-local `README.md` / `CHANGELOG.md` files; root-policy coverage remains explicit rather than assumed
- `docs-mcp` no longer registers legacy runtime-roadmap issue/phase tools, prompts, or special `issue-map` / `roadmap` aggregate resources; the retired roadmap and issue-map docs are removed from the indexed planning surface
- `docs-mcp` runtime-module helper tools remain available, but they are explicitly runtime-scoped helpers rather than whole-repository planning authority
- `docs-mcp` remains a documentation server, not a code graph or source-of-truth for code boundaries

Implication:

- docs and docs-mcp must move in the same dependency gates as architecture changes
- docs-mcp scope and coverage must be explicit and verifiable
- docs-mcp cannot be treated as the sole evidence source for architecture claims

### 5.6 The Refactor Must Preserve Real Verification Surfaces

The repo currently has:

- fast integration tests
- runtime and sdk unit suites
- full Anchor tests
- real-ZK/verifier paths
- benchmark and mutation gates

Implication:

- “tests later” and “CI later” are forbidden shortcuts

### 5.7 Machine-Readable Contract Baselines Already Exist

The repo already carries machine-readable or generated contract-bearing artifacts such as:

- `docs/api-baseline/runtime.json`
- `docs/api-baseline/sdk.json`
- `docs/api-baseline/mcp.json`
- released protocol artifacts from `@tetsuo-ai/protocol`
- `target/idl/agenc_coordination.json`
- `target/types/agenc_coordination.ts`
- `runtime/src/types/agenc_coordination.ts`
- `contracts/desktop-tool-contracts/src/index.ts`
- `scripts/idl/verifier_router.json`
- benchmark manifests and gate fixtures
- operational/runtime CLI docs that encode supported behavior

Implication:

- public API baselines, IDL/schema artifacts, benchmark manifests, and behavior-defining operational docs must become mandatory gates in the refactor program rather than optional references

### 5.8 Scripts, CI, And Migration Procedures Already Encode The Execution Graph

The repo already uses scripts, smoke harnesses, and upgrade procedures as the live execution graph for cross-surface behavior.

Implications:

- scripts, CI jobs, smoke harnesses, and upgrade procedures are early contract surfaces, not late cleanup
- dependency gates must preserve or intentionally migrate those procedure bundles as part of the architecture

### 5.9 Proof Verification Uses Live Harnesses Beyond Unit Tests

The repo already depends on live proof/verifier harnesses beyond ordinary package unit tests, including verifier-localnet bootstrap, mock verifier-router builds, real-proof execution, and program fuzzing.

Implications:

- proof and protocol refactors must keep those harnesses as explicit dependency gates
- verifier-facing artifacts and real-proof test paths cannot be treated as secondary tooling

### 5.10 Repository Split Readiness Is Proven For The Current Candidate Scope

Current repo packaging and build behavior is versioned and repo-independent for the current split-candidate scope.

Current facts:

- publishable split-contract packages now have clean `pack -> install -> smoke` proof:
  - `@tetsuo-ai/sdk`
  - `@tetsuo-ai/desktop-tool-contracts`
  - `@tetsuo-ai/runtime`
  - `@tetsuo-ai/mcp`
  - `@tetsuo-ai/docs-mcp`
- downstream consumer and tool surfaces were validated against installed/public package contracts:
  - `web`
  - `mobile`
  - `examples/tetsuo-integration`
  - `containers/desktop/server`
  - `examples/private-task-demo`
  - `tools/localnet-social`
  - `tools/proof-harness`
- the root `file:patches/npm/bigint-buffer` override is gone, and split-candidate manifests no longer rely on `file:` dependencies
- `@tetsuo-ai/sdk@1.3.1` is now published from the standalone public repo `tetsuo-ai/agenc-sdk`, and the private monorepo validates against that released artifact rather than a local workspace-owned SDK build
- the final split-candidate import audit found no repo-relative `runtime/src`, `sdk/src`, `mcp/src`, `docs-mcp/src`, desktop-server source imports, or `runtime/dist/operator-events.mjs` coupling in candidate code
- contract-bearing split-candidate artifacts now have repo-independent handoff through packaged/runtime-owned surfaces:
  - shipped runtime IDL
  - shared desktop tool-contract package
  - `@tetsuo-ai/runtime/operator-events`
  - `runtime/dist/bin/agenc-watch.js`
- `docs-mcp` aligns with the live authority model: legacy runtime-roadmap issue/phase surfaces are deleted, the master refactor docs are indexed root docs, and remaining runtime-module helpers are explicitly runtime-scoped
- some root-monorepo validation assets remain intentionally local:
  - `scripts/idl/verifier_router.json`
  - `target/idl/**`
  - `target/types/**`
  - root proof/program/verifier harnesses that consume those assets
- some root-local wrappers remain intentionally local:
  - `scripts/agenc-watch.mjs` is a local-dev wrapper over the packaged runtime watch surface

Implications:

- Gate 10 is complete for the current split-candidate scope
- Gate 11 can begin
- root-local test and ops assets do not reopen Gate 10 unless they are promoted into future split-candidate scope

---

## 6. End-State Architecture

The desired end state is not “many packages.” It is a coherent architecture with these properties:

1. Stable contracts are explicit and versionable.
2. Control-plane code is separated from domain logic where a real seam exists.
3. Execution domains depend on contracts, not on arbitrary gateway internals.
4. Protocol, SDK, and proof systems have clear public/internal boundaries.
5. Desktop platform is versioned as a platform contract.
6. Apps and examples are consumers, not shadow owners of runtime internals.
7. Build, CI, docs, benchmarks, codegen, and release tooling understand the architecture directly.
8. Repo splits remain optional and happen only if they materially improve ownership and release cadence.

The end state may still be monorepo-based if that is the better operational choice. Repository split is not the success criterion. Explicit modularity is.

---

## 7. Non-Negotiable Contracts

These contracts must be made explicit, versioned where needed, and migration-tested.

### 7.1 Runtime Contracts

- chat/tool sequencing
- channel adapter transport and event semantics
- channel adapter registration and lifecycle wiring semantics
- operator event normalization and runtime-to-console contract semantics
- tool-call lifecycle semantics
- request timeout, tool timeout, and stop-reason behavior
- `planner_execute` and pipeline execution semantics
- approval request lifecycle
- host-workspace resolution and session workspace-root policy
- policy evaluation, access control, and budget-governance semantics
- subagent orchestration, verifier, and budget semantics
- durable background-run state model, wake-bus event sequencing, notifier/progress callback semantics, supervisor/operator role boundaries, and wake-adapter extensibility
- delegation tool-bridge, delegation-runtime, delegation-scope, delegation-timeout, durable-subrun-orchestrator, and subrun-contract semantics
- browser-tool-mode guard and doom-stop-guard behavioral contracts
- init workflow orchestration, repo-guide generation, and bounded delegated investigation semantics
- logging, trace, and observability event shape, trace-log fanout, and sqlite trace store semantics

### 7.2 Protocol Contracts

- account layouts (including `ZkConfig` account for trusted image ID governance)
- instruction behavior (44 instructions including `initialize_zk_config` and `update_zk_image_id`)
- error codes and error decoding (200 error codes, 6000-6199)
- PDA derivation (including `zk_config` PDA)
- emitted events and parsers (49 event types including `ZkConfigInitialized`, `ZkImageIdUpdated`)
- transaction assembly/confirmation semantics
- `protocol_version` / `min_supported_version` compatibility and migration semantics
- `zk_config` account governance: `initialize_zk_config` and `update_zk_image_id` instruction semantics, trusted image-ID rotation authority
- fuzz harness continuity for instruction/state-machine behavior

### 7.3 Proof Contracts

- zkVM guest journal schema
- zkVM methods build outputs, image IDs, and generated artifact ownership
- prover transport plus proof and seal handling
- verifier expectations
- verifier-router IDL and on-chain verifier interface expectations
- verifier-entry layout, selector, and authority-validation semantics
- `zk_config` / active-image governance and image-rotation semantics
- SDK proof preflight and client-side nullifier/replay-protection semantics
- runtime/sdk proof integration semantics
- mock verifier-router artifact and proof-fixture continuity
- real-proof integration harness semantics

### 7.4 Desktop Platform Contracts

- desktop server tool catalog (19 tools: original 13 + process_start/status/stop, text_editor, video_start/video_stop)
- shared desktop tool-definition contract package consumed by both runtime and desktop server
- desktop event model
- desktop auth token, header, and session identity semantics
- managed desktop process identity, registry, log, tail, and exit-event semantics (including process_start/status/stop tool contracts)
- text_editor tool contract (str_replace pattern, 5 commands, LRU undo buffer, path restrictions, file size limit)
- video recording tool contract (video_start/video_stop, ffmpeg x11grab, PID file recovery)
- Playwright MCP browser integration contract (container routing via docker exec, lazy per-session bridges, tool namespacing as `playwright.*`)
- watchdog, recovery, and reclamation semantics
- server health/feature/version/hash negotiation
- image version compatibility (Ubuntu 24.04, 6 supervisord processes including nvim-headless)
- bridge transport behavior
- TUI guard contract (22 blocked interactive apps unless backgrounded)

### 7.5 Consumer Contracts

- runtime public exports
- sdk public exports
- mcp tool, resource, and prompt schemas, connection behavior, and operator-role/audit semantics
- docs-mcp resource, query, module-helper, conventions-helper, scope-manifest, and legacy-authority-guard semantics
- websocket / webchat protocol surfaces consumed by apps
- app-safe websocket/socket-client transport contract
- app-facing gateway status, approval, background-run, and observability read models
- app-safe shared helpers
- script-safe runtime/protocol/sdk helper surfaces for operational consumers
- example package contract and verification expectations

### 7.6 Operational Contracts

- core package build closure
- repo-wide verification matrix
- package build graph
- publishability and versioning independence for candidate split packages
- published-artifact handoff for contract-bearing generated outputs
- pack/install smoke validation and cross-repo compatibility ownership
- root standalone tool/app classification and entrypoint behavior
- operator-console/watch subsystem ownership and built operator-event artifact compatibility
- public API baselines
- generated schema and IDL baselines
- Anchor-generated `target/idl` / `target/types` artifact-chain continuity
- named drift and contract guard surfaces such as `scripts/check-breaking-changes.ts`, `runtime/scripts/check-idl-drift.ts`, the released `@tetsuo-ai/protocol` artifact contract, and the `contracts/desktop-tool-contracts/` package build
- benchmark corpus, manifests, and gate definitions
- benchmark and mutation gates
- background-run quality gates, delegation benchmark gates, pipeline quality gates, and autonomy rollout gates (each a distinct gate surface beyond base benchmark/mutation)
- desktop image hardening check contract
- canonical CI contract surface and release-gate ownership (`.github/workflows` currently contains a focused proof workflow + local scripts and package commands)
- fuzz, real-proof, and verifier-localnet harness ownership
- setup/bootstrap scripts
- migration scripts
- migration procedure bundle across docs, scripts, smoke runs, and Rust migration code
- release flows
- docs, root policy docs indexed by docs-mcp, issue-map, and sequencing-graph synchronization
- operational CLI and runbook behavior where they encode supported workflows

Nothing in these categories is allowed to be deferred as “cleanup.”

---

## 8. Domain Plans

This section is the actual plan. Each domain includes:

- current-state problem
- target end state
- required seams
- acceptance gates
- rollback expectations

### 8.1 Runtime Control Plane

Scope:

- `runtime/src/gateway/**` (70+ source files including init-runner, delegation infrastructure, background-run suite, tool routing, session isolation, subagent orchestration)
- `runtime/src/cli/**` (17 command files including agenc, init, operator-console, daemon, health, onboard, replay, jobs, logs, sessions, security, skills, wizard, registry-cli, foreground-log-tee)
- `runtime/src/bin/**`
- `runtime/src/observability/**` (trace-log fanout, SQLite store, structured tracing)
- `runtime/src/mcp-client/**`
- `runtime/src/project-doc.ts` (shared repo-guide generation for init workflow)
- daemon lifecycle
- sessions and routing
- approvals
- subagent orchestration
- delegation infrastructure (delegation-tool, delegation-runtime, delegation-scope, delegation-timeout, durable-subrun-orchestrator, subrun-contract)
- background-run supervision (supervisor, control, store, notifier, operator, wake-bus, wake-adapters)
- control-plane logging/observability

Current-state problem:

- dense coupling across gateway, llm, workflow, policy, autonomous, and desktop
- oversized anchors such as `daemon.ts`, `daemon.test.ts`, and gateway-heavy supervision/orchestration files
- runtime entrypoints, CLI behavior, observability, and MCP bridge behavior are also part of the control plane and cannot be treated as detached support code
- host-workspace resolution and session workspace-root policy now bridge gateway, webchat plugin, subagent orchestration, and filesystem tools, so workspace safety is a runtime control-plane contract rather than detached tooling
- channel adapter registration and lifecycle wiring are still trapped inside daemon-heavy control-plane code
- fake seams where gateway glue is being mistaken for domain-local code

Target end state:

- explicit control-plane contracts
- daemon decomposition around real responsibilities
- approval transport separated from policy evaluation
- background-run supervision treated as control-plane state orchestration unless proven otherwise
- subagent orchestration separated from execution-domain internals by contract

Required seams:

1. planner/pipeline seam
2. approval transport seam
3. background-run control seam
4. subagent orchestration seam
5. gateway-side message/session contract seam
6. control-plane entrypoint and observability seam
7. host-workspace and session-workspace policy seam
8. channel adapter registration and lifecycle wiring seam

Acceptance gates:

- control-plane contract tests exist
- giant control-plane files are decomposed only after seams exist
- `daemon.ts`, `daemon.test.ts`, and other named blocker artifacts have explicit decomposition tasks and prerequisites
- no runtime execution package depends on gateway internals that should be contract-owned
- operator-facing behavior and diagnostics remain stable or versioned

Rollback:

- retain compatibility façades and adapters
- no package extraction until seams prove stable

### 8.2 Runtime Foundations, Execution, And Domain Services

Scope:

- `runtime/src/agent/**`
- `runtime/src/llm/**`
- `runtime/src/workflow/**`
- `runtime/src/autonomous/**`
- `runtime/src/task/**`
- `runtime/src/connection/**`
- `runtime/src/events/**`
- `runtime/src/proof/**`
- `runtime/src/dispute/**`
- `runtime/src/governance/**`
- `runtime/src/marketplace/**`
- `runtime/src/social/**`
- `runtime/src/team/**`
- `runtime/src/bridges/**`
- `runtime/src/reputation/**`
- `runtime/src/memory/**`
- `runtime/src/tools/**`
- `runtime/src/skills/**`
- `runtime/src/channels/**`
- `runtime/src/voice/**`
- `runtime/src/eval/**`
- `runtime/src/replay/**`
- `runtime/src/telemetry/**`
- `runtime/src/policy/**`
- `runtime/src/types/**`
- `runtime/src/utils/**`
- public runtime API surfaces such as `runtime/src/index.ts`, `runtime.ts`, `builder.ts`, and `idl.ts`

Current-state problem:

- real cycles and porous boundaries exist across llm/workflow, memory/llm, replay/eval, autonomous/gateway, and channels/runtime internals
- major runtime domains outside gateway/llm/workflow have to participate in the modularity story and cannot remain unowned planning residue
- some boundary types live in unstable or inappropriate places
- execution domains still depend on private control-plane details
- policy enforcement logic sits on the fault line between control-plane transport and domain policy evaluation and must be explicitly owned rather than implied by approvals work

Target end state:

- execution domains consume stable contracts
- no false “extension” extraction
- domain-local logic lives with the owning domain
- cross-domain types and helpers sit in explicit contract packages or internal contract layers

Required seams:

1. planner/pipeline contract seam
2. llm ↔ memory contract seam
3. eval/replay ownership seam
4. autonomous ↔ gateway contract seam
5. channels/webchat protocol and client-helper seam
6. runtime domain-service ownership seams for agent/task/proof/events/connection/dispute/governance/marketplace/social/team/policy
7. public runtime API boundary and export-baseline seam

Acceptance gates:

- every top-level `runtime/src/*` domain has a named target boundary and owner
- no consumer depends on execution-domain private internals without an explicit contract
- execution domains can be tested in isolation against contracts
- benchmark and mutation gates remain meaningful

Rollback:

- keep current package layout until the new seams are proven

### 8.3 Protocol And SDK

Scope:

- `programs/agenc-coordination/**`
- `sdk/**`
- `scripts/idl/**`
- `agenc-prover/admin-tools/zk-config-admin.ts`
- `target/idl/**`
- `target/types/**`
- `tests/upgrades.ts`
- protocol-facing runtime and mcp consumers

Current-state problem:

- protocol and SDK are often treated as “foundation unchanged,” which is planning debt
- Solana- and Anchor-dependent types risk being misplaced into supposedly zero-dep runtime layers
- SDK public API boundaries now govern most runtime and MCP consumers; remaining exceptions are scoped to root-level script surfaces only.
- proof-facing protocol contracts also depend on non-SDK artifacts such as verifier-router IDL and SDK proof/IDL contract tests
- protocol version compatibility and trusted-image / `zk_config` administration already span program, SDK, scripts, and upgrade tests

Target end state:

- clear public/internal SDK boundary
- explicit mapping between on-chain semantics and client abstractions
- runtime/protocol integration depends on stable protocol/SDK surfaces, not leakage
- protocol-facing proof and verifier artifacts are owned and versioned alongside the SDK/program contract they serve

Required seams:

1. instruction/state/event ownership map
2. SDK public API map
3. generated-client/IDL ownership map
4. SDK proof/IDL contract-test seam
5. runtime-protocol integration contract
6. protocol-version / min-supported-version compatibility seam
7. `zk_config` and trusted-image rotation seam

Acceptance gates:

- protocol and SDK consumers compile only through approved surfaces
- published SDK and protocol-facing contract artifacts stay aligned with API baselines and generated IDL/schema artifacts
- no zero-dependency runtime core package depends on Solana or Anchor specifics
- protocol migrations are versioned and testable
- protocol version-compatibility and upgrade tests remain green across program/SDK changes
- SDK proof-validation, prover, protocol, and IDL-alignment contract tests remain green
- program fuzz harness continuity is preserved across instruction/state refactors

Rollback:

- preserve versioned compatibility APIs and decoding helpers during migration

### 8.4 zkVM And Proof System

Scope:

- `zkvm/**`
- `scripts/idl/**`
- `scripts/build-mock-verifier-router.sh`
- `tools/proof-harness/verifier-localnet.ts`
- `scripts/setup-verifier-localnet.sh`
- `scripts/setup-verifier-localnet.ts`
- `tests/mock-router/**`
- `tests/fixtures/real-groth16-proof.json`
- verifier-localnet and real-proof integration scripts/tests
- proof integration in runtime and sdk
- verifier-facing schemas

Current-state problem:

- proof-related contracts are easy to under-specify because they span Rust, TypeScript, runtime behavior, and verification
- zkVM build products, verifier-router artifacts, and local verifier bootstrap paths are part of the live proof boundary, not auxiliary tooling
- verifier-entry layout, ProgramData authority checks, and mock-router artifact handling are currently duplicated across program, scripts, and tests

Target end state:

- explicit guest/schema/seal/prover boundaries
- explicit methods-build/image-id/generated-artifact boundary
- runtime and SDK depend on proof contracts through owned interfaces
- verifier expectations are versioned and tested

Required seams:

1. journal/public-output contract
2. methods-build/image-id/generated-artifact seam
3. guest/prover ownership seam
4. verifier integration seam
5. runtime/sdk proof-consumer seam
6. real-proof, mock-router, and verifier-localnet harness seam
7. verifier-entry layout and authority-validation seam
8. SDK prover/preflight/nullifier-replay seam

Acceptance gates:

- real proof paths continue to work
- zkVM methods/prover artifacts remain reproducible and versioned through the refactor
- proof schema changes are migration-controlled
- verifier integration is tested end-to-end
- mock-router artifact continuity is preserved
- verifier-entry layout and authority-validation tests remain aligned across program, scripts, and tests
- the real-proof harness and verifier-localnet bootstrap remain green through proof-surface changes

Rollback:

- keep compatibility layers for prior proof artifacts until consumers migrate

### 8.5 Desktop Platform

Scope:

- `runtime/src/desktop/**`
- `containers/desktop/**`
- desktop-related runtime consumers
- generated desktop tool definitions

Current-state problem:

- desktop runtime layer, container build, desktop server, generated tool definitions, and bridge semantics are tightly coupled today
- build and test flows already depend on this contract
- session transport is not desktop-local; one live router currently multiplexes desktop, Playwright, and MCP tool traffic
- generated desktop tool definitions are a shared build-graph contract, not passive compatibility metadata; tool catalog now has 19 tools (was 13) including process management (process_start/status/stop), text_editor, and video recording (video_start/video_stop)
- server health/features do not yet provide real version, schema-hash, or catalog-hash negotiation
- desktop lifecycle is co-owned by webchat/session-management code, not only by the desktop bridge layer
- desktop platform behavior also depends on per-container auth, managed-process identity, and watchdog recovery/reclamation policies
- desktop/session-router/container lifecycle behavior is materially under-documented relative to the current code surface
- container now runs Ubuntu 24.04 with 6 supervisord processes (Xvfb, XFCE4, x11vnc, websockify, nvim-headless, rest-server)
- tool definitions now live in the shared `@tetsuo-ai/desktop-tool-contracts` package, with `tools.ts` as the desktop execution engine and runtime consuming the same published contract
- TUI guard in session-router blocks 22 interactive terminal apps unless backgrounded

Target end state:

- one explicit desktop platform contract with versioned ownership
- server feature negotiation and event model are explicit
- runtime consumes the platform through stable interfaces
- image and runtime compatibility are tracked intentionally
- tool routing and desktop session lifecycle are separated from bridge internals by explicit service contracts

Required seams:

1. desktop tool-routing contract
2. desktop session-service and lifecycle contract
3. desktop event contract
4. tool-catalog ownership and generation contract
5. server health/feature/version negotiation contract
6. image version and catalog compatibility contract
7. desktop auth and session identity seam
8. managed-process lifecycle and event seam
9. watchdog / recovery / reclamation seam

Acceptance gates:

- runtime build/test no longer depend on hidden desktop coupling
- desktop, Playwright, and MCP tool-routing ownership no longer collapses into one monolithic session router
- desktop session lifecycle is owned by an explicit service contract rather than direct webchat/manager coupling
- generated desktop tool definitions are governed by an explicit shared build-graph contract and drift gate
- desktop consumers use the platform contract rather than bridge internals
- health negotiation exposes version/hash-compatible metadata before the platform contract can be called complete
- managed-process identity/events remain compatible across runtime, server, eval, and background-run consumers
- desktop/session-router/container lifecycle docs and docs-mcp resources are updated alongside the platform contract changes
- container/runtime/catalog compatibility can be checked and reasoned about explicitly

Rollback:

- keep current in-repo platform arrangement until the new contract is proven

### 8.6 MCP And Docs-MCP

Scope:

- `mcp/**`
- `docs-mcp/**`

Current-state problem:

- both are active consumers of runtime, sdk, docs, and roadmap data
- they are easy to under-model because they look like tooling, but they affect build closure and developer operations directly
- `docs-mcp` no longer exposes runtime-roadmap-specific issue/phase tools or prompts, but its remaining runtime-module helper tools still need to stay explicitly scoped so they are not mistaken for whole-repository planning authority
- `docs-mcp` root-doc coverage is explicit rather than equivalent to every repo-policy file, so any new authoritative root doc must be added deliberately to the indexed set

Target end state:

- `mcp` consumes only stable runtime and protocol surfaces
- `docs-mcp` consumes the live architecture docs, runtime docs, master refactor plan, indexed root policy docs, and contract artifacts without drift
- `docs-mcp` consumes package-local docs and changelogs that define public usage and migration behavior without drift
- `docs-mcp` publishes an explicit scope manifest so its authority and limits are visible
- any docs-mcp issue/phase/module/tooling surface is either aligned to the master program or explicitly labeled as narrower runtime-specific legacy behavior
- both are thin, contract-respecting consumers

Required seams:

1. MCP runtime/protocol consumer boundary
2. Docs-MCP architecture/roadmap resource boundary
3. Docs-MCP indexed-corpus and scope-manifest boundary
4. Docs-MCP legacy runtime-roadmap authority removal seam
5. Docs-MCP runtime-helper scoping seam
6. tool/resource/helper schema and scope-manifest versioning expectations

Acceptance gates:

- the core package build closure remains green
- the relevant repo-wide verification matrix remains green for `mcp`, `docs-mcp`, and the docs/roadmap resources they serve
- no MCP server imports private internals
- docs-mcp serves the current architecture rather than stale planning residue
- docs-mcp scope manifest names the indexed corpus and its limits explicitly
- docs-mcp indexes the authoritative docs and contract artifacts it claims to represent
- docs-mcp indexes the package-local docs and changelog surfaces that it claims to represent
- docs-mcp root policy doc coverage is explicit whenever those docs encode live workflow or architecture behavior
- docs-mcp runtime-module helper tools do not overclaim whole-repo authority while they remain bound to narrower runtime-specific data
- docs-mcp does not reintroduce legacy runtime-roadmap issue, phase, or prompt surfaces unless they are rebuilt against the current authoritative planning model
- docs-mcp resource and helper-tool surfaces have explicit regression or snapshot validation before they are treated as stable contracts

Rollback:

- preserve temporary compatibility exports and docs resources until consumers migrate

### 8.7 Web, Mobile, Demo, And Examples

Scope:

- `web/**`
- `mobile/**`
- `demo-app/**`
- `examples/**`
- `tools/**`

Current-state problem:

- app consumers are now routed to public package surfaces for runtime/SDK contracts; private source-path imports remain in a bounded set of scripts and demos
- reclassified example/operator tool surfaces now live in explicit buckets:
  - `examples/private-task-demo/index.ts`
  - `tools/localnet-social/smoke.ts`
  - `tools/localnet-social/bootstrap.ts`
  - `tools/proof-harness/benchmark-private-e2e.mts`
  - private prover admin tooling via `agenc-prover/admin-tools`
- packaged examples and runnable examples are not all the same ownership class: some are public-package consumers, some have their own manifests and build/start scripts, and some are root-driven samples
- `demo-app`, `examples/`, and `tools/` are different migration classes and cannot be handled as one consumer bucket

Target end state:

- private source-path consumers and public-package consumers are tracked as separate migration problems with separate exit criteria
- all consumers depend on stable package or protocol surfaces
- app-safe helper packages or public export layers exist where needed
- web and mobile consume one declared source of truth for app-facing runtime read models
- examples are classified by owning domain, contract surface, and verification expectations
- demo-app, demo scripts, demo collateral, and examples each have explicit ownership and migration rules

Required seams:

1. private source-path cleanup contract for app and script consumers
2. public package consumer compatibility contract
3. public webchat/websocket client and socket-core transport contract
4. app-safe gateway status, approval, background-run, and observability read-model contract
5. mobile adapter and mapping-test contract
6. stable app-facing helpers replacing private runtime and SDK imports
7. demo-app / demo / demos / examples ownership and migration map
8. per-example classification and verification-expectation map

Acceptance gates:

- no app, example, or consumer-facing script imports private runtime or SDK source files directly
- public-package consumers and packaged examples continue to run only through approved package surfaces
- `web` build, unit, and e2e verification remain explicit in the repo-wide matrix
- `mobile` typecheck is treated as the current minimum gate and must be accompanied by an explicit stronger non-interactive validation plan before consumer migration can be called complete
- `demo-app` build remains green
- demo surfaces remain functional through the migration
- packaged-example build/start checks and example/demo smoke verification remain green through consumer-surface changes
- consumer breakage is caught by contract tests, API baselines where applicable, and the repo-wide verification matrix for app surfaces

Rollback:

- transitional façades are allowed until all consumers migrate

### 8.8 Tests, Docs, Scripts, CI, And Root Workspace

Scope:

- `tests/**`
- co-located tests
- `docs/**`
- package-local docs and changelogs
- `scripts/**`
- `.github/**`
- root package, root TypeScript config, and any root source-bearing leftovers that appear during the program
- package scripts and matrix commands
- migration scripts

Current-state problem:

- these surfaces are often treated as a trailing concern, but they currently define the build, test, bootstrap, benchmark, mutation, and deployment reality of the repo
- docs-mcp is also coupled to docs and roadmap assets
- package-local docs and changelogs can drift away from the public surfaces they describe
- the root package remains a build-bearing workspace control surface, and any new root app/demo code would immediately reintroduce the exact ambiguity this program is eliminating
- scripts, smoke harnesses, and upgrade procedures already embody the repo-wide execution graph and cannot be treated as late cleanup
- canonical CI contract ownership is distributed across package scripts and operational expectations, with `.github/workflows` currently reduced to targeted workflow entrypoints
- current enforcement truth lives in package scripts, repo scripts, package-local harnesses, and `.github/workflows/private-proof-benchmark-pages.yml` as a dedicated proof/benchmark gate
- some scripts and smoke/admin harnesses currently bypass public runtime and SDK surfaces and act as shadow consumers of private internals
- `scripts/` now contains operational utilities, soak/autonomy infrastructure, localnet setup, fender/security scanning, deployment validation, and wrapper entrypoints; the runtime-owned watch implementation lives under `runtime/src/watch/`, and its package-local regression suite lives under `runtime/tests/watch/`
- the operator-console/watch surface is now a runtime-owned subsystem under `runtime/src/watch/` with a packaged `agenc-watch` bin and a local-dev wrapper at `scripts/agenc-watch.mjs`
- exported runtime surfaces such as `@tetsuo-ai/runtime/operator-events` and the packaged `agenc-watch` bin act as compatibility inputs for operational tooling and must be modeled as contract-bearing outputs where they cross package boundaries
- oversized runtime/watch artifacts such as `runtime/src/watch/agenc-watch-app.mjs` and giant test surfaces such as `tests/test_1.ts` are also part of the refactor backlog and cannot be ignored just because they sit outside `runtime/src/gateway`
- concrete drift and contract guards already act as architecture gates today, including `scripts/check-breaking-changes.ts`, `runtime/scripts/check-idl-drift.ts`, the released `@tetsuo-ai/protocol` artifact contract, and the `contracts/desktop-tool-contracts/` package build

Target end state:

- test ownership follows code ownership
- docs, package-local docs/changelogs, root policy docs indexed by docs-mcp, and docs-mcp represent the live architecture and public usage reality
- scripts and CI understand package boundaries
- scripts, smoke harnesses, and migration procedures are owned as first-class execution contracts
- operational scripts and harnesses consume stable runtime/protocol/sdk surfaces rather than private source paths
- the operator-console/watch subsystem has an explicit composition root, module-boundary map, and declared runtime artifact contract
- root workspace remains coherent through all dependency gates

Required seams:

1. canonical root workspace/build authority map
2. core package build/test closure map
3. package-aware CI graph and contract-surface ownership map
4. benchmark/mutation gate ownership map
5. docs/roadmap/package-doc/root-policy-doc/docs-mcp synchronization process
6. docs-mcp indexed-corpus ownership and coverage audit process
7. root standalone tool/app classification seam
8. migration procedure bundle ownership map
9. script-facing runtime/protocol/sdk helper boundary for operational consumers
10. oversized non-runtime artifact classification/decomposition map
11. operator-console/watch subsystem ownership and runtime operator-event artifact seam
12. host-workspace and session-workspace-root policy seam where runtime tooling crosses into workspace safety

Operator-console checkpoint for this seam:

- `scripts/agenc-watch.mjs` is only the local-dev wrapper; `runtime/src/watch/agenc-watch-app.mjs` is the real composition root now in scope for decomposition under the oversized runtime/watch artifact map
- the target is an explicit operator-console/watch subsystem over watch-local modules, not a false package split claim before runtime CLI and build consumers are decoupled
- command dispatch, terminal input state machines, websocket/bootstrap lifecycle, and top-level frame assembly must move behind explicit watch-local module boundaries before this artifact can be considered structurally complete
- runtime operator-event normalization and the exported `@tetsuo-ai/runtime/operator-events` subpath are part of the live compatibility surface and must be explicitly migrated before any standalone-package or repo-split claim
- any future standalone-package or repo-split claim for the operator console is blocked until runtime CLI packaging, operator-event contract consumption, and workspace-index/runtime-path assumptions are all explicitly migrated

Acceptance gates:

- core package build, typecheck, test, benchmark, and matrix commands remain valid or are explicitly version-migrated
- repo-wide verification remains explicit for app packages, packaged examples, desktop server, Anchor/program, zkVM/proof, and other build-bearing surfaces touched by the gate
- docs, package-local docs/changelogs, root policy docs indexed by docs-mcp, and docs-mcp update in the same gate as the architecture or public surface they describe
- no smoke, admin, bootstrap, or validation script imports private runtime or SDK source files directly unless it is explicitly classified as refactor-local tooling with an owned compatibility contract
- named drift and contract guards such as `scripts/check-breaking-changes.ts`, `runtime/scripts/check-idl-drift.ts`, the released `@tetsuo-ai/protocol` artifact contract, and the `contracts/desktop-tool-contracts/` package remain green or are explicitly version-migrated in the same gate
- the operator-console/watch subsystem has an explicit compatibility contract for runtime operator events and built helper artifacts
- the root standalone tool/app surface is explicitly classified and no giant orphaned test, script, or root build surface remains unexplained

Rollback:

- keep old entrypoints while new build/test graphs prove themselves

### 8.9 Repository Split Readiness, Publication, And Optional Split

Scope:

- all candidate packages or domains that might be moved to separate repos

Current-state problem:

- package extraction is easy to confuse with actual modularity
- candidate split units are not yet proven under clean, published-artifact only conditions (pack/install/smoke/release)
- the earlier root-level local patch override (`file:patches/npm/bigint-buffer`) was removed on `2026-03-16` by replacing the `@solana/spl-token` dependency chain with an owned SDK token helper; Gate 10 no longer depends on that path, and remaining program work moved on to Gate 11 extraction planning
- the remaining root-monorepo verifier/program assets are now explicitly scoped outside split-candidate package contracts; Gate 11 owns their long-term repo placement rather than treating them as hidden Gate 10 blockers

Target end state:

- candidate split units are independently releasable inside the monorepo before any split is attempted
- repo splits happen only when ownership, release cadence, and consumer experience improve materially

Required seams:

- stable public APIs
- package-local tests
- published-artifact install and smoke-validation seam
- dependency versioning and release-channel seam
- repo-independent build/test/publish seam
- generated-artifact handoff seam for IDL/schema/tool-definition/operator-event and other contract-bearing outputs
- cross-package integration matrix
- release automation
- docs and examples migrated

Acceptance gates:

- package boundaries are already proven inside the monorepo
- candidate split packages no longer depend on `file:../...` links, sibling `--prefix ../...` build steps, repo-local patch paths, or repository-relative artifact paths
- each candidate split package can be built, tested, packed, installed, and smoke-validated from published-like artifacts in a clean environment
- versioning, changelog, and release ownership are explicit for each candidate split package
- no split package still secretly depends on repo-local internals
- optional repo split remains a business and operating decision, not a technical escape hatch

Rollback:

- leave packages in the monorepo if split cost exceeds value

---

## 9. Dependency-Gated Program Order

This is the dependency order. No domain gets to skip its gate because another domain is harder.

Cross-cutting mandatory gates:

- Every gate that changes architecture must update affected docs and `docs-mcp` resources in the same gate.
- Every gate that changes a published or consumed surface must update the relevant API baseline, generated schema, or IDL artifact in the same gate.
- Every gate that changes runtime behavior must update the affected benchmark, mutation, or operational verification surface in the same gate.
- Every gate must preserve both minimum core package build closure and the relevant repo-wide verification matrix for the surfaces it touches.

### Gate 0 — Repository Classification And Program Lock

Goals:

- make this file canonical
- classify every top-level directory and root source-bearing file
- freeze terminology and success criteria

Must produce:

- ownership map for every domain in Section 4
- classification for stray root surfaces
- classification for the root standalone tool/app surface and whether it is canonical, isolated, or legacy
- classification of the former root `src/` modules and duplicate root router implementations
- canonical root workspace/build authority map
- list of active generated artifacts and codegen pipelines
- list of public consumers and known private-import consumers
- list of script and harness consumers using private runtime or SDK internals
- list of build-bearing packaged examples, runnable examples, and their verification entrypoints
- operator-console/watch subsystem inventory including composition root, module families, tests, and built-runtime couplings

Exit gate:

- there is no unclassified major domain

### Gate 1 — Contract Inventory And Baseline Harness

Goals:

- identify all non-negotiable contracts
- inventory current docs, tests, and public exports
- establish baseline compatibility harnesses

Must produce:

- runtime contract inventory
- protocol and SDK contract inventory
- proof contract inventory
- desktop platform contract inventory
- consumer/private-import inventory
- script/private-import inventory
- app-facing read-model and DTO inventory for web/mobile
- per-example classification inventory
- operational/build/CI/docs inventory
- package-local doc and changelog inventory
- docs-mcp indexed-corpus inventory and coverage gap list
- docs-mcp resource/helper validation-gap inventory
- public API baseline inventory
- generated schema and IDL baseline inventory
- `target/idl` and `target/types` artifact-chain inventory
- named drift/codegen guard inventory
- fuzz, mock-router, verifier-localnet, real-proof, and proof-fixture harness inventory
- benchmark/gate and operational-doc inventory
- giant artifact decomposition inventory for `runtime/src/gateway/daemon*`, `runtime/src/llm/chat-executor*`, `runtime/src/desktop/session-router.ts`, `runtime/src/desktop/manager.ts`, `containers/desktop/server/src/tools.ts`, `runtime/src/watch/agenc-watch-app.mjs`, `tests/test_1.ts`, and any similarly dominant blockers discovered in Gate 0 classification

Exit gate:

- every major contract has an owner and at least one validation strategy

### Gate 2A — Early Consumer And Shadow-Ownership Blocker Removal

Goals:

- remove the high-risk private-import and shadow-ownership blockers that would invalidate later modularity work if deferred

Must include:

- web/mobile/demo/example/script replacement surfaces for private runtime or SDK imports
- separate migration tracking for private source-path consumers and public-package consumers
- cut over the highest-risk private-import consumers that currently own app-facing runtime protocol, read-model, or socket behavior
- app-safe websocket/socket-client transport ownership clarification
- script-safe runtime/protocol/sdk helper surfaces for smoke, bootstrap, admin, and validation workflows
- MCP and docs-mcp dependency audit focused on hidden private-surface usage
- docs-mcp authority guard so legacy issue/phase/prompt surfaces stay removed and runtime-helper surfaces remain explicitly scoped and non-authoritative for the master program

Exit gate:

- runtime seam work is no longer blocked by shadow ownership in apps, scripts, or planning tooling
- remaining private-import consumers are explicitly tracked behind approved transitional surfaces and compatibility plans

### Gate 2B — Contract Authority And Tooling Lock

Goals:

- lock the shared contract-authority and tooling surfaces that later seams depend on

Must include:

- canonical root workspace/build authority lock
- repo-wide verification matrix covering core packages, app consumers, packaged examples, desktop server, Anchor/program, and zkVM/proof paths
- Anchor `target/idl` and `target/types` artifact-chain ownership clarification
- verifier-router IDL ownership clarification
- fuzz, mock-router, verifier-localnet, and real-proof gate ownership clarification
- docs/roadmap/root-policy-doc/docs-mcp synchronization rules
- docs-mcp scope expansion for whole-repo docs, runtime docs, baselines, IDL/schema artifacts, benchmark manifests, and the master refactor plan
- docs-mcp scope expansion for package-local docs and changelogs that define public usage or migration behavior
- desktop codegen ownership clarification
- desktop tool-routing and session-service ownership clarification
- app-facing gateway status / approval / background-run / observability read-model ownership clarification
- mobile adapter contract and mapping-test ownership clarification
- operator-console/watch subsystem ownership clarification, including runtime operator-event artifact compatibility
- API baseline and IDL/schema gate ownership clarification
- benchmark/gate and operational-doc ownership clarification

Exit gate:

- later package or seam work is no longer blocked by shared tooling or authority ambiguity
- validation, baseline, and artifact owners are explicit for every contract surface introduced in Gates 0 through 2A

### Gate 3 — Foundation Contract Lock And Runtime Seam Preconditions

Goals:

- lock the foundation contracts that runtime and consumers already depend on
- reduce the prerequisite cross-cuts that block the first extractable runtime seam

Must include:

- program instruction/state/event, protocol-version, and `zk_config` governance contract lock
- SDK public/internal API, proof preflight/nullifier, and export-baseline lock
- zkVM/proof schema, verifier-entry layout, and verifier contract lock
- runtime-facing protocol and proof integration contract lock
- prerequisite reduction for the planner/pipeline cross-cut across gateway, workflow, llm, memory, and tool utilities

Exit gate:

- foundation contracts are explicit enough that runtime architecture decisions are no longer built on false assumptions
- runtime cross-cuts are trimmed enough to select a first proven seam without hand-waving

### Gate 4 — Runtime First Proven Seam

Goals:

- extract and stabilize the first runtime seam that is proven by code evidence, not diagram preference

Must include:

- a short scorecard for every viable seam candidate covering current callers, direct consumer exposure including private-import consumers, existing test coverage, rollback and compatibility path, build and verification blast radius, and schema/state migration risk
- candidate-first work on planner/pipeline contracts only if the scorecard shows it is the highest-confidence extractable seam after Gate 3
- fallback selection of a smaller lower-blast-radius seam if planner/pipeline still fails the scorecard
- explicit validation and rollback coverage for the chosen seam

This gate must not begin with:

- daemon extraction
- desktop extraction
- approvals extraction
- background-run extraction
- broad package splitting

Exit gate:

- the first runtime seam is explicit, tested, and consumed through contract
- the chosen seam is backed by a predeclared scorecard and is no longer merely paper-safe

### Gate 5 — Runtime Control-Plane Boundary Reduction

Goals:

- reduce the real runtime control-plane couplings after the first proven seam exists

Must include:

- gateway ↔ llm seam reduction
- approval transport vs policy evaluation split
- background-run control-plane contract clarification
- subagent orchestration contract clarification
- daemon decomposition only after the above seams exist

Exit gate:

- runtime control-plane package or internal-boundary planning is based on real seams

### Gate 6 — Desktop Platform Contract Stabilization

Goals:

- turn desktop from hidden coupling into explicit platform

Must include:

- control contract
- event contract
- auth/identity contract
- managed-process lifecycle contract
- watchdog/recovery contract
- tool-catalog generation contract
- health/feature negotiation contract
- image/version compatibility contract

Exit gate:

- desktop can be reasoned about as a platform boundary rather than a runtime-internal assumption

### Gate 7 — Consumer Migration

Goals:

- migrate all consumers onto stable surfaces

Must include:

- mcp migration
- docs-mcp migration
- web/mobile migration
- demo-app / demo / demos / examples migration
- packaged-example public-package migration
- removal of private-import dependence
- same-gate updates to affected docs, docs-mcp resources, baselines, and consumer verification entries for each migrated surface

Exit gate:

- consumers use stable surfaces only

### Gate 8 — Verification, Docs, Tooling, And Migration Convergence

Goals:

- complete the remaining verification, docs, tooling, and migration convergence work that has been updated incrementally since Gates 2A and 2B

Must include:

- package-aware build graph
- package-aware CI/test graph
- public API baseline enforcement
- generated schema and IDL baseline enforcement
- benchmark/mutation gate ownership
- docs and docs-mcp sync
- docs-mcp resource/helper regression or snapshot validation
- migration tooling and rollback graph
- consumer verification matrix enforcement for `web` build/unit/e2e, `mobile` validation, `demo-app` build, `demo` smoke, and packaged examples
- completion of any remaining repo-wide verification entries that were introduced earlier but not yet enforced centrally

Exit gate:

- the repo can prove the architecture with its own tooling and machine-readable baselines
- no stale docs/docs-mcp/tooling/codegen authority remains after the earlier architecture gates

### Gate 9 — Internal Modularization Inside The Monorepo

Goals:

- perform package or internal-boundary extraction only after the prior seams and consumer/tooling migrations are proven

Must include:

- runtime internal modularization
- protocol/sdk internal modularization
- desktop platform packaging decisions
- consumer-facing public surfaces and façades

Exit gate:

- modularity is proven inside one workspace

### Gate 10 — Repository Split Readiness

Goals:

- prove candidate split units are independently releasable before any repo split

Must include:

- replacement of `file:../...` dependencies with versioned package inputs or published-like artifact installs
- removal of sibling `npm run --prefix ../...` and `npm install ../...` build assumptions from split candidates
- elimination or relocation of repo-local patch-path dependencies for split candidates
- published-artifact smoke validation in clean environments for each candidate split package
- repo-independent handoff for contract-bearing generated artifacts such as IDL/schema/tool-definition/operator-event outputs
- versioning, changelog, release automation, and support-window ownership for each candidate split package
- cross-repo CI and integration-matrix rehearsal using published-like artifacts rather than sibling source paths

Exit gate:

- candidate split packages can build, test, pack, install, and release without the monorepo layout
- no candidate split package still depends on repo-local internals, patches, or repository-relative artifact paths

### Gate 11 — Repository Split Decision And Extraction

Goals:

- execute the recorded split decision only after Gate 10 portability proof is green
- keep the engine private while publishing contracts and extension sockets
- make third-party contribution target the public contract layer rather than the private runtime kernel

Chosen topology:

- public `agenc-sdk`
- public `agenc-protocol`
- public `agenc-plugin-kit` (new, narrow extension ABI)
- private `agenc-core`
- private `agenc-prover` or `agenc-cloud`

Must include:

- exact folder-to-repo ownership mapping
- public/private package distribution policy
- `agenc-plugin-kit` v1 manifest, lifecycle, and certification contract
- explicit `plugin-kit` host ABI versioning and compatibility policy owned by `agenc-core`
- migration of repository metadata, issue and docs authority, and consumer install paths to the chosen repo topology
- explicit rollback path back to the monorepo release topology
- deprecation/migration handling for runtime-side packages that should no longer be treated as public long-term contracts

Guardrails:

- `runtime`, `mcp`, `docs-mcp`, desktop control-plane surfaces, apps, and proving ops are not the public extension model
- `contracts/desktop-tool-contracts` stays internal/private unless a separate external use case is explicitly proven
- public examples must be SDK-only or plugin-kit-only; examples needing private runtime internals remain private
- `zkvm/guest` belongs with the public protocol/trust surface; `zkvm/host` and remote prover operations remain private
- the current `AgenC` repo is the frozen `agenc-core` baseline for Gate 11 unless a later fallback mirror is explicitly invoked
- runtime-side package names already published publicly are transitional artifacts only and require explicit deprecation plus migration handling before any visibility tightening

Exit gate:

- extracted repos run on released contracts rather than monorepo internals
- the public/private boundary is enforced in code, packaging, docs, and CI
- rollback remains possible at every extraction wave

### Gate 12 — Legacy Deletion And Convergence

Goals:

- remove transitional scaffolding that is now truly dead

Must include:

- façade removal
- compatibility shim removal
- stale docs removal
- dead example deletion
- generator and script cleanup

Exit gate:

- every removal is backed by search, tests, and release notes

---

## 10. Dependency Rules

The following sequencing rules are mandatory:

1. No repo split before internal modularity and repo-split readiness are proven.
2. No candidate package may be called split-ready while it still depends on `file:../...`, sibling `--prefix ../...` build steps, repo-local patches, or repository-relative artifact paths.
3. No first runtime seam may be selected without a published scorecard covering caller count, consumer exposure, test coverage, rollback path, build impact, and schema/state risk.
4. No runtime package extraction before planner/pipeline and control-plane seams are proven.
5. No desktop extraction before the desktop platform contract exists.
6. No consumer migration is “done” while apps or tooling still import private source files.
7. No build/CI refactor is “later”; both minimum build closure and the repo-wide verification matrix must remain green through the program.
8. No docs or `docs-mcp` gate may lag the package-map, phase-graph, or contract changes it describes.
9. No protocol/runtime separation may rely on moving Solana- or Anchor-dependent types into zero-dependency core layers.
10. No proof refactor may bypass versioned schema and verifier expectations.
11. No public package or consumer-facing surface may change without updating the relevant machine-readable baseline or generated contract artifact.

---

## 11. Risk Register

### R1 — Fake Runtime Seams

Risk:

- package moves are chosen by diagram aesthetics rather than real responsibilities

Mitigation:

- seam extraction before code motion

### R2 — Consumer Drift

Risk:

- web/mobile/examples/demo/scripts/MCP continue to depend on private internals or drift on app-facing read models

Mitigation:

- early consumer inventory and explicit replacement surfaces

### R3 — Desktop Hidden Coupling

Risk:

- desktop runtime and container platform are split on paper but not in reality

Mitigation:

- treat desktop as one platform contract first

### R4 — Foundation Domains Parked Too Long

Risk:

- protocol, SDK, and zkVM are treated as unchanged until late, invalidating runtime decisions

Mitigation:

- dedicated Gate 3 foundation-contract lock before the first runtime seam is extracted

### R5 — Docs And Docs-MCP Drift

Risk:

- architecture docs, roadmap, and docs-mcp become false authority during the refactor, including runtime-helper surfaces that overclaim scope or any reintroduced legacy issue/phase tooling that drifts from the current repository authority

Mitigation:

- sync docs and docs-mcp in the same gates as architecture changes and require a current scope manifest for docs-mcp

### R6 — Tooling And CI Become The Hidden Blocker

Risk:

- build, test, benchmark, codegen, and release logic no longer match the architecture

Mitigation:

- treat build/test closure, repo-wide verification matrix, baselines, codegen, and package-aware CI as required architecture work from Gates 2A and 2B onward

### R7 — Giant Files And Tests Become Permanent Excuses

Risk:

- oversized files like daemon/chat-executor, `runtime/src/watch/agenc-watch-app.mjs`, and giant test surfaces such as `tests/test_1.ts` block progress indefinitely

Mitigation:

- decompose them only after contract seams exist, and make that decomposition a gated deliverable

### R8 — Public Compatibility Is Faked By Human Memory

Risk:

- package compatibility is asserted informally instead of being proven against API baselines and generated artifacts

Mitigation:

- require public API baselines, IDL/schema baselines, and benchmark/gate artifacts to be updated and reviewed as hard gates

### R9 — Root Surface Ambiguity

Risk:

- reintroducing build-bearing product code at the repo root would blur the workspace contract and recreate the retired legacy surface problem

Mitigation:

- keep root ownership limited to workspace orchestration, shared scripts, and explicit package entrypoints

---

## 12. Forbidden Shortcuts

The following are explicitly forbidden:

- pretending a runtime-only plan covers the whole repository
- calling a domain “unchanged” without analysis
- using repo split as a substitute for modularity
- moving control-plane glue into autonomous or policy packages just to clean up a diagram
- treating desktop as isolated while runtime build/test and container/server behavior remain coupled
- assuming apps are protected by a façade while they still import `runtime/src` directly
- assuming operational scripts are “just tooling” while they still import `runtime/src` or `sdk/src` directly
- parking `mcp` or `docs-mcp` while still claiming core package build closure
- parking docs while docs-mcp drifts from the indexed authoritative planning docs
- treating docs-mcp as whole-repo authority without a current scope manifest and indexed-corpus audit
- treating runtime-scoped docs-mcp helper tools as if they define whole-repository refactor authority
- claiming the repo is green while app, desktop-server, Anchor, zkVM, or other build-bearing surfaces are red
- pushing Solana- or Anchor-dependent types into zero-dependency core layers
- changing proof or protocol schemas without versioned migration strategy
- delaying CI, benchmarks, mutation gates, codegen, or migration scripts to a final polish gate
- changing published or consumer-facing surfaces without updating API baselines, IDL/schema artifacts, or other machine-readable contract files
- deleting public exports or compatibility layers before all consumers migrate
- treating newly introduced root build-bearing source code as harmless leftovers instead of blocking and classifying it immediately

---

## 13. Current Dependency Priorities

Current status:

- Gates 0 through 9 have produced their gate artifacts and monorepo modularity proof.
- Gate 10 passed its final exit review on `2026-03-16` for the current split-candidate scope.
- Gate 11 is `IN PROGRESS` with a recorded split decision: public contracts and extension sockets, private core and proving/control-plane repos.
- Gate 11 Phase 0 boundary lock is now recorded in [ADR-002](docs/architecture/adr/adr-002-public-contract-private-kernel-boundary.md):
  - public `agenc-sdk`, `agenc-protocol`, `agenc-plugin-kit`
  - private `agenc-core`, `agenc-prover`/`agenc-cloud`
  - `AgenC` frozen as the `agenc-core` baseline
  - `plugin-kit` host ABI and runtime-side package deprecation policy are mandatory parts of the program, not optional follow-up cleanup
- Gate 11 execution has started materially:
  - `agenc-sdk` was extracted and the monorepo now consumes the released `@tetsuo-ai/sdk@1.3.1` artifact
  - `agenc-protocol` now exists as a standalone public trust-surface repo with committed generated artifacts on `main`
  - AgenC completed the first protocol consumer cutover slice against released `@tetsuo-ai/protocol@0.1.1`; vendored runtime protocol artifact authority is gone and local `target/**` protocol assets are now explicit test-only validation inputs
  - `agenc-plugin-kit` now exists as a standalone public repo/package; AgenC consumes the released `@tetsuo-ai/plugin-kit@0.1.1` artifact and keeps only a de-authorized local rollback mirror
  - the first supported public extension class is `channel_adapter`
  - AgenC runtime now hosts plugin-backed external channels through a private adapter seam with:
    - package allowlisting via `plugins.trustedPackages`
    - explicit allowed subpaths
    - reserved built-in channel-name protection
    - manifest/channel-key matching
    - pack/install/baseline proof for the public package
  - the first `agenc-prover` bootstrap is now explicitly phased:
    - the `admin bootstrap slice` is now canonical in `agenc-prover/admin-tools` (`zk-config-admin*`, `devnet-preflight`, `protocol-program`, and the supporting package/test/typecheck files)
    - keep the `shared proof-harness/localnet slice` (`tools/proof-harness/verifier-localnet`, `tools/proof-harness/benchmark-private-e2e*`, root verifier/bootstrap scripts/tests/fixtures) in the current repo until a released shared proof-harness contract or deliberate full ownership transfer exists
    - keep `scripts/idl/**` protocol-owned throughout that phase
    - Authority rule: the first `agenc-prover` bootstrap moves only the `admin bootstrap slice`; the `shared proof-harness/localnet slice` stays with the current repo or `agenc-protocol` until a released shared proof-harness contract or deliberate full ownership transfer exists
  - that first private bootstrap is now live in [`tetsuo-ai/agenc-prover`](https://github.com/tetsuo-ai/agenc-prover) on `main`:
    - `admin-tools/` owns the mirrored admin bootstrap slice
    - the private repo enforces the narrowed slice with `scripts/check-admin-bootstrap-boundary.mjs`
    - validation there now includes admin-tools typecheck/tests plus Rust `cargo test -p agenc-prover-server` and `cargo build --release -p agenc-prover-server --features production-prover`
    - AgenC has now removed the mirrored admin files and retains only the dedicated shared proof-harness workspace
  - runtime-side visibility tightening is now materially in place in AgenC:
    - `runtime`, `mcp`, `docs-mcp`, and `desktop-tool-contracts` manifests are explicitly `private`
    - public-entrypoint docs now route external builders to `@tetsuo-ai/sdk`, `@tetsuo-ai/protocol`, and `@tetsuo-ai/plugin-kit`
    - a dedicated `check-private-kernel-surface` guard now enforces the manifest/doc posture in CI alongside pack-smoke and plugin-kit boundary checks
  - the private-kernel distribution contract is now materially locked:
    - `docs/PRIVATE_KERNEL_DISTRIBUTION.md` is the canonical support-window and internal distribution policy
    - `config/private-kernel-distribution.json` defines the staged internal package identities, registry contract, auth modes, and sunset criteria
    - `scripts/private-kernel-distribution.mjs` stages tarball-derived private packages under a dedicated internal scope and emits machine-readable dry-run outcomes
    - the local/CI reference backend is now implemented and validated through `scripts/private-registry-service.mjs`, `scripts/bootstrap-private-registry-user.mjs`, `scripts/private-registry-rehearsal.mjs`, and `.github/workflows/private-kernel-registry.yml`
    - that reference path now proves service-account bootstrap, authenticated dry-run publication, and live publish/install rehearsal for staged private packages
    - the permanent hosted backend is now chosen as Cloudsmith `agenc/private-kernel`, and protected hosted validation is wired through `.github/workflows/private-kernel-cloudsmith.yml`
    - the remaining backend work is the first successful protected hosted validation run plus its auth/operations rollout; the local/CI reference path remains the untrusted reference backend and is no longer a placeholder
- Gate 12 remains blocked until the Gate 11 extraction topology is materially stable.

The next work to execute under this plan is:

1. finish Wave 1 `agenc-sdk` stabilization after the first standalone release
   - the standalone `agenc-sdk` repo exists and `@tetsuo-ai/sdk@1.3.1` is published from it
   - the AgenC monorepo already consumes the released SDK artifact and no longer owns SDK workspace builds
   - keep the local `sdk/` and `examples/private-task-demo/` trees only as de-authorized rollback mirrors until the next extraction wave is stable, then delete them
2. execute the next `agenc-protocol` slice inside AgenC:
   - this cutover landed on `2026-03-16`: runtime now consumes released `@tetsuo-ai/protocol` artifacts, `runtime/idl/**` authority is gone, `runtime/scripts/copy-idl.js` is removed, and root tests use the published package or the explicit `tests/protocol-artifacts.ts` local fallback
   - keep the local test-only `AGENC_USE_LOCAL_PROTOCOL_TARGET=1` fallback explicit and scoped to unreleased protocol development
   - update active docs and verification records so they stop claiming runtime still owns vendored protocol artifact truth
3. finish `agenc-plugin-kit` stabilization, certification coverage, and the remaining runtime-side deprecation/private-distribution backend provisioning work after the first standalone release
4. cut over the private prover admin bootstrap slice from AgenC to `agenc-prover` authority while keeping `agenc-core` private
   - the first bootstrap is already live in `tetsuo-ai/agenc-prover`
   - de-authorize the mirrored AgenC admin slice only after the private repo completes a stable release-quality cycle as the canonical owner
   - this cutover is now complete for AgenC admin wrappers/docs; AgenC retains only the `tools/proof-harness` shared slice (`verifier-localnet`, benchmark entrypoints/helpers, root verifier/bootstrap scripts/tests/fixtures)
   - keep `scripts/idl/**` protocol-owned during that phase
   - Authority rule: the first `agenc-prover` bootstrap moves only the `admin bootstrap slice`; the `shared proof-harness/localnet slice` stays with the current repo or `agenc-protocol` until a released shared proof-harness contract or deliberate full ownership transfer exists
5. execute Gate 12 cleanup only after the Gate 11 extraction topology is materially stable
6. reopen Gate 10 only if a new split candidate reintroduces repo-relative coupling, repo-local patching, or non-portable artifact handoff

No one should start Gate 11 extraction work without preserving the Gate 10 portability guarantees already proven here.

---

## 14. Completion Criteria

This program is complete only when:

1. every domain in Section 4 has been explicitly addressed
2. every contract category in Section 7 has an implemented and verified boundary
3. every domain plan in Section 8 has met its acceptance gates
4. every dependency gate in Section 9 has met its exit gate
5. every dependency rule in Section 10 has been respected
6. no forbidden shortcut in Section 12 was used to fake completion

Until then, the refactor is still in progress.
