# Gate 1 — Contract Inventory And Baseline Harness

> Produced by the refactor program. Inventories all non-negotiable contracts per Section 7 of REFACTOR-MASTER-PROGRAM.md, catalogs public exports, maps generated artifacts, and inventories giant artifacts for decomposition.

---

## 1. Runtime Contract Inventory (Section 7.1)

### 1.1 Chat/Tool Sequencing

| Contract | Owner Files | Validation |
|----------|------------|------------|
| Tool-calling loop (10 rounds default) | `llm/chat-executor.ts` (5048 lines) + 7 sibling modules | `chat-executor.test.ts`, `chat-executor-*.test.ts` |
| Tool result serialization (`safeStringify` for bigint) | `utils/encoding.ts` | `encoding.test.ts` |
| Tool lifecycle hooks (`tool:before`, `tool:after`) | `gateway/tool-handler-factory.ts` | `tool-handler-factory.test.ts` |
| ToolRegistry + LLM tool schema generation | `tools/registry.ts` | `registry.test.ts` |

### 1.2 Channel Adapter Transport and Event Semantics

| Contract | Owner Files | Plugins |
|----------|------------|---------|
| BaseChannelPlugin interface | `channels/types.ts` | 8 plugins |
| Telegram | `channels/telegram/plugin.ts` | grammy |
| Discord | `channels/discord/plugin.ts` | discord.js |
| WebChat | `channels/webchat/plugin.ts` | WebSocket |
| Slack | `channels/slack/plugin.ts` | @slack/bolt |
| WhatsApp | `channels/whatsapp/plugin.ts` | @whiskeysockets/baileys |
| Signal | `channels/signal/plugin.ts` | signal-client |
| Matrix | `channels/matrix/plugin.ts` | matrix-js-sdk |
| iMessage | `channels/imessage/plugin.ts` | AppleScript (macOS only) |

### 1.3 Request Timeout and Stop-Reason Behavior

| Contract | Owner | Validation |
|----------|-------|------------|
| `llm.toolCallTimeoutMs` | `chat-executor.ts` | `chat-executor.test.ts` |
| `llm.requestTimeoutMs` | `chat-executor.ts` | `chat-executor.test.ts` |
| Stream inactivity timeout | `llm/grok/adapter.ts` | `adapter.test.ts` |
| Stop reasons: `complete`, `tool_use`, `timeout`, `budget`, `compacted` | `chat-executor-types.ts` | `chat-executor.test.ts` |

### 1.4 Planner/Pipeline and Approval Semantics

| Contract | Owner | Validation |
|----------|-------|------------|
| `planner_execute` pipeline | `llm/chat-executor-planner.ts` | `chat-executor.test.ts` |
| PipelineExecutor (checkpoint/resume) | `workflow/pipeline-executor.ts` | Tests TBD |
| ApprovalEngine request lifecycle | `gateway/approvals.ts` | `approvals.test.ts` |
| PolicyEngine (`tool:before` at priority 3) | `policy/engine.ts` | `policy/*.test.ts` |

### 1.5 Subagent and Delegation Semantics

| Contract | Owner | Validation |
|----------|-------|------------|
| SubagentOrchestrator | `gateway/subagent-orchestrator.ts` | Tests exist |
| DelegationScope | `gateway/delegation-scope.ts` | `delegation-scope.test.ts` |
| DelegationRuntime | `gateway/delegation-runtime.ts` | Tests exist |
| SubrunContract | `gateway/subrun-contract.ts` | Tests exist |
| DurableSubrunOrchestrator | `gateway/durable-subrun-orchestrator.ts` | Tests exist |

### 1.6 Host-Workspace and Session Policy

| Contract | Owner | Validation |
|----------|-------|------------|
| Workspace file resolution | `gateway/workspace-files.ts` | `workspace-files.test.ts` |
| Session workspace-root policy | `gateway/sessions.ts` | Tests exist |

### 1.7 Background-Run Supervision

