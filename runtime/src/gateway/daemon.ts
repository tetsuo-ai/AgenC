/**
 * Daemon lifecycle management — PID files, signal handling, and service templates.
 *
 * Wraps the Gateway with Unix daemon conventions: PID file management,
 * graceful signal handling (SIGTERM/SIGINT/SIGHUP), and systemd/launchd
 * service file generation.
 *
 * @module
 */

import {
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
  access,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
// spawn import moved to ./daemon-command-registry.ts
import { Gateway } from "./gateway.js";
import { loadGatewayConfig } from "./config-watcher.js";
import { GatewayLifecycleError, GatewayStateError } from "./errors.js";
import { toErrorMessage } from "../utils/async.js";
import type {
  GatewayConfig,
  GatewayLLMConfig,
  GatewayMCPServerConfig,
  GatewayBackgroundRunStatus,
  GatewayStatus,
  ConfigDiff,
  GatewayLoggingConfig,
  ControlResponse,
  InitRunControlPayload,
  InitRunControlResponsePayload,
} from "./types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  logTraceErrorEvent,
  logTraceEvent,
  resolveTraceFanoutEnabled,
  resolveTraceLoggingConfig,
  sanitizeLifecyclePayloadData,
  summarizeGatewayMessageForTrace,
  summarizeTraceValue,
  summarizeToolResultForTrace,
  truncateToolLogText,
  buildSubagentTraceId,
  createTurnTraceId,
} from "./daemon-trace.js";
import type { ResolvedTraceLoggingConfig } from "./daemon-trace.js";
import { WebChatChannel } from "../channels/webchat/plugin.js";
import { WorkspaceManager } from "./workspace.js";
import {
  resolveHostWorkspacePath,
} from "./host-workspace.js";
import {
  probeHostToolingProfile,
  findPackageManifestWorkspaceProtocolSpecifiers,
  type HostToolingProfile,
} from "./host-tooling.js";
import {
  SessionIsolationManager,
  type SubAgentSessionIdentity,
} from "./session-isolation.js";
import {
  SubAgentManager,
} from "./sub-agent.js";
import {
  DelegationPolicyEngine,
  DelegationVerifierService,
  SubAgentLifecycleEmitter,
  type SubAgentLifecycleEvent,
  type DelegationToolCompositionContext,
  type DelegationToolCompositionResolver,
} from "./delegation-runtime.js";
import type {
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMTool,
  ToolHandler,
  StreamProgressCallback,
  LLMMessage,
} from "../llm/types.js";
import { type Tool } from "../tools/types.js";
import type { GatewayMessage } from "./message.js";
import { createGatewayMessage } from "./message.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { createChatExecutor } from "./chat-executor-factory.js";
import {
  didToolCallFail,
  normalizeToolCallArguments,
  parseToolResultObject,
} from "../llm/chat-executor-tool-utils.js";
import { resolveToolContractExecutionBlock } from "../llm/chat-executor-contract-guidance.js";
import {
  getProviderNativeAdvertisedToolNames,
  getProviderNativeWebSearchRoutingDecision,
} from "../llm/provider-native-search.js";
import {
  createLLMProviders as createLLMProvidersStandalone,
  resolveLlmContextWindowTokens as resolveLlmContextWindowTokensStandalone,
  resolveProviderExecutionBudget as resolveProviderExecutionBudgetStandalone,
  buildPromptBudgetConfig,
  resolveSessionTokenBudget,
  DEFAULT_GROK_MODEL,
  type LLMProviderConfigCatalogEntry,
} from "./llm-provider-manager.js";
import type {
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatToolRoutingSummary,
} from "../llm/chat-executor.js";
import {
  DelegationBanditPolicyTuner,
  InMemoryDelegationTrajectorySink,
} from "../llm/delegation-learning.js";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from "../llm/chat-executor-constants.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  SystemRemoteJobManager,
} from "../tools/system/remote-job.js";
import { DEFAULT_TIMEOUT_MS as DEFAULT_BASH_TOOL_TIMEOUT_MS } from "../tools/system/types.js";
import {
  SkillDiscovery,
  type DiscoveryPaths,
  type DiscoveredSkill,
} from "../skills/markdown/discovery.js";
import { MarkdownSkillInjector } from "../skills/markdown/injector.js";
import { VoiceBridge } from "./voice-bridge.js";
import { createSessionToolHandler } from "./tool-handler-factory.js";
import {
  configureDesktopRoutingForWebChat as configureDesktopRouting,
  cleanupDesktopSessionResources as cleanupDesktopSession,
  type DesktopRouterFactory,
} from "./desktop-routing-config.js";
import { ApprovalEngine } from "./approvals.js";
import { resolveGatewayApprovalRules } from "./approval-runtime.js";
import { buildToolPolicyAction } from "../policy/tool-governance.js";
import {
  SessionCredentialBroker,
  type GovernanceAuditEventType,
} from "../policy/index.js";
import type { MemoryBackend } from "../memory/types.js";
import { entryToMessage } from "../memory/types.js";
import { createMemoryRetrievers } from "./memory-retriever-factory.js";
import { createMemoryBackend } from "./memory-backend-factory.js";
// loadWallet moved to ./daemon-tool-registry.ts and ./daemon-feature-wiring.ts
import {
  clearWebSessionRuntimeState,
  hydrateWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  executeWebChatConversationTurn as runWebChatConversationTurn,
} from "./daemon-webchat-turn.js";
import { UnifiedTelemetryCollector } from "../telemetry/collector.js";
import type { TelemetrySnapshot } from "../telemetry/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import {
  SessionManager,
} from "./session.js";
import {

  getDefaultWorkspacePath,
} from "./workspace-files.js";
import { SlashCommandRegistry } from "./commands.js";
import {
  buildDesktopContext,
  buildSystemPrompt,
  resolveActiveHostWorkspacePath,
} from "./system-prompt-builder.js";
import { HookDispatcher, createBuiltinHooks } from "./hooks.js";
import {
  INIT_ROUTED_TOOL_NAMES,
  runModelBackedProjectGuide,
} from "./init-runner.js";
import { ProgressTracker, summarizeToolResult } from "./progress.js";
import {
  inferContextWindowTokens,
  normalizeGrokModel,
} from "./context-window.js";
import {
  PipelineExecutor,
} from "../workflow/pipeline.js";
import { ConnectionManager } from "../connection/manager.js";
import type { ChannelPlugin } from "./channel.js";
import {
  wireExternalChannels as wireExternalChannelsStandalone,
  type ChannelWiringDeps,
  type ExternalChannelRegistry,
} from "./channel-wiring.js";
import type { ProactiveCommunicator } from "./proactive.js";
import { ToolRouter, type ToolRoutingDecision } from "./tool-routing.js";
import {
  filterLlmToolsByEnvironment,
  type ToolEnvironmentMode,
} from "./tool-environment-policy.js";
import { SubAgentOrchestrator } from "./subagent-orchestrator.js";
import {
  type DelegationAggressivenessProfile,
  type ResolvedSubAgentRuntimeConfig,
  SUBAGENT_CONFIG_HARD_CAPS,
  resolveSubAgentRuntimeConfig,
  requiresSubAgentInfrastructureRecreate,
  createDelegatingSubAgentLLMProvider,
  getActiveDelegationAggressiveness as getActiveDelegationAggressivenessImpl,
  resolveDelegationScoreThreshold as resolveDelegationScoreThresholdImpl,
  selectSubagentProviderForTask as selectSubagentProviderForTaskImpl,
  refreshSubAgentToolCatalog as refreshSubAgentToolCatalogImpl,
  ensureSubAgentDefaultWorkspace as ensureSubAgentDefaultWorkspaceImpl,
  configureDelegationRuntimeServices as configureDelegationRuntimeServicesImpl,
  clearDelegationRuntimeServices as clearDelegationRuntimeServicesImpl,
  destroySubAgentInfrastructure as destroySubAgentInfrastructureImpl,
} from "./subagent-infrastructure.js";
// deriveCuriosityInterestsFromWorkspaceFiles moved to ./daemon-feature-wiring.ts
import {
  BackgroundRunSupervisor,
  inferBackgroundRunIntent,
  isBackgroundRunPauseRequest,
  isBackgroundRunResumeRequest,
  isBackgroundRunStatusRequest,
  isBackgroundRunStopRequest,
} from "./background-run-supervisor.js";

function firstSurfaceSummaryLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line && line.length > 0 ? line : undefined;
}
import { BackgroundRunNotifier } from "./background-run-notifier.js";
import { BackgroundRunStore } from "./background-run-store.js";
import type {
  BackgroundRunContract,
  PersistedBackgroundRun,
} from "./background-run-store.js";
import type {
  BackgroundRunControlAction,
  BackgroundRunOperatorAvailability,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from "./background-run-operator.js";
import {
  DurableSubrunOrchestrator,
  type DurableSubrunAdmissionDecision,
} from "./durable-subrun-orchestrator.js";
import { evaluateAutonomyCanaryAdmission } from "./autonomy-rollout.js";
import {
  formatBackgroundRunAdmissionDenied,
  formatBackgroundRunStatus,
  formatInactiveBackgroundRunStatus,
  formatInactiveBackgroundRunStop,
} from "./background-run-control.js";
import {
  createBackgroundRunToolAfterHook,
  createBackgroundRunWebhookRoute,
} from "./background-run-wake-adapters.js";
import {
  getMissingDoomEvidenceGap,
  inferDoomTurnContract,
  summarizeDoomToolEvidence,
} from "../llm/chat-executor-doom.js";
import { parseBackgroundRunQualityArtifact } from "../eval/background-run-quality.js";
import type { DelegationBenchmarkSummary } from "../eval/delegation-benchmark.js";
import {
  createDaemonCommandRegistry,
  type CommandRegistryDaemonContext,
  type WebChatSkillSummary,
  didEvalScriptPass as didEvalScriptPassImported,
  formatEvalScriptReply as formatEvalScriptReplyImported,
  type EvalScriptResult,
} from "./daemon-command-registry.js";
import {
  createDaemonToolRegistry,
} from "./daemon-tool-registry.js";
import {
  wireMarketplace as wireMarketplaceStandalone,
  wireSocial as wireSocialStandalone,
  wireAutonomousFeatures as wireAutonomousFeaturesStandalone,
  type FeatureWiringContext,
} from "./daemon-feature-wiring.js";
import {
  blockUntilDoomStopTool,
  isDoomStopRequest,
} from "./doom-stop-guard.js";
import {
  ObservabilityService,
  setDefaultObservabilityService,
} from "../observability/index.js";

export {
  formatTracePayloadForLog,
  resolveTraceFanoutEnabled,
  resolveTraceLoggingConfig,
  sanitizeToolResultTextForTrace,
  summarizeToolArgsForLog,
  summarizeToolFailureForLog,
  summarizeToolResultForTrace,
} from "./daemon-trace.js";
import {
  mapScopedActionBudgets,
  mapScopedSpendBudgets,
  mapScopedTokenBudgets,
  mapScopedRuntimeBudgets,
  mapScopedProcessBudgets,
  mapPolicyBundles,
  mapCredentialCatalog,
} from "./daemon-policy-mapping.js";
export {
  summarizeLLMFailureForSurface,
} from "./daemon-llm-failure.js";
export {
  clearWebSessionRuntimeState,
  hydrateWebSessionRuntimeState,
  persistSessionStatefulContinuation,
  persistWebSessionRuntimeState,
  resolveSessionStatefulContinuation,
} from "./daemon-session-state.js";
export type { ResolvedTraceLoggingConfig } from "./daemon-trace.js";
export type { LLMFailureSurfaceSummary } from "./daemon-llm-failure.js";
export {
  resolveSessionTokenBudget,
  buildPromptBudgetConfig,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_FALLBACK_MODEL,
} from "./llm-provider-manager.js";

// ============================================================================
// Constants
// ============================================================================

// DEFAULT_GROK_MODEL imported from ./llm-provider-manager.js (DEFAULT_GROK_FALLBACK_MODEL moved to system-prompt-builder.ts)
const DEFAULT_DOOM_FIT_RESOLUTION = "RES_1024X768";
// STATIC_SUBAGENT_DESKTOP_TOOLS moved to ./subagent-infrastructure.ts

function chooseDoomResolutionForDisplay(width: number, height: number): string {
  if (width >= 1280 && height >= 720) return "RES_1280X720";
  if (width >= 1024 && height >= 768) return "RES_1024X768";
  if (width >= 800 && height >= 600) return "RES_800X600";
  return "RES_640X480";
}

function buildDoomAutoplayBackgroundContract(): BackgroundRunContract {
  return {
    domain: "generic",
    kind: "until_stopped",
    successCriteria: [
      "The active ViZDoom session is verified and continues making progress under supervision.",
    ],
    completionCriteria: [
      "The user explicitly stops Doom or cancels the background supervision run.",
    ],
    blockedCriteria: [
      "Doom MCP tools cannot verify or control the session after bounded retries.",
      "The session needs user input that cannot be inferred safely.",
    ],
    nextCheckMs: 8_000,
    heartbeatMs: 15_000,
    requiresUserStop: true,
    managedProcessPolicy: { mode: "none" },
  };
}

function extractDoomRecoveryObjective(
  toolCalls: readonly ToolCallRecord[],
): Record<string, unknown> {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (
      !toolCall ||
      toolCall.name !== "mcp.doom.set_objective" ||
      toolCall.isError
    ) {
      continue;
    }
    const objectiveType = toolCall.args.objective_type;
    if (typeof objectiveType !== "string" || objectiveType.trim().length === 0) {
      continue;
    }

    const recoveryObjective: Record<string, unknown> = {
      objective_type: objectiveType,
    };
    if (
      toolCall.args.params &&
      typeof toolCall.args.params === "object" &&
      !Array.isArray(toolCall.args.params)
    ) {
      recoveryObjective.params = toolCall.args.params;
    }
    if (typeof toolCall.args.priority === "number") {
      recoveryObjective.priority = toolCall.args.priority;
    }
    return recoveryObjective;
  }

  return {
    objective_type: "explore",
    priority: 1,
  };
}

function buildDoomAutoplaySupervisionObjective(params: {
  readonly toolCalls: readonly ToolCallRecord[];
}): string {
  const successfulStart = params.toolCalls.find(
    (toolCall) => toolCall.name === "mcp.doom.start_game" && !toolCall.isError,
  );
  const startPayload = successfulStart
    ? parseToolResultObject(successfulStart.result)
    : undefined;
  const evidence = summarizeDoomToolEvidence(params.toolCalls);
  const recoveryObjective = extractDoomRecoveryObjective(params.toolCalls);
  const contextLines: string[] = [];

  if (typeof startPayload?.scenario === "string") {
    contextLines.push("A scenario-based session is already configured.");
  }
  if (typeof startPayload?.wad === "string") {
    contextLines.push("A campaign session is already configured.");
  }
  if (evidence.confirmedGodMode) {
    contextLines.push("Requested invulnerability is already active.");
  }
  if (evidence.confirmedHoldPosition) {
    contextLines.push(
      "The current session already has a user-requested movement constraint; preserve it unless the user changes the task.",
    );
  } else if (evidence.confirmedActiveObjective) {
    contextLines.push(
      "A non-idle gameplay objective is already configured; keep it unless verification shows it is no longer progressing.",
    );
  }

  return [
    "Supervise the existing ViZDoom session for this user.",
    ...contextLines,
    `Recovery objective JSON: ${JSON.stringify(recoveryObjective)}`,
    "Use Doom MCP tools for verification and steering instead of shell or desktop process inspection.",
    "If verification shows no live episode, recover with Doom MCP tools instead of narrating.",
    "If the executor becomes idle or stalls, restore forward progress with an active objective such as `explore`, or use tactical Doom tools directly.",
    "If the episode ends or the player dies, use `mcp.doom.new_episode` and continue supervision.",
    "Keep the session visibly active until the user explicitly stops it.",
  ].join("\n");
}

/** Minimum confidence score for injecting learned patterns into conversations. */

// DEFAULT_CHANNEL_SESSION_CONFIG moved to ./channel-wiring.ts

// SUBAGENT_CONFIG_HARD_CAPS moved to ./subagent-infrastructure.ts

/** Hook priority constants — lower numbers run first. */
const HOOK_PRIORITIES = {
  POLICY_GATE: 3,
  APPROVAL_GATE: 5,
  PROGRESS_TRACKER: 95,
  BACKGROUND_RUN_WAKE: 96,
} as const;

/** Cron schedule expressions for autonomous features. */

// DEFAULT_SESSION_TOKEN_BUDGET moved to ./llm-provider-manager.js
const MODEL_QUERY_RE =
  /\b(what|which|actual|current)\b[\s\S]{0,80}(model|llm|provider)\b/i;
// EVAL_SCRIPT_NAME and EVAL_SCRIPT_TIMEOUT_MS moved to ./daemon-command-registry.ts
// DelegationAggressivenessProfile, SubagentChildProviderStrategy,
// DelegationHardBlockedTaskClass, DELEGATION_AGGRESSIVENESS_THRESHOLD_OFFSETS,
// DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE, DEFAULT_HARD_BLOCKED_TASK_CLASSES
// moved to ./subagent-infrastructure.ts
const BASH_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "SOLANA_RPC_URL",
] as const;
const BASH_DESKTOP_ENV_KEYS = [
  "DOCKER_HOST",
  "CARGO_HOME",
  "GOPATH",
  "DISPLAY",
] as const;
const MAC_DESKTOP_BASH_DENY_EXCLUSIONS = [
  "killall",
  "pkill",
  "curl",
  "wget",
] as const;
const LINUX_DESKTOP_BASH_DENY_EXCLUSIONS = [
  "killall",
  "pkill",
  "gdb",
  "curl",
  "wget",
  "node",
  "nodejs",
] as const;
const STRUCTURED_EXEC_RUNTIME_DENY_EXCLUSIONS = [
  "python",
  "python3",
  "node",
  "nodejs",
] as const;
const CHROMIUM_COMPAT_COMMANDS = ["chromium", "chromium-browser"] as const;
const CHROMIUM_HOST_CHROME_CANDIDATES = [
  "google-chrome",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
] as const;
const CHROMIUM_SHIM_DIR_SEGMENTS = [".agenc", "bin"] as const;
const HOST_RUNTIME_SHIM_COMMAND = "agenc-runtime" as const;
const RUNTIME_USER_SKILLS_ENV = "AGENC_ENABLE_USER_SKILLS" as const;
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const CURRENT_MODULE_FILE_PATH =
  typeof __filename === "string"
    ? __filename
    : process.argv[1]
      ? resolvePath(process.argv[1])
      : resolvePath(process.cwd(), "runtime", "dist", "bin", "daemon.js");

/**
 * Build a minimal environment for system.bash.
 * Never forwards token-like host secrets by default.
 */
export function resolveBashToolEnv(
  config: Pick<GatewayConfig, "desktop">,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const envKeys = config.desktop?.enabled
    ? [...BASH_SAFE_ENV_KEYS, ...BASH_DESKTOP_ENV_KEYS]
    : BASH_SAFE_ENV_KEYS;

  const safeEnv: Record<string, string> = {};
  for (const key of envKeys) {
    const value = hostEnv[key];
    if (value !== undefined) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

export function isRuntimeUserSkillDiscoveryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RUNTIME_USER_SKILLS_ENV];
  return typeof raw === "string" && TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}

export function resolveRuntimeSkillDiscoveryPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  currentFilePath: string = CURRENT_MODULE_FILE_PATH,
): Pick<DiscoveryPaths, "builtinSkills" | "userSkills"> {
  const pkgRoot = resolvePath(dirname(currentFilePath), "..", "..");
  return {
    builtinSkills: join(pkgRoot, "src", "skills", "bundled"),
    ...(isRuntimeUserSkillDiscoveryEnabled(env)
      ? { userSkills: join(homeDir, ".agenc", "skills") }
      : {}),
  };
}

/**
 * Resolve deny-list exclusions for system.bash by platform.
 * Linux desktop mode allows a narrow set of developer workflow binaries.
 */
export function resolveBashDenyExclusions(
  config: Pick<GatewayConfig, "desktop">,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform === "darwin") {
    return [...MAC_DESKTOP_BASH_DENY_EXCLUSIONS];
  }
  if (config.desktop?.enabled && platform === "linux") {
    return [...LINUX_DESKTOP_BASH_DENY_EXCLUSIONS];
  }
  return undefined;
}

export function resolveStructuredExecDenyExclusions(
  config: Pick<GatewayConfig, "desktop">,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const baseExclusions = resolveBashDenyExclusions(config, platform) ?? [];
  if (platform !== "darwin" && !(config.desktop?.enabled && platform === "linux")) {
    return baseExclusions.length > 0 ? [...baseExclusions] : undefined;
  }
  return [...new Set([...baseExclusions, ...STRUCTURED_EXEC_RUNTIME_DENY_EXCLUSIONS])];
}

