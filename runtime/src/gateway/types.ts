/**
 * Gateway type definitions.
 *
 * Defines configuration, state, events, and control plane message types
 * for the AgenC Gateway process.
 *
 * @module
 */

import type { GatewayAuthConfig } from "./remote-types.js";
import type { DesktopSandboxConfig } from "../desktop/types.js";
import type { SocialPeerDirectoryEntry } from "../social/types.js";

// ============================================================================
// Gateway Configuration
// ============================================================================

export interface GatewayLLMConfig {
  provider: "grok" | "ollama";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Enable provider-native web search when the primary LLM supports it. */
  webSearch?: boolean;
  /** Routing preference for provider-native web search. */
  searchMode?: "auto" | "on" | "off";
  /** Maximum output tokens per completion (provider request parameter). */
  maxTokens?: number;
  /** Model context window in tokens for adaptive prompt budgeting. */
  contextWindowTokens?: number;
  /** Hard cap (chars) applied after adaptive prompt budget calculation. */
  promptHardMaxChars?: number;
  /** Reserved tokens for protocol overhead when sizing prompt budget. */
  promptSafetyMarginTokens?: number;
  /** Approximate chars/token ratio used by the prompt allocator. */
  promptCharPerToken?: number;
  /** Upper bound for additive runtime hint system messages per execution. */
  maxRuntimeHints?: number;
  /** Request timeout in milliseconds for provider calls (default: provider-specific). */
  timeoutMs?: number;
  /** End-to-end timeout in milliseconds for one chat request execution. */
  requestTimeoutMs?: number;
  /** Timeout in milliseconds for a single tool execution call. */
  toolCallTimeoutMs?: number;
  /** Optional overrides for LLM failure-class retry policy matrix. */
  retryPolicy?: Partial<Record<
    | "validation_error"
    | "provider_error"
    | "authentication_error"
    | "rate_limited"
    | "timeout"
    | "tool_error"
    | "budget_exceeded"
    | "no_progress"
    | "cancelled"
    | "unknown",
    {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      jitter?: boolean;
      circuitBreakerEligible?: boolean;
    }
  >>;
  /** Session-level circuit breaker for repeated failing tool patterns. */
  toolFailureCircuitBreaker?: {
    enabled?: boolean;
    threshold?: number;
    windowMs?: number;
    cooldownMs?: number;
  };
  /** Maximum token budget per session. 0 or undefined = unlimited. */
  sessionTokenBudget?: number;
  /** Maximum tool call rounds per message. Default: 5. */
  maxToolRounds?: number;
  /** Enable planner/executor split for high-complexity turns. */
  plannerEnabled?: boolean;
  /** Maximum output tokens for the planner pass. */
  plannerMaxTokens?: number;
  /** Maximum tool calls allowed in one request execution. */
  toolBudgetPerRequest?: number;
  /** Maximum model recalls after the initial call per request. */
  maxModelRecallsPerRequest?: number;
  /** Maximum failed tool calls allowed per request before aborting. */
  maxFailureBudgetPerRequest?: number;
  /** Allow model-emitted parallel tool calls. Default: false (serialized). */
  parallelToolCalls?: boolean;
  /** Optional xAI Responses API stateful continuation controls. */
  statefulResponses?: {
    /** Enable session-scoped continuation using provider-managed response IDs. */
    enabled?: boolean;
    /** Explicit `store` value sent to provider calls while stateful mode is enabled. */
    store?: boolean;
    /** Retry once statelessly when continuation anchors are missing/mismatched/stale. */
    fallbackToStateless?: boolean;
    /** Optional server-side Responses API compaction controls. */
    compaction?: {
      /** Enable provider-native server-side compaction. */
      enabled?: boolean;
      /** Rendered-token threshold for provider compaction. */
      compactThreshold?: number;
      /** Retry once without compaction if the provider rejects the field. */
      fallbackOnUnsupported?: boolean;
    };
  };
  /** Optional Phase 6 dynamic tool-routing controls. */
  toolRouting?: {
    /** Enable per-turn tool subset routing. */
    enabled?: boolean;
    /** Minimum tools to include in a routed subset. */
    minToolsPerTurn?: number;
    /** Maximum tools to include in a routed subset. */
    maxToolsPerTurn?: number;
    /** Maximum tools to include in one-turn expanded retry subsets. */
    maxExpandedToolsPerTurn?: number;
    /** Session intent-cluster route cache TTL in milliseconds. */
    cacheTtlMs?: number;
    /** Minimum cache confidence required before route reuse. */
    minCacheConfidence?: number;
    /** Jaccard threshold below which intent shift invalidates cached routes. */
    pivotSimilarityThreshold?: number;
    /** Consecutive routing misses required before cache invalidation. */
    pivotMissThreshold?: number;
    /** Tool names always pinned in routed subsets when available. */
    mandatoryTools?: string[];
    /** Optional per-family tool caps (desktop/system/playwright/etc). */
    familyCaps?: Record<string, number>;
  };
  /** Optional sub-agent orchestration controls. */
  subagents?: GatewaySubagentConfig;
  /** Additional LLM providers for fallback (tried in order after primary fails). */
  fallback?: GatewayLLMConfig[];
}

