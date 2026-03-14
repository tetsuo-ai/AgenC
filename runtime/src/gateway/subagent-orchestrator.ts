/**
 * SubAgentOrchestrator — planner DAG execution with sub-agent scheduling.
 *
 * Executes planner-emitted DAGs through the existing pipeline executor contract.
 * Supports deterministic tool nodes, subagent task nodes, and synthesis no-op
 * nodes while preserving PipelineResult semantics.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor.js";
import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelinePlannerContextHistoryEntry,
  PipelinePlannerContextMemorySource,
  PipelinePlannerContextMemoryEntry,
  PipelinePlannerContextToolOutputEntry,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
  PipelineResult,
  PipelineStopReasonHint,
  PipelineStep,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type {
  SubAgentConfig,
  SubAgentResult,
} from "./sub-agent.js";
import type { HostToolingProfile } from "./host-tooling.js";
import {
  derivePromptBudgetPlan,
  type PromptBudgetConfig,
} from "../llm/prompt-budget.js";
import {
  type DelegatedWorkingDirectoryResolution,
  resolveDelegatedWorkingDirectory,
  resolveDelegatedWorkingDirectoryPath,
} from "./delegation-tool.js";
import {
  resolveDelegationBudgetHintMs,
} from "./delegation-timeout.js";
import type {
  LLMProviderExecutionProfile,
  LLMUsage,
} from "../llm/types.js";
import {
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
} from "../llm/chat-executor-constants.js";
import type {
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import {
  assessDelegationScope,
  type DelegationDecompositionSignal,
} from "./delegation-scope.js";
import { sleep } from "../utils/async.js";
import {
  type DelegationContractSpec,
  type DelegationOutputValidationCode,
  resolveDelegatedChildToolScope,
  specRequiresMeaningfulBrowserEvidence,
  specRequiresSuccessfulToolEvidence,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import {
  didToolCallFail,
  extractToolFailureTextFromResult,
} from "../llm/chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";
import { buildBrowserEvidenceRetryGuidance } from "../utils/browser-tool-taxonomy.js";
import {
  computeDelegationFinalReward,
  deriveDelegationContextClusterId,
  type DelegationTrajectorySink,
} from "../llm/delegation-learning.js";
import { tokenizeShellCommand } from "../tools/system/command-line.js";

interface SubAgentExecutionManager {
  spawn(config: SubAgentConfig): Promise<string>;
  getResult(sessionId: string): SubAgentResult | null;
}

interface ResolvedChildPromptBudget {
  readonly promptBudget?: PromptBudgetConfig;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

export interface SubAgentOrchestratorConfig {
  readonly fallbackExecutor: DeterministicPipelineExecutor;
  readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  readonly resolveLifecycleEmitter?: () => SubAgentLifecycleEmitter | null;
  readonly resolveTrajectorySink?: () => DelegationTrajectorySink | null;
  readonly resolveAvailableToolNames?: () => readonly string[] | null;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  readonly resolveHostWorkspaceRoot?: () => string | null;
  readonly childPromptBudget?: PromptBudgetConfig;
  readonly resolveChildPromptBudget?: (params: {
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) =>
    | Promise<ResolvedChildPromptBudget | undefined>
    | ResolvedChildPromptBudget
    | undefined;
  readonly allowParallelSubtasks?: boolean;
  readonly maxParallelSubtasks?: number;
  readonly pollIntervalMs?: number;
  readonly defaultSubagentTimeoutMs?: number;
  readonly maxDepth?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxTotalSubagentsPerRequest?: number;
  readonly maxCumulativeToolCallsPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured?: boolean;
  readonly childToolAllowlistStrategy?: "inherit_intersection" | "explicit_only";
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior?: "continue_without_delegation" | "fail_request";
  readonly unsafeBenchmarkMode?: boolean;
}

type SubagentFailureClass =
  | "timeout"
  | "budget_exceeded"
  | "tool_misuse"
  | "malformed_result_contract"
  | "needs_decomposition"
  | "invalid_input"
  | "transient_provider_error"
  | "cancelled"
  | "spawn_error"
  | "unknown";

interface SubagentRetryRule {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

type SubagentFailureOutcome = {
  readonly failureClass: SubagentFailureClass;
  readonly message: string;
  readonly stopReasonHint: PipelineStopReasonHint;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly decomposition?: DelegationDecompositionSignal;
  readonly childSessionId?: string;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly tokenUsage?: LLMUsage;
};

interface ExecuteSubagentAttemptParams {
  readonly subAgentManager: SubAgentExecutionManager;
  readonly step: PipelinePlannerSubagentStep;
  readonly pipeline: Pipeline;
  readonly parentSessionId: string;
  readonly parentRequest?: string;
  readonly lastValidationCode?: DelegationOutputValidationCode;
  readonly timeoutMs: number;
  readonly toolBudgetPerRequest: number;
  readonly taskPrompt: string;
  readonly diagnostics: SubagentContextDiagnostics;
  readonly tools: readonly string[];
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
}

type ExecuteSubagentAttemptOutcome =
  | {
    readonly status: "completed";
    readonly subagentSessionId: string;
    readonly output: string;
    readonly durationMs: number;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly providerName?: string;
  }
  | {
    readonly status: "failed";
    readonly failure: SubagentFailureOutcome;
  };

type NodeExecutionOutcome =
  | { readonly status: "completed"; readonly result: string }
  | {
    readonly status: "failed";
    readonly error: string;
    readonly stopReasonHint?: PipelineStopReasonHint;
    readonly decomposition?: DelegationDecompositionSignal;
    readonly result?: string;
  }
  | { readonly status: "halted"; readonly error?: string };

interface RuntimeNode {
  readonly step: PipelinePlannerStep;
  readonly dependencies: ReadonlySet<string>;
  readonly orderIndex: number;
}

interface RunningNode {
  readonly promise: Promise<NodeExecutionOutcome>;
  readonly exclusive: boolean;
}

interface DependencySatisfactionState {
  readonly satisfied: boolean;
  readonly reason?: string;
  readonly stopReasonHint?: PipelineStopReasonHint;
}

interface BlockedDependencyDetail {
  readonly stepName: string;
  readonly reason: string;
  readonly stopReasonHint: PipelineStopReasonHint;
}

interface CuratedSection {
  readonly lines: readonly string[];
  readonly selected: number;
  readonly available: number;
  readonly omitted: number;
  readonly truncated: boolean;
}

interface DependencyArtifactCandidate {
  readonly dependencyName: string;
  readonly path: string;
  readonly content: string;
  readonly score: number;
  readonly order: number;
  readonly depth: number;
}

interface DependencyContextEntry {
  readonly dependencyName: string;
  readonly result: string | null;
  readonly depth: number;
  readonly orderIndex: number;
}

interface PackageAuthoringState {
  readonly relativePackageDirectory: string;
  readonly relativeSourceDirectory: string;
  readonly sourceDirExists: boolean;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
}

type AcceptanceProbeCategory = "build" | "typecheck" | "lint" | "test";

interface AcceptanceProbePlan {
  readonly name: string;
  readonly category: AcceptanceProbeCategory;
  readonly step: PipelinePlannerDeterministicStep;
}

interface SubagentPromptBudgetCaps {
  readonly historyChars: number;
  readonly memoryChars: number;
  readonly toolOutputChars: number;
  readonly totalPromptChars: number;
}

interface SubagentContextDiagnostics {
  readonly executionBudget: {
    readonly provider?: string;
    readonly model?: string;
    readonly contextWindowTokens?: number;
    readonly contextWindowSource?: string;
    readonly maxOutputTokens?: number;
    readonly historyChars: number;
    readonly memoryChars: number;
    readonly toolOutputChars: number;
    readonly totalPromptChars: number;
  };
  readonly history: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly memory: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly toolOutputs: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly dependencyArtifacts: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly hostTooling: {
    readonly included: boolean;
    readonly reason: "node_package_tooling" | "not_relevant" | "profile_unavailable";
    readonly nodeVersion?: string;
    readonly npmVersion?: string;
    readonly npmWorkspaceProtocolSupport?: "supported" | "unsupported" | "unknown";
    readonly npmWorkspaceProtocolEvidence?: string;
  };
  readonly promptTruncated: boolean;
  readonly toolScope: {
    readonly strategy: "inherit_intersection" | "explicit_only";
    readonly unsafeBenchmarkMode: boolean;
    readonly required: readonly string[];
    readonly parentPolicyAllowed: readonly string[];
    readonly parentPolicyForbidden: readonly string[];
    readonly resolved: readonly string[];
    readonly allowsToollessExecution: boolean;
    readonly semanticFallback: readonly string[];
    readonly removedLowSignalBrowserTools: readonly string[];
    readonly removedByPolicy: readonly string[];
    readonly removedAsDelegationTools: readonly string[];
    readonly removedAsUnknownTools: readonly string[];
  };
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_PARALLEL_SUBTASKS = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
const DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST = 32;
const DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE = 256;
const DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE = 0;
const DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP = 150_000;
const DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS =
  DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP /
  DEFAULT_SUBAGENT_TIMEOUT_MS;
const DEFAULT_REQUEST_TREE_SUBAGENT_PASSES = Math.max(
  1,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
);
const DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET = DEFAULT_TOOL_BUDGET_PER_REQUEST;
const MAX_PLANNED_SUBAGENT_TOOL_BUDGET = 96;
const PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL = 7_500;
const BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER = 1.5;
const CONTEXT_TERM_MIN_LENGTH = 3;
const CONTEXT_HISTORY_TAIL_PIN = 2;
const FALLBACK_CONTEXT_HISTORY_CHARS = 2_000;
const FALLBACK_CONTEXT_MEMORY_CHARS = 2_800;
const FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS = 3_200;
const FALLBACK_SUBAGENT_TASK_PROMPT_CHARS = 14_000;
const DEFAULT_FALLBACK_BEHAVIOR = "fail_request" as const;
const REDACTED_IMAGE_DATA_URL = "[REDACTED_IMAGE_DATA_URL]";
const REDACTED_PRIVATE_KEY_BLOCK = "[REDACTED_PRIVATE_KEY_BLOCK]";
const REDACTED_INTERNAL_URL = "[REDACTED_INTERNAL_URL]";
const REDACTED_FILE_URL = "[REDACTED_FILE_URL]";
const REDACTED_BEARER_TOKEN = "Bearer [REDACTED_TOKEN]";
const REDACTED_API_KEY = "[REDACTED_API_KEY]";
const REDACTED_ABSOLUTE_PATH = "[REDACTED_ABSOLUTE_PATH]";
const NODE_PACKAGE_TOOLING_RE =
  /\b(?:node(?:\.js)?|npm|npx|package\.json|package-lock\.json|pnpm|pnpm-workspace\.yaml|yarn|bun|typescript|tsconfig(?:\.[a-z]+)?\.json|tsx|vitest|commander)\b/i;
const NODE_PACKAGE_MANIFEST_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[a-z]+)?\.json)$/i;
const NODE_WORKSPACE_AUTHORING_RE =
  /\b(?:package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|workspaces|dependencies|devdependencies|scripts?|bin)\b/i;
const RUST_WORKSPACE_TOOLING_RE =
  /\b(?:cargo(?:\.toml|\.lock)?|rustc|rustfmt|clippy|crates?)\b|(?:^|\/)(?:src\/)?(?:lib|main)\.rs\b/i;
const TEST_ARTIFACT_PATH_RE =
  /(?:^|\/)(?:tests?|__tests__|specs?)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_ARTIFACT_PATH_RE = /\.(?:[cm]?[jt]sx?)$/i;
const GENERATED_DECLARATION_PATH_RE = /\.d\.[cm]?ts$/i;
const PLACEHOLDER_TEST_SCRIPT_RE =
  /\berror:\s*no test specified\b|exit\s+1\b/i;
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g;
const IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const API_KEY_ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;
const INTERNAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]+\.)*internal)(?::\d+)?(?:\/[^\s"'`)]*)?/gi;
const FILE_URL_RE = /\bfile:\/\/[^\s"'`)]+/gi;
const ABSOLUTE_PATH_RE =
  /(^|[\s"'`])((?:\/home|\/Users|\/root|\/etc|\/var|\/opt|\/srv|\/tmp)\/[^\s"'`]+)/g;
const SUBAGENT_ORCHESTRATION_SECTION_RE =
  /\bsub-agent orchestration plan(?:\s*\((?:required|mandatory)\)|\s+(?:required|mandatory))\s*:[\s\S]*$/i;
const WORKSPACE_CONTEXT_CANDIDATE_PATH_RE =
  /\.(?:[cm]?[jt]sx?|json|md|txt|html|css|toml|lock|ya?ml)$/i;
const WORKSPACE_CONTEXT_SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const WORKSPACE_CONTEXT_MAX_SCAN_FILES = 160;
const WORKSPACE_CONTEXT_MAX_SCAN_DEPTH = 5;
const WORKSPACE_CONTEXT_MAX_FILE_BYTES = 64_000;
const WORKSPACE_CONTEXT_MAX_CONTENT_CHARS = 6_000;
const WORKSPACE_CONTEXT_MIN_CANDIDATES = 3;
const WORKSPACE_CONTEXT_MAX_CANDIDATES = 10;
const PACKAGE_AUTHORING_SCAN_SKIP_DIRS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const PACKAGE_AUTHORING_MAX_SCAN_FILES = 128;
const RUST_GENERATED_ARTIFACT_PATH_RE =
  /(?:^|\/)target(?:\/|$)|(?:^|\/)\.fingerprint(?:\/|$)|(?:^|\/)incremental(?:\/|$)|(?:^|\/)\.rustc_info\.json$/i;

function isPipelineStopReasonHint(
  value: unknown,
): value is PipelineStopReasonHint {
  return (
    value === "validation_error" ||
    value === "provider_error" ||
    value === "authentication_error" ||
    value === "rate_limited" ||
    value === "timeout" ||
    value === "tool_error" ||
    value === "budget_exceeded" ||
    value === "no_progress" ||
    value === "cancelled"
  );
}

const SUBAGENT_RETRY_POLICY: Readonly<
  Record<SubagentFailureClass, SubagentRetryRule>
> = {
  timeout: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  budget_exceeded: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
  tool_misuse: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  malformed_result_contract: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
  needs_decomposition: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  invalid_input: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  transient_provider_error: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 300 },
  cancelled: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  spawn_error: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  unknown: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
};

const SUBAGENT_FAILURE_STOP_REASON: Readonly<
  Record<SubagentFailureClass, PipelineStopReasonHint>
> = {
  timeout: "timeout",
  budget_exceeded: "budget_exceeded",
  tool_misuse: "tool_error",
  malformed_result_contract: "validation_error",
  needs_decomposition: "validation_error",
  invalid_input: "validation_error",
  transient_provider_error: "provider_error",
  cancelled: "cancelled",
  spawn_error: "tool_error",
  unknown: "tool_error",
};

function summarizeSubagentFailureHistory(
  stepName: string,
  failures: readonly SubagentFailureOutcome[],
): string {
  if (failures.length === 0) {
    return `Sub-agent step "${stepName}" failed`;
  }

  const uniqueReasons = [
    ...new Set(
      failures
        .map((failure) => failure.message.trim())
        .filter((message) => message.length > 0),
    ),
  ];
  const summarizedReasons = uniqueReasons.slice(0, 4).join("; ");
  const moreCount = uniqueReasons.length - Math.min(uniqueReasons.length, 4);
  const suffix = moreCount > 0 ? `; +${moreCount} more` : "";
  return `Sub-agent step "${stepName}" failed after ${failures.length} attempt${failures.length === 1 ? "" : "s"}: ${summarizedReasons}${suffix}`;
}

function toPipelineStopReasonHint(
  value: unknown,
): PipelineStopReasonHint | undefined {
  switch (value) {
    case "validation_error":
    case "provider_error":
    case "authentication_error":
    case "rate_limited":
    case "timeout":
    case "tool_error":
    case "budget_exceeded":
    case "no_progress":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

class RequestTreeBudgetTracker {
  private spawnedChildren = 0;
  private reservedSpawns = 0;
  private cumulativeToolCalls = 0;
  private cumulativeTokens = 0;
  private circuitBreakerReason: string | null = null;

  constructor(
    private readonly maxTotalSubagentsPerRequest: number,
    private readonly maxCumulativeToolCallsPerRequestTree: number,
    private readonly maxCumulativeTokensPerRequestTree: number,
  ) {}

  snapshot(): {
    readonly spawnedChildren: number;
    readonly reservedSpawns: number;
    readonly cumulativeToolCalls: number;
    readonly cumulativeTokens: number;
    readonly maxTotalSubagentsPerRequest: number;
    readonly maxCumulativeToolCallsPerRequestTree: number;
    readonly maxCumulativeTokensPerRequestTree: number;
  } {
    return {
      spawnedChildren: this.spawnedChildren,
      reservedSpawns: this.reservedSpawns,
      cumulativeToolCalls: this.cumulativeToolCalls,
      cumulativeTokens: this.cumulativeTokens,
      maxTotalSubagentsPerRequest: this.maxTotalSubagentsPerRequest,
      maxCumulativeToolCallsPerRequestTree:
        this.maxCumulativeToolCallsPerRequestTree,
      maxCumulativeTokensPerRequestTree:
        this.maxCumulativeTokensPerRequestTree,
    };
  }

  reserveSpawn(): RequestTreeBudgetBreach | null {
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: this.spawnedChildren + this.reservedSpawns + 1,
        state: this.snapshot(),
      };
    }
    const projected = this.spawnedChildren + this.reservedSpawns + 1;
    if (projected > this.maxTotalSubagentsPerRequest) {
      this.circuitBreakerReason =
        `max spawned children per request exceeded (${this.maxTotalSubagentsPerRequest})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: projected,
        state: this.snapshot(),
      };
    }
    this.reservedSpawns += 1;
    return null;
  }

  commitSpawnResult(spawned: boolean): void {
    this.reservedSpawns = Math.max(0, this.reservedSpawns - 1);
    if (spawned) this.spawnedChildren += 1;
  }

  recordUsage(
    toolCallCount: number,
    tokenCount: number,
  ): RequestTreeBudgetBreach | null {
    const normalizedToolCalls = Math.max(0, Math.floor(toolCallCount));
    const normalizedTokens = Math.max(0, Math.floor(tokenCount));
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    this.cumulativeToolCalls += normalizedToolCalls;
    this.cumulativeTokens += normalizedTokens;
    if (
      this.maxCumulativeToolCallsPerRequestTree > 0 &&
      this.cumulativeToolCalls > this.maxCumulativeToolCallsPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tool calls per request tree exceeded (${this.maxCumulativeToolCallsPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tool_calls",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    if (
      this.maxCumulativeTokensPerRequestTree > 0 &&
      this.cumulativeTokens > this.maxCumulativeTokensPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tokens per request tree exceeded (${this.maxCumulativeTokensPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    return null;
  }
}

interface RequestTreeBudgetSnapshot {
  readonly spawnedChildren: number;
  readonly reservedSpawns: number;
  readonly cumulativeToolCalls: number;
  readonly cumulativeTokens: number;
  readonly maxTotalSubagentsPerRequest: number;
  readonly maxCumulativeToolCallsPerRequestTree: number;
  readonly maxCumulativeTokensPerRequestTree: number;
}

type RequestTreeBudgetBreach =
  | {
    readonly reason: string;
    readonly limitKind: "spawns";
    readonly attemptedSpawnCount: number;
    readonly state: RequestTreeBudgetSnapshot;
  }
  | {
    readonly reason: string;
    readonly limitKind: "tool_calls" | "tokens";
    readonly stepToolCalls: number;
    readonly stepTokens: number;
    readonly state: RequestTreeBudgetSnapshot;
  };

export class SubAgentOrchestrator implements DeterministicPipelineExecutor {
  private readonly fallbackExecutor: DeterministicPipelineExecutor;
  private readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  private readonly resolveLifecycleEmitter: () => SubAgentLifecycleEmitter | null;
  private readonly resolveTrajectorySink: () => DelegationTrajectorySink | null;
  private readonly resolveAvailableToolNames: () => readonly string[] | null;
  private readonly resolveHostToolingProfile: () => HostToolingProfile | null;
  private readonly resolveHostWorkspaceRoot: () => string | null;
  private readonly childPromptBudget?: PromptBudgetConfig;
  private readonly resolveChildPromptBudget?:
    SubAgentOrchestratorConfig["resolveChildPromptBudget"];
  private readonly allowParallelSubtasks: boolean;
  private readonly maxParallelSubtasks: number;
  private readonly pollIntervalMs: number;
  private readonly defaultSubagentTimeoutMs: number;
  private readonly maxDepth: number;
  private readonly maxFanoutPerTurn: number;
  private readonly maxTotalSubagentsPerRequest: number;
  private readonly maxCumulativeToolCallsPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured: boolean;
  private readonly childToolAllowlistStrategy:
    | "inherit_intersection"
    | "explicit_only";
  private readonly allowedParentTools: ReadonlySet<string>;
  private readonly forbiddenParentTools: ReadonlySet<string>;
  private readonly fallbackBehavior:
    | "continue_without_delegation"
    | "fail_request";
  private readonly unsafeBenchmarkMode: boolean;

  constructor(config: SubAgentOrchestratorConfig) {
    this.fallbackExecutor = config.fallbackExecutor;
    this.resolveSubAgentManager = config.resolveSubAgentManager;
    this.resolveLifecycleEmitter =
      config.resolveLifecycleEmitter ?? (() => null);
    this.resolveTrajectorySink = config.resolveTrajectorySink ?? (() => null);
    this.resolveAvailableToolNames = config.resolveAvailableToolNames ?? (() => null);
    this.resolveHostToolingProfile =
      config.resolveHostToolingProfile ?? (() => null);
    this.resolveHostWorkspaceRoot =
      config.resolveHostWorkspaceRoot ?? (() => null);
    this.childPromptBudget = config.childPromptBudget;
    this.resolveChildPromptBudget = config.resolveChildPromptBudget;
    this.allowParallelSubtasks = config.allowParallelSubtasks !== false;
    this.maxParallelSubtasks = Math.max(
      1,
      Math.floor(config.maxParallelSubtasks ?? DEFAULT_MAX_PARALLEL_SUBTASKS),
    );
    this.pollIntervalMs = Math.max(
      25,
      Math.floor(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    );
    this.defaultSubagentTimeoutMs = Math.max(
      1_000,
      Math.floor(config.defaultSubagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS),
    );
    this.maxDepth = Math.max(
      1,
      Math.floor(config.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH),
    );
    this.maxFanoutPerTurn = Math.max(
      1,
      Math.floor(config.maxFanoutPerTurn ?? DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN),
    );
    this.maxTotalSubagentsPerRequest = Math.max(
      1,
      Math.floor(
        config.maxTotalSubagentsPerRequest ??
          DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST,
      ),
    );
    this.maxCumulativeToolCallsPerRequestTree = Math.max(
      1,
      Math.floor(
        config.maxCumulativeToolCallsPerRequestTree ??
          DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE,
      ),
    );
    this.maxCumulativeTokensPerRequestTree = Math.max(
      0,
      Math.floor(
        config.maxCumulativeTokensPerRequestTree ??
          DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE,
      ),
    );
    this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured =
      config.maxCumulativeTokensPerRequestTreeExplicitlyConfigured === true;
    this.childToolAllowlistStrategy =
      config.childToolAllowlistStrategy ?? "inherit_intersection";
    this.allowedParentTools = new Set(
      (config.allowedParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.forbiddenParentTools = new Set(
      (config.forbiddenParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.fallbackBehavior = config.fallbackBehavior ?? DEFAULT_FALLBACK_BEHAVIOR;
    this.unsafeBenchmarkMode = config.unsafeBenchmarkMode === true;
  }

  async execute(
    pipeline: Pipeline,
    startFrom = 0,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    const plannerSteps = pipeline.plannerSteps;
    if (!plannerSteps || plannerSteps.length === 0) {
      return this.fallbackExecutor.execute(pipeline, startFrom, options);
    }

    if (startFrom > 0) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error:
          "SubAgentOrchestrator does not support DAG resume offsets yet (startFrom > 0)",
        stopReasonHint: "validation_error",
      };
    }

    const hardCapError = this.validateSubagentHardCaps(
      plannerSteps,
      pipeline.edges ?? [],
    );
    if (hardCapError) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: hardCapError,
        stopReasonHint: "validation_error",
      };
    }

    const materialized = this.materializeDag(plannerSteps, pipeline.edges ?? []);
    if (materialized.error) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: materialized.error,
        stopReasonHint: "validation_error",
      };
    }

    const nodes = materialized.nodes;
    const executionOrder = materialized.order;
    const stepByName = new Map(nodes.map((node) => [node.step.name, node]));
    const pending = new Set(executionOrder);
    const satisfied = new Set<string>();
    const unsatisfied = new Map<string, DependencySatisfactionState>();
    const running = new Map<string, RunningNode>();
    const mutableResults: Record<string, string> = { ...pipeline.context.results };
    const totalSteps = plannerSteps.length;
    let completedSteps = 0;
    const blockedStepNames: string[] = [];
    const parentSessionId = this.resolveParentSessionId(pipeline.id);
    const lifecycleEmitter = this.resolveLifecycleEmitter();
    const effectiveMaxCumulativeTokensPerRequestTree =
      this.resolveEffectiveMaxCumulativeTokensPerRequestTree(plannerSteps);
    const budgetTracker = new RequestTreeBudgetTracker(
      this.maxTotalSubagentsPerRequest,
      this.maxCumulativeToolCallsPerRequestTree,
      effectiveMaxCumulativeTokensPerRequestTree,
    );

    const maxParallel = this.resolveMaxParallelism(pipeline.maxParallelism);

    while (pending.size > 0 || running.size > 0) {
      let scheduledAny = false;
      const exclusiveRunning = Array.from(running.values()).some((r) => r.exclusive);

      for (const nodeName of executionOrder) {
        if (!pending.has(nodeName)) continue;
        if (running.size >= maxParallel) break;
        const node = stepByName.get(nodeName);
        if (!node) continue;
        const blockedDependencies = this.collectBlockedDependencies(
          node,
          unsatisfied,
        );
        if (blockedDependencies.length > 0) {
          pending.delete(nodeName);
          blockedStepNames.push(node.step.name);
          const stopReasonHint =
            blockedDependencies[0]?.stopReasonHint ?? "validation_error";
          const error = this.buildDependencyBlockedError(
            node.step.name,
            blockedDependencies,
          );
          mutableResults[node.step.name] = this.buildDependencyBlockedResult(
            node.step.name,
            blockedDependencies,
            error,
            stopReasonHint,
          );
          unsatisfied.set(node.step.name, {
            satisfied: false,
            reason: error,
            stopReasonHint,
          });
          if (node.step.stepType === "subagent_task") {
            lifecycleEmitter?.emit({
              type: "subagents.failed",
              timestamp: Date.now(),
              sessionId: parentSessionId,
              parentSessionId,
              toolName: "execute_with_agent",
              payload: {
                stepName: node.step.name,
                stage: "dependency_blocked",
                reason: error,
                unmetDependencies: blockedDependencies.map((dependency) => ({
                  stepName: dependency.stepName,
                  reason: dependency.reason,
                  stopReasonHint: dependency.stopReasonHint,
                })),
              },
            });
          }
          continue;
        }
        if (!this.dependenciesSatisfied(node, satisfied)) continue;

        const exclusiveNode = this.isExclusiveNode(node.step);
        if (exclusiveRunning) break;
        if (exclusiveNode && running.size > 0) continue;

        const traceTool = this.resolvePipelineTraceToolName(node.step);
        const traceArgs = this.buildPipelineTraceArgs(node.step);
        const emitPlannerNodeTrace = traceTool !== undefined;
        const stepStartedAt = emitPlannerNodeTrace ? Date.now() : 0;
        if (emitPlannerNodeTrace) {
          options?.onEvent?.({
            type: "step_started",
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            tool: traceTool,
            args: traceArgs,
          });
        }
        const promise = this.executeNode(
          node.step,
          pipeline,
          mutableResults,
          budgetTracker,
          options,
        ).then((outcome) => {
          if (emitPlannerNodeTrace) {
            const event: {
              type: "step_finished";
              pipelineId: string;
              stepName: string;
              stepIndex: number;
              tool: string;
              args?: Record<string, unknown>;
              durationMs: number;
              result?: string;
              error?: string;
            } = {
              type: "step_finished",
              pipelineId: pipeline.id,
              stepName: node.step.name,
              stepIndex: node.orderIndex,
              tool: traceTool,
              args: traceArgs,
              durationMs: Math.max(0, Date.now() - stepStartedAt),
            };
            if ("result" in outcome && typeof outcome.result === "string") {
              event.result = outcome.result;
            }
            if (outcome.status === "failed") {
              event.error = outcome.error;
            } else if (outcome.status === "halted" && outcome.error) {
              event.error = outcome.error;
            }
            options?.onEvent?.(event);
          }
          return outcome;
        });
        running.set(node.step.name, { promise, exclusive: exclusiveNode });
        pending.delete(node.step.name);
        scheduledAny = true;

        if (exclusiveNode) break;
      }

      if (running.size === 0) {
        if (pending.size === 0) {
          break;
        }
        return {
          status: "failed",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error:
            "Planner DAG has no runnable nodes; dependency graph may be invalid",
          stopReasonHint: "validation_error",
        };
      }

      if (!scheduledAny && running.size > 0) {
        // No-op; await active nodes below.
      }

      const completion = await Promise.race(
        Array.from(running.entries()).map(([name, handle]) =>
          handle.promise.then((outcome) => ({ name, outcome }))
        ),
      );

      running.delete(completion.name);
      const node = stepByName.get(completion.name);
      if (!node) {
        return {
          status: "failed",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error: `Unknown node "${completion.name}" completed`,
        };
      }

      if (completion.outcome.status === "completed") {
        mutableResults[node.step.name] = completion.outcome.result;
        const satisfaction = this.assessDependencySatisfaction(
          node.step,
          completion.outcome.result,
        );
        if (satisfaction.satisfied) {
          satisfied.add(node.step.name);
        } else {
          unsatisfied.set(node.step.name, satisfaction);
        }
        completedSteps++;
        continue;
      }

      if (completion.outcome.status === "halted") {
        return {
          status: "halted",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          resumeFrom: node.orderIndex,
          error: completion.outcome.error,
        };
      }

      if (typeof completion.outcome.result === "string") {
        mutableResults[node.step.name] = completion.outcome.result;
      }
      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error: completion.outcome.error,
        decomposition: completion.outcome.decomposition,
        stopReasonHint: completion.outcome.stopReasonHint,
      };
    }

    if (blockedStepNames.length > 0) {
      const primaryBlockedStep = blockedStepNames[0];
      const primaryAssessment = primaryBlockedStep
        ? unsatisfied.get(primaryBlockedStep)
        : undefined;
      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error:
          blockedStepNames.length === 1
            ? (primaryAssessment?.reason ??
              `Planner step "${primaryBlockedStep}" was blocked by an unmet dependency`)
            : (
                `Planner DAG blocked ${blockedStepNames.length} step(s) after unmet dependency ` +
                `contracts: ${blockedStepNames.join(", ")}`
              ),
        stopReasonHint: primaryAssessment?.stopReasonHint ?? "validation_error",
      };
    }

    return {
      status: "completed",
      context: { results: { ...mutableResults } },
      completedSteps,
      totalSteps,
    };
  }

  private resolveMaxParallelism(pipelineMaxParallelism?: number): number {
    if (!this.allowParallelSubtasks) return 1;
    const pipelineCap =
      typeof pipelineMaxParallelism === "number" &&
      Number.isFinite(pipelineMaxParallelism)
        ? Math.max(1, Math.floor(pipelineMaxParallelism))
        : this.maxParallelSubtasks;
    return Math.max(1, Math.min(this.maxParallelSubtasks, pipelineCap));
  }

  private validateSubagentHardCaps(
    steps: readonly PipelinePlannerStep[],
    edges: readonly WorkflowGraphEdge[],
  ): string | null {
    const subagentSteps = steps.filter(
      (step): step is PipelinePlannerSubagentStep =>
        step.stepType === "subagent_task",
    );
    if (subagentSteps.length === 0) return null;
    if (subagentSteps.length > this.maxFanoutPerTurn) {
      return (
        `Planner emitted ${subagentSteps.length} subagent tasks but maxFanoutPerTurn ` +
        `is ${this.maxFanoutPerTurn}`
      );
    }

    const subagentNames = new Set(subagentSteps.map((step) => step.name));
    const dependencies = new Map<string, Set<string>>();
    for (const step of subagentSteps) {
      const fromDependsOn = (step.dependsOn ?? []).filter((dep) =>
        subagentNames.has(dep),
      );
      dependencies.set(step.name, new Set(fromDependsOn));
    }
    for (const edge of edges) {
      if (!subagentNames.has(edge.from) || !subagentNames.has(edge.to)) continue;
      dependencies.get(edge.to)?.add(edge.from);
    }

    const visiting = new Set<string>();
    const memo = new Map<string, number>();
    const visit = (node: string): number => {
      if (memo.has(node)) return memo.get(node)!;
      if (visiting.has(node)) return Number.POSITIVE_INFINITY;
      visiting.add(node);
      let maxDepth = 1;
      for (const dep of dependencies.get(node) ?? []) {
        const depDepth = visit(dep);
        if (!Number.isFinite(depDepth)) {
          visiting.delete(node);
          return Number.POSITIVE_INFINITY;
        }
        maxDepth = Math.max(maxDepth, depDepth + 1);
      }
      visiting.delete(node);
      memo.set(node, maxDepth);
      return maxDepth;
    };

    let observedDepth = 1;
    for (const step of subagentSteps) {
      observedDepth = Math.max(observedDepth, visit(step.name));
      if (!Number.isFinite(observedDepth)) {
        return "Planner subagent dependency graph contains a cycle";
      }
    }
    return null;
  }

  private materializeDag(
    steps: readonly PipelinePlannerStep[],
    edges: readonly WorkflowGraphEdge[],
  ): { nodes: RuntimeNode[]; order: string[]; error?: string } {
    const stepByName = new Map<string, PipelinePlannerStep>();
    for (const step of steps) {
      if (stepByName.has(step.name)) {
        return {
          nodes: [],
          order: [],
          error: `Planner DAG has duplicate step name "${step.name}"`,
        };
      }
      stepByName.set(step.name, step);
    }

    const dependencyMap = new Map<string, Set<string>>();
    for (const step of steps) {
      dependencyMap.set(step.name, new Set(step.dependsOn ?? []));
    }
    for (const edge of edges) {
      if (!stepByName.has(edge.from) || !stepByName.has(edge.to)) continue;
      dependencyMap.get(edge.to)!.add(edge.from);
    }

    for (const [stepName, dependencies] of dependencyMap.entries()) {
      for (const dependency of dependencies) {
        if (!stepByName.has(dependency)) {
          return {
            nodes: [],
            order: [],
            error:
              `Planner DAG step "${stepName}" has unknown dependency "${dependency}"`,
          };
        }
      }
    }

    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const stepIndex = new Map<string, number>();
    for (const [index, step] of steps.entries()) {
      stepIndex.set(step.name, index);
      inDegree.set(step.name, dependencyMap.get(step.name)?.size ?? 0);
      outgoing.set(step.name, []);
    }
    for (const [nodeName, dependencies] of dependencyMap.entries()) {
      for (const dep of dependencies) {
        outgoing.get(dep)!.push(nodeName);
      }
    }

    const queue: string[] = [];
    for (const [nodeName, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(nodeName);
    }
    queue.sort((a, b) => (stepIndex.get(a) ?? 0) - (stepIndex.get(b) ?? 0));

    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const next of outgoing.get(node) ?? []) {
        const nextDegree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, nextDegree);
        if (nextDegree === 0) {
          queue.push(next);
        }
      }
      queue.sort((a, b) => (stepIndex.get(a) ?? 0) - (stepIndex.get(b) ?? 0));
    }

    if (order.length !== steps.length) {
      return {
        nodes: [],
        order: [],
        error: "Planner DAG contains a cycle",
      };
    }

    const nodes = steps.map((step, index) => ({
      step,
      dependencies: dependencyMap.get(step.name) ?? new Set<string>(),
      orderIndex: index,
    }));

    return { nodes, order };
  }

  private dependenciesSatisfied(
    node: RuntimeNode,
    completed: ReadonlySet<string>,
  ): boolean {
    for (const dependency of node.dependencies) {
      if (!completed.has(dependency)) return false;
    }
    return true;
  }

  private collectBlockedDependencies(
    node: RuntimeNode,
    unsatisfied: ReadonlyMap<string, DependencySatisfactionState>,
  ): readonly BlockedDependencyDetail[] {
    const blocked: BlockedDependencyDetail[] = [];
    for (const dependency of node.dependencies) {
      const state = unsatisfied.get(dependency);
      if (!state || state.satisfied) continue;
      blocked.push({
        stepName: dependency,
        reason:
          state.reason ??
          `Planner step "${dependency}" did not satisfy its dependency contract`,
        stopReasonHint: state.stopReasonHint ?? "validation_error",
      });
    }
    return blocked;
  }

  private buildDependencyBlockedError(
    stepName: string,
    blockedDependencies: readonly BlockedDependencyDetail[],
  ): string {
    const primary = blockedDependencies[0];
    if (!primary) {
      return `Planner step "${stepName}" was blocked by an unmet dependency`;
    }
    if (blockedDependencies.length === 1) {
      return (
        `Planner step "${stepName}" was blocked by unmet dependency ` +
        `"${primary.stepName}": ${primary.reason}`
      );
    }
    return (
      `Planner step "${stepName}" was blocked by ${blockedDependencies.length} unmet ` +
      `dependencies; first blocker "${primary.stepName}": ${primary.reason}`
    );
  }

  private buildDependencyBlockedResult(
    stepName: string,
    blockedDependencies: readonly BlockedDependencyDetail[],
    error: string,
    stopReasonHint: PipelineStopReasonHint,
  ): string {
    return safeStringify({
      status: "dependency_blocked",
      success: false,
      stepName,
      error,
      stopReasonHint,
      unmetDependencies: blockedDependencies.map((dependency) => ({
        stepName: dependency.stepName,
        reason: dependency.reason,
        stopReasonHint: dependency.stopReasonHint,
      })),
    });
  }

  private assessDependencySatisfaction(
    step: PipelinePlannerStep,
    result: string,
  ): DependencySatisfactionState {
    if (step.stepType === "deterministic_tool") {
      if (result.startsWith("SKIPPED:")) {
        if (step.onError === "skip") {
          return { satisfied: true };
        }
        const reason = result.slice("SKIPPED:".length).trim();
        return {
          satisfied: false,
          reason:
            reason.length > 0
              ? reason
              : `Planner step "${step.name}" was skipped`,
          stopReasonHint: "tool_error",
        };
      }
      if (didToolCallFail(false, result)) {
        return {
          satisfied: false,
          reason: extractToolFailureTextFromResult(result),
          stopReasonHint: "tool_error",
        };
      }
      return { satisfied: true };
    }
    if (step.stepType === "subagent_task") {
      if (result.startsWith("SKIPPED:")) {
        const reason = result.slice("SKIPPED:".length).trim();
        return {
          satisfied: false,
          reason:
            reason.length > 0
              ? reason
              : `Sub-agent step "${step.name}" was skipped`,
          stopReasonHint: "validation_error",
        };
      }
      try {
        const parsed = JSON.parse(result) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const obj = parsed as Record<string, unknown>;
          const status =
            typeof obj.status === "string" ? obj.status : undefined;
          const error =
            typeof obj.error === "string" && obj.error.trim().length > 0
              ? obj.error.trim()
              : undefined;
          if (
            obj.success === false ||
            status === "failed" ||
            status === "cancelled" ||
            status === "delegation_fallback" ||
            status === "needs_decomposition" ||
            status === "dependency_blocked"
          ) {
            return {
              satisfied: false,
              reason:
                error ??
                `Sub-agent step "${step.name}" returned unresolved status "${status ?? "unknown"}"`,
              stopReasonHint:
                (isPipelineStopReasonHint(obj.stopReasonHint)
                  ? obj.stopReasonHint
                  : undefined) ??
                (status === "cancelled"
                  ? "cancelled"
                  : "validation_error"),
            };
          }
          if (error) {
            return {
              satisfied: false,
              reason: error,
              stopReasonHint:
                isPipelineStopReasonHint(obj.stopReasonHint)
                  ? obj.stopReasonHint
                  : "validation_error",
            };
          }
        }
      } catch {
        if (didToolCallFail(false, result)) {
          return {
            satisfied: false,
            reason: extractToolFailureTextFromResult(result),
            stopReasonHint: "tool_error",
          };
        }
      }
    }
    return { satisfied: true };
  }

  private isExclusiveNode(step: PipelinePlannerStep): boolean {
    if (!this.allowParallelSubtasks) return true;
    if (step.stepType === "subagent_task") {
      return !step.canRunParallel;
    }
    return false;
  }

  private resolvePipelineTraceToolName(
    step: PipelinePlannerStep,
  ): string | undefined {
    if (step.stepType === "subagent_task") {
      return "execute_with_agent";
    }
    return undefined;
  }

  private buildPipelineTraceArgs(
    step: PipelinePlannerStep,
  ): Record<string, unknown> | undefined {
    if (step.stepType !== "subagent_task") {
      return undefined;
    }
    return {
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: [...step.acceptanceCriteria],
      requiredToolCapabilities: [...step.requiredToolCapabilities],
      contextRequirements: [...step.contextRequirements],
      maxBudgetHint: step.maxBudgetHint,
      canRunParallel: step.canRunParallel,
    };
  }

  private async executeNode(
    step: PipelinePlannerStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
    options?: PipelineExecutionOptions,
  ): Promise<NodeExecutionOutcome> {
    if (step.stepType === "deterministic_tool") {
      return this.executeDeterministicStep(step, pipeline, results, options);
    }
    if (step.stepType === "subagent_task") {
      return this.executeSubagentStep(step, pipeline, results, budgetTracker);
    }
    // Synthesis node is materialized as a no-op execution marker.
    return {
      status: "completed",
      result: safeStringify({
        deferred: true,
        type: "synthesis",
        objective: step.objective ?? null,
      }),
    };
  }

  private async executeDeterministicStep(
    step: PipelinePlannerDeterministicStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    options?: PipelineExecutionOptions,
  ): Promise<NodeExecutionOutcome> {
    const singleStep: PipelineStep = {
      name: step.name,
      tool: step.tool,
      args: step.args,
      onError: step.onError,
      maxRetries: step.maxRetries,
    };
    const stepPipeline: Pipeline = {
      id: `${pipeline.id}:${step.name}`,
      createdAt: pipeline.createdAt,
      context: { results: { ...results } },
      steps: [singleStep],
    };
    const outcome = await this.fallbackExecutor.execute(
      stepPipeline,
      0,
      options,
    );
    if (outcome.status === "halted") {
      return {
        status: "halted",
        error: outcome.error ?? `Deterministic step "${step.name}" halted`,
      };
    }
    if (outcome.status === "failed") {
      return {
        status: "failed",
        error:
          outcome.error ?? `Deterministic step "${step.name}" failed`,
        stopReasonHint: outcome.stopReasonHint ?? "tool_error",
      };
    }
    const result = outcome.context.results[step.name];
    if (typeof result === "string") {
      return { status: "completed", result };
    }
    return {
      status: "completed",
      result: safeStringify({
        status: outcome.status,
        result: result ?? null,
      }),
    };
  }

  private async executeSubagentStep(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
  ): Promise<NodeExecutionOutcome> {
    const subAgentManager = this.resolveSubAgentManager();
    if (!subAgentManager) {
      return {
        status: "failed",
        error:
          `Sub-agent manager unavailable for planner step "${step.name}"`,
        stopReasonHint: "tool_error",
      };
    }

    const parentSessionId = this.resolveParentSessionId(pipeline.id);
    const lifecycleEmitter = this.resolveLifecycleEmitter();
    lifecycleEmitter?.emit({
      type: "subagents.planned",
      timestamp: Date.now(),
      sessionId: parentSessionId,
      parentSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: step.name,
        objective: step.objective,
      },
    });

    const timeoutMs = this.parseBudgetHintMs(step.maxBudgetHint);
    const toolScope = this.deriveChildToolAllowlist(step, pipeline);
    if (toolScope.blockedReason) {
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          stage: "validation",
          reason: toolScope.blockedReason,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error: toolScope.blockedReason,
        stopReasonHint: "validation_error",
      };
    }
    if (toolScope.allowedTools.length === 0 && !toolScope.allowsToollessExecution) {
      const error =
        `No permitted child tools remain for step "${step.name}" after policy scoping`;
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          stage: "validation",
          reason: error,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error,
        stopReasonHint: "validation_error",
      };
    }
    const subagentTask = await this.buildSubagentTaskPrompt(
      step,
      pipeline,
      results,
      toolScope,
    );
    const plannerSteps = pipeline.plannerSteps ?? [];
    const subagentStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "subagent_task",
    ).length;
    const deterministicStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "deterministic_tool",
    ).length;
    const synthesisStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "synthesis",
    ).length;
    const stepComplexityScore = Math.min(
      10,
      Math.max(
        1,
        1 +
          step.acceptanceCriteria.length +
          step.requiredToolCapabilities.length +
          Math.min(3, step.contextRequirements.length),
      ),
    );
    const childContextClusterId = deriveDelegationContextClusterId({
      complexityScore: stepComplexityScore,
      subagentStepCount: Math.max(1, subagentStepCount),
      hasHistory: (pipeline.plannerContext?.history.length ?? 0) > 0,
      highRiskPlan: this.hasHighRiskCapabilities(step.requiredToolCapabilities),
    });
    const parentTurnId = `parent:${parentSessionId}:${pipeline.createdAt}`;
    const trajectoryTraceId = `trace:${parentSessionId}:${pipeline.createdAt}`;
    const retryAttempts = this.createRetryAttemptTracker();
    let attempt = 0;
    let lastFailure: SubagentFailureOutcome | null = null;
    const failureHistory: SubagentFailureOutcome[] = [];
    let taskPrompt = subagentTask.taskPrompt;

    while (true) {
      attempt += 1;
      const reservationBreach = budgetTracker.reserveSpawn();
      if (reservationBreach) {
        const breakerMessage =
          this.formatRequestTreeBudgetBreach(reservationBreach);
        lifecycleEmitter?.emit({
          type: "subagents.failed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          toolName: "execute_with_agent",
          payload: this.buildRequestTreeBudgetBreachPayload({
            stepName: step.name,
            attempt,
            breach: reservationBreach,
          }),
        });
        return {
          status: "failed",
          error:
            `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
          stopReasonHint: "budget_exceeded",
        };
      }
      let attemptOutcome: ExecuteSubagentAttemptOutcome =
        await this.executeSubagentAttempt({
        subAgentManager,
        step,
        pipeline,
        parentSessionId,
        parentRequest: pipeline.plannerContext?.parentRequest,
        lastValidationCode: lastFailure?.validationCode,
        timeoutMs,
        toolBudgetPerRequest: this.resolveSubagentToolBudgetPerRequest({
          timeoutMs,
          priorFailureClass: lastFailure?.failureClass,
        }),
        taskPrompt,
        diagnostics: subagentTask.diagnostics,
        tools: toolScope.allowedTools,
        lifecycleEmitter,
      });
      if (attemptOutcome.status === "completed") {
        const acceptanceProbeFailure =
          await this.runCompletedSubagentAcceptanceProbes({
            step,
            pipeline,
            results,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage,
            durationMs: attemptOutcome.durationMs,
            lifecycleEmitter,
          });
        if (acceptanceProbeFailure) {
          attemptOutcome = {
            status: "failed",
            failure: acceptanceProbeFailure,
          };
        }
      }
      const spawnedChild =
        attemptOutcome.status === "completed"
          ? true
          : Boolean(attemptOutcome.failure.childSessionId);
      budgetTracker.commitSpawnResult(spawnedChild);
      if (attemptOutcome.status === "completed") {
        this.recordSubagentTrajectory({
          traceId: trajectoryTraceId,
          turnId:
            `child:${step.name}:${attempt}:${attemptOutcome.subagentSessionId}`,
          parentTurnId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          step,
          stepComplexityScore,
          contextClusterId: childContextClusterId,
          plannerStepCount: plannerSteps.length,
          subagentStepCount,
          deterministicStepCount,
          synthesisStepCount,
          dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
          fanout: Math.max(1, subagentStepCount),
          tools: toolScope.allowedTools,
          timeoutMs,
          delegated: true,
          strategyArmId: "balanced",
          qualityProxy: 0.9,
          tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
          latencyMs: attemptOutcome.durationMs,
          errorCount: 0,
          metadata: {
            success: true,
            attempt,
            pipelineId: pipeline.id,
            toolCalls: attemptOutcome.toolCalls.length,
            stepName: step.name,
            providerName: attemptOutcome.providerName ?? "unknown",
          },
        });
        const usageBreach = budgetTracker.recordUsage(
          attemptOutcome.toolCalls.length,
          attemptOutcome.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${step.name}:${attempt}:${attemptOutcome.subagentSessionId}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            step,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.2,
            tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
            latencyMs: attemptOutcome.durationMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: step.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolName: "execute_with_agent",
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: step.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
            stopReasonHint: "budget_exceeded",
          };
        }
        lifecycleEmitter?.emit({
          type: "subagents.completed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: step.name,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls.length,
            providerName: attemptOutcome.providerName,
          },
        });
        return {
          status: "completed",
          result: safeStringify({
            status: "completed",
            subagentSessionId: attemptOutcome.subagentSessionId,
            output: attemptOutcome.output,
            success: true,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage ?? null,
            providerName: attemptOutcome.providerName ?? null,
            attempts: attempt,
            retryPolicy: retryAttempts,
          }),
        };
      }

      lastFailure = attemptOutcome.failure;
      failureHistory.push(lastFailure);
      if (spawnedChild) {
        const usageBreach = budgetTracker.recordUsage(
          lastFailure.toolCallCount ?? 0,
          lastFailure.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${step.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            step,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.1,
            tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
            latencyMs: lastFailure.durationMs ?? timeoutMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: step.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            toolName: "execute_with_agent",
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: step.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
            stopReasonHint: "budget_exceeded",
          };
        }
      }
      const retryRule = SUBAGENT_RETRY_POLICY[lastFailure.failureClass];
      const retriesUsed = retryAttempts[lastFailure.failureClass];
      const shouldRetry =
        lastFailure.validationCode !== "blocked_phase_output" &&
        retriesUsed < retryRule.maxRetries;
      const retryAttempt = retriesUsed + 1;
      const retryDelayMs = shouldRetry
        ? this.computeRetryDelayMs(retryRule, retryAttempt)
        : 0;

      this.recordSubagentTrajectory({
        traceId: trajectoryTraceId,
        turnId: `child:${step.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}`,
        parentTurnId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        step,
        stepComplexityScore,
        contextClusterId: childContextClusterId,
        plannerStepCount: plannerSteps.length,
        subagentStepCount,
        deterministicStepCount,
        synthesisStepCount,
        dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
        fanout: Math.max(1, subagentStepCount),
        tools: toolScope.allowedTools,
        timeoutMs,
        delegated: true,
        strategyArmId: "balanced",
        qualityProxy: shouldRetry ? 0.3 : 0.15,
        tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
        latencyMs: lastFailure.durationMs ?? timeoutMs,
        errorCount: 1,
        errorClass: lastFailure.failureClass,
        metadata: {
          success: false,
          attempt,
          retrying: shouldRetry,
          pipelineId: pipeline.id,
          stepName: step.name,
        },
      });

      if (shouldRetry) {
        retryAttempts[lastFailure.failureClass] = retryAttempt;
        taskPrompt = this.buildRetryTaskPrompt(
          taskPrompt,
          step,
          toolScope.allowedTools,
          lastFailure,
          retryAttempt,
        );
        lifecycleEmitter?.emit({
          type: "subagents.progress",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: lastFailure.childSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: step.name,
            phase: "retry_backoff",
            output: lastFailure.message,
            durationMs: lastFailure.durationMs,
            failureClass: lastFailure.failureClass,
            validationCode: lastFailure.validationCode,
            decomposition: lastFailure.decomposition,
            attempt,
            retrying: true,
            retryAttempt,
            maxRetries: retryRule.maxRetries,
            delayMs: retryDelayMs,
            nextRetryDelayMs: retryDelayMs,
          },
        });
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
        continue;
      }

      lifecycleEmitter?.emit({
        type:
          lastFailure.failureClass === "cancelled"
            ? "subagents.cancelled"
            : "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          output: lastFailure.message,
          durationMs: lastFailure.durationMs,
          failureClass: lastFailure.failureClass,
          validationCode: lastFailure.validationCode,
          decomposition: lastFailure.decomposition,
          attempt,
          retrying: false,
          retryAttempt,
          maxRetries: retryRule.maxRetries,
          nextRetryDelayMs: retryDelayMs,
        },
      });

      if (
        lastFailure.failureClass === "needs_decomposition" &&
        lastFailure.decomposition
      ) {
        return {
          status: "failed",
          error:
            `Sub-agent step "${step.name}" requires decomposition: ${lastFailure.message}`,
          stopReasonHint: lastFailure.stopReasonHint,
          decomposition: lastFailure.decomposition,
          result: safeStringify({
            status: "needs_decomposition",
            success: false,
            delegated: false,
            recoveredViaParentFallback: false,
            failureClass: lastFailure.failureClass,
            error: lastFailure.message,
            stopReasonHint: lastFailure.stopReasonHint,
            failureHistory: failureHistory.map((failure) => ({
              failureClass: failure.failureClass,
              validationCode: failure.validationCode ?? null,
              message: failure.message,
            })),
            decomposition: lastFailure.decomposition,
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      if (this.fallbackBehavior === "continue_without_delegation") {
        return {
          status: "completed",
          result: safeStringify({
            status: "delegation_fallback",
            success: false,
            delegated: false,
            recoveredViaParentFallback: true,
            failureClass: lastFailure.failureClass,
            error: lastFailure.message,
            stopReasonHint: lastFailure.stopReasonHint,
            failureHistory: failureHistory.map((failure) => ({
              failureClass: failure.failureClass,
              validationCode: failure.validationCode ?? null,
              message: failure.message,
            })),
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      return {
        status: "failed",
        error: summarizeSubagentFailureHistory(step.name, failureHistory),
        stopReasonHint: lastFailure.stopReasonHint,
      };
    }
  }

  private hasHighRiskCapabilities(capabilities: readonly string[]): boolean {
    for (const capability of capabilities) {
      const normalized = capability.trim().toLowerCase();
      if (!normalized) continue;
      if (
        normalized.startsWith("wallet.") ||
        normalized.startsWith("solana.") ||
        normalized.startsWith("agenc.") ||
        normalized.startsWith("desktop.") ||
        normalized === "system.delete" ||
        normalized === "system.execute" ||
        normalized === "system.open" ||
        normalized === "system.applescript" ||
        normalized === "system.notification"
      ) {
        return true;
      }
    }
    return false;
  }

  private recordSubagentTrajectory(input: {
    traceId: string;
    turnId: string;
    parentTurnId: string;
    parentSessionId: string;
    subagentSessionId?: string;
    step: PipelinePlannerSubagentStep;
    stepComplexityScore: number;
    contextClusterId: string;
    plannerStepCount: number;
    subagentStepCount: number;
    deterministicStepCount: number;
    synthesisStepCount: number;
    dependencyDepth: number;
    fanout: number;
    tools: readonly string[];
    timeoutMs: number;
    delegated: boolean;
    strategyArmId: string;
    qualityProxy: number;
    tokenCost: number;
    latencyMs: number;
    errorCount: number;
    errorClass?: string;
    metadata?: Readonly<Record<string, string | number | boolean>>;
  }): void {
    const sink = this.resolveTrajectorySink();
    if (!sink) return;

    const reward = computeDelegationFinalReward({
      qualityProxy: input.qualityProxy,
      tokenCost: input.tokenCost,
      latencyMs: input.latencyMs,
      errorCount: input.errorCount,
    });

    sink.record({
      schemaVersion: 1,
      traceId: input.traceId,
      turnId: input.turnId,
      parentTurnId: input.parentTurnId,
      turnType: "child",
      timestampMs: Date.now(),
      stateFeatures: {
        sessionId: input.subagentSessionId ?? input.parentSessionId,
        contextClusterId: input.contextClusterId,
        complexityScore: input.stepComplexityScore,
        plannerStepCount: input.plannerStepCount,
        subagentStepCount: input.subagentStepCount,
        deterministicStepCount: input.deterministicStepCount,
        synthesisStepCount: input.synthesisStepCount,
        dependencyDepth: Math.max(1, input.dependencyDepth),
        fanout: Math.max(1, input.fanout),
      },
      action: {
        delegated: input.delegated,
        strategyArmId: input.strategyArmId,
        threshold: 0,
        selectedTools: [...input.tools],
        childConfig: {
          maxDepth: this.maxDepth,
          maxFanoutPerTurn: this.maxFanoutPerTurn,
          timeoutMs: input.timeoutMs,
        },
      },
      immediateOutcome: {
        qualityProxy: input.qualityProxy,
        tokenCost: input.tokenCost,
        latencyMs: input.latencyMs,
        errorCount: input.errorCount,
        ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      },
      finalReward: reward,
      metadata: {
        stepName: input.step.name,
        objectiveChars: input.step.objective.length,
        ...(input.metadata ?? {}),
      },
    });
  }

  private parseBudgetHintMs(hint: string): number {
    return resolveDelegationBudgetHintMs(
      hint,
      this.defaultSubagentTimeoutMs,
    );
  }

  private resolveSubagentToolBudgetPerRequest(params: {
    readonly timeoutMs: number;
    readonly priorFailureClass?: SubagentFailureClass;
  }): number {
    const baseBudget = Math.max(
      DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET,
      Math.ceil(params.timeoutMs / PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL),
    );
    const boostedBudget =
      params.priorFailureClass === "budget_exceeded"
        ? Math.ceil(
            baseBudget * BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER,
          )
        : baseBudget;
    return Math.min(MAX_PLANNED_SUBAGENT_TOOL_BUDGET, boostedBudget);
  }

  private createRetryAttemptTracker(): Record<SubagentFailureClass, number> {
    return {
      timeout: 0,
      budget_exceeded: 0,
      tool_misuse: 0,
      malformed_result_contract: 0,
      needs_decomposition: 0,
      invalid_input: 0,
      transient_provider_error: 0,
      cancelled: 0,
      spawn_error: 0,
      unknown: 0,
    };
  }

  private computeRetryDelayMs(
    rule: SubagentRetryRule,
    retryAttempt: number,
  ): number {
    if (rule.maxRetries <= 0 || rule.baseDelayMs <= 0) return 0;
    const scaled = rule.baseDelayMs * Math.max(1, retryAttempt);
    return Math.max(0, Math.min(rule.maxDelayMs, scaled));
  }

  private classifySpawnFailure(message: string): SubagentFailureClass {
    const lower = message.toLowerCase();
    if (
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("deadline exceeded")
    ) {
      return "timeout";
    }
    if (
      lower.includes("temporarily unavailable") ||
      lower.includes("resource temporarily unavailable") ||
      lower.includes("connection reset") ||
      lower.includes("econnreset") ||
      lower.includes("429") ||
      lower.includes("rate limit")
    ) {
      return "transient_provider_error";
    }
    return "spawn_error";
  }

  private classifySubagentFailureMessage(message: string): SubagentFailureClass {
    const lower = message.toLowerCase();
    if (
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("deadline exceeded")
    ) {
      return "timeout";
    }
    if (lower.includes("cancelled") || lower.includes("canceled")) {
      return "cancelled";
    }
    if (
      lower.includes("provider error") ||
      lower.includes("fetch failed") ||
      lower.includes("temporarily unavailable") ||
      lower.includes("connection reset") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("rate limit") ||
      lower.includes("429")
    ) {
      return "transient_provider_error";
    }
    if (
      lower.includes("missing required argument") ||
      lower.includes("invalid argument") ||
      lower.includes("unknown tool") ||
      lower.includes("tool call validation") ||
      lower.includes("command must be one executable token/path") ||
      lower.includes("shell snippets")
    ) {
      return "tool_misuse";
    }
    if (
      lower.includes("malformed result contract") ||
      lower.includes("expected json object")
    ) {
      return "malformed_result_contract";
    }
    return "unknown";
  }

  private classifySubagentFailureResult(
    result: Pick<SubAgentResult, "output" | "stopReason" | "stopReasonDetail">,
  ): SubagentFailureClass {
    if (result.stopReason === "timeout") return "timeout";
    if (result.stopReason === "budget_exceeded") return "budget_exceeded";
    if (result.stopReason === "cancelled") return "cancelled";
    if (
      result.stopReason === "provider_error" ||
      result.stopReason === "authentication_error" ||
      result.stopReason === "rate_limited"
    ) {
      return "transient_provider_error";
    }
    const message =
      typeof result.stopReasonDetail === "string" &&
        result.stopReasonDetail.trim().length > 0
        ? result.stopReasonDetail
        : (typeof result.output === "string" ? result.output : "");
    return this.classifySubagentFailureMessage(message);
  }

  private resolveEffectiveDelegatedWorkingDirectory(input: {
    readonly task?: string;
    readonly objective?: string;
    readonly inputContract?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly contextRequirements?: readonly string[];
  }) {
    const delegatedWorkingDirectory = resolveDelegatedWorkingDirectory(input);
    if (!delegatedWorkingDirectory) {
      return undefined;
    }

    return {
      ...delegatedWorkingDirectory,
      path: resolveDelegatedWorkingDirectoryPath(
        delegatedWorkingDirectory.path,
        this.resolveHostWorkspaceRoot() ?? undefined,
      ),
    };
  }

  private isAnchoredDelegatedWorkingDirectory(path: string): boolean {
    const trimmed = path.trim();
    return (
      trimmed.startsWith("/") ||
      trimmed.startsWith("~/") ||
      trimmed.startsWith("~\\")
    );
  }

  private normalizeAnchoredDelegatedWorkingDirectory(
    resolution?: DelegatedWorkingDirectoryResolution,
  ): DelegatedWorkingDirectoryResolution | undefined {
    if (!resolution) return undefined;
    if (!this.isAnchoredDelegatedWorkingDirectory(resolution.path)) {
      return undefined;
    }
    return {
      ...resolution,
      path: resolveDelegatedWorkingDirectoryPath(
        resolution.path,
        this.resolveHostWorkspaceRoot() ?? undefined,
      ),
    };
  }

  private resolvePlannerContextDelegatedWorkingDirectory(
    pipeline: Pipeline,
  ): DelegatedWorkingDirectoryResolution | undefined {
    const plannerContext = pipeline.plannerContext;
    if (!plannerContext) return undefined;
    const history = plannerContext.history ?? [];
    const toolOutputs = plannerContext.toolOutputs ?? [];
    return this.normalizeAnchoredDelegatedWorkingDirectory(
      resolveDelegatedWorkingDirectory({
        task: plannerContext.parentRequest,
        acceptanceCriteria: [
          ...history.map((entry) => entry.content),
          ...toolOutputs.map((entry) => entry.content),
        ],
      }),
    );
  }

  private resolveInheritedDelegatedWorkingDirectory(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): DelegatedWorkingDirectoryResolution | undefined {
    const plannerSteps = pipeline.plannerSteps ?? [];
    const plannerStepByName = new Map(
      plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
    );
    const dependencyQueue = [...(step.dependsOn ?? [])];
    const visited = new Set<string>();
    const candidates = new Map<string, DelegatedWorkingDirectoryResolution>();

    while (dependencyQueue.length > 0) {
      const dependencyName = dependencyQueue.shift();
      if (!dependencyName || visited.has(dependencyName)) continue;
      visited.add(dependencyName);
      const dependencyStep = plannerStepByName.get(dependencyName);
      if (!dependencyStep) continue;
      if (dependencyStep.stepType === "subagent_task") {
        const candidate = this.normalizeAnchoredDelegatedWorkingDirectory(
          this.resolveEffectiveDelegatedWorkingDirectory({
            task: dependencyStep.name,
            objective: dependencyStep.objective,
            inputContract: dependencyStep.inputContract,
            acceptanceCriteria: dependencyStep.acceptanceCriteria,
            contextRequirements: dependencyStep.contextRequirements,
          }),
        );
        if (candidate) {
          candidates.set(candidate.path, candidate);
        }
      }
      for (const nestedDependency of dependencyStep.dependsOn ?? []) {
        dependencyQueue.push(nestedDependency);
      }
    }

    const dependencyCandidateCount = candidates.size;
    if (dependencyCandidateCount === 1) {
      return [...candidates.values()][0];
    }

    if (dependencyCandidateCount === 0) {
      for (const plannerStep of plannerSteps) {
        if (plannerStep.stepType !== "subagent_task") continue;
        const candidate = this.normalizeAnchoredDelegatedWorkingDirectory(
          this.resolveEffectiveDelegatedWorkingDirectory({
            task: plannerStep.name,
            objective: plannerStep.objective,
            inputContract: plannerStep.inputContract,
            acceptanceCriteria: plannerStep.acceptanceCriteria,
            contextRequirements: plannerStep.contextRequirements,
          }),
        );
        if (candidate) {
          candidates.set(candidate.path, candidate);
        }
      }
      const globalCandidateCount = candidates.size;
      if (globalCandidateCount === 1) {
        return [...candidates.values()][0];
      }
    }

    return this.resolvePlannerContextDelegatedWorkingDirectory(pipeline);
  }

  private resolvePlannerStepWorkingDirectory(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): DelegatedWorkingDirectoryResolution | undefined {
    const direct = this.resolveEffectiveDelegatedWorkingDirectory({
      task: step.name,
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: step.acceptanceCriteria,
      contextRequirements: step.contextRequirements,
    });
    const anchoredDirect =
      this.normalizeAnchoredDelegatedWorkingDirectory(direct);
    if (anchoredDirect) {
      return anchoredDirect;
    }

    const inherited = this.resolveInheritedDelegatedWorkingDirectory(
      step,
      pipeline,
    );
    if (!direct) {
      return inherited;
    }

    const rawPath = direct.path.trim();
    if (rawPath.length === 0) {
      return inherited;
    }

    if (inherited) {
      return {
        path: resolvePath(inherited.path, rawPath),
        source: direct.source,
      };
    }

    const hostWorkspaceRoot = this.resolveHostWorkspaceRoot() ?? undefined;
    if (hostWorkspaceRoot) {
      return {
        path: resolvePath(hostWorkspaceRoot, rawPath),
        source: direct.source,
      };
    }

    return undefined;
  }

  private buildEffectiveContextRequirements(
    step: PipelinePlannerSubagentStep,
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    if (
      typeof delegatedWorkingDirectory !== "string" ||
      delegatedWorkingDirectory.trim().length === 0
    ) {
      return step.contextRequirements;
    }

    const normalizedRequirement = `cwd=${delegatedWorkingDirectory}`;
    let replaced = false;
    const rewritten = step.contextRequirements
      .map((requirement) => {
        if (
          /^(?:cwd|working(?:[_ -]?directory))\s*(?:=|:)\s*(.+)$/i.test(
            requirement,
          )
        ) {
          replaced = true;
          return normalizedRequirement;
        }
        return requirement;
      })
      .filter((requirement, index, entries) =>
        requirement.length > 0 && entries.indexOf(requirement) === index
      );

    if (replaced) {
      return rewritten;
    }

    return [normalizedRequirement, ...rewritten];
  }

  private async executeSubagentAttempt(
    input: ExecuteSubagentAttemptParams,
  ): Promise<ExecuteSubagentAttemptOutcome> {
    const scopeAssessment = assessDelegationScope({
      objective: input.step.objective,
      inputContract: input.step.inputContract,
      acceptanceCriteria: input.step.acceptanceCriteria,
      requiredToolCapabilities: input.step.requiredToolCapabilities,
    });
    if (!scopeAssessment.ok) {
      return {
        status: "failed",
        failure: {
          failureClass: "needs_decomposition",
          message:
            `Refusing overloaded subagent step "${input.step.name}": ${scopeAssessment.error}`,
          decomposition: scopeAssessment.decomposition,
          stopReasonHint: "validation_error",
        },
      };
    }

    const delegatedWorkingDirectory = this.resolvePlannerStepWorkingDirectory(
      input.step,
      input.pipeline,
    );
    const effectiveStep = {
      ...input.step,
      contextRequirements: this.buildEffectiveContextRequirements(
        input.step,
        delegatedWorkingDirectory?.path,
      ),
    } satisfies PipelinePlannerSubagentStep;
    const effectiveDelegationSpec = this.buildEffectiveDelegationSpec(
      effectiveStep,
      input.pipeline,
      {
        parentRequest: input.parentRequest,
        lastValidationCode: input.lastValidationCode,
        delegatedWorkingDirectory: delegatedWorkingDirectory?.path,
      },
    );
    let childSessionId: string;
    try {
      const workingDirectory = delegatedWorkingDirectory?.path;
      childSessionId = await input.subAgentManager.spawn({
        parentSessionId: input.parentSessionId,
        task: input.taskPrompt,
        timeoutMs: input.timeoutMs,
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(delegatedWorkingDirectory
          ? { workingDirectorySource: delegatedWorkingDirectory.source }
          : {}),
        tools: input.tools,
        requiredCapabilities: effectiveStep.requiredToolCapabilities,
        requireToolCall: specRequiresSuccessfulToolEvidence({
            objective: effectiveStep.objective,
            inputContract: effectiveStep.inputContract,
            acceptanceCriteria:
              effectiveDelegationSpec.acceptanceCriteria,
            requiredToolCapabilities: effectiveStep.requiredToolCapabilities,
            tools: input.tools,
          }),
        delegationSpec: effectiveDelegationSpec,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = this.classifySpawnFailure(message);
      return {
        status: "failed",
        failure: {
          failureClass,
          message:
            `Failed to spawn subagent for step "${input.step.name}": ${message}`,
          stopReasonHint: SUBAGENT_FAILURE_STOP_REASON[failureClass],
        },
      };
    }

    input.lifecycleEmitter?.emit({
      type: "subagents.spawned",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
        timeoutMs: input.timeoutMs,
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        contextCuration: input.diagnostics,
        ...(this.unsafeBenchmarkMode ? { unsafeBenchmarkMode: true } : {}),
        ...(delegatedWorkingDirectory
          ? {
            workingDirectory: delegatedWorkingDirectory.path,
            workingDirectorySource: delegatedWorkingDirectory.source,
          }
          : {}),
      },
    });
    input.lifecycleEmitter?.emit({
      type: "subagents.started",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
      },
    });

    while (true) {
      const result = input.subAgentManager.getResult(childSessionId);
      if (!result) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (result.success) {
        const contractValidation = validateDelegatedOutputContract({
          spec: effectiveDelegationSpec,
          output: result.output,
          toolCalls: result.toolCalls,
          providerEvidence: result.providerEvidence,
          unsafeBenchmarkMode: this.unsafeBenchmarkMode,
        });
        if (contractValidation.error) {
          return {
            status: "failed",
            failure: {
              failureClass: "malformed_result_contract",
              message: contractValidation.error,
              validationCode: contractValidation.code,
              stopReasonHint:
                SUBAGENT_FAILURE_STOP_REASON.malformed_result_contract,
              childSessionId,
              durationMs: result.durationMs,
              toolCallCount: result.toolCalls.length,
              tokenUsage: result.tokenUsage,
            },
          };
        }

        return {
          status: "completed",
          subagentSessionId: childSessionId,
          output: result.output,
          durationMs: result.durationMs,
          toolCalls: result.toolCalls,
          tokenUsage: result.tokenUsage,
          providerName: result.providerName,
        };
      }

      const message =
        typeof result.stopReasonDetail === "string" &&
          result.stopReasonDetail.trim().length > 0
          ? result.stopReasonDetail
          : (
              typeof result.output === "string" && result.output.length > 0
                ? result.output
                : "unknown sub-agent failure"
            );
      const initialFailureClass = this.classifySubagentFailureResult(result);
      const contractValidation =
        result.stopReason === "validation_error" && !result.validationCode
          ? validateDelegatedOutputContract({
            spec: effectiveDelegationSpec,
            output: result.output,
            toolCalls: result.toolCalls,
            providerEvidence: result.providerEvidence,
            unsafeBenchmarkMode: this.unsafeBenchmarkMode,
          })
          : undefined;
      const validationCode = result.validationCode ?? contractValidation?.code;
      const failureClass =
        validationCode !== undefined ||
          initialFailureClass === "malformed_result_contract"
          ? "malformed_result_contract"
          : initialFailureClass;
      const inheritedStopReasonHint = toPipelineStopReasonHint(result.stopReason);
      return {
        status: "failed",
        failure: {
          failureClass,
          message: contractValidation?.error ?? message,
          validationCode,
          stopReasonHint:
            inheritedStopReasonHint ?? SUBAGENT_FAILURE_STOP_REASON[failureClass],
          childSessionId,
          durationMs: result.durationMs,
          toolCallCount: result.toolCalls.length,
          tokenUsage: result.tokenUsage,
        },
      };
    }
  }

  private async runCompletedSubagentAcceptanceProbes(params: {
    readonly step: PipelinePlannerSubagentStep;
    readonly pipeline: Pipeline;
    readonly results: Record<string, string>;
    readonly parentSessionId: string;
    readonly subagentSessionId: string;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly durationMs: number;
    readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  }): Promise<SubagentFailureOutcome | undefined> {
    const probes = this.buildSubagentAcceptanceProbePlans(
      params.step,
      params.pipeline,
      params.toolCalls,
    );
    if (probes.length === 0) {
      return undefined;
    }

    for (const probe of probes) {
      const probeArgs = probe.step.args as {
        readonly command?: string;
        readonly args?: readonly string[];
        readonly cwd?: string;
      };
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.started",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
        },
      });

      const startedAt = Date.now();
      const outcome = await this.executeDeterministicStep(
        probe.step,
        params.pipeline,
        params.results,
      );
      const durationMs = Date.now() - startedAt;

      if (outcome.status === "completed") {
        params.lifecycleEmitter?.emit({
          type: "subagents.acceptance_probe.completed",
          timestamp: Date.now(),
          sessionId: params.parentSessionId,
          parentSessionId: params.parentSessionId,
          subagentSessionId: params.subagentSessionId,
          toolName: probe.step.tool,
          payload: {
            stepName: params.step.name,
            probeName: probe.name,
            category: probe.category,
            durationMs,
            result: outcome.result,
          },
        });
        continue;
      }

      const commandSummary = this.renderDeterministicCommandSummary(probe.step);
      const cwdSummary =
        typeof probeArgs.cwd === "string" && probeArgs.cwd.trim().length > 0
          ? ` in \`${this.redactSensitiveData(probeArgs.cwd)}\``
          : "";
      const failureMessage =
        `Parent-side deterministic acceptance probe failed for step "${params.step.name}" ` +
        `(${probe.category})${cwdSummary}: ${commandSummary}. ${outcome.error}`;
      const probeStopReasonHint =
        outcome.status === "failed" ? outcome.stopReasonHint : undefined;
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.failed",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          durationMs,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
          error: outcome.error,
        },
      });
      return {
        failureClass: "malformed_result_contract",
        message: failureMessage,
        validationCode: "acceptance_probe_failed",
        stopReasonHint: probeStopReasonHint ?? "validation_error",
        childSessionId: params.subagentSessionId,
        durationMs: params.durationMs,
        toolCallCount: params.toolCalls.length,
        tokenUsage: params.tokenUsage,
      };
    }

    return undefined;
  }

  private buildSubagentAcceptanceProbePlans(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    toolCalls: SubAgentResult["toolCalls"],
  ): readonly AcceptanceProbePlan[] {
    if (!this.hasCompletedNodeInstallDependency(step, pipeline)) {
      return [];
    }

    const verificationCategories = this.collectReachableVerificationCategories(
      step,
      pipeline,
    );
    if (verificationCategories.size === 0) {
      return [];
    }

    const delegatedWorkingDirectory = this.resolvePlannerStepWorkingDirectory(
      step,
      pipeline,
    );
    const packageDirectories = this.collectAcceptanceProbePackageDirectories(
      toolCalls,
      delegatedWorkingDirectory?.path,
    );
    if (packageDirectories.length === 0) {
      return [];
    }

    const plans: AcceptanceProbePlan[] = [];
    const seenCommands = new Set<string>();
    const pushProbe = (
      category: AcceptanceProbeCategory,
      scriptName: string,
      cwd: string,
    ): void => {
      const stepName = `acceptance_probe_${category}_${plans.length + 1}`;
      const commandKey = `${cwd}::${scriptName}`;
      if (seenCommands.has(commandKey)) {
        return;
      }
      seenCommands.add(commandKey);
      plans.push({
        name: stepName,
        category,
        step: {
          name: stepName,
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", scriptName],
            cwd,
          },
          onError: "abort",
        },
      });
    };

    for (const packageDirectory of packageDirectories) {
      const manifest = this.readPackageManifest(packageDirectory);
      const scripts = this.readPackageScripts(manifest);
      if (!scripts) continue;

      if (verificationCategories.has("build") && scripts.build) {
        pushProbe("build", "build", packageDirectory);
      }
      if (verificationCategories.has("typecheck") && scripts.typecheck) {
        pushProbe("typecheck", "typecheck", packageDirectory);
      }
      if (verificationCategories.has("lint") && scripts.lint) {
        pushProbe("lint", "lint", packageDirectory);
      }
      if (
        verificationCategories.has("test") &&
        this.shouldRunAcceptanceTestProbe(step, toolCalls, scripts.test)
      ) {
        pushProbe("test", "test", packageDirectory);
      }
    }

    return plans;
  }

  private collectAcceptanceProbePackageDirectories(
    toolCalls: SubAgentResult["toolCalls"],
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    const directories: string[] = [];
    const pushDirectory = (value: string | undefined): void => {
      const normalized = value?.trim().replace(/\\/g, "/");
      if (!normalized || directories.includes(normalized)) {
        return;
      }
      directories.push(normalized);
    };

    for (const filePath of this.collectMutatedFilePaths(toolCalls)) {
      pushDirectory(
        this.resolvePackageDirectoryFromFilePath(
          filePath,
          delegatedWorkingDirectory,
        ),
      );
    }

    if (
      directories.length === 0 &&
      delegatedWorkingDirectory &&
      this.hasFileMutationToolCalls(toolCalls)
    ) {
      pushDirectory(
        this.findNearestPackageDirectory(
          resolvePath(delegatedWorkingDirectory),
        ),
      );
    }

    return directories;
  }

  private collectMutatedFilePaths(
    toolCalls: readonly SubAgentResult["toolCalls"][number][],
  ): readonly string[] {
    const paths: string[] = [];
    const pushPath = (value: unknown): void => {
      if (typeof value !== "string") return;
      const normalized = value.trim();
      if (normalized.length === 0 || paths.includes(normalized)) {
        return;
      }
      paths.push(normalized);
    };

    for (const toolCall of toolCalls) {
      if (
        !toolCall ||
        typeof toolCall !== "object" ||
        typeof toolCall.name !== "string"
      ) {
        continue;
      }
      const args =
        toolCall.args &&
        typeof toolCall.args === "object" &&
        !Array.isArray(toolCall.args)
          ? toolCall.args as Record<string, unknown>
          : undefined;
      if (!args) continue;

      if (
        toolCall.name === "system.writeFile" ||
        toolCall.name === "system.appendFile"
      ) {
        pushPath(args.path);
        continue;
      }

      if (toolCall.name !== "desktop.text_editor") {
        continue;
      }
      const action =
        typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
      if (
        action === "create" ||
        action === "insert" ||
        action === "str_replace"
      ) {
        pushPath(args.filePath);
      }
    }

    return paths;
  }

  private hasFileMutationToolCalls(
    toolCalls: readonly SubAgentResult["toolCalls"][number][],
  ): boolean {
    return this.collectMutatedFilePaths(toolCalls).length > 0;
  }

  private resolvePackageDirectoryFromFilePath(
    filePath: string,
    delegatedWorkingDirectory?: string,
  ): string | undefined {
    const trimmed = filePath.trim();
    if (trimmed.length === 0) return undefined;
    if (!trimmed.startsWith("/") && !delegatedWorkingDirectory) {
      return undefined;
    }

    const absolutePath = trimmed.startsWith("/")
      ? resolvePath(trimmed)
      : resolvePath(delegatedWorkingDirectory!, trimmed);
    return this.findNearestPackageDirectory(dirname(absolutePath));
  }

  private findNearestPackageDirectory(startDirectory: string): string | undefined {
    let current = resolvePath(startDirectory);
    while (true) {
      const manifestPath = resolvePath(current, "package.json");
      if (existsSync(manifestPath) && !this.isWorkspaceRootManifest(manifestPath)) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private isWorkspaceRootManifest(manifestPath: string): boolean {
    const manifest = this.readJsonFileObject(manifestPath);
    if (!manifest) return false;
    return Array.isArray(manifest.workspaces) ||
      (
        manifest.workspaces !== undefined &&
        typeof manifest.workspaces === "object" &&
        !Array.isArray(manifest.workspaces)
      );
  }

  private readPackageManifest(
    packageDirectory: string,
  ): Record<string, unknown> | undefined {
    return this.readJsonFileObject(resolvePath(packageDirectory, "package.json"));
  }

  private readPackageScripts(
    manifest: Record<string, unknown> | undefined,
  ): Partial<Record<AcceptanceProbeCategory, string>> | undefined {
    if (!manifest) return undefined;
    const rawScripts =
      manifest.scripts &&
      typeof manifest.scripts === "object" &&
      !Array.isArray(manifest.scripts)
        ? manifest.scripts as Record<string, unknown>
        : undefined;
    if (!rawScripts) return undefined;

    const scripts: Partial<Record<AcceptanceProbeCategory, string>> = {};
    for (const category of ["build", "typecheck", "lint", "test"] as const) {
      const value = rawScripts[category];
      if (typeof value === "string" && value.trim().length > 0) {
        scripts[category] = value.trim();
      }
    }
    return Object.keys(scripts).length > 0 ? scripts : undefined;
  }

  private readJsonFileObject(path: string): Record<string, unknown> | undefined {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Best-effort acceptance probing should never crash orchestration.
    }
    return undefined;
  }

  private shouldRunAcceptanceTestProbe(
    step: PipelinePlannerSubagentStep,
    toolCalls: readonly SubAgentResult["toolCalls"][number][],
    testScript: string | undefined,
  ): boolean {
    if (!testScript || PLACEHOLDER_TEST_SCRIPT_RE.test(testScript)) {
      return false;
    }
    const stepText = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
    ].join(" ");
    if (/\b(?:test|tests|vitest|jest|spec|coverage)\b/i.test(stepText)) {
      return true;
    }
    return this.collectMutatedFilePaths(toolCalls).some((path) =>
      TEST_ARTIFACT_PATH_RE.test(path)
    );
  }

  private hasCompletedNodeInstallDependency(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): boolean {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0) {
      return false;
    }
    const stepByName = new Map(
      plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
    );
    const queue = [...(step.dependsOn ?? [])];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const dependencyName = queue.shift();
      if (!dependencyName || visited.has(dependencyName)) continue;
      visited.add(dependencyName);
      const dependency = stepByName.get(dependencyName);
      if (!dependency) continue;
      if (this.isNodeInstallPlannerStep(dependency)) {
        return true;
      }
      for (const ancestor of dependency.dependsOn ?? []) {
        if (!visited.has(ancestor)) {
          queue.push(ancestor);
        }
      }
    }
    return false;
  }

  private collectReachableVerificationCategories(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): ReadonlySet<AcceptanceProbeCategory> {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0) {
      return new Set();
    }

    const dependentsByName = new Map<string, PipelinePlannerStep[]>();
    for (const plannerStep of plannerSteps) {
      for (const dependencyName of plannerStep.dependsOn ?? []) {
        const dependents = dependentsByName.get(dependencyName) ?? [];
        dependents.push(plannerStep);
        dependentsByName.set(dependencyName, dependents);
      }
    }

    const categories = new Set<AcceptanceProbeCategory>();
    const queue = [...(dependentsByName.get(step.name) ?? [])];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.name)) continue;
      visited.add(current.name);

      if (current.stepType === "deterministic_tool") {
        for (const category of this.classifyDeterministicVerificationCategories(
          current,
        )) {
          categories.add(category);
        }
      }

      for (const next of dependentsByName.get(current.name) ?? []) {
        if (!visited.has(next.name)) {
          queue.push(next);
        }
      }
    }

    return categories;
  }

  private classifyDeterministicVerificationCategories(
    step: PipelinePlannerDeterministicStep,
  ): readonly AcceptanceProbeCategory[] {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return [];
    }

    const args =
      typeof step.args === "object" &&
      step.args !== null &&
      !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : undefined;
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args?.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const tokens = commandArgs.length > 0
      ? [command, ...commandArgs]
      : tokenizeShellCommand(command);
    const normalized = tokens
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0);
    if (normalized.length === 0) {
      return [];
    }

    const categories = new Set<AcceptanceProbeCategory>();
    const joined = normalized.join(" ");
    if (
      /\b(?:npm|pnpm|yarn|bun)\b.*\bbuild\b/.test(joined) ||
      /\bvite\b.*\bbuild\b/.test(joined) ||
      (
        /\btsc\b/.test(joined) &&
        !normalized.includes("--noemit")
      )
    ) {
      categories.add("build");
    }
    if (
      /\b(?:npm|pnpm|yarn|bun)\b.*\btypecheck\b/.test(joined) ||
      (
        /\btsc\b/.test(joined) &&
        normalized.includes("--noemit")
      )
    ) {
      categories.add("typecheck");
    }
    if (
      /\b(?:npm|pnpm|yarn|bun)\b.*\blint\b/.test(joined) ||
      /\beslint\b/.test(joined)
    ) {
      categories.add("lint");
    }
    if (
      /\b(?:npm|pnpm|yarn|bun)\b.*\btest\b/.test(joined) ||
      /\b(?:vitest|jest|pytest|mocha|ava)\b/.test(joined)
    ) {
      categories.add("test");
    }
    return [...categories];
  }

  private renderDeterministicCommandSummary(
    step: PipelinePlannerDeterministicStep,
  ): string {
    const args =
      typeof step.args === "object" &&
      step.args !== null &&
      !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : undefined;
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args?.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const rendered = [command, ...commandArgs].filter((value) => value.length > 0)
      .join(" ");
    return rendered.length > 0
      ? `\`${this.redactSensitiveData(rendered)}\``
      : `deterministic probe "${step.name}"`;
  }

  private async buildSubagentTaskPrompt(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Readonly<Record<string, string>>,
    toolScope: {
      allowedTools: readonly string[];
      allowsToollessExecution: boolean;
      semanticFallback: readonly string[];
      removedLowSignalBrowserTools: readonly string[];
      removedByPolicy: readonly string[];
      removedAsDelegationTools: readonly string[];
      removedAsUnknownTools: readonly string[];
      parentPolicyAllowed: readonly string[];
    },
  ): Promise<{
    taskPrompt: string;
    diagnostics: SubagentContextDiagnostics;
  }> {
    const plannerContext = pipeline.plannerContext;
    let resolvedChildPromptBudget: ResolvedChildPromptBudget | undefined;
    try {
      resolvedChildPromptBudget =
        await this.resolveChildPromptBudget?.({
          task: step.objective,
          tools: toolScope.allowedTools,
          requiredCapabilities: step.requiredToolCapabilities,
        });
    } catch {
      resolvedChildPromptBudget = undefined;
    }
    const effectivePromptBudget =
      resolvedChildPromptBudget?.promptBudget ?? this.childPromptBudget;
    const promptBudgetCaps = this.resolveSubagentPromptBudgetCaps(
      effectivePromptBudget,
    );
    const parentRequest = plannerContext?.parentRequest?.trim();
    const summarizedParentRequest = parentRequest
      ? this.summarizeParentRequestForSubagent(parentRequest, step)
      : undefined;
    const relevanceTerms = this.buildRelevanceTerms(step);
    const artifactRelevanceTerms = this.buildArtifactRelevanceTerms(step);
    const delegatedWorkingDirectory = this.resolvePlannerStepWorkingDirectory(
      step,
      pipeline,
    );
    const effectiveContextRequirements = this.buildEffectiveContextRequirements(
      step,
      delegatedWorkingDirectory?.path,
    );
    const effectiveStep = {
      ...step,
      contextRequirements: effectiveContextRequirements,
    } satisfies PipelinePlannerSubagentStep;
    const requirementTerms = this.extractTerms(
      effectiveContextRequirements.join(" "),
    );
    const dependencies = this.collectDependencyContexts(step, pipeline, results);
    const dependencyArtifactCandidates = this.collectDependencyArtifactCandidates(
      dependencies,
      artifactRelevanceTerms,
      delegatedWorkingDirectory?.path,
    );
    const workspaceArtifactCandidates =
      dependencyArtifactCandidates.length === 0 &&
        delegatedWorkingDirectory?.path
        ? this.collectWorkspaceArtifactCandidates(
          delegatedWorkingDirectory.path,
          artifactRelevanceTerms,
          promptBudgetCaps.toolOutputChars,
        )
        : [];
    const promptArtifactCandidates =
      dependencyArtifactCandidates.length > 0
        ? dependencyArtifactCandidates
        : workspaceArtifactCandidates;
    const toolContextBudgets = this.allocateContextGroupBudgets(
      promptBudgetCaps.toolOutputChars,
      [
        {
          key: "toolOutputs",
          active:
            dependencies.length > 0 ||
            (plannerContext?.toolOutputs?.length ?? 0) > 0,
        },
        { key: "dependencyArtifacts", active: promptArtifactCandidates.length > 0 },
      ],
    );

    const historySection = this.curateHistorySection(
      plannerContext?.history ?? [],
      relevanceTerms,
      promptBudgetCaps.historyChars,
    );
    const memorySection = this.curateMemorySection(
      plannerContext?.memory ?? [],
      effectiveContextRequirements,
      relevanceTerms,
      promptBudgetCaps.memoryChars,
    );
    const toolOutputSection = this.curateToolOutputSection(
      effectiveStep,
      plannerContext?.toolOutputs ?? [],
      dependencies,
      relevanceTerms,
      requirementTerms,
      toolContextBudgets.toolOutputs ?? 0,
    );
    const dependencyArtifactSection = this.curateDependencyArtifactSection(
      promptArtifactCandidates,
      toolContextBudgets.dependencyArtifacts ?? 0,
    );
    const workspaceStateGuidanceLines = this.buildWorkspaceStateGuidanceLines(
      effectiveStep,
      pipeline,
      promptArtifactCandidates,
      delegatedWorkingDirectory?.path,
    );
    const hostToolingSection = this.buildHostToolingPromptSection(
      effectiveStep,
      pipeline,
      dependencyArtifactCandidates,
    );
    const downstreamRequirementLines = this.buildDownstreamRequirementLines(
      effectiveStep,
      pipeline,
    );
    const workspaceVerificationContractLines =
      this.buildWorkspaceVerificationContractLines(effectiveStep, pipeline);
    const effectiveAcceptanceCriteria = this.buildEffectiveAcceptanceCriteria(
      effectiveStep,
      pipeline,
      delegatedWorkingDirectory?.path,
    );

    const buildPrompt = (diagnostics: SubagentContextDiagnostics): string => {
      const sections: string[] = [];
      const allowsStructuredShell = toolScope.allowedTools.some((toolName) =>
        toolName === "system.bash" || toolName === "desktop.bash"
      );
      const allowsDirectFileWrite = toolScope.allowedTools.some((toolName) =>
        toolName === "system.writeFile" ||
        toolName === "system.appendFile" ||
        toolName === "desktop.text_editor"
      );
      sections.push(
        `Execution rules:
- Execute only the assigned phase \`${effectiveStep.name}\`.
- Do not create a new multi-step plan for the broader parent request.
- Do not attempt sibling phases or synthesize the final deliverable.
- If the task requires tool-grounded evidence, you must use one or more allowed tools before answering.
- If you cannot complete the phase with the allowed tools, state that you are blocked and explain exactly why.`,
      );
      sections.push(`Objective: ${this.redactSensitiveData(effectiveStep.objective)}`);
      sections.push(
        `Input contract: ${this.redactSensitiveData(effectiveStep.inputContract)}`,
      );
      if (summarizedParentRequest && summarizedParentRequest.length > 0) {
        sections.push(
          `Parent request summary: ${this.redactSensitiveData(summarizedParentRequest)}`,
        );
      }
      if (effectiveAcceptanceCriteria.length > 0) {
        sections.push(
          `Acceptance criteria:\n${effectiveAcceptanceCriteria.map((item) => `- ${this.redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (effectiveContextRequirements.length > 0) {
        sections.push(
          `Context requirements:\n${effectiveContextRequirements.map((item) => `- ${this.redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (
        delegatedWorkingDirectory &&
        delegatedWorkingDirectory.source !== "context_requirement"
      ) {
        sections.push(
          "Working directory:\n" +
            `- Use \`${this.redactSensitiveData(delegatedWorkingDirectory.path)}\` as the workspace root for this phase.\n` +
            "- Keep filesystem reads and writes under that root.\n" +
            "- Prefer relative paths rooted there; do not create alternate workspaces elsewhere.",
        );
      }
      if (toolScope.allowedTools.length > 0) {
        sections.push(
          `Allowed tools (policy-scoped):\n${
            toolScope.allowedTools.map((item) => `- ${item}`).join("\n")
          }`,
        );
      } else if (toolScope.allowsToollessExecution) {
        sections.push(
          "Allowed tools (policy-scoped): none. Complete this phase from curated parent context, memory, and dependency outputs only.",
        );
      }
      if (allowsStructuredShell || allowsDirectFileWrite) {
        const toolUsageRules: string[] = [];
        if (allowsStructuredShell) {
          toolUsageRules.push(
            "- For `system.bash`/`desktop.bash` direct mode, `command` must be exactly one executable token. Put flags and operands in `args`.",
          );
          toolUsageRules.push(
            "- Use shell mode only when you need pipes, redirects, chaining, or subshells. In shell mode, set `command` to the full shell string and omit `args`.",
          );
          toolUsageRules.push(
            "- Verification commands must be non-interactive and exit on their own. Do not use watch/dev mode for tests or validation. Prefer runner-native single-run invocations. For Vitest use `vitest run`/`vitest --run`. For Jest use `CI=1 npm test` or `jest --runInBand`. Only pass extra npm `--` flags when the underlying runner supports them.",
          );
        }
        if (allowsDirectFileWrite) {
          toolUsageRules.push(
            "- Use file-write tools for file contents instead of shell heredocs or inline shell-generated source files when those tools are allowed.",
          );
        }
        sections.push(`Tool usage rules:\n${toolUsageRules.join("\n")}`);
      }
      if (!allowsDirectFileWrite) {
        sections.push(
          "Output contract:\n" +
            "- If this phase needs a design document, summary, JSON payload, notes, or other textual artifact and no file-write tools are allowed, return that artifact inline in your response.\n" +
            "- Do not block solely because you cannot persist a workspace file unless the acceptance criteria explicitly require a file on disk.",
        );
      }
      if (historySection.lines.length > 0) {
        sections.push(
          `Curated parent history slice:\n${
            historySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (memorySection.lines.length > 0) {
        sections.push(
          `Required memory retrievals:\n${
            memorySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (toolOutputSection.lines.length > 0) {
        sections.push(
          `Relevant tool outputs:\n${
            toolOutputSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (dependencyArtifactSection.lines.length > 0) {
        sections.push(
          "Dependency-derived workspace context:\n" +
            "- Use these file snapshots as the starting point for this phase.\n" +
            "- Do not spend tool rounds re-listing directories or re-reading the same files unless you need fresh verification after a mutation.\n" +
            dependencyArtifactSection.lines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (workspaceStateGuidanceLines.length > 0) {
        sections.push(
          "Observed workspace state:\n" +
            workspaceStateGuidanceLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (hostToolingSection.lines.length > 0) {
        sections.push(
          `Host tooling constraints:\n${
            hostToolingSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      const allDownstreamRequirementLines = [
        ...downstreamRequirementLines,
        ...workspaceVerificationContractLines,
      ];
      if (allDownstreamRequirementLines.length > 0) {
        sections.push(
          "Downstream execution requirements:\n" +
            allDownstreamRequirementLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      sections.push(`Budget hint: ${step.maxBudgetHint}`);
      sections.push(
        `Context curation diagnostics:\n${safeStringify(diagnostics)}`,
      );
      return this.redactSensitiveData(sections.join("\n\n"));
    };

    let diagnostics: SubagentContextDiagnostics = {
      executionBudget: {
        provider: resolvedChildPromptBudget?.providerProfile?.provider,
        model: resolvedChildPromptBudget?.providerProfile?.model,
        contextWindowTokens:
          resolvedChildPromptBudget?.providerProfile?.contextWindowTokens ??
          effectivePromptBudget?.contextWindowTokens,
        contextWindowSource:
          resolvedChildPromptBudget?.providerProfile?.contextWindowSource,
        maxOutputTokens:
          resolvedChildPromptBudget?.providerProfile?.maxOutputTokens ??
          effectivePromptBudget?.maxOutputTokens,
        historyChars: promptBudgetCaps.historyChars,
        memoryChars: promptBudgetCaps.memoryChars,
        toolOutputChars: promptBudgetCaps.toolOutputChars,
        totalPromptChars: promptBudgetCaps.totalPromptChars,
      },
      history: {
        selected: historySection.selected,
        available: historySection.available,
        omitted: historySection.omitted,
        truncated: historySection.truncated,
      },
      memory: {
        selected: memorySection.selected,
        available: memorySection.available,
        omitted: memorySection.omitted,
        truncated: memorySection.truncated,
      },
      toolOutputs: {
        selected: toolOutputSection.selected,
        available: toolOutputSection.available,
        omitted: toolOutputSection.omitted,
        truncated: toolOutputSection.truncated,
      },
      dependencyArtifacts: {
        selected: dependencyArtifactSection.selected,
        available: promptArtifactCandidates.length,
        omitted: Math.max(
          0,
          promptArtifactCandidates.length - dependencyArtifactSection.selected,
        ),
        truncated: dependencyArtifactSection.truncated,
      },
      hostTooling: hostToolingSection.diagnostics,
      promptTruncated: false,
      toolScope: {
        strategy: this.childToolAllowlistStrategy,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
        required: [...step.requiredToolCapabilities],
        parentPolicyAllowed: [...toolScope.parentPolicyAllowed],
        parentPolicyForbidden: [...this.forbiddenParentTools],
        resolved: [...toolScope.allowedTools],
        allowsToollessExecution: toolScope.allowsToollessExecution,
        semanticFallback: [...toolScope.semanticFallback],
        removedLowSignalBrowserTools: [
          ...toolScope.removedLowSignalBrowserTools,
        ],
        removedByPolicy: [...toolScope.removedByPolicy],
        removedAsDelegationTools: [...toolScope.removedAsDelegationTools],
        removedAsUnknownTools: [...toolScope.removedAsUnknownTools],
      },
    };

    let taskPrompt = buildPrompt(diagnostics);
    if (taskPrompt.length > promptBudgetCaps.totalPromptChars) {
      diagnostics = {
        ...diagnostics,
        promptTruncated: true,
      };
      taskPrompt = this.truncateText(
        buildPrompt(diagnostics),
        promptBudgetCaps.totalPromptChars,
      );
    }

    return { taskPrompt, diagnostics };
  }

  private buildWorkspaceStateGuidanceLines(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    promptArtifactCandidates: readonly DependencyArtifactCandidate[],
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    if (
      typeof delegatedWorkingDirectory !== "string" ||
      delegatedWorkingDirectory.trim().length === 0
    ) {
      return [];
    }

    const workspaceRoot = resolvePath(delegatedWorkingDirectory);
    if (!existsSync(workspaceRoot)) {
      return [
        "The delegated workspace root does not exist yet. Create it before listing directories or writing phase files.",
      ];
    }
    const packageDirectories = this.collectPromptArtifactPackageDirectories(
      promptArtifactCandidates,
      workspaceRoot,
    );
    if (packageDirectories.length === 0) {
      return [];
    }

    const stepText = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
    ].join(" ");
    const phaseMentionsTests =
      this.collectReachableVerificationCategories(step, pipeline).has("test") ||
      /\b(?:test|tests|vitest|jest|coverage|spec)\b/i.test(stepText);

    const lines: string[] = [];
    let missingSourceFiles = false;
    let missingTests = false;
    for (const packageDirectory of packageDirectories.slice(0, 3)) {
      const state = this.inspectPackageAuthoringState(
        packageDirectory,
        workspaceRoot,
      );
      if (!state) continue;

      if (state.sourceFileCount === 0) {
        lines.push(
          state.sourceDirExists
            ? `\`${state.relativeSourceDirectory}\` exists but has no authored source files yet.`
            : `\`${state.relativeSourceDirectory}\` does not exist yet.`,
        );
        missingSourceFiles = true;
      }
      if (phaseMentionsTests && state.testFileCount === 0) {
        lines.push(
          `No test files are present yet under \`${state.relativePackageDirectory}\` for this phase's test or coverage requirements.`,
        );
        missingTests = true;
      }
    }

    if (missingSourceFiles) {
      lines.push(
        "Execution ordering: author the missing source files for this phase before invoking any verification command.",
      );
    }
    if (missingTests) {
      lines.push(
        "If this phase owns test coverage, write the missing tests before invoking a test runner.",
      );
    }

    return lines.filter((line, index, entries) =>
      line.length > 0 && entries.indexOf(line) === index
    );
  }

  private collectPromptArtifactPackageDirectories(
    promptArtifactCandidates: readonly DependencyArtifactCandidate[],
    workspaceRoot: string,
  ): readonly string[] {
    const directories: string[] = [];
    const pushDirectory = (value: string | undefined): void => {
      const normalized = value?.trim();
      if (!normalized || directories.includes(normalized)) {
        return;
      }
      directories.push(normalized);
    };

    for (const candidate of promptArtifactCandidates) {
      const packageDirectory = this.resolvePackageDirectoryFromFilePath(
        candidate.path,
        workspaceRoot,
      );
      pushDirectory(packageDirectory);
    }

    return directories;
  }

  private inspectPackageAuthoringState(
    packageDirectory: string,
    workspaceRoot: string,
  ): PackageAuthoringState | undefined {
    const absolutePackageDirectory = resolvePath(packageDirectory);
    const relativePackageDirectory = this.normalizeDependencyArtifactPath(
      absolutePackageDirectory,
      workspaceRoot,
    );
    if (relativePackageDirectory.length === 0) {
      return undefined;
    }

    const sourceDirectory = resolvePath(absolutePackageDirectory, "src");
    const relativeSourceDirectory = this.normalizeDependencyArtifactPath(
      sourceDirectory,
      workspaceRoot,
    );
    const sourceDirExists = existsSync(sourceDirectory);
    const pendingDirectories = [absolutePackageDirectory];
    let scannedFiles = 0;
    let sourceFileCount = 0;
    let testFileCount = 0;

    while (
      pendingDirectories.length > 0 &&
      scannedFiles < PACKAGE_AUTHORING_MAX_SCAN_FILES
    ) {
      const currentDirectory = pendingDirectories.shift();
      if (!currentDirectory) break;

      let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
      try {
        entries = readdirSync(currentDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (scannedFiles >= PACKAGE_AUTHORING_MAX_SCAN_FILES) {
          break;
        }
        if (entry.isDirectory()) {
          if (!PACKAGE_AUTHORING_SCAN_SKIP_DIRS.has(entry.name)) {
            pendingDirectories.push(join(currentDirectory, entry.name));
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        scannedFiles += 1;
        const absolutePath = join(currentDirectory, entry.name);
        const relativePath = this.normalizeDependencyArtifactPath(
          absolutePath,
          workspaceRoot,
        );
        if (
          relativePath.length === 0 ||
          GENERATED_DECLARATION_PATH_RE.test(relativePath)
        ) {
          continue;
        }
        if (TEST_ARTIFACT_PATH_RE.test(relativePath)) {
          testFileCount += 1;
          continue;
        }
        if (
          relativePath.startsWith(`${relativePackageDirectory}/src/`) &&
          SOURCE_ARTIFACT_PATH_RE.test(relativePath)
        ) {
          sourceFileCount += 1;
        }
      }
    }

    return {
      relativePackageDirectory,
      relativeSourceDirectory,
      sourceDirExists,
      sourceFileCount,
      testFileCount,
    };
  }

  private scoreWorkspaceEcosystem(
    texts: readonly string[],
    patterns: readonly { pattern: RegExp; weight: number }[],
  ): number {
    return patterns.reduce((total, cue) => {
      const matched = texts.some((text) => cue.pattern.test(text));
      return matched ? total + cue.weight : total;
    }, 0);
  }

  private resolveWorkspaceEcosystem(
    texts: readonly string[],
  ): "node" | "rust" | "unknown" {
    const normalized = texts
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    if (normalized.length === 0) {
      return "unknown";
    }

    const nodeScore = this.scoreWorkspaceEcosystem(normalized, [
      { pattern: NODE_PACKAGE_TOOLING_RE, weight: 4 },
      { pattern: NODE_PACKAGE_MANIFEST_PATH_RE, weight: 5 },
      { pattern: NODE_WORKSPACE_AUTHORING_RE, weight: 2 },
      { pattern: /\bworkspace:\*/i, weight: 3 },
    ]);
    const rustScore = this.scoreWorkspaceEcosystem(normalized, [
      { pattern: RUST_WORKSPACE_TOOLING_RE, weight: 4 },
      { pattern: /\bcargo\s+(?:build|check|run|test)\b/i, weight: 4 },
      { pattern: /\bcargo\s+.*\s--workspace\b/i, weight: 3 },
      { pattern: /(?:^|\/)(?:cargo\.toml|cargo\.lock)$/i, weight: 5 },
    ]);

    if (nodeScore > 0 && rustScore === 0) {
      return "node";
    }
    if (rustScore > 0 && nodeScore === 0) {
      return "rust";
    }
    if (nodeScore >= rustScore + 2) {
      return "node";
    }
    if (rustScore >= nodeScore + 2) {
      return "rust";
    }
    return "unknown";
  }

  private isNodeWorkspaceRelevant(texts: readonly string[]): boolean {
    return this.resolveWorkspaceEcosystem(texts) === "node";
  }

  private buildHostToolingPromptSection(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    dependencyArtifactCandidates: readonly DependencyArtifactCandidate[],
  ): {
    lines: readonly string[];
    diagnostics: SubagentContextDiagnostics["hostTooling"];
  } {
    const stepTexts = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      pipeline.plannerContext?.parentRequest ?? "",
      ...dependencyArtifactCandidates.map((candidate) => candidate.path),
    ];
    const relevant = this.isNodeWorkspaceRelevant(stepTexts);
    if (!relevant) {
      return {
        lines: [],
        diagnostics: {
          included: false,
          reason: "not_relevant",
        },
      };
    }

    const profile = this.resolveHostToolingProfile();
    if (!profile) {
      return {
        lines: [],
        diagnostics: {
          included: false,
          reason: "profile_unavailable",
        },
      };
    }

    const diagnostics: SubagentContextDiagnostics["hostTooling"] = {
      included: true,
      reason: "node_package_tooling",
      nodeVersion: profile.nodeVersion,
      ...(profile.npm?.version ? { npmVersion: profile.npm.version } : {}),
      ...(profile.npm?.workspaceProtocolSupport
        ? { npmWorkspaceProtocolSupport: profile.npm.workspaceProtocolSupport }
        : {}),
      ...(profile.npm?.workspaceProtocolEvidence
        ? { npmWorkspaceProtocolEvidence: profile.npm.workspaceProtocolEvidence }
        : {}),
    };
    const lines = [`Host Node version: \`${profile.nodeVersion}\`.`];

    if (profile.npm?.version) {
      lines.push(`Host npm version: \`${profile.npm.version}\`.`);
    }
    lines.push(
      "Project-local CLIs such as `tsc`, `vite`, `vitest`, and `eslint` are not guaranteed to be on the host PATH. Prefer `npm run <script>`, `npx <bin>`, or `npm exec -- <bin>` from the correct cwd instead of assuming bare executables exist.",
    );
    lines.push(
      "For npm workspaces, use `npm run <script> --workspaces` to fan out or `npm run <script> --workspace=<workspace-name>` with a real workspace name. Do not use globbed selectors such as `--workspace=packages/*`.",
    );
    lines.push(
      "For TypeScript monorepos, prefer a package-local `tsconfig.json` (or project references) for each buildable package so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling package source globs.",
    );
    if (profile.npm?.workspaceProtocolSupport === "unsupported") {
      const evidence = profile.npm.workspaceProtocolEvidence
        ? ` (${this.redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
        : "";
      lines.push(
        "Empirical npm probe: local `workspace:*` dependency specifiers are unsupported on this host" +
          `${evidence}.`,
      );
      lines.push(
        "Do not rely on `workspace:*` in generated manifests. Choose a host-compatible local dependency reference and verify it with `npm install` on this host before proceeding.",
      );
    } else if (profile.npm?.workspaceProtocolSupport === "unknown") {
      const evidence = profile.npm.workspaceProtocolEvidence
        ? ` (${this.redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
        : "";
      lines.push(
        "Empirical npm probe could not confirm whether local `workspace:*` dependency specifiers work on this host" +
          `${evidence}. Verify the manifest with a real install before depending on workspace protocol semantics.`,
      );
    } else if (profile.npm?.workspaceProtocolSupport === "supported") {
      lines.push(
        "Empirical npm probe: local `workspace:*` dependency specifiers are supported on this host.",
      );
    }

    return { lines, diagnostics };
  }

  private deriveChildToolAllowlist(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): {
    allowedTools: readonly string[];
    allowsToollessExecution: boolean;
    semanticFallback: readonly string[];
    removedLowSignalBrowserTools: readonly string[];
    blockedReason?: string;
    removedByPolicy: readonly string[];
    removedAsDelegationTools: readonly string[];
    removedAsUnknownTools: readonly string[];
    parentPolicyAllowed: readonly string[];
  } {
    const parentPolicyAllowed = this.resolveParentPolicyAllowlist(pipeline);
    const availableTools = this.resolveAvailableToolNames();
    const resolvedScope = resolveDelegatedChildToolScope({
      spec: {
        task: step.name,
        objective: step.objective,
        parentRequest: pipeline.plannerContext?.parentRequest,
        inputContract: step.inputContract,
        acceptanceCriteria: step.acceptanceCriteria,
        requiredToolCapabilities: step.requiredToolCapabilities,
      },
      requestedTools: step.requiredToolCapabilities,
      parentAllowedTools: parentPolicyAllowed,
      availableTools: availableTools ?? undefined,
      forbiddenTools: [...this.forbiddenParentTools],
      enforceParentIntersection:
        this.childToolAllowlistStrategy === "inherit_intersection",
      unsafeBenchmarkMode: this.unsafeBenchmarkMode,
    });

    return {
      allowedTools: resolvedScope.allowedTools,
      allowsToollessExecution: resolvedScope.allowsToollessExecution,
      semanticFallback: resolvedScope.semanticFallback,
      removedLowSignalBrowserTools: resolvedScope.removedLowSignalBrowserTools,
      blockedReason: resolvedScope.blockedReason,
      removedByPolicy: resolvedScope.removedByPolicy,
      removedAsDelegationTools: resolvedScope.removedAsDelegationTools,
      removedAsUnknownTools: resolvedScope.removedAsUnknownTools,
      parentPolicyAllowed,
    };
  }

  private buildRetryTaskPrompt(
    currentTaskPrompt: string,
    step: PipelinePlannerSubagentStep,
    allowedTools: readonly string[],
    failure: SubagentFailureOutcome,
    retryAttempt: number,
  ): string {
    if (failure.failureClass !== "malformed_result_contract") {
      return currentTaskPrompt;
    }

    const corrections: string[] = [];
    if (failure.validationCode === "expected_json_object") {
      corrections.push(
        "Return a single JSON object only. Do not wrap it in markdown, code fences, prose, or bullet lists.",
      );
    }
    if (failure.validationCode === "empty_output") {
      corrections.push(
        "Do not return an empty reply. Produce the required deliverable with concrete evidence.",
      );
    }
    if (failure.validationCode === "low_signal_browser_evidence") {
      corrections.push(...buildBrowserEvidenceRetryGuidance(allowedTools));
    }
    if (failure.validationCode === "acceptance_evidence_missing") {
      corrections.push(
        "Do not just restate the acceptance criteria. Use allowed tools to directly verify the missing criteria and cite the observed evidence.",
      );
      if (
        specRequiresMeaningfulBrowserEvidence({
          task: step.name,
          objective: step.objective,
          inputContract: step.inputContract,
          acceptanceCriteria: step.acceptanceCriteria,
          requiredToolCapabilities: step.requiredToolCapabilities,
          contextRequirements: step.contextRequirements,
        })
      ) {
        corrections.push(...buildBrowserEvidenceRetryGuidance(allowedTools));
      }
      if (
        /\b(?:compile|compiles|compiled|compiling|build|test|verify|validated?|output(?:\s+format)?|stdout|stderr|exit(?:\s+code|s)?)\b/i.test(
          [
            step.objective,
            step.inputContract,
            ...(step.acceptanceCriteria ?? []),
          ]
            .filter((value): value is string =>
              typeof value === "string" && value.length > 0
            )
            .join(" "),
        ) &&
        allowedTools.some((toolName) =>
          toolName === "desktop.bash" || toolName === "system.bash"
        )
      ) {
        corrections.push(
          "If the acceptance criteria mention compile/build/test/output behavior, run the relevant shell command(s) and report the observed result instead of rewriting the file again.",
        );
      }
    }
    if (failure.validationCode === "forbidden_phase_action") {
      corrections.push(
        "Do not execute or claim commands that this phase explicitly forbids, including install/build/test/typecheck/lint verification or banned dependency specifiers.",
      );
      corrections.push(
        "Stay within the file-authoring or inspection contract for this phase and leave verification for the later step.",
      );
    }
    if (failure.validationCode === "acceptance_probe_failed") {
      corrections.push(
        "A parent-side deterministic acceptance probe failed after your edits. Fix the cited package/workspace compatibility issue in the authored files before answering again.",
      );
      corrections.push(
        "Do not guess or restate success. Ground the retry in the concrete probe failure details.",
      );
      corrections.push(
        `Probe failure details: ${this.redactSensitiveData(failure.message)}`,
      );
      if (
        step.acceptanceCriteria.some((criterion) =>
          /\bno npm install\/build\/test\/typecheck\/lint commands executed or claimed in this phase\b/i
            .test(criterion)
        )
      ) {
        corrections.push(
          "Do not run install/build/test/typecheck/lint yourself if this phase forbids it; repair the files and let the parent acceptance probe re-run.",
        );
      }
    }
    if (failure.validationCode === "blocked_phase_output") {
      corrections.push(
        "Do not present the phase as successful if your own output says it is blocked or cannot be completed.",
      );
      corrections.push(
        "Only return a completed phase after fixing and verifying the blocking issue with the allowed tools.",
      );
    }
    if (failure.validationCode === "contradictory_completion_claim") {
      corrections.push(
        "Do not claim the phase is complete while also mentioning unresolved mismatches, placeholders, or follow-up work.",
      );
      corrections.push(
        "Fix and verify the issue with the allowed tools first. If the issue remains unresolved, report the phase as blocked instead of successful.",
      );
    }
    if (
      step.requiredToolCapabilities.length > 0 ||
      /tool-grounded evidence|no tool calls|all child tool calls failed/i.test(
        failure.message,
      )
    ) {
      corrections.push(
        `You must invoke one or more of the allowed tools before answering. Allowed tools: ${allowedTools.join(", ") || "none"}. Do not answer from memory.`,
      );
    }
    if (/file creation\/edit evidence|file mutation tools/i.test(failure.message)) {
      corrections.push(
        "You must create or edit the required files using allowed tools and identify those files in the output.",
      );
    }
    if (/identify any files/i.test(failure.message)) {
      corrections.push(
        "Your output must explicitly name the files you created or modified.",
      );
    }

    if (corrections.length === 0) {
      corrections.push(
        `The previous attempt for step "${step.name}" violated the delegated output contract. Re-run the phase and satisfy the stated input contract and acceptance criteria exactly.`,
      );
    }

    return `${currentTaskPrompt}\n\nRetry corrections (attempt ${retryAttempt}):\n${corrections.map((entry) => `- ${entry}`).join("\n")}`;
  }

  private summarizeParentRequestForSubagent(
    parentRequest: string,
    step: PipelinePlannerSubagentStep,
  ): string {
    const stripped = parentRequest
      .replace(SUBAGENT_ORCHESTRATION_SECTION_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    const highLevelScope = stripped
      .split(/\bExecution rules:\b/i)[0]
      ?.trim();
    const base =
      highLevelScope && highLevelScope.length > 0
        ? highLevelScope
        : stripped.length > 0
          ? stripped
        : `Complete only the assigned ${step.name} phase of the parent request.`;
    return this.truncateText(
      `${base} Assigned phase only: ${step.name}. Ignore broader orchestration instructions and other phases.`,
      600,
    );
  }

  private resolveEffectiveMaxCumulativeTokensPerRequestTree(
    plannerSteps: readonly PipelinePlannerStep[],
  ): number {
    if (this.maxCumulativeTokensPerRequestTree <= 0) {
      return 0;
    }
    if (this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const plannedSubagentSteps = plannerSteps.filter(
      (step) => step.stepType === "subagent_task",
    ) as readonly PipelinePlannerSubagentStep[];
    if (plannedSubagentSteps.length <= 0) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const derivedBudget = plannedSubagentSteps.reduce(
      (total, step) =>
        total + this.estimatePlannedSubagentStepTokenBudget(step),
      0,
    );
    return Math.max(
      this.maxCumulativeTokensPerRequestTree,
      derivedBudget * DEFAULT_REQUEST_TREE_SUBAGENT_PASSES,
    );
  }

  private estimatePlannedSubagentStepTokenBudget(
    step: PipelinePlannerSubagentStep,
  ): number {
    const timeoutMs = this.parseBudgetHintMs(step.maxBudgetHint);
    return Math.max(
      DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP,
      Math.ceil(timeoutMs * DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS),
    );
  }

  private formatRequestTreeBudgetBreach(
    breach: RequestTreeBudgetBreach,
  ): string {
    const { state } = breach;
    const usageSummary =
      `cumulativeToolCalls=${state.cumulativeToolCalls}/${state.maxCumulativeToolCallsPerRequestTree}; ` +
      `cumulativeTokens=${state.cumulativeTokens}/${state.maxCumulativeTokensPerRequestTree}; ` +
      `spawnedChildren=${state.spawnedChildren}; reservedSpawns=${state.reservedSpawns}`;
    if (breach.limitKind === "spawns") {
      return `${breach.reason}; attemptedSpawnCount=${breach.attemptedSpawnCount}; ${usageSummary}`;
    }
    return (
      `${breach.reason}; ` +
      `stepToolCalls=${breach.stepToolCalls}; ` +
      `stepTokens=${breach.stepTokens}; ` +
      usageSummary
    );
  }

  private buildRequestTreeBudgetBreachPayload(params: {
    readonly stepName: string;
    readonly attempt: number;
    readonly breach: RequestTreeBudgetBreach;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      stepName: params.stepName,
      stage: "circuit_breaker",
      reason: params.breach.reason,
      limitKind: params.breach.limitKind,
      attempt: params.attempt,
      ...params.breach.state,
    };
    if (params.breach.limitKind === "spawns") {
      payload.attemptedSpawnCount = params.breach.attemptedSpawnCount;
    } else {
      payload.stepToolCalls = params.breach.stepToolCalls;
      payload.stepTokens = params.breach.stepTokens;
    }
    return payload;
  }

  private resolveParentPolicyAllowlist(
    pipeline: Pipeline,
  ): readonly string[] {
    const plannerContextAllowed =
      pipeline.plannerContext?.parentAllowedTools
        ?.map((name) => name.trim())
        .filter((name) => name.length > 0) ?? [];
    if (plannerContextAllowed.length > 0) return plannerContextAllowed;
    if (this.allowedParentTools.size > 0) {
      return [...this.allowedParentTools];
    }
    return [];
  }

  private collectDependencyContexts(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Readonly<Record<string, string>>,
  ): readonly DependencyContextEntry[] {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0 || (step.dependsOn?.length ?? 0) === 0) {
      return [];
    }

    const stepIndexByName = new Map(
      plannerSteps.map((plannerStep, index) => [plannerStep.name, index]),
    );
    const stepByName = new Map(
      plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
    );
    const queue = (step.dependsOn ?? []).map((dependencyName) => ({
      dependencyName,
      depth: 1,
    }));
    const visited = new Set<string>();
    const collected: DependencyContextEntry[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (visited.has(current.dependencyName)) continue;
      visited.add(current.dependencyName);

      collected.push({
        dependencyName: current.dependencyName,
        result: results[current.dependencyName] ?? null,
        depth: current.depth,
        orderIndex:
          stepIndexByName.get(current.dependencyName) ?? Number.MAX_SAFE_INTEGER,
      });

      const dependencyStep = stepByName.get(current.dependencyName);
      if (!dependencyStep) continue;
      for (const ancestorName of dependencyStep.dependsOn ?? []) {
        if (!visited.has(ancestorName)) {
          queue.push({
            dependencyName: ancestorName,
            depth: current.depth + 1,
          });
        }
      }
    }

    return collected.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.orderIndex - b.orderIndex;
    });
  }

  private buildArtifactRelevanceTerms(
    step: PipelinePlannerSubagentStep,
  ): ReadonlySet<string> {
    // Dependency artifact retrieval should be scoped to the delegated child
    // contract, not the full parent request. Broad parent terms cause unrelated
    // artifacts from sibling phases to leak into downstream prompts.
    const aggregate = [
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      ...step.requiredToolCapabilities,
    ].join(" ");
    return new Set(this.extractTerms(aggregate));
  }

  private buildDownstreamRequirementLines(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): readonly string[] {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0) {
      return [];
    }

    const dependentsByName = new Map<string, PipelinePlannerStep[]>();
    for (const plannerStep of plannerSteps) {
      for (const dependencyName of plannerStep.dependsOn ?? []) {
        const dependents = dependentsByName.get(dependencyName) ?? [];
        dependents.push(plannerStep);
        dependentsByName.set(dependencyName, dependents);
      }
    }

    const queue = (dependentsByName.get(step.name) ?? []).map((dependentStep) => ({
      dependentStep,
      depth: 1,
    }));
    const visited = new Set<string>();
    const lines: string[] = [];
    while (queue.length > 0 && lines.length < 4) {
      const current = queue.shift();
      if (!current) break;
      if (visited.has(current.dependentStep.name)) continue;
      visited.add(current.dependentStep.name);

      const summarized = this.summarizeDownstreamRequirementStep(
        current.dependentStep,
      );
      for (const line of summarized) {
        if (!lines.includes(line)) {
          lines.push(line);
        }
        if (lines.length >= 4) break;
      }
      if (lines.length >= 4) break;

      for (const nextDependent of dependentsByName.get(current.dependentStep.name) ?? []) {
        if (!visited.has(nextDependent.name)) {
          queue.push({
            dependentStep: nextDependent,
            depth: current.depth + 1,
          });
        }
      }
    }

    return lines;
  }

  private buildWorkspaceVerificationContractLines(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): readonly string[] {
    const delegatedWorkingDirectory = this.resolvePlannerStepWorkingDirectory(
      step,
      pipeline,
    );
    const downstreamRootScripts = this.collectDownstreamRootNpmScripts(
      step,
      pipeline,
      delegatedWorkingDirectory?.path,
    );
    const stepTexts = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      pipeline.plannerContext?.parentRequest ?? "",
      ...downstreamRootScripts.map((script) => `npm run ${script}`),
    ];
    const relevant =
      downstreamRootScripts.length > 0 ||
      this.isNodeWorkspaceRelevant(stepTexts);
    if (!relevant) {
      return [];
    }

    if (downstreamRootScripts.length === 0) {
      return [];
    }

    return [
      "If this phase authors the root workspace manifest or scaffold, define the downstream root npm scripts now: " +
        downstreamRootScripts.map((script) => `\`${script}\``).join(", ") +
        ".",
      "Do not leave those root script definitions for a later implementation-only step when deterministic verification already depends on them.",
    ];
  }

  private buildEffectiveDelegationSpec(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    options: {
      readonly parentRequest?: string;
      readonly lastValidationCode?: DelegationOutputValidationCode;
      readonly delegatedWorkingDirectory?: string;
    } = {},
  ): DelegationContractSpec {
    return {
      task: step.name,
      objective: step.objective,
      parentRequest: options.parentRequest,
      inputContract: step.inputContract,
      acceptanceCriteria: this.buildEffectiveAcceptanceCriteria(
        step,
        pipeline,
        options.delegatedWorkingDirectory,
      ),
      requiredToolCapabilities: step.requiredToolCapabilities,
      contextRequirements: step.contextRequirements,
      ...(options.lastValidationCode
        ? { lastValidationCode: options.lastValidationCode }
        : {}),
    };
  }

  private buildEffectiveAcceptanceCriteria(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    return [
      ...step.acceptanceCriteria,
      ...this.buildDerivedWorkspaceAcceptanceCriteria(
        step,
        pipeline,
        delegatedWorkingDirectory,
      ),
    ]
      .map((item) => item.trim())
      .filter((item, index, items) =>
        item.length > 0 && items.indexOf(item) === index
      );
  }

  private buildDerivedWorkspaceAcceptanceCriteria(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    const downstreamRootScripts = this.collectDownstreamRootNpmScripts(
      step,
      pipeline,
      delegatedWorkingDirectory,
    );
    const stepTexts = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      pipeline.plannerContext?.parentRequest ?? "",
      ...downstreamRootScripts.map((script) => `npm run ${script}`),
    ];
    const relevant =
      downstreamRootScripts.length > 0 ||
      this.isNodeWorkspaceRelevant(stepTexts);
    if (!relevant) {
      return [];
    }

    const criteria: string[] = [];
    if (downstreamRootScripts.length > 0) {
      criteria.push(
        `Root package.json authored with npm scripts for ${downstreamRootScripts.join(", ")}.`,
      );
    }
    if (this.stepAuthorsNodeWorkspaceManifestOrConfig(step, pipeline)) {
      criteria.push(
        "Buildable TypeScript workspace packages use package-local tsconfig/project references or equivalent so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling packages.",
      );
    }

    if (this.isPreInstallNodeWorkspaceStep(step, pipeline)) {
      criteria.push(
        "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
      );
      const profile = this.resolveHostToolingProfile();
      if (profile?.npm?.workspaceProtocolSupport === "unsupported") {
        criteria.push(
          "No `workspace:*` dependency specifiers used; use `file:` local dependency references instead.",
        );
      }
    }

    return criteria;
  }

  private stepAuthorsNodeWorkspaceManifestOrConfig(
    step: PipelinePlannerSubagentStep,
    pipeline?: Pipeline,
  ): boolean {
    const combined = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
    ].join(" ");
    const hasNodeWorkspaceCue = this.isNodeWorkspaceRelevant([
      combined,
      pipeline?.plannerContext?.parentRequest ?? "",
    ]);
    const hasManifestOrConfigTarget =
      /\b(?:manifest|config|package\.json|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|readme|workspace|workspaces|dependencies|devdependencies|scripts?|bin)\b/i
        .test(combined);
    const hasAuthoringVerb =
      /\b(?:author|create|scaffold|write|update|define|configure|declare|add)\b/i
        .test(combined);
    return hasNodeWorkspaceCue &&
      hasManifestOrConfigTarget &&
      hasAuthoringVerb;
  }

  private isPreInstallNodeWorkspaceStep(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): boolean {
    if (!this.hasReachableNodeInstallStep(step, pipeline)) {
      return false;
    }

    const combined = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
    ].join(" ");
    return this.isNodeWorkspaceRelevant([combined]);
  }

  private hasReachableNodeInstallStep(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): boolean {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0) {
      return false;
    }
    const dependentsByName = new Map<string, PipelinePlannerStep[]>();
    for (const plannerStep of plannerSteps) {
      for (const dependency of plannerStep.dependsOn ?? []) {
        const dependents = dependentsByName.get(dependency) ?? [];
        dependents.push(plannerStep);
        dependentsByName.set(dependency, dependents);
      }
    }

    const queue = [...(dependentsByName.get(step.name) ?? [])];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.name)) continue;
      visited.add(current.name);
      if (this.isNodeInstallPlannerStep(current)) {
        return true;
      }
      for (const dependent of dependentsByName.get(current.name) ?? []) {
        if (!visited.has(dependent.name)) {
          queue.push(dependent);
        }
      }
    }

    return false;
  }

  private isNodeInstallPlannerStep(
    step: PipelinePlannerStep,
  ): step is PipelinePlannerDeterministicStep {
    if (step.stepType !== "deterministic_tool") {
      return false;
    }
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return false;
    }
    const command =
      typeof step.args.command === "string"
        ? step.args.command.trim().toLowerCase()
        : "";
    const commandArgs = Array.isArray(step.args.args)
      ? step.args.args.filter((value): value is string => typeof value === "string")
      : [];
    const firstArg = commandArgs[0]?.trim().toLowerCase() ?? "";
    if (!["npm", "pnpm", "yarn", "bun"].includes(command)) {
      return false;
    }
    if (command === "yarn" && firstArg.length === 0) {
      return true;
    }
    return ["install", "ci", "add"].includes(firstArg);
  }

  private summarizeDownstreamRequirementStep(
    step: PipelinePlannerStep,
  ): readonly string[] {
    if (step.stepType === "subagent_task") {
      const inputContract = step.inputContract.trim();
      if (inputContract.length === 0) {
        return [];
      }
      return [
        `\`${step.name}\` expects: ${this.redactSensitiveData(inputContract)}`,
      ];
    }

    if (step.stepType === "deterministic_tool") {
      const commandSummary = this.summarizeDeterministicVerificationStep(step);
      return commandSummary ? [commandSummary] : [];
    }

    return [];
  }

  private summarizeDeterministicVerificationStep(
    step: PipelinePlannerDeterministicStep,
  ): string | undefined {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return undefined;
    }

    const args =
      typeof step.args === "object" &&
        step.args !== null &&
        !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : undefined;
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args?.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const rendered = [command, ...commandArgs].filter((value) => value.length > 0).join(" ");
    if (rendered.length === 0) {
      return undefined;
    }
    const normalizedCommand = command.toLowerCase();
    const normalizedArgs = commandArgs.map((value) => value.toLowerCase());
    const looksLikeTestVerification =
      step.name.toLowerCase().includes("test") ||
      normalizedCommand === "vitest" ||
      normalizedCommand === "jest" ||
      normalizedArgs.includes("test");
    if (looksLikeTestVerification) {
      return "Later deterministic verification reruns the workspace test command in non-interactive single-run mode.";
    }

    return `Later deterministic verification runs \`${this.redactSensitiveData(rendered)}\`.`;
  }

  private collectDownstreamRootNpmScripts(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    const plannerSteps = pipeline.plannerSteps ?? [];
    const dependentsByName = new Map<string, PipelinePlannerStep[]>();
    for (const plannerStep of plannerSteps) {
      for (const dependency of plannerStep.dependsOn ?? []) {
        const dependents = dependentsByName.get(dependency) ?? [];
        dependents.push(plannerStep);
        dependentsByName.set(dependency, dependents);
      }
    }

    const queue = [...(dependentsByName.get(step.name) ?? [])];
    const visited = new Set<string>();
    const scripts: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.name)) continue;
      visited.add(current.name);

      const scriptNames = current.stepType === "deterministic_tool"
        ? this.extractDownstreamRootNpmRunScripts(
          current,
          delegatedWorkingDirectory,
        )
        : [];
      for (const scriptName of scriptNames) {
        if (!scripts.includes(scriptName)) {
          scripts.push(scriptName);
        }
      }

      for (const next of dependentsByName.get(current.name) ?? []) {
        if (!visited.has(next.name)) {
          queue.push(next);
        }
      }
    }

    return scripts;
  }

  private extractDownstreamRootNpmRunScripts(
    step: PipelinePlannerDeterministicStep,
    delegatedWorkingDirectory?: string,
  ): readonly string[] {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return [];
    }

    const args =
      typeof step.args === "object" &&
        step.args !== null &&
        !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : undefined;
    const cwd = typeof args?.cwd === "string" ? args.cwd.trim() : "";
    const normalizedDelegatedCwd = delegatedWorkingDirectory
      ? delegatedWorkingDirectory.replace(/\\/g, "/").replace(/\/+$/u, "")
      : "";
    const normalizedCommandCwd = cwd.replace(/\\/g, "/").replace(/\/+$/u, "");
    if (
      normalizedDelegatedCwd.length > 0 &&
      normalizedCommandCwd.length > 0 &&
      normalizedDelegatedCwd !== normalizedCommandCwd
    ) {
      return [];
    }

    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args?.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const tokens = commandArgs.length > 0
      ? [command, ...commandArgs]
      : tokenizeShellCommand(command);
    return this.collectRootNpmScriptsFromTokens(tokens);
  }

  private collectRootNpmScriptsFromTokens(
    tokens: readonly string[],
  ): readonly string[] {
    if (tokens.length === 0) {
      return [];
    }

    const scripts: string[] = [];
    const pushScript = (scriptName: string | undefined) => {
      const normalized = scriptName?.trim();
      if (!normalized || normalized.startsWith("-")) {
        return;
      }
      if (!scripts.includes(normalized)) {
        scripts.push(normalized);
      }
    };

    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]?.trim().toLowerCase();
      if (token !== "npm") {
        index += 1;
        continue;
      }

      index += 1;
      let rootScoped = true;
      while (index < tokens.length) {
        const current = tokens[index]?.trim();
        const normalized = current?.toLowerCase() ?? "";
        if (
          normalized === "&&" ||
          normalized === "||" ||
          normalized === ";" ||
          normalized === "|" ||
          normalized === "&"
        ) {
          break;
        }

        if (
          normalized === "--prefix" ||
          normalized === "-c" ||
          normalized === "--workspace" ||
          normalized === "-w" ||
          normalized.startsWith("--prefix=") ||
          normalized.startsWith("--workspace=")
        ) {
          rootScoped = false;
          if (
            normalized === "--prefix" ||
            normalized === "-c" ||
            normalized === "--workspace" ||
            normalized === "-w"
          ) {
            index += 1;
          }
          index += 1;
          continue;
        }

        if (normalized === "run") {
          if (rootScoped) {
            pushScript(tokens[index + 1]);
          }
          break;
        }

        if (normalized === "test") {
          if (rootScoped) {
            pushScript("test");
          }
          break;
        }

        index += 1;
      }

      while (index < tokens.length) {
        const current = tokens[index]?.trim().toLowerCase();
        if (
          current === "&&" ||
          current === "||" ||
          current === ";" ||
          current === "|" ||
          current === "&"
        ) {
          index += 1;
          break;
        }
        index += 1;
      }
    }

    return scripts;
  }

  private curateHistorySection(
    history: readonly PipelinePlannerContextHistoryEntry[],
    relevanceTerms: ReadonlySet<string>,
    maxChars: number,
  ): CuratedSection {
    if (history.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }

    const lastIndex = history.length - 1;
    const pinned = new Set<number>();
    for (
      let index = Math.max(0, history.length - CONTEXT_HISTORY_TAIL_PIN);
      index <= lastIndex;
      index++
    ) {
      pinned.add(index);
    }

    const scored = history.map((entry, index) => {
      const score = this.scoreText(entry.content, relevanceTerms);
      return { entry, index, score };
    });
    const relevant = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.index - a.index;
      });
    const filtered = (
      relevant.length > 0
        ? relevant
        : scored.filter((item) => pinned.has(item.index))
    ).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.index - a.index;
    });
    const selectedIndices = new Set<number>(
      (filtered.length > 0 ? filtered : scored.slice(-CONTEXT_HISTORY_TAIL_PIN))
        .map((item) => item.index),
    );
    const orderedLines = scored
      .filter((item) => selectedIndices.has(item.index))
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => {
        const prefix = entry.toolName
          ? `[${entry.role}:${entry.toolName}]`
          : `[${entry.role}]`;
        return `${prefix} ${this.redactSensitiveData(entry.content)}`;
      });
    const section = this.applySectionCaps(orderedLines, maxChars);
    return {
      ...section,
      available: history.length,
      omitted: Math.max(0, history.length - section.selected),
    };
  }

  private curateMemorySection(
    memory: readonly PipelinePlannerContextMemoryEntry[],
    contextRequirements: readonly string[],
    relevanceTerms: ReadonlySet<string>,
    maxChars: number,
  ): CuratedSection {
    if (memory.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }
    const lowerRequirements = contextRequirements.map((term) =>
      term.toLowerCase()
    );
    const sourceHints = this.resolveAllowedMemorySources(lowerRequirements);
    if (sourceHints.size === 0) {
      return {
        lines: [],
        selected: 0,
        available: memory.length,
        omitted: memory.length,
        truncated: false,
      };
    }
    const eligible = memory.filter((entry) => sourceHints.has(entry.source));
    if (eligible.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: memory.length,
        omitted: memory.length,
        truncated: false,
      };
    }

    const queryTerms = this.expandContextQueryTerms(relevanceTerms);
    const bm25Scores = this.computeBm25Scores(
      eligible.map((entry, index) => ({
        id: String(index),
        text: entry.content,
      })),
      queryTerms,
    );
    const queryTermSet = new Set(queryTerms);
    const candidates = eligible
      .map((entry, index) => ({
        entry,
        score:
          (bm25Scores.get(String(index)) ?? 0) +
          this.scoreText(entry.content, queryTermSet),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.entry.source.localeCompare(b.entry.source);
      });
    if (candidates.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: memory.length,
        omitted: memory.length,
        truncated: false,
      };
    }
    const lines = candidates.map(
      ({ entry }) =>
        `[${entry.source}] ${this.redactSensitiveData(entry.content)}`,
    );
    const section = this.applySectionCaps(lines, maxChars);
    return {
      ...section,
      available: memory.length,
      omitted: Math.max(0, memory.length - section.selected),
    };
  }

  private curateToolOutputSection(
    step: PipelinePlannerSubagentStep,
    toolOutputs: readonly PipelinePlannerContextToolOutputEntry[],
    dependencies: readonly { dependencyName: string; result: string | null }[],
    relevanceTerms: ReadonlySet<string>,
    requirementTerms: readonly string[],
    maxChars: number,
  ): CuratedSection {
    const requiredCapabilities = new Set(
      step.requiredToolCapabilities.map((tool) => tool.toLowerCase()),
    );
    const requirementTermSet = new Set(
      requirementTerms.map((term) => term.toLowerCase()),
    );
    const dependencyLines = dependencies.map(
      ({ dependencyName, result }) =>
        `[dependency:${dependencyName}] ${this.redactSensitiveData(
          this.summarizeDependencyResultForPrompt(result),
        )}`,
    );
    const historicalLines = toolOutputs
      .map((entry) => {
        const toolName = entry.toolName?.toLowerCase();
        const capabilityMatch =
          typeof toolName === "string" &&
          Array.from(requiredCapabilities).some((required) =>
            toolName === required ||
            toolName.startsWith(required) ||
            required.startsWith(toolName)
          );
        const requirementMatch = this.scoreText(entry.content, requirementTermSet) > 0;
        const relevanceMatch = this.scoreText(entry.content, relevanceTerms) > 0;
        if (!capabilityMatch && !requirementMatch && !relevanceMatch) return null;
        const prefix = entry.toolName
          ? `[tool:${entry.toolName}]`
          : "[tool]";
        return `${prefix} ${this.redactSensitiveData(entry.content)}`;
      })
      .filter((line): line is string => line !== null);

    const combined = [...dependencyLines, ...historicalLines];
    const section = this.applySectionCaps(combined, maxChars);
    return {
      ...section,
      available: dependencies.length + toolOutputs.length,
      omitted: Math.max(
        0,
        dependencies.length + toolOutputs.length - section.selected,
      ),
    };
  }

  private curateDependencyArtifactSection(
    artifacts: readonly DependencyArtifactCandidate[],
    maxChars: number,
  ): CuratedSection {
    if (artifacts.length === 0 || maxChars <= 0) {
      return {
        lines: [],
        selected: 0,
        available: artifacts.length,
        omitted: artifacts.length,
        truncated: false,
      };
    }

    const prefixLengths = artifacts.map((artifact) =>
      `[artifact:${artifact.dependencyName}:${artifact.path}] `.length
    );
    const totalPrefixChars = prefixLengths.reduce((sum, value) => sum + value, 0);
    const previewBudget = Math.max(0, maxChars - totalPrefixChars);
    const weights = artifacts.map((artifact) =>
      artifact.score > 0 ? artifact.score : 1
    );
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const rawPreviewAllocations = weights.map((weight) =>
      totalWeight > 0 ? (previewBudget * weight) / totalWeight : 0
    );
    const previewAllocations = rawPreviewAllocations.map((value) =>
      Math.floor(value)
    );
    let remainder =
      previewBudget - previewAllocations.reduce((sum, value) => sum + value, 0);
    const fractionalOrder = rawPreviewAllocations
      .map((value, index) => ({ index, fractional: value - previewAllocations[index]! }))
      .sort((a, b) => b.fractional - a.fractional);
    for (const entry of fractionalOrder) {
      if (remainder <= 0) break;
      previewAllocations[entry.index] =
        (previewAllocations[entry.index] ?? 0) + 1;
      remainder -= 1;
    }
    const lines = artifacts.map((artifact, index) => {
      const prefix = `[artifact:${artifact.dependencyName}:${artifact.path}]`;
      const normalizedContent = artifact.content.trim().replace(/\s+/g, " ");
      const previewChars = previewAllocations[index] ?? 0;
      if (previewChars <= 0 || normalizedContent.length === 0) {
        return prefix;
      }
      return `${prefix} ${
        this.truncateText(normalizedContent, previewChars)
      }`;
    });
    const section = this.applySectionCaps(lines, maxChars);
    return {
      ...section,
      available: artifacts.length,
      omitted: Math.max(0, artifacts.length - section.selected),
    };
  }

  private collectDependencyArtifactCandidates(
    dependencies: readonly DependencyContextEntry[],
    queryTerms: ReadonlySet<string>,
    workspaceRoot?: string,
  ): readonly DependencyArtifactCandidate[] {
    if (dependencies.length === 0) return [];
    const candidates = new Map<string, DependencyArtifactCandidate>();
    let order = 0;

    dependencies.forEach(({ dependencyName, result, depth }) => {
      if (typeof result !== "string" || result.trim().length === 0) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }

      const record = parsed as Record<string, unknown>;
      const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
      for (const toolCall of toolCalls) {
        const extracted = this.extractDependencyArtifactsFromToolCall(toolCall);
        for (const artifact of extracted) {
          const normalizedPath = this.normalizeDependencyArtifactPath(
            artifact.path,
            workspaceRoot,
          );
          if (!this.isDependencyArtifactPathCandidate(normalizedPath)) {
            continue;
          }
          const content = artifact.content.trim();
          if (content.length === 0) continue;
          const candidate: DependencyArtifactCandidate = {
            dependencyName,
            path: normalizedPath,
            content,
            score: 0,
            order,
            depth,
          };
          order += 1;
          const previous = candidates.get(normalizedPath);
          if (
            !previous ||
            candidate.depth < previous.depth ||
            (
              candidate.depth === previous.depth &&
              candidate.order > previous.order
            )
          ) {
            candidates.set(normalizedPath, candidate);
          }
        }
      }
    });

    const uniqueCandidates = [...candidates.values()];
    if (uniqueCandidates.length === 0) {
      return [];
    }

    const bm25Scores = this.computeBm25Scores(
      uniqueCandidates.map((candidate) => ({
        id: candidate.path,
        text: `${candidate.path}\n${candidate.content}`,
      })),
      [...queryTerms],
    );

    return uniqueCandidates
      .map((candidate) => ({
        ...candidate,
        score: bm25Scores.get(candidate.path) ?? 0,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.order - b.order;
      });
  }

  private collectWorkspaceArtifactCandidates(
    workspaceRoot: string,
    queryTerms: ReadonlySet<string>,
    maxChars: number,
  ): readonly DependencyArtifactCandidate[] {
    const normalizedWorkspaceRoot = resolvePath(workspaceRoot);
    if (
      maxChars <= 0 ||
      !existsSync(normalizedWorkspaceRoot)
    ) {
      return [];
    }

    const candidatePaths = this.collectWorkspaceArtifactPaths(
      normalizedWorkspaceRoot,
      0,
      [],
    );
    if (candidatePaths.length === 0) {
      return [];
    }

    const documents: { id: string; text: string }[] = [];
    const byPath = new Map<string, DependencyArtifactCandidate>();
    for (const absolutePath of candidatePaths) {
      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile() || stats.size > WORKSPACE_CONTEXT_MAX_FILE_BYTES) {
          continue;
        }
        const relativePath = this.normalizeDependencyArtifactPath(
          absolutePath,
          normalizedWorkspaceRoot,
        );
        if (!this.isDependencyArtifactPathCandidate(relativePath)) {
          continue;
        }
        const rawContent = readFileSync(absolutePath, "utf-8");
        const content = rawContent.trim();
        if (content.length === 0) continue;
        const truncatedContent = this.truncateText(
          content,
          WORKSPACE_CONTEXT_MAX_CONTENT_CHARS,
        );
        documents.push({
          id: relativePath,
          text: `${relativePath}\n${truncatedContent}`,
        });
        byPath.set(relativePath, {
          dependencyName: "workspace_context",
          path: relativePath,
          content: truncatedContent,
          score: 0,
          order: byPath.size,
          depth: 0,
        });
      } catch {
        // Best-effort prompt enrichment only.
      }
    }

    if (documents.length === 0) {
      return [];
    }

    const scores = this.computeBm25Scores(documents, [...queryTerms]);
    const scored = [...byPath.values()]
      .map((candidate) => ({
        ...candidate,
        score:
          (scores.get(candidate.path) ?? 0) +
          this.scoreText(candidate.path, queryTerms),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.path.localeCompare(b.path);
      });
    const positiveScoreCount = scored.filter((candidate) => candidate.score > 0).length;
    const targetCount = Math.max(
      WORKSPACE_CONTEXT_MIN_CANDIDATES,
      Math.min(
        WORKSPACE_CONTEXT_MAX_CANDIDATES,
        Math.floor(maxChars / 600),
      ),
    );
    const selected = positiveScoreCount > 0
      ? scored.slice(
        0,
        Math.min(
          WORKSPACE_CONTEXT_MAX_CANDIDATES,
          Math.max(targetCount, positiveScoreCount),
        ),
      )
      : (() => {
        const bootstrapCandidates = scored.filter((candidate) =>
          this.isWorkspaceBootstrapArtifact(candidate.path)
        );
        return (bootstrapCandidates.length > 0 ? bootstrapCandidates : scored).slice(
          0,
          targetCount,
        );
      })();

    return selected;
  }

  private collectWorkspaceArtifactPaths(
    directory: string,
    depth: number,
    collected: string[],
  ): string[] {
    if (
      depth > WORKSPACE_CONTEXT_MAX_SCAN_DEPTH ||
      collected.length >= WORKSPACE_CONTEXT_MAX_SCAN_FILES
    ) {
      return collected;
    }

    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return collected;
    }

    for (const entry of entries) {
      if (collected.length >= WORKSPACE_CONTEXT_MAX_SCAN_FILES) {
        break;
      }
      if (WORKSPACE_CONTEXT_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        this.collectWorkspaceArtifactPaths(
          absolutePath,
          depth + 1,
          collected,
        );
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!WORKSPACE_CONTEXT_CANDIDATE_PATH_RE.test(entry.name)) {
        continue;
      }
      collected.push(absolutePath);
    }

    return collected;
  }

  private isWorkspaceBootstrapArtifact(path: string): boolean {
    const normalized = path.trim().toLowerCase();
    return (
      normalized.endsWith("package.json") ||
      normalized.endsWith("index.html") ||
      normalized.endsWith("tsconfig.json") ||
      normalized.endsWith("vite.config.ts") ||
      normalized.endsWith("vite.config.js") ||
      normalized.endsWith("vitest.config.ts") ||
      normalized.endsWith("vitest.config.js") ||
      normalized.includes("/src/")
    );
  }

  private extractDependencyArtifactsFromToolCall(
    toolCall: unknown,
  ): readonly { path: string; content: string }[] {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
      return [];
    }

    const record = toolCall as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const args =
      typeof record.args === "object" &&
        record.args !== null &&
        !Array.isArray(record.args)
        ? record.args as Record<string, unknown>
        : undefined;
    const rawResult = typeof record.result === "string" ? record.result : "";

    if (
      (name === "system.writeFile" || name === "system.appendFile") &&
      args
    ) {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      return path.trim().length > 0 && content.trim().length > 0
        ? [{ path, content }]
        : [];
    }

    if (name === "system.readFile") {
      const path =
        (args && typeof args.path === "string" ? args.path : "").trim();
      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(rawResult);
      } catch {
        parsedResult = undefined;
      }
      if (
        parsedResult &&
        typeof parsedResult === "object" &&
        !Array.isArray(parsedResult)
      ) {
        const resultRecord = parsedResult as Record<string, unknown>;
        const resultPath =
          typeof resultRecord.path === "string" ? resultRecord.path : path;
        const content =
          typeof resultRecord.content === "string" ? resultRecord.content : "";
        return resultPath.trim().length > 0 && content.trim().length > 0
          ? [{ path: resultPath, content }]
          : [];
      }
      return [];
    }

    if (name !== "system.bash" || !args) {
      return [];
    }

    const command = typeof args.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    if (command !== "cat" || commandArgs.length === 0) {
      return [];
    }

    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(rawResult);
    } catch {
      parsedResult = undefined;
    }
    if (
      !parsedResult ||
      typeof parsedResult !== "object" ||
      Array.isArray(parsedResult)
    ) {
      return [];
    }
    const stdout = (parsedResult as Record<string, unknown>).stdout;
    return typeof stdout === "string" && stdout.trim().length > 0
      ? [{ path: commandArgs[0]!, content: stdout }]
      : [];
  }

  private normalizeDependencyArtifactPath(
    path: string,
    workspaceRoot?: string,
  ): string {
    const normalize = (value: string): string =>
      value
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/$/, "");

    const normalizedPath = normalize(path);
    if (normalizedPath.length === 0) {
      return normalizedPath;
    }

    const normalizedWorkspaceRoot =
      typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0
        ? normalize(workspaceRoot)
        : "";
    if (
      normalizedWorkspaceRoot.length > 0 &&
      (
        normalizedPath === normalizedWorkspaceRoot ||
        normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)
      )
    ) {
      return normalizedPath
        .slice(normalizedWorkspaceRoot.length)
        .replace(/^\/+/, "");
    }

    return normalizedPath;
  }

  private isDependencyArtifactPathCandidate(path: string): boolean {
    const normalized = path.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (
      RUST_GENERATED_ARTIFACT_PATH_RE.test(normalized) ||
      normalized.includes("/node_modules/") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes("/dist/") ||
      normalized.startsWith("dist/") ||
      normalized.endsWith(".tsbuildinfo")
    ) {
      return false;
    }
    return /\.(?:[cm]?[jt]sx?|json|md|txt|toml|lock|ya?ml)$/i.test(normalized);
  }

  private allocateContextGroupBudgets(
    totalChars: number,
    groups: readonly { key: string; active: boolean }[],
  ): Record<string, number> {
    const activeGroups = groups.filter((group) => group.active);
    const budgets: Record<string, number> = {};
    if (activeGroups.length === 0) {
      return budgets;
    }
    const base = Math.floor(totalChars / activeGroups.length);
    let remainder = totalChars - base * activeGroups.length;
    for (const group of activeGroups) {
      budgets[group.key] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    return budgets;
  }

  private resolveAllowedMemorySources(
    lowerRequirements: readonly string[],
  ): Set<PipelinePlannerContextMemorySource> {
    const allowed = new Set<PipelinePlannerContextMemorySource>();
    for (const requirement of lowerRequirements) {
      const normalized = requirement.replace(/[_-]+/g, " ").trim();
      if (
        /\b(?:memory semantic|semantic memory)\b/i.test(normalized)
      ) {
        allowed.add("memory_semantic");
      }
      if (
        /\b(?:memory episodic|episodic memory)\b/i.test(normalized)
      ) {
        allowed.add("memory_episodic");
      }
      if (
        /\b(?:memory working|working memory)\b/i.test(normalized)
      ) {
        allowed.add("memory_working");
      }
    }
    return allowed;
  }

  private redactSensitiveData(value: string): string {
    if (value.length === 0) return value;
    let redacted = value;
    redacted = redacted.replace(PRIVATE_KEY_BLOCK_RE, REDACTED_PRIVATE_KEY_BLOCK);
    redacted = redacted.replace(IMAGE_DATA_URL_RE, REDACTED_IMAGE_DATA_URL);
    redacted = redacted.replace(BEARER_TOKEN_RE, REDACTED_BEARER_TOKEN);
    redacted = redacted.replace(
      API_KEY_ASSIGNMENT_RE,
      (_match, key: string) => `${key}=<redacted>`,
    );
    redacted = redacted.replace(OPENAI_KEY_RE, REDACTED_API_KEY);
    redacted = redacted.replace(INTERNAL_URL_RE, REDACTED_INTERNAL_URL);
    redacted = redacted.replace(FILE_URL_RE, REDACTED_FILE_URL);
    redacted = redacted.replace(
      ABSOLUTE_PATH_RE,
      (_match, prefix: string) => `${prefix}${REDACTED_ABSOLUTE_PATH}`,
    );
    return redacted;
  }

  private buildRelevanceTerms(
    step: PipelinePlannerSubagentStep,
  ): Set<string> {
    const aggregate = [
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      ...step.requiredToolCapabilities,
    ].join(" ");
    return new Set(this.extractTerms(aggregate));
  }

  private singularizeContextTerm(value: string): string {
    if (value.endsWith("ies") && value.length > 3) {
      return `${value.slice(0, -3)}y`;
    }
    if (value.endsWith("s") && value.length > CONTEXT_TERM_MIN_LENGTH) {
      return value.slice(0, -1);
    }
    return value;
  }

  private expandContextQueryTerms(terms: ReadonlySet<string>): string[] {
    const expanded = new Set<string>();
    for (const term of terms) {
      const normalized = term.trim().toLowerCase();
      if (normalized.length < CONTEXT_TERM_MIN_LENGTH) continue;
      expanded.add(normalized);
      expanded.add(this.singularizeContextTerm(normalized));
      for (const fragment of normalized.split(/[._-]+/g)) {
        if (fragment.length < CONTEXT_TERM_MIN_LENGTH) continue;
        expanded.add(fragment);
        expanded.add(this.singularizeContextTerm(fragment));
      }
    }
    return [...expanded].filter((term) => term.length >= CONTEXT_TERM_MIN_LENGTH);
  }

  private extractTerms(value: string): string[] {
    const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
    const deduped = new Set<string>();
    for (const match of matches) {
      if (match.length < CONTEXT_TERM_MIN_LENGTH) continue;
      deduped.add(match);
    }
    return [...deduped];
  }

  private computeBm25Scores(
    documents: readonly { id: string; text: string }[],
    queryTerms: readonly string[],
  ): ReadonlyMap<string, number> {
    if (documents.length === 0 || queryTerms.length === 0) {
      return new Map();
    }

    const filteredQueryTerms = [...new Set(
      queryTerms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= CONTEXT_TERM_MIN_LENGTH),
    )];
    if (filteredQueryTerms.length === 0) {
      return new Map();
    }

    const stats = documents.map((document) => {
      const tokens = document.text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
      const termFrequencies = new Map<string, number>();
      for (const token of tokens) {
        if (token.length < CONTEXT_TERM_MIN_LENGTH) continue;
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
      }
      return {
        id: document.id,
        length: Math.max(1, tokens.length),
        termFrequencies,
      };
    });

    const averageDocumentLength =
      stats.reduce((sum, document) => sum + document.length, 0) / stats.length;
    const documentFrequency = new Map<string, number>();
    for (const term of filteredQueryTerms) {
      documentFrequency.set(
        term,
        stats.reduce(
          (count, document) =>
            count + (document.termFrequencies.has(term) ? 1 : 0),
          0,
        ),
      );
    }

    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map<string, number>();
    for (const document of stats) {
      let score = 0;
      for (const term of filteredQueryTerms) {
        const termFrequency = document.termFrequencies.get(term) ?? 0;
        if (termFrequency <= 0) continue;
        const docFrequency = documentFrequency.get(term) ?? 0;
        const idf = Math.log(
          1 + (stats.length - docFrequency + 0.5) / (docFrequency + 0.5),
        );
        const normalization =
          termFrequency +
          k1 * (1 - b + b * (document.length / Math.max(1, averageDocumentLength)));
        score += idf * ((termFrequency * (k1 + 1)) / Math.max(1e-9, normalization));
      }
      scores.set(document.id, score);
    }

    return scores;
  }

  private scoreText(text: string, terms: ReadonlySet<string>): number {
    if (terms.size === 0) return 0;
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score++;
    }
    return score;
  }

  private applySectionCaps(
    lines: readonly string[],
    maxChars: number,
  ): CuratedSection {
    const cleaned = lines
      .map((line) => this.redactSensitiveData(line.trim()))
      .filter((line) => line.length > 0);
    if (cleaned.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }

    const selected: string[] = [];
    let usedChars = 0;
    let truncated = false;
    for (const line of cleaned) {
      const remaining = maxChars - usedChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (line.length <= remaining) {
        selected.push(line);
        usedChars += line.length + 1;
        continue;
      }
      if (remaining >= 24) {
        selected.push(this.truncateText(line, remaining));
      }
      truncated = true;
      break;
    }
    const omitted = Math.max(0, cleaned.length - selected.length);
    if (omitted > 0) truncated = true;
    return {
      lines: selected,
      selected: selected.length,
      available: cleaned.length,
      omitted,
      truncated,
    };
  }

  private truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
    return value.slice(0, maxChars - 3) + "...";
  }

  private resolveSubagentPromptBudgetCaps(
    promptBudget?: PromptBudgetConfig,
  ): SubagentPromptBudgetCaps {
    if (!promptBudget) {
      return {
        historyChars: FALLBACK_CONTEXT_HISTORY_CHARS,
        memoryChars: FALLBACK_CONTEXT_MEMORY_CHARS,
        toolOutputChars: FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS,
        totalPromptChars: FALLBACK_SUBAGENT_TASK_PROMPT_CHARS,
      };
    }

    const plan = derivePromptBudgetPlan(promptBudget);
    return {
      historyChars: plan.caps.historyChars,
      memoryChars: plan.caps.memoryChars,
      toolOutputChars: plan.caps.toolChars,
      totalPromptChars:
        plan.caps.userChars +
        plan.caps.historyChars +
        plan.caps.memoryChars +
        plan.caps.toolChars +
        plan.caps.assistantRuntimeChars +
        plan.caps.otherChars,
    };
  }

  private summarizeDependencyResultForPrompt(result: string | null): string {
    if (result === null) return "null";

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return this.truncateText(result, 320);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.truncateText(result, 320);
    }

    const record = parsed as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    for (const key of [
      "status",
      "success",
      "durationMs",
      "providerName",
      "attempts",
      "stopReason",
      "stopReasonDetail",
      "validationCode",
    ]) {
      const value = record[key];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        summary[key] = value;
      }
    }

    if (Array.isArray(record.toolCalls)) {
      const toolNames = new Set<string>();
      const modifiedFiles: string[] = [];
      const verificationCommandStates = new Map<string, number>();
      for (const entry of record.toolCalls) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const toolCall = entry as Record<string, unknown>;
        const name = toolCall.name;
        if (typeof name === "string" && name.trim().length > 0) {
          toolNames.add(name);
        }
        const args =
          typeof toolCall.args === "object" &&
            toolCall.args !== null &&
            !Array.isArray(toolCall.args)
            ? toolCall.args as Record<string, unknown>
            : undefined;
        if ((name === "system.writeFile" || name === "system.appendFile") && args) {
          const path = typeof args.path === "string" ? args.path.trim() : "";
          const normalizedPath = this.normalizeDependencyArtifactPath(path);
          if (
            normalizedPath.length > 0 &&
            this.isDependencyArtifactPathCandidate(normalizedPath) &&
            !modifiedFiles.includes(normalizedPath)
          ) {
            modifiedFiles.push(normalizedPath);
          }
        }
        if (name === "system.bash" || name === "desktop.bash") {
          const command = this.summarizeDependencyShellCommand(args);
          if (!command || !this.isDependencyVerificationCommand(command)) {
            continue;
          }
          const exitCode = this.extractDependencyCommandExitCode(
            typeof toolCall.result === "string" ? toolCall.result : "",
          );
          if (typeof exitCode === "number") {
            verificationCommandStates.set(command, exitCode);
          }
        }
      }
      const verifiedCommands = [...verificationCommandStates.entries()]
        .filter(([, exitCode]) => exitCode === 0)
        .map(([command]) => command);
      const failedCommands = [...verificationCommandStates.entries()]
        .filter(([, exitCode]) => exitCode !== 0)
        .map(([command]) => command);
      if (modifiedFiles.length > 0) {
        summary.modifiedFiles = modifiedFiles.slice(0, 6);
      }
      if (verifiedCommands.length > 0) {
        summary.verifiedCommands = verifiedCommands.slice(0, 4);
      }
      if (failedCommands.length > 0) {
        summary.failedCommands = failedCommands.slice(0, 4);
      }
      summary.toolCallSummary = {
        count: record.toolCalls.length,
        tools: [...toolNames],
      };
    }

    if (
      typeof record.output === "string" &&
      record.output.trim().length > 0 &&
      summary.modifiedFiles === undefined &&
      summary.verifiedCommands === undefined &&
      summary.failedCommands === undefined
    ) {
      summary.outputSummary = this.summarizeDependencyOutputText(record.output);
    }

    return safeStringify(
      Object.keys(summary).length > 0 ? summary : record,
    );
  }

  private summarizeDependencyShellCommand(
    args: Record<string, unknown> | undefined,
  ): string | undefined {
    if (!args) return undefined;
    const command =
      typeof args.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const rendered = [command, ...commandArgs]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    return rendered.length > 0 ? rendered : undefined;
  }

  private isDependencyVerificationCommand(command: string): boolean {
    return /\b(?:npm|pnpm|yarn|bun|vitest|jest|tsc)\b/i.test(command) &&
      /\b(?:build|test|coverage|verify|check|install|run)\b/i.test(command);
  }

  private extractDependencyCommandExitCode(result: string): number | undefined {
    if (result.trim().length === 0) return undefined;
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      return typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
        ? parsed.exitCode
        : undefined;
    } catch {
      return undefined;
    }
  }

  private summarizeDependencyOutputText(output: string): string {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return this.truncateText(output.trim(), 240);
    }
    return this.truncateText(lines.slice(0, 3).join(" "), 240);
  }

  private resolveParentSessionId(pipelineId: string): string {
    if (!pipelineId.startsWith("planner:")) return pipelineId;
    const encodedParentSessionId = pipelineId.slice("planner:".length);
    const separatorIndex = encodedParentSessionId.lastIndexOf(":");
    if (separatorIndex <= 0) {
      return encodedParentSessionId || pipelineId;
    }
    return encodedParentSessionId.slice(0, separatorIndex);
  }
}
