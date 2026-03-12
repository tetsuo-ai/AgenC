# REFACTOR v5 — AgenC Modular Runtime Architecture

> OS-inspired layered architecture. Thin kernel, typed contracts, everything is a plugin.
>
> **v5** — Ground-up redesign based on deep research into OS kernels (Linux LKM, seL4, QNX), plugin systems (VS Code, webpack Tapable, Grafana, Home Assistant), agent frameworks (LangGraph, OpenAI Agents SDK, Anthropic Agent SDK, AgentForge, Auton), and full coupling analysis of the actual codebase.

---

## 1. What's Wrong with v4

REFACTOR.md v4 proposed 8 cages with AgenX as the orchestrator. The problem:

**AgenX is 62% of the codebase.** At ~120,600 lines, it contains gateway, daemon, ChatExecutor, autonomous, workflow, policy, social, marketplace, team, bridges, replay, telemetry, observability, and eval. Extracting leaf modules (tools, channels, voice, desktop) while leaving this monolith intact is not modularization — it's trimming the edges.

In OS terms, v4 puts the kernel, filesystem, network stack, GPU drivers, window manager, and half the applications inside ring 0. That's not a microkernel. That's Linux circa 1991 before loadable modules existed.

**v5 fixes this.** The kernel is small. Everything else plugs in.

---

## 2. Architecture Model

Inspired by:
- **QNX microkernel**: Only IPC, scheduling, and interrupt handling in kernel. Everything else is a service.
- **VS Code extension host**: Manifest-driven lazy loading. Extensions declare activation events. Core is ~10% of total.
- **seL4 capabilities**: Explicit typed tokens for service access. No ambient authority.
- **Home Assistant**: 5000+ integrations via manifest-driven discovery and coordinator pattern.
- **Auton framework**: Blueprint/runtime split — declarative "what" separated from imperative "how."

### The Three Rings

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   RING 2: EXTENSIONS (separate repos, behind plugin contract)       │
│                                                                     │
│   @agenc/channels    @agenc/desktop     @agenc/voice                │
│   @agenc/autonomous  @agenc/social      @agenc/policy               │
│   @agenc/eval        @agenc/replay      @agenc/bridges              │
│   @agenc/workflow    @agenc/marketplace  @agenc/team                 │
│                                                                     │
│   ════════════════ Plugin Contract (ServiceModule) ════════════════  │
│                                                                     │
│   RING 1: CORE SERVICES (separate repos, in-process)                │
│                                                                     │
│   @agenc/engine      @agenc/providers   @agenc/memory               │
│   @agenc/tools       @agenc/protocol                                │
│                                                                     │
│   ════════════════ Service Registry (typed tokens) ════════════════  │
│                                                                     │
│   RING 0: KERNEL (small, stable, changes rarely)                    │
│                                                                     │
│   @agenc/core ─── contracts, types, utils, constants                │
│   @agenc/kernel ── daemon, sessions, hooks, config, plugin loader   │
│                                                                     │
│   ════════════════════════════════════════════════════════════════   │
│                                                                     │
│   FOUNDATION: @agenc/sdk ── ZK proofs & Solana (unchanged)          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Ring 0 (Kernel):** The minimum viable runtime. If you strip everything else away, this is what's left — daemon lifecycle, session management, hook dispatch, config, plugin loading, MCP client bridge, AgentBuilder/Runtime, and CLI. ~28K lines total across core (~8K) + kernel (~20K†). †After aggressive daemon.ts split from 9,635 → ~3,400 lines (see §18 Decision 1). **Changes here are rare and carefully reviewed.**

**Ring 1 (Core Services):** The engine and provider infrastructure that the kernel loads first. ChatExecutor, LLM adapters, memory backends, tool registry, protocol operations. These are in-process for performance but communicate through typed interfaces defined in @agenc/core. ~70K lines across 5 packages. **Changes here require contract compatibility.**

**Ring 2 (Extensions):** Everything else. Channels, desktop, voice, autonomous agents, social, marketplace, workflow, policy, eval, replay, bridges, team. Each is a separate repo implementing the `ServiceModule` contract. A crash or bug in one extension does not bring down the kernel. ~70K lines across 12 packages. **Changes here are independent — ship whenever ready.**

### Why Three Rings, Not Two

Two-ring systems (kernel + everything) don't distinguish between "the ChatExecutor failing means the runtime is broken" and "the Telegram channel failing means Telegram doesn't work." Core services are not optional — the runtime needs an LLM provider and a tool registry to function. Extensions are optional — you can run without voice, without desktop, without social.

---

## 3. Package Map

### Ring 0: Kernel

| Package | Repo | Source Lines | Purpose |
|---------|------|-------------|---------|
| `@agenc/core` | `tetsuo-ai/agenc-core` | ~5.5K | Typed contracts, interfaces, pure utils, constants. **Zero external deps.** (Includes LLMChatOptions tree, ToolCallRecord, HeartbeatResult, ConfigDiff — see Audit §17) |
| `@agenc/kernel` | `tetsuo-ai/agenc-kernel` | ~27K† | DaemonManager, Gateway server, sessions, hook dispatcher, config watcher, plugin loader, service registry, MCP client bridge, AgentBuilder, AgentRuntime, CLI. †Audit §17 found actual size is ~27K with full daemon.ts; splits planned to reduce toward 18K target. |

### Ring 1: Core Services

| Package | Repo | Source Lines | Purpose |
|---------|------|-------------|---------|
| `@agenc/engine` | `tetsuo-ai/agenc-engine` | ~17.5K† | ChatExecutor (15 files), LLMTaskExecutor, tool handler pipeline, prompt budget, tool-turn validator, context window, planner, verifier, compaction. †Corrected from ~16K — llm/ is 21,080 lines not 14,268. |
| `@agenc/providers` | `tetsuo-ai/agenc-providers` | ~3.4K† | LLM adapters (Grok, Ollama), FallbackProvider, provider capabilities matrix, native search. †Corrected from ~9K — no Anthropic adapter exists in the codebase. |
| `@agenc/memory` | `tetsuo-ai/agenc-memory` | ~5K | InMemory/SQLite/Redis backends, embeddings, vector store, ingestion, retrieval, structured memory |
| `@agenc/tools` | `tetsuo-ai/agenc-tools` | ~21K | ToolRegistry, system tools (bash, http, filesystem, browser, macos — 14.2K), skill adapter, skill registry (5.8K), monetization |
| `@agenc/protocol` | `tetsuo-ai/agenc-protocol` | ~22K | Agent/task/dispute/governance/reputation operations, events, connection manager, proof engine, IDL types |

### Ring 2: Extensions

| Package | Repo | Source Lines | Purpose |
|---------|------|-------------|---------|
| `@agenc/channels` | `tetsuo-ai/agenc-channels` | ~7K | 8 channel plugins (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, iMessage, WebChat) |
| `@agenc/desktop` | `tetsuo-ai/agenc-desktop` | ~4K | Desktop sandbox manager, session router, container management |
| `@agenc/voice` | `tetsuo-ai/agenc-voice` | ~3K† | STT (Whisper), TTS (ElevenLabs, OpenAI, Edge), Realtime (xAI). †voice-bridge.ts (1,066) + media.ts (384) counted. |
| `@agenc/autonomous` | `tetsuo-ai/agenc-autonomous` | ~28K | Autonomous agent, scanner, verifier, risk scoring, background run supervisor + helpers (control, notifier, operator, wake bus/adapters), delegation orchestration (runtime, scope, timeout) |
| `@agenc/workflow` | `tetsuo-ai/agenc-workflow` | ~5K | DAG orchestrator, goal compiler, pipeline executor, canary rollout |
| `@agenc/social` | `tetsuo-ai/agenc-social` | ~5K | Agent discovery, messaging, feed, collaboration protocol |
| `@agenc/marketplace` | `tetsuo-ai/agenc-marketplace` | ~2.5K | Task bidding, matching, strategies, ServiceMarketplace |
| `@agenc/team` | `tetsuo-ai/agenc-team` | ~2.5K | Team contracts, payouts, audit, validation |
| `@agenc/policy` | `tetsuo-ai/agenc-policy` | ~5K | Policy engine, budgets, circuit breakers, RBAC, tool governance |
| `@agenc/eval` | `tetsuo-ai/agenc-eval` | ~14.5K† | Benchmarks, mutation testing, trajectory replay, chaos matrix, pipeline quality, event timeline store, backfill, alerting. †Includes merged @agenc/replay (~3K) per §18 Decision 5. |
| `@agenc/bridges` | `tetsuo-ai/agenc-bridges` | ~1K | LangChain, X402 payments, Farcaster |

### Foundation

| Package | Repo | Lines | Purpose |
|---------|------|-------|---------|
| `@agenc/sdk` | `tetsuo-ai/AgenC` | ~existing | ZK proofs & Solana infrastructure (unchanged) |
| `@agenc/mcp` | `tetsuo-ai/AgenC` | ~existing | MCP server exposing protocol ops (stays in program repo) |

### Standalone Apps (not packages)

| App | Repo | Purpose |
|-----|------|---------|
| Web UI | `tetsuo-ai/agenc-web` | Vite + React + Tailwind dashboard |
| Mobile App | `tetsuo-ai/agenc-mobile` | Expo React Native |
| Demo App | stays in AgenC repo | React demo for ZK workflow |

### Stays in AgenC Program Repo

| Directory | Purpose |
|-----------|---------|
| `programs/agenc-coordination/` | Anchor program (42 instructions, Rust) |
| `sdk/` | TypeScript SDK wrapping the program |
| `mcp/` | MCP server exposing protocol ops as tools |
| `docs-mcp/` | Docs MCP server (dev tooling) |
| `zkvm/` | RISC Zero guest + host crates (Rust, tied to program) |
| `tests/` | LiteSVM integration tests (test SDK + program) |
| `containers/` | Desktop sandbox Docker images (consumed by @agenc/desktop) |
| `examples/` | Example projects (migrated per-package in Phase 4) |
| `scripts/` | Build/deploy scripts for program + SDK |
| `demo/` + `demo-app/` | Demo scripts and React demo app |
| `docs/` | Architecture docs (updated to reflect v5) |
| `migrations/` | Protocol migration tools |

**Total: 18 package repos + 1 facade (@agenc/runtime) + 2 app repos + 1 program repo (AgenC with sdk, mcp, zkvm, containers, tests, docs). See §18 for architectural decisions (eval+replay merged, facade meta-package).**

---

## 4. The Kernel in Detail

The kernel is the smallest possible thing that can boot, discover plugins, and run a session. Everything else plugs in.

### @agenc/core — Contracts & Foundation

Zero external dependencies. Every other package depends on this.

```
@agenc/core/
├── src/
│   ├── types/
│   │   ├── llm.ts           # LLMProvider, LLMMessage, LLMResponse, LLMTool
│   │   ├── tools.ts         # Tool, ToolResult, ToolHandler, ToolPolicyHook
│   │   ├── memory.ts        # MemoryBackend, MemoryEntry, MemoryRetriever
│   │   ├── message.ts       # GatewayMessage, OutboundMessage
│   │   ├── hooks.ts         # HookHandler, HookContext, HookResult, HookEventMap
│   │   ├── media.ts         # TranscriptionProvider, STTProvider, TTSProvider
│   │   ├── metrics.ts       # MetricsProvider, TelemetryCollector
│   │   ├── plugin.ts        # ServiceModule, ServiceRegistry, ServiceToken
│   │   ├── session.ts       # Session, SessionManager, SessionConfig
│   │   ├── config.ts        # Config schemas (Zod-validated per-module)
│   │   ├── errors.ts        # RuntimeErrorCodes, error classes (Solana-free)
│   │   └── index.ts
│   ├── utils/
│   │   ├── encoding.ts      # toUint8Array, toBuffer, base58
│   │   ├── logger.ts        # Logger interface + default impl
│   │   ├── async.ts         # retry, timeout, debounce, SEVEN_DAYS_MS
│   │   ├── safe-stringify.ts # bigint-safe JSON serialization
│   │   ├── type-guards.ts   # isError, isString, etc.
│   │   ├── validation.ts    # Input validators
│   │   ├── process.ts       # Process utilities
│   │   ├── lazy-import.ts   # ensureLazyModule() for optional deps
│   │   ├── pda.ts           # PDA derivation helpers
│   │   ├── trace-logger.ts  # ProviderTraceLogger (LLM call observability)
│   │   └── index.ts
│   ├── constants/
│   │   ├── hook-priorities.ts    # HOOK_PRIORITIES
│   │   ├── cron-schedules.ts     # CRON_SCHEDULES
│   │   ├── metric-names.ts       # TELEMETRY_METRIC_NAMES
│   │   └── index.ts
│   └── index.ts
├── package.json    # zero deps
└── tsconfig.json
```

**What goes here:** Only things that satisfy ALL of these:
1. Used by 3+ packages
2. Zero external dependencies (no @solana, no openai, nothing)
3. Pure types, interfaces, or stateless utility functions
4. No implementation logic — only contracts

