# REFACTOR.md — AgenC Cage Architecture (v4)

> Breaking the AgenC monorepo into self-contained modules (cages). Separate repos, stable interfaces, install only what you need.
>
> **v4** — Second adversarial 5-agent review against actual codebase. Line counts replaced with verified `wc -l` measurements. ChatExecutor file count corrected (30 files). 11 new cross-cage violations discovered and resolved (21 total). @agenc/common Solana dependency contradiction fixed. tools/social/ and tools/marketplace/ reassigned to AgenX. Phase 0 effort estimate revised upward.

---

## Table of Contents

1. [Vision](#1-vision)
2. [Cage Map](#2-cage-map)
3. [Dependency Graph](#3-dependency-graph)
4. [Cage Specifications](#4-cage-specifications)
   - [4.0 @agenc/common — Shared Foundation](#40-agenccommon--shared-foundation)
   - [4.1 AgenC — ZK Proofs & Solana Infrastructure](#41-agenc--zk-proofs--solana-infrastructure)
   - [4.2 AgenX — Orchestrator Runtime](#42-agenx--orchestrator-runtime)
   - [4.3 AgenA — Tools & Skills](#43-agena--tools--skills)
   - [4.4 AgenB — LLM Providers & Memory](#44-agenb--llm-providers--memory)
   - [4.5 AgenD — Desktop Automation](#45-agend--desktop-automation)
   - [4.6 AgenE — Voice Interface](#46-agene--voice-interface)
   - [4.7 AgenF — Channel Plugins](#47-agenf--channel-plugins)
   - [4.8 AgenG — Protocol Operations](#48-ageng--protocol-operations)
   - [4.9 Standalone Apps](#49-standalone-apps)
5. [Interface Contracts](#5-interface-contracts)
6. [Plugin Architecture](#6-plugin-architecture)
7. [Config Ownership](#7-config-ownership)
8. [Shared Types Inventory & Governance](#8-shared-types-inventory--governance)
9. [Current Module → Cage Assignment](#9-current-module--cage-assignment)
10. [Cross-Cage Violation Register](#10-cross-cage-violation-register)
11. [Migration Plan](#11-migration-plan)
12. [Test Migration Strategy](#12-test-migration-strategy)
13. [Package Naming & Versioning](#13-package-naming--versioning)
14. [CI/CD Strategy](#14-cicd-strategy)
15. [Risks & Mitigations](#15-risks--mitigations)

---

## 1. Vision

AgenC has always been the on-chain coordination layer. Now the rest of the stack gets its own identity.

The full framework is organized into self-contained modules called **cages**. Separate repos, stable interfaces, install only what you need.

**AgenX** is the orchestrator — the headless runtime that plugs in every other module and coordinates autonomous execution. This is the thing that runs.

The modules it orchestrates:

| Cage | Brand | Package | Purpose |
|------|-------|---------|---------|
| — | — | `@agenc/common` | Shared types, utils, constants — the foundation |
| **AgenC** | AgenC | `@agenc/sdk` | ZK proofs & Solana infrastructure (unchanged) |
| **AgenX** | AgenX | `@agenc/runtime` | Orchestrator — gateway, daemon, ChatExecutor, autonomous loop |
| **AgenA** | AgenA | `@agenc/tools` | Tool registry & system tools + skill registry |
| **AgenB** | AgenB | `@agenc/llm` | LLM provider adapters + memory backends + MCP client |
| **AgenD** | AgenD | `@agenc/desktop` | Desktop automation sandbox |
| **AgenE** | AgenE | `@agenc/voice` | Voice STT/TTS/Realtime |
| **AgenF** | AgenF | `@agenc/channels` | Channel plugins (Telegram, Discord, Slack, ...) |
| **AgenG** | AgenG | `@agenc/protocol` | Protocol operations (agent, task, dispute, events, connection) |

The goal: `npm install @agenc/tools` and have it work standalone. Each cage has its own repo, its own versioning, its own surface area.

You build with what you need and nothing else.

### When NOT to Split

This refactor trades monorepo testing convenience for organizational independence and npm discoverability. Be honest about the costs:

- **Monorepo CI catches integration bugs immediately.** Multi-repo requires nightly cross-cage integration runs.
- **One `npm install` becomes 8 coordinated releases** when `@agenc/common` has a breaking change.
- **Tree-shaking already handles unused code** — bundle size gains are marginal at best.
- **Config splitting adds complexity** — users must understand which cage owns which config section.

**This split is worth it because:**
- Third-party developers can build on individual cages without the full stack
- Independent versioning lets leaf cages (voice, desktop) release without touching the orchestrator
- Clear cage boundaries force clean interfaces and prevent the "everything imports everything" problem
- Each cage gets focused CI, focused docs, focused ownership

**Do NOT proceed if:** the architecture hasn't stabilized (interfaces still changing weekly), or there are fewer than 3 developers actively working across different cages.

---

## 2. Cage Map

```
                         ┌──────────────────────────────────────────┐
                         │           AgenX (@agenc/runtime)          │
                         │  gateway/ daemon/ ChatExecutor(30 files)  │
                         │  autonomous/ workflow/ policy/ social/    │
                         │  marketplace/ team/ bridges/ replay/      │
                         │  telemetry/ observability/ eval/          │
                         │  createAgencTools() (bridge)              │
                         └──────────┬───────────────────────────────┘
                                    │
           ┌────────┬───────┬───────┼───────┬────────┬──────────┐
           │        │       │       │       │        │          │
           ▼        ▼       ▼       ▼       ▼        ▼          ▼
       ┌──────┐ ┌──────┐ ┌──────┐ ┌─────┐ ┌────────┐ ┌────────┐ ┌──────┐
       │AgenA │ │AgenB │ │AgenD │ │AgenE│ │ AgenF  │ │ AgenG  │ │AgenC │
       │@agenc│ │@agenc│ │@agenc│ │@agen│ │ @agenc │ │ @agenc │ │@agenc│
       │/tools│ │/llm  │ │/desk │ │/voic│ │/channe │ │/protoc │ │/sdk  │
       └──┬───┘ └──┬───┘ └──┬───┘ └──┬──┘ └───┬────┘ └───┬────┘ └──┬───┘
          │        │        │        │        │          │          │
          └────────┴────────┴────────┴────────┘          │          │
                            │                            │          │
                     ┌──────┴──────┐              ┌──────┴──────┐   │
                     │@agenc/common│              │  @agenc/sdk ◄───┘
                     │ types utils │              │ instructions│
                     │  constants  │              │  PDAs, ZK   │
                     └─────────────┘              └─────────────┘
```

**Key rules:**
- Arrows point downward only — no circular dependencies
- AgenX imports from all cages; **cages never import from AgenX**
- All cages import from `@agenc/common`
- Only AgenG and AgenC import from `@agenc/sdk` (Solana/Anchor deps)
- Leaf cages (AgenD, AgenE, AgenF) have minimal dependencies
- **AgenA and AgenG are independent** — protocol tools (`createAgencTools`) live in AgenX as bridge code

---

## 3. Dependency Graph

### Package-Level Dependencies

```
@agenc/common    → (zero external deps)
@agenc/sdk       → @coral-xyz/anchor, @solana/web3.js
@agenc/tools     → @agenc/common
@agenc/llm       → @agenc/common, openai?, @anthropic-ai/sdk?, ollama?, better-sqlite3?, ioredis?, ws?
@agenc/desktop   → @agenc/common
@agenc/voice     → @agenc/common, openai?, edge-tts?
@agenc/channels  → @agenc/common, grammy?, discord.js?, @slack/bolt?, ...
@agenc/protocol  → @agenc/common, @agenc/sdk, @coral-xyz/anchor, @solana/web3.js
@agenc/runtime   → @agenc/common, @agenc/sdk, @agenc/tools, @agenc/llm, @agenc/desktop,
                    @agenc/voice, @agenc/channels, @agenc/protocol
```

### Dependency Matrix

Reads as "row imports from column":

| Imports → | common | sdk | tools | llm | desktop | voice | channels | protocol | runtime |
|-----------|--------|-----|-------|-----|---------|-------|----------|----------|---------|
| **common** | — | | | | | | | | |
| **sdk** | | — | | | | | | | |
| **tools** | YES | | — | | | | | | |
| **llm** | YES | | | — | | | | | |
| **desktop** | YES | | | | — | | | | |
| **voice** | YES | | | | | — | | | |
| **channels** | YES | | | | | | — | | |
| **protocol** | YES | YES | | | | | | — | |
| **runtime** | YES | YES | YES | YES | YES | YES | YES | YES | — |

**Zero circular dependencies.** AgenA (tools) and AgenG (protocol) are fully independent. The bridge between them (`createAgencTools()`) lives in AgenX.

### Known Violations (Current Code) & Required Fixes

See [Section 10: Cross-Cage Violation Register](#10-cross-cage-violation-register) for the complete list of 10 import violations found during adversarial review, with file-level evidence and fix actions.

---

## 4. Cage Specifications

### 4.0 @agenc/common — Shared Foundation

**Package:** `@agenc/common`
**Repo:** `tetsuo-ai/agenc-common`
**Purpose:** Types, interfaces, constants, and pure utilities shared by all cages.

**What goes here:**

```
@agenc/common/
├── src/
│   ├── types/
│   │   ├── errors.ts           # 101 RuntimeErrorCodes + 26 error classes (Solana-free subset)
│   │   ├── llm.ts              # LLMMessage, LLMTool, LLMToolCall, LLMProvider, LLMResponse, LLMUsage
│   │   ├── tools.ts            # Tool, ToolResult, ToolHandler, ToolPolicyHook, JSONSchema, safeStringify
│   │   ├── memory.ts           # MemoryEntry, MemoryBackend, MemoryQuery, MemoryRole, MemoryRetriever
│   │   ├── message.ts          # GatewayMessage, OutboundMessage, MessageAttachment, MessageScope
│   │   ├── hooks.ts            # HookHandler, HookContext, HookResult
│   │   ├── media.ts            # TranscriptionProvider, SpeechToTextProvider, TextToSpeechProvider
│   │   ├── metrics.ts          # MetricsProvider (used by memory + task)
│   │   ├── skill-injector.ts   # SkillInjector interface (used by AgenA + AgenX)
│   │   └── plugin.ts           # CagePlugin, PluginContext interfaces
│   ├── utils/
│   │   ├── logger.ts           # Logger interface + createLogger + silentLogger
│   │   ├── encoding.ts         # hex/bytes, agent ID, lamports/sol, base64, toUint8Array
│   │   ├── async.ts            # sleep, toErrorMessage, SEVEN_DAYS_MS
│   │   ├── pda.ts              # PdaWithBump, derivePda, validateIdLength
│   │   ├── lazy-import.ts      # ensureLazyModule (generic lazy loading)
│   │   ├── validation.ts       # requireNonEmptyString, validationResult
│   │   ├── type-guards.ts      # isRecord, isStringArray
│   │   ├── numeric.ts          # clamp01, clampRatio, clampInteger
│   │   └── collections.ts      # groupBy
│   ├── constants/
│   │   ├── hooks.ts            # HOOK_PRIORITIES (exported for cage use)
│   │   ├── cron.ts             # CRON_SCHEDULES
│   │   └── defaults.ts         # SEMANTIC_MEMORY_DEFAULTS, DEFAULT_CHANNEL_SESSION_CONFIG
│   └── index.ts
├── package.json                # ZERO external dependencies
└── tsconfig.json
```

**Size estimate:** ~3,000 lines / ~60KB (measured from current source files)

#### Solana Dependency Resolution (v4 fix)

Three files originally proposed for @agenc/common import `@solana/web3.js`:
- `errors.ts` — `import type { PublicKey }` (type-only, used in error context)
- `wallet.ts` — `import { Keypair, PublicKey, Transaction, VersionedTransaction }` (value import)
- `protocol.ts` — `import { PublicKey }` (value import)

**Resolution:** `wallet.ts` and `protocol.ts` move to **AgenG** (`@agenc/protocol`), not @agenc/common. These types are Solana-specific and only consumed by AgenG and AgenX. `errors.ts` is split: the 101 `RuntimeErrorCodes` enum + 26 error classes stay in @agenc/common (Solana-free); the `PublicKey`-dependent error context types move to AgenG.

This preserves @agenc/common's zero-dependency guarantee.

#### Governance Rules

`@agenc/common` has strict admission criteria to prevent bloat:

1. **Types only** — interfaces, type aliases, enums, constants, pure functions. No classes with state. No I/O. No side effects.
2. **2-cage minimum with justification** — a type should be used by 2+ cages to qualify. If used by only 1 cage, it stays in that cage. Exception: contract interfaces between exactly 2 cages belong in common if they define a public API boundary (e.g., `ToolPolicyHook` is the contract between AgenA and AgenX even though only AgenA defines and AgenX implements).
3. **No external dependencies** — zero npm deps. If a utility needs an external package, it stays in the cage that owns that dep. Types that import `@solana/web3.js` belong in AgenG, not common.
4. **No cage-specific types** — `GatewayConfig` stays in AgenX. `ChatExecutorConfig` stays in AgenX. Only cross-cage contracts live here.
5. **200KB hard cap** — if `@agenc/common` exceeds 200KB, it's too big. Audit and move cage-specific types out.
6. **Breaking changes require coordinated release** — a semver major bump means all cages must update and pass CI before any cage publishes.

#### What Does NOT Go Here

| Type | Stays In | Reason |
|------|----------|--------|
| `GatewayConfig` (~70 fields) | AgenX | Only orchestrator needs full config |
| `ChatExecutorConfig` | AgenX | Orchestration detail |
| `PolicyEngine` class | AgenX | Stateful class, not an interface |
| `Wallet` / `SignMessageWallet` | AgenG | Imports `@solana/web3.js` (Keypair, PublicKey, Transaction) |
| `ProtocolConfig` / `parseProtocolConfig` | AgenG | Imports `@solana/web3.js` (PublicKey) |
| 57 event type interfaces | AgenG | Solana-specific event definitions |
| `DesktopSandboxConfig` | AgenD | Cage-specific config |
| Channel-specific configs | AgenF | Per-plugin detail |
| `BenchmarkManifest` | AgenX (dev) | Not shipped to users |
| `ProofEngineConfig` | AgenG | Protocol detail |
| Anchor IDL types | AgenG | Solana-specific |

#### Types Added in v3-v4 (from adversarial reviews)

These types were identified as missing by import tracing and DX validation:

| Type | Current Location | Used By | Why It Must Be in Common |
|------|-----------------|---------|--------------------------|
| `HookHandler`, `HookContext`, `HookResult` | `gateway/hooks.ts` | AgenB (ingestion), AgenX | Memory ingestion hooks need this interface |
| `TranscriptionProvider` | `gateway/media.ts` | AgenE, AgenX | Voice cage defines providers; gateway consumes |
| `MetricsProvider` | `task/types.ts` | AgenB (memory), AgenG (task) | Memory and task both provide metrics |
| `ToolPolicyHook` | (new interface) | AgenA, AgenX | Decouples ToolRegistry from PolicyEngine |
| `CagePlugin`, `PluginContext` | (new) | ALL | Cross-cage plugin contract |
| `SkillInjector` | `llm/chat-executor.ts` | AgenA (markdown/injector), AgenX | Decouples skill injection from ChatExecutor |
| `LLMTool` | `llm/types.ts` | AgenA (registry), AgenB | Tool registry needs LLM tool format |
| `HOOK_PRIORITIES` | `gateway/daemon.ts` | AgenF, AgenE, AgenX | Channels and voice need hook priority constants |
| `TELEMETRY_METRIC_NAMES` | `telemetry/metric-names.ts` | AgenB (memory backends), AgenX | Memory backends emit telemetry metrics |

---

### 4.1 AgenC — ZK Proofs & Solana Infrastructure

**Package:** `@agenc/sdk` (unchanged)
**Repo:** `tetsuo-ai/AgenC` (this repo, minus runtime)
**Purpose:** The on-chain coordination layer. Anchor program, TypeScript SDK, ZK VM, integration tests.

**What stays in this repo:**

```
AgenC/
├── programs/agenc-coordination/    # Anchor program (42 instructions)
│   ├── src/
│   │   ├── lib.rs                  # 42 instruction entrypoint
│   │   ├── state.rs                # 23 account structures
│   │   ├── errors.rs               # 176 error codes (6000-6175)
│   │   ├── events.rs               # 57 event types
│   │   └── instructions/           # 42 handlers + 9 helpers
│   └── fuzz/                       # 8 fuzz targets
├── sdk/                            # @agenc/sdk v1.3.0
│   └── src/                        # 100+ instruction wrappers, PDA helpers, ZK proof functions
├── zkvm/                           # RISC Zero zkVM
│   ├── guest/src/lib.rs            # Journal schema (192 bytes)
│   ├── methods/                    # ELF bridge (risc0-build)
│   └── host/src/                   # Prover (Groth16)
├── tests/                          # LiteSVM integration tests (~5s, ~140 tests)
├── scripts/                        # Build/deployment/upgrade scripts
├── migrations/                     # Protocol migration tools
├── security/                       # Audit documentation
├── Anchor.toml
└── Cargo.toml
```

**Why ZK VM stays here:**
- Guest ELF image ID is pinned on-chain in `complete_task_private.rs`
- Changes to guest require protocol upgrade + new image ID deployment
- Must be versioned atomically with program + SDK

**What leaves this repo:**
- `runtime/` → splits into AgenX + AgenA + AgenB + AgenD + AgenE + AgenF + AgenG
- `mcp/` → ships with AgenB
- `docs-mcp/` → standalone repo
- `web/`, `mobile/` → standalone repos
- `demo-app/` → ships with SDK docs
- `containers/` → AgenD

**To make SDK a published npm package:**
Change `"@agenc/sdk": "file:../sdk"` → `"@agenc/sdk": "^1.3.0"` in all consumers. No API changes needed.

---

### 4.2 AgenX — Orchestrator Runtime

**Package:** `@agenc/runtime`
**Repo:** `tetsuo-ai/agenc-runtime`
**Purpose:** The headless runtime that plugs in every cage and coordinates autonomous execution. This is the thing that runs. It is intentionally the largest cage because orchestration IS complexity.

**Why AgenX is fat (and that's correct):**

The orchestrator's job is to compose all cages into a working system. This means:
- Gateway daemon lifecycle (sessions, config, WebSocket, hooks)
- ChatExecutor (the core multi-turn tool-calling loop — it imports from gateway, workflow, and tools, making it an orchestration concern, not a pure LLM concern)
- Protocol tool bridge (`createAgencTools()` — bridges AgenA's tool system with AgenG's protocol operations, keeping them independent)
- Business logic that requires cross-cage coordination (marketplace bidding, team contracts, social collaboration, replay)
- Policy enforcement, telemetry, observability

These cannot be extracted without re-architecting how the daemon manages sessions and routes messages.

**AgenX is ~62% of runtime source lines (measured). This is acknowledged, not a bug.** The orchestrator is where cross-cage coordination lives. Attempting to split AgenX further (e.g., separating marketplace/social/team) would create coupling issues because these modules depend on TeamContractEngine, TaskOperations, and WorkflowOrchestrator which are orchestration concerns. If AgenX becomes unwieldy in practice (>150K lines), the correct response is to extract new leaf cages, not split the orchestrator.

**Source directories (from current `runtime/src/`, measured via `wc -l` source files only):**

| Directory | Purpose | Measured Lines |
|-----------|---------|---------------|
| `gateway/` | Daemon lifecycle, config watcher, WebSocket, sessions, workspace, hooks, routing, approvals, slash commands, sub-agents, scheduler, heartbeat, identity, personality, media, JWT, sandbox, remote, voice-bridge | 51,614 |
| `llm/chat-executor*.ts` (30 files: 17 source + 13 test) | ChatExecutor — multi-turn tool calling, compaction, planning, verification, recovery, delegation decision/learning, contract flow/guidance, planner-verifier loop, doom, routing state, explicit tools | 14,268 |
| `autonomous/` | AutonomousAgent loop, scanner, verifier, risk scoring, arbitration, escalation | 7,907 |
| `eval/` | Benchmarks, mutation testing, trajectory replay (dev tooling) | 11,501 |
| `cli/` + `bin/` | CLI commands + entry points | 7,398 |
| `workflow/` | DAG orchestrator, goal compiler, optimizer, canary rollout, pipeline executor | 5,012 |
| `policy/` | PolicyEngine, RBAC, budgets, circuit breakers, audit trail, tool governance | 4,691 |
| `social/` | Agent discovery, messaging, feed, reputation scoring, collaboration | 4,127 |
| `replay/` | Event timeline store, backfill, alerting, trace | 2,978 |
| `marketplace/` | TaskBidMarketplace, ServiceMarketplace, bid strategies, scoring | 2,267 |
| `team/` | TeamContractEngine, workflow adapter, payouts, audit | 2,221 |
| `observability/` | Tracing, instrumentation | 1,157 |
| `builder.ts` + `runtime.ts` | AgentBuilder + AgentRuntime lifecycle | 1,299 |
| `tools/agenc/` | `createAgencTools()` — 4 built-in protocol tools (bridge code) | 1,198 |
| `tools/social/` | Social tool wrappers (AgentDiscovery, Messaging, Feed, Collaboration) | 1,200 |
| `tools/marketplace/` | Marketplace tool wrappers (ServiceMarketplace) | 500 |
| `bridges/` | LangChain, X402, Farcaster integrations | 638 |
| `telemetry/` | UnifiedTelemetryCollector, sinks, metric names | 575 |
| **Total** | | **~120,600** |

**Why these modules MUST stay in AgenX** (verified by import audit):
- **marketplace** — ServiceMarketplace manages bid lifecycle; `tools/marketplace/` imports `ServiceMarketplace` directly (V14)
- **social** — CollaborationProtocol depends on TeamContractEngine + TaskOperations; `tools/social/` imports 5 social modules directly (V13); messaging shares session state
- **team** — TeamWorkflowAdapter binds to WorkflowOrchestrator; checkpoints are part of DAG execution
- **replay** — backfill service integrates with production monitoring and daemon event subscriptions
- **bridges** — not wired into daemon yet but will need ToolRegistry and event loop integration
- **tools/social/** — imports AgentDiscovery, AgentMessaging, AgentFeed, CollaborationProtocol from `social/` (V13). Must colocate with social module in AgenX.
- **tools/marketplace/** — imports ServiceMarketplace from `marketplace/` (V14). Must colocate with marketplace in AgenX.
- **ChatExecutor** — 30 files (17 source + 13 test) importing from `gateway/` (delegation-scope, delegation-timeout, message), `workflow/` (pipeline), and `tools/` (types). It IS orchestration.
- **createAgencTools()** — bridges AgenA (Tool interface) with AgenG (TaskOperations, AgentManager). Moving it here keeps AgenA and AgenG independent.

**Note on coupling evidence (v4 honest assessment):** marketplace/, social/, and team/ do NOT have direct `import` statements from `gateway/daemon.ts`. Their coupling is architectural: they depend on modules (TeamContractEngine, WorkflowOrchestrator, TaskOperations) that are wired together by the daemon. Extracting them would require either duplicating the wiring logic or creating new cross-cage interfaces for every internal coordination point.

**Public API Surface (tiered):**

```typescript
// Tier 1: Core Runtime (what most users import)
export { AgentRuntime, AgentBuilder } from './runtime.js';
export { AgentDaemon } from './gateway/daemon.js';

// Tier 2: Advanced (power users / custom integrations)
export { ChatExecutor } from './llm/chat-executor.js';
export { AutonomousAgent } from './autonomous/agent.js';
export { WorkflowOrchestrator } from './workflow/orchestrator.js';
export { PolicyEngine } from './policy/engine.js';

// Tier 3: Internal (re-exported for backward compat, not for direct use)
export * from '@agenc/tools';
export * from '@agenc/llm';
export * from '@agenc/protocol';
// ... re-exports during migration period
```

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0",
  "@agenc/sdk": "^1.3.0",
  "@agenc/tools": "^1.0.0",
  "@agenc/llm": "^1.0.0",
  "@agenc/desktop": "^1.0.0",
  "@agenc/voice": "^1.0.0",
  "@agenc/channels": "^1.0.0",
  "@agenc/protocol": "^1.0.0"
}
```

---

### 4.3 AgenA — Tools & Skills

**Package:** `@agenc/tools`
**Repo:** `tetsuo-ai/agenc-tools`
**Purpose:** Tool registry, system tools, skill registry, skill adapter, bundled skills, monetization. Pure capabilities layer — no protocol-specific logic.

**Source directories (from current `runtime/src/`, measured via `wc -l`):**

| Directory | Purpose | Measured Lines |
|-----------|---------|---------------|
| `tools/` (minus `agenc/`, `social/`, `marketplace/`) | ToolRegistry, skill adapter, system tools (bash, HTTP, filesystem, browser, macos, etc.) | 15,310 |
| `skills/` (minus protocol-dependent code) | SkillRegistry, Jupiter DEX, markdown SKILL.md parser, bundled skills, catalog | 5,776 |
| **Total** | | **~21,086** |

**What moved OUT of AgenA:**
- `tools/agenc/` (`createAgencTools()`) → AgenX. These 4 built-in protocol tools import from `agent/`, `task/`, `types/protocol` which are AgenG modules.
- `tools/social/` → AgenX. Imports 5 classes from `social/` module (AgentDiscovery, AgentMessaging, AgentFeed, CollaborationProtocol, SocialPeerDirectoryEntry). Must colocate with social module. (V13)
- `tools/marketplace/` → AgenX. Imports `ServiceMarketplace` from `marketplace/`. Must colocate with marketplace module. (V14)
- Protocol-dependent skill code (JupiterSkill protocol calls, monetization payments importing `findAgentPda`) → AgenX bridge. (V9, V10, V18)

**PolicyEngine Decoupling (v3 fix):**

ToolRegistry currently imports `PolicyEngine` from `policy/engine.ts` (AgenX), creating an AgenA→AgenX reverse dependency. This is fixed by:

1. Defining `ToolPolicyHook` interface in `@agenc/common`:
   ```typescript
   // @agenc/common/types/tools.ts
   interface ToolPolicyHook {
     evaluate(toolName: string, args: Record<string, unknown>): Promise<PolicyResult>;
   }
   interface PolicyResult {
     allowed: boolean;
     reason?: string;
   }
   ```

2. ToolRegistry accepts an optional `policyHook` in its constructor:
   ```typescript
   // @agenc/tools — ToolRegistry constructor
   constructor(opts: { logger: Logger; policyHook?: ToolPolicyHook }) { ... }
   ```

3. AgenX injects PolicyEngine (which implements `ToolPolicyHook`) during daemon wiring:
   ```typescript
   // @agenc/runtime — daemon startup
   const policyEngine = new PolicyEngine(config);
   const registry = new ToolRegistry({ logger, policyHook: policyEngine });
   ```

This removes the only AgenA→AgenX import. AgenA depends only on `@agenc/common`.

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0"
}
```

**Optional dependencies:** `cheerio`, `playwright` (for browser tools)

**Key exports:**
- `ToolRegistry` — register, discover, execute tools
- System tool factories: `createBashTool()`, `createHttpTool()`, `createFilesystemTool()`, etc.
- `SkillRegistry` — skill discovery, loading, execution
- `skillToTools()` — adapter converting skills to LLM-callable tools
- `JupiterSkill` — DEX integration
- Bundled SKILL.md files

**Standalone usage:**
```typescript
import { ToolRegistry, createBashTool, createHttpTool } from '@agenc/tools';

const registry = new ToolRegistry({ logger });
registry.register(createBashTool({ logger }));
registry.register(createHttpTool({ logger }));

const tools = registry.toLLMTools();  // → LLMTool[] for any provider

// With optional policy enforcement:
import type { ToolPolicyHook } from '@agenc/common';
const registry = new ToolRegistry({ logger, policyHook: myPolicyHook });
```

---

### 4.4 AgenB — LLM Providers & Memory

**Package:** `@agenc/llm`
**Repo:** `tetsuo-ai/agenc-llm`
**Purpose:** LLM provider adapters, memory backends, embeddings, semantic retrieval, MCP client bridging. Pure provider/backend layer — no orchestration logic.

**Source directories (from current `runtime/src/`, measured via `wc -l`):**

| Directory | Purpose | Measured Lines |
|-----------|---------|---------------|
| `llm/` (minus chat-executor*, delegation-*) | Grok, Anthropic, Ollama adapters, FallbackProvider, prompt-budget, timeout, response-converter, policy, tool-turn-validator, provider-trace-logger, provider-capabilities, lazy-import | 6,312 |
| `memory/` | InMemory, SQLite, Redis backends, embeddings (Ollama/OpenAI/Noop), vector store, ingestion, retriever, graph, structured, encryption | 4,728 |
| `mcp-client/` | MCP server connection, tool bridge, ResilientMCPBridge, manager | 658 |
| **Total** | | **~11,698** |

**What moved OUT of AgenB:**
- **ChatExecutor** (30 files: 17 source + 13 test, ~14,268 lines total) → AgenX. ChatExecutor imports from `gateway/` (delegation-scope, delegation-timeout, message), `workflow/` (pipeline, types), and `tools/` (types). This is orchestration logic, not a pure LLM concern. AgenB provides the raw `LLMProvider.chat()` calls; AgenX composes them into the ChatExecutor loop.
- **Voice** → AgenE. Different optional deps, distinct concern.

**Import violations fixed (v3-v4):**

| File | Current Import | Fix |
|------|---------------|-----|
| `llm/provider-native-search.ts` | `GatewayLLMConfig` from `gateway/types.ts` | Extract `LLMProviderConfig` to `@agenc/common/types/llm.ts` |
| `llm/provider-native-search.ts` | `normalizeGrokModel` from `gateway/context-window.ts` | Move `normalizeGrokModel()` to AgenB (it's provider logic, not gateway logic) |
| `memory/ingestion.ts` | `HookHandler, HookContext` from `gateway/hooks.ts` | `HookHandler`/`HookContext` → `@agenc/common/types/hooks.ts` |
| `memory/ingestion.ts` | `createProviderTraceEventLogger` from `llm/provider-trace-logger.ts` | Already within AgenB (llm/ → llm/). No fix needed. |
| `memory/types.ts` | `MetricsProvider` from `task/types.ts` | `MetricsProvider` → `@agenc/common/types/metrics.ts` |
| `memory/retriever.ts` | `MemoryRetriever` from `llm/chat-executor.ts` | `MemoryRetriever` → `@agenc/common/types/memory.ts` (V20b) |
| `memory/{sqlite,redis,in-memory}/backend.ts` | `TELEMETRY_METRIC_NAMES` from `telemetry/metric-names.ts` | `TELEMETRY_METRIC_NAMES` → `@agenc/common/constants/` (V20c) |
| `mcp-client/tool-bridge.ts` | `MCPToolCatalogPolicyConfig` from `policy/mcp-governance.ts` | Extract `MCPToolCatalogPolicyConfig` type to `@agenc/common/types/tools.ts` (V19) |

After these fixes, AgenB imports only from `@agenc/common`. Zero coupling to AgenX or AgenG.

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0"
}
```

**Optional dependencies:** `openai`, `@anthropic-ai/sdk`, `ollama`, `better-sqlite3`, `ioredis`, `@modelcontextprotocol/sdk`, `ws`

**Also ships:** `@agenc/mcp` (the MCP server package) — depends on `@agenc/sdk` + `@agenc/llm` + `@agenc/protocol`

**Key exports:**
- `GrokProvider`, `AnthropicProvider`, `OllamaProvider` — LLM adapters
- `FallbackLLMProvider` — automatic failover across providers
- `InMemoryBackend`, `SqliteBackend`, `RedisBackend` — memory backends
- `createEmbeddingProvider()` — auto-selects Ollama/OpenAI/Noop
- `InMemoryVectorStore` — cosine + BM25 hybrid search
- `MemoryIngestionEngine` — embeds conversation turns
- `SemanticMemoryRetriever` — hybrid search + recency re-ranking
- `MCPManager` — manage external MCP server connections
- `ResilientMCPBridge` — auto-reconnecting MCP bridge

**Standalone usage:**
```typescript
import { GrokProvider, InMemoryBackend } from '@agenc/llm';

const llm = new GrokProvider({ apiKey, model: 'grok-3' });
const response = await llm.chat({
  messages: [{ role: 'user', content: 'Hello' }],
});

const memory = new InMemoryBackend();
await memory.addEntry({ sessionId: 's1', role: 'user', content: 'Hello' });
```

**Note:** ChatExecutor is NOT available from `@agenc/llm`. It lives in `@agenc/runtime` because it orchestrates tools, memory, planning, and verification. If you want raw LLM access, use `@agenc/llm` providers directly.

---

### 4.5 AgenD — Desktop Automation

**Package:** `@agenc/desktop`
**Repo:** `tetsuo-ai/agenc-desktop`
**Purpose:** Desktop sandbox lifecycle, Docker container management, session routing, REST bridge, tool definitions.

**Components:**

| Component | Source | Measured Lines |
|-----------|--------|---------------|
| Runtime module | `runtime/src/desktop/` — DesktopSandboxManager, pool, health, REST bridge, session router, watchdog | 3,616 |
| Container image | `containers/desktop/` — Dockerfile, REST server (16 tools), supervisord, seccomp, XFCE config | ~2,000 |
| **Total** | | **~5,616** |

**Import violation fixed (v3):**

| File | Current Import | Fix |
|------|---------------|-----|
| `desktop/session-router.ts` | `ToolHandler` from `llm/types.ts` | `ToolHandler` → `@agenc/common/types/tools.ts` (already planned) |

After fix, AgenD imports only from `@agenc/common`.

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0"
}
```

Container image has zero npm cage dependencies — the REST server is self-contained.

**Standalone usage:**
```typescript
import { DesktopSandboxManager } from '@agenc/desktop';

const manager = new DesktopSandboxManager({ image: 'agenc/desktop:latest', logger });
await manager.start();
const session = await manager.createSession();
const screenshot = await session.execute('screenshot', {});
```

---

### 4.6 AgenE — Voice Interface

**Package:** `@agenc/voice`
**Repo:** `tetsuo-ai/agenc-voice`
**Purpose:** Speech-to-text, text-to-speech, realtime voice API.

**Source:** `runtime/src/voice/` (1,554 lines measured)

| Provider | Type | Backend |
|----------|------|---------|
| `WhisperAPIProvider` | STT | OpenAI Whisper API |
| `ElevenLabsProvider` | TTS | ElevenLabs API |
| `OpenAITTSProvider` | TTS | OpenAI TTS API |
| `EdgeTTSProvider` | TTS | Microsoft Edge TTS (free) |
| `XaiRealtimeClient` | Realtime | xAI Realtime voice API |

**Import violation fixed (v3):**

| File | Current Import | Fix |
|------|---------------|-----|
| `voice/stt.ts` | `TranscriptionProvider` from `gateway/media.ts` | `TranscriptionProvider` → `@agenc/common/types/media.ts` |

After fix, AgenE imports only from `@agenc/common`.

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0"
}
```

**Optional dependencies:** `openai`, `edge-tts`

**Why its own cage (not folded into AgenB):**
- Distinct optional deps (edge-tts is never needed by LLM users)
- Clear boundary: audio I/O is not text model context
- Respects "install only what you need" — `npm install @agenc/llm` shouldn't pull voice deps
- Small but self-contained with a stable interface

**Standalone usage:**
```typescript
import { WhisperAPIProvider, EdgeTTSProvider } from '@agenc/voice';

const stt = new WhisperAPIProvider({ apiKey });
const tts = new EdgeTTSProvider();
const text = await stt.transcribe(audioBuffer);
const audio = await tts.synthesize(text);
```

---

### 4.7 AgenF — Channel Plugins

**Package:** `@agenc/channels`
**Repo:** `tetsuo-ai/agenc-channels`
**Purpose:** 8 chat channel plugins for external communication.

**Source:** `runtime/src/channels/` (~7,204 lines across 8 plugins)

| Plugin | Backend | Optional Dep |
|--------|---------|-------------|
| `TelegramChannel` | grammy | `grammy` |
| `DiscordChannel` | discord.js | `discord.js` |
| `WebChatChannel` | Built-in WebSocket | — |
| `SlackChannel` | @slack/bolt | `@slack/bolt` |
| `WhatsAppChannel` | Baileys | `@whiskeysockets/baileys` |
| `SignalChannel` | signal-cli bridge | — |
| `MatrixChannel` | matrix-js-sdk | `matrix-js-sdk` |
| `IMessageChannel` | AppleScript (macOS) | — |

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0"
}
```

All channel-specific deps are optional/lazy-loaded. Install only the channels you need.

**Key dependency:** Channels need `GatewayMessage` and `OutboundMessage` for their `onMessage`/`send` signatures. These move to `@agenc/common/types/message.ts` in Phase 0.

**Standalone usage:**
```typescript
import { TelegramChannel } from '@agenc/channels';

const telegram = new TelegramChannel({ botToken, logger });
telegram.onMessage((msg) => { /* handle */ });
await telegram.start();
```

---

### 4.8 AgenG — Protocol Operations

**Package:** `@agenc/protocol`
**Repo:** `tetsuo-ai/agenc-protocol`
**Purpose:** Runtime wrappers for on-chain protocol operations — agent management, task execution, dispute resolution, event monitoring, governance, reputation, proof engine, RPC connection management.

**Source directories (from current `runtime/src/`, measured via `wc -l`):**

| Directory | Purpose | Measured Lines |
|-----------|---------|---------------|
| `task/` | TaskOperations, discovery, proof pipeline, DLQ, checkpoints, priority queue, dependency graph | 11,065 |
| `events/` | EventMonitor, 57 event types, subscriptions, IDL drift checks | 3,504 |
| `agent/` | AgentManager, capabilities, PDA derivation, event subscriptions | 2,842 |
| `dispute/` | DisputeOperations (6 instructions), PDA helpers | 1,344 |
| `connection/` | ConnectionManager (RPC retry, failover, coalescing) | 921 |
| `governance/` | GovernanceOperations (5 instructions), PDA helpers | 802 |
| `reputation/` | ReputationEconomyOperations (staking, delegation, portability) | 800 |
| `proof/` | ProofEngine with cache (TTL + LRU), RISC Zero integration | 722 |
| `idl.ts` | IDL loading + Program factory | 162 |
| **Total** | | **~22,162** |

**Why one cage (not split into 8 micro-packages):**
- All share the same heavy peer deps (@coral-xyz/anchor, @solana/web3.js, @solana/spl-token)
- All work with the same Anchor `Program<AgencCoordination>` instance
- Connection is infrastructure for all operations
- Events spans all domains
- Tree-shaking handles unused code in the bundle
- 8 micro-packages with identical peer deps = unnecessary maintenance

**Dependencies:**
```json
{
  "@agenc/common": "^1.0.0",
  "@agenc/sdk": "^1.3.0"
}
```

**Peer dependencies:** `@coral-xyz/anchor >=0.29.0`, `@solana/web3.js >=1.90.0`, `@solana/spl-token >=0.4.0`

**Standalone usage:**
```typescript
import { AgentManager, TaskOperations, ConnectionManager, createProgram } from '@agenc/protocol';

const conn = new ConnectionManager([rpcUrl], { logger });
const program = createProgram(provider);
const agentMgr = new AgentManager({ program, wallet, logger });
const taskOps = new TaskOperations({ program, wallet, logger });

await agentMgr.register({ capabilities: 3n, stake: 1_000_000_000n });
const tasks = await taskOps.fetchClaimableTasks();
```

---

### 4.9 Standalone Apps

These are fully independent and connect to the orchestrator via WebSocket. No cage dependencies.

| App | Current Location | Repo | Notes |
|-----|-----------------|------|-------|
| **Web UI** | `web/` | `tetsuo-ai/agenc-web` | React 19 + Vite + Tailwind. Connects via `ws://localhost:3100`. Zero SDK/runtime imports. |
| **Mobile** | `mobile/` | `tetsuo-ai/agenc-mobile` | Expo React Native. Connects via gateway URL. Zero SDK/runtime imports. |
| **Demo App** | `demo-app/` | Ships with SDK docs | Educational example |
| **Docs MCP** | `docs-mcp/` | `tetsuo-ai/agenc-docs-mcp` | Zero deps on SDK/runtime. Ready to split today. |

---

## 5. Interface Contracts

Each cage exposes a stable public API. Cross-cage communication happens only through interfaces defined in `@agenc/common`.

### Core Interfaces

```typescript
// ─── Tool Interface (AgenA defines, AgenX/AgenB consume) ───
interface Tool {
  readonly name: string;           // namespaced: "system.bash", "jupiter.getQuote"
  readonly description: string;
  readonly inputSchema: JSONSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: string;                 // JSON or plain text
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

// ─── Tool Policy Interface (AgenA accepts, AgenX implements) ───
interface ToolPolicyHook {
  evaluate(toolName: string, args: Record<string, unknown>): Promise<PolicyResult>;
}

interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

// ─── LLM Interface (AgenB defines, AgenX consumes) ───
interface LLMProvider {
  chat(options: LLMChatOptions): Promise<LLMResponse>;
}

// ─── Memory Interface (AgenB defines, AgenX consumes) ───
interface MemoryBackend {
  addEntry(options: AddEntryOptions): Promise<MemoryEntry>;
  getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]>;
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  close(): Promise<void>;
}

interface MemoryRetriever {
  retrieve(message: string, sessionId: string): Promise<string>;
}

// ─── Channel Interface (AgenF defines, AgenX consumes) ───
interface ChannelPlugin {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: GatewayMessage) => Promise<void>): void;
  send(msg: OutboundMessage): Promise<void>;
}

// ─── Voice Interface (AgenE defines, AgenX consumes) ───
interface SpeechToTextProvider {
  transcribe(audio: Buffer, options?: STTOptions): Promise<string>;
}

interface TextToSpeechProvider {
  synthesize(text: string, options?: TTSOptions): Promise<Buffer>;
}

// ─── Desktop Interface (AgenD defines, AgenX consumes) ───
interface DesktopSession {
  execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
  destroy(): Promise<void>;
}

// ─── Hook Interface (common — used by AgenB ingestion, AgenX daemon) ───
interface HookHandler {
  name: string;
  priority: number;
  handle(ctx: HookContext): Promise<HookResult>;
}

// ─── Plugin Interface (common — used by all cages) ───
interface CagePlugin {
  readonly name: string;
  readonly version: string;
  register(ctx: PluginContext): Promise<void>;
  shutdown?(): Promise<void>;
}

interface PluginContext {
  toolRegistry: { register(tool: Tool): void };
  hookDispatcher: { register(hook: string, handler: HookHandler): void };
  config: Record<string, unknown>;
  logger: Logger;
}

// ─── Logger (shared infrastructure, used everywhere) ───
interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, error?: Error | string, data?: Record<string, unknown>): void;
  child(name: string): Logger;
}
```

### Cross-Cage Data Flow

```
User Input
    │
    ▼
AgenX (gateway) ──► AgenF (channel plugin receives message)
    │
    ├──► AgenB (LLM provider: raw model call)
    │       ↕
    │   AgenX (ChatExecutor: orchestrates tool calling loop)
    │       │
    │       ├──► AgenA (tool execution via ToolHandler)
    │       │       │
    │       │       └── AgenX creates protocol tools bridging to:
    │       │               └──► AgenG (on-chain operations)
    │       │
    │       ├──► AgenD (desktop tool execution)
    │       │
    │       └──► AgenB (memory retrieval + embedding)
    │
    ├──► AgenE (voice STT/TTS if voice session)
    │
    └──► AgenF (send response back through channel)
```

---

## 6. Plugin Architecture

### Current State

The daemon uses static imports and direct wiring in `gateway/daemon.ts`. All cages are imported at build time.

### Target State

Each cage exports a registration function. AgenX composes them during startup:

```typescript
// Each cage exports a plugin factory:
// @agenc/tools
export function createToolsPlugin(config: ToolsConfig): CagePlugin;

// @agenc/llm
export function createLLMPlugin(config: LLMConfig): CagePlugin;

// @agenc/desktop
export function createDesktopPlugin(config: DesktopConfig): CagePlugin;

// Plugin contract (defined in @agenc/common):
interface CagePlugin {
  readonly name: string;
  readonly version: string;
  register(ctx: PluginContext): Promise<void>;
  shutdown?(): Promise<void>;
}

interface PluginContext {
  toolRegistry: { register(tool: Tool): void };
  hookDispatcher: { register(hook: string, handler: HookHandler): void };
  config: Record<string, unknown>;
  logger: Logger;
}
```

**AgenX wiring (daemon startup):**
```typescript
const daemon = new AgentDaemon({
  plugins: [
    createToolsPlugin({ logger }),
    createLLMPlugin({ provider: 'grok', apiKey, model: 'grok-3' }),
    createDesktopPlugin({ image: 'agenc/desktop:latest' }),
    createVoicePlugin({ stt: 'whisper', tts: 'elevenlabs' }),
    createChannelsPlugin({ telegram: { botToken }, discord: { token } }),
    createProtocolPlugin({ connection, wallet }),
  ],
});
```

**Why this matters:**
- Cages can be added/removed without modifying daemon code
- Third-party cages can plug in via the same interface
- Dynamic loading becomes possible (lazy `import()` on first use)
- Testing: mock individual cages without the full stack

**Migration path:** `CagePlugin` interface is defined in `@agenc/common` during Phase 0. Cages adopt it progressively during Phase 1-3. Full dynamic loading available in Phase 4.

---

## 7. Config Ownership

### Current Problem

`GatewayConfig` in `gateway/types.ts` has 100+ fields spanning every cage. There's no way to know which cage owns which config section.

### Solution: Phased Config Splitting

**Phase 0-3 (monorepo workspace):** Keep `GatewayConfig` monolithic in AgenX. Each cage receives its config section as a constructor argument, but the canonical type stays in AgenX. This avoids premature config coupling across packages.

**Phase 4 (separate repos):** Each cage exports its own config type. AgenX composes them.

```typescript
// @agenc/tools — owns its config
export interface ToolsConfig {
  systemTools?: { bash?: BashToolConfig; http?: HttpToolConfig; /* ... */ };
  skills?: { enabled?: boolean; bundledSkillsDir?: string; /* ... */ };
}

// @agenc/llm — owns its config
export interface LLMConfig {
  provider: 'grok' | 'anthropic' | 'ollama';
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  contextWindowTokens?: number;
  // ... provider-specific config
}

export interface MemoryConfig {
  backend?: 'in-memory' | 'sqlite' | 'redis';
  embeddingProvider?: 'ollama' | 'openai' | 'noop';
  // ... backend-specific config
}

// @agenc/desktop — owns its config
export interface DesktopConfig {
  enabled?: boolean;
  image?: string;
  port?: number;
  poolSize?: number;
}

// @agenc/voice — owns its config
export interface VoiceConfig {
  stt?: { provider: 'whisper'; apiKey?: string };
  tts?: { provider: 'elevenlabs' | 'openai' | 'edge'; apiKey?: string; voiceId?: string };
}

// @agenc/channels — owns its config
export interface ChannelsConfig {
  telegram?: { botToken: string; /* ... */ };
  discord?: { token: string; /* ... */ };
  // ... per-channel
}

// @agenc/runtime (AgenX) — composes all configs
export interface GatewayConfig {
  llm: LLMConfig;                    // from @agenc/llm
  memory?: MemoryConfig;             // from @agenc/llm
  tools?: ToolsConfig;               // from @agenc/tools
  desktop?: DesktopConfig;           // from @agenc/desktop
  voice?: VoiceConfig;               // from @agenc/voice
  channels?: ChannelsConfig;         // from @agenc/channels
  // AgenX's own sections:
  approvals?: ApprovalsConfig;
  policy?: PolicyConfig;
  hooks?: HookConfig;
  scheduler?: SchedulerConfig;
}
```

**Config fields that span cages (honest assessment):**
- `toolBudgetPerRequest` — in LLMConfig but affects ToolRegistry behavior. Resolution: AgenX reads it from LLMConfig and passes it to ToolRegistry via PluginContext at startup.
- `toolRouting.mandatoryTools` — same pattern. AgenX mediates.
- `enableTracing` — global flag. Goes in AgenX's own config section; each cage receives `logger` with tracing already configured.

**Rule:** A cage's config type is exported from that cage's package. AgenX imports and composes them. The `~/.agenc/config.json` file structure mirrors this composition. Config fields that span cages are resolved by AgenX at startup, not by cages importing each other's config types.

---

## 8. Shared Types Inventory & Governance

### Types in @agenc/common

| Type | Current Location | Used By Cages | Priority | Notes (v4) |
|------|-----------------|---------------|----------|------------|
| `RuntimeErrorCodes` (101) + 26 error classes | `types/errors.ts` | ALL | CRITICAL | Solana-free subset only; PublicKey-dependent error context → AgenG |
| `Logger` interface + `createLogger` | `utils/logger.ts` | ALL (259 imports) | CRITICAL | |
| `Tool` / `ToolResult` / `ToolHandler` / `LLMTool` | `tools/types.ts`, `llm/types.ts` | A, B, D, E, X | CRITICAL | `LLMTool` added in v4 (V11) |
| `ToolPolicyHook` / `PolicyResult` | (new interface) | A, X | CRITICAL | |
| `LLMMessage` / `LLMProvider` / `LLMResponse` | `llm/types.ts` | B, X | CRITICAL | |
| `safeStringify` | `tools/types.ts` | ALL | CRITICAL | |
| `MemoryBackend` / `MemoryEntry` / `MemoryRetriever` | `memory/types.ts`, `llm/chat-executor.ts` | B, X | HIGH | `MemoryRetriever` added in v4 (V20) |
| `SkillInjector` | `llm/chat-executor.ts` | A, X | HIGH | Added in v4 (V17) |
| `GatewayMessage` / `OutboundMessage` | `gateway/message.ts` | F, E, X | HIGH | |
| `HookHandler` / `HookContext` / `HookResult` | `gateway/hooks.ts` | B, X | HIGH | |
| `TranscriptionProvider` | `gateway/media.ts` | E, X | HIGH | |
| `MetricsProvider` | `task/types.ts` | B, G | HIGH | |
| `MCPToolCatalogPolicyConfig` | `policy/mcp-governance.ts` | B, X | HIGH | Added in v4 (V19) |
| `CagePlugin` / `PluginContext` | (new) | ALL | HIGH | |
| encoding utils (hex, bytes, agent ID, base64) | `utils/encoding.ts` | G, C, X | HIGH | |
| `toUint8Array` | `utils/encoding.ts` | G, B, X | HIGH | |
| `HOOK_PRIORITIES` | `gateway/daemon.ts` | F, E, X | HIGH | |
| `TELEMETRY_METRIC_NAMES` | `telemetry/metric-names.ts` | B, X | HIGH | Added in v4 (V21) |
| `ensureLazyModule` | `utils/lazy-import.ts` | B, A, X | MEDIUM | |
| PDA utils | `utils/pda.ts` | G, X | MEDIUM | |
| async utils (sleep, toErrorMessage) | `utils/async.ts` | A, B, X | MEDIUM | |
| numeric utils | `utils/numeric.ts` | B, X | LOW | |
| type guards | `utils/type-guards.ts` | B, X | LOW | |

**Moved to AgenG (NOT in @agenc/common):** `Wallet`, `SignMessageWallet`, `ProtocolConfig`, `parseProtocolConfig`, 57 event type interfaces — all import `@solana/web3.js`.

---

## 9. Current Module → Cage Assignment

### Directory-Level Assignment

| Current Directory | Target Cage | Package | Justification |
|-------------------|-------------|---------|---------------|
| `gateway/` | AgenX | `@agenc/runtime` | Orchestrator core — wires everything |
| `llm/chat-executor*.ts` + `delegation-*.ts` (30 files) | AgenX | `@agenc/runtime` | Imports gateway, workflow, tools — orchestration logic |
| `autonomous/` | AgenX | `@agenc/runtime` | Autonomous execution loop |
| `workflow/` | AgenX | `@agenc/runtime` | DAG orchestrator, pipeline executor |
| `policy/` | AgenX | `@agenc/runtime` | Policy enforcement (tool:before hooks) |
| `cli/` + `bin/` | AgenX | `@agenc/runtime` | CLI commands + entry points |
| `marketplace/` | AgenX | `@agenc/runtime` | Session-scoped bid book, daemon lifecycle coupling |
| `social/` | AgenX | `@agenc/runtime` | CollaborationProtocol → TeamContractEngine coupling |
| `team/` | AgenX | `@agenc/runtime` | TeamWorkflowAdapter → WorkflowOrchestrator binding |
| `bridges/` | AgenX | `@agenc/runtime` | Not wired yet; will need ToolRegistry + event loop |
| `replay/` | AgenX | `@agenc/runtime` | Backfill needs daemon lifecycle hooks |
| `telemetry/` | AgenX | `@agenc/runtime` | Metrics collection (observer pattern) |
| `observability/` | AgenX | `@agenc/runtime` | Tracing, instrumentation |
| `eval/` | AgenX (dev) | `@agenc/runtime` | Benchmarks, mutation testing — devDependencies |
| `builder.ts` + `runtime.ts` | AgenX | `@agenc/runtime` | AgentBuilder + AgentRuntime lifecycle |
| `tools/agenc/` | AgenX | `@agenc/runtime` | Bridge: createAgencTools() links AgenA↔AgenG |
| `tools/` (minus agenc/, social/, marketplace/) | AgenA | `@agenc/tools` | ToolRegistry + system tools |
| `tools/social/` | AgenX | `@agenc/runtime` | Imports 5 social module classes (V13) |
| `tools/marketplace/` | AgenX | `@agenc/runtime` | Imports ServiceMarketplace (V14) |
| `skills/` | AgenA | `@agenc/tools` | SkillRegistry + Jupiter + monetization |
| `llm/` (providers) | AgenB | `@agenc/llm` | Grok, Anthropic, Ollama adapters, FallbackProvider |
| `memory/` | AgenB | `@agenc/llm` | Memory backends + embeddings + retriever |
| `mcp-client/` | AgenB | `@agenc/llm` | MCP server bridge, ResilientMCPBridge |
| `desktop/` | AgenD | `@agenc/desktop` | Desktop sandbox manager |
| `voice/` | AgenE | `@agenc/voice` | STT/TTS/Realtime providers |
| `channels/` | AgenF | `@agenc/channels` | 8 channel plugins |
| `agent/` | AgenG | `@agenc/protocol` | AgentManager, capabilities, PDA |
| `task/` | AgenG | `@agenc/protocol` | TaskOperations, discovery, proofs |
| `proof/` | AgenG | `@agenc/protocol` | ProofEngine with cache |
| `dispute/` | AgenG | `@agenc/protocol` | DisputeOperations |
| `governance/` | AgenG | `@agenc/protocol` | GovernanceOperations |
| `events/` | AgenG | `@agenc/protocol` | EventMonitor, 57 event types |
| `connection/` | AgenG | `@agenc/protocol` | ConnectionManager (RPC) |
| `reputation/` | AgenG | `@agenc/protocol` | ReputationEconomyOperations |
| `idl.ts` | AgenG | `@agenc/protocol` | IDL + Program factories |
| `types/` | shared | `@agenc/common` | Shared types/errors |
| `utils/` | shared | `@agenc/common` | Shared utilities |

### File-Level Split Tables (Directories Spanning Multiple Cages)

#### `runtime/src/llm/` — Splits AgenX (30) / AgenB (~28)

**TO AgenX (@agenc/runtime) — 30 files (17 source + 13 test):**

| File | Reason |
|------|--------|
| `chat-executor.ts` + `.test.ts` | Main orchestrator loop (3,821 lines) |
| `chat-executor-types.ts` | Types for ChatExecutor (887 lines) |
| `chat-executor-constants.ts` | Constants for ChatExecutor (193 lines) |
| `chat-executor-tool-utils.ts` + `.test.ts` | Tool calling utilities (787 lines) |
| `chat-executor-text.ts` + `.test.ts` | Text processing (imports gateway/message) (1,509 lines) |
| `chat-executor-recovery.ts` + `.test.ts` | Recovery logic (794 lines) |
| `chat-executor-planner.ts` + `.test.ts` | Planning step (imports gateway/delegation-*) (3,133 lines) |
| `chat-executor-planner-normalization.ts` + `.test.ts` | Planner output normalization (36 lines) |
| `chat-executor-planner-verifier-loop.ts` | Plan-verify loop (249 lines) |
| `chat-executor-verifier.ts` + `.test.ts` | Output verification (imports workflow/pipeline) (481 lines) |
| `chat-executor-contract-flow.ts` + `.test.ts` | Contract flow orchestration (169 lines) |
| `chat-executor-contract-guidance.ts` + `.test.ts` | Contract guidance (447 lines) |
| `chat-executor-doom.ts` + `.test.ts` | Doom autoplay orchestration (273 lines) |
| `chat-executor-explicit-tools.ts` | Explicit tool management (38 lines) |
| `chat-executor-routing-state.ts` + `.test.ts` | Tool routing state tracking (92 lines) |
| `delegation-decision.ts` + `.test.ts` | Delegation classification (799 lines) |
| `delegation-learning.ts` + `.test.ts` | Learning from delegations (560 lines) |

**TO AgenB (@agenc/llm):**

| File | Reason |
|------|--------|
| `grok/` (adapter + tests) | Grok LLM provider |
| `ollama/` (adapter + tests) | Ollama LLM provider |
| `anthropic/` (adapter + tests) | Anthropic LLM provider |
| `fallback.ts` + `.test.ts` | FallbackLLMProvider |
| `executor.ts` + `.test.ts` | LLMTaskExecutor (pure LLM execution) |
| `policy.ts` + `.test.ts` | LLM request policy |
| `prompt-budget.ts` + `.test.ts` | Token budget calculation |
| `timeout.ts` | Request timeout |
| `tool-turn-validator.ts` + `.test.ts` | Tool turn validation |
| `response-converter.ts` + `.test.ts` | Response format conversion |
| `provider-trace-logger.ts` + `.test.ts` | Provider tracing |
| `provider-capabilities.ts` | Provider capability detection |
| `provider-native-search.ts` + `.test.ts` | Provider-native search |
| `lazy-import.ts` | Lazy module loading |
| `types.ts` + `.test.ts` | LLM type definitions |
| `errors.ts` + `.test.ts` | LLM error classes |
| `index.ts` | Barrel re-exports |

#### `runtime/src/tools/` — Splits AgenA (~50) / AgenX (~10)

**TO AgenA (@agenc/tools):**
- `registry.ts` + `.test.ts` — ToolRegistry (PolicyEngine import removed, uses ToolPolicyHook; LLMTool import moved to @agenc/common)
- `skill-adapter.ts` + `.test.ts` — Skill→Tool adapter
- `types.ts` — Tool, ToolResult, ToolHandler (interfaces move to @agenc/common; implementations stay)
- `errors.ts` — ToolNotFoundError, ToolAlreadyRegisteredError
- `index.ts` — barrel
- `system/` — All system tools (~30 files: bash, http, filesystem, browser, macos, calendar, command-line, email-message, handle-contract, types, etc.)
- `shared/` — Shared system tool utilities (helpers.ts)

**TO AgenX (@agenc/runtime):**
- `agenc/tools.ts` — createAgencTools() (bridge code)
- `agenc/types.ts` — Serialized types
- `agenc/index.ts` — barrel
- `agenc/agenc-tools.test.ts` — tests
- `social/tools.ts` + `.test.ts` + `index.ts` — Social tool wrappers (imports AgentDiscovery, AgentMessaging, AgentFeed, CollaborationProtocol from social/ — V13)
- `marketplace/tools.ts` + `.test.ts` + `index.ts` — Marketplace tool wrappers (imports ServiceMarketplace — V14)

#### `runtime/src/types/` — Splits common (1) / AgenG (2) / AgenX (3)

**TO @agenc/common:** `errors.ts` (Solana-free subset — RuntimeErrorCodes + error classes; PublicKey-dependent context types → AgenG)
**TO AgenG:** `wallet.ts`, `protocol.ts` (+ their tests) — import `@solana/web3.js`
**Stays in AgenX:** `config.ts`, `config-migration.ts`, `agenc_coordination.ts`, `index.ts` (+ their tests)

#### `runtime/src/utils/` — Splits common (9 source + tests) / AgenX (9 source + tests)

**TO @agenc/common:** `logger.ts`, `encoding.ts`, `async.ts`, `pda.ts`, `lazy-import.ts`, `validation.ts`, `type-guards.ts`, `numeric.ts`, `collections.ts` (+ corresponding `.test.ts` files + `index.ts`)
**Stays in AgenX:** `delegation-validation.ts`, `delegated-contract-normalization.ts`, `query.ts`, `token.ts`, `process.ts`, `treasury.ts`, `trace-payload-serialization.ts`, `trace-payload-store.ts`, `keyed-async-queue.ts` (+ corresponding `.test.ts` files)

**Non-runtime components:**

| Current Location | Target | Notes |
|-----------------|--------|-------|
| `programs/` | AgenC (stays) | Anchor program |
| `sdk/` | AgenC (stays) | `@agenc/sdk` |
| `zkvm/` | AgenC (stays) | RISC Zero guest/host |
| `tests/` | AgenC (stays) | LiteSVM integration tests |
| `mcp/` | Ships with AgenB | `@agenc/mcp` |
| `docs-mcp/` | Standalone | Zero dependencies |
| `web/` | Standalone | Pure WebSocket client |
| `mobile/` | Standalone | Pure WebSocket client |
| `containers/desktop/` | AgenD | Docker image + REST server |

---

## 10. Cross-Cage Violation Register

These are all known import violations where the current code breaks the proposed cage boundaries. Every violation has a fix action and must be resolved in Phase 0 before any cage extraction.

### Original Violations (V1-V10, found in v3)

| # | File | Current Import | Violation | Fix |
|---|------|---------------|-----------|-----|
| V1 | `tools/registry.ts:13` | `PolicyEngine` from `policy/engine.js` | AgenA→AgenX | Extract `ToolPolicyHook` interface to `@agenc/common`; ToolRegistry accepts optional hook injection |
| V2 | `tools/types.ts:15` | `PolicyEngine` from `policy/engine.js` | AgenA→AgenX | Same as V1 — use interface, not class |
| V3 | `llm/provider-native-search.ts:2` | `GatewayLLMConfig` from `gateway/types.js` | AgenB→AgenX | Extract `LLMProviderConfig` (subset of GatewayLLMConfig) to `@agenc/common` |
| V4 | `llm/provider-native-search.ts:3` | `normalizeGrokModel` from `gateway/context-window.js` | AgenB→AgenX | Move `normalizeGrokModel()` to AgenB (`llm/grok/` or `llm/utils.ts`) — it's provider logic |
| V5 | `memory/ingestion.ts:27` | `HookHandler, HookContext, HookResult` from `gateway/hooks.js` | AgenB→AgenX | `HookHandler`/`HookContext`/`HookResult` → `@agenc/common/types/hooks.ts` |
| V6 | `memory/types.ts:12` + 3 backends | `MetricsProvider` from `task/types.js` | AgenB→AgenG | `MetricsProvider` → `@agenc/common/types/metrics.ts` |
| V7 | `desktop/session-router.ts:11` | `ToolHandler` from `llm/types.js` | AgenD→AgenB | `ToolHandler` → `@agenc/common/types/tools.ts` (already planned) |
| V8 | `voice/stt.ts:12` | `TranscriptionProvider` from `gateway/media.js` | AgenE→AgenX | `TranscriptionProvider` → `@agenc/common/types/media.ts` |
| V9 | `skills/jupiter/jupiter-skill.ts:46` | `Capability` from `agent/capabilities.js` | AgenA→AgenG | JupiterSkill protocol imports → move protocol-dependent skill parts to AgenX bridge |
| V10 | `skills/monetization/manager.ts:14` | `findAgentPda` from `agent/pda.js` | AgenA→AgenG | Same as V9 — monetization payment logic depends on TaskOperations, move to AgenX |

### New Violations (V11-V21, found in v4 review)

| # | File | Current Import | Violation | Fix |
|---|------|---------------|-----------|-----|
| V11 | `tools/registry.ts:10` | `LLMTool, ToolHandler` from `llm/types.js` | AgenA→AgenB | `LLMTool` → `@agenc/common/types/tools.ts` (it's a cross-cage contract type) |
| V12 | `tools/registry.ts:14` | `buildToolPolicyAction` from `policy/tool-governance.js` | AgenA→AgenX | Handle alongside V1 — PolicyEngine decoupling removes this import |
| V13 | `tools/social/tools.ts:15-19` | `AgentDiscovery`, `AgentMessaging`, `AgentFeed`, `CollaborationProtocol`, `SocialPeerDirectoryEntry` from `social/*` | AgenA→AgenX | **Move `tools/social/` to AgenX** — these tools are wrappers for AgenX's social module. Cannot decouple without hollowing them out. |
| V14 | `tools/marketplace/tools.ts:12` | `ServiceMarketplace` from `marketplace/service-marketplace.js` | AgenA→AgenX | **Move `tools/marketplace/` to AgenX** — same pattern as V13 |
| V15 | `tools/agenc/tools.ts` | 6 imports from `agent/`, `task/` | AgenA→AgenG | Already in AgenX by design (bridge code). No fix needed — `tools/agenc/` is assigned to AgenX. |
| V16 | `tools/agenc/index.ts:1` | `TaskOperations` from `task/operations.js` | AgenA→AgenG | Same as V15 — already assigned to AgenX |
| V17 | `skills/markdown/injector.ts:13` | `SkillInjector` from `llm/chat-executor.js` | AgenA→AgenX | `SkillInjector` interface → `@agenc/common/types/skill-injector.ts` |
| V18 | `skills/registry/payment.ts:22` | `findAgentPda, findProtocolPda` from `agent/pda.js` | AgenA→AgenG | Move skill payment logic to AgenX bridge (alongside V9, V10) |
| V19 | `mcp-client/tool-bridge.ts:18` | `MCPToolCatalogPolicyConfig` from `policy/mcp-governance.js` | AgenB→AgenX | Extract `MCPToolCatalogPolicyConfig` type to `@agenc/common/types/tools.ts` |
| V20 | `memory/retriever.ts:19` | `MemoryRetriever` from `llm/chat-executor.js` | AgenB→AgenX | `MemoryRetriever` already planned for `@agenc/common/types/memory.ts` |
| V21 | `memory/{sqlite,redis,in-memory}/backend.ts` | `TELEMETRY_METRIC_NAMES` from `telemetry/metric-names.js` | AgenB→AgenX | `TELEMETRY_METRIC_NAMES` → `@agenc/common/constants/` |

### Resolution Summary

- **7 violations** resolved by moving interfaces/types to `@agenc/common` (V1, V5, V6, V7, V8, V11, V17)
- **3 violations** resolved by moving constants/types to `@agenc/common` (V19, V20, V21)
- **2 violations** resolved by moving functions to correct cage (V3, V4)
- **1 violation** resolved by new `ToolPolicyHook` interface + `buildToolPolicyAction` removal (V2, V12)
- **2 violations** resolved by reassigning tool directories to AgenX (V13, V14)
- **4 violations** resolved by moving protocol-dependent code to AgenX bridge (V9, V10, V15-V16, V18)
- **2 violations** already resolved by design — `tools/agenc/` is assigned to AgenX (V15, V16)

### Violation Tiers

**Tier 1: MUST FIX (blocks cage independence):**
V1, V2, V11, V12, V13, V14, V17 — all AgenA coupling. V13/V14 require moving tool directories to AgenX.

**Tier 2: SHOULD FIX (impacts composability):**
V3, V4, V5, V6, V7, V8, V19, V20, V21 — mostly mechanical interface/constant extraction to @agenc/common.

**Tier 3: KNOWN BY DESIGN:**
V9, V10, V15, V16, V18 — protocol bridge code that lives in AgenX intentionally.

**Effort estimate:** 7-10 days total (21 violations, AST-based import rewriting, interface extraction, directory reassignment, zero test regressions required).

---

## 11. Migration Plan

### Phase 0: Foundation (monorepo, no splits)

**Goal:** Extract `@agenc/common` as a workspace package, resolve all cross-cage violations, and stabilize interfaces.

**Steps:**

1. **Create workspace structure:**
   ```
   AgenC/
   ├── packages/
   │   └── common/
   │       ├── src/
   │       │   ├── types/    ← move from runtime/src/types/ (errors only — Solana-free subset)
   │       │   │             ← add new: llm.ts, tools.ts, memory.ts, message.ts,
   │       │   │                hooks.ts, media.ts, metrics.ts, plugin.ts,
   │       │   │                skill-injector.ts
   │       │   │             ← NOTE: wallet.ts, protocol.ts → AgenG (Solana deps)
   │       │   ├── utils/    ← move from runtime/src/utils/ (9 pure utility files)
   │       │   ├── constants/ ← extract from gateway/daemon.ts (HOOK_PRIORITIES, etc.)
   │       │   └── index.ts
   │       ├── package.json  ← @agenc/common, zero deps
   │       └── tsconfig.json
   ├── runtime/              ← now imports from @agenc/common
   └── package.json          ← add "packages/*" to workspaces
   ```

2. **Move interface types to @agenc/common** (resolves violations V1-V8, V17, V20, V21):
   - `Tool`, `ToolResult`, `ToolHandler`, `ToolPolicyHook`, `LLMTool` → `common/types/tools.ts`
   - `LLMMessage`, `LLMProvider`, `LLMResponse`, `LLMProviderConfig` → `common/types/llm.ts`
   - `MemoryBackend`, `MemoryEntry`, `MemoryRetriever` → `common/types/memory.ts`
   - `SkillInjector` → `common/types/skill-injector.ts`
   - `GatewayMessage`, `OutboundMessage` → `common/types/message.ts`
   - `HookHandler`, `HookContext`, `HookResult` → `common/types/hooks.ts`
   - `TranscriptionProvider`, `SpeechToTextProvider`, `TextToSpeechProvider` → `common/types/media.ts`
   - `MetricsProvider` → `common/types/metrics.ts`
   - `CagePlugin`, `PluginContext` → `common/types/plugin.ts`
   - `MCPToolCatalogPolicyConfig` → `common/types/tools.ts`
   - `HOOK_PRIORITIES`, `CRON_SCHEDULES`, `TELEMETRY_METRIC_NAMES` → `common/constants/`

3. **Resolve remaining violations (V1-V2, V4, V9-V21):**
   - V1-V2: Refactor `ToolRegistry` to accept optional `ToolPolicyHook` instead of importing `PolicyEngine`
   - V4: Move `normalizeGrokModel()` from `gateway/context-window.ts` to `llm/grok/utils.ts`
   - V9-V10: Move protocol-dependent skill code (JupiterSkill protocol calls, monetization payments) to AgenX bridge code alongside `createAgencTools()`
   - V11: Extract `types/errors.ts` PublicKey-dependent context types to AgenG
   - V12: Move `wallet.ts`, `protocol.ts` to AgenG (import `@solana/web3.js`)
   - V13-V14: tools/social/ and tools/marketplace/ stay in AgenX (not AgenA) — they import AgenX social/marketplace modules
   - V15-V16: Move `gateway/host-tooling.ts` and `gateway/host-workspace.ts` bash tool factory to use AgenA's `ToolRegistry` via interface
   - V17: Move `SkillInjector` interface to `@agenc/common`; `skills/markdown/injector.ts` imports from common
   - V18: `llm/chat-executor-planner.ts` delegation-decision import stays AgenX-local (both move together)
   - V19: `mcp-client/tool-bridge.ts` imports `MCPToolCatalogPolicyConfig` from `@agenc/common` instead of `policy/mcp-governance`
   - V20: `memory/retriever.ts` imports `MemoryRetriever` from `@agenc/common` instead of `llm/chat-executor`
   - V21: Memory backends import `TELEMETRY_METRIC_NAMES` from `@agenc/common` instead of `telemetry/`

4. **Update all imports in `runtime/src/`:**
   - `from '../types/errors.js'` → `from '@agenc/common'`
   - `from '../utils/logger.js'` → `from '@agenc/common'`
   - This touches **600+ files**. Use a codemod script:
     ```bash
     node scripts/rewrite-imports.mjs  # AST-based, not sed
     ```
   **Important:** Do NOT use `sed` for import rewriting (Challenge #4 from adversarial review). Use an AST-aware codemod (e.g., `jscodeshift` or a custom script) that:
   - Handles re-exports correctly
   - Preserves `type` import annotations
   - Handles barrel re-exports without circular refs
   - Validates every rewritten import resolves

5. **Verify zero test regressions:**
   ```bash
   cd runtime && npm run test      # 5000+ tests must pass
   npm run typecheck               # types must compile
   npm run build                   # build must succeed
   ```

6. **Add contract tests** — integration tests that validate each cross-cage interface. One test per interface: `Tool`, `LLMProvider`, `MemoryBackend`, `ChannelPlugin`, `DesktopSession`, `SpeechToTextProvider`.

**Estimated effort:** 10-14 days (21 violation fixes + interface/constant extraction + AST codemod writing + 600+ file import rewrite + directory reassignment + contract tests + full test suite validation)

### Phase 1: Extract Leaf Cages (lowest risk)

| Order | Cage | Package | Risk | Effort | Validation |
|-------|------|---------|------|--------|------------|
| 1.1 | AgenE | `@agenc/voice` | Very Low | 1 day | STT/TTS providers work standalone |
| 1.2 | AgenD | `@agenc/desktop` | Very Low | 1-2 days | Desktop tools + container work |
| 1.3 | AgenF | `@agenc/channels` | Low | 2 days | Each channel plugin starts/stops |
| 1.4 | docs-mcp | `@agenc/docs-mcp` | Zero | 1 hour | Already standalone |
| 1.5 | web + mobile | own repos | Zero | 1 hour each | Already standalone |

**Leaf cages have the property:** no other cage imports from them. Only AgenX consumes them. Extraction cannot break anything downstream.

**For each leaf cage extraction:**
1. Create `packages/{cage}/` workspace with its own `package.json` and `tsconfig.json`
2. Move source files from `runtime/src/{dir}/` to `packages/{cage}/src/`
3. Update imports: relative `../` paths → `@agenc/common` package imports
4. Verify cage builds and tests pass in isolation
5. Verify `runtime/` still builds with cage as workspace dependency
6. Run full test suite

### Phase 2: Extract Core Logic (medium risk)

| Order | Cage | Package | Risk | Effort | Validation |
|-------|------|---------|------|--------|------------|
| 2.1 | AgenG | `@agenc/protocol` | Medium | 3-4 days | Agent/task/dispute operations pass tests |
| 2.2 | AgenA | `@agenc/tools` | Medium | 2-3 days | ToolRegistry + skill adapter work |
| 2.3 | AgenB | `@agenc/llm` | Medium | 3-4 days | LLM providers + memory backends work |

**Critical during this phase:**
- `createAgencTools()` must already be in AgenX (done in Phase 0) to avoid AgenA→AgenG dependency
- ChatExecutor files must already be in AgenX (physically moved in Phase 0) to avoid AgenB→gateway dependency
- All cross-cage violations resolved in Phase 0 — no relative imports between cages remain
- Test coverage for cross-cage boundaries via contract tests

### Phase 3: Refactor Orchestrator (highest risk, do last)

| Order | Cage | Package | Risk | Effort | Validation |
|-------|------|---------|------|--------|------------|
| 3.1 | AgenX | `@agenc/runtime` | High | 5-7 days | Full daemon lifecycle + all integrations |

AgenX is extracted last because it depends on everything. By this point, all other cages are workspace packages with stable APIs.

### Phase 4: Separate Repos

Once all cages work as workspace packages in the monorepo:

1. Create individual repos: `tetsuo-ai/agenc-{runtime,tools,llm,desktop,voice,channels,protocol}`
2. Move cage source to its repo
3. Publish to npm: `@agenc/{runtime,tools,llm,desktop,voice,channels,protocol}`
4. Update AgenC repo to consume published packages
5. Set up cross-repo CI triggers
6. Split config types: each cage exports its own config type (deferred from Phase 0-3)

### Migration Invariants

- **Zero test regression at every step** — full suite after each extraction
- **No breaking public API changes** — consumers of `@agenc/runtime` see the same exports during transition
- **Backward compat barrel** — AgenX re-exports all cage APIs during migration period:
  ```typescript
  // @agenc/runtime/index.ts (temporary, during migration)
  export * from '@agenc/tools';
  export * from '@agenc/llm';
  export * from '@agenc/protocol';
  // ... enables gradual consumer migration
  ```
- **Semantic versioning** — all cages start at 1.0.0 with locked interfaces
- **AST-based import rewriting** — never use `sed` for import changes (prevents partial matches, preserves type annotations)

---

## 12. Test Migration Strategy

### Test File Distribution (306 test files, ~5000+ test cases)

| Cage | Test Files | Est. Test Cases | Migration Difficulty |
|------|-----------|----------------|---------------------|
| **AgenX** (@agenc/runtime) | 173 | ~3,200 | HIGH — ChatExecutor + gateway tests + 4 standalone root tests |
| **AgenG** (@agenc/protocol) | 38 | ~450 | LOW — pure protocol operations |
| **AgenA** (@agenc/tools) | 36 | ~400 | MEDIUM — PolicyEngine import in registry.test.ts is NOT dead (actively used); must refactor to ToolPolicyHook mock |
| **AgenB** (@agenc/llm) | 25 | ~300 | MEDIUM — ChatExecutor tests removed; some tests import telemetry metric names |
| **@agenc/common** | 14 | ~200 | LOW — pure types/utils |
| **AgenF** (@agenc/channels) | 9 | ~120 | VERY LOW — isolated plugins |
| **AgenD** (@agenc/desktop) | 5 | ~60 | VERY LOW — fully isolated |
| **AgenE** (@agenc/voice) | 2 | ~30 | VERY LOW — fully isolated |

**Note:** 4 standalone root test files (`builder.test.ts`, `runtime.test.ts`, `idl.test.ts`, `idl-validation.test.ts`) are assigned to AgenX.

### Migration Tiers

**Tier 1 (extract first, zero refactoring needed):**
AgenD (5 tests), AgenE (2 tests), AgenF (9 tests), AgenG (38 tests)

**Tier 2 (minor surgery needed):**
@agenc/common (14 tests — shared type coordination), AgenA (36 tests — PolicyEngine import in `registry.test.ts` must be refactored to use `ToolPolicyHook` mock, NOT removed as dead code), AgenB (25 tests — ChatExecutor tests removed, telemetry imports resolved)

**Tier 3 (heavy, do last):**
AgenX (173 tests — receives 13 ChatExecutor tests + 2 delegation tests from llm/, 56+ gateway tests with deep integration, 4 standalone root tests)

### Root Integration Tests

The 18 test files in `/tests/` (LiteSVM-based, ~140 tests) stay in the AgenC repo. They exercise SDK + on-chain program and do NOT import from `runtime/src/`. They remain as protocol-level acceptance tests.

### Shared Test Utilities

Create `@agenc/test-utils` (devDependency only) for cross-cage test mocks:

| Utility | Used By | Current Location |
|---------|---------|-----------------|
| `createMockMemoryBackend()` | AgenX, AgenB | `memory/test-utils.ts` |
| `createMockLLMProvider()` | AgenX, AgenB | various test files |
| `createMockToolHandler()` | AgenX | gateway test files |
| `silentLogger` | ALL | `utils/logger.ts` (moves to @agenc/common) |

---

## 13. Package Naming & Versioning

### Brand Names vs npm Names

Each cage has a brand name (AgenX, AgenA, etc.) and a descriptive npm name:

| Brand | Package | Binary | Description |
|-------|---------|--------|-------------|
| — | `@agenc/common` | — | Shared types, utils, constants |
| AgenC | `@agenc/sdk` | `agenc` | ZK proofs & Solana SDK |
| AgenX | `@agenc/runtime` | `agenc-runtime` | Orchestrator daemon |
| AgenA | `@agenc/tools` | — | Tool & skill registry |
| AgenB | `@agenc/llm` | — | LLM providers & memory |
| AgenB (MCP) | `@agenc/mcp` | `agenc-mcp` | MCP server |
| AgenD | `@agenc/desktop` | — | Desktop automation |
| AgenE | `@agenc/voice` | — | Voice STT/TTS |
| AgenF | `@agenc/channels` | — | Channel plugins |
| AgenG | `@agenc/protocol` | — | Protocol operations |

### Versioning Strategy

- **`@agenc/common`**: Strict semver. Breaking changes = major bump = coordinated release across all cages. Target: stay at 1.x as long as possible.
- **`@agenc/sdk`**: Follows on-chain program versions. Breaking changes when instructions change.
- **Cage packages**: Independent semver. Pin `@agenc/common` as peer dep with caret range.
- **Release cadence**: Cages release independently unless `@agenc/common` changes.
- **Coordinated releases**: When `@agenc/common` bumps major, all cages must release compatible versions within 48 hours. CI enforces this via cross-cage compatibility matrix.

### Peer Dependencies

Every cage declares:
```json
{ "peerDependencies": { "@agenc/common": "^1.0.0" } }
```

AgenG additionally:
```json
{
  "peerDependencies": {
    "@agenc/common": "^1.0.0",
    "@agenc/sdk": "^1.3.0",
    "@coral-xyz/anchor": ">=0.29.0",
    "@solana/web3.js": ">=1.90.0"
  }
}
```

### Diamond Dependency Prevention

To prevent `@agenc/common@1.x` vs `@agenc/common@2.x` diamond conflicts:
1. Keep `@agenc/common` at 1.x as long as possible (additive changes only)
2. When a major bump is unavoidable, use a 2-week deprecation window where 1.x gets a final patch with forward-compatible types
3. Nightly CI runs the full cage compatibility matrix to catch version drift early
4. `@agenc/common` uses `exports` map with subpath exports — allows adding new entry points without breaking existing imports

---

## 14. CI/CD Strategy

### Per-Cage CI

| Cage | Package | Tests | Gate |
|------|---------|-------|------|
| @agenc/common | types + utils | `vitest run` | Types compile, utils pass |
| @agenc/sdk | SDK + program | `vitest run` + `npm run test:fast` (LiteSVM) | All instruction tests |
| @agenc/runtime | Orchestrator | `vitest run` + benchmarks + mutation gates | 5000+ tests, mutation thresholds |
| @agenc/tools | Tools + skills | `vitest run` | Tool + skill tests |
| @agenc/llm | LLM + memory + MCP | `vitest run` | Provider + backend tests |
| @agenc/desktop | Desktop | `vitest run` + Docker build | Container starts, REST API responds |
| @agenc/voice | Voice | `vitest run` | Provider tests |
| @agenc/channels | Channels | `vitest run` | Plugin tests |
| @agenc/protocol | Protocol ops | `vitest run` | Operation tests |
| @agenc/test-utils | Test mocks | `vitest run` | Mock factories work |

### Cross-Cage Integration

- **Nightly integration** in AgenX repo: installs all cages from npm, runs full daemon lifecycle
- **Dependabot/Renovate** on each cage watches for `@agenc/common` updates
- **Canary releases** for pre-release testing across cages
- **Compatibility matrix**: weekly CI job that tests all cage version combinations

---

## 15. Risks & Mitigations

### R1: Interface Drift

**Risk:** Cages evolve types and break cross-cage contracts.
**Mitigation:** All shared interfaces live in `@agenc/common` with strict semver. Contract tests in every cage verify compatibility. `@agenc/common` governance rules (Section 8) prevent bloat.

### R2: @agenc/common Scope Creep

**Risk:** Controversial types get dumped into common, growing it unboundedly.
**Mitigation:** Governance rules: 2-cage minimum with justification, 200KB hard cap, no cage-specific types, no external deps. Every addition requires justification. Relaxed from v2's 3-cage minimum based on adversarial review finding that contract interfaces between exactly 2 cages (e.g., ToolPolicyHook) still belong in common.

### R3: Dependency Diamond

**Risk:** Two cages depend on different major versions of `@agenc/common`.
**Mitigation:** Keep `@agenc/common` at 1.x as long as possible. Peer dependency + caret range. Breaking changes require coordinated release within 48 hours. Nightly cross-cage CI catches drift. 2-week deprecation window for major bumps.

### R4: Build Complexity

**Risk:** Multi-repo development harder than monorepo.
**Mitigation:** Phases 0-3 happen entirely within the monorepo using workspace packages. Separate repos only in Phase 4 after interfaces are stable. `npm link` for cross-repo dev.

### R5: AgenX Bloat

**Risk:** AgenX grows to absorb everything that doesn't fit elsewhere.
**Mitigation:** Clear criteria: a module stays in AgenX only if it requires cross-cage coordination or daemon lifecycle coupling (verified by code audit — marketplace, social, team all require session lifecycle hooks). New modules default to their own cage unless they demonstrably need daemon coupling. If AgenX exceeds 100K lines, extract new leaf cages.

### R6: createAgencTools() Bridge Fragility

**Risk:** Protocol tools break when AgenA or AgenG APIs change.
**Mitigation:** Protocol tools are ~500 lines of bridge code in AgenX. AgenX's integration tests exercise them. Both AgenA and AgenG have contract tests for their exported interfaces.

### R7: ChatExecutor Split Complexity

**Risk:** Moving ChatExecutor (30 files, ~14.3K lines) from llm/ to AgenX is the riskiest single move.
**Mitigation:** ChatExecutor already imports from gateway/ and workflow/. Moving it to AgenX makes these local imports instead of cross-cage deps. The LLM providers it calls are consumed via the `LLMProvider` interface from `@agenc/common` — no coupling to provider internals. Move happens in Phase 0 while still in monorepo — zero risk of npm version conflicts.

### R8: Optional Dependency Hell

**Risk:** Lazy-loaded deps (openai, ollama, etc.) fail at runtime.
**Mitigation:** Each cage handles its own optional deps with clear error messages. `peerDependenciesMeta` marks them optional. `ensureLazyModule()` from common provides consistent error handling.

### R9: Test Coverage Gaps

**Risk:** Tests that ran in one suite now span repos.
**Mitigation:** Integration tests in AgenX exercise cross-cage paths. Each cage has unit tests. Nightly cross-cage suite catches regressions. `@agenc/test-utils` provides shared mock factories.

### R10: Config Migration

**Risk:** Existing `~/.agenc/config.json` files break when config ownership splits.
**Mitigation:** Config stays monolithic in AgenX through Phase 0-3. Only splits in Phase 4 when repos separate. AgenX includes config migration logic that maps old flat structure to cage-owned sections. Cross-cage config fields are mediated by AgenX at startup.

### R11: Migration Import Breakage (v3, from adversarial review)

**Risk:** Relative imports (`../policy/engine.ts`) break when source files move to different workspace packages, because the relative path no longer exists.
**Mitigation:** Phase 0 resolves ALL cross-cage violations BEFORE any files move. Use AST-based codemod (not `sed`) for import rewriting. The codemod validates every rewritten import resolves. Phase 0 is complete only when `npm run typecheck && npm run test` passes with zero violations remaining.

### R12: Shared Runtime State (v3, from adversarial review)

**Risk:** Module-level constants (HOOK_PRIORITIES, CRON_SCHEDULES, etc.) defined in `gateway/daemon.ts` are used to initialize state for channels, voice, and tools.
**Mitigation:** Extract shared constants to `@agenc/common/constants/` during Phase 0. Constants are pure values (no imports, no side effects) and belong in common. Cage-specific initialization values are passed via `PluginContext` at startup.

### R13: Coordinated Release Burden (v3, from adversarial review)

**Risk:** Breaking changes in `@agenc/common` require 8 coordinated releases. This is expensive and error-prone.
**Mitigation:** (1) Minimize breaking changes — `@agenc/common` adds new interfaces via subpath exports without breaking existing ones. (2) Keep at 1.x as long as possible. (3) When a major bump is unavoidable, use a 2-week deprecation window. (4) Automated release pipeline: bump common → CI runs all cages → auto-publish compatible versions. (5) This cost is the honest price of modular architecture — acknowledged, not hidden.

### R14: Monorepo Is Actually Fine (v3, from adversarial review)

**Risk:** The refactor solves a problem that doesn't exist. Tree-shaking handles unused code. One repo is simpler than eight.
**Mitigation:** This is an honest trade-off, not a risk to mitigate. The refactor is justified if: (a) third-party developers will build on individual cages, (b) independent release cadence matters for leaf cages, (c) the team has >3 developers working across different cages simultaneously. If none of these are true today, defer Phase 4 (separate repos) indefinitely. Phases 0-3 (workspace packages in monorepo) provide most of the architectural benefits with none of the multi-repo coordination cost.

---

## Appendix A: Measured Line Counts (source files only, no tests)

All line counts verified via `wc -l` against actual source files (March 2026).

| Cage | Modules | Measured Lines | % of Runtime Source |
|------|---------|---------------|-------------------|
| @agenc/common | types/, utils/, constants/ (Solana-free subset) | 2,890 | 1.5% |
| @agenc/runtime (AgenX) | gateway, ChatExecutor(30), autonomous, workflow, cli, policy, marketplace, social, team, bridges, replay, telemetry, observability, eval, tools/{agenc,social,marketplace} | 120,600 | 62% |
| @agenc/tools (AgenA) | tools (minus agenc/social/marketplace/), skills (minus protocol-dependent) | 21,086 | 11% |
| @agenc/llm (AgenB) | llm (minus ChatExecutor/delegation), memory, mcp-client | 11,698 | 6% |
| @agenc/desktop (AgenD) | desktop + container | 3,616 | 2% |
| @agenc/voice (AgenE) | voice | 1,554 | 1% |
| @agenc/channels (AgenF) | channels (8 plugins) | 7,204 | 4% |
| @agenc/protocol (AgenG) | agent, task, proof, dispute, governance, events, connection, reputation, idl + wallet.ts, protocol.ts | 22,162 | 11% |

**Notes:**
- Total runtime source: ~194,000 lines (source only). With tests: ~355,000 lines.
- @agenc/common is small because Solana-dependent types (wallet, protocol, events) stay in AgenG.
- AgenX is 62% — the orchestrator is intentionally the largest cage. gateway/ alone is 51,614 lines.
- v3 estimates were 2-3x understated across the board due to measuring methods. All numbers above are `wc -l` verified.

## Appendix B: External Dependency Ownership

| External Package | Cage | Optional? |
|-----------------|------|-----------|
| `@coral-xyz/anchor` | AgenG | Required (peer) |
| `@solana/web3.js` | AgenG | Required (peer) |
| `@solana/spl-token` | AgenG | Required (peer) |
| `openai` | AgenB, AgenE | Optional |
| `@anthropic-ai/sdk` | AgenB | Optional |
| `ollama` | AgenB | Optional |
| `better-sqlite3` | AgenB | Optional |
| `ioredis` | AgenB | Optional |
| `ws` | AgenB, AgenX | Optional |
| `@modelcontextprotocol/sdk` | AgenB | Required |
| `grammy` | AgenF | Optional |
| `discord.js` | AgenF | Optional |
| `@slack/bolt` | AgenF | Optional |
| `@whiskeysockets/baileys` | AgenF | Optional |
| `matrix-js-sdk` | AgenF | Optional |
| `cheerio` | AgenA | Optional |
| `playwright` | AgenA | Optional |
| `edge-tts` | AgenE | Optional |

## Appendix C: Monorepo Workspace (Intermediate State)

Before splitting into separate repos, the monorepo transitions to:

```
AgenC/
├── packages/
│   ├── common/          # @agenc/common — types, utils, constants
│   ├── tools/           # @agenc/tools — tool & skill registries
│   ├── llm/             # @agenc/llm — LLM providers, memory, MCP client
│   ├── desktop/         # @agenc/desktop — sandbox manager + container
│   ├── voice/           # @agenc/voice — STT/TTS providers
│   ├── channels/        # @agenc/channels — 8 channel plugins
│   ├── protocol/        # @agenc/protocol — on-chain operations
│   ├── runtime/         # @agenc/runtime — orchestrator (gateway, daemon, ChatExecutor)
│   └── test-utils/      # @agenc/test-utils — shared test mocks (devDependencies)
├── apps/
│   ├── web/             # Web UI (standalone)
│   ├── mobile/          # Mobile app (standalone)
│   └── demo-app/        # Demo (standalone)
├── programs/            # Anchor program (stays)
├── sdk/                 # @agenc/sdk (stays)
├── zkvm/                # RISC Zero (stays)
├── mcp/                 # @agenc/mcp (ships with AgenB)
├── docs-mcp/            # @agenc/docs-mcp (standalone)
├── containers/          # Desktop image (ships with AgenD)
├── tests/               # Integration tests (stays)
├── scripts/             # Build/deploy scripts
├── docs/                # Architecture docs
└── package.json         # Workspace root with "packages/*", "apps/*"
```

## Appendix D: Key Design Decisions

### D1: Why ChatExecutor is in AgenX, not AgenB

ChatExecutor (30 files: 17 source + 13 test, ~14,268 lines) is the core multi-turn orchestration loop. Code audit shows it imports from:
- `gateway/delegation-scope.ts` — delegation scope classification
- `gateway/delegation-timeout.ts` — delegation timeout management
- `gateway/message.ts` — message types
- `workflow/pipeline.ts` — pipeline execution
- `workflow/types.ts` — workflow types
- `tools/types.ts` — tool interfaces

These are orchestration concerns. AgenB provides raw `LLMProvider.chat()` calls. AgenX composes them with tools, memory, planning, and verification via ChatExecutor.

**Consequence:** ChatExecutor is NOT available from `@agenc/llm`. Developers who want multi-turn orchestration must use `@agenc/runtime`. This is intentional — ChatExecutor without gateway, workflow, and tool integration is meaningless.

**Note:** `SkillInjector` and `MemoryRetriever` interfaces (currently defined in `chat-executor.ts`) must move to `@agenc/common` before extraction, since AgenA's `skills/markdown/injector.ts` implements `SkillInjector` and AgenB's `memory/retriever.ts` implements `MemoryRetriever`.

### D2: Why createAgencTools() is in AgenX, not AgenA

`createAgencTools()` creates 4 built-in protocol tools (listTasks, getTask, getAgent, getProtocolConfig). Code audit shows it imports:
- `TaskOperations` from `task/operations.ts` (AgenG)
- `findAgentPda()`, `findProtocolPda()` from `agent/pda.ts` (AgenG)
- `parseAgentState()`, `agentStatusToString()` from `agent/types.ts` (AgenG)
- `taskStatusToString()`, `isPrivateTask()` from `task/types.ts` (AgenG)

If this stayed in AgenA, AgenA would depend on AgenG, creating a coupling between tools and protocol. Instead, AgenX bridges them: it imports `ToolRegistry` from AgenA and protocol operations from AgenG, then creates the bridge tools during daemon startup.

### D3: Why AgenG is one cage, not 8 micro-packages

agent/, task/, dispute/, governance/, events/, connection/, reputation/, proof/ all:
- Share `@coral-xyz/anchor` and `@solana/web3.js` peer deps
- Work with the same Anchor `Program<AgencCoordination>` instance
- Share the IDL and type system
- Have internal dependencies (task→agent, dispute→agent, proof→task)

8 micro-packages with identical peer deps = unnecessary maintenance. Tree-shaking handles unused exports.

### D4: Why marketplace/social/team stay in AgenX

Verified by code audit:
- **marketplace**: Session-scoped in-memory bid book, requires daemon lifecycle hooks for per-session management
- **social**: CollaborationProtocol depends on TeamContractEngine + TaskOperations; messaging routes through daemon sessions
- **team**: TeamWorkflowAdapter binds to WorkflowOrchestrator; checkpoints are part of DAG execution
- All three require cross-cage coordination that only the orchestrator can provide

### D5: Why ToolRegistry uses ToolPolicyHook injection (v3)

ToolRegistry (AgenA) previously imported PolicyEngine (AgenX), creating an AgenA→AgenX reverse dependency that violates the "cages never import from AgenX" rule. The fix:
- Define `ToolPolicyHook` interface in `@agenc/common`
- ToolRegistry accepts an optional `policyHook` in its constructor
- PolicyEngine in AgenX implements `ToolPolicyHook` and is injected during daemon wiring
- AgenA depends only on `@agenc/common` — zero coupling to AgenX

### D6: Why 8 cages (not fewer, not more)

**Why not fewer (e.g., merge AgenA + AgenB into "@agenc/integration"):**
- AgenA (tools) has optional deps: cheerio, playwright
- AgenB (llm) has optional deps: openai, ollama, better-sqlite3, ioredis
- Merging them means `npm install @agenc/integration` pulls both dep sets
- They serve different audiences: tool authors vs. LLM integrators

**Why not more (e.g., split AgenX into orchestrator + execution + business):**
- marketplace, social, team all depend on daemon lifecycle hooks — splitting creates circular deps
- ChatExecutor depends on gateway + workflow — splitting creates more cross-cage imports
- AgenX at ~120K lines is large but cohesive — gateway/daemon/ChatExecutor form a tightly coupled core. Extracting sub-cages would create more circular deps than it resolves. If a clear leaf emerges (e.g., eval/), extract then

**Why not fewer by dropping leaf cages (e.g., fold AgenE into AgenB):**
- Voice has distinct optional deps (edge-tts)
- Audio I/O is not text model context
- "Install only what you need" means `@agenc/llm` shouldn't pull voice deps

## Appendix E: Adversarial Review Results

v3 was hardened by a 5-agent adversarial review. Each agent attacked from a different angle:

| Agent | Role | Key Finding | Status |
|-------|------|-------------|--------|
| **The Splitter** | File-level cage assignment | 203 files across split directories mapped. tools/registry.ts→PolicyEngine is the one real violation | RESOLVED (ToolPolicyHook injection, Section 4.3) |
| **The Import Tracer** | Cross-cage import validation | 10 violations found (V1-V10). AgenB↔AgenX circular risk via provider-native-search.ts | RESOLVED (all 10 fixes documented, Section 10) |
| **v4 Review** | Full codebase verification | 11 additional violations (V11-V21) found via grep. Line counts off by 2-3x. @agenc/common had Solana deps. tools/social+marketplace misassigned | RESOLVED (21 violations total, all line counts verified, Solana types→AgenG, social/marketplace→AgenX) |
| **The Consumer** | Developer experience | 5 DX blockers: missing common types, PolicyEngine coupling, ChatExecutor coupling, config split complexity, API surface clarity | RESOLVED (types moved, PolicyEngine decoupled, API tiers documented) |
| **The Test Auditor** | Test migration planning | 306 test files mapped. ChatExecutor is 30 files (17 source + 13 test). PolicyEngine import in tools/registry.test.ts is NOT dead | RESOLVED (file counts corrected, test strategy in Section 12) |
| **The Devil's Advocate** | Architecture stress testing | 10 challenges including: breaking migration (#4 CRITICAL), wrong cage assignment (#2), monorepo is fine (#10) | RESOLVED (AST-based migration, ToolPolicyHook, honest tradeoff section) |

**Verdict from v3 adversarial review:** YES WITH CHANGES. All critical and high-severity issues addressed in v3.

**Verdict from v4 codebase verification:** YES — CONFIRMED. All v3 claims verified against actual source. 11 additional violations discovered and resolved. Line counts corrected (some were 2-3x off). @agenc/common Solana dependency contradiction fixed. Phase 0 effort revised upward (10-14 days) to account for 21 total violations. The architecture is viable with the documented fixes applied during Phase 0.