export function resolveBashToolTimeoutConfig(
  config: Pick<GatewayConfig, "desktop" | "llm">,
): {
  timeoutMs: number;
  maxTimeoutMs: number;
} {
  const chatToolTimeoutMs = Math.max(
    1,
    Math.floor(config.llm?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS),
  );
  const baseTimeoutMs = config.desktop?.enabled
    ? 300_000
    : DEFAULT_BASH_TOOL_TIMEOUT_MS;
  const baseMaxTimeoutMs = config.desktop?.enabled
    ? 600_000
    : baseTimeoutMs;

  return {
    timeoutMs: Math.min(baseTimeoutMs, chatToolTimeoutMs),
    maxTimeoutMs: Math.min(baseMaxTimeoutMs, chatToolTimeoutMs),
  };
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function isExecutablePath(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutablePath(
  command: string,
  envPath: string | undefined,
): Promise<string | undefined> {
  if (command.includes("/")) {
    return (await isExecutablePath(command)) ? command : undefined;
  }

  const searchDirs = splitPathEntries(envPath);
  for (const dir of searchDirs) {
    const candidate = join(dir, command);
    if (await isExecutablePath(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// prependPathEntry moved to ./daemon-tool-registry.ts

function buildChromiumShimScript(targetExecutable: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec ${JSON.stringify(targetExecutable)} "$@"`,
    "",
  ].join("\n");
}

function buildRuntimeShimScript(targetExecutable: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec ${JSON.stringify(targetExecutable)} "$@"`,
    "",
  ].join("\n");
}

function resolveAgencRuntimeBinaryCandidates(
  currentWorkingDirectory: string = process.cwd(),
  currentFilePath: string = CURRENT_MODULE_FILE_PATH,
): string[] {
  const packageRoot = resolvePath(dirname(currentFilePath), "..", "..");
  return [
    resolvePath(packageRoot, "dist", "bin", "agenc-runtime.js"),
    resolvePath(
      currentWorkingDirectory,
      "runtime",
      "dist",
      "bin",
      "agenc-runtime.js",
    ),
    resolvePath(currentWorkingDirectory, "dist", "bin", "agenc-runtime.js"),
  ];
}

/**
 * Ensure host-level Chromium compatibility commands exist for system.bash checks.
 *
 * Some Linux hosts only install Google Chrome. When desktop mode is enabled we
 * provide user-scoped shim binaries (`chromium`, `chromium-browser`) that
 * forward to Chrome, then prepend that shim directory to system.bash PATH.
 */
export async function ensureChromiumCompatShims(
  config: Pick<GatewayConfig, "desktop">,
  envPath: string | undefined,
  logger: Logger | undefined = silentLogger,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): Promise<string | undefined> {
  if (!config.desktop?.enabled || platform !== "linux") {
    return undefined;
  }

  const existingChromium = await resolveExecutablePath("chromium", envPath);
  const existingChromiumBrowser = await resolveExecutablePath(
    "chromium-browser",
    envPath,
  );
  if (existingChromium && existingChromiumBrowser) {
    return undefined;
  }

  let chromeTarget: string | undefined;
  for (const candidate of CHROMIUM_HOST_CHROME_CANDIDATES) {
    chromeTarget = await resolveExecutablePath(candidate, envPath);
    if (chromeTarget) break;
  }
  if (!chromeTarget) {
    return undefined;
  }

  const shimDir = join(homeDir, ...CHROMIUM_SHIM_DIR_SEGMENTS);
  await mkdir(shimDir, { recursive: true });

  const createdShims: string[] = [];
  for (const name of CHROMIUM_COMPAT_COMMANDS) {
    const existing =
      name === "chromium" ? existingChromium : existingChromiumBrowser;
    if (existing) continue;

    const shimPath = join(shimDir, name);
    await writeFile(shimPath, buildChromiumShimScript(chromeTarget), "utf-8");
    await chmod(shimPath, 0o755);
    createdShims.push(name);
  }

  if (createdShims.length > 0) {
    (logger ?? silentLogger).info(
      `Installed host Chromium compatibility shim(s): ${createdShims.join(", ")} -> ${chromeTarget}`,
    );
  }

  return shimDir;
}

/**
 * Ensure `agenc-runtime` is resolvable on PATH for system.bash host checks.
 *
 * Recovery and orchestration flows may invoke `agenc-runtime status --output json`
 * directly after a denied `node .../agenc-runtime.js` attempt. Provide a
 * deterministic user-scoped shim that points at the runtime CLI bundle.
 */
export async function ensureAgencRuntimeShim(
  config: Pick<GatewayConfig, "desktop">,
  envPath: string | undefined,
  logger: Logger | undefined = silentLogger,
  homeDir: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
  currentFilePath: string = CURRENT_MODULE_FILE_PATH,
): Promise<string | undefined> {
  if (!config.desktop?.enabled) {
    return undefined;
  }

  const existingRuntimeCommand = await resolveExecutablePath(
    HOST_RUNTIME_SHIM_COMMAND,
    envPath,
  );
  if (existingRuntimeCommand) {
    return undefined;
  }

  let runtimeTarget: string | undefined;
  for (const candidate of resolveAgencRuntimeBinaryCandidates(
    currentWorkingDirectory,
    currentFilePath,
  )) {
    runtimeTarget = await resolveExecutablePath(candidate, envPath);
    if (runtimeTarget) break;
  }

  if (!runtimeTarget) {
    return undefined;
  }

  const shimDir = join(homeDir, ...CHROMIUM_SHIM_DIR_SEGMENTS);
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, HOST_RUNTIME_SHIM_COMMAND);
  await writeFile(shimPath, buildRuntimeShimScript(runtimeTarget), "utf-8");
  await chmod(shimPath, 0o755);

  (logger ?? silentLogger).info(
    `Installed host runtime shim: ${HOST_RUNTIME_SHIM_COMMAND} -> ${runtimeTarget}`,
  );
  return shimDir;
}

// ResolvedSubAgentRuntimeConfig, applyDelegationAggressiveness,
// resolveSubAgentRuntimeConfig, requiresSubAgentInfrastructureRecreate,
// createDelegatingSubAgentLLMProvider
// moved to ./subagent-infrastructure.ts

// LLMProviderConfigCatalogEntry imported from ./llm-provider-manager.js

// resolveSessionTokenBudget moved to ./llm-provider-manager.js

// buildPromptBudgetConfig moved to ./llm-provider-manager.js

export function isCommandUnavailableError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return true;
  }

  const message = toErrorMessage(error).toLowerCase();
  return message.includes("enoent") || message.includes("command not found");
}

// EvalScriptResult, didEvalScriptPass, formatEvalScriptReply,
// resolveEvalScriptPathCandidates, runEvalScript
// moved to ./daemon-command-registry.ts
export const didEvalScriptPass = didEvalScriptPassImported;
export const formatEvalScriptReply = formatEvalScriptReplyImported;
export type { EvalScriptResult };

/**
 * Default max tool rounds for ChatExecutor based on config.
 *
 * Desktop-enabled sessions get 50 rounds because multi-step desktop automation
 * (open app → type → screenshot → verify → retry) legitimately chains many calls.
 * Text-only chat gets 3 rounds to keep simple responses snappy. Foreground
 * coding and durable-execution turns can raise their per-turn cap above this
 * default via resolveTurnMaxToolRounds().
 * Voice delegation uses a separate cap (MAX_DELEGATION_TOOL_ROUNDS = 15) set
 * per-call in voice-bridge.ts.
 */
function getDefaultMaxToolRounds(config: GatewayConfig): number {
  return config.desktop?.enabled ? 50 : 3;
}

/** Result of loadWallet() — either a keypair + wallet adapter or null. */

// WebChatSkillSummary moved to ./daemon-command-registry.ts

interface WebChatSignals {
  signalThinking: (sessionId: string) => void;
  signalIdle: (sessionId: string) => void;
}

interface WebChatMessageHandlerDeps {
  webChat: WebChatChannel;
  commandRegistry: SlashCommandRegistry;
  getChatExecutor: () => ChatExecutor | null;
  getLoggingConfig: () => GatewayLoggingConfig | undefined;
  hooks: HookDispatcher;
  sessionMgr: SessionManager;
  getSystemPrompt: () => string;
  baseToolHandler: ToolHandler;
  approvalEngine: ApprovalEngine | null;
  memoryBackend: MemoryBackend;
  signals: WebChatSignals;
  sessionTokenBudget: number;
  contextWindowTokens?: number;
}

// ============================================================================
// PID File Types
// ============================================================================

export interface PidFileInfo {
  pid: number;
  port: number;
  configPath: string;
}

export interface StalePidResult {
  status: "none" | "alive" | "stale";
  pid?: number;
  port?: number;
}

// ============================================================================
// PID File Operations
// ============================================================================

export function getDefaultPidPath(): string {
  return process.env.AGENC_PID_PATH ?? join(homedir(), ".agenc", "daemon.pid");
}

export async function writePidFile(
  info: PidFileInfo,
  pidPath: string,
): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, JSON.stringify(info), { mode: 0o600 });
}