export type GatewaySubagentMode = "manager_tools" | "handoff" | "hybrid";
export type GatewaySubagentChildToolAllowlistStrategy =
  | "inherit_intersection"
  | "explicit_only";
export type GatewaySubagentFallbackBehavior =
  | "continue_without_delegation"
  | "fail_request";
export type GatewaySubagentChildProviderStrategy =
  | "same_as_parent"
  | "capability_matched";
export type GatewaySubagentDelegationAggressiveness =
  | "conservative"
  | "balanced"
  | "aggressive"
  | "adaptive";
export type GatewaySubagentHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration";

export interface GatewaySubagentConfig {
  /** Master enable switch for sub-agent orchestration. */
  enabled?: boolean;
  /** Delegation control mode. */
  mode?: GatewaySubagentMode;
  /** Global delegation aggressiveness profile exposed to users/operators. */
  delegationAggressiveness?: GatewaySubagentDelegationAggressiveness;
  /** Maximum concurrent sub-agents across one request/session execution. */
  maxConcurrent?: number;
  /** Maximum delegation recursion depth. */
  maxDepth?: number;
  /** Maximum child tasks spawned from one planner turn. */
  maxFanoutPerTurn?: number;
  /** Hard cap on total child agents in one parent request. */
  maxTotalSubagentsPerRequest?: number;
  /** Hard cap on cumulative child tool calls across one request tree. */
  maxCumulativeToolCallsPerRequestTree?: number;
  /** Hard cap on cumulative child LLM tokens across one request tree. */
  maxCumulativeTokensPerRequestTree?: number;
  /** Default timeout for child agent execution in milliseconds. */
  defaultTimeoutMs?: number;
  /** Utility score threshold (0-1) required before delegation. */
  spawnDecisionThreshold?: number;
  /** Minimum planner confidence (0-1) required before handoff delegation mode. */
  handoffMinPlannerConfidence?: number;
  /** Force verifier/critic stage after child execution. */
  forceVerifier?: boolean;
  /** Allow multiple child subtasks to run in parallel. */
  allowParallelSubtasks?: boolean;
  /** Hard-blocked safety/compliance task classes that cannot be delegated. */
  hardBlockedTaskClasses?: GatewaySubagentHardBlockedTaskClass[];
  /** Parent tools allowed to initiate delegation workflows. */
  allowedParentTools?: string[];
  /** Parent tools that may never initiate delegation workflows. */
  forbiddenParentTools?: string[];
  /** Strategy for deriving child tool allowlists. */
  childToolAllowlistStrategy?: GatewaySubagentChildToolAllowlistStrategy;
  /** Child model/provider routing strategy. */
  childProviderStrategy?: GatewaySubagentChildProviderStrategy;
  /** Behavior when delegation is rejected/fails policy checks. */
  fallbackBehavior?: GatewaySubagentFallbackBehavior;
  /** Optional online policy-learning controls (bandit routing + trajectories). */
  policyLearning?: GatewaySubagentPolicyLearningConfig;
}

export interface GatewaySubagentPolicyLearningConfig {
  /** Enable online bandit tuning and trajectory emission. */
  enabled?: boolean;
  /** Epsilon-greedy exploration probability in [0, 1]. */
  epsilon?: number;
  /** Global exploration budget for random arm pulls. */
  explorationBudget?: number;
  /** Required initial pulls per arm/context before exploitation. */
  minSamplesPerArm?: number;
  /** UCB exploration scale (>0). */
  ucbExplorationScale?: number;
  /** Optional strategy-arm catalog with threshold offsets. */
  arms?: Array<{
    id: string;
    thresholdOffset?: number;
    description?: string;
  }>;
}