**What does NOT go here:**
- Wallet types (depend on @solana/web3.js → @agenc/protocol)
- Protocol types (depend on Anchor → @agenc/protocol)
- Any implementation class
- Anything used by only 1-2 packages (stays in that package)

### @agenc/kernel — The Runtime Daemon

The init system. Boots the runtime, discovers and loads plugins, manages sessions, dispatches hooks.

```
@agenc/kernel/
├── src/
│   ├── daemon/
│   │   ├── manager.ts         # DaemonManager class (lifecycle: start/stop)
│   │   ├── bootstrap.ts       # Plugin discovery, dependency resolution, boot sequence
│   │   ├── wiring.ts          # Wire core services (engine, providers, memory, tools)
│   │   ├── signal-handlers.ts # SIGTERM, SIGINT, PID file
│   │   └── index.ts
│   ├── gateway/
│   │   ├── server.ts          # HTTP + WebSocket transport
│   │   ├── session.ts         # Session lifecycle, compaction, reset
│   │   ├── routing.ts         # Message routing rules
│   │   ├── format.ts          # Channel formatting
│   │   ├── webhooks.ts        # Webhook routing
│   │   ├── channel.ts         # Base channel class
│   │   ├── progress.ts        # Cross-session progress tracking
│   │   └── index.ts
│   ├── hooks/
│   │   ├── dispatcher.ts      # TypedHookDispatcher (typed events via HookEventMap)
│   │   ├── builtin.ts         # Built-in hook stubs
│   │   └── index.ts
│   ├── config/
│   │   ├── loader.ts          # Load + validate config from file
│   │   ├── watcher.ts         # Hot-reload with diffing
│   │   ├── schema.ts          # Zod schemas per module section
│   │   ├── migration.ts       # Config version migration
│   │   └── index.ts
│   ├── registry/
│   │   ├── service-registry.ts  # Typed token-based service resolution
│   │   ├── plugin-loader.ts     # ServiceModule lifecycle management
│   │   ├── tokens.ts            # All ServiceToken definitions
│   │   └── index.ts
│   ├── workspace/
│   │   ├── workspace.ts       # Agent workspace model
│   │   ├── workspace-files.ts # System prompt assembly
│   │   ├── personality.ts     # Personality templates
│   │   └── index.ts
│   ├── identity/
│   │   ├── identity.ts        # Cross-channel identity linking
│   │   └── index.ts
│   ├── commands/
│   │   ├── registry.ts        # Slash command registry
│   │   └── index.ts
│   ├── observability/
│   │   ├── trace.ts           # Trace logging
│   │   ├── sqlite-store.ts    # SQLite observability store
│   │   └── index.ts
│   ├── mcp-client/
│   │   ├── connection.ts      # Spawn child process, JSON-RPC via stdio
│   │   ├── manager.ts         # MCPManager — multiple server lifecycle
│   │   ├── resilient-bridge.ts # ResilientMCPBridge — auto-reconnect
│   │   ├── tool-bridge.ts     # MCP tools → runtime Tool[] conversion
│   │   ├── types.ts           # MCPServerConfig, MCPToolBridge interfaces
│   │   └── index.ts
│   ├── composition/
│   │   ├── builder.ts         # AgentBuilder fluent API
│   │   ├── runtime.ts         # AgentRuntime lifecycle wrapper
│   │   └── index.ts
│   ├── cli/
│   │   ├── daemon.ts          # CLI daemon commands (start/stop/restart)
│   │   ├── health.ts          # Health check
│   │   ├── wizard.ts          # Config wizard
│   │   ├── onboard.ts         # Agent onboarding
│   │   ├── replay.ts          # Event replay ops
│   │   ├── jobs.ts            # Scheduled job management
│   │   ├── logs.ts            # Log viewing
│   │   ├── sessions.ts        # Session management
│   │   ├── security.ts        # Security checks
│   │   ├── types.ts           # CLI types
│   │   └── index.ts
│   ├── cron/
│   │   ├── heartbeat.ts       # Periodic heartbeat
│   │   ├── heartbeat-actions.ts # Heartbeat action handlers
│   │   ├── scheduler.ts       # Cron job scheduler
│   │   └── index.ts
│   ├── transport/
│   │   ├── remote.ts          # Remote gateway client
│   │   ├── remote-types.ts    # Remote type definitions
│   │   ├── jwt.ts             # JWT auth
│   │   ├── proactive.ts       # Proactive communication
│   │   └── index.ts
│   ├── bin/
│   │   ├── agenc-runtime.ts   # CLI entry point
│   │   └── daemon.ts          # Daemon entry point
│   └── index.ts
├── package.json    # depends on: @agenc/core
└── tsconfig.json
```

**Key design decision:** The kernel does NOT contain ChatExecutor, tool routing, LLM providers, memory backends, or any business logic. It loads those as core services during bootstrap.

### Kernel Size Budget

| Component | Lines | Source |
|-----------|-------|--------|
| Daemon lifecycle (manager + bootstrap + wiring + signals) | ~3,400 | Extracted from daemon.ts (9,635 → 3,400 after §18 aggressive 9-module split) |
| Gateway server + sessions + routing + format + webhooks | ~3,000 | Already standalone files in gateway/ |
| Hook dispatcher (typed upgrade) | ~500 | Current hooks.ts (339) + typed event map |
| Config loader + watcher + schema | ~2,500 | Current config-watcher.ts (2,372) |
| Service registry + plugin loader | ~700 | New code (~200 registry + ~500 lifecycle) |
| Workspace + identity + personality | ~2,000 | Already standalone files |
| Commands + observability + trace | ~1,200 | commands.ts (375), daemon-trace.ts (874), observability/ |
| MCP client bridge | ~660 | mcp-client/ (connection, manager, resilient-bridge, tool-bridge) |
| AgentBuilder + AgentRuntime + IDL | ~1,460 | builder.ts (754), runtime.ts (545), idl.ts (162) |
| Progress tracking + remote types | ~310 | progress.ts (219), remote-types.ts (95) |
| CLI commands | ~2,000 | daemon.ts (1,273), health.ts, wizard.ts, subset of cli/ |
| Gateway barrel + channel base | ~830 | index.ts (429), channel.ts (400) |
| Daemon extracted modules (9 files) | ~5,920 | daemon-tool-registry, -webchat-setup, -prompt-builder, -llm-setup, -memory-setup, -delegation-setup, -hooks-commands, -signals, -session-handlers |
| **Total** | **~20,000** | **~9.5% of total runtime (209K)** |

Compare to v4's AgenX at 120,600 lines (62%). The kernel should be 8-12% of the total — that's the range where VS Code, Grafana, and Home Assistant operate. At 9.5%, we're within that window. See §18 Decision 1 for the daemon.ts split plan.

---

## 5. The Plugin Contract

Every package in Ring 1 and Ring 2 implements the same contract. This is the single most important interface in the system.

### ServiceModule Interface

```typescript
// @agenc/core/types/plugin.ts

/**
 * Every package implements this interface. The kernel discovers,
 * resolves dependencies, and manages the lifecycle of all modules.
 */
interface ServiceModule {
  /** Unique package name (e.g., "@agenc/channels") */
  readonly name: string;

  /** Semver version */
  readonly version: string;

  /** Ring level: 1 (core) or 2 (extension) */
  readonly ring: 1 | 2;

  /** Services this module requires (validated before start) */
  readonly requires: ServiceToken<unknown>[];

  /** Services this module optionally uses (not validated) */
  readonly optionalRequires?: ServiceToken<unknown>[];

  /**
   * Register services and hooks. Called during bootstrap.
   * The module receives only the services it declared in requires/optionalRequires.
   */
  register(registry: ServiceRegistry): void;

  /**
   * Start the module. Called after all modules are registered.
   * Activation order respects dependency graph.
   */
  start?(registry: ServiceRegistry): Promise<void>;

  /**
   * Graceful shutdown. Called in reverse activation order.
   */
  stop?(): Promise<void>;
}
```

### ServiceRegistry Interface

```typescript
// @agenc/core/types/plugin.ts

/**
 * Typed service resolution. The kernel owns the registry.
 * Modules register providers; other modules resolve them.
 */
interface ServiceRegistry {
  /** Register a service factory under a typed token */
  register<T>(token: ServiceToken<T>, factory: () => T): void;

  /** Resolve a required service (throws if missing) */
  resolve<T>(token: ServiceToken<T>): T;

  /** Resolve an optional service (returns undefined if missing) */
  resolveOptional<T>(token: ServiceToken<T>): T | undefined;

  /** Get the typed hook dispatcher */
  readonly hooks: TypedHookDispatcher;

  /** Get a child logger for this module */
  logger(moduleName: string): Logger;

  /** Get this module's config section (Zod-validated) */
  config<T>(schema: ZodSchema<T>): T;
}

/**
 * Typed token — compile-time enforcement of service types.
 * No string-based lookups, no ambient authority.
 */
class ServiceToken<T> {
  private constructor(readonly id: string) {}
  static create<T>(id: string): ServiceToken<T> {
    return new ServiceToken<T>(id);
  }
}
```

### Service Tokens (defined in @agenc/core)

```typescript
// @agenc/core/registry/tokens.ts

// Core services (Ring 1)
export const LLM_PROVIDER = ServiceToken.create<LLMProvider>('engine.llm');
export const CHAT_EXECUTOR = ServiceToken.create<ChatExecutor>('engine.executor');
export const TOOL_REGISTRY = ServiceToken.create<ToolRegistry>('tools.registry');
export const TOOL_HANDLER = ServiceToken.create<ToolHandler>('tools.handler');
export const MEMORY_BACKEND = ServiceToken.create<MemoryBackend>('memory.backend');
export const MEMORY_RETRIEVER = ServiceToken.create<MemoryRetriever>('memory.retriever');
export const SKILL_INJECTOR = ServiceToken.create<SkillInjector>('tools.skills');
export const EMBEDDING_PROVIDER = ServiceToken.create<EmbeddingProvider>('memory.embedding');

// Protocol services
export const PROTOCOL_PROGRAM = ServiceToken.create<Program>('protocol.program');
export const CONNECTION_MANAGER = ServiceToken.create<ConnectionManager>('protocol.connection');
export const AGENT_OPERATIONS = ServiceToken.create<AgentOperations>('protocol.agent');
export const TASK_OPERATIONS = ServiceToken.create<TaskOperations>('protocol.task');

// Extension services (Ring 2, resolved optionally)
export const DESKTOP_MANAGER = ServiceToken.create<DesktopSandboxManager>('desktop.manager');
export const POLICY_ENGINE = ServiceToken.create<PolicyEngine>('policy.engine');
export const APPROVAL_ENGINE = ServiceToken.create<ApprovalEngine>('policy.approvals');
export const MARKETPLACE = ServiceToken.create<ServiceMarketplace>('marketplace.service');
export const TELEMETRY = ServiceToken.create<TelemetryCollector>('telemetry.collector');
```

### Typed Hook System

```typescript
// @agenc/core/types/hooks.ts

/**
 * Every hook event has a typed payload. Adding a new event
 * requires adding it here — the compiler catches mismatches.
 */
interface HookEventMap {
  'gateway:startup':    { config: GatewayConfig };
  'gateway:shutdown':   { reason: string };
  'session:start':      { sessionId: string; channel: string };
  'session:end':        { sessionId: string; reason: string };
  'session:compact':    { sessionId: string; summary: string };
  'message:inbound':    { sessionId: string; message: GatewayMessage };
  'message:outbound':   { sessionId: string; content: string; toolCalls?: ToolCallRecord[] };
  'tool:before':        { tool: string; args: Record<string, unknown>; sessionId: string };
  'tool:after':         { tool: string; result: ToolResult; durationMs: number };
  'heartbeat:before':   { timestamp: number };
  'heartbeat:after':    { timestamp: number; results: HeartbeatResult[] };
  'command:new':        { command: string; sessionId: string };
  'command:reset':      { sessionId: string };
  'command:stop':       { sessionId: string };
  'config:reload':      { diff: ConfigDiff };
}

interface TypedHookDispatcher {
  on<E extends keyof HookEventMap>(
    event: E,
    handler: HookRegistration<HookEventMap[E]>
  ): Disposable;

  dispatch<E extends keyof HookEventMap>(
    event: E,
    payload: HookEventMap[E]
  ): Promise<HookChainResult>;
}

interface HookRegistration<T> {
  name: string;
  priority: number;
  handler: (payload: T) => Promise<HookResult>;
}
```

### Plugin Lifecycle

Every ServiceModule goes through this state machine:

```
REGISTERED → RESOLVED → STARTING → ACTIVE → STOPPING → STOPPED
                |                     |
                v                     v
             FAILED                FAILED
```

1. **REGISTERED**: Module loaded, manifest read
2. **RESOLVED**: All `requires` tokens are available (or module enters FAILED)
3. **STARTING**: `start()` called
4. **ACTIVE**: Ready to handle events
5. **STOPPING**: `stop()` called (reverse order of activation)
6. **STOPPED**: Fully decommissioned

The kernel logs the full dependency graph and activation order at startup.

---

## 6. How It Boots