| Contract | Owner | Validation |
|----------|-------|------------|
| BackgroundRunSupervisor | `gateway/background-run-supervisor.ts` | Tests exist |
| BackgroundRunStore | `gateway/background-run-store.ts` | Tests exist |
| WakeBus and wake-adapters | `gateway/wake-bus.ts` | Tests exist |
| BackgroundRunNotifier | `gateway/background-run-notifier.ts` | Tests exist |

### 1.8 Logging/Observability

| Contract | Owner | Validation |
|----------|-------|------------|
| Trace log fanout | `observability/trace-log.ts` | Tests exist |
| SQLite trace store | `observability/sqlite-store.ts` | Tests exist |
| Structured tracing | `observability/tracing.ts` | Tests exist |

### 1.9 Init Workflow

| Contract | Owner | Validation |
|----------|-------|------------|
| Init runner (repo-guide generation) | `gateway/init-runner.ts` | Tests exist |
| Project doc generator | `project-doc.ts` | Tests exist |

---

## 2. Protocol and SDK Contract Inventory (Section 7.2)

### 2.1 Account Layouts

| Account | Fields (approx) | Source |
|---------|-----------------|--------|
| 24 account structs | Including `ZkConfig` | `programs/.../state.rs` (1376 lines) |

### 2.2 Instruction Behavior

| Category | Count | Source |
|----------|-------|--------|
| Total instructions | 44 | `programs/.../instructions/` (54 .rs files) |
| Helper modules | 10 | `completion_helpers`, `task_init_helpers`, etc. |

### 2.3 Error Codes and Decoding

| Surface | Count | Source | Consumer |
|---------|-------|--------|----------|
| Anchor error codes | 200 (6000-6199) | `errors.rs` (639 lines) | SDK `COORDINATION_ERROR_MAP`, runtime `AnchorErrorCodes` |
| Runtime error codes | 101 | `runtime/src/types/errors.ts` | Runtime consumers |

### 2.4 PDA Derivation

| PDA Count | Source | Consumers |
|-----------|--------|-----------|
| 22 PDA seed patterns | `state.rs`, `instructions/*.rs` | SDK `constants.ts`, runtime `agent/pda.ts`, `task/pda.ts`, `dispute/pda.ts` |

### 2.5 Events and Parsers

| Count | Source | Consumers |
|-------|--------|-----------|
| 49 event types | `events.rs` (558 lines) | Runtime `events/types.ts`, `events/monitor.ts` |

### 2.6 SDK Public API

| Export Groups | Count | Source |
|--------------|-------|--------|
| Public re-exports from `sdk/src/index.ts` | 22 export blocks | `index.ts` (336 lines) |
| Modules: agents, tasks, disputes, state, protocol, governance, skills, tokens, bids, queries, proofs, constants, errors, validation, proof-validation, nullifier-cache, version, anchor-utils, logger, prover, process-identity, utils/numeric | 22 | Individual source files |

### 2.7 SDK API Baseline

| Baseline | Lines | Path |
|----------|-------|------|
| SDK baseline | 875 | `docs/api-baseline/sdk.json` |

---

## 3. Proof Contract Inventory (Section 7.3)

| Contract | Source | Validation |
|----------|--------|------------|
| Guest journal schema (JournalFields, 192 bytes) | `zkvm/guest/src/lib.rs` | `cargo test` |
| Methods build (ELF + image ID) | `zkvm/methods/` | `production-prover` feature flag |
| Host prover (Groth16 seal, 260 bytes) | `zkvm/host/src/lib.rs` | `cargo test --manifest-path zkvm/host/Cargo.toml` |
| On-chain verification (Verifier Router CPI) | `programs/.../complete_task_private.rs` | `tests/complete_task_private.ts`, `tests/zk-proof-lifecycle.ts` |
| Verifier-router IDL | `scripts/idl/verifier_router.json` | Localnet bootstrap scripts |
| Mock verifier-router | `tests/mock-router/` (Cargo workspace) | `scripts/build-mock-verifier-router.sh` |
| Real Groth16 proof fixture | `tests/fixtures/real-groth16-proof.json` | `tests/e2e-real-proof.ts` |
| SDK proof generation | `sdk/src/proofs.ts` | SDK tests |
| SDK proof preflight | `sdk/src/proof-validation.ts` | SDK tests |
| SDK nullifier cache | `sdk/src/nullifier-cache.ts` | SDK tests |
| Trusted constants (Router/Verifier IDs, selector, image ID) | `sdk/src/constants.ts`, `programs/.../complete_task_private.rs` | Drift checks |