export interface GatewayMemoryConfig {
  backend: "memory" | "sqlite" | "redis";
  /** SQLite: database file path. Default: ~/.agenc/memory.db */
  dbPath?: string;
  /** Redis: connection URL (e.g. 'redis://localhost:6379') */
  url?: string;
  /** Redis: host. Default: 'localhost'. Ignored when url is set. */
  host?: string;
  /** Redis: port. Default: 6379. Ignored when url is set. */
  port?: number;
  /** Redis: password */
  password?: string;
  /** AES-256-GCM encryption key for content at rest (hex-encoded, 64 hex chars = 32 bytes). */
  encryptionKey?: string;
  /** Embedding provider for semantic memory. Auto-selects if omitted. */
  embeddingProvider?: "ollama" | "openai" | "noop";
  /** API key for embedding provider. Falls back to llm.apiKey. */
  embeddingApiKey?: string;
  /** Base URL for embedding provider (e.g. Ollama host). */
  embeddingBaseUrl?: string;
  /** Embedding model name (e.g. 'nomic-embed-text'). */
  embeddingModel?: string;
}

export interface GatewayChannelConfig {
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface GatewayAgentConfig {
  name: string;
  /** Capability bitmask as decimal string (bigint doesn't survive JSON round-trip) */
  capabilities?: string;
  endpoint?: string;
  stake?: string;
}

export interface GatewayConnectionConfig {
  rpcUrl: string;
  keypairPath?: string;
  endpoints?: string[];
}

export interface GatewayLoggingConfig {
  level?: "debug" | "info" | "warn" | "error";
  trace?: {
    /** Enable verbose per-turn chat/tool tracing in daemon logs. */
    enabled?: boolean;
    /** Include serialized session history in trace output. */
    includeHistory?: boolean;
    /** Include the assembled system prompt in trace output. */
    includeSystemPrompt?: boolean;
    /** Include raw tool-call arguments in trace output. */
    includeToolArgs?: boolean;
    /** Include raw tool-call results in trace output. */
    includeToolResults?: boolean;
    /** Include raw provider request/response/error payloads in trace output. */
    includeProviderPayloads?: boolean;
    /** Max characters retained for any traced text field. */
    maxChars?: number;
  };
}

export interface GatewayBindConfig {
  port: number;
  bind?: string;
}

export interface GatewayVoiceConfig {
  enabled?: boolean;
  voice?: "Ara" | "Rex" | "Sal" | "Eve" | "Leo";
  mode?: "vad" | "push-to-talk";
  /** Separate API key for voice. Falls back to llm.apiKey when not set. */
  apiKey?: string;
  /** xAI Realtime model for voice sessions. Default: grok-4-1-fast-reasoning. */
  model?: string;
  /** VAD silence threshold (0.0–1.0). Higher = requires louder speech. Default: 0.5 */
  vadThreshold?: number;
  /** Silence duration (ms) before turn ends. Higher = more patient. Default: 800 */
  vadSilenceDurationMs?: number;
  /** Audio prefix (ms) to include before speech start. Default: 300 */
  vadPrefixPaddingMs?: number;
}

export interface GatewayTelemetryConfig {
  /** Enable metrics collection. Default: true. */
  enabled?: boolean;
  /** Auto-flush interval in ms. 0 = manual only. Default: 60000. */
  flushIntervalMs?: number;
}

export interface GatewayMCPConfig {
  /** External MCP servers to connect to via stdio transport */
  servers: GatewayMCPServerConfig[];
}

export type GatewayMCPTrustTier = "trusted" | "sandboxed" | "untrusted";

export interface GatewayMCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  name: string;
  /** Executable command (e.g. "npx", "node") */
  command: string;
  /** Command arguments */
  args: string[];
  /** Optional environment variables for the child process */
  env?: Record<string, string>;
  /** Whether this server is enabled. Default: true */
  enabled?: boolean;
  /** Connection timeout in ms. Default: 30000 */
  timeout?: number;
  /** Route this server into a container instead of running on the host.
   *  Currently only "desktop" is supported — the MCP server will be spawned
   *  via `docker exec` inside the desktop sandbox container per session. */
  container?: "desktop";
  /** Declarative runtime trust tier for tool exposure and isolation policy. */
  trustTier?: GatewayMCPTrustTier;
  /** Per-server runtime risk controls. */
  riskControls?: {
    /** Allow-list of MCP tool names or globs exposed from this server. */
    toolAllowList?: string[];
    /** Deny-list of MCP tool names or globs exposed from this server. */
    toolDenyList?: string[];
    /** Require runtime approval before invoking any exposed tool from this server. */
    requireApproval?: boolean;
  };
  /** Per-server supply-chain assertions. */
  supplyChain?: {
    /** Require npx/dlx style package specs to pin an explicit version. */
    requirePinnedPackageVersion?: boolean;
    /** Require the desktop image used for this container-routed server to be digest pinned. */
    requireDesktopImageDigest?: boolean;
    /** Optional SHA-256 for the resolved executable binary. */
    binarySha256?: string;
    /** Optional SHA-256 for the filtered exposed MCP tool catalog. */
    catalogSha256?: string;
  };
}