```typescript
// @agenc/kernel — daemon bootstrap

import { createEngineModule } from '@agenc/engine';
import { createProvidersModule } from '@agenc/providers';
import { createMemoryModule } from '@agenc/memory';
import { createToolsModule } from '@agenc/tools';
import { createProtocolModule } from '@agenc/protocol';

// Extensions — loaded conditionally based on config
const extensions = [];
if (config.channels?.telegram) extensions.push(await import('@agenc/channels'));
if (config.desktop?.enabled) extensions.push(await import('@agenc/desktop'));
if (config.voice?.enabled) extensions.push(await import('@agenc/voice'));
if (config.autonomous?.enabled) extensions.push(await import('@agenc/autonomous'));
// ... etc

const daemon = new DaemonManager({
  config,
  coreServices: [
    createEngineModule(config.engine),
    createProvidersModule(config.llm),
    createMemoryModule(config.memory),
    createToolsModule(config.tools),
    createProtocolModule(config.protocol),
  ],
  extensions: extensions.map(m => m.createModule(config)),
});

await daemon.start();
// 1. Create ServiceRegistry
// 2. Register all core services (Ring 1)
// 3. Validate: all required tokens resolved
// 4. Register all extensions (Ring 2)
// 5. Resolve dependency graph, compute activation order
// 6. Start modules in order
// 7. Log dependency graph
// 8. Emit 'gateway:startup' hook
```

**Key property:** The kernel never directly imports extension internals. It calls `createModule()` which returns a `ServiceModule` implementing the contract. Extensions declare what they need, the registry provides it.

**Lazy loading:** Extensions are `import()`-ed only when their config section is present. If you don't configure desktop, `@agenc/desktop` is never loaded. This matches VS Code's activation events pattern.

---

## 7. Dependency Graph

### Package-Level Dependencies

```
@agenc/core       → (zero deps)
@agenc/sdk        → @coral-xyz/anchor, @solana/web3.js

@agenc/kernel     → @agenc/core
@agenc/engine     → @agenc/core
@agenc/providers  → @agenc/core, openai?, @anthropic-ai/sdk?, ollama?
@agenc/memory     → @agenc/core, better-sqlite3?, ioredis?
@agenc/tools      → @agenc/core, cheerio?, playwright?
@agenc/protocol   → @agenc/core, @agenc/sdk, @coral-xyz/anchor, @solana/web3.js

@agenc/channels   → @agenc/core, grammy?, discord.js?, @slack/bolt?, ...
@agenc/desktop    → @agenc/core
@agenc/voice      → @agenc/core, openai?, edge-tts?
@agenc/autonomous → @agenc/core
@agenc/workflow   → @agenc/core
@agenc/social     → @agenc/core
@agenc/marketplace→ @agenc/core
@agenc/team       → @agenc/core
@agenc/policy     → @agenc/core
@agenc/eval       → @agenc/core
@agenc/replay     → @agenc/core
@agenc/bridges    → @agenc/core
```

### Dependency Matrix

| Imports → | core | sdk | kernel | engine | providers | memory | tools | protocol |
|-----------|------|-----|--------|--------|-----------|--------|-------|----------|
| **core** | — | | | | | | | |
| **sdk** | | — | | | | | | |
| **kernel** | YES | | — | | | | | |
| **engine** | YES | | | — | | | | |
| **providers** | YES | | | | — | | | |
| **memory** | YES | | | | | — | | |
| **tools** | YES | | | | | | — | |
| **protocol** | YES | YES | | | | | | — |
| **Ring 2 (all)** | YES | | | | | | | |

**Zero circular dependencies.** Ring 2 packages depend ONLY on @agenc/core. They access Ring 1 services through the ServiceRegistry at runtime, not through compile-time imports. This is the critical difference from v4 — extensions never import from the kernel, engine, or each other.

### How Ring 2 Accesses Ring 1 Services

```typescript
// @agenc/autonomous — an extension that needs LLM and tools

import { ServiceModule, ServiceToken, LLM_PROVIDER, TOOL_HANDLER } from '@agenc/core';

export function createAutonomousModule(config: AutonomousConfig): ServiceModule {
  return {
    name: '@agenc/autonomous',
    version: '1.0.0',
    ring: 2,
    requires: [LLM_PROVIDER, TOOL_HANDLER],  // Declared dependencies
    optionalRequires: [DESKTOP_MANAGER, POLICY_ENGINE],

    register(registry) {
      const llm = registry.resolve(LLM_PROVIDER);       // Type-safe: LLMProvider
      const tools = registry.resolve(TOOL_HANDLER);      // Type-safe: ToolHandler
      const desktop = registry.resolveOptional(DESKTOP_MANAGER); // Optional

      const scanner = new TaskScanner({ llm, tools });
      const supervisor = new BackgroundRunSupervisor({ llm, tools, desktop });

      // Register hooks for autonomous behavior
      registry.hooks.on('heartbeat:after', {
        name: 'autonomous-scanner',
        priority: 50,
        handler: async (payload) => {
          await scanner.scan();
          return { continue: true };
        },
      });
    },
  };
}
```

The autonomous module never imports from @agenc/engine, @agenc/kernel, or @agenc/providers directly. It declares what it needs via tokens, and the kernel provides concrete implementations at boot time. If @agenc/autonomous fails to start (e.g., missing required service), the kernel logs the failure and continues — other modules are unaffected.

---

## 8. Breaking the Four Cycles

The coupling analysis found four bidirectional dependency cycles. Here's how v5 breaks each:

### Cycle 1: gateway ↔ llm (CRITICAL)

**Current:** 36 gateway files import from llm/. 5 llm files import gateway types.

**v5 fix:** Split into @agenc/kernel (gateway parts) + @agenc/engine (ChatExecutor parts). Both depend only on @agenc/core contracts. The gateway never imports the engine directly — it resolves `CHAT_EXECUTOR` from the registry.

### Cycle 2: memory ↔ llm

**Current:** Memory ingestion imports LLM callbacks. LLM executor imports MemoryRetriever.

**v5 fix:** `MemoryRetriever` and `EmbeddingProvider` interfaces live in @agenc/core. @agenc/memory implements them. @agenc/engine consumes them via service tokens. Neither imports the other.

### Cycle 3: autonomous ↔ gateway

**Current:** Autonomous imports gateway approvals/hooks. Gateway imports autonomous scanner.

**v5 fix:** Autonomous is Ring 2 — it registers hooks via the dispatcher and resolves services via tokens. The kernel never imports autonomous directly. It loads the module dynamically if configured.

### Cycle 4: policy ↔ gateway

**Current:** Policy imports gateway/approvals. Gateway imports policy/engine.

**v5 fix:** Policy is Ring 2. It registers a `tool:before` hook via the dispatcher. The `ToolPolicyHook` interface lives in @agenc/core. The kernel resolves it optionally — if @agenc/policy isn't loaded, no policy enforcement happens.

**All four cycles are broken by the same principle:** modules communicate through @agenc/core contracts and the hook dispatcher, never through direct imports across rings.

---

## 9. Current Module → Package Assignment

### From gateway/ (51,614 source lines → distributed across 69 source files)

| Current Location | New Package | Lines |
|-----------------|-------------|-------|
| daemon.ts (lifecycle, wiring, helpers) | @agenc/kernel | ~4,000 |
| gateway.ts, session.ts, routing.ts, format.ts, webhooks.ts | @agenc/kernel | ~3,000 |
| config-watcher.ts | @agenc/kernel | ~2,400 |
| hooks.ts | @agenc/kernel | ~340 |
| workspace.ts, workspace-files.ts, personality.ts, identity.ts | @agenc/kernel | ~2,100 |
| commands.ts, jwt.ts, remote.ts, remote-types.ts, proactive.ts | @agenc/kernel | ~980 |
| daemon-trace.ts, daemon-session-state.ts | @agenc/kernel | ~1,100 |
| heartbeat.ts, heartbeat-actions.ts, scheduler.ts | @agenc/kernel (cron) | ~1,150 |
| channel.ts | @agenc/kernel (base class) | ~400 |
| progress.ts | @agenc/kernel (session continuity) | ~220 |
| browser-tool-mode.ts, system-prompt-routing.ts, host-tooling.ts, host-workspace.ts | @agenc/kernel | ~410 |
| index.ts (gateway barrel) | @agenc/kernel | ~430 |
| tool-routing.ts, tool-handler-factory.ts, tool-handler-factory-delegation.ts | @agenc/engine | ~3,100 |
| context-window.ts, tool-environment-policy.ts, tool-round-budget.ts | @agenc/engine | ~500 |
| daemon-webchat-turn.ts, daemon-text-channel-turn.ts | @agenc/engine | ~800 |
| chat-usage.ts, daemon-llm-failure.ts, llm-stateful-defaults.ts | @agenc/engine | ~250 |
| background-run-supervisor.ts, background-run-store.ts | @agenc/autonomous | ~10,900 |
| background-run-control.ts, background-run-notifier.ts, background-run-operator.ts | @agenc/autonomous | ~680 |
| background-run-wake-adapters.ts, background-run-wake-bus.ts | @agenc/autonomous | ~900 |
| subagent-orchestrator.ts, sub-agent.ts, delegation-tool.ts, durable-subrun-orchestrator.ts | @agenc/autonomous | ~5,300 |
| delegation-runtime.ts, delegation-scope.ts, delegation-timeout.ts | @agenc/autonomous | ~580 |
| run-domains.ts, run-domain-native-tools.ts, autonomy-rollout.ts | @agenc/autonomous | ~2,160 |
| session-isolation.ts, agent-run-contract.ts, subrun-contract.ts | @agenc/autonomous | ~930 |
| doom-stop-guard.ts | @agenc/autonomous | ~30 |
| approvals.ts, approval-runtime.ts | @agenc/policy | ~1,000 |
| sandbox.ts | @agenc/desktop | ~560 |
| voice-bridge.ts, media.ts | @agenc/voice | ~1,450 |
| types.ts, errors.ts, message.ts | @agenc/core (interfaces), @agenc/kernel (impl) | ~1,130 |

### From llm/ (21,080 source lines → distributed across 38 source files)

| Current Location | New Package | Lines |
|-----------------|-------------|-------|
| chat-executor.ts + all chat-executor-*.ts (17 source files) | @agenc/engine | ~12,900 |
| executor.ts (LLMTaskExecutor) | @agenc/engine | ~520 |
| prompt-budget.ts (PromptBudgetCalculator) | @agenc/engine | ~840 |
| tool-turn-validator.ts (tool_calls → tool_result sequencing) | @agenc/engine | ~170 |
| timeout.ts (timeout state/helpers) | @agenc/engine | ~50 |
| policy.ts (LLMPolicy — rate limits, cost guards) | @agenc/engine | ~140 |
| delegation-decision.ts, delegation-learning.ts | @agenc/autonomous | ~1,360 |
| grok/ adapter.ts, adapter-utils.ts, types.ts | @agenc/providers | ~2,330 |
| ~~anthropic/ adapter~~ | ~~@agenc/providers~~ | ~~2,000~~ | **PHANTOM — does not exist. Removed.** |
| ollama/ adapter.ts, types.ts | @agenc/providers | ~660 |
| fallback.ts | @agenc/providers | ~130 |
| provider-capabilities.ts (provider feature matrix) | @agenc/providers | ~100 |
| provider-native-search.ts (Grok web_search) | @agenc/providers | ~110 |
| response-converter.ts | @agenc/providers | ~30 |
| provider-trace-logger.ts (LLM call observability) | @agenc/core | ~210 |
| types.ts, errors.ts | @agenc/core (interfaces) | ~810 |
| lazy-import.ts, index.ts | per-package utility | ~200 |

### From tools/ (~27,871 lines with tests, ~15,450 source → distributed)

| Current Location | New Package | Source Lines |
|-----------------|-------------|-------------|
| registry.ts, skill-adapter.ts, types.ts, errors.ts, index.ts | @agenc/tools | ~690 |
| system/ (bash, http, filesystem, browser, macos, calendar, email, office, pdf, etc. — 19 tools) | @agenc/tools | ~14,250 |
| shared/helpers.ts | @agenc/tools | ~20 |
| skills/ (manifest, registry, catalog, markdown, monetization, jupiter, bundled) | @agenc/tools | ~5,780 |
| agenc/ (createAgencTools bridge, tools.ts, types.ts) | @agenc/kernel (bridge code) | ~1,200 |
| social/tools.ts | @agenc/social | ~870 |
| marketplace/tools.ts | @agenc/marketplace | ~320 |

### Standalone Modules (move directly to their package)