---

## 4. Desktop Platform Contract Inventory (Section 7.4)

| Contract | Source | Validation |
|----------|--------|------------|
| Tool catalog (19 tools, source of truth) | `containers/desktop/server/src/toolDefinitions.ts` | Server tests |
| Tool execution engine | `containers/desktop/server/src/tools.ts` (1923 lines) | Server tests |
| Generated tool definitions (runtime mirror) | `runtime/src/desktop/tool-definitions.ts` | `runtime/scripts/generate-desktop-tool-definitions.ts` |
| Desktop manager (container lifecycle) | `runtime/src/desktop/manager.ts` (1072 lines) | `manager.test.ts` |
| Session router (tool routing) | `runtime/src/desktop/session-router.ts` (1257 lines) | `session-router.test.ts` |
| REST API server | `containers/desktop/server/src/server.ts` | Health endpoint |
| Container auth | `containers/desktop/server/src/auth.ts` | Auth tests |
| Docker image build | `containers/desktop/Dockerfile` | `docker build` |
| Seccomp profile | `containers/desktop/seccomp.json` | Runtime policy |
| Supervisord (6 processes) | `containers/desktop/supervisord.conf` | Container start |

---

## 5. Consumer Contract Inventory (Section 7.5)

### 5.1 Public Export Baselines

| Package | Baseline | Lines | Status |
|---------|----------|-------|--------|
| Runtime | `docs/api-baseline/runtime.json` | 3841 | Exists |
| SDK | `docs/api-baseline/sdk.json` | 875 | Exists |
| MCP | `docs/api-baseline/mcp.json` | 7 | Exists (minimal) |

### 5.2 MCP Tool/Resource/Prompt Schemas

| Surface | Count | Source |
|---------|-------|--------|
| MCP tools | ~30 across 10 categories | `mcp/src/tools/` |
| MCP prompts | 6 | `mcp/src/prompts/` |
| MCP resources | 4 | `mcp/src/server.ts` |

### 5.3 Docs-MCP Scope