export interface GatewayPolicyConfig {
  enabled?: boolean;
  defaultTenantId?: string;
  defaultProjectId?: string;
  simulationMode?: "off" | "shadow";
  toolAllowList?: string[];
  toolDenyList?: string[];
  credentialAllowList?: string[];
  networkAccess?: {
    allowHosts?: string[];
    denyHosts?: string[];
  };
  writeScope?: {
    allowRoots?: string[];
    denyRoots?: string[];
  };
  credentialCatalog?: Record<
    string,
    {
      sourceEnvVar: string;
      domains: string[];
      headerTemplates?: Record<string, string>;
      allowedTools?: string[];
      ttlMs?: number;
    }
  >;
  actionBudgets?: Record<string, { limit: number; windowMs: number }>;
  /** Spend budget. `limitLamports` is a decimal string for JSON round-trip safety. */
  spendBudget?: { limitLamports: string; windowMs: number };
  tokenBudget?: { limitTokens: number; windowMs: number };
  runtimeBudget?: { maxElapsedMs: number };
  processBudget?: { maxConcurrent: number };
  scopedActionBudgets?: {
    tenant?: Record<string, { limit: number; windowMs: number }>;
    project?: Record<string, { limit: number; windowMs: number }>;
    run?: Record<string, { limit: number; windowMs: number }>;
  };
  scopedSpendBudgets?: {
    tenant?: { limitLamports: string; windowMs: number };
    project?: { limitLamports: string; windowMs: number };
    run?: { limitLamports: string; windowMs: number };
  };
  scopedTokenBudgets?: {
    tenant?: { limitTokens: number; windowMs: number };
    project?: { limitTokens: number; windowMs: number };
    run?: { limitTokens: number; windowMs: number };
  };
  scopedRuntimeBudgets?: {
    tenant?: { maxElapsedMs: number };
    project?: { maxElapsedMs: number };
    run?: { maxElapsedMs: number };
  };
  scopedProcessBudgets?: {
    tenant?: { maxConcurrent: number };
    project?: { maxConcurrent: number };
    run?: { maxConcurrent: number };
  };
  /** Max risk score in [0, 1]. */
  maxRiskScore?: number;
  policyClassRules?: Partial<
    Record<
      | "read_only"
      | "reversible_side_effect"
      | "destructive_side_effect"
      | "irreversible_financial_action"
      | "credential_secret_access",
      {
        deny?: boolean;
        maxRiskScore?: number;
      }
    >
  >;
  audit?: {
    enabled?: boolean;
    signingKey?: string;
    retentionMs?: number;
    maxEntries?: number;
    retentionMode?: "delete" | "archive";
    legalHold?: boolean;
    redaction?: {
      redactActors?: boolean;
      stripFields?: string[];
      redactPatterns?: string[];
    };
  };
  tenantBundles?: Record<
    string,
    Omit<
      GatewayPolicyConfig,
      | "tenantBundles"
      | "projectBundles"
      | "defaultTenantId"
      | "defaultProjectId"
      | "simulationMode"
      | "audit"
      | "credentialCatalog"
    >
  >;
  projectBundles?: Record<
    string,
    Omit<
      GatewayPolicyConfig,
      | "tenantBundles"
      | "projectBundles"
      | "defaultTenantId"
      | "defaultProjectId"
      | "simulationMode"
      | "audit"
      | "credentialCatalog"
    >
  >;
  circuitBreaker?: {
    enabled?: boolean;
    threshold: number;
    windowMs: number;
    mode: "pause_discovery" | "halt_submissions" | "safe_mode";
  };
}

