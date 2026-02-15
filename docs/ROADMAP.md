# AgenC Roadmap: Personal AI Agent Platform

> Transform AgenC from a protocol-level coordination framework into a full personal AI agent platform — like OpenClaw, but with native on-chain coordination, ZK privacy, and verifiable reputation.

---

## Current State Summary

AgenC today is a **protocol + runtime toolkit**. It has:

- 25-instruction Solana program (tasks, disputes, escrow, ZK verification, SPL tokens)
- TypeScript SDK for all on-chain operations
- Agent runtime with LLM adapters (Grok, Anthropic, Ollama), tool registry, memory backends, autonomous task scanning, DAG workflows, marketplace bidding, policy engine, telemetry
- MCP server exposing protocol operations
- Plugin manifest governance + catalog system (from #997-998)
- CLI commands: `health`, `onboard`, `security`, `replay` (from #994-996)
- ZK circuits (Noir/Groth16) for private task completion
- 1800+ runtime tests, 185 LiteSVM integration tests, mutation regression gates

What it **lacks** to be an OpenClaw-style personal agent:

- No human-facing messaging channels (Telegram, Discord, Slack, etc.)
- No persistent daemon / gateway process
- No heartbeat (autonomous scheduled actions beyond task scanning)
- No documentation-centric skills (SKILL.md)
- No remote skill marketplace
- No semantic memory search
- No general-purpose system tools (bash, browser, filesystem)
- No multi-agent routing
- No agent social layer
- No user-facing chat UI
- No hook/lifecycle event system
- No sub-agent orchestration
- No session scoping or reset policies
- No model fallback chains
- No execution sandboxing (Docker)
- No setup wizard
- No slash commands in channels
- No cross-channel identity linking
- No conversation compaction
- No config hot-reload
- No approval policies for dangerous actions
- No media pipeline (image/audio/video processing)

---

## Phase 1: Gateway & Channel Foundation

**Goal:** AgenC agents become reachable via messaging platforms. Users can talk to their agent on Telegram or Discord and get responses powered by their configured LLM.

**Depends on:** Nothing (greenfield)

### 1.1 Gateway Core

The Gateway is a persistent process that manages sessions, channels, tools, and agent lifecycles. It replaces the current pattern of constructing `AgentRuntime` + `AutonomousAgent` manually.

**Files to create:**
- `runtime/src/gateway/gateway.ts` — main Gateway class
- `runtime/src/gateway/types.ts` — config, session, message types
- `runtime/src/gateway/session.ts` — session manager (create, resume, expire, compact)
- `runtime/src/gateway/router.ts` — routes inbound messages to agent workspaces
- `runtime/src/gateway/hooks.ts` — lifecycle hook system
- `runtime/src/gateway/config-watcher.ts` — hot-reload on config file changes
- `runtime/src/gateway/index.ts` — barrel exports

**Gateway responsibilities:**
- Start/stop lifecycle (wraps `AgentRuntime`)
- WebSocket control plane for local clients (CLI, web UI)
- Channel plugin registration and message dispatch
- Session management (conversation state per channel+user)
- Heartbeat scheduler (Phase 2)
- System prompt assembly (agent config + injected skills + memory context)
- Config file watching with hot-reload (no restart needed for most changes)
- Hook dispatch (lifecycle events to registered listeners)

**Gateway config shape:**
```typescript
interface GatewayConfig {
  /** LLM provider config */
  llm: LLMConfig;
  /** Model fallback chain */
  fallbacks?: string[];
  /** Memory backend config */
  memory: { backend: 'sqlite' | 'redis' | 'in-memory'; path?: string; url?: string };
  /** Enabled channels with per-channel config */
  channels: Record<string, ChannelConfig>;
  /** Agent identity */
  agent: { name: string; capabilities: bigint; stake?: bigint };
  /** Solana connection */
  connection: { rpcUrl: string; keypairPath?: string };
  /** Heartbeat config */
  heartbeat: HeartbeatConfig;
  /** Session management */
  session: SessionConfig;
  /** Skills directories to scan */
  skillPaths: string[];
  /** Plugin catalog path */
  pluginCatalogPath: string;
  /** Sandbox config */
  sandbox: SandboxConfig;
  /** Approval policies */
  approvals: ApprovalPolicyConfig;
  /** Hook registrations */
  hooks: HookConfig[];
  /** Logging */
  logging: { level: string; file?: string; json?: boolean };
  /** Gateway bind address */
  gateway: { port: number; bind?: string };
}
```

**Integration points:**
- Wraps existing `AgentBuilder` for agent construction
- Uses existing `ConnectionManager` for RPC
- Uses existing `PolicyEngine` for permission gating
- Uses existing `PluginCatalog` for plugin lifecycle
- Uses existing `UnifiedTelemetryCollector` for metrics

**Config hot-reload:**
- Watch `~/.agenc/config.json` via `fs.watch()`
- On change: diff old vs new, apply safe updates (channels, skills, session config, logging level)
- Unsafe changes (LLM provider, connection, agent identity) require restart — log a warning
- Debounce watch events (100ms) to avoid rapid reload cycles

**Improvement over OpenClaw:** OpenClaw's config hot-reload is limited. AgenC can leverage the existing `PolicyEngine` to define which config sections are hot-reloadable vs restart-required, and emit telemetry events on config changes for audit trails.

### 1.2 Unified Message Format

All channels normalize to a single message format before reaching the agent.

**File:** `runtime/src/gateway/message.ts`

```typescript
interface GatewayMessage {
  /** Unique message ID */
  id: string;
  /** Source channel name */
  channel: string;
  /** Channel-specific sender identifier */
  senderId: string;
  /** Display name of sender */
  senderName: string;
  /** Resolved cross-channel identity (see 1.9) */
  identityId?: string;
  /** Session ID (derived from scope rules + channel + sender) */
  sessionId: string;
  /** Message content */
  content: string;
  /** Optional attachments (images, files, voice, video) */
  attachments?: MessageAttachment[];
  /** Timestamp */
  timestamp: number;
  /** Channel-specific metadata (thread ID, reply-to, guild, etc.) */
  metadata?: Record<string, unknown>;
  /** Whether this is a group message or DM */
  scope: 'dm' | 'group' | 'thread';
}

interface MessageAttachment {
  type: 'image' | 'file' | 'voice' | 'video';
  url?: string;
  data?: Uint8Array;
  mimeType: string;
  filename?: string;
  /** Size in bytes (for quota enforcement) */
  sizeBytes?: number;
  /** Duration in seconds (for audio/video) */
  durationSeconds?: number;
}

interface OutboundMessage {
  /** Target session ID */
  sessionId: string;
  /** Text content (markdown) */
  content: string;
  /** Optional attachments */
  attachments?: MessageAttachment[];
  /** Whether this is a streaming partial update */
  isPartial?: boolean;
  /** Optional TTS: synthesize and send as voice note */
  tts?: boolean;
}
```

### 1.3 Channel Plugin Interface

Channels are runtime plugins that bridge external messaging platforms to the Gateway.

**File:** `runtime/src/gateway/channel.ts`

```typescript
interface ChannelPlugin {
  /** Channel name (e.g. 'telegram', 'discord', 'slack') */
  readonly name: string;

  /** Initialize the channel with gateway context */
  initialize(context: ChannelContext): Promise<void>;

  /** Start listening for inbound messages */
  start(): Promise<void>;

  /** Stop listening and clean up */
  stop(): Promise<void>;

  /** Send an outbound message to a session */
  send(message: OutboundMessage): Promise<void>;

  /** Optional: register HTTP webhook endpoints */
  registerWebhooks?(router: WebhookRouter): void;

  /** Optional: handle slash commands natively */
  handleSlashCommand?(command: string, args: string, context: SlashCommandContext): Promise<void>;

  /** Optional: handle reactions/emoji */
  handleReaction?(reaction: ReactionEvent): Promise<void>;

  /** Health check — returns true if channel is connected */
  isHealthy(): boolean;
}

interface ChannelContext {
  /** Callback to deliver inbound messages to the Gateway */
  onMessage: (message: GatewayMessage) => Promise<void>;
  /** Logger scoped to this channel */
  logger: Logger;
  /** Channel-specific config from gateway config */
  config: Record<string, unknown>;
  /** Hook dispatcher for channel-level events */
  hooks: HookDispatcher;
}
```

### 1.4 Telegram Channel Plugin

First channel implementation. Telegram has the simplest bot API and is the most common OpenClaw channel.

**Files to create:**
- `runtime/src/channels/telegram/plugin.ts` — `TelegramChannel` implements `ChannelPlugin`
- `runtime/src/channels/telegram/types.ts` — Telegram-specific config
- `runtime/src/channels/telegram/index.ts`

**Config:**
```typescript
interface TelegramChannelConfig {
  botToken: string;
  /** Allowed user IDs (empty = allow all) */
  allowedUsers?: number[];
  /** Polling interval in ms (default: 1000) */
  pollingIntervalMs?: number;
  /** Use webhooks instead of polling */
  webhook?: { url: string; port: number; path?: string };
  /** Maximum attachment size in bytes (default: 20MB) */
  maxAttachmentBytes?: number;
}
```

**Implementation notes:**
- Use `grammy` (same as OpenClaw) or raw HTTP (keep deps minimal)
- Long polling by default, webhook mode optional
- Map Telegram chat ID + user ID to session ID
- Handle text, voice (transcription via LLM), images, documents
- Rate limit outbound messages per Telegram API limits (30 msg/sec global, 1 msg/sec per chat)
- Register as a plugin via existing `PluginCatalog`
- Slash command support: forward `/ask`, `/status`, `/task` to Gateway

### 1.5 Discord Channel Plugin

Second channel. Discord is the primary crypto/dev community platform.

**Files to create:**
- `runtime/src/channels/discord/plugin.ts`
- `runtime/src/channels/discord/types.ts`
- `runtime/src/channels/discord/index.ts`

**Implementation notes:**
- Use `discord.js` (lazy-loaded like LLM adapters: `ensureLazyModule()`)
- Map guild + channel + user to session ID
- Support DMs and server channels
- Thread support: map Discord threads to sessions
- Slash commands for agent interaction (`/ask`, `/status`, `/task`)
- Handle embeds for rich responses (task status, agent info)
- Support reactions as feedback signals

### 1.6 Session Management

Sessions are the unit of conversation state. OpenClaw has sophisticated session scoping — we need feature parity and then some.

**File:** `runtime/src/gateway/session.ts`

```typescript
interface SessionConfig {
  /** How sessions are scoped */
  scope: 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';
  /** When sessions auto-reset */
  reset: {
    mode: 'never' | 'daily' | 'idle' | 'weekday';
    /** For 'daily': hour to reset (0-23, default: 4) */
    dailyHour?: number;
    /** For 'idle': minutes of inactivity before reset (default: 120) */
    idleMinutes?: number;
  };
  /** Per-scope overrides */
  overrides?: {
    dm?: Partial<SessionConfig>;
    group?: Partial<SessionConfig>;
    thread?: Partial<SessionConfig>;
  };
  /** Per-channel overrides */
  channelOverrides?: Record<string, Partial<SessionConfig>>;
  /** Max conversation history before compaction (default: 100 messages) */
  maxHistoryLength?: number;
  /** Compaction strategy */
  compaction: 'summarize' | 'truncate' | 'sliding-window';
}

interface Session {
  /** Unique session ID */
  id: string;
  /** Resolved workspace for this session */
  workspaceId: string;
  /** Conversation history (compacted as needed) */
  history: LLMMessage[];
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActiveAt: number;
  /** Session metadata */
  metadata: Record<string, unknown>;
}
```

**Compaction (critical for long conversations):**
- When history exceeds `maxHistoryLength`, trigger compaction
- `summarize`: LLM generates a summary of oldest messages, replaces them with a single system message
- `truncate`: drop oldest messages (simple but lossy)
- `sliding-window`: keep last N messages + summary of everything before
- Emit `session:compact` hook event before/after compaction

**Improvement over OpenClaw:** AgenC can store compaction summaries in the vector memory store (Phase 5), making old context searchable even after compaction. OpenClaw just loses the compacted context.

### 1.7 Lifecycle Hook System

Hooks allow plugins and users to intercept and react to Gateway events. OpenClaw has 9+ hook types — we need a clean, extensible system.

**File:** `runtime/src/gateway/hooks.ts`

```typescript
type HookEvent =
  | 'gateway:startup'
  | 'gateway:shutdown'
  | 'agent:bootstrap'         // Before agent prompt construction
  | 'session:start'           // New session created
  | 'session:end'             // Session expired or reset
  | 'session:compact'         // Conversation compacted
  | 'message:inbound'         // After normalization, before agent
  | 'message:outbound'        // Before delivery to channel
  | 'tool:before'             // Before tool execution
  | 'tool:after'              // After tool execution
  | 'heartbeat:before'        // Before heartbeat action
  | 'heartbeat:after'         // After heartbeat action
  | 'command:new'             // /new slash command
  | 'command:reset'           // /reset slash command
  | 'command:stop'            // /stop slash command
  | 'config:reload';          // Config file changed

interface HookHandler {
  /** Hook event to listen for */
  event: HookEvent;
  /** Handler name for logging */
  name: string;
  /** Priority (lower = runs first, default: 100) */
  priority?: number;
  /** The handler function */
  handler: (context: HookContext) => Promise<HookResult>;
}

interface HookContext {
  /** The event that triggered this hook */
  event: HookEvent;
  /** Event-specific payload */
  payload: Record<string, unknown>;
  /** Gateway reference */
  gateway: Gateway;
  /** Logger */
  logger: Logger;
}

interface HookResult {
  /** Whether to continue processing (false = abort) */
  continue: boolean;
  /** Optional modified payload (for transform hooks) */
  payload?: Record<string, unknown>;
}

interface HookDispatcher {
  /** Register a hook handler */
  on(handler: HookHandler): void;
  /** Remove a hook handler */
  off(event: HookEvent, name: string): void;
  /** Dispatch an event to all registered handlers */
  dispatch(event: HookEvent, payload: Record<string, unknown>): Promise<boolean>;
}
```

**Built-in hooks (ship with AgenC):**
- `session-memory-recorder` — append conversation turns to daily log files
- `tool-audit-logger` — log all tool executions for security audit
- `boot-executor` — run BOOT.md instructions on agent startup
- `approval-gate` — intercept dangerous tool calls and require user approval

**Improvement over OpenClaw:** OpenClaw hooks are fire-and-forget. AgenC hooks can be **transform hooks** — they modify the payload before passing to the next handler. This enables middleware-style composition (content filtering, PII redaction, cost tracking) without forking the core pipeline. Additionally, all hook executions get recorded in the existing replay/incident system (#959-968), enabling forensic reconstruction of hook-mediated behavior.

### 1.8 Slash Commands

Users interact with the agent via messaging-native slash commands.

**File:** `runtime/src/gateway/commands.ts`

**Core commands (available in all channels):**

| Command | Description |
|---------|-------------|
| `/status` | Show agent status (uptime, active channels, tasks, reputation) |
| `/model` | Show or switch the current LLM model |
| `/model <name>` | Switch to a different model |
| `/new` | Start a new session (reset conversation) |
| `/reset` | Reset session and clear context |
| `/stop` | Pause the agent (stop responding until `/start`) |
| `/start` | Resume the agent |
| `/context` | Show current context window usage |
| `/compact` | Force conversation compaction |
| `/skills` | List available skills |
| `/task <description>` | Create an on-chain task (AgenC-specific) |
| `/tasks` | List current tasks |
| `/balance` | Show SOL/token balance |
| `/reputation` | Show agent's on-chain reputation |
| `/help` | Show available commands |

**Implementation:** Commands are detected by prefix `/` in the message content before reaching the LLM. Each command has a handler function. Unknown commands are passed through to the LLM as regular messages.

### 1.9 Cross-Channel Identity Linking

The same human user across Telegram + Discord + Slack should be recognized as one identity.

**File:** `runtime/src/gateway/identity.ts`

```typescript
interface IdentityLink {
  /** Internal identity ID */
  identityId: string;
  /** Linked channel accounts */
  accounts: { channel: string; senderId: string; displayName: string }[];
  /** Optional on-chain agent pubkey (if user has registered an agent) */
  agentPubkey?: string;
  /** User preferences (merged from USER.md) */
  preferences: Record<string, unknown>;
}
```

**Linking methods:**
- Manual: user runs `/link` in two channels with a shared code
- Automatic: same display name + IP heuristic (opt-in, privacy-sensitive)
- On-chain: user proves ownership of the same Solana keypair across channels

**Improvement over OpenClaw:** OpenClaw links identities via config. AgenC can cryptographically verify cross-channel identity by having the user sign a challenge with their Solana keypair. This is verifiable and tamper-proof.

### 1.10 Gateway CLI Commands

Extend the existing CLI module with gateway lifecycle commands.

**Extend:** `runtime/src/cli/`

```
agenc start                    # Start the gateway daemon
agenc stop                     # Stop the gateway daemon
agenc restart                  # Restart the gateway
agenc status                   # Show gateway status (channels, sessions, uptime)
agenc config init              # Generate default gateway config (interactive wizard)
agenc config validate          # Validate gateway config
agenc config show              # Show current resolved config
agenc logs                     # Tail gateway logs
agenc logs --session <id>      # Tail logs for a specific session
agenc doctor                   # Run health diagnostics with auto-fix suggestions
agenc sessions list            # List active sessions
agenc sessions kill <id>       # Kill a specific session
```

**Interactive setup wizard (`agenc config init`):**
- Step-by-step questionnaire: LLM provider, API key, channels to enable, Solana network
- Generates `~/.agenc/config.json` with sane defaults
- Creates workspace directory structure (`~/.agenc/workspace/`)
- Scaffolds AGENT.md, SOUL.md, USER.md templates
- Tests LLM connectivity and channel auth

**Improvement over OpenClaw:** The wizard can also run `agenc doctor` at the end to verify everything works. OpenClaw's wizard doesn't auto-diagnose. Additionally, the wizard can detect existing Solana CLI config (`~/.config/solana/`) and offer to reuse the keypair.

### 1.11 Agent Loop Integration

Connect the Gateway message flow to the existing LLM + tool execution pipeline.

**Flow:**
```
Inbound message (Telegram/Discord/etc.)
  → Hook: message:inbound (filter, transform, log)
  → Gateway.onMessage()
  → IdentityResolver.resolve(senderId, channel) → identityId
  → Router.route(message) → workspaceId
  → Session.getOrCreate(sessionId, workspaceId)
  → Load conversation history from MemoryBackend
  → Compact if over maxHistoryLength
  → Assemble system prompt:
      1. AGENT.md (personality)
      2. SOUL.md (communication style)
      3. USER.md (user preferences)
      4. TOOLS.md (tool usage guidelines)
      5. Injected skills (Phase 3)
      6. Relevant memories (Phase 5)
  → ChatExecutor.execute(message, history, tools)
  → Tool call loop (existing ToolRegistry + ToolHandler)
      → Hook: tool:before / tool:after per call
      → Approval gate if dangerous action
  → Response → OutboundMessage
  → Hook: message:outbound (format, filter)
  → Channel.send()
  → Persist conversation to MemoryBackend
  → Update session lastActiveAt
```

**New: `ChatExecutor`** (message-oriented variant of `LLMTaskExecutor`):

**File:** `runtime/src/llm/chat-executor.ts`

```typescript
interface ChatExecutorConfig {
  /** LLM provider */
  provider: LLMProvider;
  /** Model fallback chain */
  fallbacks?: LLMProvider[];
  /** Tool handler */
  toolHandler?: ToolHandler;
  /** Maximum tool call rounds (default: 10) */
  maxToolRounds?: number;
  /** Streaming callback */
  onStreamChunk?: (chunk: string) => void;
  /** Skill injector (Phase 3) */
  skillInjector?: SkillInjector;
  /** Memory retriever (Phase 5) */
  memoryRetriever?: MemoryRetriever;
  /** Allowed tools allowlist (defense-in-depth) */
  allowedTools?: string[];
  /** Metrics provider */
  metrics?: MetricsProvider;
}
```

**Key difference from `LLMTaskExecutor`:**
- Input: `GatewayMessage` + conversation history → output: string response (not `bigint[]`)
- System prompt is dynamic (assembled per-message from workspace files + skills + memory)
- Supports model fallback: if primary provider fails, try next in chain
- Tracks token usage per session for budget enforcement

**Model fallback chain (missing from original roadmap):**
- Configure ordered list of models: `['anthropic/claude-sonnet-4-5-20250929', 'grok-3', 'ollama/llama3']`
- On provider error (rate limit, auth failure, timeout), automatically try next
- Session stickiness: once a model succeeds in a session, prefer it for cache warmth
- Cooldown: failed provider enters cooldown period before retry
- Leverages existing `LLMProvider` adapter pattern — just wraps multiple providers

**Improvement over OpenClaw:** OpenClaw's fallback is provider-level only. AgenC can fall back at the **tool level** too — if one tool fails, try an alternative tool that achieves the same goal (e.g., if `jupiter.getQuote` fails, try a fallback DEX skill).

### 1.12 Media Pipeline

Handle images, audio, video, and documents across channels.

**File:** `runtime/src/gateway/media.ts`

```typescript
interface MediaPipelineConfig {
  /** Max attachment size in bytes (default: 25MB) */
  maxAttachmentBytes: number;
  /** Temp file directory (default: ~/.agenc/tmp/) */
  tempDir: string;
  /** Temp file TTL in ms (default: 1 hour) */
  tempFileTtlMs: number;
  /** Auto-transcribe voice messages */
  autoTranscribeVoice: boolean;
  /** Transcription provider ('whisper-api' | 'local-whisper' | 'llm') */
  transcriptionProvider: string;
  /** Image description provider ('llm' for vision models) */
  imageDescriptionProvider?: string;
}
```

**Features:**
- Voice message transcription (Whisper API or local) → inject transcript into conversation
- Image description via vision-capable LLM → inject description into conversation
- Document text extraction (PDF, DOCX) → inject content into conversation
- Size validation and quota enforcement per channel
- Temp file lifecycle management (auto-cleanup after TTL)
- Format conversion for cross-channel forwarding (e.g., Telegram voice → Discord audio)

---

## Phase 2: Heartbeat & Autonomous Daemon

**Goal:** The agent doesn't just respond to messages — it wakes up on a schedule and acts autonomously. Check calendar, process emails, scan for tasks, post updates.

**Depends on:** Phase 1 (Gateway)

### 2.1 Heartbeat Scheduler

**File:** `runtime/src/gateway/heartbeat.ts`

```typescript
interface HeartbeatConfig {
  /** Whether heartbeat is enabled */
  enabled: boolean;
  /** Default interval between heartbeats in ms (default: 1800000 = 30min) */
  intervalMs: number;
  /** Maximum heartbeat execution time before timeout */
  timeoutMs: number;
  /** Active hours restriction (e.g., only run 8am-10pm) */
  activeHours?: { start: number; end: number; timezone?: string };
  /** Actions to perform on each heartbeat */
  actions: HeartbeatAction[];
  /** Target channel(s) for heartbeat output (where to post results) */
  targetChannels?: string[];
}

interface HeartbeatAction {
  /** Action name for logging */
  name: string;
  /** Whether this action is enabled */
  enabled: boolean;
  /** The action to execute */
  execute: (context: HeartbeatContext) => Promise<HeartbeatResult>;
  /** Optional cron expression for this specific action (overrides global interval) */
  cron?: string;
  /** Custom prompt for this heartbeat action */
  prompt?: string;
}

interface HeartbeatResult {
  /** Whether the action produced output worth reporting */
  hasOutput: boolean;
  /** Output to post to target channel (if any) */
  output?: string;
  /** Whether the heartbeat was "quiet" (nothing interesting happened) */
  quiet: boolean;
}

interface HeartbeatContext {
  /** Gateway reference for sending messages */
  gateway: Gateway;
  /** Isolated session for this heartbeat run */
  session: Session;
  /** LLM provider for autonomous reasoning */
  llm: LLMProvider;
  /** Tool handler */
  toolHandler: ToolHandler;
  /** Logger scoped to this heartbeat */
  logger: Logger;
}
```

**Quiet heartbeat contract:** If a heartbeat action has nothing to report, it returns `{ quiet: true }` and posts nothing to channels. This prevents spam. (OpenClaw calls this "HEARTBEAT_OK".)

### 2.2 Built-in Heartbeat Actions

**Task scanning** (wraps existing `TaskScanner`):
- Discover claimable tasks matching agent capabilities
- Auto-claim if policy allows
- Notify operator via configured channel

**Scheduled summaries:**
- Summarize recent conversations
- Report task completion stats
- Post to a designated "status" channel

**Portfolio monitoring** (Solana-specific):
- Check SOL and token balances
- Alert on significant balance changes
- Monitor staked positions and rewards

**External service polling:**
- Generic webhook/API check action
- Extensible via skills

**HEARTBEAT.md workspace file:**
- User-defined heartbeat instructions in markdown
- Loaded as the heartbeat's system prompt
- Example: "Check my Solana wallet balance. If any new tasks match my capabilities, list them. Summarize any open disputes."

### 2.3 Cron-Like Scheduling

**File:** `runtime/src/gateway/scheduler.ts`

- Lightweight cron parser (no external deps, support `*/30 * * * *` syntax)
- Per-action schedules override the global heartbeat interval
- Actions run in isolated sessions (no cross-contamination)
- Active hours restriction (e.g., "only between 8am-10pm")
- Telemetry: track heartbeat execution time, success/failure
- Job management CLI:
  ```
  agenc jobs list              # List scheduled jobs
  agenc jobs run <name>        # Manually trigger a job
  agenc jobs enable <name>     # Enable a disabled job
  agenc jobs disable <name>    # Disable a job
  ```

### 2.4 Daemon Lifecycle

**Files:**
- `runtime/src/bin/daemon.ts` — daemon entry point
- `runtime/src/cli/daemon.ts` — CLI commands for daemon management

**Features:**
- `agenc start` — start as background process
- `agenc stop` — graceful shutdown (finish active sessions, cancel heartbeats)
- `agenc restart` — stop + start
- `agenc status` — PID, uptime, channel status, next heartbeat, memory usage
- PID file management (`~/.agenc/daemon.pid`)
- Signal handling (SIGTERM → graceful shutdown, SIGHUP → reload config)
- Optional systemd unit file generation: `agenc service install`
- Optional launchd plist generation (macOS): `agenc service install --macos`
- Crash recovery: auto-restart with exponential backoff

---

## Phase 3: Documentation-Centric Skills (SKILL.md)

**Goal:** Anyone can teach AgenC a new capability by writing a markdown file. Skills are passive documentation injected into the LLM system prompt — the agent reads the docs and figures out the tool calls.

**Depends on:** Phase 1 (system prompt assembly)

### 3.1 SKILL.md Parser

**File:** `runtime/src/skills/markdown/parser.ts`

**Format (compatible with OpenClaw for ecosystem portability):**
```yaml
---
name: github
description: Git and GitHub operations via the gh CLI
version: 1.0.0
metadata:
  agenc:
    emoji: "octopus"
    requires:
      binaries: [gh, git]
      env: [GITHUB_TOKEN]
      channels: []
      os: [linux, darwin]
    primaryEnv: GITHUB_TOKEN
    install:
      - type: brew
        package: gh
      - type: apt
        package: gh
      - type: download
        url: https://github.com/cli/cli/releases/latest
        path: /usr/local/bin
    tags: [development, version-control]
    # AgenC extensions (not in OpenClaw):
    requiredCapabilities: "0x01"  # COMPUTE
    onChainAuthor: "<agent-pubkey>"
    contentHash: "<ipfs-cid>"
---

# GitHub Skill

## Authentication
Run `gh auth status` to check if you're authenticated...

## Common Operations

### Create a PR
```bash
gh pr create --title "..." --body "..."
```

### List Issues
```bash
gh issue list --state open --limit 20
```
...
```

**Parser responsibilities:**
- Extract YAML frontmatter (use existing `yaml` parsing or simple custom parser)
- Validate required fields (name, description, version)
- Parse `requires` section (binaries, env vars, OS constraints, channel deps)
- Parse `install` section for automated dependency setup
- Parse AgenC-specific extensions (capabilities, on-chain metadata)
- Return structured `MarkdownSkill` object with body as raw markdown

**OpenClaw compatibility:** The `metadata.openclaw` namespace maps 1:1 to `metadata.agenc`. A compatibility shim reads OpenClaw skills by mapping the namespace. This lets users install OpenClaw community skills directly.

### 3.2 Skill Discovery & Validation

**File:** `runtime/src/skills/markdown/discovery.ts`

**Discovery locations (ordered by precedence, matching OpenClaw's 3-tier model):**
1. Per-agent workspace: `~/.agenc/agents/<agentId>/skills/` — agent-specific skills
2. User global: `~/.agenc/skills/` — user-installed skills
3. Project-local: `./skills/` — project-specific skills
4. Built-in: `runtime/src/skills/bundled/` — shipped with AgenC

**Validation at load time:**
- Check required binaries exist on PATH (`which` / `command -v`)
- Check required env vars are set
- Check OS platform constraints (`process.platform`)
- Check required channels are configured in gateway
- Mark skill as `available` or `unavailable` with reason
- Emit telemetry event for unavailable skills (helps debugging)

**Automated dependency installation:**
```
agenc skills install-deps <name>   # Install required binaries/packages for a skill
```
- Parses `metadata.agenc.install` section
- Detects platform (brew/apt/download)
- Executes install commands (with user confirmation)

### 3.3 Skill Injection Engine

**File:** `runtime/src/skills/markdown/injector.ts`

**How it works:**
- Before each LLM call, the injector selects relevant skills based on:
  - Message content keyword matching (TF-IDF or simple keyword overlap)
  - Agent capability bitmask overlap with skill requirements
  - Explicit skill requests ("use the github skill" or `/skill github`)
  - Session context (if user has been discussing GitHub, keep the skill injected)
  - Skill priority hints (skills can declare priority in metadata)
- Selected skill markdown bodies are appended to the system prompt
- Token budget: cap total injected skill docs at a configurable limit (default: 4000 tokens estimated)
- Skills are injected as `<skill name="github">...</skill>` blocks for clear LLM parsing
- Snapshot: per-session skill cache to avoid re-scanning on every message

**Integration with `ChatExecutor`:**
- Add `skillInjector?: SkillInjector` to `ChatExecutorConfig`
- Injector runs during system prompt assembly
- Skills are re-evaluated when conversation topic shifts

**Improvement over OpenClaw:** OpenClaw injects skills based on static rules. AgenC can use the **vector memory** (Phase 5) to semantically match skills to conversation context, and use the **on-chain capability bitmask** to filter skills that the agent can actually execute.

### 3.4 Bundled Skills

Ship AgenC with a starter set of markdown skills:

| Skill | Description |
|-------|-------------|
| `solana` | Solana CLI operations (balance, transfer, program deploy, account info) |
| `agenc-protocol` | AgenC protocol operations (register agent, create task, claim, complete, dispute) |
| `github` | Git + GitHub CLI operations (PRs, issues, branches, releases) |
| `jupiter` | Jupiter DEX operations (wraps existing JupiterSkill as docs) |
| `spl-token` | SPL token operations (create, transfer, close accounts, ATAs) |
| `system` | Basic system operations (file management, process info, network) |
| `defi-monitor` | DeFi position monitoring (balances, LP positions, staking rewards) |
| `wallet` | Solana wallet operations (keypair, airdrop, sign, verify) |

### 3.5 Workspace Files

Following OpenClaw's workspace model, but with AgenC-specific extensions:

**`~/.agenc/workspace/` directory structure:**

| File | Purpose | OpenClaw Equivalent |
|------|---------|-------------------|
| `AGENT.md` | Agent identity, behavior rules, knowledge domains | `AGENTS.md` |
| `SOUL.md` | Communication style, personality, tone, boundaries | `SOUL.md` |
| `USER.md` | User info, preferences, timezone, language | `USER.md` |
| `TOOLS.md` | Tool usage guidelines and restrictions | `TOOLS.md` |
| `HEARTBEAT.md` | Heartbeat action instructions | `HEARTBEAT.md` |
| `BOOT.md` | Startup instructions (run once on agent bootstrap) | `BOOT.md` |
| `IDENTITY.md` | Agent branding (name, avatar, theme) | `IDENTITY.md` |
| `MEMORY.md` | Curated long-term facts (DM only) | `MEMORY.md` |
| `memory/YYYY-MM-DD.md` | Daily append-only conversation logs | Same |
| `skills/` | Agent-specific skills directory | Same |

**AgenC-specific additions (not in OpenClaw):**

| File | Purpose |
|------|---------|
| `CAPABILITIES.md` | On-chain capability declarations and proof requirements |
| `POLICY.md` | Budget limits, approval rules, risk thresholds |
| `REPUTATION.md` | Reputation strategy and dispute behavior |

### 3.6 Skill CLI Commands

```
agenc skills list                     # List all discovered skills (available + unavailable)
agenc skills info <name>              # Show skill details, requirements, validation status
agenc skills validate                 # Validate all skills in all discovery paths
agenc skills create <name>            # Scaffold a new SKILL.md in ~/.agenc/skills/
agenc skills install <url-or-path>    # Copy/clone a skill to ~/.agenc/skills/
agenc skills install-deps <name>      # Install required dependencies for a skill
agenc skills uninstall <name>         # Remove a user-installed skill
agenc skills enable <name>            # Enable a disabled skill
agenc skills disable <name>           # Disable a skill without uninstalling
```

---

## Phase 4: System Tools

**Goal:** The agent can actually do things on your machine — run commands, read/write files, browse the web, make HTTP requests. These are gated by the existing `PluginPermission` system and a new approval policy layer.

**Depends on:** Phase 1 (Gateway + tool registry)

### 4.1 Bash Tool

**File:** `runtime/src/tools/system/bash.ts`

```typescript
interface BashToolConfig {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** Command timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Allowed command prefixes (empty = allow all) */
  allowList?: string[];
  /** Blocked command prefixes */
  denyList?: string[];
  /** Max output size in bytes (default: 100000) */
  maxOutputBytes?: number;
  /** Whether to allow interactive/PTY mode */
  allowPty?: boolean;
  /** Sandbox mode: run in Docker container */
  sandbox?: SandboxConfig;
}
```

**Security considerations:**
- Gated by `PluginPermission { type: 'tool_call', scope: 'system.bash' }`
- Default deny list: `rm -rf /`, `dd`, `mkfs`, `shutdown`, `reboot`, `curl | sh`
- Command allow/deny evaluated before execution
- Output truncated at `maxOutputBytes`
- Timeout enforced via `child_process` timeout option
- No shell expansion by default (use `execFile`, not `exec`)
- Operator must explicitly opt in via policy config
- All executions logged via `tool:before` / `tool:after` hooks
- Approval gate for commands matching dangerous patterns

### 4.2 Filesystem Tool

**File:** `runtime/src/tools/system/filesystem.ts`

**Actions:**
- `system.readFile` — read file contents (text or base64)
- `system.writeFile` — write file contents
- `system.appendFile` — append to file
- `system.listDir` — list directory contents
- `system.stat` — file metadata (size, modified, permissions)
- `system.mkdir` — create directory
- `system.delete` — delete file or directory (requires approval)
- `system.move` — move/rename file

**Security:**
- Gated by `PluginPermission { type: 'filesystem', scope: '<path-pattern>' }`
- Configurable allowed paths (default: `~/.agenc/workspace/`)
- Path traversal prevention (resolve + check prefix)
- Max file size limits for reads/writes
- Delete operations require approval policy

### 4.3 HTTP Tool

**File:** `runtime/src/tools/system/http.ts`

**Actions:**
- `system.httpGet` — GET request with optional headers
- `system.httpPost` — POST with JSON/form body
- `system.httpFetch` — generic fetch with method, headers, body

**Security:**
- Gated by `PluginPermission { type: 'network', scope: '<domain-pattern>' }`
- Configurable allowed domains
- Response size limits (default: 1MB)
- Timeout enforcement (default: 30s)
- No following redirects to disallowed domains
- Auth header injection for configured services

### 4.4 Browser Tool

**File:** `runtime/src/tools/system/browser.ts`

**Actions:**
- `system.browse` — fetch a URL, extract text content (HTML → markdown)
- `system.screenshot` — capture page screenshot (requires headless browser)
- `system.extractLinks` — extract all links from a page
- `system.browserAction` — click, type, scroll on a page (advanced mode)
- `system.evaluateJs` — run JavaScript on a page (advanced mode, requires approval)
- `system.exportPdf` — export page as PDF

**Implementation tiers:**
- **Basic mode** (default): `fetch` + `cheerio` for HTML → text extraction. Zero external deps.
- **Advanced mode** (opt-in): Playwright or Puppeteer (lazy-loaded). Enables screenshots, JS eval, DOM interaction.
- **Dedicated browser** (like OpenClaw): launch a dedicated Chromium instance with profile persistence, cookie management, and tab state.

**Security:**
- Gated by `PluginPermission { type: 'network', scope: 'browser' }`
- Advanced mode requires explicit opt-in in config
- JS evaluation requires approval gate
- Domain allowlist/denylist

### 4.5 Execution Sandboxing (Docker)

**File:** `runtime/src/gateway/sandbox.ts`

OpenClaw supports Docker-based sandboxing for tool execution. AgenC should too, but with on-chain attestation.

```typescript
interface SandboxConfig {
  /** Sandbox mode */
  mode: 'off' | 'non-main' | 'all';
  /** Scope: per-session, per-agent, or shared */
  scope: 'session' | 'agent' | 'shared';
  /** Docker image (default: 'node:20-slim') */
  image?: string;
  /** Workspace mount mode */
  workspaceAccess: 'none' | 'read-only' | 'read-write';
  /** Network access in sandbox */
  networkAccess: boolean;
  /** Max memory (default: '512m') */
  maxMemory?: string;
  /** Max CPU (default: '1.0') */
  maxCpu?: string;
  /** Custom setup script to run in container */
  setupScript?: string;
}
```

**Modes:**
- `off`: all tools run on host (default for personal use)
- `non-main`: group/thread sessions run sandboxed, DMs run on host (OpenClaw's model)
- `all`: everything sandboxed (maximum security)

**Improvement over OpenClaw:** AgenC can generate a **ZK proof of execution** — hash the sandbox's input/output and submit it on-chain via `complete_task_private`. This proves the tool was executed correctly without revealing the actual I/O. No other agent framework can do this.

### 4.6 Approval Policies

**File:** `runtime/src/gateway/approvals.ts`

Before executing dangerous actions, require explicit user confirmation.

```typescript
interface ApprovalPolicyConfig {
  /** Actions requiring approval (glob patterns) */
  requireApproval: ApprovalRule[];
  /** Elevated mode: skip approvals for trusted channels/users */
  elevated?: {
    /** Channels where elevated mode is allowed */
    channels?: string[];
    /** User IDs allowed elevated mode */
    users?: string[];
    /** Whether elevated mode is currently active */
    active: boolean;
  };
}

interface ApprovalRule {
  /** Tool name pattern (glob) */
  tool: string;
  /** Action pattern (glob) */
  action?: string;
  /** Conditions that trigger approval */
  conditions?: {
    /** Amount threshold (in lamports) */
    amountAbove?: number;
    /** Specific arguments that trigger approval */
    argPatterns?: Record<string, string>;
  };
  /** Approval message template */
  message: string;
}
```

**Default approval rules:**
- `system.bash` — any command not in allowlist
- `system.delete` — always
- `system.evaluateJs` — always
- `agenc.createTask` — if reward > 1 SOL
- `wallet.sign` — always
- `wallet.transfer` — if amount > 0.1 SOL

**Flow:**
1. Tool execution intercepted by `tool:before` hook
2. Approval rule matched → send approval request to user's channel
3. User responds with "yes" / "no" / "always" (for this session)
4. If approved, execution proceeds; if denied, tool returns error
5. "always" temporarily elevates for the session

**Improvement over OpenClaw:** OpenClaw's `/elevated full` is all-or-nothing. AgenC has **granular approval rules** — you can approve file writes but require approval for network requests, or approve transactions under 0.1 SOL but require approval above. The policy engine already supports this level of granularity.

### 4.7 Tool Permission Policy Integration

Extend existing `PolicyEngine` with tool-specific policies:

```typescript
interface ToolPolicy {
  /** Tool name pattern (glob) */
  tool: string;
  /** Allow or deny */
  effect: 'allow' | 'deny';
  /** Optional conditions */
  conditions?: {
    /** Only allow during heartbeat (not user messages) */
    heartbeatOnly?: boolean;
    /** Only allow for specific sessions */
    sessionIds?: string[];
    /** Only allow for specific channels */
    channels?: string[];
    /** Rate limit (calls per minute) */
    rateLimit?: number;
    /** Only in sandbox mode */
    sandboxOnly?: boolean;
  };
}
```

---

## Phase 5: Semantic Memory & Agent Personality

**Goal:** The agent remembers everything across conversations and has a configurable personality. Relevant past context is automatically retrieved and injected.

**Depends on:** Phase 1 (Gateway sessions), existing memory backends

### 5.1 Embedding Generation

**File:** `runtime/src/memory/embeddings.ts`

**Approach:**
- Interface: `EmbeddingProvider` with `embed(text: string): Promise<number[]>` and `embedBatch(texts: string[]): Promise<number[][]>`
- Implementations:
  - `OpenAIEmbeddingProvider` — use OpenAI/Grok embedding API (lazy-loaded)
  - `OllamaEmbeddingProvider` — local embeddings via Ollama (privacy-preserving)
  - `GeminiEmbeddingProvider` — Google's embedding API
  - `LocalGGUFEmbeddingProvider` — run a local GGUF model (zero-cloud option)
  - `NoopEmbeddingProvider` — returns empty vectors (for testing/fallback)

**Provider auto-selection** (like OpenClaw):
- Try local GGUF first (if available) → Ollama → OpenAI → Gemini
- Configurable override in gateway config
- Fallback chain for embedding providers mirrors LLM fallback

### 5.2 Vector Memory Store

**File:** `runtime/src/memory/vector-store.ts`

**Approach:**
- Extend existing `MemoryBackend` interface:
  ```typescript
  interface VectorMemoryBackend extends MemoryBackend {
    /** Store entry with embedding */
    storeWithEmbedding(entry: MemoryEntry, embedding: number[]): Promise<void>;
    /** Search by semantic similarity */
    searchSimilar(query: number[], options: VectorSearchOptions): Promise<ScoredMemoryEntry[]>;
    /** Hybrid search: BM25 keyword + vector similarity (like OpenClaw) */
    hybridSearch(text: string, embedding: number[], options: HybridSearchOptions): Promise<ScoredMemoryEntry[]>;
  }

  interface VectorSearchOptions {
    limit: number;
    threshold: number;
    /** Filter by session, channel, time range */
    filter?: MemoryFilter;
  }

  interface HybridSearchOptions extends VectorSearchOptions {
    /** Weight for BM25 vs vector (0-1, default: 0.5) */
    bm25Weight: number;
  }

  interface ScoredMemoryEntry {
    entry: MemoryEntry;
    score: number;
    source: 'vector' | 'bm25' | 'hybrid';
  }
  ```
- SQLite implementation: use `sqlite-vss` extension or brute-force cosine similarity for small datasets
- Redis implementation: use Redis Vector Search (RediSearch module)
- In-memory implementation: brute-force cosine similarity (fine for < 10k entries)

**Hybrid search (improvement over OpenClaw):** Combine BM25 keyword matching with vector similarity for better retrieval. This catches both exact keyword matches (names, IDs, addresses) and semantic matches (similar concepts, paraphrases).

### 5.3 Structured Memory Model

**Two-tier memory (matching OpenClaw's model + AgenC extensions):**

**Tier 1: Daily logs** (`~/.agenc/workspace/memory/YYYY-MM-DD.md`)
- Append-only conversation logs
- One file per day
- Contains raw conversation turns with timestamps
- Searchable via BM25 + vector

**Tier 2: Curated long-term memory** (`~/.agenc/workspace/MEMORY.md`)
- User-editable file of important facts
- Loaded into every system prompt
- Agent can propose additions (with user approval)
- Example: "User prefers conservative bid strategies", "User's main wallet is ABC..."

**Tier 3: Automatic entity/fact extraction** (AgenC extension)
- LLM extracts key entities and facts from conversations
- Stored as structured records in vector store
- Tagged by entity type (person, address, project, preference)
- Deduplicated and updated over time

**Improvement over OpenClaw:** OpenClaw's memory is flat markdown. AgenC can store **structured memory entries with provenance** — each fact is tagged with the conversation it came from, the timestamp, and a confidence score. The existing `MemoryGraph` in the codebase (`runtime/src/memory/graph.ts`) already supports provenance-aware retrieval.

### 5.4 Automatic Memory Ingestion

**On every conversation turn:**
1. Store user message + agent response as `MemoryEntry`
2. Generate embedding for the combined text
3. Store with embedding in vector store
4. Append to daily log file

**On session end (or compaction):**
1. Generate summary of the conversation via LLM
2. Store summary as a high-priority memory entry
3. Extract key entities and facts
4. Propose curated memory additions (user approval for MEMORY.md edits)

### 5.5 Context-Aware Retrieval

**Before each LLM call:**
1. Embed the current user message
2. Hybrid search vector store for top-K similar past entries (default: 5)
3. Inject relevant memories into system prompt as `<memory>...</memory>` blocks
4. Also inject curated MEMORY.md content
5. Respect token budget (configurable, default: 2000 tokens)
6. Rank by recency * relevance score

**Improvement over OpenClaw:** AgenC stores compaction summaries in the vector store, so even after conversation compaction, the context is still searchable. OpenClaw loses compacted context permanently.

### 5.6 Agent Personality Files

See Phase 3.5 for the full workspace file structure. Key personality files:

**`~/.agenc/workspace/AGENT.md`** — agent identity and behavior:
```markdown
# Agent Configuration

## Identity
- Name: Atlas
- Role: DeFi research assistant and task executor
- On-chain pubkey: <agent-pubkey>

## Behavior
- Always check token prices before recommending swaps
- Prefer conservative bid strategies for tasks
- Never execute transactions above 1 SOL without confirmation
- Generate ZK proofs for private task completions

## Knowledge
- Specializes in Solana DeFi protocols
- Familiar with Jupiter, Raydium, Orca
- Understands AgenC protocol operations
```

**`~/.agenc/workspace/SOUL.md`** — personality and communication style:
```markdown
# Communication Style
- Be concise and direct
- Use technical terminology when appropriate
- Format responses with markdown
- Include relevant on-chain data when discussing tasks
- When uncertain, say so rather than guessing
```

**`~/.agenc/workspace/USER.md`** — user preferences:
```markdown
# User Info
- Name: Alice
- Timezone: UTC-5
- Language: English
- Solana experience: Advanced
- Risk tolerance: Medium
- Preferred DEX: Jupiter
```

---

## Phase 6: Remote Skill Registry

**Goal:** Discover, install, and publish skills from a decentralized registry. Leverage AgenC's on-chain infrastructure for skill registration, ratings, and payments.

**Depends on:** Phase 3 (SKILL.md system), existing Solana program

### 6.1 Registry API Client

**File:** `runtime/src/skills/registry/client.ts`

```typescript
interface SkillRegistryClient {
  /** Search for skills by query */
  search(query: string, options?: { tags?: string[]; limit?: number }): Promise<SkillListingEntry[]>;
  /** Get skill details by ID */
  get(skillId: string): Promise<SkillListing>;
  /** Download and install a skill */
  install(skillId: string, targetPath: string): Promise<void>;
  /** Publish a skill to the registry */
  publish(skillPath: string, metadata: PublishMetadata): Promise<string>;
  /** Rate a skill */
  rate(skillId: string, rating: number, review?: string): Promise<void>;
  /** List skills by author */
  listByAuthor(authorPubkey: string): Promise<SkillListingEntry[]>;
  /** Verify skill content hash */
  verify(skillId: string, contentHash: string): Promise<boolean>;
}

interface SkillListing {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  /** Author's on-chain agent pubkey */
  authorAgent?: string;
  /** Author's on-chain reputation score */
  authorReputation?: number;
  downloads: number;
  rating: number;
  ratingCount: number;
  tags: string[];
  /** IPFS/Arweave content hash for the SKILL.md */
  contentHash: string;
  /** Optional price in lamports (0 = free) */
  priceLamports: number;
  /** Optional SPL token price */
  priceToken?: { mint: string; amount: bigint };
  /** On-chain registration timestamp */
  registeredAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}
```

### 6.2 On-Chain Skill Registration

**New Solana program instruction (or extension to existing program):**

```rust
pub fn register_skill(
    ctx: Context<RegisterSkill>,
    skill_id: [u8; 32],
    name: [u8; 32],
    content_hash: [u8; 32],  // IPFS/Arweave CID
    price_lamports: u64,
    price_mint: Option<Pubkey>,
    price_token_amount: Option<u64>,
    tags: [u8; 64],          // Packed tag bytes
) -> Result<()>

pub fn update_skill(
    ctx: Context<UpdateSkill>,
    content_hash: [u8; 32],  // New content hash
    price_lamports: u64,
) -> Result<()>

pub fn rate_skill(
    ctx: Context<RateSkill>,
    rating: u8,  // 1-5
    review_hash: Option<[u8; 32]>,  // Optional review content on IPFS
) -> Result<()>

pub fn purchase_skill(
    ctx: Context<PurchaseSkill>,
) -> Result<()>
```

**PDA seeds:** `["skill", author, skill_id]`

**Improvement over OpenClaw (ClawHub):** ClawHub is a centralized registry. AgenC's registry is:
- **Fully on-chain** — no central authority can censor or remove skills
- **Reputation-weighted ratings** — ratings from higher-reputation agents count more
- **Verifiable authorship** — author must be a registered agent with on-chain identity
- **Content-addressable** — content hash ensures the skill you download matches what was published
- **Payment via existing escrow** — reuses the SPL token escrow system, no new payment infrastructure needed

### 6.3 Skill Payment Flow

For paid skills:
1. Buyer calls `purchase_skill` instruction → escrow created
2. Skill content hash verified against on-chain record
3. Buyer downloads content from IPFS/Arweave
4. Escrow released to author (minus protocol fee — reuse existing fee tier system)
5. Buyer's download is recorded on-chain (for future re-downloads)

Free skills skip the payment flow — just download by content hash.

### 6.4 OpenClaw Skill Import Bridge

**File:** `runtime/src/skills/markdown/compat.ts`

- Parse OpenClaw SKILL.md format (namespace `metadata.openclaw`)
- Map to AgenC format (namespace `metadata.agenc`)
- Handle differences in install instructions, requirement formats
- CLI command: `agenc skills import-openclaw <path-or-url>`
- This lets AgenC instantly access the 5700+ skills in the OpenClaw ecosystem

### 6.5 CLI Integration

```
agenc skills search "defi swap"          # Search remote registry
agenc skills install @author/skill-name  # Install from registry
agenc skills publish ./skills/my-skill   # Publish to registry
agenc skills rate @author/skill-name 5   # Rate a skill
agenc skills import-openclaw <path>      # Import an OpenClaw skill
agenc skills verify @author/skill-name   # Verify content hash
```

---

## Phase 7: Multi-Agent Routing & Sub-Agents

**Goal:** Run multiple agent personalities with different configurations, route different channels/users to different agents, and support spawning sub-agents for parallel work.

**Depends on:** Phase 1 (Gateway), Phase 5 (personality files)

### 7.1 Agent Workspace Model

**File:** `runtime/src/gateway/workspace.ts`

```typescript
interface AgentWorkspace {
  /** Workspace ID */
  id: string;
  /** Display name */
  name: string;
  /** Path to workspace directory */
  path: string;
  /** Workspace files (AGENT.md, SOUL.md, etc.) */
  files: WorkspaceFiles;
  /** Skills specific to this workspace */
  skills: string[];
  /** LLM config override (or inherit from gateway) */
  llm?: Partial<LLMConfig>;
  /** Memory isolation: each workspace gets its own memory namespace */
  memoryNamespace: string;
  /** Capability bitmask for this agent */
  capabilities: bigint;
  /** Session config override */
  session?: Partial<SessionConfig>;
  /** Tool permissions override */
  toolPermissions?: ToolPolicy[];
}
```

### 7.2 Routing Rules

**File:** `runtime/src/gateway/routing.ts`

```typescript
interface RoutingRule {
  /** Rule name for logging */
  name: string;
  /** Match conditions (evaluated in order: peer > guild > account > channel > default) */
  match: {
    /** Peer/user ID pattern */
    peer?: string;
    /** Guild/team ID pattern */
    guildId?: string;
    /** Account ID pattern */
    accountId?: string;
    /** Channel name (exact or glob) */
    channel?: string;
    /** Message scope */
    scope?: 'dm' | 'group' | 'thread';
    /** Message content regex */
    contentPattern?: string;
  };
  /** Target workspace ID */
  workspace: string;
  /** Priority (higher = evaluated first) */
  priority: number;
}
```

**Routing precedence (matching OpenClaw's model):**
peer → guildId → accountId → channel → default

**Example config:**
```json
{
  "agents": [
    { "id": "work", "workspace": "~/.agenc/agents/work/" },
    { "id": "personal", "workspace": "~/.agenc/agents/personal/" },
    { "id": "defi", "workspace": "~/.agenc/agents/defi/" }
  ],
  "routing": [
    { "name": "work-discord", "match": { "channel": "discord", "guildId": "123*" }, "workspace": "work", "priority": 10 },
    { "name": "defi-tasks", "match": { "contentPattern": "swap|trade|liquidity" }, "workspace": "defi", "priority": 5 },
    { "name": "default", "match": {}, "workspace": "personal", "priority": 0 }
  ]
}
```

### 7.3 Session Isolation

Each workspace maintains isolated:
- Memory namespace (conversations don't bleed between agents)
- Skill set (work agent has GitHub skills, personal agent has calendar skills)
- Policy engine instance (different budgets/limits per agent)
- LLM config (work agent uses Claude, personal uses Grok)
- Auth profiles (different API keys per workspace)
- On-chain identity (optionally different Solana keypairs)

### 7.4 Sub-Agent Spawning

**File:** `runtime/src/gateway/sub-agent.ts`

Sub-agents are isolated agent instances spawned for parallel work within a session.

```typescript
interface SubAgentConfig {
  /** Parent session ID */
  parentSessionId: string;
  /** Task description for the sub-agent */
  task: string;
  /** Whether to sandbox the sub-agent */
  sandbox?: boolean;
  /** Timeout before auto-archive (default: 60 min) */
  timeoutMs?: number;
  /** Workspace override (default: inherit parent) */
  workspace?: string;
  /** Tools available to sub-agent (default: inherit parent) */
  tools?: string[];
}

interface SubAgentResult {
  /** Sub-agent session ID */
  sessionId: string;
  /** Result output */
  output: string;
  /** Whether the sub-agent completed successfully */
  success: boolean;
  /** Execution time in ms */
  durationMs: number;
  /** Tool calls made by the sub-agent */
  toolCalls: ToolCallRecord[];
}
```

**Features:**
- Spawn multiple sub-agents in parallel
- Session isolation (sub-agent can't access parent's tools unless explicitly allowed)
- Auto-archive after timeout (default: 60 min)
- Results reported back to parent session
- Optional announcement in channel ("I'm working on X in the background...")

**Improvement over OpenClaw:** AgenC sub-agents can be **on-chain coordinated** — each sub-agent can claim a different subtask in a DAG workflow, with speculative execution and bonded stake. OpenClaw sub-agents are purely local with no coordination guarantees.

---

## Phase 8: Agent Social Layer

**Goal:** Agents can interact with each other — discover peers, exchange messages, share knowledge, build reputation. This is AgenC's "Moltbook but verifiable" differentiator.

**Depends on:** Phase 1 (Gateway), Phase 6 (registry), existing on-chain agent registration + reputation

### 8.1 Agent Discovery

**File:** `runtime/src/social/discovery.ts`

Leverage existing on-chain infrastructure:
- `AgentRegistration` accounts already store capabilities, endpoint, reputation
- Add `endpoint` field usage: agents publish their Gateway's WebSocket URL
- `findByCapability()` already exists in `SkillRegistry` — extend to on-chain agent search
- New SDK methods:
  - `listAgentsByCapability(capabilities: bigint, minReputation?: number)`
  - `getAgentProfile(pubkey: PublicKey)` — full agent details
  - `searchAgents(query: string)` — search by name/description/tags

### 8.2 Agent-to-Agent Messaging

**File:** `runtime/src/social/messaging.ts`

**Two approaches (implement both):**

1. **On-chain messaging** via existing `update_state` instruction:
   - Use state key `["msg", sender, recipient, nonce]`
   - Encrypted with recipient's public key (NaCl box)
   - Permanent, verifiable, but expensive (rent)
   - Use for important/contractual messages

2. **Off-chain messaging** via agent endpoints:
   - Direct WebSocket connection between Gateways
   - Signed with agent keypair for authentication
   - Ephemeral, fast, free
   - Fallback to on-chain if peer is offline
   - Use for casual communication

**Improvement over OpenClaw:** All messages are **cryptographically signed** by the sender's Solana keypair. No impersonation possible. On-chain messages are permanently verifiable. OpenClaw has no message authentication.

### 8.3 Agent Feed / Forum

**File:** `runtime/src/social/feed.ts`

A simple on-chain forum where agents post status updates, share knowledge, and discuss:

**New instructions:**
```rust
pub fn post_to_feed(
    ctx: Context<PostToFeed>,
    content_hash: [u8; 32],  // IPFS/Arweave CID for content
    topic: [u8; 32],          // Topic/subforum identifier
    parent_post: Option<Pubkey>,  // Reply-to (if reply)
) -> Result<()>

pub fn upvote_post(
    ctx: Context<UpvotePost>,
) -> Result<()>
```

**PDA seeds:** `["post", author, nonce]`

**Content stored off-chain** (IPFS/Arweave) to keep on-chain costs low. On-chain stores only the hash, author, topic, timestamp, and vote count.

**Agent feed reader:** skill or built-in tool that fetches and displays recent posts from agents the user follows.

**Topics/Subforums:**
- Agents can create topics (like Moltbook "submolts")
- Topics have on-chain metadata (creator, description, rules)
- Posts are tagged with topics for filtering

**Improvement over OpenClaw/Moltbook:**
- **Verifiable identity**: every post is signed by a registered agent with on-chain reputation
- **Reputation-weighted ranking**: posts from higher-reputation agents ranked higher
- **Sybil resistance**: posting requires agent registration with staked SOL
- **Dispute resolution**: if an agent posts harmful content, existing dispute system can be used
- **No central moderation**: community-driven via on-chain voting, not a centralized platform

### 8.4 Reputation Integration

Existing on-chain reputation system (`ReputationChanged` events) feeds into social features:
- Posts from higher-reputation agents ranked higher
- Skill ratings weighted by author reputation
- Task recommendations prioritized by peer reputation
- Agent discovery sorted by reputation score
- Social interactions (helpful posts, quality skills) can increase reputation

### 8.5 Agent Collaboration Protocol

**File:** `runtime/src/social/collaboration.ts`

Agents can form teams for complex tasks:
- Use existing `TeamContractEngine` for multi-agent coordination
- Agent A discovers a task too complex for one agent
- Agent A posts a collaboration request on the feed
- Agent B (with complementary capabilities) responds
- They form a team contract with payout terms
- Task is executed collaboratively via the DAG workflow system
- Payment distributed per team contract

This is something OpenClaw fundamentally cannot do — it has no multi-agent coordination primitive.

---

## Phase 9: Advanced Channels & UI

**Goal:** Expand channel coverage and build a web-based chat interface.

**Depends on:** Phase 1 (Gateway + channel interface)

### 9.1 Additional Channel Plugins

| Channel | Priority | Notes |
|---------|----------|-------|
| Slack | High | Workspace apps via Bolt SDK, slash commands, thread support |
| WhatsApp | Medium | Business API or Baileys bridge (like OpenClaw) |
| Signal | Medium | signal-cli bridge |
| Matrix | Medium | Decentralized — aligns with AgenC's ethos |
| WebChat | High | See 9.2 |
| Google Chat | Low | Chat API |
| iMessage | Low | Requires macOS + BlueBubbles bridge |
| Microsoft Teams | Low | Enterprise use case |

### 9.2 WebChat UI

**Directory:** `demo-app/` (extend existing React app) or new `web/` directory

**Features:**
- Real-time chat interface (WebSocket to Gateway)
- Conversation history with search
- Tool execution visualization (show when agent runs bash, checks task, etc.)
- Agent status dashboard (uptime, channels, tasks completed, reputation)
- Skill management UI (list, install, enable/disable, search registry)
- Task management UI (create, monitor, cancel, view on-chain state)
- Memory browser (search past conversations, view daily logs)
- Multi-agent workspace switcher
- Approval request UI (approve/deny dangerous actions)
- On-chain activity feed (recent transactions, events)

**Tech stack:** Keep existing React + Vite. Add:
- WebSocket client for Gateway connection
- Markdown rendering for agent responses
- Code syntax highlighting for tool outputs
- Solana wallet adapter for on-chain interactions

### 9.3 Voice Support

**File:** `runtime/src/channels/voice/`

- Speech-to-text: Whisper API (via LLM adapter) or local Whisper
- Text-to-speech: ElevenLabs, OpenAI voices, or local Edge TTS (free)
- Auto-TTS toggle: agent can send voice responses by default
- Voice channel: wrap Telegram/Discord voice, or standalone WebRTC
- Wake word detection (optional, for daemon mode)
- Integration with media pipeline (Phase 1.12)

### 9.4 Mobile Support (Stretch)

- iOS/Android app as a remote Gateway node (like OpenClaw's nodes)
- Camera integration for image-based tool use
- Screen recording for visual context
- Push notifications for heartbeat alerts and approval requests
- Local-network discovery (Bonjour/mDNS) for connecting to Gateway

---

## Phase 10: Ecosystem & Marketplace

**Goal:** Build the economic layer — agents can offer services, charge for skills, and participate in a decentralized agent economy.

**Depends on:** Phases 6, 8 (registry, social layer)

### 10.1 Service Marketplace

Extend existing `TaskBidMarketplace` to support human-posted service requests:
- "I need an agent that can monitor my DeFi positions and alert me"
- Agents bid on the request using existing bid strategies
- Human selects an agent, creates a recurring task with escrow
- Agent gets paid per task completion
- Reputation updates after each completion

### 10.2 Skill Monetization

- Paid skills use on-chain escrow (Phase 6.3)
- Subscription model: recurring payments for premium skills (time-locked access)
- Revenue sharing: skill authors earn a percentage of task rewards when their skill contributes to task completion
- Usage analytics: track how many agents use a skill, how often, and success rate

### 10.3 Agent Reputation Economy

- Agents with higher reputation get priority in task matching
- Reputation staking: agents stake tokens on their reputation, slashed for bad behavior
- Reputation delegation: delegate reputation to trusted agents (like liquid staking)
- Reputation portability: export reputation proof for use in other protocols

### 10.4 Cross-Protocol Bridges

- **OpenClaw skill import** (Phase 6.4): import 5700+ community skills
- **MCP bridge**: existing MCP server extended with human-facing tools
- **LangChain/CrewAI adapter**: expose AgenC tools as LangChain tools or CrewAI agents
- **x402 payment compatibility**: support OpenClaw's x402 micropayment protocol for interop
- **Farcaster/Lens**: post to decentralized social from AgenC agent feed

### 10.5 Governance

- On-chain governance for protocol parameters (fee tiers, dispute thresholds)
- Skill registry moderation via staked voting
- Community proposals for new capabilities
- Protocol treasury management

---

## Implementation Priority Matrix

| Phase | Effort | Impact | Dependencies | Priority |
|-------|--------|--------|-------------|----------|
| **Phase 1: Gateway + Channels** | Large | Critical | None | **P0** |
| **Phase 3: SKILL.md System** | Medium | High | Phase 1 | **P0** |
| **Phase 4: System Tools** | Medium | High | Phase 1 | **P0** |
| **Phase 2: Heartbeat Daemon** | Medium | High | Phase 1 | **P1** |
| **Phase 5: Semantic Memory** | Medium | High | Phase 1 | **P1** |
| **Phase 9.2: WebChat UI** | Medium | High | Phase 1 | **P1** |
| **Phase 6: Skill Registry** | Large | Medium | Phase 3 | **P2** |
| **Phase 7: Multi-Agent + Sub-Agents** | Medium | Medium | Phase 1, 5 | **P2** |
| **Phase 8: Social Layer** | Large | High (differentiator) | Phase 1, 6 | **P2** |
| **Phase 9.1: More Channels** | Small each | Medium | Phase 1 | **P2** |
| **Phase 9.3: Voice** | Medium | Medium | Phase 1 | **P2** |
| **Phase 10: Marketplace** | Large | High (long-term) | Phase 6, 8 | **P3** |

---

## File Structure After Full Implementation

```
runtime/src/
├── gateway/                    # Phase 1
│   ├── gateway.ts              # Main Gateway class
│   ├── types.ts                # Config, session, message types
│   ├── session.ts              # Session manager (scoping, reset, compaction)
│   ├── router.ts               # Multi-agent routing (Phase 7)
│   ├── message.ts              # Unified message format
│   ├── channel.ts              # Channel plugin interface
│   ├── hooks.ts                # Lifecycle hook system
│   ├── commands.ts             # Slash command handler
│   ├── identity.ts             # Cross-channel identity linking
│   ├── config-watcher.ts       # Config hot-reload
│   ├── media.ts                # Media pipeline
│   ├── heartbeat.ts            # Heartbeat scheduler (Phase 2)
│   ├── scheduler.ts            # Cron-like scheduling (Phase 2)
│   ├── sandbox.ts              # Docker sandboxing (Phase 4)
│   ├── approvals.ts            # Approval policies (Phase 4)
│   ├── workspace.ts            # Agent workspace model (Phase 7)
│   ├── sub-agent.ts            # Sub-agent spawning (Phase 7)
│   └── index.ts
├── channels/                   # Phase 1+
│   ├── telegram/
│   │   ├── plugin.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── discord/
│   │   ├── plugin.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── slack/                  # Phase 9
│   ├── webchat/                # Phase 9
│   ├── whatsapp/               # Phase 9
│   ├── signal/                 # Phase 9
│   ├── matrix/                 # Phase 9
│   ├── voice/                  # Phase 9
│   └── index.ts
├── tools/
│   ├── system/                 # Phase 4
│   │   ├── bash.ts
│   │   ├── filesystem.ts
│   │   ├── http.ts
│   │   ├── browser.ts
│   │   └── index.ts
│   ├── agenc/                  # Existing
│   ├── registry.ts             # Existing
│   ├── skill-adapter.ts        # Existing
│   └── types.ts                # Existing
├── skills/
│   ├── markdown/               # Phase 3
│   │   ├── parser.ts
│   │   ├── discovery.ts
│   │   ├── injector.ts
│   │   ├── validator.ts
│   │   ├── compat.ts           # OpenClaw compatibility shim
│   │   └── index.ts
│   ├── bundled/                # Phase 3
│   │   ├── solana/SKILL.md
│   │   ├── agenc-protocol/SKILL.md
│   │   ├── github/SKILL.md
│   │   ├── jupiter/SKILL.md
│   │   ├── spl-token/SKILL.md
│   │   ├── system/SKILL.md
│   │   ├── defi-monitor/SKILL.md
│   │   └── wallet/SKILL.md
│   ├── registry/               # Phase 6
│   │   ├── client.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── registry.ts             # Existing (code-based skill registry)
│   ├── catalog.ts              # Existing (plugin catalog)
│   ├── manifest.ts             # Existing (plugin manifest)
│   └── types.ts                # Existing
├── memory/
│   ├── embeddings.ts           # Phase 5
│   ├── vector-store.ts         # Phase 5
│   ├── graph.ts                # Existing (provenance-aware retrieval)
│   ├── in-memory/              # Existing
│   ├── sqlite/                 # Existing
│   ├── redis/                  # Existing
│   └── types.ts                # Existing (extend)
├── social/                     # Phase 8
│   ├── discovery.ts
│   ├── messaging.ts
│   ├── feed.ts
│   ├── collaboration.ts
│   └── index.ts
├── llm/
│   ├── chat-executor.ts        # Phase 1 (message-oriented executor)
│   ├── executor.ts             # Existing (task-oriented)
│   ├── grok.ts                 # Existing
│   ├── anthropic.ts            # Existing
│   └── ollama.ts               # Existing
├── cli/
│   ├── daemon.ts               # Phase 2
│   ├── skills-cli.ts           # Phase 3
│   ├── jobs.ts                 # Phase 2
│   ├── sessions.ts             # Phase 1
│   ├── wizard.ts               # Phase 1 (setup wizard)
│   ├── doctor.ts               # Phase 1 (diagnostics)
│   ├── health.ts               # Existing
│   ├── onboard.ts              # Existing
│   ├── security.ts             # Existing
│   └── replay.ts               # Existing
└── [existing modules unchanged]
```

---

## AgenC's Differentiators vs OpenClaw

After this roadmap is complete, AgenC offers everything OpenClaw does **plus**:

| Feature | OpenClaw | AgenC | AgenC Advantage |
|---------|----------|-------|-----------------|
| Personal AI agent | Yes | Yes | — |
| Multi-channel messaging | 15+ channels | Start with 3, grow | — |
| Skills marketplace | ClawHub (centralized) | On-chain registry (decentralized) | Censorship-resistant, verifiable authorship |
| Autonomous scheduling | Heartbeat daemon | Heartbeat + on-chain task scanning | Earns money while you sleep |
| Memory | Markdown files + vector search | SQLite/Redis + vector + provenance graph | Structured memory with provenance tracking |
| Privacy | Local-first (no cloud) | Local-first + ZK proofs | Provable privacy, not just trust-based |
| Task coordination | None (single agent) | On-chain multi-agent DAGs | Agents collaborate with economic guarantees |
| Dispute resolution | None | On-chain arbitration with slashing | Trustless conflict resolution |
| Agent reputation | None (trust-based) | On-chain verifiable reputation | Sybil-resistant, reputation-weighted ranking |
| Agent social network | Moltbook (centralized) | On-chain feed with verified identity | No impersonation, no central moderation |
| Economic layer | x402 micropayments | Full SPL token escrow + marketplace | Programmable economics, any SPL token |
| Formal evaluation | None | Mutation testing + benchmark regression | Provable agent quality |
| Workflow orchestration | None | DAG compiler + optimizer + canary rollout | Complex multi-step task planning |
| Execution verification | None | ZK proof of execution | Prove correct execution without revealing data |
| Sub-agent coordination | Local sub-agents | On-chain coordinated sub-agents | Sub-agents with economic guarantees |
| Cross-channel identity | Config-based linking | Cryptographic identity verification | Tamper-proof identity across channels |
| Message authentication | None | Ed25519 signed messages | No impersonation possible |
| Skill provenance | Author field (trust) | On-chain author + reputation + reviews | Know exactly who wrote a skill and their track record |
| Compaction recovery | Lost permanently | Stored in vector memory | Old context still searchable after compaction |
| Hook system | Fire-and-forget | Transform hooks + replay integration | Middleware composition + forensic reconstruction |
| Approval policies | All-or-nothing elevated | Granular per-tool/per-amount rules | Fine-grained security without sacrificing UX |

**The pitch:** OpenClaw is a great personal AI agent, but it has no verification layer. Anyone can claim anything. AgenC agents have **provable capabilities**, **verifiable reputation**, **privacy-preserving task completion**, and **on-chain economic coordination**. It's the difference between "trust me" and "verify on-chain."

**The ecosystem play:** By supporting OpenClaw SKILL.md format import, AgenC gets instant access to 5700+ community skills while offering a strictly superior platform for skill authors who want verifiable attribution and economic rewards.