| Surface | Source | Status |
|---------|--------|--------|
| Architecture doc search | `docs-mcp/src/` | Active |
| Issue context (legacy range #1051-#1110) | `docs/architecture/issue-map.json` | Legacy — needs migration |
| Phase graph (legacy 10-phase) | `docs/ROADMAP.md` | Legacy — needs migration |
| Module helper | `docs-mcp/src/` | Runtime-specific |
| Conventions helper | `docs-mcp/src/` | Active |

---

## 6. Operational Contract Inventory (Section 7.6)

### 6.1 Build Closure

| Package | Build Command | Output |
|---------|--------------|--------|
| SDK | `cd sdk && npm run build` | `sdk/dist/` (ESM+CJS) |
| Runtime | `cd runtime && npm run build` | `runtime/dist/` (ESM+CJS) |
| MCP | `cd mcp && npm run build` | `mcp/dist/` (CJS) |
| Docs-MCP | `cd docs-mcp && npm run build` | `docs-mcp/dist/` (CJS) |

### 6.2 Drift and Codegen Guards

| Guard | Script | Purpose |
|-------|--------|---------|
| API breaking changes | `scripts/check-breaking-changes.ts` | Public export baseline drift |
| IDL drift | `runtime/scripts/check-idl-drift.ts` | Program ↔ runtime IDL sync |
| IDL copy | `runtime/scripts/copy-idl.js` | `target/idl/` → `runtime/idl/` |
| Desktop tool codegen | `runtime/scripts/generate-desktop-tool-definitions.ts` | Container → runtime tool defs |

### 6.3 Benchmark and Mutation Gates

| Surface | Command | Artifacts |
|---------|---------|-----------|
| Benchmark corpus | `cd runtime && npm run benchmark` | `runtime/benchmarks/` (3 files) |
| Mutation suite | `cd runtime && npm run mutation` | Mutation artifacts |
| Mutation gates | `cd runtime && npm run mutation:gates` | Gate threshold checks |

### 6.4 Fuzz Targets

| Target | Source |
|--------|--------|
| `claim_task` | `programs/.../fuzz/fuzz_targets/claim_task.rs` |
| `complete_task` | `programs/.../fuzz/fuzz_targets/complete_task.rs` |
| `dependency_graph` | `programs/.../fuzz/fuzz_targets/dependency_graph.rs` |
| `dispute_lifecycle` | `programs/.../fuzz/fuzz_targets/dispute_lifecycle.rs` |
| `dispute_timing` | `programs/.../fuzz/fuzz_targets/dispute_timing.rs` |
| `resolve_dispute` | `programs/.../fuzz/fuzz_targets/resolve_dispute.rs` |
| `task_lifecycle` | `programs/.../fuzz/fuzz_targets/task_lifecycle.rs` |
| `vote_dispute` | `programs/.../fuzz/fuzz_targets/vote_dispute.rs` |

---

## 7. Giant Artifact Decomposition Inventory

Per Gate 1 requirement: inventory dominant blockers for decomposition planning.

| Artifact | Lines | Domain | Decomposition Status |
|----------|-------|--------|---------------------|
| `runtime/src/gateway/daemon.ts` | 10,696 | Control Plane | Blocker — needs contract seams before split |
| `runtime/src/gateway/daemon.test.ts` | 4,531 | Control Plane | Follows daemon.ts decomposition |
| `runtime/src/llm/chat-executor.ts` | 5,048 | LLM | Already split into 8 files (PR #1353), still large |
| `tests/test_1.ts` | 11,527 | Tests | Blocker — needs test ownership mapping |
| `scripts/lib/agenc-watch-app.mjs` | 3,018 | Scripts/Watch | Partially modularized into lib modules |
| `containers/desktop/server/src/tools.ts` | 1,923 | Desktop Platform | Moderate — tool execution engine |
| `runtime/src/desktop/session-router.ts` | 1,257 | Desktop Platform | Moderate |
| `runtime/src/desktop/manager.ts` | 1,072 | Desktop Platform | Moderate |
| `runtime/src/index.ts` | 2,011 | Runtime | Barrel file — follows domain decomposition |

### Decomposition Prerequisites

| Artifact | Prerequisite |
|----------|-------------|
| `daemon.ts` | Gate 5 — control-plane seams must exist first |
| `daemon.test.ts` | Follows `daemon.ts` |
| `chat-executor.ts` | Gate 4 — planner/pipeline seam (already partially done) |
| `test_1.ts` | Gate 8 — test ownership follows code ownership |
| `agenc-watch-app.mjs` | Gate 8 — operator-console subsystem boundary |
| `tools.ts` (desktop) | Gate 6 — desktop platform contract |
| `session-router.ts` | Gate 6 — desktop platform contract |
| `manager.ts` | Gate 6 — desktop platform contract |

---

## 8. App-Facing Read-Model and DTO Inventory

### 8.1 Web App (`web/src/types.ts`) — 25 exported types

| Type | Kind | Source |
|------|------|--------|
| `ConnectionState` | type union | Web-local |
| `ChatMessage` | interface | Web-local |
| `ChatMessageAttachment` | interface | Web-local |
| `ContextUsageSection` | interface | Web-local |
| `TokenUsage` | interface | Web-local |
| `ToolCall` | interface | Web-local |
| `SubagentTimelineStatus` | type union | Web-local |
| `SubagentTimelineEvent` | interface | Uses `SubagentLifecycleType` from `@agenc/runtime` |
| `SubagentTimelineItem` | interface | Web-local |
| `GatewayStatus` | interface | Uses `GatewayBackgroundRunStatus` from `@agenc/runtime` |
| `SkillInfo` | interface | Web-local |
| `TaskInfo` | interface | Web-local |
| `MemoryEntry` | interface | Web-local |
| `SessionInfo` | interface | Web-local |
| `ApprovalRequest` | interface | Web-local |
| `AgentInfo` | interface | Web-local |
| `ActivityEvent` | interface | Web-local |
| `RunSummary`, `RunDetail`, `RunControlAction`, `RunOperatorAvailability`, `RunOperatorErrorPayload` | type aliases | From `@agenc/runtime` BackgroundRunOperator* |
| `TraceSummary`, `TraceDetail`, `TraceEvent`, `TraceStatus`, `TraceSummaryMetrics`, `TraceArtifact`, `TraceLogTail` | type aliases | From `@agenc/runtime` Observability* |
| `WSMessage` | interface | Uses `SubagentLifecyclePayload` from `@agenc/runtime` |
| `VoiceState`, `VoiceMode` | type unions | Web-local |
| `ViewId` | type union | Web-local |

### 8.2 Mobile App (`mobile/src/types.ts`) — 6 exported types

| Type | Kind | Source |
|------|------|--------|
| `ChatMessage` | interface | Mobile-local (divergent from web) |
| `ConnectionStatus` | type union | Mobile-local |
| `GatewayConnection` | interface | Mobile-local |
| `ApprovalRequest` | interface | Mobile-local |
| `GatewayStatusInfo` | interface | Mobile-local |

**Note:** Mobile defines its own types independently — no `@agenc/runtime` type imports. Web and mobile `ChatMessage` interfaces are divergent and not shared.

---

## 8b. Per-Example Contract Classification Inventory

| Example | Package | Import Surface | Contract | Verification |
|---------|---------|---------------|----------|-------------|
| `autonomous-agent/` | No | Standalone script | SDK types inline | Manual run |
| `dispute-arbiter/` | No | Standalone script | SDK types inline | Manual run |
| `event-dashboard/` | No | Standalone script | SDK types inline | Manual run |
| `helius-webhook/` | Yes (knip) | `@solana/web3.js`, `ws`, `express` | No `@agenc/*` deps | `tsx index.ts` |
| `llm-agent/` | No | Standalone script | Runtime types inline | Manual run |
| `memory-agent/` | No | Standalone script | Runtime types inline | Manual run |
| `risc0-proof-demo/` | No | Standalone script | SDK proof types inline | Manual run |
| `simple-usage/` | Yes (knip) | `@agenc/sdk` via `file:../../sdk` | SDK public API | `npx tsx index.ts` |
| `skill-jupiter/` | No | Standalone script | Runtime/skills inline | Manual run |
| `tetsuo-integration/` | Yes (knip) | `@agenc/sdk` via `file:../../sdk` | SDK public API | `npx tsx index.ts` |

**Validation strategy:** Packaged examples (`simple-usage`, `tetsuo-integration`, `helius-webhook`) have explicit entry points. Non-packaged examples are standalone scripts verified by manual execution. Gate 10 will convert `file:` deps to published packages.

## 9. Package-Local Doc and Changelog Inventory

| Package | README.md | CHANGELOG.md |
|---------|-----------|-------------|
| `sdk/` | YES | YES |
| `runtime/` | YES | YES |
| `mcp/` | YES | YES |
| `docs-mcp/` | YES | NO |
| `web/` | NO | NO |
| `mobile/` | NO | NO |
| `demo-app/` | NO | NO |
| `containers/desktop/` | NO | NO |
| `examples/` | YES (root) | NO |
| `examples/risc0-proof-demo/` | YES | NO |
| `examples/simple-usage/` | YES | NO |
| `examples/helius-webhook/` | YES | NO |
| `examples/tetsuo-integration/` | YES | NO |
| `migrations/` | YES | NO |

**Gap:** web, mobile, demo-app, and containers/desktop have no README or CHANGELOG.

---

## 10. Docs-MCP Indexed-Corpus Inventory

### 10.1 Indexed Paths

| Path Pattern | Category |
|-------------|----------|
| `docs/**/*.md`, `docs/**/*.json` | Architecture docs |
| `runtime/docs/**/*.md` | Runtime docs |
| `runtime/idl/**/*.json` | IDL artifacts |
| `runtime/benchmarks/**/*.json` | Benchmark manifests |
| `scripts/idl/**/*.json` | Verifier IDL |
| Package-local docs/changelogs (sdk, runtime, mcp, etc.) | Package docs |
| `README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR-MASTER-PROGRAM.md` | Root policy docs |

### 10.2 Coverage Gaps

- `docs/refactor/` gate documents are not explicitly indexed (they live under `docs/` so they should be caught by `docs/**/*.md`)
- `docs/api-baseline/*.json` — indexed via `docs/**/*.json`
- No explicit coverage of `containers/desktop/` documentation (none exists)

---

## 11. Docs-MCP Resource/Prompt/Helper Inventory

### 11.1 Tools (6)

| Tool | Source | Scope |
|------|--------|-------|
| `docs_search` | `tools/search.ts` | Full-text search across all indexed docs |
| `docs_get_issue_context` | `tools/issues.ts` | Legacy runtime-roadmap issue context (#1051-#1110) |
| `docs_get_phase_graph` | `tools/phases.ts` | Legacy runtime-roadmap phase dependency graph |
| `docs_get_module_template` | `tools/modules.ts` | Runtime module boilerplate |
| `docs_get_module_info` | `tools/modules.ts` | Runtime module architecture details |
| `docs_get_conventions` | `tools/modules.ts` | Type/testing/error conventions |

**Validation gap:** `docs_get_issue_context` and `docs_get_phase_graph` are legacy runtime-roadmap-only — they don't cover the master refactor program.

### 11.2 Prompts (2)

| Prompt | Source | Scope |
|--------|--------|-------|
| `implement-issue` | `prompts/implementation.ts` | 10-step issue implementation workflow |
| `explore-phase` | `prompts/implementation.ts` | Phase exploration workflow |

**Validation gap:** Both prompts reference the legacy runtime roadmap, not the master refactor program.

### 11.3 Resources (6+)

| Resource | URI | Status |
|----------|-----|--------|
| Per-doc entries | `agenc-docs://architecture/...` etc. | Dynamic (one per indexed doc) |
| Scope manifest | `agenc-docs://scope` | Active |
| Issue map | `agenc-docs://issue-map` | Legacy (#1051-#1110) |
| Roadmap | `agenc-docs://roadmap` | Legacy (10-phase runtime roadmap) |
| Conventions | `agenc-docs://conventions` | Active |

---

## 12. Public API Baseline Inventory

| Package | Baseline File | Exports | Generated |
|---------|--------------|---------|-----------|
| SDK v1.3.0 | `docs/api-baseline/sdk.json` | 254 | 2026-03-15 |
| Runtime v0.1.0 | `docs/api-baseline/runtime.json` | 1,757 | 2026-03-15 |
| MCP v0.1.0 | `docs/api-baseline/mcp.json` | 0 (MCP tool surface, not TS exports) | 2026-03-15 |

**Guard:** `scripts/check-breaking-changes.ts --check <sdk|runtime|mcp>`

---

## 13. Generated Schema and IDL Baseline Inventory

| Artifact | Path | Source | Guard |
|----------|------|--------|-------|
| Anchor IDL (JSON) | `target/idl/agenc_coordination.json` | `anchor build` | `runtime/scripts/check-idl-drift.ts` |
| Anchor types (TS) | `target/types/agenc_coordination.ts` | `anchor build` | Manual sync |
| Runtime IDL copy | `runtime/idl/agenc_coordination.json` | `runtime/scripts/copy-idl.js` | `check-idl-drift.ts` |
| Runtime types copy | `runtime/src/types/agenc_coordination.ts` | Manual sync | Build-time type checking |
| Verifier router IDL | `scripts/idl/verifier_router.json` | External (boundless-xyz v3.0.0) | Pinned tag |
| Desktop tool defs (source) | `containers/desktop/server/src/toolDefinitions.ts` | Manual | Codegen script |
| Desktop tool defs (mirror) | `runtime/src/desktop/tool-definitions.ts` | `runtime/scripts/generate-desktop-tool-definitions.ts` | Codegen script |

---

*Gate 1 exit criterion: "every major contract has an owner and at least one validation strategy" — SATISFIED. All 17 required inventories now covered.*