export interface GatewayApprovalConfig {
  /** Opt-in approval engine for gated tool calls. */
  enabled?: boolean;
  /** Require approval for desktop click/type/scroll automation tools. */
  gateDesktopAutomation?: boolean;
  timeoutMs?: number;
  defaultSlaMs?: number;
  defaultEscalationDelayMs?: number;
  resolverSigningKey?: string;
}

export interface GatewayMarketplaceConfig {
  enabled?: boolean;
  defaultMatchingPolicy?: "best_price" | "best_eta" | "weighted_score";
  antiSpam?: {
    maxActiveBidsPerBidderPerTask?: number;
    maxBidsPerTask?: number;
  };
  authorizedSelectorIds?: string[];
}

export interface GatewaySocialConfig {
  enabled?: boolean;
  discoveryEnabled?: boolean;
  discoveryCacheTtlMs?: number;
  discoveryCacheMaxEntries?: number;
  messagingEnabled?: boolean;
  messagingMode?: "on-chain" | "off-chain" | "auto";
  messagingPort?: number;
  feedEnabled?: boolean;
  collaborationEnabled?: boolean;
  reputationEnabled?: boolean;
  /**
   * Optional bounded peer directory for stable alias resolution in the social
   * tool surface. Intended for active peers, not a global registry.
   */
  peerDirectory?: readonly SocialPeerDirectoryEntry[];
}

export type GatewayBackgroundRunNotificationEvent =
  | "run_started"
  | "run_updated"
  | "run_blocked"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_controlled";

export type GatewayBackgroundRunNotificationSinkType =
  | "webhook"
  | "slack_webhook"
  | "discord_webhook"
  | "email_webhook"
  | "mobile_push_webhook";

export interface GatewayBackgroundRunNotificationSink {
  readonly id: string;
  readonly type: GatewayBackgroundRunNotificationSinkType;
  readonly url: string;
  readonly enabled?: boolean;
  readonly events?: readonly GatewayBackgroundRunNotificationEvent[];
  readonly sessionIds?: readonly string[];
  readonly headers?: Record<string, string>;
  readonly signingSecret?: string;
  readonly recipient?: string;
}

export interface GatewayBackgroundRunNotificationConfig {
  readonly enabled?: boolean;
  readonly sinks?: readonly GatewayBackgroundRunNotificationSink[];
}

export interface GatewayAutonomyFeatureFlags {
  readonly backgroundRuns?: boolean;
  readonly multiAgent?: boolean;
  readonly notifications?: boolean;
  readonly replayGates?: boolean;
  readonly canaryRollout?: boolean;
}

export interface GatewayAutonomyKillSwitches {
  readonly backgroundRuns?: boolean;
  readonly multiAgent?: boolean;
  readonly notifications?: boolean;
  readonly replayGates?: boolean;
  readonly canaryRollout?: boolean;
}

export interface GatewayAutonomySloTargets {
  readonly runStartLatencyMs?: number;
  readonly updateCadenceMs?: number;
  readonly completionAccuracyRate?: number;
  readonly recoverySuccessRate?: number;
  readonly stopLatencyMs?: number;
  readonly eventLossRate?: number;
}

export interface GatewayAutonomyCanaryConfig {
  readonly enabled?: boolean;
  readonly tenantAllowList?: readonly string[];
  readonly featureAllowList?: readonly string[];
  readonly domainAllowList?: readonly string[];
  readonly percentage?: number;
}

export interface GatewayAutonomyConfig {
  readonly enabled?: boolean;
  readonly featureFlags?: GatewayAutonomyFeatureFlags;
  readonly killSwitches?: GatewayAutonomyKillSwitches;
  readonly notifications?: GatewayBackgroundRunNotificationConfig;
  readonly slo?: GatewayAutonomySloTargets;
  readonly canary?: GatewayAutonomyCanaryConfig;
}

