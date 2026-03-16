/**
 * Factory for constructing ChatExecutor instances from gateway config.
 *
 * Extracts the duplicated ChatExecutor construction logic from daemon.ts
 * (wireWebChat + hotSwapLLMProvider) into a single reusable factory.
 *
 * Gate 3 — prerequisite reduction for planner/pipeline cross-cut.
 */

import { ChatExecutor } from "../llm/chat-executor.js";
import type { ChatExecutorConfig } from "../llm/chat-executor-types.js";
import type { LLMProvider } from "../llm/types.js";
import type { ToolHandler } from "../tools/registry.js";
import type { SkillInjector, MemoryRetriever } from "../llm/chat-executor-types.js";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor-types.js";
import type { GatewayLLMConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Resolved subagent config shape (matches resolveSubAgentRuntimeConfig output)
// ---------------------------------------------------------------------------

export interface ResolvedSubAgentConfigForExecutor {
  readonly enabled: boolean;
  readonly unsafeBenchmarkMode: boolean;
  readonly mode: string;
  readonly baseSpawnDecisionThreshold: number;
  readonly maxFanoutPerTurn: number;
  readonly maxDepth: number;
  readonly handoffMinPlannerConfidence: number;
  readonly hardBlockedTaskClasses: readonly string[];
  readonly forceVerifier: boolean;
}

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

export interface CreateChatExecutorParams {
  /** LLM providers (if empty, returns null). */
  providers: LLMProvider[];
  /** Base tool handler from ToolRegistry. */
  toolHandler: ToolHandler;
  /** Tool names advertised to the model. */
  allowedTools: readonly string[];
  /** Optional skill injector. */
  skillInjector?: SkillInjector;
  /** Optional memory retriever. */
  memoryRetriever?: MemoryRetriever;
  /** Optional learning provider. */
  learningProvider?: ChatExecutorConfig["learningProvider"];
  /** Optional progress provider. */
  progressProvider?: ChatExecutorConfig["progressProvider"];
  /** Prompt budget config. */
  promptBudget?: ChatExecutorConfig["promptBudget"];
  /** Max tool rounds per request. */
  maxToolRounds: number;
  /** Session token budget. */
  sessionTokenBudget?: ChatExecutorConfig["sessionTokenBudget"];
  /** Compaction callback. */
  onCompaction?: ChatExecutorConfig["onCompaction"];
  /** Gateway LLM config (for planner, timeout, retry, circuit breaker settings). */
  llmConfig?: GatewayLLMConfig;
  /** Resolved subagent runtime config. */
  subagentConfig: ResolvedSubAgentConfigForExecutor;
  /** Callback to resolve dynamic delegation score threshold. */
  resolveDelegationScoreThreshold: () => number;
  /** Delegation learning sinks. */
  delegationLearning?: {
    trajectorySink?: unknown;
    banditTuner?: unknown;
    defaultStrategyArmId?: string;
  };
  /** Callback to resolve host tooling profile. */
  resolveHostToolingProfile: () => unknown;
  /** Optional deterministic pipeline executor. */
  pipelineExecutor?: DeterministicPipelineExecutor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ChatExecutor from gateway-level config, or null if no providers.
 *
 * This centralizes the ~50-line construction block that was duplicated in
 * daemon.ts wireWebChat() and hotSwapLLMProvider().
 */
export function createChatExecutor(
  params: CreateChatExecutorParams,
): ChatExecutor | null {
  if (params.providers.length === 0) {
    return null;
  }

  const { subagentConfig, llmConfig } = params;

  return new ChatExecutor({
    providers: params.providers,
    toolHandler: params.toolHandler,
    allowedTools: params.allowedTools,
    skillInjector: params.skillInjector,
    memoryRetriever: params.memoryRetriever,
    learningProvider: params.learningProvider,
    progressProvider: params.progressProvider,
    promptBudget: params.promptBudget,
    maxToolRounds: params.maxToolRounds,
    plannerEnabled:
      llmConfig?.plannerEnabled ?? subagentConfig.enabled,
    plannerMaxTokens: llmConfig?.plannerMaxTokens,
    toolBudgetPerRequest: llmConfig?.toolBudgetPerRequest,
    maxModelRecallsPerRequest: llmConfig?.maxModelRecallsPerRequest,
    maxFailureBudgetPerRequest: llmConfig?.maxFailureBudgetPerRequest,
    delegationDecision: {
      enabled: subagentConfig.enabled,
      mode: subagentConfig.mode,
      scoreThreshold: subagentConfig.baseSpawnDecisionThreshold,
      maxFanoutPerTurn: subagentConfig.maxFanoutPerTurn,
      maxDepth: subagentConfig.maxDepth,
      handoffMinPlannerConfidence:
        subagentConfig.handoffMinPlannerConfidence,
      hardBlockedTaskClasses: subagentConfig.hardBlockedTaskClasses,
    },
    resolveDelegationScoreThreshold: params.resolveDelegationScoreThreshold,
    subagentVerifier: {
      enabled:
        subagentConfig.enabled &&
        !subagentConfig.unsafeBenchmarkMode,
      force: subagentConfig.forceVerifier,
    },
    delegationLearning: {
      trajectorySink: params.delegationLearning?.trajectorySink,
      banditTuner: params.delegationLearning?.banditTuner,
      defaultStrategyArmId:
        params.delegationLearning?.defaultStrategyArmId ?? "balanced",
    },
    toolCallTimeoutMs: llmConfig?.toolCallTimeoutMs,
    requestTimeoutMs: llmConfig?.requestTimeoutMs,
    retryPolicyMatrix: llmConfig?.retryPolicy,
    toolFailureCircuitBreaker: llmConfig?.toolFailureCircuitBreaker,
    resolveHostToolingProfile: params.resolveHostToolingProfile,
    pipelineExecutor: params.pipelineExecutor,
    sessionTokenBudget: params.sessionTokenBudget,
    onCompaction: params.onCompaction,
  });
}