export async function readPidFile(
  pidPath: string,
): Promise<PidFileInfo | null> {
  try {
    const raw = await readFile(pidPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "port" in parsed &&
      "configPath" in parsed &&
      typeof (parsed as PidFileInfo).pid === "number" &&
      typeof (parsed as PidFileInfo).port === "number" &&
      typeof (parsed as PidFileInfo).configPath === "string"
    ) {
      return parsed as PidFileInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removePidFile(pidPath: string): Promise<void> {
  try {
    await unlink(pidPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function pidFileExists(pidPath: string): Promise<boolean> {
  try {
    await access(pidPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Process Detection
// ============================================================================

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function checkStalePid(pidPath: string): Promise<StalePidResult> {
  const info = await readPidFile(pidPath);
  if (info === null) {
    return { status: "none" };
  }
  if (isProcessAlive(info.pid)) {
    return { status: "alive", pid: info.pid, port: info.port };
  }
  return { status: "stale", pid: info.pid, port: info.port };
}

// ============================================================================
// DaemonManager
// ============================================================================

export interface DaemonManagerConfig {
  configPath: string;
  pidPath?: string;
  logger?: Logger;
  yolo?: boolean;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptimeMs: number;
  gatewayStatus: GatewayStatus | null;
  memoryUsage: { heapUsedMB: number; rssMB: number };
}

export class DaemonManager {
  private gateway: Gateway | null = null;
  private _webChatChannel: WebChatChannel | null = null;
  private _webChatInboundHandler:
    | ((msg: GatewayMessage) => Promise<void>)
    | null = null;
  private readonly _externalChannels: ExternalChannelRegistry = new Map();
  private _proactiveCommunicator: ProactiveCommunicator | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _heartbeatScheduler:
    | import("./heartbeat.js").HeartbeatScheduler
    | null = null;
  private _cronScheduler: import("./scheduler.js").CronScheduler | null = null;
  private _mcpManager: import("../mcp-client/manager.js").MCPManager | null =
    null;
  private _voiceBridge: VoiceBridge | null = null;
  private _memoryBackend: MemoryBackend | null = null;
  private _observabilityService: ObservabilityService | null = null;
  private _approvalEngine: ApprovalEngine | null = null;
  private _governanceAuditLog:
    | import("../policy/governance-audit-log.js").GovernanceAuditLog
    | null = null;
  private _sessionCredentialBroker: SessionCredentialBroker | null = null;
  private _webSessionManager: SessionManager | null = null;
  private _telemetry: UnifiedTelemetryCollector | null = null;
  private _hookDispatcher: HookDispatcher | null = null;
  private _connectionManager: ConnectionManager | null = null;
  private _chatExecutor: ChatExecutor | null = null;
  private _sessionIsolationManager: SessionIsolationManager | null = null;
  private _subAgentManager: SubAgentManager | null = null;
  private readonly _subAgentToolCatalog: Tool[] = [];
  private _subAgentRuntimeConfig: ResolvedSubAgentRuntimeConfig | null = null;
  private _delegationAggressivenessOverride: DelegationAggressivenessProfile | null =
    null;
  private _delegationPolicyEngine: DelegationPolicyEngine | null = null;
  private _delegationVerifierService: DelegationVerifierService | null = null;
  private _subAgentLifecycleEmitter: SubAgentLifecycleEmitter | null = null;
  private _delegationTrajectorySink: InMemoryDelegationTrajectorySink | null =
    null;
  private _delegationBanditTuner: DelegationBanditPolicyTuner | null = null;
  private _subAgentLifecycleUnsubscribe: (() => void) | null = null;
  private readonly _activeSessionTraceIds = new Map<string, string>();
  private readonly _subagentActivityTraceBySession = new Map<string, string>();
  private readonly _latestDelegationSurfaceContextBySession = new Map<
    string,
    {
      objective?: string;
      stepName?: string;
      subagentSessionId?: string;
      toolName?: string;
    }
  >();
  private readonly _textApprovalDispatchBySession = new Map<
    string,
    {
      channelName: string;
      send: (content: string) => Promise<void>;
    }
  >();
  private _resolvedContextWindowTokens: number | undefined;
  private _hostToolingProfile: HostToolingProfile | null = null;
  private _hostWorkspacePath: string | null = null;
  private _hostWorkspacePathPinned = false;
  private _allLlmTools: LLMTool[] = [];
  private _llmTools: LLMTool[] = [];
  private _llmProviders: LLMProvider[] = [];
  private _llmProviderConfigByInstance = new WeakMap<
    LLMProvider,
    GatewayLLMConfig
  >();
  private _llmProviderConfigCatalog: LLMProviderConfigCatalogEntry[] = [];
  private _primaryLlmConfig: GatewayLLMConfig | undefined = undefined;
  private _toolRouter: ToolRouter | null = null;
  private _baseToolHandler: ToolHandler | null = null;
  private _defaultForegroundMaxToolRounds = 10;
  private _desktopManager:
    | import("../desktop/manager.js").DesktopSandboxManager
    | null = null;
  private _desktopWatchdog:
    | import("../desktop/health.js").DesktopSandboxWatchdog
    | null = null;
  private _desktopBridges: Map<
    string,
    import("../desktop/rest-bridge.js").DesktopRESTBridge
  > = new Map();
  private _playwrightBridges: Map<
    string,
    import("../mcp-client/types.js").MCPToolBridge
  > = new Map();
  private _containerMCPConfigs: GatewayMCPServerConfig[] = [];
  private _containerMCPBridges: Map<
    string,
    import("../mcp-client/types.js").MCPToolBridge[]
  > = new Map();
  private _desktopRouterFactory: DesktopRouterFactory | null = null;
  private _desktopExecutor:
    | import("../autonomous/desktop-executor.js").DesktopExecutor
    | null = null;
  private _backgroundRunSupervisor: BackgroundRunSupervisor | null = null;
  private _durableSubrunOrchestrator: DurableSubrunOrchestrator | null = null;
  private _remoteJobManager: SystemRemoteJobManager | null = null;
  private _sessionModelInfo = new Map<
    string,
    {
      provider: string;
      model: string;
      usedFallback: boolean;
      updatedAt: number;
    }
  >();
  private _goalManager:
    | import("../autonomous/goal-manager.js").GoalManager
    | null = null;
  private readonly _foregroundSessionLocks = new Set<string>();
  private _policyEngine: import("../policy/engine.js").PolicyEngine | null =
    null;
  private _marketplace:
    | import("../marketplace/service-marketplace.js").ServiceMarketplace
    | null = null;
  private _agentDiscovery:
    | import("../social/discovery.js").AgentDiscovery
    | null = null;
  private _agentMessaging:
    | import("../social/messaging.js").AgentMessaging
    | null = null;
  private _agentMessagingUnsubscribe: (() => void) | null = null;
  private _agentFeed: import("../social/feed.js").AgentFeed | null = null;
  private _reputationScorer:
    | import("../social/reputation.js").ReputationScorer
    | null = null;
  private _collaborationProtocol:
    | import("../social/collaboration.js").CollaborationProtocol
    | null = null;
  private _systemPrompt = "";
  private _voiceSystemPrompt = "";
  private shutdownInProgress = false;
  private startedAt = 0;
  private signalHandlersRegistered = false;
  private signalHandlerRefs: { signal: string; handler: () => void }[] = [];
  private readonly configPath: string;
  private readonly pidPath: string;
  private readonly logger: Logger;
  private readonly yolo: boolean;
  private readonly resolveDelegationToolContext: DelegationToolCompositionResolver =
    (): DelegationToolCompositionContext | undefined => {
      if (
        !this._delegationPolicyEngine &&
        !this._delegationVerifierService &&
        !this._subAgentLifecycleEmitter &&
        !this._subAgentManager
      ) {
        return undefined;
      }
      const unsafeBenchmarkMode =
        this._subAgentRuntimeConfig?.unsafeBenchmarkMode === true;
      return {
        subAgentManager: this._subAgentManager,
        policyEngine: this._delegationPolicyEngine,
        verifier: this._delegationVerifierService,
        lifecycleEmitter: this._subAgentLifecycleEmitter,
        unsafeBenchmarkMode,
      };
    };

  constructor(config: DaemonManagerConfig) {
    this.configPath = config.configPath;
    this.pidPath = config.pidPath ?? getDefaultPidPath();
    this.logger = config.logger ?? silentLogger;
    this.yolo = config.yolo ?? false;
  }

  private initializeObservabilityService(logging?: GatewayLoggingConfig): void {
    if (this._observabilityService) {
      setDefaultObservabilityService(this._observabilityService);
      return;
    }
    this._observabilityService = new ObservabilityService({
      logger: this.logger,
      traceFanoutEnabled: resolveTraceFanoutEnabled(logging),
    });
    setDefaultObservabilityService(this._observabilityService);
  }

  private async disposeObservabilityService(): Promise<void> {
    setDefaultObservabilityService(null);
    if (!this._observabilityService) {
      return;
    }
    await this._observabilityService.close();
    this._observabilityService = null;
  }

  private getActiveDelegationAggressiveness(
    resolved?: ResolvedSubAgentRuntimeConfig | null,
  ): DelegationAggressivenessProfile {
    return getActiveDelegationAggressivenessImpl(
      this._subAgentRuntimeConfig,
      this._delegationAggressivenessOverride,
      resolved,
    );
  }

  private resolveDelegationScoreThreshold(
    resolved?: ResolvedSubAgentRuntimeConfig | null,
  ): number {
    return resolveDelegationScoreThresholdImpl(
      this._subAgentRuntimeConfig,
      this._delegationAggressivenessOverride,
      resolved,
    );
  }

  private selectSubagentProviderForTask(
    requiredCapabilities: readonly string[] | undefined,
    fallbackProvider: LLMProvider,
  ): LLMProvider {
    return selectSubagentProviderForTaskImpl(
      requiredCapabilities,
      fallbackProvider,
      this._subAgentRuntimeConfig,
      this._llmProviders,
    );
  }

  private refreshSubAgentToolCatalog(
    registry: ToolRegistry,
    environment: ToolEnvironmentMode,
    options: {
      readonly includeStaticDesktopTools?: boolean;
    } = {},
  ): void {
    refreshSubAgentToolCatalogImpl(
      this._subAgentToolCatalog,
      registry,
      environment,
      options,
    );
  }

  private async ensureSubAgentDefaultWorkspace(
    workspaceManager: WorkspaceManager,
  ): Promise<void> {
    await ensureSubAgentDefaultWorkspaceImpl(workspaceManager, this.logger);
  }

  private configureDelegationRuntimeServices(
    resolved: ResolvedSubAgentRuntimeConfig,
  ): void {
    const result = configureDelegationRuntimeServicesImpl(
      resolved,
      {
        delegationPolicyEngine: this._delegationPolicyEngine,
        delegationVerifierService: this._delegationVerifierService,
        subAgentLifecycleEmitter: this._subAgentLifecycleEmitter,
        delegationTrajectorySink: this._delegationTrajectorySink,
        delegationBanditTuner: this._delegationBanditTuner,
      },
      {
        subAgentRuntimeConfig: this._subAgentRuntimeConfig,
        delegationAggressivenessOverride: this._delegationAggressivenessOverride,
        attachLifecycleBridge: () => {
          if (this._webChatChannel) {
            this.attachSubAgentLifecycleBridge(this._webChatChannel);
          }
        },
      },
    );
    this._delegationPolicyEngine = result.delegationPolicyEngine;
    this._delegationVerifierService = result.delegationVerifierService;
    this._subAgentLifecycleEmitter = result.subAgentLifecycleEmitter;
    this._delegationTrajectorySink = result.delegationTrajectorySink;
    this._delegationBanditTuner = result.delegationBanditTuner;
  }

  private clearDelegationRuntimeServices(): void {
    const result = clearDelegationRuntimeServicesImpl(
      () => this.detachSubAgentLifecycleBridge(),
      this._subAgentLifecycleEmitter,
    );
    this._delegationPolicyEngine = result.delegationPolicyEngine;
    this._delegationVerifierService = result.delegationVerifierService;
    this._delegationBanditTuner = result.delegationBanditTuner;
    this._delegationTrajectorySink = result.delegationTrajectorySink;
    this._subAgentLifecycleEmitter = result.subAgentLifecycleEmitter;
  }

  private async destroySubAgentInfrastructure(): Promise<void> {
    const subAgentManager = this._subAgentManager;
    this._subAgentManager = null;
    const isolationManager = this._sessionIsolationManager;
    this._sessionIsolationManager = null;
    await destroySubAgentInfrastructureImpl(
      subAgentManager,
      isolationManager,
      this.logger,
    );
  }

  private async configureSubAgentInfrastructure(
    config: GatewayConfig,
  ): Promise<void> {
    const previous = this._subAgentRuntimeConfig;
    const resolved = resolveSubAgentRuntimeConfig(config.llm, {
      unsafeBenchmarkMode: this.yolo,
    });
    this._subAgentRuntimeConfig = resolved;
    this.configureDelegationRuntimeServices(resolved);
    const effectiveDelegationThreshold =
      this.resolveDelegationScoreThreshold(resolved);

    this.logger.info("Sub-agent orchestration config", {
      ...resolved,
      effectiveDelegationThreshold,
      activeDelegationAggressiveness:
        this.getActiveDelegationAggressiveness(resolved),
      hardCaps: SUBAGENT_CONFIG_HARD_CAPS,
    });
    if (resolved.unsafeBenchmarkMode) {
      this.logger.warn(
        "Unsafe delegation benchmark mode enabled via --yolo; delegation policy checks and child contract enforcement are bypassed for delegated-agent flows",
      );
    }

    if (!resolved.enabled) {
      await this.destroySubAgentInfrastructure();
      return;
    }

    const shouldRecreate = requiresSubAgentInfrastructureRecreate(
      previous,
      resolved,
      this._subAgentManager,
      this._sessionIsolationManager,
    );
    if (!shouldRecreate) {
      this.logger.info("Sub-agent orchestration thresholds updated in place", {
        spawnDecisionThreshold: effectiveDelegationThreshold,
        forceVerifier: resolved.forceVerifier,
        maxDepth: resolved.maxDepth,
        maxFanoutPerTurn: resolved.maxFanoutPerTurn,
        maxTotalSubagentsPerRequest: resolved.maxTotalSubagentsPerRequest,
        maxCumulativeToolCallsPerRequestTree:
          resolved.maxCumulativeToolCallsPerRequestTree,
        maxCumulativeTokensPerRequestTree:
          resolved.maxCumulativeTokensPerRequestTree,
        delegationAggressiveness:
          this.getActiveDelegationAggressiveness(resolved),
        fallbackBehavior: resolved.fallbackBehavior,
      });
      return;
    }

    await this.destroySubAgentInfrastructure();

    const workspaceManager = new WorkspaceManager(getDefaultWorkspacePath());
    await this.ensureSubAgentDefaultWorkspace(workspaceManager);
    const traceConfig = resolveTraceLoggingConfig(config.logging);
    const contextWindowTokens = await this.resolveLlmContextWindowTokens(
      config.llm,
    );
    const subAgentSessionTokenBudget = resolveSessionTokenBudget(
      config.llm,
      contextWindowTokens,
    );
    const subAgentPromptBudget = buildPromptBudgetConfig(
      config.llm,
      contextWindowTokens,
    );
    const isolationManager = new SessionIsolationManager({
      workspaceManager,
      defaultLLMProvider: createDelegatingSubAgentLLMProvider(
        () => this._llmProviders[0],
      ),
      defaultTools: this._subAgentToolCatalog,
      logger: this.logger,
    });
    this._sessionIsolationManager = isolationManager;

    this._subAgentManager = new SubAgentManager({
      createContext: async (sessionIdentity: SubAgentSessionIdentity) => {
        const manager = this._sessionIsolationManager;
        if (!manager) {
          throw new Error("Session isolation manager is not initialized");
        }
        return manager.getContext(sessionIdentity);
      },
      destroyContext: async (sessionIdentity: SubAgentSessionIdentity) => {
        const manager = this._sessionIsolationManager;
        if (manager) {
          await manager.destroyContext(sessionIdentity);
        }
        await cleanupDesktopSession(
          sessionIdentity.subagentSessionId,
          {
            desktopManager: this._desktopManager,
            desktopBridges: this._desktopBridges,
            playwrightBridges: this._playwrightBridges,
            containerMCPBridges: this._containerMCPBridges,
            logger: this.logger,
          },
        );
      },
      defaultWorkspaceId: workspaceManager.getDefault(),
      contextStartupTimeoutMs: config.desktop?.enabled ? 60_000 : undefined,
      maxConcurrent: resolved.maxConcurrent,
      maxDepth: resolved.maxDepth,
      promptBudget: subAgentPromptBudget,
      sessionTokenBudget: subAgentSessionTokenBudget,
      onCompaction: this.handleCompaction,
      resolveExecutionBudget: async ({ selectedProvider }) =>
        this.resolveProviderExecutionBudget(selectedProvider),
      resolveDefaultMaxToolRounds: () => this._defaultForegroundMaxToolRounds,
      selectLLMProvider: ({ requiredCapabilities, contextProvider }) =>
        this.selectSubagentProviderForTask(
          requiredCapabilities,
          contextProvider,
        ),
      traceExecution: traceConfig.enabled,
      traceProviderPayloads:
        traceConfig.enabled && traceConfig.includeProviderPayloads,
      composeToolHandler: ({
        sessionIdentity,
        baseToolHandler,
        allowedToolNames,
        workingDirectory,
        desktopRoutingSessionId,
      }) =>
        createSessionToolHandler({
          sessionId: sessionIdentity.subagentSessionId,
          baseHandler: baseToolHandler,
          availableToolNames: allowedToolNames,
          defaultWorkingDirectory: workingDirectory,
          workspaceAliasRoot: this._hostWorkspacePath ?? undefined,
          scopedFilesystemRoot: workingDirectory,
          desktopRouterFactory: this._desktopRouterFactory ?? undefined,
          routerId: desktopRoutingSessionId,
          send: (response) => {
            this.routeSubagentControlResponseToParent({
              response,
              parentSessionId: sessionIdentity.parentSessionId,
              subagentSessionId: sessionIdentity.subagentSessionId,
            });
          },
          hooks: this._hookDispatcher ?? undefined,
          approvalEngine: this._approvalEngine ?? undefined,
          delegation: this.resolveDelegationToolContext,
          credentialBroker: this._sessionCredentialBroker ?? undefined,
          resolvePolicyScope: () =>
            this.resolvePolicyScopeForSession({
              sessionId: sessionIdentity.subagentSessionId,
              runId: sessionIdentity.parentSessionId,
            }),
        }),
      logger: this.logger,
    });

    this.logger.info("Sub-agent orchestration manager ready", {
      mode: resolved.mode,
      unsafeBenchmarkMode: resolved.unsafeBenchmarkMode,
      maxConcurrent: resolved.maxConcurrent,
      maxDepth: resolved.maxDepth,
      maxFanoutPerTurn: resolved.maxFanoutPerTurn,
      maxTotalSubagentsPerRequest: resolved.maxTotalSubagentsPerRequest,
      maxCumulativeToolCallsPerRequestTree:
        resolved.maxCumulativeToolCallsPerRequestTree,
      maxCumulativeTokensPerRequestTree:
        resolved.maxCumulativeTokensPerRequestTree,
      defaultTimeoutMs: resolved.defaultTimeoutMs,
      spawnDecisionThreshold: effectiveDelegationThreshold,
      handoffMinPlannerConfidence: resolved.handoffMinPlannerConfidence,
      delegationAggressiveness:
        this.getActiveDelegationAggressiveness(resolved),
      childProviderStrategy: resolved.childProviderStrategy,
    });
  }

  async start(): Promise<void> {
    if (this.gateway !== null) {
      throw new GatewayStateError("Daemon is already running");
    }

    const loadedConfig = await loadGatewayConfig(this.configPath);

    // Shallow-copy so we don't mutate the loaded config object
    const gatewayConfig = { ...loadedConfig };
    if (gatewayConfig.logging?.level) {
      this.logger.setLevel?.(gatewayConfig.logging.level);
    }
    const hostWorkspacePath = resolveHostWorkspacePath({
      config: gatewayConfig,
      configPath: this.configPath,
      daemonCwd: process.cwd(),
    });
    this._hostWorkspacePath = hostWorkspacePath;
    this._hostWorkspacePathPinned =
      typeof gatewayConfig.workspace?.hostPath === "string" &&
      gatewayConfig.workspace.hostPath.trim().length > 0;

    await this.configureSubAgentInfrastructure(gatewayConfig);

    // Auto-configure default MCP servers on macOS when none are specified
    if (process.platform === "darwin" && !gatewayConfig.mcp?.servers?.length) {
      gatewayConfig.mcp = {
        servers: [
          {
            name: "peekaboo",
            command: "npx",
            args: ["-y", "@steipete/peekaboo@latest"],
            enabled: true,
          },
          {
            name: "macos-automator",
            command: "npx",
            args: ["-y", "@steipete/macos-automator-mcp@latest"],
            enabled: true,
          },
        ],
      };
      this.logger.info(
        "Auto-configured default macOS MCP servers (Peekaboo + macos-automator)",
      );
    }

    const gateway = new Gateway(gatewayConfig, {
      logger: this.logger,
      configPath: this.configPath,
    });
    gateway.setStatusProvider?.((baseStatus) =>
      this.buildGatewayStatusSnapshot(baseStatus),
    );
    gateway.setControlMessageDelegate?.((params) =>
      this.handleGatewayControlMessage(params),
    );

    await gateway.start();
    this.gateway = gateway;
    this.initializeObservabilityService(gatewayConfig.logging);
    const pendingExternalChannels: ExternalChannelRegistry = new Map();

    try {
      // Start desktop sandbox manager before wiring WebChat (commands need it)
      if (gatewayConfig.desktop?.enabled) {
        try {
          const [{ DesktopSandboxManager }, { DesktopSandboxWatchdog }] =
            await Promise.all([
              import("../desktop/manager.js"),
              import("../desktop/health.js"),
            ]);
          this._desktopManager = new DesktopSandboxManager(
            gatewayConfig.desktop,
            {
              logger: this.logger,
              workspacePath: hostWorkspacePath,
              workspaceAccess: "readwrite",
              workspaceMountPath: "/workspace",
              hostUid:
                typeof process.getuid === "function"
                  ? process.getuid()
                  : undefined,
              hostGid:
                typeof process.getgid === "function"
                  ? process.getgid()
                  : undefined,
            },
          );
          await this._desktopManager.start();
          this._desktopWatchdog = new DesktopSandboxWatchdog(
            this._desktopManager,
            {
              intervalMs: gatewayConfig.desktop.healthCheckIntervalMs,
              logger: this.logger,
            },
          );
          this._desktopWatchdog.start();
        } catch (err) {
          this._desktopWatchdog?.stop();
          this._desktopWatchdog = null;
          this.logger.warn?.("Desktop sandbox manager failed to start:", err);
        }
      }

      // Wire up WebChat channel with LLM pipeline
      await this.wireWebChat(gateway, gatewayConfig);

      // Wire up all enabled external channels through the unified registry path
      const channelDeps = this._buildChannelWiringDeps();
      const extChannels = await wireExternalChannelsStandalone(
        gatewayConfig,
        channelDeps,
      );
      for (const [name, channel] of extChannels) {
        pendingExternalChannels.set(name, channel);
      }
      for (const [name, channel] of extChannels) {
        gateway.registerChannel(channel);
        this._externalChannels.set(name, channel);
        pendingExternalChannels.delete(name);
      }

      // Wire up autonomous features (curiosity, self-learning, meta-planner, proactive comms)
      await this.wireAutonomousFeatures(gatewayConfig);

      // Wire up subsystems (marketplace, social module)
      await this.wireMarketplace(gatewayConfig);
      await this.wireSocial(gatewayConfig);

      try {
        await writePidFile(
          {
            pid: process.pid,
            port: gatewayConfig.gateway.port,
            configPath: this.configPath,
          },
          this.pidPath,
        );
      } catch (error) {
        throw new GatewayLifecycleError(
          `Failed to write PID file: ${toErrorMessage(error)}`,
        );
      }

      this.startedAt = Date.now();
      this.setupSignalHandlers();

      this.logger.info("Daemon started", {
        pid: process.pid,
        port: gatewayConfig.gateway.port,
      });
    } catch (error) {
      this._externalChannels.clear();
      try {
        await this.stop();
      } catch (stopError) {
        this.logger.error("Daemon startup rollback failed:", stopError);
      }
      if (error instanceof GatewayLifecycleError) {
        throw error;
      }
      throw new GatewayLifecycleError(`Failed to start daemon: ${toErrorMessage(error)}`);
    }
  }

  /**
   * Wire the WebChat channel plugin to the Gateway's WebSocket control plane
   * and connect it to an LLM provider with tool execution, skill injection,
   * session management, workspace-driven system prompt, slash commands,
   * memory retrieval, lifecycle hooks, and real-time tool/typing events.
   */
  private async wireWebChat(
    gateway: Gateway,
    config: GatewayConfig,
  ): Promise<void> {
    const hooks = await this.createHookDispatcher(config);
    const { availableSkills, skillList, skillToggle } =
      await this.buildWebChatSkillState();
    const telemetry = this.createWebChatTelemetry(config);

    const registry = await this.createToolRegistry(
      config,
      telemetry ?? undefined,
    );
    const environment = config.desktop?.environment ?? "both";

    const llmTools = registry.toLLMTools();
    let baseToolHandler = registry.createToolHandler();

    if (config.desktop?.enabled && this._desktopManager) {
      const factory = await configureDesktopRouting(
        config,
        llmTools,
        baseToolHandler,
        {
          desktopManager: this._desktopManager,
          desktopBridges: this._desktopBridges,
          playwrightBridges: this._playwrightBridges,
          containerMCPConfigs: this._containerMCPConfigs,
          containerMCPBridges: this._containerMCPBridges,
          logger: this.logger,
          broadcastDesktopEvent: (_sessionId, eventType, payload) => {
            this._webChatChannel?.broadcastEvent(eventType, payload);
          },
          signalBackgroundRun: async (_sessionId, signal) => {
            const signalled = await this._backgroundRunSupervisor?.signalRun({
              sessionId: _sessionId,
              type: signal.type as any,
              content: signal.content,
              data: signal.data,
            });
            return signalled ?? false;
          },
          pushStatusToSession: (sessionId, msg) => {
            this._webChatChannel?.pushToSession(sessionId, msg);
          },
        },
      );
      this._desktopRouterFactory = factory;
    }

    this.refreshSubAgentToolCatalog(registry, environment, {
      includeStaticDesktopTools: config.desktop?.enabled === true,
    });

    this._allLlmTools = [...llmTools];
    this._llmTools = filterLlmToolsByEnvironment(llmTools, environment);
    this._toolRouter = new ToolRouter(
      this._llmTools,
      config.llm?.toolRouting,
      this.logger,
    );
    this._baseToolHandler = baseToolHandler;
    const providers = await this.createLLMProviders(config, this._llmTools);
    this._llmProviders = providers;
    const skillInjector = this.createSkillInjector(availableSkills);
    const memoryBackend = await createMemoryBackend({
      config,
      metrics: telemetry ?? undefined,
      logger: this.logger,
    });
    this._memoryBackend = memoryBackend;

    const { memoryRetriever, learningProvider } =
      await this.createWebChatMemoryRetrievers({
        config,
        hooks,
        memoryBackend,
      });

    // --- Cross-session progress tracker ---
    const progressTracker = new ProgressTracker({
      memoryBackend,
      logger: this.logger,
    });
    hooks.on({
      event: "tool:after",
      name: "progress-tracker",
      priority: HOOK_PRIORITIES.PROGRESS_TRACKER,
      handler: async (ctx) => {
        const { sessionId, toolName, args, result, durationMs } =
          ctx.payload as {
            sessionId: string;
            toolName: string;
            args: Record<string, unknown>;
            result: string;
            durationMs: number;
          };
        await progressTracker.append({
          sessionId,
          type: "tool_result",
          summary: summarizeToolResult(toolName, args, result, durationMs),
        });
        return { continue: true };
      },
    });
    hooks.on({
      ...createBackgroundRunToolAfterHook({
        getSupervisor: () => this._backgroundRunSupervisor,
        logger: this.logger,
      }),
      priority: HOOK_PRIORITIES.BACKGROUND_RUN_WAKE,
    });

    await this.attachWebChatPolicyHook({
      config,
      hooks,
      telemetry,
      memoryBackend,
    });

    const approvalRules = resolveGatewayApprovalRules({
      approvals: config.approvals,
      mcpServers: config.mcp?.servers,
    });
    const approvalEngine =
      approvalRules.length > 0
        ? new ApprovalEngine({
            rules: approvalRules,
            timeoutMs: config.approvals?.timeoutMs,
            defaultSlaMs: config.approvals?.defaultSlaMs,
            defaultEscalationDelayMs:
              config.approvals?.defaultEscalationDelayMs,
            resolverSigningKey:
              config.approvals?.resolverSigningKey ?? config.auth?.secret,
          })
        : null;
    this._approvalEngine = approvalEngine;
    approvalEngine?.onRequest(async (request) => {
      await this.appendGovernanceAuditEvent({
        type: "approval.requested",
        actor: request.sessionId,
        subject: request.toolName,
        scope: this.resolvePolicyScopeForSession({
          sessionId: request.sessionId,
          runId: request.parentSessionId ?? request.sessionId,
          channel: "webchat",
        }),
        payload: {
          requestId: request.id,
          message: request.message,
          deadlineAt: request.deadlineAt,
          slaMs: request.slaMs,
          escalateAt: request.escalateAt,
          allowDelegatedResolution: request.allowDelegatedResolution,
          approverGroup: request.approverGroup,
          requiredApproverRoles: request.requiredApproverRoles,
          parentSessionId: request.parentSessionId,
          subagentSessionId: request.subagentSessionId,
        },
      });
    });
    approvalEngine?.onEscalation(async (request, escalation) => {
      await this.appendGovernanceAuditEvent({
        type: "approval.escalated",
        actor: escalation.escalateToSessionId,
        subject: request.toolName,
        scope: this.resolvePolicyScopeForSession({
          sessionId: request.sessionId,
          runId: request.parentSessionId ?? request.sessionId,
          channel: "webchat",
        }),
        payload: {
          requestId: request.id,
          escalatedAt: escalation.escalatedAt,
          escalateToSessionId: escalation.escalateToSessionId,
          deadlineAt: escalation.deadlineAt,
          approverGroup: escalation.approverGroup,
          requiredApproverRoles: escalation.requiredApproverRoles,
        },
      });
      const targetSessionId = escalation.escalateToSessionId;
      this.pushApprovalEscalationNotice({
        sessionId: targetSessionId,
        request,
        escalation,
      });
      void this._backgroundRunSupervisor
        ?.signalRun({
          sessionId: targetSessionId,
          type: "approval",
          content: `Approval escalation for ${request.toolName} (${request.id}).`,
          data: {
            requestId: request.id,
            toolName: request.toolName,
            escalatedAt: escalation.escalatedAt,
            escalateToSessionId: escalation.escalateToSessionId,
            approverGroup: escalation.approverGroup,
            requiredApproverRoles: escalation.requiredApproverRoles,
          },
        })
        .catch((error) => {
          this.logger.debug(
            "Failed to signal background run from approval escalation",
            {
              sessionId: targetSessionId,
              requestId: request.id,
              error: toErrorMessage(error),
            },
          );
        });
    });
    approvalEngine?.onResponse(async (request, response) => {
      await this.appendGovernanceAuditEvent({
        type: "approval.resolved",
        actor: response.approvedBy,
        subject: request.toolName,
        scope: this.resolvePolicyScopeForSession({
          sessionId: request.sessionId,
          runId: request.parentSessionId ?? request.sessionId,
          channel: "webchat",
        }),
        payload: {
          requestId: request.id,
          disposition: response.disposition,
          approvedBy: response.approvedBy,
          resolver: response.resolver,
        },
      });
      const sessionId = request.parentSessionId ?? request.sessionId;
      void this._backgroundRunSupervisor
        ?.signalRun({
          sessionId,
          type: "approval",
          content: `Approval ${response.disposition} for ${request.toolName} (${request.id}).`,
          data: {
            requestId: request.id,
            toolName: request.toolName,
            disposition: response.disposition,
            approvedBy: response.approvedBy,
          },
        })
        .catch((error) => {
          this.logger.debug(
            "Failed to signal background run from approval response",
            {
              sessionId,
              requestId: request.id,
              error: toErrorMessage(error),
            },
          );
        });
    });

    // --- Resumable pipeline executor ---
    const pipelineExecutor = new PipelineExecutor({
      toolHandler: baseToolHandler,
      memoryBackend,
      approvalEngine: approvalEngine ?? undefined,
      progressTracker,
      logger: this.logger,
    });

    const contextWindowTokens = await this.resolveLlmContextWindowTokens(
      config.llm,
    );
    this._resolvedContextWindowTokens = contextWindowTokens;
    const sessionTokenBudget = resolveSessionTokenBudget(
      config.llm,
      contextWindowTokens,
    );
    const promptBudget = buildPromptBudgetConfig(
      config.llm,
      contextWindowTokens,
    );
    const resolvedSubAgentConfig = resolveSubAgentRuntimeConfig(config.llm, {
      unsafeBenchmarkMode: this.yolo,
    });
    await this.refreshHostToolingProfile({
      enabled: resolvedSubAgentConfig.enabled,
      logging: config.logging,
    });
    const plannerPipelineExecutor = this.createPlannerPipelineExecutor(
      pipelineExecutor,
      resolvedSubAgentConfig,
      promptBudget,
    );
    const defaultForegroundMaxToolRounds =
      config.llm?.maxToolRounds ?? getDefaultMaxToolRounds(config);
    this._defaultForegroundMaxToolRounds = defaultForegroundMaxToolRounds;

    this._chatExecutor = createChatExecutor({
      providers,
      toolHandler: baseToolHandler,
      allowedTools: this.getAdvertisedToolNames(),
      skillInjector,
      memoryRetriever,
      learningProvider,
      progressProvider: progressTracker,
      promptBudget,
      maxToolRounds: defaultForegroundMaxToolRounds,
      sessionTokenBudget,
      onCompaction: this.handleCompaction,
      llmConfig: config.llm,
      subagentConfig: resolvedSubAgentConfig,
      resolveDelegationScoreThreshold: () =>
        this.resolveDelegationScoreThreshold(),
      delegationLearning: {
        trajectorySink: this._delegationTrajectorySink ?? undefined,
        banditTuner: this._delegationBanditTuner ?? undefined,
        defaultStrategyArmId: "balanced",
      },
      resolveHostToolingProfile: () => this._hostToolingProfile,
      pipelineExecutor: plannerPipelineExecutor,
    });

    const sessionMgr = this.createSessionManager(hooks);
    this._webSessionManager = sessionMgr;
    const resolveSessionId = this.createSessionIdResolver(sessionMgr);
    this._systemPrompt = await this._buildSystemPrompt(config);
    this._voiceSystemPrompt = await this._buildSystemPrompt(config, {
      forVoice: true,
    });
    const commandRegistry = this.createCommandRegistry(
      sessionMgr,
      resolveSessionId,
      providers,
      memoryBackend,
      registry,
      availableSkills,
      skillList,
      hooks,
      baseToolHandler,
      approvalEngine,
      progressTracker,
      pipelineExecutor,
    );
    const voiceDeps = {
      getChatExecutor: () => this._chatExecutor,
      sessionManager: sessionMgr,
      hooks,
      approvalEngine: approvalEngine ?? undefined,
      memoryBackend,
      delegation: this.resolveDelegationToolContext,
    };
    const voiceBridge = this.createOptionalVoiceBridge(
      config,
      this._llmTools,
      baseToolHandler,
      this._systemPrompt,
      voiceDeps,
      this._voiceSystemPrompt,
    );
    this._voiceBridge = voiceBridge ?? null;

    const webChat = new WebChatChannel({
      gateway: {
        getStatus: () => gateway.getStatus(),
        config,
      },
      getDaemonStatus: () => this.getStatus(),
      skills: skillList,
      voiceBridge,
      memoryBackend,
      approvalEngine: approvalEngine ?? undefined,
      skillToggle,
      connection: this._connectionManager?.getConnection(),
      broadcastEvent: (type, data) => webChat.broadcastEvent(type, data),
      desktopManager: this._desktopManager ?? undefined,
      onDesktopSessionRebound: (webSessionId: string) => {
        void import("../desktop/session-router.js").then(
          ({ destroySessionBridge }) => {
            destroySessionBridge(
              webSessionId,
              this._desktopBridges,
              this._playwrightBridges,
              this._containerMCPBridges,
              this.logger,
            );
          },
        );
      },
      resetSessionContext: (webSessionId: string) =>
        this.resetWebSessionContext({
          webSessionId,
          sessionMgr,
          resolveSessionId,
          memoryBackend,
          progressTracker,
        }),
      hydrateSessionContext: (webSessionId: string) =>
        this.hydrateWebSessionContext({
          webSessionId,
          sessionMgr,
          resolveSessionId,
          memoryBackend,
        }),
      cancelBackgroundRun: (sessionId: string) =>
        this._backgroundRunSupervisor?.cancelRun(
          sessionId,
          "Background run cancelled from the web UI.",
        ) ?? false,
      listBackgroundRuns: (sessionIds) =>
        this.listOwnedBackgroundRuns(sessionIds),
      getBackgroundRunAvailability: () => this.getBackgroundRunAvailability(),
      inspectBackgroundRun: (sessionId) =>
        this.inspectOwnedBackgroundRun(sessionId),
      controlBackgroundRun: (params) => this.controlOwnedBackgroundRun(params),
      policyPreview: (params) =>
        this.buildPolicySimulationPreview({
          sessionId: params.sessionId,
          toolName: params.toolName,
          args: params.args,
        }),
      getObservabilitySummary: async (query) =>
        this._observabilityService
          ? this._observabilityService.getSummary(query)
          : undefined,
      listObservabilityTraces: async (query) =>
        this._observabilityService
          ? this._observabilityService.listTraces(query)
          : undefined,
      getObservabilityTrace: async (traceId) =>
        this._observabilityService
          ? this._observabilityService.getTrace(traceId)
          : undefined,
      getObservabilityArtifact: async (path) =>
        this._observabilityService
          ? this._observabilityService.getArtifact(path)
          : undefined,
      getObservabilityLogTail: async (params) =>
        this._observabilityService
          ? this._observabilityService.getLogTail(params)
          : undefined,
    });
    const signals = this.createWebChatSignals(webChat);
    const onMessage = this.createWebChatMessageHandler({
      webChat,
      commandRegistry,
      getChatExecutor: () => this._chatExecutor,
      getLoggingConfig: () => gateway.config.logging,
      hooks,
      sessionMgr,
      getSystemPrompt: () => this._systemPrompt,
      baseToolHandler,
      approvalEngine,
      memoryBackend,
      signals,
      sessionTokenBudget,
      contextWindowTokens,
    });
    this._webChatInboundHandler = onMessage;

    await webChat.initialize({ onMessage, logger: this.logger, config: {} });
    await webChat.start();

    gateway.setWebChatHandler(webChat);
    this._webChatChannel = webChat;
    const autonomyConfig = gateway.config.autonomy;
    const autonomyTraceConfig = resolveTraceLoggingConfig(
      gateway.config.logging,
    );
    const traceProviderPayloads =
      autonomyTraceConfig.enabled &&
      autonomyTraceConfig.includeProviderPayloads;
    const backgroundRunsEnabled =
      autonomyConfig?.enabled !== false &&
      autonomyConfig?.featureFlags?.backgroundRuns !== false &&
      autonomyConfig?.killSwitches?.backgroundRuns !== true;
    const multiAgentEnabled =
      backgroundRunsEnabled &&
      autonomyConfig?.featureFlags?.multiAgent !== false &&
      autonomyConfig?.killSwitches?.multiAgent !== true;
    const backgroundRunNotificationsEnabled =
      backgroundRunsEnabled &&
      autonomyConfig?.featureFlags?.notifications !== false &&
      autonomyConfig?.killSwitches?.notifications !== true;
    if (this._chatExecutor && providers[0] && backgroundRunsEnabled) {
      const runStore = new BackgroundRunStore({
        memoryBackend,
        logger: this.logger,
      });
      const notifier =
        backgroundRunNotificationsEnabled &&
        autonomyConfig?.notifications?.enabled !== false &&
        Array.isArray(autonomyConfig?.notifications?.sinks) &&
        autonomyConfig.notifications.sinks.length > 0
          ? new BackgroundRunNotifier({
              config: autonomyConfig.notifications,
              logger: this.logger,
            })
          : undefined;
      this._backgroundRunSupervisor = new BackgroundRunSupervisor({
        chatExecutor: this._chatExecutor,
        supervisorLlm: providers[0],
        getSystemPrompt: () => this._systemPrompt,
        runStore,
        policyEngine: this._policyEngine ?? undefined,
        resolvePolicyScope: ({ sessionId, runId }) =>
          this.resolvePolicyScopeForSession({
            sessionId,
            runId,
            channel: "webchat",
          }),
        telemetry: this._telemetry ?? undefined,
        createToolHandler: ({ sessionId, runId, cycleIndex }) =>
          this.createWebChatSessionToolHandler({
            sessionId,
            webChat,
            hooks,
            approvalEngine: approvalEngine ?? undefined,
            baseToolHandler,
            traceLabel: "webchat.background",
            traceConfig: resolveTraceLoggingConfig(gateway.config.logging),
            traceId: `background:${sessionId}:${runId}:${cycleIndex}`,
            hookMetadata: { backgroundRunId: runId },
          }),
        buildToolRoutingDecision: (sessionId, messageText, history) =>
          this.buildToolRoutingDecision(sessionId, messageText, history),
        seedHistoryForSession: (sessionId) =>
          sessionMgr.get(sessionId)?.history ?? [],
        isSessionBusy: (sessionId) =>
          this._foregroundSessionLocks.has(sessionId),
        onStatus: (sessionId, payload) => {
          webChat.pushToSession(sessionId, { type: "agent.status", payload });
        },
        publishUpdate: async (sessionId, content) => {
          await webChat.send({ sessionId, content });
          await memoryBackend
            .addEntry({
              sessionId,
              role: "assistant",
              content,
            })
            .catch((error) => {
              this.logger.debug("Background run memory write failed", {
                sessionId,
                error: toErrorMessage(error),
              });
            });
        },
        progressTracker,
        logger: this.logger,
        notifier,
        traceProviderPayloads,
      });
      this._durableSubrunOrchestrator = new DurableSubrunOrchestrator({
        supervisor: this._backgroundRunSupervisor,
        enabled: multiAgentEnabled,
        logger: this.logger,
        qualityArtifactProvider: () =>
          this.loadBackgroundRunQualityArtifactFromDisk(),
        delegationBenchmarkProvider: () =>
          this.loadDelegationBenchmarkSummaryFromDisk(),
        admissionEvaluator: ({ parentRun }): DurableSubrunAdmissionDecision =>
          this.evaluateMultiAgentAdmission(parentRun),
      });
      gateway.registerWebhookRoute(
        createBackgroundRunWebhookRoute({
          getSupervisor: () => this._backgroundRunSupervisor,
          authSecret: gateway.config.auth?.secret,
          logger: this.logger,
        }),
      );
      const recoveredRuns = await this._backgroundRunSupervisor.recoverRuns();
      if (recoveredRuns > 0) {
        this.logger.info(
          `Recovered ${recoveredRuns} background run(s) on boot`,
        );
      }
    } else {
      this._backgroundRunSupervisor = null;
      this._durableSubrunOrchestrator = null;
    }
    if (this._remoteJobManager) {
      gateway.registerWebhookRoute({
        method: "POST",
        path: "/webhooks/remote-job/:jobHandleId",
        handler: async (req) => {
          const response = await this._remoteJobManager!.handleWebhook({
            jobHandleId: String(req.params?.jobHandleId ?? ""),
            headers: req.headers,
            body: req.body,
          });
          return {
            status: response.status,
            body: response.body,
          };
        },
      });
    }
    this.attachSubAgentLifecycleBridge(webChat);

    this.registerWebChatConfigReloadHandler({
      gateway,
      skillInjector,
      memoryRetriever,
      learningProvider,
      progressTracker,
      pipelineExecutor,
      registry,
      baseToolHandler,
      voiceDeps,
    });

    const toolCount = registry.size;
    const skillCount = availableSkills.length;
    const providerNames = providers.map((p) => p.name).join(" → ") || "none";
    this.logger.info(
      `WebChat wired` +
        ` with LLM [${providerNames}]` +
        `, ${toolCount} tools, ${skillCount} skills` +
        `, memory=${memoryBackend.name}` +
        `, ${commandRegistry.size} commands` +
        (telemetry ? ", telemetry" : "") +
        `, budget=${sessionTokenBudget}` +
        (voiceBridge ? ", voice" : "") +
        ", hooks, sessions, approvals",
    );
  }

  private async buildWebChatSkillState(): Promise<{
    availableSkills: DiscoveredSkill[];
    skillList: WebChatSkillSummary[];
    skillToggle: (name: string, enabled: boolean) => void;
  }> {
    const discovered = await this.discoverSkills();
    const availableSkills = discovered.filter((entry) => entry.available);
    const skillList: WebChatSkillSummary[] = discovered.map((entry) => ({
      name: entry.skill.name,
      description: entry.skill.description,
      enabled: entry.available,
    }));
    const skillToggle = (name: string, enabled: boolean): void => {
      const skill = skillList.find((entry) => entry.name === name);
      if (skill) {
        skill.enabled = enabled;
      }
    };
    return { availableSkills, skillList, skillToggle };
  }

  private createWebChatTelemetry(
    config: GatewayConfig,
  ): UnifiedTelemetryCollector | null {
    if (config.telemetry?.enabled === false) {
      return null;
    }
    const telemetry = new UnifiedTelemetryCollector(
      { flushIntervalMs: config.telemetry?.flushIntervalMs ?? 60_000 },
      this.logger,
    );
    this._telemetry = telemetry;
    return telemetry;
  }

  private buildGatewayStatusSnapshot(baseStatus: GatewayStatus): GatewayStatus {
    return {
      ...baseStatus,
      backgroundRuns: this.buildBackgroundRunStatusSummary(),
    };
  }

  private buildBackgroundRunOperatorAvailability():
    BackgroundRunOperatorAvailability {
    const autonomyConfig = this.gateway?.config.autonomy;
    if (autonomyConfig?.enabled === false) {
      return {
        enabled: false,
        operatorAvailable: false,
        inspectAvailable: false,
        controlAvailable: false,
        disabledCode: "autonomy_disabled",
        disabledReason: "Autonomy is disabled for this runtime.",
      };
    }
    if (autonomyConfig?.featureFlags?.backgroundRuns === false) {
      return {
        enabled: false,
        operatorAvailable: false,
        inspectAvailable: false,
        controlAvailable: false,
        disabledCode: "background_runs_feature_disabled",
        disabledReason:
          "Durable background runs are disabled in autonomy feature flags.",
      };
    }
    if (autonomyConfig?.killSwitches?.backgroundRuns === true) {
      return {
        enabled: false,
        operatorAvailable: false,
        inspectAvailable: false,
        controlAvailable: false,
        disabledCode: "background_runs_kill_switch",
        disabledReason:
          "Durable background runs are disabled by the autonomy kill switch.",
      };
    }
    if (!this._backgroundRunSupervisor) {
      return {
        enabled: true,
        operatorAvailable: false,
        inspectAvailable: false,
        controlAvailable: false,
        disabledCode: "operator_unavailable",
        disabledReason:
          "Durable background runs are enabled, but the run operator is not attached to this runtime.",
      };
    }
    return {
      enabled: true,
      operatorAvailable: true,
      inspectAvailable: true,
      controlAvailable: true,
    };
  }

  private attachBackgroundRunAvailability<T extends BackgroundRunOperatorSummary>(
    value: T,
  ): T {
    return {
      ...value,
      availability: this.buildBackgroundRunOperatorAvailability(),
    };
  }

  private buildBackgroundRunStatusSummary():
    GatewayBackgroundRunStatus {
    const fleet = this._backgroundRunSupervisor?.getFleetStatusSnapshot();
    const telemetry = this._telemetry?.getFullSnapshot();
    const multiAgentEnabled = this._durableSubrunOrchestrator !== null;
    const availability = this.buildBackgroundRunOperatorAvailability();

    return {
      enabled: availability.enabled,
      operatorAvailable: availability.operatorAvailable,
      inspectAvailable: availability.inspectAvailable,
      controlAvailable: availability.controlAvailable,
      disabledCode: availability.disabledCode,
      disabledReason: availability.disabledReason,
      multiAgentEnabled,
      activeTotal: fleet?.activeTotal ?? 0,
      queuedSignalsTotal: fleet?.queuedSignalsTotal ?? 0,
      stateCounts: fleet?.stateCounts ?? {
        pending: 0,
        running: 0,
        working: 0,
        blocked: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suspended: 0,
      },
      recentAlerts: fleet?.recentAlerts ?? [],
      metrics: {
        startedTotal: this.getTelemetryCounterTotal(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_STARTED_TOTAL,
        ),
        completedTotal: this.getTelemetryCounterTotal(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_COMPLETED_TOTAL,
        ),
        failedTotal: this.getTelemetryCounterTotal(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_FAILED_TOTAL,
        ),
        blockedTotal: this.getTelemetryCounterTotal(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_BLOCKED_TOTAL,
        ),
        recoveredTotal: this.getTelemetryCounterTotal(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_RECOVERED_TOTAL,
        ),
        meanLatencyMs: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_LATENCY_MS,
        ),
        meanTimeToFirstAckMs: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_ACK_MS,
        ),
        meanTimeToFirstVerifiedUpdateMs: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_VERIFIED_UPDATE_MS,
        ),
        falseCompletionRate: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_FALSE_COMPLETION_RATE,
        ),
        blockedWithoutNoticeRate: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_BLOCKED_WITHOUT_NOTICE_RATE,
        ),
        meanStopLatencyMs: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_STOP_LATENCY_MS,
        ),
        recoverySuccessRate: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_RECOVERY_SUCCESS_RATE,
        ),
        verifierAccuracyRate: this.getTelemetryHistogramMean(
          telemetry,
          TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_VERIFIER_ACCURACY,
        ),
      },
    };
  }

  private resolveArtifactPathCandidates(fileName: string): string[] {
    return [
      resolvePath(
        process.cwd(),
        "runtime",
        "benchmarks",
        "artifacts",
        fileName,
      ),
      resolvePath(process.cwd(), "benchmarks", "artifacts", fileName),
    ];
  }

  private async loadJsonArtifact<T>(
    candidates: readonly string[],
    parser: (value: unknown) => T,
  ): Promise<T | undefined> {
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        const raw = await readFile(candidate, "utf8");
        return parser(JSON.parse(raw));
      } catch (error) {
        const message = toErrorMessage(error);
        if (
          message.includes("ENOENT") ||
          message.includes("no such file") ||
          message.includes("Unexpected end of JSON input")
        ) {
          continue;
        }
        this.logger.debug("Autonomy artifact load failed", {
          path: candidate,
          error: message,
        });
      }
    }
    return undefined;
  }

  private async loadBackgroundRunQualityArtifactFromDisk() {
    return this.loadJsonArtifact(
      this.resolveArtifactPathCandidates("background-run-quality.ci.json"),
      parseBackgroundRunQualityArtifact,
    );
  }

  private async loadDelegationBenchmarkSummaryFromDisk(): Promise<
    DelegationBenchmarkSummary | undefined
  > {
    return this.loadJsonArtifact(
      this.resolveArtifactPathCandidates("delegation-benchmark.latest.json"),
      (value) => {
        if (typeof value !== "object" || value === null) {
          throw new Error("delegation benchmark artifact must be an object");
        }
        const summary = (value as Record<string, unknown>).summary;
        if (typeof summary !== "object" || summary === null) {
          throw new Error("delegation benchmark artifact summary is missing");
        }
        return summary as DelegationBenchmarkSummary;
      },
    );
  }

  private evaluateBackgroundRunAdmission(params: {
    sessionId: string;
    domain: string;
  }) {
    const scope = this.resolvePolicyScopeForSession({
      sessionId: params.sessionId,
      channel: "webchat",
    });
    return evaluateAutonomyCanaryAdmission({
      autonomy: this.gateway?.config.autonomy,
      tenantId: scope.tenantId,
      feature: "backgroundRuns",
      domain: params.domain,
      stableKey: params.sessionId,
    });
  }

  private evaluateMultiAgentAdmission(
    parentRun: PersistedBackgroundRun,
  ): DurableSubrunAdmissionDecision {
    const decision = evaluateAutonomyCanaryAdmission({
      autonomy: this.gateway?.config.autonomy,
      tenantId: parentRun.policyScope?.tenantId,
      feature: "multiAgent",
      domain: parentRun.contract.domain,
      stableKey: parentRun.sessionId,
    });
    return {
      allowed: decision.allowed,
      reason: decision.reason,
    };
  }

  private async listOwnedBackgroundRuns(
    sessionIds: readonly string[],
  ): Promise<readonly BackgroundRunOperatorSummary[]> {
    if (!this._backgroundRunSupervisor || sessionIds.length === 0) {
      return [];
    }
    const summaries =
      await this._backgroundRunSupervisor.listOperatorSummaries(sessionIds);
    return summaries.map((summary) =>
      this.attachBackgroundRunAvailability(summary),
    );
  }

  private getBackgroundRunAvailability():
    BackgroundRunOperatorAvailability {
    return this.buildBackgroundRunOperatorAvailability();
  }

  private async inspectOwnedBackgroundRun(
    sessionId: string,
  ): Promise<BackgroundRunOperatorDetail | undefined> {
    if (!this._backgroundRunSupervisor) {
      return undefined;
    }
    const detail = await this._backgroundRunSupervisor.getOperatorDetail(sessionId);
    return detail
      ? this.attachBackgroundRunAvailability(detail)
      : undefined;
  }

  private async controlOwnedBackgroundRun(params: {
    action: BackgroundRunControlAction;
    actor?: string;
    channel?: string;
  }): Promise<BackgroundRunOperatorDetail | undefined> {
    if (!this._backgroundRunSupervisor) {
      return undefined;
    }
    const detail = await this._backgroundRunSupervisor.applyOperatorControl(
      params.action,
    );
    if (!detail) {
      return undefined;
    }
    const detailWithAvailability = this.attachBackgroundRunAvailability(detail);
    await this.appendGovernanceAuditEvent({
      type: "run.controlled",
      actor: params.actor ? `webchat:${params.actor}` : undefined,
      subject: detailWithAvailability.sessionId,
      scope: {
        tenantId: detailWithAvailability.policyScope?.tenantId,
        projectId: detailWithAvailability.policyScope?.projectId,
        runId: detailWithAvailability.runId,
        sessionId: detailWithAvailability.sessionId,
        channel: params.channel,
      },
      payload: {
        action: params.action.action,
        state: detailWithAvailability.state,
        currentPhase: detailWithAvailability.currentPhase,
        unsafeToContinue: detailWithAvailability.unsafeToContinue,
      },
    });
    return detailWithAvailability;
  }

  private getTelemetryCounterTotal(
    snapshot: TelemetrySnapshot | null | undefined,
    metricName: string,
  ): number {
    if (!snapshot) {
      return 0;
    }
    return Object.entries(snapshot.counters)
      .filter(([key]) => key === metricName || key.startsWith(`${metricName}|`))
      .reduce((sum, [, value]) => sum + value, 0);
  }

  private getTelemetryHistogramMean(
    snapshot: TelemetrySnapshot | null | undefined,
    metricName: string,
  ): number | undefined {
    if (!snapshot) {
      return undefined;
    }
    const entries = Object.entries(snapshot.histograms)
      .filter(([key]) => key === metricName || key.startsWith(`${metricName}|`))
      .flatMap(([, values]) => values);
    if (entries.length === 0) {
      return undefined;
    }
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    return total / entries.length;
  }

  private async createWebChatMemoryRetrievers(params: {
    config: GatewayConfig;
    hooks: HookDispatcher;
    memoryBackend: MemoryBackend;
  }): Promise<{
    memoryRetriever: MemoryRetriever;
    learningProvider: MemoryRetriever;
  }> {
    const { config, hooks, memoryBackend } = params;

    return createMemoryRetrievers({
      config,
      hooks,
      memoryBackend,
      workspacePath: this._resolveActiveHostWorkspacePath(config),
      logger: this.logger,
    });
  }

  private async attachWebChatPolicyHook(params: {
    config: GatewayConfig;
    hooks: HookDispatcher;
    telemetry: UnifiedTelemetryCollector | null;
    memoryBackend: MemoryBackend;
  }): Promise<void> {
    const { config, hooks, telemetry, memoryBackend } = params;
    this._sessionCredentialBroker = null;
    if (!config.policy?.enabled) {
      return;
    }
    try {
      const { PolicyEngine } = await import("../policy/engine.js");
      const { MemoryBackedGovernanceAuditLog } =
        await import("../policy/governance-audit-log.js");
      const { createPolicyGateHook } = await import("../policy/policy-gate.js");
      const resolvedAuditSigningKey =
        config.policy.audit?.signingKey ?? config.auth?.secret;
      if (config.policy.audit?.enabled === true && !resolvedAuditSigningKey) {
        this.logger.warn?.(
          "Policy governance audit logging is enabled but no signing key is configured; audit log disabled",
        );
      }
      this._governanceAuditLog =
        config.policy.audit?.enabled === true && resolvedAuditSigningKey
          ? await MemoryBackedGovernanceAuditLog.create({
              signingKey: resolvedAuditSigningKey,
              retentionMs: config.policy.audit?.retentionMs,
              maxEntries: config.policy.audit?.maxEntries,
              retentionMode: config.policy.audit?.retentionMode,
              legalHold: config.policy.audit?.legalHold,
              redaction: config.policy.audit?.redaction,
              memoryBackend,
            })
          : null;
      this._policyEngine = new PolicyEngine({
        policy: {
          enabled: true,
          simulationMode: config.policy.simulationMode,
          toolAllowList: config.policy.toolAllowList,
          toolDenyList: config.policy.toolDenyList,
          credentialAllowList: config.policy.credentialAllowList,
          networkAccess: config.policy.networkAccess,
          writeScope: config.policy.writeScope,
          credentialCatalog: mapCredentialCatalog(
            config.policy.credentialCatalog,
          ),
          actionBudgets: config.policy.actionBudgets,
          spendBudget: config.policy.spendBudget
            ? {
                limitLamports: BigInt(config.policy.spendBudget.limitLamports),
                windowMs: config.policy.spendBudget.windowMs,
              }
            : undefined,
          tokenBudget: config.policy.tokenBudget
            ? {
                limitTokens: config.policy.tokenBudget.limitTokens,
                windowMs: config.policy.tokenBudget.windowMs,
              }
            : undefined,
          runtimeBudget: config.policy.runtimeBudget
            ? {
                maxElapsedMs: config.policy.runtimeBudget.maxElapsedMs,
              }
            : undefined,
          processBudget: config.policy.processBudget
            ? {
                maxConcurrent: config.policy.processBudget.maxConcurrent,
              }
            : undefined,
          scopedActionBudgets: config.policy.scopedActionBudgets
            ? mapScopedActionBudgets(config.policy.scopedActionBudgets)
            : undefined,
          scopedSpendBudgets: config.policy.scopedSpendBudgets
            ? mapScopedSpendBudgets(config.policy.scopedSpendBudgets)
            : undefined,
          scopedTokenBudgets: config.policy.scopedTokenBudgets
            ? mapScopedTokenBudgets(config.policy.scopedTokenBudgets)
            : undefined,
          scopedRuntimeBudgets: config.policy.scopedRuntimeBudgets
            ? mapScopedRuntimeBudgets(config.policy.scopedRuntimeBudgets)
            : undefined,
          scopedProcessBudgets: config.policy.scopedProcessBudgets
            ? mapScopedProcessBudgets(config.policy.scopedProcessBudgets)
            : undefined,
          maxRiskScore: config.policy.maxRiskScore,
          policyClassRules: config.policy.policyClassRules,
          circuitBreaker: config.policy.circuitBreaker,
          defaultTenantId: config.policy.defaultTenantId,
          defaultProjectId: config.policy.defaultProjectId,
          tenantBundles: mapPolicyBundles(config.policy.tenantBundles),
          projectBundles: mapPolicyBundles(config.policy.projectBundles),
          audit: config.policy.audit,
        },
        logger: this.logger,
        metrics: telemetry ?? undefined,
      });
      this._sessionCredentialBroker = new SessionCredentialBroker({
        policy: this._policyEngine.getPolicy(),
        logger: this.logger,
        onLeaseIssued: async ({ sessionId, credentialId, scope, lease }) => {
          await this.appendGovernanceAuditEvent({
            type: "credential.issued",
            actor: sessionId,
            subject: credentialId,
            scope,
            payload: {
              sessionId,
              credentialId,
              sourceEnvVar: lease.sourceEnvVar,
              issuedAt: lease.issuedAt,
              expiresAt: lease.expiresAt,
              domains: lease.domains,
              allowedTools: lease.allowedTools,
            },
          });
        },
        onLeaseRevoked: async ({
          sessionId,
          credentialId,
          scope,
          lease,
          reason,
        }) => {
          await this.appendGovernanceAuditEvent({
            type: "credential.revoked",
            actor: sessionId,
            subject: credentialId,
            scope,
            payload: {
              sessionId,
              credentialId,
              sourceEnvVar: lease.sourceEnvVar,
              issuedAt: lease.issuedAt,
              expiresAt: lease.expiresAt,
              revokedAt: lease.revokedAt,
              reason,
            },
          });
        },
      });
      hooks.on({
        ...createPolicyGateHook({
          engine: this._policyEngine,
          logger: this.logger,
          simulationMode: config.policy.simulationMode,
          auditLog: this._governanceAuditLog ?? undefined,
          resolveScope: (payload) => {
            const sessionId =
              typeof payload.sessionId === "string"
                ? payload.sessionId
                : undefined;
            if (!sessionId) {
              return {
                tenantId: config.policy?.defaultTenantId,
                projectId: config.policy?.defaultProjectId,
                runId:
                  typeof payload.backgroundRunId === "string"
                    ? payload.backgroundRunId
                    : undefined,
                channel: "webchat",
              };
            }
            return this.resolvePolicyScopeForSession({
              sessionId,
              runId:
                typeof payload.backgroundRunId === "string"
                  ? payload.backgroundRunId
                  : undefined,
              channel: "webchat",
            });
          },
        }),
        priority: HOOK_PRIORITIES.POLICY_GATE,
      });
      this.logger.info("Policy engine initialized");
    } catch (error) {
      this.logger.warn?.("Policy engine initialization failed:", error);
    }
  }

  private registerWebChatConfigReloadHandler(params: {
    gateway: Gateway;
    skillInjector: SkillInjector;
    memoryRetriever: MemoryRetriever;
    learningProvider: MemoryRetriever;
    progressTracker: ProgressTracker;
    pipelineExecutor: PipelineExecutor;
    registry: ToolRegistry;
    baseToolHandler: ToolHandler;
    voiceDeps: {
      getChatExecutor: () => ChatExecutor | null | undefined;
      sessionManager: SessionManager;
      hooks: HookDispatcher;
      approvalEngine?: ApprovalEngine;
      memoryBackend: MemoryBackend;
      delegation: DelegationToolCompositionResolver;
    };
  }): void {
    const {
      gateway,
      skillInjector,
      memoryRetriever,
      learningProvider,
      progressTracker,
      pipelineExecutor,
      registry,
      baseToolHandler,
      voiceDeps,
    } = params;
    gateway.on("configReloaded", (...args: unknown[]) => {
      const diff = args[0] as ConfigDiff;
      const logLevelChanged = diff.safe.includes("logging.level");
      if (logLevelChanged && gateway.config.logging?.level) {
        this.logger.setLevel?.(gateway.config.logging.level);
        this.logger.info(
          `Logger level updated to ${gateway.config.logging.level}`,
        );
      }
      const llmChanged = diff.safe.some((key) => key.startsWith("llm."));
      const subAgentChanged = diff.safe.some((key) =>
        key.startsWith("llm.subagents."),
      );
      if (subAgentChanged) {
        void this.configureSubAgentInfrastructure(gateway.config).catch(
          (error) => {
            this.logger.error(
              `Failed to reconfigure sub-agent orchestration: ${toErrorMessage(error)}`,
            );
          },
        );
      }
      const policyChanged = diff.safe.some((key) => key.startsWith("policy."));
      if (policyChanged && this._policyEngine) {
        const newConfig = gateway.config;
        if (newConfig.policy?.enabled) {
          this._policyEngine.setPolicy({
            enabled: true,
            toolAllowList: newConfig.policy.toolAllowList,
            toolDenyList: newConfig.policy.toolDenyList,
            actionBudgets: newConfig.policy.actionBudgets,
            spendBudget: newConfig.policy.spendBudget
              ? {
                  limitLamports: BigInt(
                    newConfig.policy.spendBudget.limitLamports,
                  ),
                  windowMs: newConfig.policy.spendBudget.windowMs,
                }
              : undefined,
            tokenBudget: newConfig.policy.tokenBudget
              ? {
                  limitTokens: newConfig.policy.tokenBudget.limitTokens,
                  windowMs: newConfig.policy.tokenBudget.windowMs,
                }
              : undefined,
            runtimeBudget: newConfig.policy.runtimeBudget
              ? {
                  maxElapsedMs: newConfig.policy.runtimeBudget.maxElapsedMs,
                }
              : undefined,
            processBudget: newConfig.policy.processBudget
              ? {
                  maxConcurrent: newConfig.policy.processBudget.maxConcurrent,
                }
              : undefined,
            scopedActionBudgets: newConfig.policy.scopedActionBudgets
              ? mapScopedActionBudgets(newConfig.policy.scopedActionBudgets)
              : undefined,
            scopedSpendBudgets: newConfig.policy.scopedSpendBudgets
              ? mapScopedSpendBudgets(newConfig.policy.scopedSpendBudgets)
              : undefined,
            scopedTokenBudgets: newConfig.policy.scopedTokenBudgets
              ? mapScopedTokenBudgets(newConfig.policy.scopedTokenBudgets)
              : undefined,
            scopedRuntimeBudgets: newConfig.policy.scopedRuntimeBudgets
              ? mapScopedRuntimeBudgets(newConfig.policy.scopedRuntimeBudgets)
              : undefined,
            scopedProcessBudgets: newConfig.policy.scopedProcessBudgets
              ? mapScopedProcessBudgets(newConfig.policy.scopedProcessBudgets)
              : undefined,
            maxRiskScore: newConfig.policy.maxRiskScore,
            policyClassRules: newConfig.policy.policyClassRules,
            circuitBreaker: newConfig.policy.circuitBreaker,
            defaultTenantId: newConfig.policy.defaultTenantId,
            defaultProjectId: newConfig.policy.defaultProjectId,
            tenantBundles: mapPolicyBundles(newConfig.policy.tenantBundles),
            projectBundles: mapPolicyBundles(newConfig.policy.projectBundles),
            networkAccess: newConfig.policy.networkAccess,
            writeScope: newConfig.policy.writeScope,
            credentialAllowList: newConfig.policy.credentialAllowList,
            credentialCatalog: mapCredentialCatalog(
              newConfig.policy.credentialCatalog,
            ),
            audit: newConfig.policy.audit,
            simulationMode: newConfig.policy.simulationMode,
          });
          this.logger.info("Policy engine config reloaded");
        }
      }
      const envChanged = diff.safe.some((key) => key === "desktop.environment");
      const voiceChanged = diff.safe.some((key) => key.startsWith("voice."));
      const shouldRefreshVoiceBridge = llmChanged || envChanged || voiceChanged;
      if (llmChanged || envChanged || shouldRefreshVoiceBridge) {
        void (async () => {
          if (envChanged) {
            const env = gateway.config.desktop?.environment ?? "both";
            this._llmTools = filterLlmToolsByEnvironment(
              this._allLlmTools,
              env,
            );
            this.refreshSubAgentToolCatalog(registry, env, {
              includeStaticDesktopTools:
                gateway.config.desktop?.enabled === true,
            });
          }
          if (llmChanged || envChanged) {
            await this.hotSwapLLMProvider(
              gateway.config,
              skillInjector,
              memoryRetriever,
              learningProvider,
              progressTracker,
              pipelineExecutor,
            );
          }
          if (llmChanged || envChanged) {
            this._systemPrompt = await this._buildSystemPrompt(gateway.config);
            this._voiceSystemPrompt = await this._buildSystemPrompt(
              gateway.config,
              { forVoice: true },
            );
            if (llmChanged) {
              this.logger.info("System prompt rebuilt after LLM config change");
            }
            if (envChanged) {
              const env = gateway.config.desktop?.environment ?? "both";
              this.logger.info(
                `Environment mode changed to "${env}" — ${this._llmTools.length} tools visible`,
              );
            }
          }
          if (shouldRefreshVoiceBridge) {
            await this._voiceBridge?.stopAll();
            const newBridge = this.createOptionalVoiceBridge(
              gateway.config,
              this._llmTools,
              baseToolHandler,
              this._systemPrompt,
              voiceDeps,
              this._voiceSystemPrompt,
            );
            this._voiceBridge = newBridge ?? null;
            if (this._webChatChannel) {
              this._webChatChannel.updateVoiceBridge(newBridge ?? null);
            }
            this.logger.info(
              `Voice bridge ${newBridge ? "recreated" : "disabled"}`,
            );
          }
        })();
      }
    });
  }

  /**
   * Build the dependency bag required by the extracted channel-wiring functions.
   */
  private _buildChannelWiringDeps(): ChannelWiringDeps {
    return {
      gateway: this.gateway,
      logger: this.logger,
      chatExecutor: this._chatExecutor,
      memoryBackend: this._memoryBackend,
      defaultForegroundMaxToolRounds: this._defaultForegroundMaxToolRounds,
      buildSystemPrompt: (config, options) =>
        this._buildSystemPrompt(config, options),
      handleTextChannelApprovalCommand: (params) =>
        this.handleTextChannelApprovalCommand(params),
      registerTextApprovalDispatcher: (sessionId, channelName, send) =>
        this.registerTextApprovalDispatcher(sessionId, channelName, send),
      createTextChannelSessionToolHandler: (params) =>
        this.createTextChannelSessionToolHandler(params),
      buildToolRoutingDecision: (sessionId, content, history) =>
        this.buildToolRoutingDecision(sessionId, content, history),
      recordToolRoutingOutcome: (sessionId, summary) =>
        this.recordToolRoutingOutcome(sessionId, summary),
    };
  }

  private async _stopChannelRegistry(
    channels: ReadonlyMap<string, ChannelPlugin>,
  ): Promise<void> {
    const entries = [...channels.entries()].reverse();
    for (const [name, channel] of entries) {
      try {
        await channel.stop();
      } catch (error) {
        this.logger.warn?.(`Failed to stop external channel '${name}':`, error);
      }
    }
  }

  private _buildFeatureWiringContext(): FeatureWiringContext {
    return {
      logger: this.logger,
      connectionManager: this._connectionManager,
      marketplace: this._marketplace as any,
      agentDiscovery: this._agentDiscovery as any,
      agentMessaging: this._agentMessaging as any,
      agentMessagingUnsubscribe: this._agentMessagingUnsubscribe,
      agentFeed: this._agentFeed as any,
      reputationScorer: this._reputationScorer as any,
      collaborationProtocol: this._collaborationProtocol as any,
      chatExecutor: this._chatExecutor,
      memoryBackend: this._memoryBackend,
      baseToolHandler: this._baseToolHandler,
      approvalEngine: this._approvalEngine,
      proactiveCommunicator: this._proactiveCommunicator as any,
      heartbeatScheduler: this._heartbeatScheduler as any,
      cronScheduler: this._cronScheduler as any,
      goalManager: this._goalManager as any,
      desktopExecutor: this._desktopExecutor as any,
      mcpManager: this._mcpManager as any,
      externalChannels: new Map(this._externalChannels),
      llmProviders: this._llmProviders,
      gatewayLogging: this.gateway?.config.logging,
      resolveActiveHostWorkspacePath: (config) =>
        this._resolveActiveHostWorkspacePath(config),
      handleIncomingSocialMessage: (message) =>
        this.handleIncomingSocialMessage(message),
    };
  }

  private _applyFeatureWiringContext(ctx: FeatureWiringContext): void {
    this._marketplace = ctx.marketplace as any;
    this._agentDiscovery = ctx.agentDiscovery as any;
    this._agentMessaging = ctx.agentMessaging as any;
    this._agentMessagingUnsubscribe = ctx.agentMessagingUnsubscribe;
    this._agentFeed = ctx.agentFeed as any;
    this._reputationScorer = ctx.reputationScorer as any;
    this._collaborationProtocol = ctx.collaborationProtocol as any;
    this._proactiveCommunicator = ctx.proactiveCommunicator as any;
    this._heartbeatScheduler = ctx.heartbeatScheduler as any;
    this._cronScheduler = ctx.cronScheduler as any;
    this._goalManager = ctx.goalManager as any;
    this._desktopExecutor = ctx.desktopExecutor as any;
  }

  private async wireMarketplace(config: GatewayConfig): Promise<void> {
    const ctx = this._buildFeatureWiringContext();
    await wireMarketplaceStandalone(config, ctx);
    this._applyFeatureWiringContext(ctx);
  }

  private async wireSocial(config: GatewayConfig): Promise<void> {
    const ctx = this._buildFeatureWiringContext();
    await wireSocialStandalone(config, ctx);
    this._applyFeatureWiringContext(ctx);
  }

  private async wireAutonomousFeatures(config: GatewayConfig): Promise<void> {
    const ctx = this._buildFeatureWiringContext();
    await wireAutonomousFeaturesStandalone(config, ctx);
    this._applyFeatureWiringContext(ctx);
  }

  /**
   * Hot-swap the LLM provider when config.set changes llm.* fields.
   * Re-creates the provider chain and ChatExecutor without restarting the gateway.
   */
  private handleCompaction = (sessionId: string, summary: string): void => {
    this.logger.info(
      `Context compacted for session ${sessionId} (${summary.length} chars)`,
    );
    if (this._hookDispatcher) {
      void this._hookDispatcher.dispatch("session:compact", {
        sessionId,
        summary,
        phase: "after",
        result: {
          summaryGenerated: true,
        },
        source: "budget",
      });
    }
  };

  private async resolveLlmContextWindowTokens(
    llmConfig: GatewayLLMConfig | undefined,
  ): Promise<number | undefined> {
    return resolveLlmContextWindowTokensStandalone(llmConfig, this.logger);
  }

  private async resolveProviderExecutionBudget(
    provider: LLMProvider,
  ): Promise<{
    readonly promptBudget?: ReturnType<typeof buildPromptBudgetConfig>;
    readonly sessionTokenBudget?: number;
    readonly providerProfile?: LLMProviderExecutionProfile;
  }> {
    return resolveProviderExecutionBudgetStandalone(
      provider,
      this._llmProviderConfigByInstance,
      this._llmProviderConfigCatalog,
      this._primaryLlmConfig,
      this.logger,
    );
  }

  private async refreshHostToolingProfile(params: {
    enabled: boolean;
    logging?: GatewayLoggingConfig;
  }): Promise<void> {
    if (!params.enabled) {
      this._hostToolingProfile = null;
      return;
    }

    const traceConfig = resolveTraceLoggingConfig(params.logging);
    try {
      const profile = await probeHostToolingProfile();
      this._hostToolingProfile = profile;
      const payload = {
        traceId: `daemon:host-tooling:${Date.now()}`,
        sessionId: "daemon",
        nodeVersion: profile.nodeVersion,
        npm: profile.npm
          ? {
              version: profile.npm.version,
              workspaceProtocolSupport: profile.npm.workspaceProtocolSupport,
              ...(profile.npm.workspaceProtocolEvidence
                ? {
                    workspaceProtocolEvidence:
                      profile.npm.workspaceProtocolEvidence,
                  }
                : {}),
            }
          : null,
      };
      if (traceConfig.enabled) {
        logTraceEvent(
          this.logger,
          "subagents.host_tooling_profile_resolved",
          payload,
          traceConfig.maxChars,
          { artifactPayload: payload },
        );
        return;
      }
      this.logger.info("Resolved host tooling profile", payload);
    } catch (error) {
      this._hostToolingProfile = null;
      const payload = {
        traceId: `daemon:host-tooling:${Date.now()}`,
        sessionId: "daemon",
        error: toErrorMessage(error),
      };
      if (traceConfig.enabled) {
        logTraceErrorEvent(
          this.logger,
          "subagents.host_tooling_profile_resolution_failed",
          payload,
          traceConfig.maxChars,
          { artifactPayload: payload },
        );
        return;
      }
      this.logger.warn("Failed to resolve host tooling profile", payload);
    }
  }

  private createPlannerPipelineExecutor(
    basePipelineExecutor: PipelineExecutor,
    resolvedSubAgentConfig: ResolvedSubAgentRuntimeConfig,
    childPromptBudget?: ReturnType<typeof buildPromptBudgetConfig>,
  ): DeterministicPipelineExecutor {
    return new SubAgentOrchestrator({
      fallbackExecutor: basePipelineExecutor,
      resolveSubAgentManager: () => this._subAgentManager,
      resolveLifecycleEmitter: () => this._subAgentLifecycleEmitter,
      resolveTrajectorySink: () => this._delegationTrajectorySink,
      resolveHostToolingProfile: () => this._hostToolingProfile,
      resolveHostWorkspaceRoot: () => this._hostWorkspacePath,
      childPromptBudget: childPromptBudget ?? undefined,
      resolveChildPromptBudget: async ({ requiredCapabilities }) => {
        const fallbackProvider = this._llmProviders[0];
        if (!fallbackProvider) {
          return childPromptBudget
            ? { promptBudget: childPromptBudget }
            : undefined;
        }
        const selectedProvider = this.selectSubagentProviderForTask(
          requiredCapabilities,
          fallbackProvider,
        );
        const resolvedBudget = await this.resolveProviderExecutionBudget(
          selectedProvider,
        );
        return {
          promptBudget:
            resolvedBudget.promptBudget ?? childPromptBudget ?? undefined,
          providerProfile: resolvedBudget.providerProfile,
        };
      },
      allowParallelSubtasks: resolvedSubAgentConfig.allowParallelSubtasks,
      maxParallelSubtasks: resolvedSubAgentConfig.maxConcurrent,
      defaultSubagentTimeoutMs: resolvedSubAgentConfig.defaultTimeoutMs,
      maxTotalSubagentsPerRequest:
        resolvedSubAgentConfig.maxTotalSubagentsPerRequest,
      maxCumulativeToolCallsPerRequestTree:
        resolvedSubAgentConfig.maxCumulativeToolCallsPerRequestTree,
      maxCumulativeTokensPerRequestTree:
        resolvedSubAgentConfig.maxCumulativeTokensPerRequestTree,
      maxCumulativeTokensPerRequestTreeExplicitlyConfigured:
        resolvedSubAgentConfig.maxCumulativeTokensPerRequestTreeExplicitlyConfigured,
      childToolAllowlistStrategy:
        resolvedSubAgentConfig.childToolAllowlistStrategy,
      allowedParentTools: resolvedSubAgentConfig.allowedParentTools,
      forbiddenParentTools: resolvedSubAgentConfig.forbiddenParentTools,
      fallbackBehavior: resolvedSubAgentConfig.fallbackBehavior,
      unsafeBenchmarkMode: resolvedSubAgentConfig.unsafeBenchmarkMode,
      resolveAvailableToolNames: () =>
        this.getAdvertisedToolNames(
          this._subAgentToolCatalog.map((tool) => tool.name),
        ),
    });
  }

  private async hotSwapLLMProvider(
    newConfig: GatewayConfig,
    skillInjector: SkillInjector,
    memoryRetriever: MemoryRetriever,
    learningProvider?: MemoryRetriever,
    progressProvider?: MemoryRetriever,
    pipelineExecutor?: PipelineExecutor,
  ): Promise<void> {
    try {
      this._toolRouter = new ToolRouter(
        this._llmTools,
        newConfig.llm?.toolRouting,
        this.logger,
      );
      const contextWindowTokens = await this.resolveLlmContextWindowTokens(
        newConfig.llm,
      );
      this._resolvedContextWindowTokens = contextWindowTokens;
      const sessionTokenBudget = resolveSessionTokenBudget(
        newConfig.llm,
        contextWindowTokens,
      );
      const promptBudget = buildPromptBudgetConfig(
        newConfig.llm,
        contextWindowTokens,
      );
      const resolvedSubAgentConfig = resolveSubAgentRuntimeConfig(
        newConfig.llm,
        { unsafeBenchmarkMode: this.yolo },
      );
      await this.refreshHostToolingProfile({
        enabled: resolvedSubAgentConfig.enabled,
        logging: newConfig.logging,
      });
      const defaultForegroundMaxToolRounds =
        newConfig.llm?.maxToolRounds ?? getDefaultMaxToolRounds(newConfig);
      this._defaultForegroundMaxToolRounds = defaultForegroundMaxToolRounds;
      const plannerPipelineExecutor = pipelineExecutor
        ? this.createPlannerPipelineExecutor(
            pipelineExecutor,
            resolvedSubAgentConfig,
            promptBudget,
          )
        : undefined;
      const providers = await this.createLLMProviders(
        newConfig,
        this._llmTools,
      );
      this._llmProviders = providers;
      this._chatExecutor = createChatExecutor({
        providers,
        toolHandler: this._baseToolHandler!,
        allowedTools: this.getAdvertisedToolNames(),
        skillInjector,
        memoryRetriever,
        learningProvider,
        progressProvider,
        promptBudget,
        maxToolRounds: defaultForegroundMaxToolRounds,
        sessionTokenBudget,
        onCompaction: this.handleCompaction,
        llmConfig: newConfig.llm,
        subagentConfig: resolvedSubAgentConfig,
        resolveDelegationScoreThreshold: () =>
          this.resolveDelegationScoreThreshold(),
        delegationLearning: {
          trajectorySink: this._delegationTrajectorySink ?? undefined,
          banditTuner: this._delegationBanditTuner ?? undefined,
          defaultStrategyArmId: "balanced",
        },
        resolveHostToolingProfile: () => this._hostToolingProfile,
        pipelineExecutor: plannerPipelineExecutor,
      });

      const providerNames = providers.map((p) => p.name).join(" → ") || "none";
      this.logger.info(`LLM provider hot-swapped to [${providerNames}]`);
    } catch (err) {
      this.logger.error("Failed to hot-swap LLM provider:", err);
    }
  }

  private async createHookDispatcher(
    config: GatewayConfig,
  ): Promise<HookDispatcher> {
    const hooks = new HookDispatcher({ logger: this.logger });
    for (const hook of createBuiltinHooks()) {
      hooks.on(hook);
    }
    this._hookDispatcher = hooks;
    await hooks.dispatch("gateway:startup", { config });
    return hooks;
  }

  private async createToolRegistry(
    config: GatewayConfig,
    metrics?: UnifiedTelemetryCollector,
  ): Promise<ToolRegistry> {
    const result = await createDaemonToolRegistry(config, {
      logger: this.logger,
      configPath: this.configPath,
      yolo: this.yolo,
      getBackgroundRunSupervisor: () => this._backgroundRunSupervisor,
      getMarketplace: () => this._marketplace,
      getAgentDiscovery: () => this._agentDiscovery,
      getAgentMessaging: () => this._agentMessaging,
      getAgentFeed: () => this._agentFeed,
      getCollaborationProtocol: () => this._collaborationProtocol,
    }, metrics);
    this._remoteJobManager = result.remoteJobManager;
    this._containerMCPConfigs = result.containerMCPConfigs;
    this._mcpManager = result.mcpManager;
    this._connectionManager = result.connectionManager;
    return result.registry;
  }

  private createSkillInjector(skills: DiscoveredSkill[]): SkillInjector {
    return new MarkdownSkillInjector({
      discovery: {
        getAvailable: async () => skills,
      },
      logger: this.logger,
    });
  }

  private handleIncomingSocialMessage(
    message: import("../social/messaging-types.js").AgentMessage,
  ): void {
    const sender = message.sender.toBase58();
    const recipient = message.recipient.toBase58();

    this.logger.info("Inbound social message received", {
      messageId: message.id,
      sender,
      recipient,
      mode: message.mode,
      onChain: message.onChain,
      threadId: message.threadId ?? null,
      timestamp: message.timestamp,
      content: message.content,
    });

    const deliveredSessions =
      this._webChatChannel?.pushSocialMessageToActiveSessions({
        messageId: message.id,
        sender,
        recipient,
        content: message.content,
        mode: message.mode,
        timestamp: message.timestamp,
        onChain: message.onChain,
        threadId: message.threadId ?? null,
      }) ?? 0;

    this.logger.info("Inbound social message session fanout", {
      messageId: message.id,
      deliveredSessions,
      sender,
      recipient,
      threadId: message.threadId ?? null,
    });
  }

  private createSessionManager(hooks: HookDispatcher): SessionManager {
    const mgr = new SessionManager(
      {
        scope: "per-peer",
        reset: { mode: "idle", idleMinutes: 120 },
        maxHistoryLength: 100,
        compaction: "sliding-window",
      },
      {
        compactionHook: async (payload) => {
          // Extract the compaction summary text if available
          let summary: string | undefined;
          if (payload.phase === "after" && payload.result?.summaryGenerated) {
            const session = mgr.get(payload.sessionId);
            const first = session?.history[0];
            if (first?.role === "system") {
              summary =
                typeof first.content === "string" ? first.content : undefined;
            }
          }
          await hooks.dispatch("session:compact", {
            ...payload,
            summary,
          });
        },
      },
    );
    return mgr;
  }

  private createSessionIdResolver(
    sessionMgr: SessionManager,
  ): (sessionKey: string) => string {
    return (sessionKey: string): string => {
      return sessionMgr.getOrCreate({
        channel: "webchat",
        senderId: sessionKey,
        scope: "dm",
        workspaceId: "default",
      }).id;
    };
  }

  private async resetWebSessionContext(params: {
    webSessionId: string;
    sessionMgr: SessionManager;
    resolveSessionId: (sessionKey: string) => string;
    memoryBackend: MemoryBackend;
    progressTracker?: ProgressTracker;
  }): Promise<void> {
    const {
      webSessionId,
      sessionMgr,
      resolveSessionId,
      memoryBackend,
      progressTracker,
    } = params;

    const historySessionId = resolveSessionId(webSessionId);
    sessionMgr.reset(historySessionId);
    this._chatExecutor?.resetSessionTokens(webSessionId);
    this._toolRouter?.resetSession(webSessionId);
    this._sessionModelInfo.delete(webSessionId);
    await progressTracker?.clear(webSessionId);
    await this._sessionCredentialBroker?.revoke({
      sessionId: webSessionId,
      scope: this.resolvePolicyScopeForSession({
        sessionId: webSessionId,
        runId: webSessionId,
        channel: "webchat",
      }),
      reason: "session_reset",
    });
    await this._backgroundRunSupervisor?.cancelRun(
      webSessionId,
      "Background run cancelled because the session was reset.",
    );
    await memoryBackend.deleteThread(webSessionId).catch((error) => {
      this.logger.debug("Failed to delete memory thread during session reset", {
        sessionId: webSessionId,
        error: toErrorMessage(error),
      });
    });
    await clearWebSessionRuntimeState(memoryBackend, webSessionId).catch(
      (error) => {
        this.logger.debug("Failed to delete web session runtime state", {
          sessionId: webSessionId,
          error: toErrorMessage(error),
        });
      },
    );

    await cleanupDesktopSession(webSessionId, {
      desktopManager: this._desktopManager,
      desktopBridges: this._desktopBridges,
      playwrightBridges: this._playwrightBridges,
      containerMCPBridges: this._containerMCPBridges,
      logger: this.logger,
    });
  }

  private async hydrateWebSessionContext(params: {
    webSessionId: string;
    sessionMgr: SessionManager;
    resolveSessionId: (sessionKey: string) => string;
    memoryBackend: MemoryBackend;
  }): Promise<void> {
    const { webSessionId, sessionMgr, resolveSessionId, memoryBackend } =
      params;

    const historySessionId = resolveSessionId(webSessionId);
    const session = sessionMgr.getOrCreate({
      channel: "webchat",
      senderId: webSessionId,
      scope: "dm",
      workspaceId: "default",
    });
    if (session.history.length > 0) {
      return;
    }

    const maxHistory = 100;
    const thread = await memoryBackend
      .getThread(webSessionId, maxHistory)
      .catch((error) => {
        this.logger.debug("Failed to hydrate web session from memory", {
          sessionId: webSessionId,
          error: toErrorMessage(error),
        });
        return [];
      });
    if (thread.length === 0) {
      return;
    }

    const history = thread
      .filter((entry) => entry.role !== "tool")
      .map((entry) => entryToMessage(entry));
    sessionMgr.replaceHistory(historySessionId, history);
    await hydrateWebSessionRuntimeState(memoryBackend, webSessionId, session);
  }

  private _buildCommandRegistryContext(): CommandRegistryDaemonContext {
    return {
      logger: this.logger,
      configPath: this.configPath,
      gateway: this.gateway,
      yolo: this.yolo,
      resetWebSessionContext: (params) => this.resetWebSessionContext(params),
      getWebChatChannel: () => this._webChatChannel,
      getHostWorkspacePath: () => this._hostWorkspacePath,
      getChatExecutor: () => this._chatExecutor,
      getResolvedContextWindowTokens: () => this._resolvedContextWindowTokens,
      getSystemPrompt: () => this._systemPrompt,
      getMemoryBackendName: () => this._memoryBackend?.name,
      getPolicyEngineState: () => this._policyEngine?.getState(),
      isPolicyEngineEnabled: () => !!this._policyEngine,
      isGovernanceAuditLogEnabled: () => !!this._governanceAuditLog,
      listSessionCredentialLeases: (sessionId) =>
        (this._sessionCredentialBroker?.listLeases(sessionId) ?? []) as any,
      revokeSessionCredentials: async (params) =>
        (await this._sessionCredentialBroker?.revoke({
          sessionId: params.sessionId,
          credentialId: params.credentialId,
          scope: this.resolvePolicyScopeForSession({
            sessionId: params.sessionId,
            runId: params.sessionId,
            channel: "webchat",
          }),
          reason: params.reason as any,
        })) ?? 0,
      resolvePolicyScopeForSession: (params) =>
        this.resolvePolicyScopeForSession(params),
      buildPolicySimulationPreview: (params) =>
        this.buildPolicySimulationPreview(params),
      getSubAgentRuntimeConfig: () => this._subAgentRuntimeConfig,
      getActiveDelegationAggressiveness: (config) =>
        this.getActiveDelegationAggressiveness(config),
      resolveDelegationScoreThreshold: (config) =>
        this.resolveDelegationScoreThreshold(config),
      getDelegationAggressivenessOverride: () =>
        this._delegationAggressivenessOverride,
      setDelegationAggressivenessOverride: (value) => {
        this._delegationAggressivenessOverride = value;
      },
      configureDelegationRuntimeServices: (config) =>
        this.configureDelegationRuntimeServices(config),
      getWebChatInboundHandler: () => this._webChatInboundHandler,
      getDesktopHandleBySession: (sessionId) =>
        this._desktopManager?.getHandleBySession(sessionId) as any,
      getSessionModelInfo: (sessionId) =>
        this._sessionModelInfo.get(sessionId),
      handleConfigReload: () => this.handleConfigReload(),
      getVoiceBridge: () => this._voiceBridge,
      getDesktopManager: () => this._desktopManager as any,
      getDesktopBridges: () => this._desktopBridges,
      getPlaywrightBridges: () => this._playwrightBridges,
      getContainerMCPBridges: () => this._containerMCPBridges as any,
      getGoalManager: () => this._goalManager as any,
    };
  }

  private createCommandRegistry(
    sessionMgr: SessionManager,
    resolveSessionId: (sessionKey: string) => string,
    providers: LLMProvider[],
    memoryBackend: MemoryBackend,
    registry: ToolRegistry,
    availableSkills: DiscoveredSkill[],
    skillList: WebChatSkillSummary[],
    hooks: HookDispatcher,
    baseToolHandler: ToolHandler,
    approvalEngine: ApprovalEngine | null,
    progressTracker?: ProgressTracker,
    pipelineExecutor?: PipelineExecutor,
  ): SlashCommandRegistry {
    return createDaemonCommandRegistry(
      this._buildCommandRegistryContext(),
      sessionMgr,
      resolveSessionId,
      providers,
      memoryBackend,
      registry,
      availableSkills,
      skillList,
      hooks,
      baseToolHandler,
      approvalEngine,
      progressTracker,
      pipelineExecutor,
    );
  }

  private async runProjectInitOperation(params: {
    workspaceRoot: string;
    force?: boolean;
    sessionId: string;
    channel: string;
    traceLabel: string;
    traceConfig: ResolvedTraceLoggingConfig;
    turnTraceId: string;
    sendResponse: (response: ControlResponse) => void;
    hooks?: HookDispatcher;
    baseToolHandler?: ToolHandler;
    approvalEngine?: ApprovalEngine | null;
  }) {
    const chatExecutor = this._chatExecutor;
    const baseToolHandler = params.baseToolHandler ?? this._baseToolHandler;
    const hooks = params.hooks ?? this._hookDispatcher;
    const approvalEngine = params.approvalEngine ?? this._approvalEngine;
    const systemPrompt = this._systemPrompt;
    const workspaceRoot = resolvePath(params.workspaceRoot);

    const workspaceStats = await stat(workspaceRoot).catch(() => null);
    if (!workspaceStats?.isDirectory()) {
      throw new Error(`Init workspace root is not a directory: ${workspaceRoot}`);
    }
    if (!chatExecutor) {
      throw new Error(
        "Init unavailable: no LLM provider is configured for the runtime.",
      );
    }
    if (!baseToolHandler || !hooks) {
      throw new Error(
        "Init unavailable: the runtime tool pipeline is not initialized.",
      );
    }
    if (systemPrompt.trim().length === 0) {
      throw new Error("Init unavailable: system prompt is not initialized.");
    }

    const baseSessionHandler = createSessionToolHandler({
      sessionId: params.sessionId,
      baseHandler: baseToolHandler,
      availableToolNames: [...INIT_ROUTED_TOOL_NAMES],
      routerId: params.sessionId,
      defaultWorkingDirectory: workspaceRoot,
      workspaceAliasRoot: workspaceRoot,
      scopedFilesystemRoot: workspaceRoot,
      resolveWorkspaceContext: async () => ({
        defaultWorkingDirectory: workspaceRoot,
        workspaceAliasRoot: workspaceRoot,
        scopedFilesystemRoot: workspaceRoot,
        additionalAllowedPaths: [workspaceRoot],
      }),
      send: params.sendResponse,
      hooks,
      approvalEngine: approvalEngine ?? undefined,
      delegation: this.resolveDelegationToolContext,
      credentialBroker: this._sessionCredentialBroker ?? undefined,
      resolvePolicyScope: () =>
        this.resolvePolicyScopeForSession({
          sessionId: params.sessionId,
          runId: params.sessionId,
          channel: params.channel,
        }),
    });

    const toolHandler = this.createTracedSessionToolHandler({
      traceLabel: params.traceLabel,
      traceConfig: params.traceConfig,
      turnTraceId: params.turnTraceId,
      sessionId: params.sessionId,
      baseSessionHandler,
    });

    return runModelBackedProjectGuide({
      workspaceRoot,
      force: params.force,
      sessionId: params.sessionId,
      systemPrompt,
      chatExecutor,
      toolHandler,
    });
  }

  private async handleGatewayControlMessage(params: {
    clientId: string;
    message: {
      type: string;
      payload?: unknown;
    };
    sendResponse: (response: ControlResponse) => void;
  }): Promise<boolean> {
    if (params.message.type !== "init.run") {
      return false;
    }

    const rawPayload =
      typeof params.message.payload === "object" &&
      params.message.payload !== null &&
      !Array.isArray(params.message.payload)
        ? (params.message.payload as InitRunControlPayload)
        : {};
    const workspaceRoot = resolvePath(
      typeof rawPayload.path === "string" && rawPayload.path.trim().length > 0
        ? rawPayload.path
        : this._hostWorkspacePath ?? process.cwd(),
    );
    const sessionId = `init-control:${params.clientId}:${Date.now().toString(36)}`;
    const turnTraceId = createTurnTraceId(
      createGatewayMessage({
        channel: "system",
        senderId: params.clientId,
        senderName: "Init Control",
        sessionId,
        scope: "dm",
        content: `/init ${workspaceRoot}`,
        metadata: { source: "control-init", workspaceRoot },
      }),
    );
    const result = await this.runProjectInitOperation({
      workspaceRoot,
      force: rawPayload.force === true,
      sessionId,
      channel: "control",
      traceLabel: "control.init",
      traceConfig: resolveTraceLoggingConfig(this.gateway?.config.logging),
      turnTraceId,
      sendResponse: params.sendResponse,
    });
    const payload: InitRunControlResponsePayload = {
      projectRoot: workspaceRoot,
      filePath: result.filePath,
      result: result.status,
      delegatedInvestigations: result.delegatedInvestigations,
      attempts: result.attempts,
      modelBacked: true,
      ...(result.result
        ? {
            provider: result.result.provider,
            model: result.result.model,
            usedFallback: result.result.usedFallback,
          }
        : {}),
    };
    params.sendResponse({
      type: "init.run",
      payload,
    });
    return true;
  }

  private createOptionalVoiceBridge(
    config: GatewayConfig,
    llmTools: LLMTool[],
    toolHandler: ToolHandler,
    systemPrompt: string,
    deps?: {
      getChatExecutor: () => ChatExecutor | null | undefined;
      sessionManager?: SessionManager;
      hooks?: HookDispatcher;
      approvalEngine?: ApprovalEngine;
      memoryBackend?: MemoryBackend;
      delegation?: DelegationToolCompositionResolver;
    },
    voiceSystemPrompt?: string,
  ): VoiceBridge | undefined {
    const voiceApiKey = config.voice?.apiKey || config.llm?.apiKey;
    const resolvedDeps = deps;
    const chatExecutor = resolvedDeps?.getChatExecutor?.();
    if (
      !voiceApiKey ||
      config.voice?.enabled === false ||
      !chatExecutor ||
      !resolvedDeps
    ) {
      return undefined;
    }

    // Use voice-specific prompt (no planning instruction) when available,
    // otherwise fall back to the standard system prompt.
    let voicePrompt = voiceSystemPrompt ?? systemPrompt;
    if (config.desktop?.enabled) {
      voicePrompt += "\n\n" + buildDesktopContext(config, this.yolo);
    }

    const contextWindowTokens =
      this._resolvedContextWindowTokens ?? inferContextWindowTokens(config.llm);
    const traceConfig = resolveTraceLoggingConfig(config.logging);

    return new VoiceBridge({
      apiKey: voiceApiKey,
      toolHandler,
      availableToolNames: this.getAdvertisedToolNames(
        llmTools.map((tool) => tool.function.name),
      ),
      desktopRouterFactory: this._desktopRouterFactory ?? undefined,
      systemPrompt: voicePrompt,
      voice: config.voice?.voice ?? "Ara",
      model: config.voice?.model ?? DEFAULT_GROK_MODEL,
      mode: config.voice?.mode ?? "vad",
      vadThreshold: config.voice?.vadThreshold,
      vadSilenceDurationMs: config.voice?.vadSilenceDurationMs,
      vadPrefixPaddingMs: config.voice?.vadPrefixPaddingMs,
      logger: this.logger,
      getChatExecutor: resolvedDeps.getChatExecutor,
      sessionManager: resolvedDeps.sessionManager,
      hooks: resolvedDeps.hooks,
      approvalEngine: resolvedDeps.approvalEngine,
      memoryBackend: resolvedDeps.memoryBackend,
      sessionTokenBudget: resolveSessionTokenBudget(
        config.llm,
        contextWindowTokens,
      ),
      contextWindowTokens,
      delegation: resolvedDeps.delegation,
      traceConfig,
      traceProviderPayloads:
        traceConfig.enabled && traceConfig.includeProviderPayloads,
    });
  }

  private createWebChatSignals(webChat: WebChatChannel): WebChatSignals {
    return {
      signalThinking: (sessionId: string): void => {
        webChat.pushToSession(sessionId, {
          type: "agent.status",
          payload: { phase: "thinking" },
        });
        webChat.pushToSession(sessionId, {
          type: "chat.typing",
          payload: { active: true },
        });
      },
      signalIdle: (sessionId: string): void => {
        webChat.pushToSession(sessionId, {
          type: "agent.status",
          payload: { phase: "idle" },
        });
        webChat.pushToSession(sessionId, {
          type: "chat.typing",
          payload: { active: false },
        });
      },
    };
  }

  private async appendGovernanceAuditEvent(params: {
    type: GovernanceAuditEventType;
    actor?: string;
    subject?: string;
    scope?: {
      tenantId?: string;
      projectId?: string;
      runId?: string;
      sessionId?: string;
      channel?: string;
    };
    payload?: Record<string, unknown>;
  }): Promise<void> {
    if (!this._governanceAuditLog) {
      return;
    }
    await this._governanceAuditLog.append(params);
  }

  private extractSessionPolicyContext(
    sessionId: string,
  ): { tenantId?: string; projectId?: string } | undefined {
    const metadata = this._webSessionManager?.get(sessionId)?.metadata;
    if (!metadata || typeof metadata !== "object") {
      return undefined;
    }
    const raw =
      typeof metadata.policyContext === "object" &&
      metadata.policyContext !== null
        ? (metadata.policyContext as Record<string, unknown>)
        : undefined;
    if (!raw) {
      return undefined;
    }
    const tenantId =
      typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
        ? raw.tenantId.trim()
        : undefined;
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim().length > 0
        ? raw.projectId.trim()
        : undefined;
    if (!tenantId && !projectId) {
      return undefined;
    }
    return {
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }

  private applyWebSessionPolicyContext(
    session: { metadata: Record<string, unknown> },
    msg: GatewayMessage,
  ): void {
    const raw =
      typeof msg.metadata?.policyContext === "object" &&
      msg.metadata?.policyContext !== null
        ? (msg.metadata.policyContext as Record<string, unknown>)
        : undefined;
    if (!raw) {
      return;
    }
    const tenantId =
      typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
        ? raw.tenantId.trim()
        : undefined;
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim().length > 0
        ? raw.projectId.trim()
        : undefined;
    if (!tenantId && !projectId) {
      return;
    }
    session.metadata.policyContext = {
      ...(typeof session.metadata.policyContext === "object" &&
      session.metadata.policyContext !== null
        ? (session.metadata.policyContext as Record<string, unknown>)
        : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }

  private resolvePolicyScopeForSession(params: {
    sessionId: string;
    runId?: string;
    channel?: string;
  }): {
    tenantId?: string;
    projectId?: string;
    runId?: string;
    sessionId: string;
    channel: string;
  } {
    const sessionContext = this.extractSessionPolicyContext(params.sessionId);
    const policyConfig = this.gateway?.config.policy;
    return {
      tenantId: sessionContext?.tenantId ?? policyConfig?.defaultTenantId,
      projectId: sessionContext?.projectId ?? policyConfig?.defaultProjectId,
      ...(params.runId ? { runId: params.runId } : {}),
      sessionId: params.sessionId,
      channel: params.channel ?? "webchat",
    };
  }

  private async buildPolicySimulationPreview(params: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<{
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{
        code: string;
        message: string;
      }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  }> {
    const args = params.args ?? {};
    const scope = this.resolvePolicyScopeForSession({
      sessionId: params.sessionId,
      runId: params.sessionId,
      channel: "webchat",
    });
    const action = buildToolPolicyAction({
      toolName: params.toolName,
      args,
      scope,
    });
    const policyDecision = this._policyEngine?.simulate(action) ?? {
      allowed: true,
      mode: "normal",
      violations: [],
    };
    const approvalDecision = this._approvalEngine?.simulate(
      params.toolName,
      args,
      params.sessionId,
      {
        message: `Policy simulation preview for ${params.toolName}`,
      },
    ) ?? {
      required: false,
      elevated: false,
      denied: false,
    };

    return {
      toolName: params.toolName,
      sessionId: params.sessionId,
      policy: {
        allowed: policyDecision.allowed,
        mode: policyDecision.mode,
        violations: policyDecision.violations.map((violation) => ({
          code: violation.code,
          message: violation.message,
        })),
      },
      approval: {
        required: approvalDecision.required,
        elevated: approvalDecision.elevated,
        denied: approvalDecision.denied,
        ...(approvalDecision.requestPreview
          ? {
              requestPreview: {
                message: approvalDecision.requestPreview.message,
                deadlineAt: approvalDecision.requestPreview.deadlineAt,
                allowDelegatedResolution:
                  approvalDecision.requestPreview.allowDelegatedResolution,
                ...(approvalDecision.requestPreview.approverGroup
                  ? {
                      approverGroup:
                        approvalDecision.requestPreview.approverGroup,
                    }
                  : {}),
                ...(approvalDecision.requestPreview.requiredApproverRoles &&
                approvalDecision.requestPreview.requiredApproverRoles.length > 0
                  ? {
                      requiredApproverRoles:
                        approvalDecision.requestPreview.requiredApproverRoles,
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  private parseApprovalDisposition(
    value: string | undefined,
  ): "yes" | "no" | "always" | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "yes" ||
      normalized === "no" ||
      normalized === "always"
    ) {
      return normalized;
    }
    return null;
  }

  private formatApprovalRequestMessage(
    requestId: string,
    action: string,
    message: string,
  ): string {
    const detail =
      message.trim().length > 0
        ? message.trim()
        : `Approval required for ${action}`;
    return (
      `${detail}\n` +
      `Request ID: ${requestId}\n` +
      `Reply: approve ${requestId} yes\n` +
      `Or: approve ${requestId} no\n` +
      `Or: approve ${requestId} always`
    );
  }

  private formatApprovalEscalationMessage(params: {
    requestId: string;
    action: string;
    deadlineAt: number;
    message?: string;
    approverGroup?: string;
    requiredApproverRoles?: readonly string[];
  }): string {
    const detail = params.message?.trim().length
      ? params.message.trim()
      : `Approval escalated for ${params.action}`;
    const roleSummary =
      params.requiredApproverRoles && params.requiredApproverRoles.length > 0
        ? `\nRequired roles: ${params.requiredApproverRoles.join(", ")}`
        : "";
    const groupSummary = params.approverGroup
      ? `\nApprover group: ${params.approverGroup}`
      : "";
    return (
      `${detail}\n` +
      `Escalated request ID: ${params.requestId}\n` +
      `Deadline: ${new Date(params.deadlineAt).toISOString()}` +
      `${groupSummary}` +
      `${roleSummary}\n` +
      `Reply: approve ${params.requestId} yes\n` +
      `Or: approve ${params.requestId} no\n` +
      `Or: approve ${params.requestId} always`
    );
  }

  private registerTextApprovalDispatcher(
    sessionId: string,
    channelName: string,
    send: (content: string) => Promise<void>,
  ): () => void {
    this._textApprovalDispatchBySession.set(sessionId, { channelName, send });
    return () => {
      const existing = this._textApprovalDispatchBySession.get(sessionId);
      if (!existing) return;
      if (existing.channelName !== channelName || existing.send !== send)
        return;
      this._textApprovalDispatchBySession.delete(sessionId);
    };
  }

  private routeSubagentControlResponseToParent(params: {
    response: ControlResponse;
    parentSessionId: string;
    subagentSessionId: string;
  }): void {
    const { response, parentSessionId, subagentSessionId } = params;
    if (response.type !== "approval.request") return;

    const payload =
      typeof response.payload === "object" && response.payload !== null
        ? (response.payload as Record<string, unknown>)
        : {};
    const scopedResponse: ControlResponse = {
      ...response,
      payload: {
        ...payload,
        parentSessionId,
        subagentSessionId,
      },
    };

    this._webChatChannel?.pushToSession(parentSessionId, scopedResponse);
    const textDispatch =
      this._textApprovalDispatchBySession.get(parentSessionId);
    if (!textDispatch) return;
    this.forwardControlToTextChannel({
      response: scopedResponse,
      sessionId: parentSessionId,
      channelName: textDispatch.channelName,
      send: textDispatch.send,
    });
  }

  private forwardControlToTextChannel(params: {
    response: ControlResponse;
    sessionId: string;
    channelName: string;
    send: (content: string) => Promise<void>;
  }): void {
    const { response, sessionId, channelName, send } = params;
    if (
      response.type !== "approval.request" &&
      response.type !== "approval.escalated"
    ) {
      return;
    }
    const payload =
      typeof response.payload === "object" && response.payload !== null
        ? (response.payload as Record<string, unknown>)
        : {};
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : "";
    const action =
      typeof payload.action === "string" ? payload.action : "tool call";
    if (!requestId) return;
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const approverGroup =
      typeof payload.approverGroup === "string"
        ? payload.approverGroup
        : undefined;
    const requiredApproverRoles = Array.isArray(payload.requiredApproverRoles)
      ? payload.requiredApproverRoles.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined;
    const content =
      response.type === "approval.escalated"
        ? this.formatApprovalEscalationMessage({
            requestId,
            action,
            deadlineAt:
              typeof payload.deadlineAt === "number"
                ? payload.deadlineAt
                : Date.now(),
            message,
            approverGroup,
            requiredApproverRoles,
          })
        : this.formatApprovalRequestMessage(
            requestId,
            action,
            message ?? `Approval required for ${action}`,
          );

    void send(content).catch((error) => {
      this.logger.warn("Failed to send approval prompt to text channel", {
        channel: channelName,
        sessionId,
        requestId,
        error: toErrorMessage(error),
      });
    });
  }

  private pushApprovalEscalationNotice(params: {
    sessionId: string;
    request: {
      id: string;
      toolName: string;
      message: string;
      parentSessionId?: string;
      subagentSessionId?: string;
    };
    escalation: {
      escalatedAt: number;
      deadlineAt: number;
      escalateToSessionId: string;
      approverGroup?: string;
      requiredApproverRoles?: readonly string[];
    };
  }): void {
    const { sessionId, request, escalation } = params;
    const response: ControlResponse = {
      type: "approval.escalated",
      payload: {
        requestId: request.id,
        action: request.toolName,
        message: request.message,
        escalatedAt: escalation.escalatedAt,
        deadlineAt: escalation.deadlineAt,
        escalateToSessionId: escalation.escalateToSessionId,
        ...(escalation.approverGroup
          ? { approverGroup: escalation.approverGroup }
          : {}),
        ...(escalation.requiredApproverRoles &&
        escalation.requiredApproverRoles.length > 0
          ? { requiredApproverRoles: escalation.requiredApproverRoles }
          : {}),
        ...(request.parentSessionId
          ? { parentSessionId: request.parentSessionId }
          : {}),
        ...(request.subagentSessionId
          ? { subagentSessionId: request.subagentSessionId }
          : {}),
      },
    };
    this._webChatChannel?.pushToSession(sessionId, response);
    this._webChatChannel?.broadcastEvent("approval.escalated", {
      sessionId,
      requestId: request.id,
      toolName: request.toolName,
      escalatedAt: escalation.escalatedAt,
      deadlineAt: escalation.deadlineAt,
      escalateToSessionId: escalation.escalateToSessionId,
      ...(escalation.approverGroup
        ? { approverGroup: escalation.approverGroup }
        : {}),
      ...(escalation.requiredApproverRoles &&
      escalation.requiredApproverRoles.length > 0
        ? { requiredApproverRoles: escalation.requiredApproverRoles }
        : {}),
    });

    const textDispatch = this._textApprovalDispatchBySession.get(sessionId);
    if (!textDispatch) {
      return;
    }
    this.forwardControlToTextChannel({
      response,
      sessionId,
      channelName: textDispatch.channelName,
      send: textDispatch.send,
    });
  }

  private async handleTextChannelApprovalCommand(params: {
    msg: GatewayMessage;
    send: (content: string) => Promise<void>;
  }): Promise<boolean> {
    const { msg, send } = params;
    const text = msg.content.trim();
    const rawParts = text.split(/\s+/);
    const command = rawParts[0]?.toLowerCase();
    if (command !== "/approve" && command !== "approve") return false;

    const approvalEngine = this._approvalEngine;
    if (!approvalEngine) {
      await send("Approvals are not configured.");
      return true;
    }

    const parts = ["approve", ...rawParts.slice(1)];
    if (parts.length === 2 && parts[1]?.toLowerCase() === "list") {
      const pending = approvalEngine
        .getPending()
        .filter(
          (entry) =>
            entry.sessionId === msg.sessionId ||
            entry.parentSessionId === msg.sessionId,
        );
      if (pending.length === 0) {
        await send("No pending approvals for this session.");
        return true;
      }
      const lines = pending.slice(0, 10).map((entry) => {
        const ageSeconds = Math.max(
          0,
          Math.floor((Date.now() - entry.createdAt) / 1000),
        );
        const delegatedSuffix =
          entry.parentSessionId && entry.subagentSessionId
            ? ` | delegated:${entry.subagentSessionId}`
            : "";
        return `- ${entry.id} | ${entry.toolName} | ${ageSeconds}s${delegatedSuffix}`;
      });
      const suffix =
        pending.length > 10 ? `\n...and ${pending.length - 10} more.` : "";
      await send(`Pending approvals:\n${lines.join("\n")}${suffix}`);
      return true;
    }

    let requestId: string | undefined;
    let disposition: "yes" | "no" | "always" | null = null;
    if (parts.length === 3) {
      disposition = this.parseApprovalDisposition(parts[2]);
      if (disposition) {
        requestId = parts[1];
      } else {
        disposition = this.parseApprovalDisposition(parts[1]);
        if (disposition) requestId = parts[2];
      }
    }

    if (!requestId || !disposition) {
      await send(
        "Usage:\n" + "approve list\n" + "approve <requestId> <yes|no|always>",
      );
      return true;
    }

    const request = approvalEngine
      .getPending()
      .find((entry) => entry.id === requestId);
    if (!request) {
      await send(`No pending approval found for request ID: ${requestId}`);
      return true;
    }
    if (
      request.sessionId !== msg.sessionId &&
      request.parentSessionId !== msg.sessionId
    ) {
      await send(
        `Request ${requestId} belongs to a different session and cannot be resolved here.`,
      );
      return true;
    }

    const resolverRoles = Array.isArray(msg.metadata?.roles)
      ? msg.metadata.roles.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined;
    const resolved = await approvalEngine.resolve(requestId, {
      requestId,
      disposition,
      approvedBy: msg.senderId,
      resolver: {
        actorId: msg.senderId,
        sessionId: msg.sessionId,
        channel: msg.channel,
        ...(resolverRoles && resolverRoles.length > 0
          ? { roles: resolverRoles }
          : {}),
        resolvedAt: Date.now(),
      },
    });
    if (!resolved) {
      await send(
        `Approval ${requestId} requires a different approver role or identity.`,
      );
      return true;
    }
    await send(
      `Recorded approval: ${disposition} for ${request.toolName} (${requestId}).`,
    );
    return true;
  }

  private buildToolRoutingDecision(
    sessionId: string,
    messageText: string,
    history: readonly LLMMessage[],
  ): ToolRoutingDecision | undefined {
    if (!this._toolRouter) return undefined;
    try {
      const decision = this._toolRouter.route({
        sessionId,
        messageText,
        history,
      });
      return this.maybeAugmentToolRoutingDecisionWithNativeSearch(
        decision,
        messageText,
        history,
      );
    } catch (error) {
      this.logger.warn?.(
        "Tool routing decision failed; falling back to full toolset",
        {
          sessionId,
          error: toErrorMessage(error),
        },
      );
      return undefined;
    }
  }

  private recordToolRoutingOutcome(
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ): void {
    if (!this._toolRouter) return;
    this._toolRouter.recordOutcome(sessionId, summary);
  }

  private resolveLifecycleParentSessionId(
    event: SubAgentLifecycleEvent,
  ): string {
    if (event.parentSessionId && event.parentSessionId.length > 0) {
      return event.parentSessionId;
    }
    if (event.sessionId.startsWith("subagent:")) {
      const subAgentInfo = this._subAgentManager?.getInfo(event.sessionId);
      if (subAgentInfo?.parentSessionId) {
        return subAgentInfo.parentSessionId;
      }
    }
    return event.sessionId;
  }

  private getAdvertisedToolNames(
    toolNames: readonly string[] = this._llmTools.map(
      (tool) => tool.function.name,
    ),
  ): readonly string[] {
    return Array.from(
      new Set([
        ...toolNames,
        ...getProviderNativeAdvertisedToolNames(this._primaryLlmConfig),
      ]),
    );
  }

  private maybeAugmentToolRoutingDecisionWithNativeSearch(
    decision: ToolRoutingDecision,
    messageText: string,
    history: readonly LLMMessage[],
  ): ToolRoutingDecision {
    const nativeSearch = getProviderNativeWebSearchRoutingDecision({
      llmConfig: this._primaryLlmConfig,
      messageText,
      history,
    });
    if (!nativeSearch) return decision;

    const routedToolNames = Array.from(
      new Set([...decision.routedToolNames, nativeSearch.toolName]),
    );
    const expandedToolNames = Array.from(
      new Set([...decision.expandedToolNames, nativeSearch.toolName]),
    );
    if (
      routedToolNames.length === decision.routedToolNames.length &&
      expandedToolNames.length === decision.expandedToolNames.length
    ) {
      return decision;
    }

    const routedAdded =
      routedToolNames.length > decision.routedToolNames.length
        ? nativeSearch.schemaChars
        : 0;
    const expandedAdded =
      expandedToolNames.length > decision.expandedToolNames.length
        ? nativeSearch.schemaChars
        : 0;
    const schemaCharsFull =
      decision.diagnostics.schemaCharsFull + nativeSearch.schemaChars;
    const schemaCharsRouted =
      decision.diagnostics.schemaCharsRouted + routedAdded;
    const schemaCharsExpanded =
      decision.diagnostics.schemaCharsExpanded + expandedAdded;

    return {
      routedToolNames,
      expandedToolNames,
      diagnostics: {
        ...decision.diagnostics,
        totalToolCount: decision.diagnostics.totalToolCount + 1,
        routedToolCount: routedToolNames.length,
        expandedToolCount: expandedToolNames.length,
        schemaCharsFull,
        schemaCharsRouted,
        schemaCharsExpanded,
        schemaCharsSaved: Math.max(0, schemaCharsFull - schemaCharsRouted),
      },
    };
  }

  private relaySubAgentLifecycleEvent(
    webChat: WebChatChannel,
    event: SubAgentLifecycleEvent,
  ): void {
    const parentSessionId = this.resolveLifecycleParentSessionId(event);
    const previousContext =
      this._latestDelegationSurfaceContextBySession.get(parentSessionId);
    const payloadWithContext =
      event.type === "subagents.synthesized"
        ? {
            ...(event.payload ?? {}),
            ...(typeof event.payload?.objective === "string" &&
            event.payload.objective.trim().length > 0
              ? {}
              : previousContext?.objective
                ? { objective: previousContext.objective }
                : {}),
            ...(typeof event.payload?.stepName === "string" &&
            event.payload.stepName.trim().length > 0
              ? {}
              : previousContext?.stepName
                ? { stepName: previousContext.stepName }
                : {}),
          }
        : event.payload;
    const subagentSessionId =
      event.subagentSessionId ??
      previousContext?.subagentSessionId ??
      (event.sessionId.startsWith("subagent:") ? event.sessionId : undefined);
    const effectiveToolName =
      event.toolName ?? previousContext?.toolName;
    const sanitizedData = sanitizeLifecyclePayloadData(payloadWithContext);
    const parentTraceId = this._activeSessionTraceIds.get(parentSessionId);
    const traceId = buildSubagentTraceId(parentTraceId, event);
    if (parentTraceId && event.type !== "subagents.synthesized") {
      this._subagentActivityTraceBySession.set(parentSessionId, parentTraceId);
    }
    if (event.type !== "subagents.synthesized") {
      const nextContext = {
        objective:
          typeof payloadWithContext?.objective === "string" &&
          payloadWithContext.objective.trim().length > 0
            ? payloadWithContext.objective.trim()
            : previousContext?.objective,
        stepName:
          typeof payloadWithContext?.stepName === "string" &&
          payloadWithContext.stepName.trim().length > 0
            ? payloadWithContext.stepName.trim()
            : previousContext?.stepName,
        subagentSessionId,
        toolName: effectiveToolName,
      };
      if (
        nextContext.objective ||
        nextContext.stepName ||
        nextContext.subagentSessionId ||
        nextContext.toolName
      ) {
        this._latestDelegationSurfaceContextBySession.set(
          parentSessionId,
          nextContext,
        );
      }
    }

    webChat.pushToSession(parentSessionId, {
      type: event.type,
      payload: {
        sessionId: parentSessionId,
        parentSessionId,
        ...(subagentSessionId ? { subagentSessionId } : {}),
        ...(effectiveToolName ? { toolName: effectiveToolName } : {}),
        timestamp: event.timestamp,
        ...(Object.keys(sanitizedData).length > 0
          ? { data: sanitizedData }
          : {}),
        ...(traceId ? { traceId } : {}),
        ...(parentTraceId ? { parentTraceId } : {}),
      },
    });

    const activityData: Record<string, unknown> = {
      sessionId: parentSessionId,
      parentSessionId,
      ...(subagentSessionId ? { subagentSessionId } : {}),
      ...(effectiveToolName ? { toolName: effectiveToolName } : {}),
      timestamp: event.timestamp,
    };
    for (const [key, value] of Object.entries(sanitizedData)) {
      if (Object.prototype.hasOwnProperty.call(activityData, key)) continue;
      activityData[key] = value;
    }

    const traceConfig = resolveTraceLoggingConfig(
      this.gateway?.config.logging,
    );
    if (traceConfig.enabled) {
      logTraceEvent(
        this.logger,
        event.type,
        {
          ...activityData,
          ...(traceId ? { traceId } : {}),
          ...(parentTraceId ? { parentTraceId } : {}),
        },
        traceConfig.maxChars,
      );
    }

    webChat.broadcastEvent(event.type, {
      ...activityData,
      ...(traceId ? { traceId } : {}),
      ...(parentTraceId ? { parentTraceId } : {}),
    });
    if (event.type === "subagents.synthesized") {
      this._latestDelegationSurfaceContextBySession.delete(parentSessionId);
    }
  }

  private attachSubAgentLifecycleBridge(webChat: WebChatChannel): void {
    this._subAgentLifecycleUnsubscribe?.();
    this._subAgentLifecycleUnsubscribe = null;
    const lifecycleEmitter = this._subAgentLifecycleEmitter;
    if (!lifecycleEmitter) return;
    this._subAgentLifecycleUnsubscribe = lifecycleEmitter.on((event) => {
      this.relaySubAgentLifecycleEvent(webChat, event);
    });
  }

  private detachSubAgentLifecycleBridge(): void {
    this._subAgentLifecycleUnsubscribe?.();
    this._subAgentLifecycleUnsubscribe = null;
  }

  private createWebChatMessageHandler(
    params: WebChatMessageHandlerDeps,
  ): (msg: GatewayMessage) => Promise<void> {
    return async (msg: GatewayMessage): Promise<void> =>
      this.handleWebChatInboundMessage(msg, params);
  }

  private createTracedSessionToolHandler(params: {
    traceLabel: string;
    traceConfig: ResolvedTraceLoggingConfig;
    turnTraceId: string;
    sessionId: string;
    baseSessionHandler: ToolHandler;
    normalizeArgs?: (
      name: string,
      normalizedArgs: Record<string, unknown>,
    ) => Record<string, unknown>;
    beforeHandle?: (
      name: string,
      normalizedArgs: Record<string, unknown>,
    ) => string | Promise<string | undefined> | undefined;
  }): ToolHandler {
    const {
      traceLabel,
      traceConfig,
      turnTraceId,
      sessionId,
      baseSessionHandler,
      normalizeArgs,
      beforeHandle,
    } = params;

    return async (name, args) => {
      const normalizedArgs = normalizeToolCallArguments(name, args);
      const turnArgs = normalizeArgs?.(name, normalizedArgs) ?? normalizedArgs;
      const interceptedResult = await this.resolvePreToolExecutionBlock({
        toolName: name,
        args: turnArgs,
        beforeHandle,
      });
      if (typeof interceptedResult === "string") {
        if (traceConfig.enabled) {
          logTraceEvent(
            this.logger,
            `${traceLabel}.tool.intercepted`,
            {
              traceId: turnTraceId,
              sessionId,
              tool: name,
              ...(traceConfig.includeToolArgs
                ? { args: summarizeTraceValue(turnArgs, traceConfig.maxChars) }
                : {}),
              ...(traceConfig.includeToolResults
                ? {
                    result: summarizeToolResultForTrace(
                      interceptedResult,
                      traceConfig.maxChars,
                    ),
                  }
                : {}),
            },
            traceConfig.maxChars,
          );
        }
        return interceptedResult;
      }

      if (traceConfig.enabled) {
        logTraceEvent(
          this.logger,
          `${traceLabel}.tool.call`,
          {
            traceId: turnTraceId,
            sessionId,
            tool: name,
            ...(traceConfig.includeToolArgs
              ? { args: summarizeTraceValue(turnArgs, traceConfig.maxChars) }
              : {}),
          },
          traceConfig.maxChars,
        );
      }

      const startedAt = Date.now();
      try {
        const result = await baseSessionHandler(name, turnArgs);
        if (traceConfig.enabled) {
          logTraceEvent(
            this.logger,
            `${traceLabel}.tool.result`,
            {
              traceId: turnTraceId,
              sessionId,
              tool: name,
              durationMs: Date.now() - startedAt,
              ...(traceConfig.includeToolResults
                ? {
                    result: summarizeToolResultForTrace(
                      result,
                      traceConfig.maxChars,
                    ),
                  }
                : {}),
            },
            traceConfig.maxChars,
          );
        }
        return result;
      } catch (error) {
        if (traceConfig.enabled) {
          logTraceErrorEvent(
            this.logger,
            `${traceLabel}.tool.error`,
            {
              traceId: turnTraceId,
              sessionId,
              tool: name,
              durationMs: Date.now() - startedAt,
              error: toErrorMessage(error),
            },
            traceConfig.maxChars,
          );
        }
        throw error;
      }
    };
  }

  private async resolvePreToolExecutionBlock(params: {
    toolName: string;
    args: Record<string, unknown>;
    beforeHandle?: (
      name: string,
      normalizedArgs: Record<string, unknown>,
    ) => string | Promise<string | undefined> | undefined;
  }): Promise<string | undefined> {
    const { toolName, args, beforeHandle } = params;
    const delegatedBlock = await beforeHandle?.(toolName, args);
    if (typeof delegatedBlock === "string") {
      return delegatedBlock;
    }
    return this.resolveHostToolingManifestWriteBlock(toolName, args);
  }

  private async resolveHostToolingManifestWriteBlock(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    const npmProfile = this._hostToolingProfile?.npm;
    if (npmProfile?.workspaceProtocolSupport !== "unsupported") {
      return undefined;
    }
    if (toolName !== "system.writeFile" && toolName !== "system.appendFile") {
      return undefined;
    }
    const rawPath =
      typeof args.path === "string" ? args.path.trim() : "";
    if (rawPath.length === 0 || basename(rawPath) !== "package.json") {
      return undefined;
    }
    if (toolName === "system.writeFile" && args.encoding === "base64") {
      return undefined;
    }
    const incomingContent =
      typeof args.content === "string" ? args.content : undefined;
    if (typeof incomingContent !== "string" || incomingContent.length === 0) {
      return undefined;
    }

    const cwd =
      typeof args.cwd === "string" && args.cwd.trim().length > 0
        ? args.cwd.trim()
        : undefined;
    const manifestPath = cwd ? resolvePath(cwd, rawPath) : rawPath;

    let manifestContent = incomingContent;
    if (toolName === "system.appendFile") {
      try {
        manifestContent =
          (await readFile(manifestPath, "utf-8")) + incomingContent;
      } catch {
        manifestContent = incomingContent;
      }
    }

    const blockedSpecifiers =
      findPackageManifestWorkspaceProtocolSpecifiers(manifestContent);
    if (blockedSpecifiers.length === 0) {
      return undefined;
    }

    const formattedSpecifiers = blockedSpecifiers
      .slice(0, 3)
      .map((specifier) =>
        specifier.packageName
          ? `${specifier.dependencyField}.${specifier.packageName}=${specifier.specifier}`
          : specifier.specifier,
      )
      .join(", ");
    const evidence =
      typeof npmProfile.workspaceProtocolEvidence === "string" &&
      npmProfile.workspaceProtocolEvidence.trim().length > 0
        ? ` Probe evidence: ${npmProfile.workspaceProtocolEvidence.trim()}.`
        : "";

    return JSON.stringify({
      error: {
        code: "host_tooling_workspace_protocol_unsupported",
        message:
          `Host npm ${npmProfile.version} does not support local \`workspace:\` dependency specifiers.` +
          `${evidence} ` +
          `Do not write ${formattedSpecifiers} into ${manifestPath}. ` +
          "Use a host-compatible local dependency reference such as `file:../core`, then rerun `npm install`.",
      },
      manifestPath,
      blockedSpecifiers,
      hostTooling: {
        npmVersion: npmProfile.version,
        workspaceProtocolSupport: npmProfile.workspaceProtocolSupport,
        ...(npmProfile.workspaceProtocolEvidence
          ? { workspaceProtocolEvidence: npmProfile.workspaceProtocolEvidence }
          : {}),
      },
    });
  }

  private createWebChatSessionToolHandler(params: {
    sessionId: string;
    webChat: WebChatChannel;
    hooks: HookDispatcher;
    approvalEngine?: ApprovalEngine;
    baseToolHandler: ToolHandler;
    traceLabel: string;
    traceConfig: ResolvedTraceLoggingConfig;
    traceId: string;
    normalizeArgs?: (
      toolName: string,
      normalizedArgs: Record<string, unknown>,
    ) => Record<string, unknown>;
    hookMetadata?: Record<string, unknown>;
    beforeHandle?: (
      toolName: string,
      args: Record<string, unknown>,
    ) => string | undefined;
    onToolEnd?: (
      toolName: string,
      args: Record<string, unknown>,
      result: string,
      durationMs: number,
      toolCallId: string,
    ) => void;
  }): ToolHandler {
    const {
      sessionId,
      webChat,
      hooks,
      approvalEngine,
      baseToolHandler,
      traceLabel,
      traceConfig,
      traceId,
      normalizeArgs,
      hookMetadata,
      beforeHandle,
      onToolEnd,
    } = params;
    const inFlightToolArgs = new Map<string, Record<string, unknown>>();

    const baseSessionHandler = createSessionToolHandler({
      sessionId,
      baseHandler: baseToolHandler,
      availableToolNames: this.getAdvertisedToolNames(),
      defaultWorkingDirectory: this._hostWorkspacePath ?? undefined,
      workspaceAliasRoot: this._hostWorkspacePath ?? undefined,
      scopedFilesystemRoot: this._hostWorkspacePath ?? undefined,
      resolveWorkspaceContext: async () => {
        if (this._hostWorkspacePathPinned) {
          return {
            defaultWorkingDirectory: this._hostWorkspacePath ?? undefined,
            workspaceAliasRoot: this._hostWorkspacePath ?? undefined,
            scopedFilesystemRoot: this._hostWorkspacePath ?? undefined,
          };
        }

        const workspaceRoot =
          (typeof webChat.loadSessionWorkspaceRoot === "function"
            ? await webChat.loadSessionWorkspaceRoot(sessionId)
            : undefined) ??
          this._hostWorkspacePath ??
          undefined;
        if (!workspaceRoot) {
          return undefined;
        }
        return {
          defaultWorkingDirectory: workspaceRoot,
          workspaceAliasRoot: workspaceRoot,
          scopedFilesystemRoot: workspaceRoot,
          additionalAllowedPaths: [workspaceRoot],
        };
      },
      desktopRouterFactory: this._desktopRouterFactory ?? undefined,
      routerId: sessionId,
      send: (m) => webChat.pushToSession(sessionId, m),
      hooks,
      approvalEngine,
      credentialBroker: this._sessionCredentialBroker ?? undefined,
      resolvePolicyScope: () =>
        this.resolvePolicyScopeForSession({
          sessionId,
          runId: sessionId,
          channel: "webchat",
        }),
      hookMetadata,
      delegation: this.resolveDelegationToolContext,
      onToolStart: (name, args, toolCallId) => {
        inFlightToolArgs.set(toolCallId, args);
        webChat.pushToSession(sessionId, {
          type: "agent.status",
          payload: { phase: "tool_call", detail: `Calling ${name}` },
        });
      },
      onToolEnd: (toolName, result, durationMs, toolCallId) => {
        const completedArgs = inFlightToolArgs.get(toolCallId) ?? {};
        inFlightToolArgs.delete(toolCallId);
        webChat.broadcastEvent("tool.executed", {
          toolName,
          durationMs,
          sessionId,
        });
        webChat.pushToSession(sessionId, {
          type: "agent.status",
          payload: { phase: "generating" },
        });
        onToolEnd?.(toolName, completedArgs, result, durationMs, toolCallId);
      },
    });

    return this.createTracedSessionToolHandler({
      traceLabel,
      traceConfig,
      turnTraceId: traceId,
      sessionId,
      baseSessionHandler,
      normalizeArgs,
      beforeHandle,
    });
  }

  private createTextChannelSessionToolHandler(params: {
    sessionId: string;
    channelName: string;
    send: (content: string) => Promise<void>;
    traceConfig: ResolvedTraceLoggingConfig;
    traceId: string;
  }): ToolHandler {
    const { sessionId, channelName, send, traceConfig, traceId } = params;

    const baseSessionHandler = createSessionToolHandler({
      sessionId,
      baseHandler: this._baseToolHandler!,
      availableToolNames: this.getAdvertisedToolNames(),
      defaultWorkingDirectory: this._hostWorkspacePath ?? undefined,
      workspaceAliasRoot: this._hostWorkspacePath ?? undefined,
      desktopRouterFactory: this._desktopRouterFactory ?? undefined,
      routerId: sessionId,
      send: (response) => {
        this.forwardControlToTextChannel({
          response,
          sessionId,
          channelName,
          send,
        });
      },
      hooks: this._hookDispatcher ?? undefined,
      approvalEngine: this._approvalEngine ?? undefined,
      delegation: this.resolveDelegationToolContext,
      credentialBroker: this._sessionCredentialBroker ?? undefined,
      resolvePolicyScope: () =>
        this.resolvePolicyScopeForSession({
          sessionId,
          runId: sessionId,
          channel: channelName,
        }),
    });

    return this.createTracedSessionToolHandler({
      traceLabel: channelName,
      traceConfig,
      turnTraceId: traceId,
      sessionId,
      baseSessionHandler,
    });
  }

  private async handleWebChatInboundMessage(
    msg: GatewayMessage,
    params: WebChatMessageHandlerDeps,
  ): Promise<void> {
    const {
      webChat,
      commandRegistry,
      getChatExecutor,
      getLoggingConfig,
      hooks,
      sessionMgr,
      getSystemPrompt,
      baseToolHandler,
      approvalEngine,
      memoryBackend,
      signals,
      sessionTokenBudget,
      contextWindowTokens,
    } = params;
    const hasAttachments = msg.attachments && msg.attachments.length > 0;
    if (!msg.content.trim() && !hasAttachments) {
      return;
    }
    const turnTraceId = createTurnTraceId(msg);
    const session = sessionMgr.getOrCreate({
      channel: "webchat",
      senderId: msg.sessionId,
      scope: "dm",
      workspaceId: "default",
    });
    this.applyWebSessionPolicyContext(session, msg);

    const traceConfig = resolveTraceLoggingConfig(getLoggingConfig());
    if (traceConfig.enabled) {
      logTraceEvent(
        this.logger,
        "webchat.inbound",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          message: summarizeGatewayMessageForTrace(msg, traceConfig.maxChars),
        },
        traceConfig.maxChars,
      );
    }

    const reply = async (content: string): Promise<void> => {
      if (traceConfig.enabled) {
        logTraceEvent(
          this.logger,
          "webchat.command.reply",
          {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            content: truncateToolLogText(content, traceConfig.maxChars),
          },
          traceConfig.maxChars,
        );
      }
      await webChat.send({ sessionId: msg.sessionId, content });
    };
    const handled = await commandRegistry.dispatch(
      msg.content,
      msg.sessionId,
      msg.senderId,
      "webchat",
      reply,
    );
    if (handled) {
      if (traceConfig.enabled) {
        logTraceEvent(
          this.logger,
          "webchat.command.handled",
          {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            command: truncateToolLogText(
              msg.content.trim(),
              traceConfig.maxChars,
            ),
          },
          traceConfig.maxChars,
        );
      }
      return;
    }

    // Resolve model/provider questions from runtime metadata instead of letting
    // the model hallucinate or mirror static configuration text.
    if (MODEL_QUERY_RE.test(msg.content)) {
      const last = this._sessionModelInfo.get(msg.sessionId);
      if (last) {
        await webChat.send({
          sessionId: msg.sessionId,
          content:
            `Last completion model: ${last.model} ` +
            `(provider: ${last.provider}${last.usedFallback ? ", fallback used" : ""})`,
        });
        return;
      }

      const configuredProvider = this.gateway?.config.llm?.provider ?? "none";
      const configuredModel =
        normalizeGrokModel(this.gateway?.config.llm?.model) ??
        (configuredProvider === "grok" ? DEFAULT_GROK_MODEL : "unknown");
      await webChat.send({
        sessionId: msg.sessionId,
        content:
          `No completion recorded yet for this session. ` +
          `Configured primary is ${configuredProvider}:${configuredModel}.`,
      });
      return;
    }

    const chatExecutor = getChatExecutor();
    if (!chatExecutor) {
      await webChat.send({
        sessionId: msg.sessionId,
        content:
          "No LLM provider configured. Add an `llm` section to ~/.agenc/config.json.",
      });
      return;
    }

    const inboundResult = await hooks.dispatch("message:inbound", {
      sessionId: msg.sessionId,
      content: msg.content,
      senderId: msg.senderId,
    });
    if (!inboundResult.completed) {
      return;
    }

    webChat.broadcastEvent("chat.inbound", { sessionId: msg.sessionId });
    const isDoomStopTurn = isDoomStopRequest(msg.content);
    const doomTurnContract = inferDoomTurnContract(msg.content);

    const activeBackgroundRun =
      this._backgroundRunSupervisor?.getStatusSnapshot(msg.sessionId);
    if (activeBackgroundRun) {
      if (isBackgroundRunStopRequest(msg.content)) {
        await this._backgroundRunSupervisor?.cancelRun(
          msg.sessionId,
          "Stopped the active background run for this session.",
        );
        if (!isDoomStopTurn) return;
      }
      if (isBackgroundRunPauseRequest(msg.content)) {
        const paused = await this._backgroundRunSupervisor?.pauseRun(
          msg.sessionId,
        );
        if (paused) return;
      }
      if (isBackgroundRunResumeRequest(msg.content)) {
        const resumed = await this._backgroundRunSupervisor?.resumeRun(
          msg.sessionId,
        );
        if (resumed) return;
      }
      if (isBackgroundRunStatusRequest(msg.content)) {
        await webChat.send({
          sessionId: msg.sessionId,
          content: formatBackgroundRunStatus(activeBackgroundRun),
        });
        return;
      }
      const signalled = await this._backgroundRunSupervisor?.signalRun({
        sessionId: msg.sessionId,
        content: msg.content,
        type: "user_input",
      });
      if (signalled) {
        await memoryBackend
          .addEntry({
            sessionId: msg.sessionId,
            role: "user",
            content: msg.content,
          })
          .catch((error) => {
            this.logger.debug("Background run signal memory write failed", {
              sessionId: msg.sessionId,
              error: toErrorMessage(error),
            });
          });
        await webChat.send({
          sessionId: msg.sessionId,
          content:
            activeBackgroundRun.state === "paused"
              ? "Queued your latest instruction for the paused background run. Resume it when you want execution to continue."
              : "Queued your latest instruction for the active background run and woke it for an immediate follow-up cycle.",
        });
        return;
      }
    }

    if (!isDoomStopTurn && this._backgroundRunSupervisor) {
      if (isBackgroundRunStatusRequest(msg.content)) {
        const recentSnapshot =
          await this._backgroundRunSupervisor.getRecentSnapshot(msg.sessionId);
        await webChat.send({
          sessionId: msg.sessionId,
          content: formatInactiveBackgroundRunStatus(recentSnapshot),
        });
        return;
      }
      if (isBackgroundRunStopRequest(msg.content)) {
        const recentSnapshot =
          await this._backgroundRunSupervisor.getRecentSnapshot(msg.sessionId);
        await webChat.send({
          sessionId: msg.sessionId,
          content: formatInactiveBackgroundRunStop(recentSnapshot),
        });
        return;
      }
      if (isBackgroundRunPauseRequest(msg.content)) {
        await webChat.send({
          sessionId: msg.sessionId,
          content: "No active background run to pause.",
        });
        return;
      }
      if (isBackgroundRunResumeRequest(msg.content)) {
        await webChat.send({
          sessionId: msg.sessionId,
          content: "No paused background run to resume.",
        });
        return;
      }
    }

    if (
      !doomTurnContract &&
      inferBackgroundRunIntent(msg.content) &&
      this._backgroundRunSupervisor
    ) {
      const admission = this.evaluateBackgroundRunAdmission({
        sessionId: msg.sessionId,
        domain: "generic",
      });
      if (!admission.allowed) {
        this.logger.info("Background run canary admission denied", {
          sessionId: msg.sessionId,
          cohort: admission.cohort,
          reason: admission.reason,
        });
        await webChat.send({
          sessionId: msg.sessionId,
          content: formatBackgroundRunAdmissionDenied(admission.reason),
        });
        return;
      } else {
        await memoryBackend
          .addEntry({
            sessionId: msg.sessionId,
            role: "user",
            content: msg.content,
          })
          .catch((error) => {
            this.logger.debug(
              "Background run user message memory write failed",
              {
                sessionId: msg.sessionId,
                error: toErrorMessage(error),
              },
            );
          });
        await this._backgroundRunSupervisor.startRun({
          sessionId: msg.sessionId,
          objective: msg.content,
        });
        return;
      }
    }

    const sessionStreamCallback: StreamProgressCallback = (chunk) => {
      webChat.pushToSession(msg.sessionId, {
        type: "chat.stream",
        payload: { content: chunk.content, done: chunk.done },
      });
    };

    const requestedDesktopResolution =
      this._desktopManager?.getHandleBySession(msg.sessionId)?.resolution ??
      this.gateway?.config.desktop?.resolution;
    const requestedDoomResolution = requestedDesktopResolution
      ? chooseDoomResolutionForDisplay(
          requestedDesktopResolution.width,
          requestedDesktopResolution.height,
        )
      : DEFAULT_DOOM_FIT_RESOLUTION;
    const doomTurnToolCalls: ToolCallRecord[] = [];
    let doomStopIssued = false;
    const advertisedToolNames = this.getAdvertisedToolNames();

    const sessionToolHandler = this.createWebChatSessionToolHandler({
      sessionId: msg.sessionId,
      webChat,
      hooks,
      approvalEngine: approvalEngine ?? undefined,
      baseToolHandler,
      traceLabel: "webchat",
      traceConfig,
      traceId: turnTraceId,
      normalizeArgs: (toolName, normalizedArgs) => {
        if (toolName !== "mcp.doom.start_game") return normalizedArgs;
        let nextArgs = normalizedArgs;
        if (
          doomTurnContract?.requiresAutonomousPlay &&
          nextArgs.async_player !== true
        ) {
          nextArgs = { ...nextArgs, async_player: true };
        }
        if (
          nextArgs.screen_resolution === "RES_1280X720" &&
          requestedDoomResolution !== "RES_1280X720"
        ) {
          nextArgs = {
            ...nextArgs,
            screen_resolution: requestedDoomResolution,
          };
        }
        return nextArgs;
      },
      beforeHandle: (toolName) => {
        if (isDoomStopTurn) {
          const blockedResult = blockUntilDoomStopTool(
            toolName,
            doomStopIssued,
          );
          if (toolName === "mcp.doom.stop_game" && !blockedResult) {
            doomStopIssued = true;
          }
          if (blockedResult) return blockedResult;
        }
        const contractBlock = resolveToolContractExecutionBlock({
          phase: doomTurnToolCalls.length === 0 ? "initial" : "tool_followup",
          messageText: msg.content,
          toolCalls: doomTurnToolCalls,
          allowedToolNames: advertisedToolNames,
          candidateToolName: toolName,
        });
        if (contractBlock) {
          return JSON.stringify({ error: contractBlock });
        }
        return undefined;
      },
      onToolEnd: (toolName, args, result, durationMs) => {
        doomTurnToolCalls.push({
          name: toolName,
          args,
          result,
          isError: didToolCallFail(false, result),
          durationMs,
        });
      },
    });

    if (isDoomStopTurn) {
      await this.executeWebChatDoomStopTurn({
        msg,
        webChat,
        hooks,
        sessionMgr,
        sessionToolHandler,
        memoryBackend,
        signals,
      });
      return;
    }

    const conversationResult = await this.executeWebChatConversationTurn({
      msg,
      webChat,
      chatExecutor,
      sessionMgr,
      getSystemPrompt,
      sessionToolHandler,
      sessionStreamCallback,
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget,
      defaultMaxToolRounds: this._defaultForegroundMaxToolRounds,
      contextWindowTokens,
      traceConfig,
      turnTraceId,
    });

    if (
      conversationResult &&
      conversationResult.stopReason === "completed" &&
      doomTurnContract?.requiresAutonomousPlay &&
      this._backgroundRunSupervisor
    ) {
      const doomEvidence = summarizeDoomToolEvidence(doomTurnToolCalls);
      if (!getMissingDoomEvidenceGap(doomTurnContract, doomEvidence)) {
        try {
          await this._backgroundRunSupervisor.startRun({
            sessionId: msg.sessionId,
            objective: buildDoomAutoplaySupervisionObjective({
              toolCalls: doomTurnToolCalls,
            }),
            options: {
              silent: true,
              contract: buildDoomAutoplayBackgroundContract(),
            },
          });
        } catch (error) {
          this.logger.warn("Failed to start Doom background supervision", {
            sessionId: msg.sessionId,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  private async executeWebChatDoomStopTurn(params: {
    msg: GatewayMessage;
    webChat: WebChatChannel;
    hooks: HookDispatcher;
    sessionMgr: SessionManager;
    sessionToolHandler: ToolHandler;
    memoryBackend: MemoryBackend;
    signals: WebChatSignals;
  }): Promise<void> {
    const {
      msg,
      webChat,
      hooks,
      sessionMgr,
      sessionToolHandler,
      memoryBackend,
      signals,
    } = params;

    const session = sessionMgr.getOrCreate({
      channel: "webchat",
      senderId: msg.sessionId,
      scope: "dm",
      workspaceId: "default",
    });

    signals.signalThinking(msg.sessionId);
    let content = "Doom stopped.";
    try {
      const result = await sessionToolHandler("mcp.doom.stop_game", {});
      const parsed = parseToolResultObject(result);
      const error =
        parsed &&
        typeof parsed.error === "string" &&
        parsed.error.trim().length > 0
          ? parsed.error.trim()
          : undefined;
      if (error) {
        content = `Failed to stop Doom: ${error}`;
      } else if (parsed?.status === "stopped") {
        content = "Doom stopped.";
      } else {
        content = "Doom stop requested.";
      }
    } catch (error) {
      content = `Failed to stop Doom: ${toErrorMessage(error)}`;
    } finally {
      signals.signalIdle(msg.sessionId);
    }

    sessionMgr.appendMessage(session.id, {
      role: "user",
      content: msg.content,
    });
    sessionMgr.appendMessage(session.id, { role: "assistant", content });

    await webChat.send({
      sessionId: msg.sessionId,
      content,
    });
    webChat.broadcastEvent("chat.response", { sessionId: msg.sessionId });

    await hooks.dispatch("message:outbound", {
      sessionId: msg.sessionId,
      content,
      provider: "runtime",
      userMessage: msg.content,
      agentResponse: content,
    });

    try {
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "user",
        content: msg.content,
      });
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "assistant",
        content,
      });
    } catch (error) {
      this.logger.warn?.("Failed to persist messages to memory:", error);
    }
  }

  private async executeWebChatConversationTurn(params: {
    msg: GatewayMessage;
    webChat: WebChatChannel;
    chatExecutor: ChatExecutor;
    sessionMgr: SessionManager;
    getSystemPrompt: () => string;
    sessionToolHandler: ToolHandler;
    sessionStreamCallback: StreamProgressCallback;
    signals: WebChatSignals;
    hooks: HookDispatcher;
    memoryBackend: MemoryBackend;
    sessionTokenBudget: number;
    defaultMaxToolRounds: number;
    contextWindowTokens?: number;
    traceConfig: ResolvedTraceLoggingConfig;
    turnTraceId: string;
  }): Promise<ChatExecutorResult | undefined> {
    const {
      msg,
      webChat,
      chatExecutor,
      sessionMgr,
      getSystemPrompt,
      sessionToolHandler,
      sessionStreamCallback,
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget,
      defaultMaxToolRounds,
      contextWindowTokens,
      traceConfig,
      turnTraceId,
    } = params;

    this._activeSessionTraceIds.set(msg.sessionId, turnTraceId);
    this._foregroundSessionLocks.add(msg.sessionId);
    try {
      return await runWebChatConversationTurn({
        logger: this.logger,
        msg,
        webChat,
        chatExecutor,
        sessionMgr,
        getSystemPrompt,
        sessionToolHandler,
        sessionStreamCallback,
        signals,
        hooks,
        memoryBackend,
        sessionTokenBudget,
        defaultMaxToolRounds,
        contextWindowTokens,
        traceConfig,
        turnTraceId,
        buildToolRoutingDecision: (sessionId, content, history) =>
          this.buildToolRoutingDecision(sessionId, content, history),
        recordToolRoutingOutcome: (sessionId, summary) => {
          this.recordToolRoutingOutcome(sessionId, summary);
        },
        getSessionTokenUsage: (sessionId) =>
          chatExecutor.getSessionTokenUsage(sessionId),
        onModelInfo: (result) => {
          if (!result.model) return;
          this._sessionModelInfo.set(msg.sessionId, {
            provider: result.provider,
            model: result.model,
            usedFallback: result.usedFallback,
            updatedAt: Date.now(),
          });
        },
        onSubagentSynthesis: (result) => {
          if (
            this._subagentActivityTraceBySession.get(msg.sessionId) !== turnTraceId
          ) {
            return;
          }
          const outputPreview = firstSurfaceSummaryLine(result.content);
          const stopReasonDetail =
            typeof result.stopReasonDetail === "string" &&
            result.stopReasonDetail.trim().length > 0
              ? result.stopReasonDetail.trim()
              : undefined;
          this.relaySubAgentLifecycleEvent(webChat, {
            type: "subagents.synthesized",
            timestamp: Date.now(),
            sessionId: msg.sessionId,
            parentSessionId: msg.sessionId,
            payload: {
              stopReason: result.stopReason,
              ...(stopReasonDetail ? { stopReasonDetail } : {}),
              outputChars: result.content.length,
              toolCalls: result.toolCalls.length,
              ...(outputPreview ? { outputPreview } : {}),
            },
          });
          this._subagentActivityTraceBySession.delete(msg.sessionId);
          this._latestDelegationSurfaceContextBySession.delete(msg.sessionId);
        },
      });
    } finally {
      this._foregroundSessionLocks.delete(msg.sessionId);
      if (this._activeSessionTraceIds.get(msg.sessionId) === turnTraceId) {
        this._activeSessionTraceIds.delete(msg.sessionId);
      }
      if (
        this._subagentActivityTraceBySession.get(msg.sessionId) === turnTraceId
      ) {
        this._subagentActivityTraceBySession.delete(msg.sessionId);
        this._latestDelegationSurfaceContextBySession.delete(msg.sessionId);
      }
    }
  }

  /**
   * Build the system prompt from workspace files, falling back to
   * personality template when no workspace directory exists.
   *
   * Delegates to standalone helpers in `./system-prompt-builder.js`.
   */
  private _buildSystemPrompt(
    config: GatewayConfig,
    options?: { forVoice?: boolean },
  ): Promise<string> {
    return buildSystemPrompt(
      config,
      {
        yolo: this.yolo,
        configPath: this.configPath,
        logger: this.logger,
      },
      options,
    );
  }

  private _resolveActiveHostWorkspacePath(config: GatewayConfig): string {
    return resolveActiveHostWorkspacePath(config, this.configPath);
  }

  /**
   * Create the ordered provider chain: primary + optional fallbacks.
   * ChatExecutor handles cooldown-based failover across the chain.
   */
  private async createLLMProviders(
    config: GatewayConfig,
    tools: LLMTool[],
  ): Promise<LLMProvider[]> {
    const result = await createLLMProvidersStandalone(config, tools, this.logger);
    this._primaryLlmConfig = result.primaryLlmConfig;
    this._llmProviderConfigByInstance = result.providerConfigByInstance;
    this._llmProviderConfigCatalog = result.providerConfigCatalog;
    return result.providers;
  }

  /**
   * Discover bundled skills and, when explicitly enabled, user-home skills.
   * Returns discovered skill metadata for downstream relevance-filtered prompt
   * injection.
   */
  private async discoverSkills(): Promise<DiscoveredSkill[]> {
    try {
      const discoveryPaths = resolveRuntimeSkillDiscoveryPaths();
      if (discoveryPaths.userSkills) {
        this.logger.warn?.(
          `Runtime user skill discovery enabled via ${RUNTIME_USER_SKILLS_ENV}; loading skills from ${discoveryPaths.userSkills}`,
        );
      }

      const discovery = new SkillDiscovery(discoveryPaths);
      return await discovery.discoverAll();
    } catch (err) {
      this.logger.warn?.("Skill discovery failed:", err);
      return [];
    }
  }
  async stop(): Promise<void> {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    try {
      // Dispatch shutdown hook (best-effort)
      if (this._hookDispatcher !== null) {
        await this._hookDispatcher.dispatch("gateway:shutdown", {});
        this._hookDispatcher.clear();
        this._hookDispatcher = null;
      }
      // Stop voice sessions before WebChat channel
      if (this._voiceBridge !== null) {
        await this._voiceBridge.stopAll();
        this._voiceBridge = null;
      }
      // Stop social module
      this._agentMessagingUnsubscribe?.();
      this._agentMessagingUnsubscribe = null;
      if (this._agentMessaging !== null) {
        await this._agentMessaging.dispose();
        this._agentMessaging = null;
      }
      if (this._agentDiscovery !== null) {
        this._agentDiscovery.dispose();
        this._agentDiscovery = null;
      }
      this._agentFeed = null;
      this._reputationScorer = null;
      this._collaborationProtocol = null;
      this._marketplace = null;
      this._policyEngine = null;
      this._governanceAuditLog = null;
      if (this._sessionCredentialBroker !== null) {
        await this._sessionCredentialBroker.revokeAll("shutdown");
        this._sessionCredentialBroker = null;
      }
      // Clean up subsystems
      if (this._approvalEngine !== null) {
        this._approvalEngine.dispose();
        this._approvalEngine = null;
      }
      this._textApprovalDispatchBySession.clear();
      if (this._telemetry !== null) {
        this._telemetry.flush();
        this._telemetry.destroy();
        this._telemetry = null;
      }
      this._toolRouter?.clear();
      this._toolRouter = null;
      await this.destroySubAgentInfrastructure();
      this._subAgentRuntimeConfig = null;
      this.clearDelegationRuntimeServices();
      this._subAgentToolCatalog.splice(0, this._subAgentToolCatalog.length);
      // Disconnect desktop bridges and destroy containers
      for (const bridge of this._desktopBridges.values()) {
        bridge.disconnect();
      }
      this._desktopBridges.clear();
      // Disconnect Playwright MCP bridges
      for (const pwBridge of this._playwrightBridges.values()) {
        await pwBridge.dispose().catch((error) => {
          this.logger.debug("Failed to dispose Playwright MCP bridge", {
            error: toErrorMessage(error),
          });
        });
      }
      this._playwrightBridges.clear();
      // Disconnect container MCP bridges
      for (const bridges of this._containerMCPBridges.values()) {
        for (const bridge of bridges) {
          await bridge.dispose().catch((error) => {
            this.logger.debug("Failed to dispose container MCP bridge", {
              error: toErrorMessage(error),
            });
          });
        }
      }
      this._containerMCPBridges.clear();
      this._containerMCPConfigs = [];
      if (this._backgroundRunSupervisor !== null) {
        await this._backgroundRunSupervisor.shutdown();
        this._backgroundRunSupervisor = null;
        this._durableSubrunOrchestrator = null;
      }
      if (this._desktopWatchdog !== null) {
        this._desktopWatchdog.stop();
        this._desktopWatchdog = null;
      }
      if (this._desktopManager !== null) {
        await this._desktopManager.stop();
        this._desktopManager = null;
      }
      if (this._connectionManager !== null) {
        this._connectionManager.destroy();
        this._connectionManager = null;
      }
      if (this._memoryBackend !== null) {
        await this._memoryBackend.close();
        this._memoryBackend = null;
      }
      // Stop MCP server connections
      if (this._mcpManager !== null) {
        await this._mcpManager.stop();
        this._mcpManager = null;
      }
      // Stop autonomous schedulers
      if (this._heartbeatScheduler !== null) {
        this._heartbeatScheduler.stop();
        this._heartbeatScheduler = null;
      }
      if (this._cronScheduler !== null) {
        this._cronScheduler.stop();
        this._cronScheduler = null;
      }
      // Stop legacy heartbeat timer (if still in use)
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      // Stop desktop executor
      if (this._desktopExecutor !== null) {
        this._desktopExecutor.cancel();
        this._desktopExecutor = null;
      }
      // Clear goal manager
      this._goalManager = null;
      // Clear proactive communicator
      this._proactiveCommunicator = null;
      // Stop WebChat channel before gateway
      this.detachSubAgentLifecycleBridge();
      if (this._webChatChannel !== null) {
        await this._webChatChannel.stop();
        this._webChatChannel = null;
      }
      this._webChatInboundHandler = null;
      this._activeSessionTraceIds.clear();
      this._subagentActivityTraceBySession.clear();
      this._latestDelegationSurfaceContextBySession.clear();
      this._foregroundSessionLocks.clear();
      this._hostWorkspacePath = null;
      this._hostWorkspacePathPinned = false;
      if (this.gateway !== null) {
        await this.gateway.stop();
        this.gateway = null;
      } else {
        await this._stopChannelRegistry(this._externalChannels);
      }
      this._externalChannels.clear();
      await this.disposeObservabilityService();
      await removePidFile(this.pidPath);
      this.removeSignalHandlers();
      this.startedAt = 0;
      this.logger.info("Daemon stopped");
    } finally {
      this.shutdownInProgress = false;
    }
  }

  get desktopExecutor():
    | import("../autonomous/desktop-executor.js").DesktopExecutor
    | null {
    return this._desktopExecutor;
  }

  get goalManager():
    | import("../autonomous/goal-manager.js").GoalManager
    | null {
    return this._goalManager;
  }

  get proactiveCommunicator(): ProactiveCommunicator | null {
    return this._proactiveCommunicator;
  }

  get marketplace():
    | import("../marketplace/service-marketplace.js").ServiceMarketplace
    | null {
    return this._marketplace;
  }

  get policyEngine(): import("../policy/engine.js").PolicyEngine | null {
    return this._policyEngine;
  }

  get agentDiscovery(): import("../social/discovery.js").AgentDiscovery | null {
    return this._agentDiscovery;
  }

  get subAgentRuntimeConfig(): Readonly<ResolvedSubAgentRuntimeConfig> | null {
    return this._subAgentRuntimeConfig;
  }

  get delegationPolicyEngine(): DelegationPolicyEngine | null {
    return this._delegationPolicyEngine;
  }

  get delegationVerifierService(): DelegationVerifierService | null {
    return this._delegationVerifierService;
  }

  get subAgentLifecycleEmitter(): SubAgentLifecycleEmitter | null {
    return this._subAgentLifecycleEmitter;
  }

  get delegationTrajectorySink(): InMemoryDelegationTrajectorySink | null {
    return this._delegationTrajectorySink;
  }

  get delegationBanditTuner(): DelegationBanditPolicyTuner | null {
    return this._delegationBanditTuner;
  }

  getStatus(): DaemonStatus {
    const mem = process.memoryUsage();
    return {
      running: this.gateway !== null && this.gateway.state === "running",
      pid: process.pid,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      gatewayStatus:
        this.gateway !== null
          ? this.gateway.getStatus()
          : null,
      memoryUsage: {
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      },
    };
  }

  setupSignalHandlers(): void {
    if (this.signalHandlersRegistered) {
      return;
    }
    this.signalHandlersRegistered = true;

    const shutdown = () => {
      void this.stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    const reload = () => {
      void this.handleConfigReload();
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGHUP", reload);

    this.signalHandlerRefs = [
      { signal: "SIGTERM", handler: shutdown },
      { signal: "SIGINT", handler: shutdown },
      { signal: "SIGHUP", handler: reload },
    ];
  }

  private removeSignalHandlers(): void {
    for (const ref of this.signalHandlerRefs) {
      process.removeListener(ref.signal, ref.handler);
    }
    this.signalHandlerRefs = [];
    this.signalHandlersRegistered = false;
  }

  private async handleConfigReload(): Promise<void> {
    try {
      this.logger.info("Reloading config", { configPath: this.configPath });
      const newConfig = await loadGatewayConfig(this.configPath);
      if (this.gateway !== null) {
        const diff = this.gateway.reloadConfig(newConfig);
        this.logger.info("Config reloaded", {
          safe: diff.safe,
          unsafe: diff.unsafe,
        });
      }
    } catch (error) {
      this.logger.error("Config reload failed", {
        error: toErrorMessage(error),
      });
    }
  }
}

// ============================================================================
// Service Templates
// ============================================================================

export function generateSystemdUnit(options: {
  execStart: string;
  description?: string;
  user?: string;
}): string {
  const desc = options.description ?? "AgenC Gateway Daemon";
  const lines = [
    "[Unit]",
    `Description=${desc}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${options.execStart}`,
    "Restart=on-failure",
    "RestartSec=10s",
    "TimeoutStopSec=35s",
    "Environment=NODE_ENV=production",
  ];
  if (options.user) {
    lines.push(`User=${options.user}`);
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateLaunchdPlist(options: {
  programArguments: string[];
  label?: string;
  logDir?: string;
}): string {
  const label = escapeXml(options.label ?? "ai.agenc.gateway");
  const logDir = options.logDir ?? join(homedir(), ".agenc", "logs");
  const programArgs = options.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArgs,
    "  </array>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(join(logDir, "agenc-stdout.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(join(logDir, "agenc-stderr.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