export interface GatewayConfig {
  gateway: GatewayBindConfig;
  agent: GatewayAgentConfig;
  connection: GatewayConnectionConfig;
  llm?: GatewayLLMConfig;
  memory?: GatewayMemoryConfig;
  channels?: Record<string, GatewayChannelConfig>;
  logging?: GatewayLoggingConfig;
  auth?: GatewayAuthConfig;
  voice?: GatewayVoiceConfig;
  telemetry?: GatewayTelemetryConfig;
  desktop?: DesktopSandboxConfig;
  /** External MCP server connections */
  mcp?: GatewayMCPConfig;
  /** Policy engine: budget enforcement + circuit breakers on tool calls */
  policy?: GatewayPolicyConfig;
  /** Approval engine: SLAs and escalation behavior for gated tool calls. */
  approvals?: GatewayApprovalConfig;
  /** Marketplace: task bidding between agents */
  marketplace?: GatewayMarketplaceConfig;
  /** Social module: discovery, messaging, feed, reputation, collaboration */
  social?: GatewaySocialConfig;
  /** Runtime autonomy controls, notifications, and rollout policy. */
  autonomy?: GatewayAutonomyConfig;
}

// ============================================================================
// Gateway State
// ============================================================================

export type GatewayState = "stopped" | "starting" | "running" | "stopping";

// ============================================================================
// Gateway Status Snapshot
// ============================================================================

export interface GatewayStatus {
  readonly state: GatewayState;
  readonly uptimeMs: number;
  readonly channels: string[];
  readonly activeSessions: number;
  readonly controlPlanePort: number;
  readonly backgroundRuns?: GatewayBackgroundRunStatus;
}

export interface GatewayBackgroundRunAlert {
  readonly id: string;
  readonly severity: "info" | "warn" | "error";
  readonly code: string;
  readonly message: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface GatewayBackgroundRunMetrics {
  readonly startedTotal: number;
  readonly completedTotal: number;
  readonly failedTotal: number;
  readonly blockedTotal: number;
  readonly recoveredTotal: number;
  readonly meanLatencyMs?: number;
  readonly meanTimeToFirstAckMs?: number;
  readonly meanTimeToFirstVerifiedUpdateMs?: number;
  readonly falseCompletionRate?: number;
  readonly blockedWithoutNoticeRate?: number;
  readonly meanStopLatencyMs?: number;
  readonly recoverySuccessRate?: number;
  readonly verifierAccuracyRate?: number;
}

export interface GatewayBackgroundRunStatus {
  readonly multiAgentEnabled: boolean;
  readonly activeTotal: number;
  readonly queuedSignalsTotal: number;
  readonly stateCounts: Record<
    | "pending"
    | "running"
    | "working"
    | "blocked"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled"
    | "suspended",
    number
  >;
  readonly recentAlerts: readonly GatewayBackgroundRunAlert[];
  readonly metrics: GatewayBackgroundRunMetrics;
}

// ============================================================================
// Gateway Events
// ============================================================================

export type GatewayEvent =
  | "started"
  | "stopped"
  | "configReloaded"
  | "configError"
  | "channelConnected"
  | "channelDisconnected"
  | "error";

export type GatewayEventHandler = (...args: unknown[]) => void;

export interface GatewayEventSubscription {
  unsubscribe(): void;
}

// ============================================================================
// Control Plane Messages
// ============================================================================

export type ControlMessageType =
  | "ping"
  | "status"
  | "reload"
  | "channels"
  | "sessions"
  | "sessions.kill"
  | "auth"
  | "config.get"
  | "config.set"
  | "wallet.info"
  | "wallet.airdrop"
  | "ollama.models";

export interface ControlMessage {
  type: ControlMessageType;
  id?: string;
  payload?: unknown;
}

export interface ControlResponse {
  type: string;
  payload?: unknown;
  id?: string;
  error?: string;
}

// ============================================================================
// Channel Handle
// ============================================================================

export interface ChannelHandle {
  readonly name: string;
  /** Live health check — implementations should report current status */
  isHealthy(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ============================================================================
// WebChat Handler
// ============================================================================

/**
 * Delegate interface for routing dotted-namespace WebSocket messages
 * from the Gateway to the WebChat channel plugin.
 */
export interface WebChatHandler {
  handleMessage(
    clientId: string,
    type: string,
    msg: ControlMessage,
    send: (response: ControlResponse) => void,
  ): void;
}

// ============================================================================
// Config Diff
// ============================================================================

export interface ConfigDiff {
  safe: string[];
  unsafe: string[];
}