| Current Location | New Package | Source Lines | With Tests |
|-----------------|-------------|-------------|------------|
| memory/ | @agenc/memory | ~4,730 | ~8,830 |
| channels/ | @agenc/channels | ~7,200 | ~13,310 |
| desktop/ | @agenc/desktop | ~3,620 | ~6,180 |
| voice/ | @agenc/voice | ~1,550 | ~2,060 |
| autonomous/ | @agenc/autonomous | ~7,910 | ~13,380 |
| workflow/ | @agenc/workflow | ~5,010 | ~7,700 |
| social/ | @agenc/social | ~4,130 | ~8,500 |
| marketplace/ | @agenc/marketplace | ~2,270 | ~3,580 |
| team/ | @agenc/team | ~2,220 | ~3,180 |
| policy/ | @agenc/policy | ~4,690 | ~6,980 |
| eval/ | @agenc/eval | ~11,500 | ~17,700 |
| replay/ | @agenc/replay | ~2,980 | ~4,580 |
| bridges/ | @agenc/bridges | ~640 | ~1,120 |
| telemetry/ | @agenc/core (metrics interfaces) + @agenc/kernel (impl) | ~575 | ~915 |
| observability/ | @agenc/kernel (trace logging, sqlite store) | ~1,160 | ~1,550 |

### Protocol Operations (→ @agenc/protocol)

| Current Location | New Package | Source Lines | With Tests |
|-----------------|-------------|-------------|------------|
| agent/ | @agenc/protocol | ~2,840 | ~5,460 |
| task/ | @agenc/protocol | ~11,065 | ~27,450 |
| dispute/ | @agenc/protocol | ~1,500 | ~2,490 |
| events/ | @agenc/protocol | ~3,500 | ~6,760 |
| connection/ | @agenc/protocol | ~920 | ~1,940 |
| proof/ | @agenc/protocol | ~720 | ~1,470 |
| governance/ | @agenc/protocol | ~800 | ~1,420 |
| reputation/ | @agenc/protocol | ~800 | ~1,520 |

### Types & Utils (→ distributed)

| Current Location | New Package | Source Lines | Notes |
|-----------------|-------------|-------------|-------|
| types/errors.ts (Solana-free subset) | @agenc/core | ~700† | RuntimeErrorCodes + error classes. †Actual file is 1,411 lines total, not 3,996. |
| types/errors.ts (Anchor error codes) | @agenc/protocol | ~711† | AnchorErrorCodes mapping. †Split does not create 4K from 1,411 lines. |
| types/agenc_coordination.ts (generated IDL types) | @agenc/protocol | ~11,936 | Auto-generated, moves with IDL |
| types/wallet.ts | @agenc/protocol | ~500 | Depends on @solana/web3.js |
| types/protocol.ts | @agenc/protocol | ~1,000 | Depends on @solana/web3.js |
| types/config.ts, config-migration.ts | @agenc/kernel | ~1,200 | Config system |
| types/index.ts | split per-package | — | Barrel exports |
| utils/ (encoding, logger, async, safe-stringify, type-guards, validation, process, lazy-import, pda) | @agenc/core | ~1,500 | Pure utilities |
| utils/ (delegation-validation, trace-payload, query, token, treasury) | @agenc/protocol or @agenc/autonomous | ~2,170 | Domain-specific utilities |

### Top-Level Entry Points (→ @agenc/kernel)

| Current Location | New Package | Source Lines | Notes |
|-----------------|-------------|-------------|-------|
| builder.ts (AgentBuilder fluent API) | @agenc/kernel | ~754 | Composition root |
| runtime.ts (AgentRuntime lifecycle) | @agenc/kernel | ~545 | Lifecycle wrapper |
| idl.ts (IDL + Program factories) | @agenc/protocol | ~162 | Depends on Anchor |
| index.ts (barrel exports — 460+ exports) | splits across all | ~2,011 | Each package gets its own barrel |

### MCP Client Bridge (→ @agenc/kernel)

| Current Location | New Package | Source Lines | Notes |
|-----------------|-------------|-------------|-------|
| mcp-client/ (connection, manager, resilient-bridge, tool-bridge, types) | @agenc/kernel | ~658 | External MCP server connections, tool bridging via stdio |

### CLI Commands (→ @agenc/kernel + @agenc/protocol)

| Current Location | New Package | Source Lines | Notes |
|-----------------|-------------|-------------|-------|
| cli/daemon.ts, cli/health.ts, cli/wizard.ts | @agenc/kernel | ~2,500 | Core daemon lifecycle CLI |
| cli/onboard.ts, cli/replay.ts, cli/jobs.ts, cli/logs.ts | @agenc/kernel | ~2,000 | General CLI commands |
| cli/sessions.ts, cli/security.ts | @agenc/kernel | ~1,000 | Session + security management |
| cli/skills.ts, cli/registry-cli.ts | @agenc/tools | ~1,400 | Skill management CLI |
| cli/types.ts, cli/index.ts | @agenc/kernel | ~500 | CLI infrastructure |
| bin/ (entry points) | @agenc/kernel | ~200 | agenc-runtime, daemon entry |

---

## 10. Cross-Cage Violation Register

All 21 violations from v4 are resolved by the v5 architecture. The resolution mechanism is the same for all: **modules depend on @agenc/core contracts, not on each other.**

| V# | Current Import | v4 Fix | v5 Fix |
|----|---------------|--------|--------|
| V1 | tools/registry → policy/engine | ToolPolicyHook interface | ServiceToken: POLICY_ENGINE resolved optionally |
| V2 | tools/registry → policy/mcp-governance | Move type to common | MCPToolCatalogPolicyConfig in @agenc/core |
| V3 | channels/* → gateway/types | Move types to common | GatewayMessage in @agenc/core |
| V4 | llm/grok → gateway/context-window | Move function | normalizeGrokModel stays in @agenc/providers |
| V5 | memory/ingestion → gateway/hooks | Move HookHandler to common | HookHandler in @agenc/core |
| V6 | voice/ → gateway/types | Move types to common | Session types in @agenc/core |
| V7 | desktop/ → gateway/types | Move types to common | Session types in @agenc/core |
| V8 | channels/* → gateway/message | Move types to common | GatewayMessage in @agenc/core |
| V9 | skills/jupiter → protocol calls | Move to AgenX bridge | Jupiter protocol code → @agenc/protocol |
| V10 | skills/monetization → protocol payments | Move to AgenX bridge | Monetization payments → @agenc/protocol |
| V11 | types/errors → @solana/web3.js | Move PublicKey types to AgenG | PublicKey context types → @agenc/protocol |
| V12 | types/wallet → @solana/web3.js | Move to AgenG | wallet.ts → @agenc/protocol |
| V13 | tools/social → social/ | Move to AgenX | tools/social/ → @agenc/social (registers own tools) |
| V14 | tools/marketplace → marketplace/ | Move to AgenX | tools/marketplace/ → @agenc/marketplace (registers own tools) |
| V15 | gateway/host-tooling → tools/system/bash | Interface extraction | Resolves TOOL_REGISTRY token |
| V16 | gateway/host-workspace → tools/system/bash | Interface extraction | Resolves TOOL_REGISTRY token |
| V17 | skills/markdown/injector → llm/chat-executor | Move SkillInjector to common | SkillInjector in @agenc/core |
| V18 | llm/chat-executor-planner → delegation-decision | Both move to same package | Both in @agenc/engine (or autonomous) |
| V19 | mcp-client/tool-bridge → policy/mcp-governance | Move type to common | MCPToolCatalogPolicyConfig in @agenc/core |
| V20 | memory/retriever → llm/chat-executor | Move MemoryRetriever to common | MemoryRetriever in @agenc/core |
| V21 | memory/backends → telemetry/metric-names | Move constants to common | TELEMETRY_METRIC_NAMES in @agenc/core |

**v5 resolves all violations by design** — the three-ring architecture makes cross-ring imports impossible because Ring 2 packages only depend on @agenc/core at compile time.

---

## 11. Migration Plan

### Phase 0: Foundation (2-3 weeks)

**Goal:** Create @agenc/core and the service registry. No files move yet.

1. **Create @agenc/core as a workspace package:**
   - Extract all shared interfaces from types/, utils/, constants
   - Define ServiceModule, ServiceRegistry, ServiceToken
   - Define TypedHookDispatcher with HookEventMap
   - Define all service tokens
   - Zero external deps

2. **Rewrite all imports to @agenc/core:**
   - AST-based codemod (jscodeshift), not sed
   - `from '../types/errors.js'` → `from '@agenc/core'`
   - `from '../utils/logger.js'` → `from '@agenc/core'`
   - This touches 600+ files

3. **Validate:**
   ```bash
   npm run typecheck && npm run test && npm run build
   ```

### Phase 1: Kernel Extraction (2-3 weeks)

**Goal:** Create @agenc/kernel. Extract daemon, gateway, sessions, hooks, config from the monolith.

1. **Create @agenc/kernel as a workspace package**
2. **Move files from gateway/ and cli/ to kernel**
3. **Implement ServiceRegistry (~200 lines)**
4. **Implement PluginLoader with lifecycle management (~500 lines)**
5. **Split daemon.ts into manager + bootstrap + wiring**
6. **Implement TypedHookDispatcher with compile-time checked events**
7. **Validate: daemon boots and runs a basic chat session**

### Phase 2: Core Service Extraction (3-4 weeks)

**Goal:** Extract Ring 1 packages. Each becomes a workspace package implementing ServiceModule.

Order (by dependency — extract leaves first):

| Order | Package | Risk | Effort |
|-------|---------|------|--------|
| 2.1 | @agenc/providers | LOW | 2 days — LLM adapters are already isolated |
| 2.2 | @agenc/memory | LOW | 2 days — backends are already isolated |
| 2.3 | @agenc/tools | MEDIUM | 3 days — skill system has some coupling |
| 2.4 | @agenc/protocol | MEDIUM | 3 days — many submodules (agent, task, dispute, etc.) |
| 2.5 | @agenc/engine | HIGH | 5 days — ChatExecutor has gateway + tool coupling |

**Critical:** @agenc/engine is extracted LAST because ChatExecutor imports from gateway/ and tools/. By this point, those imports are replaced with service token resolution.

### Phase 3: Extension Extraction (4-6 weeks)

**Goal:** Extract Ring 2 packages. Each implements ServiceModule.

| Tier | Packages | Risk | Effort |
|------|----------|------|--------|
| Tier 1 (zero coupling) | @agenc/voice, @agenc/desktop, @agenc/bridges | LOW | 1 week |
| Tier 2 (minimal coupling) | @agenc/channels, @agenc/replay, @agenc/eval | LOW | 1 week |
| Tier 3 (some coupling) | @agenc/workflow, @agenc/social, @agenc/marketplace, @agenc/team | MEDIUM | 2 weeks |
| Tier 4 (most coupling) | @agenc/autonomous, @agenc/policy | HIGH | 2 weeks |

@agenc/autonomous is the hardest extension because it absorbs background runs (12.5K) + delegation (5.8K) + current autonomous/ (8K). But these files are internally cohesive and have low coupling to other gateway files.

### Phase 4: Separate Repos (2-3 weeks)

Once all packages work as workspace packages:

1. Create individual repos
2. Move package source to its repo
3. Publish to npm
4. Set up cross-repo CI triggers
5. Update AgenC program repo to consume published packages

### Phase 5: Polish (ongoing)

1. Per-module Zod config schemas
2. Plugin SDK documentation for third-party developers
3. ESLint boundary enforcement rules
4. Incremental builds with TypeScript project references
5. Affected-only test execution

### Migration Invariants

- **Zero test regression at every phase** — full suite after each extraction
- **No breaking public API** — @agenc/kernel re-exports all packages during migration
- **AST-based import rewriting** — never use sed
- **One package extracted per PR** — reviewable diffs, easy to revert

---

## 12. Test Migration Strategy

### Test Distribution

| Package | Test Files | Test Lines | Difficulty |
|---------|-----------|------------|------------|
| @agenc/core | ~12 | ~2,500 | LOW — pure types/utils |
| @agenc/kernel | ~35 | ~12,000 | HIGH — daemon/gateway integration (daemon.test.ts alone is 3,829 lines) |
| @agenc/engine | ~18 | ~18,000 | HIGH — ChatExecutor (11,142 lines in chat-executor.test.ts), tool handler tests |
| @agenc/providers | ~6 | ~3,000 | LOW — isolated adapters |
| @agenc/memory | ~12 | ~4,100 | LOW — isolated backends |
| @agenc/tools | ~20 | ~8,600 | MEDIUM — system tool tests, skill adapter |
| @agenc/protocol | ~50 | ~20,000 | MEDIUM — task/ alone has 16,386 test lines |
| @agenc/channels | ~16 | ~6,100 | LOW — isolated plugins |
| @agenc/desktop | ~5 | ~2,600 | LOW — isolated |
| @agenc/voice | ~2 | ~500 | LOW — isolated |
| @agenc/autonomous | ~30 | ~14,000 | HIGH — background runs (5,678), subagent orchestrator (3,465) |
| @agenc/workflow | ~10 | ~2,700 | MEDIUM |
| @agenc/social | ~7 | ~4,400 | LOW |
| @agenc/marketplace | ~3 | ~1,300 | LOW |
| @agenc/team | ~3 | ~960 | LOW |
| @agenc/policy | ~10 | ~2,300 | MEDIUM |
| @agenc/eval | ~20 | ~6,200 | LOW — self-contained |
| @agenc/replay | ~4 | ~1,600 | LOW |
| @agenc/bridges | ~3 | ~490 | LOW |

### Shared Test Utilities

Create `@agenc/test-utils` as a dev-only package:
- Mock ServiceRegistry
- Mock HookDispatcher
- Mock MemoryBackend, LLMProvider, ToolHandler
- Test config builders
- Assertion helpers

### Integration Tests

The 18 test files in `/tests/` (LiteSVM-based, ~140 tests) stay in the AgenC program repo. They test SDK + on-chain program, not the runtime.

A new integration test suite in @agenc/kernel validates cross-package wiring: boot daemon → load all core services → send a message → verify tool call → verify response.

---

## 13. Naming & Branding

The v4 naming (AgenA, AgenB, AgenX, etc.) was arbitrary and unmemorable. Nobody can remember what AgenB is.

v5 uses **descriptive package names**:

| v4 Name | v5 Package | Why |
|---------|-----------|-----|
| @agenc/common | @agenc/core | "Core" is standard for foundation packages |
| AgenX (@agenc/runtime) | @agenc/kernel | It's the kernel. That's what it does. |
| — | @agenc/engine | New. The execution engine. |
| AgenB (@agenc/llm) | @agenc/providers | They're provider adapters, not "LLM" |
| AgenA (@agenc/tools) | @agenc/tools | Same — this name was already good |
| AgenG (@agenc/protocol) | @agenc/protocol | Same — already good |
| AgenF (@agenc/channels) | @agenc/channels | Same |
| AgenD (@agenc/desktop) | @agenc/desktop | Same |
| AgenE (@agenc/voice) | @agenc/voice | Same |
| AgenC (@agenc/sdk) | @agenc/sdk | Unchanged |

If brand names are wanted for marketing, use them externally. Package names should be self-documenting.

---

## 14. v4 vs v5 Comparison

| Dimension | v4 (Cage Architecture) | v5 (OS/Kernel Architecture) |
|-----------|----------------------|---------------------------|
| Packages | 9 (common + 8 cages) | 19 (core + kernel + 5 services + 12 extensions) |
| Orchestrator size | 120,600 lines (62%) | 18,000 lines (10%) |
| Coupling model | "Cages never import AgenX" | Three-ring model with typed service tokens |
| Plugin contract | Aspirational (CagePlugin) | First-class (ServiceModule with lifecycle) |
| Hook system | Untyped (Record<string, unknown>) | Typed (HookEventMap, compile-time checked) |
| Dependency injection | Manual wiring in daemon.ts | ServiceRegistry with typed tokens |
| Boundary enforcement | Convention only | TypeScript project references + ESLint rules |
| Failure isolation | None (shared process, no boundaries) | Ring 2 failures don't crash kernel |
| Lazy loading | Not addressed | Config-driven dynamic import() |
| Config validation | Loose types | Zod schemas per module |
| Bidirectional cycles | 21 violations to fix manually | Eliminated by architecture (Ring 2 → core only) |
| Migration effort | Phase 0: 10-14 days | Phase 0: 2-3 weeks (but more thorough) |
| Total migration | ~4-6 months | ~4-6 months |

**The fundamental difference:** v4 extracts leaves from a monolith. v5 hollows out the monolith into a thin kernel and pushes everything to plugins. Same total effort, fundamentally different result.

---

## 15. Non-Runtime Directory Plan

The v5 refactor focuses on the `runtime/src/` monolith, but the AgenC repo contains other directories that need clear disposition.

### Stays in AgenC Program Repo (unchanged)

These directories are tied to the Anchor program and SDK — they don't move.

| Directory | Lines | Reason |
|-----------|-------|--------|
| `programs/agenc-coordination/` | ~20K Rust | The Anchor program itself |
| `sdk/` | ~8K TS source | @agenc/sdk wraps the program. No structural change. |
| `zkvm/` (guest + host + methods) | ~3K Rust | RISC Zero crates — Rust workspace tied to program build |
| `tests/` (18 LiteSVM test files) | ~18K TS | Integration tests for SDK + on-chain program |
| `mcp/` (@agenc/mcp) | ~8K TS source | MCP server — depends on SDK + runtime. Stays as @agenc/mcp in program repo, updated to import from v5 packages. |
| `docs-mcp/` | ~2K TS source | Dev tooling for architecture doc lookups. Stays. |
| `demo-app/` | React app | ZK workflow demo. Stays. |
| `demo/` | ~600 TS | Demo scripts (e2e_devnet_test, private_task_demo). Stays. |
| `scripts/` | ~2.2K | Build/deploy scripts for program. Stays. |
| `docs/` | ~200KB markdown | Architecture docs. Stays, updated to reflect v5 package structure. |
| `migrations/` | ~450 lines | Protocol migration tools. Stays. |
| `containers/` | Docker + ~5K | Desktop sandbox Docker images. Stays — @agenc/desktop references these images at runtime. |
| `patches/` | ~5 lines | npm patch files. Stays with root workspace. |

### Moves to Separate Repos (Phase 4)

| Directory | New Repo | Timing |
|-----------|----------|--------|
| `web/` | `tetsuo-ai/agenc-web` | Phase 4 (after all packages are workspace-stable) |
| `mobile/` | `tetsuo-ai/agenc-mobile` | Phase 4 (same batch as web) |

### Examples Migration

`examples/` (10 projects) stays in AgenC repo during Phases 0-3. In Phase 4:
- Each example migrates to the most relevant package repo (e.g., `autonomous-agent` → `@agenc/autonomous`, `skill-jupiter` → `@agenc/tools`)
- A new `@agenc/examples` repo collects cross-package examples
- The AgenC repo keeps only SDK/program-level examples (`simple-usage`, `risc0-proof-demo`)

### @agenc/mcp Adaptation

The MCP server (`mcp/`) currently imports from `@agenc/runtime` (the monolith). During migration:
- Phase 2: Update MCP imports from `@agenc/runtime` → individual packages (`@agenc/core`, `@agenc/protocol`, `@agenc/tools`)
- The MCP server stays in the AgenC repo because it depends on both the SDK and runtime packages — it's a consumer, not a module being extracted
- If it grows significantly, it can move to its own repo in Phase 4

### containers/ and @agenc/desktop Relationship

- `containers/desktop/` = the Docker image (Dockerfile, supervisord, REST API server, seccomp profile). Stays in AgenC repo.
- `@agenc/desktop` = the runtime manager layer (DesktopSandboxManager, session router, health, REST bridge). Extracted to separate repo.
- @agenc/desktop references the Docker image by tag (`agenc/desktop:latest`) at runtime, not at build time. No circular dependency.

---

## 16. Risks & Mitigations

### R1: Service Registry Overhead

**Risk:** Typed token resolution adds indirection.
**Reality:** It's a Map lookup. Microsecond overhead. seL4 does capability resolution on every system call at ~0.2μs on ARM64. A TypeScript Map.get() is negligible.

### R2: Over-Modularization

**Risk:** 19 packages for a small team.
**Mitigation:** Most extension packages (voice, desktop, bridges, team, replay) are stable and rarely touched. Active development happens in 4-5 packages at a time. The package boundary prevents accidental coupling — that's the point.

### R3: ChatExecutor Split Complexity

**Risk:** ChatExecutor (30 files, 14.3K lines) moving from llm/ to @agenc/engine while breaking gateway imports.
**Mitigation:** Phase 2.5 (engine extraction) happens LAST after all other core services are extracted. By then, all gateway types ChatExecutor imported have been replaced with @agenc/core contracts.

### R4: Background Runs in Autonomous

**Risk:** Background run supervisor + helpers (~14K source lines) is deeply wired into daemon.ts.
**Mitigation:** The gateway deep dive confirmed background-run-* files have LOW internal coupling — only daemon.ts imports them. Extraction to @agenc/autonomous means one wiring change in the kernel's bootstrap.

### R5: Protocol Package Size

**Risk:** @agenc/protocol at ~22K source lines is big for a single package. Task module alone is 11K.
**Mitigation:** It's cohesive — all Solana operations. If it grows past 30K, split into @agenc/protocol-core (agent, task) and @agenc/protocol-extensions (governance, reputation, dispute). Task's speculative executor subsystem (~6K) could also extract to @agenc/autonomous if it grows further.

### R5.1: Task Module Complexity

**Risk:** task/ at 11K source (27K with tests) is the largest protocol submodule, containing speculative execution, proof pipeline, checkpoints, DLQ, rollback, dependency graph, and priority queue.
**Mitigation:** These subsystems are internally cohesive. The speculative executor depends on task operations. If task/ grows past 15K source, split into @agenc/protocol-tasks (core ops) and @agenc/protocol-execution (speculative, checkpoints, DLQ).

### R6: Third-Party Plugin Development

**Risk:** The ServiceModule contract needs to be simple enough for third-party devs.
**Mitigation:** The contract is 6 fields (name, version, ring, requires, register, start/stop). Compare to VS Code extensions (20+ manifest fields) or Home Assistant (10+ manifest fields). This is minimal.

### R7: Migration Import Breakage

**Risk:** AST-based rewriting of 600+ files could introduce subtle bugs.
**Mitigation:** Every import rewrite is validated by `npm run typecheck`. If it compiles, the imports are correct. Run full test suite after each batch of rewrites.

---

## Appendix A: Research Sources

| Source | Key Takeaway |
|--------|-------------|
| Linux LKM | Loadable modules with shared address space + well-defined internal APIs |
| seL4 microkernel | Capability-based access control, explicit typed tokens for every resource |
| QNX microkernel | Everything outside kernel is a service process; 5-10% IPC overhead |
| VS Code extensions | Extension host process, activation events, contribution points, lazy loading |
| webpack Tapable | Typed hook system with Sync/Async/Bail/Waterfall semantics |
| Grafana plugins | gRPC process isolation for backend plugins, manifest-driven discovery |
| Home Assistant | 5000+ integrations via manifest + coordinator pattern |
| OpenAI Agents SDK | 4 primitives (Agent, Tool, Guardrail, Handoff), minimal core |
| Anthropic Agent SDK | 4-phase loop, subagent isolation, automatic compaction |
| AgentForge (IEEE 2026) | 4-layer architecture, formal skill contracts, 62-78% dev time reduction |
| Auton framework (2026) | Blueprint/runtime split, constraint manifold, hierarchical memory |
| LangGraph | Graph-based state machines, channels with reducers, built-in checkpointing |

## Appendix B: Verified Line Counts (2026-03-11 audit)

All source counts measured via `find DIR -name '*.ts' ! -name '*.test.ts' ! -name '*.test-utils.ts' | xargs wc -l`.

| Directory | Source Lines | With Tests | Source Files |
|-----------|-------------|------------|--------------|
| gateway/ | 51,614 | 88,098 | 69 source, 67 test |
| llm/ (ChatExecutor + providers) | ~~14,268~~ **21,080** | 24,000+ | ~~36~~ **38** source, 25 test |
| tools/ (all subdirs, incl. tools/x/) | ~~15,450~~ **18,208** | 27,871 | ~~42~~ **40** source, 20 test |
| skills/ | 5,776 | 11,288 | 26 source, 17 test |
| memory/ | 4,728 | 8,832 | 18 source, 12 test |
| channels/ | 7,204 | 13,309 | 26 source, 16 test |
| autonomous/ | 7,907 | 13,378 | 27 source, 18 test |
| workflow/ | 5,012 | 7,703 | 14 source, 10 test |
| agent/ | 2,842 | 5,460 | 10 source, 8 test |
| task/ | 11,065 | 27,451 | 20 source, 24 test |
| dispute/ | ~~1,500~~ **1,344** | 2,489 | ~~6~~ **5** source, 4 test |
| events/ | 3,504 | 6,823 | 10 source, 8 test |
| connection/ | 921 | 1,942 | 4 source, 4 test |
| proof/ | 722 | 1,466 | 5 source, 3 test |
| governance/ | 802 | 1,420 | 5 source, 3 test |
| reputation/ | 800 | 1,524 | 4 source, 3 test |
| social/ | 4,127 | 8,502 | 16 source, 7 test |
| marketplace/ | 2,267 | 3,577 | 7 source, 3 test |
| team/ | 2,221 | 3,184 | 8 source, 3 test |
| policy/ | 4,691 | 6,981 | 14 source, 10 test |
| eval/ | 11,501 | 17,700 | 35 source, 20 test |
| replay/ | 2,978 | 4,580 | 11 source, 4 test |
| bridges/ | 638 | 1,124 | 6 source, 3 test |
| desktop/ | 3,616 | 6,182 | 9 source, 5 test |
| voice/ | 1,554 | 2,056 | 9 source, 2 test |
| telemetry/ | 575 | 915 | 4 source, 2 test |
| observability/ | 1,157 | 1,550 | 4 source, 2 test |
| types/ | 14,841 | 16,723 | 7 source, 4 test |
| utils/ | 3,674 | 6,823 | 12 source, 8 test |
| cli/ | 7,398 | 10,624 | 13 source, 6 test |
| mcp-client/ | 658 | 1,118 | 5 source, 3 test |
| bin/ | ~~200~~ **97** | ~200 | 2 source |
| Top-level (builder, runtime, idl, index) | 3,472 | 3,472 | 4 source |
| **Runtime Total** | **~209,284** | **~357,201** | **510 source** |

**Note:** `types/agenc_coordination.ts` (11,936 lines) is auto-generated from the Anchor IDL and inflates the types/ count. It moves to @agenc/protocol as-is.

---

## 17. Audit Corrections (2026-03-11 — 9-Agent Deep Audit)

A 9-agent, 3-phase audit crawled every file in `runtime/src/` against this proposal. Agents: Inventory, Import Tracer, Export Auditor, Non-Runtime Scanner, File Assignment Verifier, Dependency Graph Verifier, Contract Completeness Checker, Devil's Advocate, Migration Feasibility Auditor.

**Audit verdict: NEEDS_MAJOR_REVISION** — The three-ring architecture is sound conceptually, but the dependency matrix (§7), file assignments (§9), and cycle-breaking strategy (§8) undercount actual cross-boundary runtime function calls. The proposal identifies 4 cycles; the codebase has at least 6. Multiple runtime functions (not just types) must relocate to @agenc/core for the ring model to work.

### 17.1 Critical Line Count Corrections

| Item | Proposal Claimed | Actual Verified | Impact |
|------|-----------------|----------------|--------|
| llm/ source | 14,268 (36 files) | **21,080** (38 files) | @agenc/engine and @agenc/providers estimates wrong |
| tools/ source | 15,450 (42 files) | **18,208** (40 files) | @agenc/tools estimate wrong |
| llm/anthropic/ adapter | ~2,000 lines | **Does not exist** | @agenc/providers inflated by 2K phantom lines |
| types/errors.ts split | ~1,500 + ~2,500 = 4,000 | **1,411 total** | @agenc/protocol inflated by ~2,589 phantom lines |
| @agenc/kernel size | ~18K | **~27K** (daemon.ts 9,633 + cli/index.ts 3,251 + others) | Blows 10% budget — daemon.ts split mandatory |
| @agenc/providers size | ~9K | **~3.4K** | No anthropic adapter; only grok + ollama + fallback |
| @agenc/voice size | ~2K | **~3K** | voice-bridge.ts (1,066) + media.ts (384) not counted |
| Runtime total | ~200,000 | **~209,284** | 4.6% undercount |
| Total source files | ~530+ | **510** | |
| dispute/ source | 1,500 (6 files) | **1,344** (5 files) | Minor |
| bin/ source | ~200 | **97** | Minor |

### 17.2 Missing Files / Directories Not in Proposal

| File | Lines | Correct Package |
|------|-------|----------------|
| `tools/x/index.ts` + `tools/x/tools.ts` | 858 | @agenc/tools (X/Twitter API tools, PR #1257) |
| `cli/foreground-log-tee.ts` | 92 | @agenc/kernel |
| `cli/test-utils.ts` | 26 | @agenc/test-utils (dev-only) |
| `utils/numeric.ts` | 44 | @agenc/core |
| `utils/collections.ts` | 25 | @agenc/core |
| `utils/keyed-async-queue.ts` | 50 | @agenc/core |
| `utils/trace-payload-store.ts` | 55 | @agenc/kernel (consumed by kernel + engine) |
| `utils/delegated-contract-normalization.ts` | 234 | @agenc/engine (co-located with delegation-validation split) |
| `observability/trace-log-fanout.ts` | 190 | @agenc/kernel |
| `observability/types.ts` | 122 | @agenc/kernel |
| `observability/errors.ts` | 8 | @agenc/kernel |

**File name corrections:**
- Proposal says `cli/skills.ts` → actual is `cli/skills-cli.ts`
- Proposal says "17 chat-executor source files" → actual is **15**

### 17.3 Additional Cycles to Break (Beyond §8's Four)

**Cycle 5: llm ↔ workflow — CRITICAL (unaddressed)**

6 llm/ files import ~20 types + functions from workflow/pipeline.ts. llm/ is @agenc/engine (Ring 1), workflow/ is @agenc/workflow (Ring 2). Ring 1 cannot import Ring 2.

Key imports: `PipelineStep`, `Pipeline`, `PipelineResult`, `PipelinePlannerContext`, `PipelineExecutionOptions`, `WorkflowGraphEdge`

**Resolution options:**
- (a) Move Pipeline types/interfaces to @agenc/core, PipelineExecutor class to @agenc/engine → workflow becomes a thin DAG/compiler layer
- (b) Promote @agenc/workflow to Ring 1
- (c) Extract pipeline types to @agenc/core, keep executor in @agenc/workflow, inject via ServiceToken

**Cycle 6: eval ↔ replay — CRITICAL (unaddressed)**

Bidirectional runtime function calls:
- replay → eval: `projectOnChainEvents` (runtime function), `stableStringifyJson`, `ProjectedTimelineEvent`
- eval → replay: `replay/types.js`, `replay/trace.js`, `replay/alerting.js`

**Resolution options:**
- (a) Merge @agenc/eval and @agenc/replay into @agenc/eval
- (b) Extract `stableStringifyJson`/`JsonValue` + `projectOnChainEvents`/`ProjectedTimelineEvent` to @agenc/core

### 17.4 Ring Violations Not in V1-V21

| V# | Import | Severity | Resolution |
|----|--------|----------|------------|
| V22 | llm/chat-executor-planner → workflow/pipeline (Ring 1→2) | CRITICAL | Move Pipeline types to @agenc/core |
| V23 | llm/chat-executor-planner → tools/system/command-line (Ring 1→1 horizontal) | HIGH | Move `collectDirectModeShellControlTokens` to @agenc/engine |
| V24 | llm/chat-executor-contract-guidance → tools/system/typed-artifact-domains (Ring 1→1) | HIGH | Move consumed exports to @agenc/engine |
| V25 | autonomous → eval (Ring 2→2): `evaluateBackgroundRunQualityGates` | HIGH | Move quality gate functions to @agenc/autonomous |
| V26 | autonomous → policy (Ring 2→2): `PolicyEngine` class | HIGH | Extract PolicyEngine interface to @agenc/core |
| V27 | social → team (Ring 2→2): `TeamContractEngine` class | HIGH | Extract interface to @agenc/core or merge packages |
| V28 | team → workflow (Ring 2→2): `OnChainDependencyType`, `validateWorkflow` | MEDIUM | Move OnChainDependencyType to @agenc/core |
| V29 | replay → eval (Ring 2→2): `projectOnChainEvents`, `stableStringifyJson` | HIGH | See Cycle 6 above |
| V30 | policy → eval (Ring 2→2): `stableStringifyJson`, `JsonValue` | MEDIUM | Move to @agenc/core |
| V31 | workflow → policy (Ring 2→2): `PolicyEngine` class | MEDIUM | See V26 |
| V32 | tool-handler-factory → policy/types (Ring 1→2) | HIGH | Extract `PolicyEvaluationScope`, `SessionCredentialBroker` to @agenc/core |
| V33 | gateway/types.ts → desktop/types.ts + social/types.ts | MEDIUM | Config section registry pattern (§17.7) |
| V34 | autonomous → gateway/heartbeat (Ring 2→kernel) | MEDIUM | Move HeartbeatAction/Context/Result interfaces to @agenc/core |
| V35 | autonomous → llm/provider-trace-logger (Ring 2→1 runtime function) | HIGH | Move createProviderTraceEventLogger to @agenc/core or use DI |

### 17.5 Missing Types in @agenc/core

The following must be in `@agenc/core/types/` for the ring model to compile:

**LLM type tree (required by LLMProvider interface):**
- `LLMChatOptions`, `LLMChatStatefulOptions`, `LLMChatToolRoutingOptions`, `LLMChatTraceOptions`
- `LLMStatefulResponsesConfig`, `LLMProviderCapabilities`, `LLMProviderStatefulCapabilities`
- `LLMStreamChunk`, `StreamProgressCallback`, `LLMToolChoice`, `LLMUsage`
- `MessageRole`, `LLMAssistantPhase`, `LLMContentPart`
- Total: ~200 lines not accounted for in the §4 directory tree

**Hook payload types:**
- `ToolCallRecord` — currently in llm/chat-executor-types.ts. MUST be in core or HookEventMap creates Ring 0→Ring 1 dependency
- `ConfigDiff` — currently in gateway/types.ts. Referenced by HookEventMap `config:reload` payload
- `HeartbeatResult` — currently in gateway/heartbeat.ts. Referenced by HookEventMap `heartbeat:after` payload

**Missing hook event:**
- `agent:bootstrap` — defined in HookEvent type (gateway/hooks.ts line 23) but missing from proposal's HookEventMap (§5 lists 15 events, codebase has 16)

**Cross-package interfaces needed:**
- `PolicyEngine` interface (consumed by autonomous, workflow, policy-gate)
- `TeamContractEngine` interface (consumed by social)
- `ApprovalEngine` interface (consumed by workflow, autonomous)
- `ProactiveCommunicator` interface (consumed by autonomous)
- `ProgressTracker` interface (consumed by workflow)
- `DelegationDecompositionSignal` interface (consumed by workflow, engine)
- `HeartbeatAction`, `HeartbeatContext` interfaces (consumed by autonomous)

### 17.6 Missing ServiceTokens

Add to §5 ServiceToken list:

| Token | Type | Needed By |
|-------|------|-----------|
| `PROOF_ENGINE` | ProofEngine interface | @agenc/autonomous, AgentBuilder |
| `EVENT_MONITOR` | EventMonitor interface | @agenc/replay, AgentRuntime |
| `SOCIAL_MODULE` | SocialModule interface | @agenc/kernel (daemon), tools/social |
| `REPLAY_STORE` | ReplayStore interface | @agenc/kernel (daemon), @agenc/eval, cli |
| `EVAL_RUNNER` | EvalRunner interface | @agenc/kernel (daemon), @agenc/autonomous |
| `TEAM_ENGINE` | TeamContractEngine interface | @agenc/social, @agenc/workflow |

### 17.7 Config Section Registry Pattern (New Requirement)

`GatewayConfig` currently imports `DesktopSandboxConfig` from desktop/types.ts and `SocialPeerDirectoryEntry` from social/types.ts. Moving GatewayConfig to @agenc/core would drag Ring 2 types into Ring 0.

**Required pattern:** Each ServiceModule declares its config Zod schema during `register()`. The kernel's config loader merges all module schemas into a composite schema for full-file validation. GatewayConfig in @agenc/kernel defines the base shape with extensible sections (e.g., `Record<string, unknown>` or Zod `.passthrough()`). Extension config types stay in their packages.

### 17.8 Runtime Functions That Must Relocate to @agenc/core

These are not type-only — they are concrete function calls that cannot be resolved via ServiceToken:

| Function | Current Location | Lines | Consumed By | Recommendation |
|----------|-----------------|-------|------------|----------------|
| `safeStringify` | tools/types.ts | ~101 | 35+ files across 8 modules | @agenc/core/utils/safe-stringify.ts |
| `stableStringifyJson` + `JsonValue` | eval/types.ts | ~50 | 6+ modules (policy, replay, workflow, cli, autonomous) | @agenc/core/utils/stable-stringify.ts |
| `entryToMessage` + `messageToEntryOptions` | memory/types.ts | ~40 | llm/executor.ts, memory/ | @agenc/core (bridge between MemoryEntry + LLMMessage) |
| `didToolCallFail` + `extractToolFailureTextFromResult` | llm/chat-executor-tool-utils.ts | ~50 | workflow/pipeline.ts | @agenc/core/utils/ or @agenc/engine |
| `collectDirectModeShellControlTokens` | tools/system/command-line.ts | ~30 | llm/chat-executor-planner.ts | @agenc/engine (ChatExecutor heuristic) |
| `projectOnChainEvents` | eval/projector.ts | ~200 | replay/bridge.ts, replay/backfill.ts | @agenc/core or @agenc/protocol |

### 17.9 Corrected Dependency Matrix (§7 Update)

The current §7 matrix shows all Ring 1 packages depending ONLY on @agenc/core. Actual dependencies:

| Package | @agenc/core | @agenc/kernel | @agenc/engine | @agenc/providers | @agenc/memory | @agenc/tools | @agenc/protocol |
|---------|:-----------:|:-------------:|:-------------:|:----------------:|:-------------:|:------------:|:---------------:|
| @agenc/engine | **YES** | | | | type-only† | runtime‡ | | |
| @agenc/providers | **YES** | | | | | | |
| @agenc/memory | **YES** | | | | | | |
| @agenc/tools | **YES** | | | | | | |
| @agenc/protocol | **YES** | | | | | | |

†engine imports `entryToMessage`/`MemoryGraph` from memory — must be moved to core for this row to be clean
‡engine imports `safeStringify` + `collectDirectModeShellControlTokens` from tools — must be moved to core/engine

**After relocations in §17.8:** All Ring 1 packages will depend only on @agenc/core. The relocations are prerequisites for Phase 0.

### 17.10 daemon.ts Rewrite Scope (§11 Phase 1 Update)

The current daemon.ts has ~200+ direct import lines that create compile-time dependencies on Ring 1 and Ring 2 packages:

- 7 static channel class imports (TelegramChannel, DiscordChannel, etc.)
- 15+ tool factory imports (createBashTool, createHttpTools, etc.)
- Direct ChatExecutor instantiation
- Direct PolicyEngine wiring
- Direct eval/ imports (evaluateBackgroundRunQualityGates, etc.)
- Direct memory backend creation
- Direct social component wiring (5 sub-components)

All of these must be converted to ServiceModule registration + ServiceToken resolution. This is the single largest rewrite in the migration. Phase 1's "Move files from gateway/ and cli/ to kernel" understates the effort — it should explicitly scope the daemon.ts wiring rewrite as a distinct sub-phase.

### 17.11 cli/index.ts Split (New Requirement)

`cli/index.ts` (3,251 lines) imports from eval/, tools/, skills/, gateway/, and protocol/. It cannot reside purely in @agenc/kernel without compile-time access to Ring 1 and Ring 2 packages.

**Required approach:** Split CLI subcommands across packages:
- @agenc/kernel: daemon, health, wizard, sessions, security, onboard, jobs, logs commands
- @agenc/tools: skills, registry-cli commands
- @agenc/eval: replay, benchmark commands
- Thin CLI dispatcher in @agenc/kernel loads subcommands dynamically via ServiceModule registration

### 17.12 Files That Need Package Reassignment

| File | Current Assignment | Correct Assignment | Reason |
|------|-------------------|-------------------|--------|
| `gateway/delegation-scope.ts` | @agenc/autonomous | **@agenc/engine** | Consumed by chat-executor-planner.ts (Ring 1) |
| `gateway/delegation-timeout.ts` | @agenc/autonomous | **@agenc/engine** | Consumed by chat-executor-planner.ts (Ring 1) |
| `utils/delegation-validation.ts` | @agenc/protocol or @agenc/autonomous | **Split**: interfaces→@agenc/core, impl→@agenc/engine, wrappers→@agenc/autonomous | Imports from llm/, consumed by both engine and autonomous |
| `utils/trace-payload-store.ts` | @agenc/protocol | **@agenc/kernel** | Consumed by kernel + engine, not protocol |
| `utils/trace-payload-serialization.ts` | @agenc/protocol | **@agenc/core** | Pure serialization utility, consumed by 4+ modules |
| `llm/provider-trace-logger.ts` | @agenc/core | **@agenc/kernel** | Imports from observability (cannot be in zero-dep core) |
| `utils/pda.ts` | @agenc/core | **@agenc/protocol** | Depends on @solana/web3.js (violates core zero-deps) |
| `types/media.ts` (STT/TTS types) | @agenc/core | **@agenc/voice** | Only used by voice (2 files, 1 package) — over-extraction |

### 17.13 Missing Risks (§16 Update)

**R8: Phantom Line Counts**
Risk: Package sizing based on incorrect line counts leads to wrong phase durations.
Mitigation: Rerun all counts with verified `find | xargs wc -l` before Phase 0. This audit's §17.1 provides corrected numbers.

**R9: eval ↔ replay Bidirectional Cycle**
Risk: These two packages cannot be separated without extracting shared runtime functions.
Mitigation: Either merge into @agenc/eval or extract `projectOnChainEvents` + `stableStringifyJson` to @agenc/core in Phase 0.

**R10: daemon.ts Wiring Rewrite Scale**
Risk: 200+ direct imports in daemon.ts make Phase 1 (kernel extraction) significantly larger than estimated.
Mitigation: Scope daemon.ts rewrite as a dedicated sub-phase with its own validation checkpoint.

**R11: Ring 2 Graceful Degradation**
Risk: No defined behavior when a Ring 2 module fails to start or throws during hook execution.
Mitigation: Define `onStartFailure: "abort" | "disable" | "retry"` and `onHookFailure: "propagate" | "isolate"` in ServiceModule contract.

**R12: Backward Compatibility During Migration**
Risk: 460+ exports in index.ts spanning 19 packages — consumers (MCP server, web app, mobile, examples) break on first extraction.
Mitigation: Create `@agenc/runtime` compatibility meta-package that re-exports from all 19 packages for at least 2 major versions.

**R13: Build Tooling for 19 Packages**
Risk: Current tsup config has 15+ externals. 19 packages need coordinated builds, version management, and cross-repo CI.
Mitigation: Use npm workspaces during Phases 0-3 (monorepo), move to separate repos only in Phase 4. Define turborepo/nx build orchestration before Phase 4.

**R14: Ring 1→Ring 1 Horizontal Dependencies**
Risk: The §7 dependency matrix claims Ring 1 packages depend only on @agenc/core. In reality, engine needs runtime functions from tools and memory.
Mitigation: The §17.8 function relocations are prerequisites for Phase 0. Until those are done, the ring model does not hold.

### 17.14 Corrected Package Sizes (Summary)

| Package | Original Estimate | Corrected Estimate | Delta |
|---------|------------------|-------------------|-------|
| @agenc/core | ~5K | ~7-8K | +2-3K (LLMChatOptions tree, ToolCallRecord, Pipeline types, stableStringifyJson, cross-package interfaces) |
| @agenc/kernel | ~18K | ~27K (pre-split), ~20K (post daemon.ts split) | +2-9K |
| @agenc/engine | ~16K | ~17.5K | +1.5K |
| @agenc/providers | ~9K | ~3.4K | **-5.6K** (phantom anthropic adapter) |
| @agenc/memory | ~5K | ~4.7K | -300 |
| @agenc/tools | ~21K | ~22K | +1K (tools/x/) |
| @agenc/protocol | ~22K | ~20K | -2K (errors.ts inflation removed) |
| @agenc/voice | ~2K | ~3K | +1K (voice-bridge + media) |
| @agenc/bridges | ~1K | ~638 | -362 |

All other packages within ±10% of estimates.

### 17.15 Audit Agent Results Archive

Full agent outputs archived at:
- Phase 1: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/a3a7c70da781f3176.output` (Inventory)
- Phase 1: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/af6591e821d313d93.output` (Import Tracer)
- Phase 1: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/a6702a6ddb690502c.output` (Export Auditor)
- Phase 1: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/a31c7c4cf04e6ab73.output` (Non-Runtime Scanner)
- Phase 2: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/a340e620d2acaddce.output` (File Assignment Verifier)
- Phase 2: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/aa37b2bc033c652a1.output` (Dependency Graph Verifier)
- Phase 2: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/a32fab3f71df89c7a.output` (Contract Completeness)
- Phase 3: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/ae991463031e16a21.output` (Devil's Advocate)
- Phase 3: `/tmp/claude-1000/-home-tetsuo-git-AgenC/tasks/aafff75bc94d9b145.output` (Migration Feasibility — complete)

### 17.16 Migration Feasibility Findings (Phase 3 Agent — Completed)

**Verdict: FEASIBLE_WITH_CHANGES** — The three-ring architecture is sound, but the proposal cannot be executed as written.

#### 17.16.1 Phase 0 (@agenc/core) Is Underscoped

@agenc/core must grow from the estimated ~5K to ~7-8K lines. In addition to the types listed in §17.5, the following must be extracted in Phase 0:

- `WorkflowGraphEdge` (workflow/types.ts) — consumed by 3 llm/ files in @agenc/engine
- `Pipeline`, `PipelineResult`, `PipelineExecutionOptions`, `PipelinePlannerStep`, `PipelinePlannerContext` — consumed by `DeterministicPipelineExecutor` interface in chat-executor-types.ts
- `stableStringifyJson` / `JsonValue` (eval/types.ts) — consumed by 4 separate Ring 2 packages
- Config extension pattern (Zod schema registration per ServiceModule)
- Monorepo tooling selection (npm workspaces + turborepo recommended)
- Backward-compat `@agenc/runtime` meta-package definition

**Revised Phase 0 estimate:** 3-4 weeks (was 2-3).

#### 17.16.2 Phase Ordering Dependencies

| Blocking Dependency | Source Phase | Target Phase | Resolution |
|---------------------|-------------|-------------|------------|
| Engine needs workflow types | Phase 2.5 (engine) | Phase 0 (core) | Extract Pipeline/WorkflowGraphEdge types to core in Phase 0 |
| Channels need BaseChannelPlugin | Phase 3 Tier 2 (channels) | Phase 1 (kernel) | Extract `ChannelPlugin` interface to core; keep `BaseChannelPlugin` convenience class in kernel |
| Ring 2×Ring 2 cross-deps must be resolved | Phase 3 (all Ring 2) | No phase addresses this | Add Phase 2.5b: resolve all Ring 2 cross-imports before extraction |
| CI pipeline scripts import from eval/ | Phase 4 (separate repos) | No phase addresses this | CI migration must be in Phase 4, not Phase 5 polish |
| ServiceModule boot order | Phase 1 + Phase 2 | No phase defines this | Define boot order constraints + test coverage for dependency resolution failures |
| 6 missing ServiceTokens | Phase 0 (token defs) | Phase 2-3 (service wiring) | Add missing tokens to Phase 0 |

**Recommended phase adjustment:** Add explicit Phase 2.5b (Ring 2 cross-dep resolution) between engine extraction and Ring 2 extraction.

#### 17.16.3 Test Migration Gaps

| Gap | Impact | Resolution |
|-----|--------|------------|
| Cross-package integration tests (`builder.test.ts`, `runtime.test.ts`, `session-isolation.test.ts`) import from 5-7 modules | ~3 critical test files break | Create `@agenc/integration-tests` dev-only workspace package |
| `daemon.test.ts` (3,829 lines, 17 `vi.mock()` calls) targets modules across 6+ packages | Hardest test file to migrate | Split into kernel-only unit tests + cross-package integration tests; all mock paths must be rewritten |
| `chat-executor.test.ts` (11,539 lines) imports `GatewayMessage` from gateway | Cross-package import breaks on extraction | Resolves naturally if GatewayMessage moves to @agenc/core (Phase 0 prerequisite) |
| Shared test utilities (`createMockMemoryBackend`) used across packages | Test helpers scattered across package boundaries | Audit all `test-utils.ts` files; centralize in `@agenc/test-utils` |
| CI benchmark/mutation scripts import from `eval/` | Release gates break when eval moves to separate repo | Keep benchmark scripts in @agenc/eval; restructure CI to orchestrate across packages |

#### 17.16.4 Additional Missing Risks

**R15: No Monorepo Tooling Defined**
Risk: 19 packages need coordinated builds, tests, and versioning from day one. Currently no workspaces, turborepo, or nx configured.
Mitigation: Phase 0 must select and configure monorepo tooling before any extraction begins.

**R16: @agenc/core Gravity Well**
Risk: Core accumulates types from every package, growing past "small contracts-only" vision toward a types monolith.
Mitigation: Set hard line count budget for core (~8K max). Enforce 3+ package usage threshold for any type to be promoted to core.

**R17: Version Drift Between Packages Post-Phase-4**
Risk: 19 separate repos mean a breaking change in @agenc/core requires coordinated releases of 18 downstream packages.
Mitigation: Use lockstep versioning (all packages same version) during initial releases. Evaluate semver with compatibility matrix after stabilization.

**R18: BaseChannelPlugin Is a Concrete Class (Not an Interface)**
Risk: All 8 channel plugins extend `BaseChannelPlugin` (400 lines, imports from gateway/message.ts, gateway/commands.ts, gateway/hooks.ts, gateway/webhooks.ts). Channels cannot depend only on @agenc/core — they need this class from @agenc/kernel.
Mitigation: Extract abstract `ChannelPlugin` interface to @agenc/core. Keep `BaseChannelPlugin` in @agenc/kernel as a convenience class. Channels that need the base class depend on kernel; lightweight channels depend only on core.

**R19: GatewayConfig Decomposition**
Risk: GatewayConfig has 25+ sub-config interfaces spanning gateway, desktop, llm, memory, voice, telemetry, policy, approvals, marketplace, social, and autonomy modules. Moving it to core drags Ring 2 types.
Mitigation: Use config section registry pattern (§17.7). Each ServiceModule registers its config Zod schema; kernel assembles composite config.

#### 17.16.5 @agenc/providers Sizing Decision

At ~3.4K lines (no anthropic adapter exists), @agenc/providers may not justify a separate package. Two options:

- (a) **Keep as lightweight package** — clean separation of provider adapters, but disproportionate CI/release overhead for ~3.4K lines
- (b) **Merge into @agenc/engine** — combined ~23K lines, simpler dependency graph, providers are the primary engine consumer

Recommendation: Keep separate for now. Provider adapters change independently of the chat executor. When Anthropic or other adapters are added, the package will grow naturally.

#### 17.16.6 Corrected Phase Timeline

| Phase | Original Estimate | Revised Estimate | Key Changes |
|-------|------------------|-----------------|-------------|
| Phase 0: @agenc/core | 2-3 weeks | **3-4 weeks** | +12 types, config extension pattern, monorepo tooling, backward-compat meta-package |
| Phase 1: @agenc/kernel | 3-4 weeks | **4-5 weeks** | Kernel is ~27K not 18K; daemon.ts rewrite is ~200+ imports, not "one wiring change" |
| Phase 2: Ring 1 services | 4-5 weeks | **5-6 weeks** | Add Phase 2.5b for Ring 2 cross-dep resolution; engine blocked by workflow types |
| Phase 3: Ring 2 extensions | 4-5 weeks | **4-5 weeks** | Unchanged (but requires 2.5b complete) |
| Phase 4: Separate repos | 2-3 weeks | **3-4 weeks** | CI pipeline migration is blocking, not polish |
| **Total** | **15-20 weeks** | **19-24 weeks** |

---

## 18. Architectural Decisions (Resolved 2026-03-11)

These decisions close every open question from the 9-agent audit.

### Decision 1: Aggressively Split daemon.ts — YES

**Decision:** Split daemon.ts from 9,635 lines into 9 focused modules + a thin orchestrator.

**Rationale:** daemon.ts is the #1 coupling nexus in the codebase. It has 135 private properties, ~95 methods, and 200+ import lines reaching into every Ring 1 and Ring 2 module. The "10% kernel budget" is impossible without this split. More importantly, the ServiceModule plugin architecture *requires* it — the daemon must become a thin bootstrap orchestrator that loads plugins, not a god object that wires everything inline.

**Split plan:**

| New File | Extracted From | Lines | Contents |
|----------|---------------|-------|----------|
| `daemon-tool-registry.ts` | createToolRegistry + helpers | ~550 | All 15 system tool factories, deny-list logic, bash env resolution, skill discovery |
| `daemon-webchat-setup.ts` | wireWebChat + auxiliaries | ~700 | WebChat channel wiring, skill state, config reload handler |
| `daemon-prompt-builder.ts` | buildSystemPrompt + context methods | ~350 | System prompt assembly, desktop context, model disclosure, workspace prompt files |
| `daemon-llm-setup.ts` | createLLMProviders + hotSwap | ~220 | LLM provider factory, per-provider creation, hot-swap logic |
| `daemon-memory-setup.ts` | createMemoryBackend + retriever methods | ~500 | Memory backend factory, embedding provider, vector store, semantic retriever, ingestion hooks |
| `daemon-delegation-setup.ts` | Delegation + SubAgent methods | ~900 | Delegation policy engine, verifier service, trajectory sink, bandit tuner, SubAgentManager, session isolation, tool catalog |
| `daemon-hooks-commands.ts` | createHookDispatcher + createCommandRegistry | ~1,200 | Hook dispatcher creation, builtin hooks, slash command registry (progress/pipeline/resume/context), voice bridge |
| `daemon-signals.ts` | createWebChatSignals + lifecycle bridges | ~800 | WebChat signal callbacks (thinking/executing/idle), subagent lifecycle bridge |
| `daemon-session-handlers.ts` | Session + message handler methods | ~700 | Session tool handler creation, message dispatch, approval routing, session context hydration/reset |

**Remaining in daemon.ts (~3,400 lines):**
- Class declaration + 135 properties (~136 lines)
- Lifecycle: `start()`, `stop()`, signal handlers, config reload (~475 lines)
- External channel wiring: wireTelegram, wireExternalChannels (~500 lines)
- Social/marketplace/autonomous feature wiring (~800 lines)
- Message execution: handleWebChatInboundMessage, executeWebChatConversationTurn (~600 lines)
- Observability init/dispose (~100 lines)
- Module-level exports + PID utilities (~800 lines — these are already outside the class)

**Post-split kernel size:** ~20K (down from ~27K). Still above the 18K target but within the 8-12% range when combined with the other extractions. The remaining ~2K delta comes from files the audit found that weren't in the original estimate (trace-log-fanout, observability types/errors, foreground-log-tee).

**Migration path:** This split is a *prerequisite* for Phase 1 (kernel extraction). Each extracted module receives the DaemonManager instance or specific services via constructor/parameter injection — not global imports. This naturally evolves toward the ServiceModule registration pattern.

### Decision 2: llm → workflow Cycle — Move Pipeline Types to @agenc/core, PipelineExecutor to @agenc/engine

**Decision:** Option (a) — Extract Pipeline types/interfaces to @agenc/core. Move the PipelineExecutor class to @agenc/engine. @agenc/workflow becomes a thin DAG compiler and canary rollout layer.

**Rationale:** 6 llm/ files import ~20 types from workflow/pipeline.ts. The ChatExecutor's planner is *deeply* coupled to the Pipeline abstraction — it builds, validates, and executes pipelines as a core part of the chat loop. This isn't an optional extension; it's core engine behavior. Promoting @agenc/workflow to Ring 1 would defeat the purpose of Ring 2. Moving PipelineExecutor to @agenc/engine is the cleanest cut.

**What moves to @agenc/core/types/pipeline.ts (~200 lines):**
- `Pipeline`, `PipelineStep`, `PipelineResult`, `PipelineExecutionOptions`
- `PipelinePlannerStep`, `PipelinePlannerContext`
- `DeterministicPipelineExecutor` interface
- `WorkflowGraphEdge`

**What moves to @agenc/engine (~1,200 lines):**
- `PipelineExecutor` class (the full implementation from workflow/pipeline.ts)
- All pipeline checkpoint/resume logic

**What stays in @agenc/workflow (~3,800 lines):**
- DAG orchestrator, goal compiler, workflow optimizer
- Canary rollout, feature extractor
- Thin re-exports of pipeline types from @agenc/core for convenience

**Impact on @agenc/workflow:** It becomes a genuine extension — optional DAG-level workflow compilation. The runtime works fine without it. When present, it compiles higher-level workflow graphs into Pipeline objects that the engine executes.

### Decision 3: Kernel Size — Accept ~20K with Aggressive daemon.ts Split

**Decision:** Accept a kernel size of ~20K lines (~9.5% of 209K). This is within the 8-12% target range after the daemon.ts split.

**Rationale:** The audit proved ~18K was based on phantom line counts. After the daemon.ts split (Decision 1), the kernel lands at ~20K. Trying to force it to 18K would mean moving observability or MCP client to a separate package, which adds dependency complexity for marginal gain. 9.5% is comparable to VS Code (~10%) and Grafana (~10%).

**Budget enforcement:** Any new code added to @agenc/kernel must pass the "is this boot/lifecycle/plugin infrastructure?" test. Business logic, channel-specific wiring, or domain heuristics belong in Ring 1/Ring 2.

### Decision 4: Ring 1 Horizontal Dependencies — Relocate All Shared Functions to @agenc/core

**Decision:** No Ring 1 → Ring 1 cross-imports allowed. All shared functions move to @agenc/core.

**Rationale:** Allowing "controlled" horizontal deps between Ring 1 packages creates a slippery slope back to the monolith. The audit found exactly which functions need to move (§17.8). There are only 6 function families totaling ~470 lines. Moving them is cheaper than maintaining a complex "controlled exception" policy.

**Concrete relocations (all to @agenc/core/utils/):**

| Function | From | To | Lines |
|----------|------|----|-------|
| `safeStringify` | tools/types.ts | core/utils/safe-stringify.ts | ~101 |
| `stableStringifyJson` + `JsonValue` | eval/types.ts | core/utils/stable-stringify.ts | ~50 |
| `entryToMessage` + `messageToEntryOptions` | memory/types.ts | core/utils/memory-bridge.ts | ~40 |
| `didToolCallFail` + `extractToolFailureTextFromResult` | llm/chat-executor-tool-utils.ts | core/utils/tool-result.ts | ~50 |
| `collectDirectModeShellControlTokens` | tools/system/command-line.ts | engine (ChatExecutor-specific heuristic) | ~30 |
| `projectOnChainEvents` + types | eval/projector.ts | core/utils/event-projection.ts | ~200 |

**After these relocations:** The §7 dependency matrix becomes correct — all Ring 1 packages depend only on @agenc/core. Zero exceptions.

**@agenc/core revised size:** ~7.5-8K lines (up from 5K). Still well within the "small contracts-only" scope. The core gravity well risk (R16) is mitigated by the 3+ package usage threshold — every function above is used by 3+ packages.

### Decision 5: eval ↔ replay — Merge into @agenc/eval

**Decision:** Merge @agenc/replay into @agenc/eval. The combined package becomes `@agenc/eval` (~14.5K lines).

**Rationale:** The bidirectional coupling is deep — 5 replay files import runtime functions from eval (not just types). `projectOnChainEvents` is shared implementation logic, not an interface you can abstract. `stableStringifyJson` moves to core (Decision 4), but the eval/projector ↔ replay/bridge coupling remains semantic — they operate on the same on-chain event projection model. Forcing a clean interface boundary here would create an artificial abstraction that adds complexity without value. These two modules are conceptually one thing: "observe and analyze what happened."

**Package structure:**
```
@agenc/eval/
├── benchmarks/          # BenchmarkRunner, manifests
├── mutation/            # MutationEngine, MutationRunner
├── trajectory/          # TrajectoryRecorder, ReplayEngine
├── chaos/               # ChaosMatrix
├── evidence/            # Evidence packs, calibration
├── replay/              # Event timeline store, backfill, alerting (was @agenc/replay)
├── projection/          # projectOnChainEvents, projector types (shared)
└── quality/             # Background run quality gates, delegation benchmarks
```

**Impact:** 18 packages instead of 19. The @agenc/replay repo is never created. All replay-related imports stay internal to @agenc/eval. The Ring 2 × Ring 2 cross-dep count drops by 3 (replay→eval, eval→replay types, replay→eval stableStringifyJson).

### Decision 6: Backward Compatibility — @agenc/runtime Facade Meta-Package

**Decision:** Create `@agenc/runtime` as a thin facade that re-exports from all packages.

**Rationale:** 460+ exports from runtime/src/index.ts. The MCP server, web app, mobile app, examples, and any external consumers all import from `@agenc/runtime`. Breaking every import path on day one is unacceptable.

**Implementation:**
```typescript
// @agenc/runtime/src/index.ts (meta-package)
export * from '@agenc/core';
export * from '@agenc/kernel';
export * from '@agenc/engine';
export * from '@agenc/providers';
export * from '@agenc/memory';
export * from '@agenc/tools';
export * from '@agenc/protocol';
export * from '@agenc/channels';
export * from '@agenc/desktop';
export * from '@agenc/voice';
export * from '@agenc/autonomous';
export * from '@agenc/workflow';
export * from '@agenc/social';
export * from '@agenc/marketplace';
export * from '@agenc/team';
export * from '@agenc/policy';
export * from '@agenc/eval';
export * from '@agenc/bridges';
```

**Lifecycle:** Ships from Phase 1 onward. Marked `@deprecated` in Phase 3. Removed in Phase 5 (or kept indefinitely if external adoption is significant). Consumers migrate at their own pace by switching to direct package imports.

### Decision 7: @agenc/channels Depends on @agenc/kernel (Not Just Core)

**Decision:** Allow @agenc/channels to depend on @agenc/kernel. Update the dependency matrix.

**Rationale:** BaseChannelPlugin is a 400-line concrete class that provides real value — session derivation, webhook routing, hook dispatch, attachment handling. Extracting a minimal ChannelPlugin interface to core is correct, but most channels will still extend BaseChannelPlugin for convenience. Forcing them to depend only on core means either duplicating 400 lines of base class logic in every channel, or moving BaseChannelPlugin to core (which drags in implementation).

**Updated dependency rule:** Ring 2 packages depend on @agenc/core. @agenc/channels additionally depends on @agenc/kernel (for BaseChannelPlugin). This is the only Ring 2 → kernel exception and it's justified: channels are *the* primary kernel integration surface.

**Dependency matrix update:**
```
@agenc/channels: @agenc/core ✓, @agenc/kernel ✓ (BaseChannelPlugin only)
All other Ring 2:  @agenc/core ✓ only
```

### Decision Summary

| # | Question | Decision | Impact |
|---|----------|----------|--------|
| 1 | Split daemon.ts? | **YES — aggressive 9-module split** | 9,635 → ~3,400 lines. Kernel hits ~20K (~9.5%) |
| 2 | llm → workflow? | **Pipeline types → core, PipelineExecutor → engine** | @agenc/workflow becomes thin DAG layer |
| 3 | Kernel size? | **Accept ~20K with split** | Within 8-12% target (9.5%) |
| 4 | Ring 1 horizontal deps? | **Zero tolerance — relocate all to core** | 6 function families (~470 lines) move to core |
| 5 | eval ↔ replay? | **Merge into @agenc/eval** | 18 packages, not 19. Removes 3 cross-deps |
| 6 | Backward compat? | **@agenc/runtime facade meta-package** | Zero breaking changes for consumers |
| 7 | Channels → kernel? | **Allow (only Ring 2 exception)** | BaseChannelPlugin stays in kernel |

### Revised Package Count: 18 + 1 facade

| Ring | Packages |
|------|----------|
| Ring 0 | @agenc/core, @agenc/kernel |
| Ring 1 | @agenc/engine, @agenc/providers, @agenc/memory, @agenc/tools, @agenc/protocol |
| Ring 2 | @agenc/channels, @agenc/desktop, @agenc/voice, @agenc/autonomous, @agenc/workflow, @agenc/social, @agenc/marketplace, @agenc/team, @agenc/policy, @agenc/eval |
| Facade | @agenc/runtime (re-exports all, deprecated after Phase 3) |
| **Total** | **18 packages + 1 facade** |
