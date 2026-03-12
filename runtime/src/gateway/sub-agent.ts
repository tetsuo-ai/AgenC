/**
 * Sub-agent spawning — parallel isolated task execution within a session.
 *
 * Sub-agents are independently scoped ChatExecutor instances that execute a
 * task description with configurable tool access, workspace isolation, and
 * timeout enforcement.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type {
  IsolatedSessionContext,
  SubAgentSessionIdentity,
} from "./session-isolation.js";
import { createGatewayMessage } from "./message.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import type { PromptBudgetConfig } from "../llm/prompt-budget.js";
import type {
  ChatExecutorResult,
  ToolCallRecord,
} from "../llm/chat-executor-types.js";
import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type {
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMMessage,
  LLMProviderEvidence,
  LLMUsage,
  ToolHandler,
} from "../llm/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
  logStructuredTraceEvent,
} from "../llm/provider-trace-logger.js";
import { resolveMaxToolRoundsForToolNames } from "./tool-round-budget.js";
import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import {
  getMissingSuccessfulToolEvidenceMessage,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import { SubAgentSpawnError } from "./errors.js";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 3_600_000; // 60 min
export const DEFAULT_SUB_AGENT_CONTEXT_STARTUP_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_SUB_AGENTS = 16;
export const DEFAULT_MAX_SUB_AGENT_DEPTH = 4;
export const DEFAULT_MAX_RETAINED_TERMINAL_SUB_AGENTS = 256;
export const DEFAULT_TERMINAL_SUB_AGENT_RETENTION_MS = 6 * 60 * 60 * 1000; // 6h
export const SUB_AGENT_SESSION_PREFIX = "subagent:";

const DEFAULT_SUB_AGENT_SYSTEM_PROMPT =
  "You are a sub-agent. Execute only the assigned phase, stay within the provided scope, " +
  "and report the result concisely. Do not reinterpret the broader parent request into a " +
  "new multi-step plan, do not attempt sibling phases, and do not delegate unless the " +
  "task explicitly grants that authority.";

const ABORT_SENTINEL = Symbol("abort");
const TIMEOUT_SENTINEL = Symbol("timeout");

/**
 * Race a promise against an AbortSignal.
 * Resolves/rejects normally if the promise settles first,
 * or returns `ABORT_SENTINEL` if the signal fires first.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORT_SENTINEL> {
  if (signal.aborted) return Promise.resolve(ABORT_SENTINEL);
  return Promise.race([
    promise,
    new Promise<typeof ABORT_SENTINEL>((resolve) => {
      signal.addEventListener("abort", () => resolve(ABORT_SENTINEL), {
        once: true,
      });
    }),
  ]);
}

function raceAbortOrTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | typeof ABORT_SENTINEL | typeof TIMEOUT_SENTINEL> {
  if (signal.aborted) return Promise.resolve(ABORT_SENTINEL);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve(ABORT_SENTINEL);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ============================================================================
// Types
// ============================================================================

export type SubAgentStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "timed_out"
  | "failed";

export interface SubAgentConfig {
  readonly parentSessionId: string;
  readonly task: string;
  readonly prompt?: string;
  readonly continuationSessionId?: string;
  readonly timeoutMs?: number;
  readonly workingDirectory?: string;
  readonly workingDirectorySource?: "context_requirement" | "task_text";
  readonly workspace?: string;
  readonly tools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly requireToolCall?: boolean;
  readonly delegationSpec?: DelegationContractSpec;
  readonly unsafeBenchmarkMode?: boolean;
}

export interface SubAgentResult {
  readonly sessionId: string;
  readonly output: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly providerEvidence?: LLMProviderEvidence;
  readonly tokenUsage?: LLMUsage;
  readonly providerName?: string;
  readonly stopReason?: ChatExecutorResult["stopReason"];
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
}

export interface SubAgentManagerConfig {
  readonly createContext: (
    sessionIdentity: SubAgentSessionIdentity,
  ) => Promise<IsolatedSessionContext>;
  readonly destroyContext: (
    sessionIdentity: SubAgentSessionIdentity,
  ) => Promise<void>;
  readonly defaultWorkspaceId?: string;
  readonly contextStartupTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxDepth?: number;
  readonly maxRetainedTerminalHandles?: number;
  readonly terminalHandleRetentionMs?: number;
  readonly systemPrompt?: string;
  readonly composeToolHandler?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    context: IsolatedSessionContext;
    baseToolHandler: ToolHandler;
    task: string;
    allowedToolNames?: readonly string[];
    workingDirectory?: string;
    desktopRoutingSessionId: string;
  }) => ToolHandler;
  readonly selectLLMProvider?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    contextProvider: LLMProvider;
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) => LLMProvider | undefined;
  readonly resolveExecutionBudget?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    contextProvider: LLMProvider;
    selectedProvider: LLMProvider;
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) =>
    | Promise<ResolvedSubAgentExecutionBudget | undefined>
    | ResolvedSubAgentExecutionBudget
    | undefined;
  readonly resolveDefaultMaxToolRounds?: () => number | undefined;
  readonly logger?: Logger;
  readonly traceExecution?: boolean;
  readonly traceProviderPayloads?: boolean;
  readonly promptBudget?: PromptBudgetConfig;
  readonly sessionTokenBudget?: number;
  readonly onCompaction?: (sessionId: string, summary: string) => void;
}

export interface ResolvedSubAgentExecutionBudget {
  readonly promptBudget?: PromptBudgetConfig;
  readonly sessionTokenBudget?: number;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

export interface SubAgentInfo {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly status: SubAgentStatus;
  readonly startedAt: number;
  readonly task: string;
}

// ============================================================================
// Internal handle (not exported)
// ============================================================================

interface SubAgentHandle {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly task: string;
  readonly config: SubAgentConfig;
  history: LLMMessage[];
  readonly startedAt: number;
  status: SubAgentStatus;
  result: SubAgentResult | null;
  readonly abortController: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  execution: Promise<void>;
  finishedAt: number | null;
}

function mapChatStopReasonToSubAgentStatus(
  stopReason: ChatExecutorResult["stopReason"],
): Exclude<SubAgentStatus, "running"> {
  if (stopReason === "completed") return "completed";
  if (stopReason === "timeout") return "timed_out";
  if (stopReason === "cancelled") return "cancelled";
  return "failed";
}

// ============================================================================
// SubAgentManager
// ============================================================================

export class SubAgentManager {
  private readonly handles = new Map<string, SubAgentHandle>();
  private readonly config: SubAgentManagerConfig;
  private readonly maxConcurrent: number;
  private readonly maxDepth: number;
  private readonly maxRetainedTerminalHandles: number;
  private readonly terminalHandleRetentionMs: number;
  private readonly logger: Logger;

  constructor(config: SubAgentManagerConfig) {
    this.config = config;
    this.maxConcurrent = config.maxConcurrent ?? MAX_CONCURRENT_SUB_AGENTS;
    this.maxDepth = Math.max(
      1,
      Math.floor(config.maxDepth ?? DEFAULT_MAX_SUB_AGENT_DEPTH),
    );
    this.maxRetainedTerminalHandles = Math.max(
      1,
      Math.floor(
        config.maxRetainedTerminalHandles ??
          DEFAULT_MAX_RETAINED_TERMINAL_SUB_AGENTS,
      ),
    );
    this.terminalHandleRetentionMs = Math.max(
      0,
      Math.floor(
        config.terminalHandleRetentionMs ??
          DEFAULT_TERMINAL_SUB_AGENT_RETENTION_MS,
      ),
    );
    this.logger = config.logger ?? silentLogger;
  }

  get activeCount(): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.status === "running") count++;
    }
    return count;
  }

  async spawn(config: SubAgentConfig): Promise<string> {
    this.pruneTerminalHandles();

    // Validate inputs
    if (!config.parentSessionId) {
      throw new SubAgentSpawnError("", "parentSessionId must be non-empty");
    }
    if (!config.task) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        "task must be non-empty",
      );
    }
    if (this.activeCount >= this.maxConcurrent) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `max concurrent sub-agents reached (${this.maxConcurrent})`,
      );
    }
    const continuationHandle = this.resolveContinuationHandle(config);
    const parentDepth = this.resolveSessionDepth(config.parentSessionId);
    const depth = continuationHandle
      ? continuationHandle.depth
      : parentDepth + 1;
    if (!continuationHandle && depth > this.maxDepth) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `max sub-agent depth reached (${this.maxDepth})`,
      );
    }

    const sessionId = continuationHandle?.sessionId ??
      `${SUB_AGENT_SESSION_PREFIX}${randomUUID()}`;
    const abortController = new AbortController();

    const handle: SubAgentHandle = {
      sessionId,
      parentSessionId: config.parentSessionId,
      depth,
      task: config.task,
      config,
      history: continuationHandle ? [...continuationHandle.history] : [],
      startedAt: Date.now(),
      status: "running",
      result: null,
      abortController,
      timeoutTimer: null,
      execution: Promise.resolve(),
      finishedAt: null,
    };

    this.handles.set(sessionId, handle);

    // Fire-and-forget execution
    handle.execution = this.executeSubAgent(handle).catch(() => {
      // Errors are captured in the handle, no unhandled rejection
    });

    this.logger.info(
      `Sub-agent ${sessionId} spawned for parent ${config.parentSessionId}`,
    );
    return sessionId;
  }

  getResult(sessionId: string): SubAgentResult | null {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    if (handle.status === "running") return null;
    return handle.result;
  }

  getInfo(sessionId: string): SubAgentInfo | null {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    return {
      sessionId: handle.sessionId,
      parentSessionId: handle.parentSessionId,
      depth: handle.depth,
      status: handle.status,
      startedAt: handle.startedAt,
      task: handle.task,
    };
  }

  cancel(sessionId: string): boolean {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    if (handle.status !== "running") return false;

    this.markTerminalState(handle, "cancelled", {
      sessionId,
      output: "Sub-agent was cancelled",
      success: false,
      durationMs: Date.now() - handle.startedAt,
      toolCalls: [],
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
    handle.abortController.abort();
    if (handle.timeoutTimer !== null) {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = null;
    }
    this.logger.info(`Sub-agent ${sessionId} cancelled`);
    return true;
  }

  listActive(): readonly string[] {
    this.pruneTerminalHandles();
    const active: string[] = [];
    for (const handle of this.handles.values()) {
      if (handle.status === "running") active.push(handle.sessionId);
    }
    return active;
  }

  listAll(): readonly SubAgentInfo[] {
    this.pruneTerminalHandles();
    const infos: SubAgentInfo[] = [];
    for (const handle of this.handles.values()) {
      infos.push({
        sessionId: handle.sessionId,
        parentSessionId: handle.parentSessionId,
        depth: handle.depth,
        status: handle.status,
        startedAt: handle.startedAt,
        task: handle.task,
      });
    }
    return infos;
  }

  findLatestSuccessfulSessionId(parentSessionId: string): string | undefined {
    this.pruneTerminalHandles();
    let latest:
      | {
        readonly sessionId: string;
        readonly finishedAt: number;
      }
      | undefined;

    for (const handle of this.handles.values()) {
      if (
        handle.parentSessionId !== parentSessionId ||
        handle.status !== "completed" ||
        !handle.result?.success
      ) {
        continue;
      }
      const finishedAt = handle.finishedAt ?? handle.startedAt;
      if (!latest || finishedAt > latest.finishedAt) {
        latest = {
          sessionId: handle.sessionId,
          finishedAt,
        };
      }
    }

    return latest?.sessionId;
  }

  async destroyAll(): Promise<void> {
    const executions = Array.from(this.handles.values()).map((h) => h.execution);

    // Cancel all running sub-agents
    for (const handle of this.handles.values()) {
      if (handle.status === "running") {
        this.markTerminalState(handle, "cancelled", {
          sessionId: handle.sessionId,
          output: "Sub-agent was cancelled",
          success: false,
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
        });
        handle.abortController.abort();
        if (handle.timeoutTimer !== null) {
          clearTimeout(handle.timeoutTimer);
          handle.timeoutTimer = null;
        }
      }
    }

    // Await all executions
    await Promise.allSettled(executions);

    this.handles.clear();
    this.logger.info("All sub-agents destroyed");
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private startExecutionTimeout(
    handle: SubAgentHandle,
    timeoutMs: number,
  ): void {
    if (handle.timeoutTimer !== null) {
      clearTimeout(handle.timeoutTimer);
    }
    handle.timeoutTimer = setTimeout(() => {
      if (handle.status === "running") {
        this.markTerminalState(handle, "timed_out", {
          sessionId: handle.sessionId,
          output: `Sub-agent timed out after ${timeoutMs}ms`,
          success: false,
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
        });
        handle.abortController.abort();
        this.logger.warn(
          `Sub-agent ${handle.sessionId} timed out after ${timeoutMs}ms`,
        );
      }
    }, timeoutMs);
  }

  private async executeSubAgent(handle: SubAgentHandle): Promise<void> {
    const workspaceId =
      handle.config.workspace ?? this.config.defaultWorkspaceId ?? "default";
    const sessionIdentity: SubAgentSessionIdentity = {
      workspaceId,
      parentSessionId: handle.parentSessionId,
      subagentSessionId: handle.sessionId,
    };

    let context: IsolatedSessionContext | undefined;
    try {
      // Check abort before context creation
      if (handle.abortController.signal.aborted) return;

      const startupTimeoutMs = Math.max(
        1_000,
        Math.floor(
          this.config.contextStartupTimeoutMs ??
            DEFAULT_SUB_AGENT_CONTEXT_STARTUP_TIMEOUT_MS,
        ),
      );
      const contextOrAbort = await raceAbortOrTimeout(
        this.config.createContext(sessionIdentity),
        handle.abortController.signal,
        startupTimeoutMs,
      );
      if (contextOrAbort === ABORT_SENTINEL) return;
      if (contextOrAbort === TIMEOUT_SENTINEL) {
        if (handle.status === "running") {
          this.markTerminalState(handle, "timed_out", {
            sessionId: handle.sessionId,
            output:
              `Sub-agent context startup timed out after ${startupTimeoutMs}ms`,
            success: false,
            durationMs: Date.now() - handle.startedAt,
            toolCalls: [],
            tokenUsage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            },
          });
          handle.abortController.abort();
          this.logger.warn(
            `Sub-agent ${handle.sessionId} context startup timed out after ${startupTimeoutMs}ms`,
          );
        }
        return;
      }
      context = contextOrAbort;

      // Check abort after context creation
      if (handle.abortController.signal.aborted) return;
      this.startExecutionTimeout(
        handle,
        handle.config.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS,
      );

      const toolHandler = this.composeToolHandler(sessionIdentity, context, handle);
      const selectedProvider =
        this.config.selectLLMProvider?.({
          sessionIdentity,
          contextProvider: context.llmProvider,
          task: handle.task,
          tools: handle.config.tools,
          requiredCapabilities: handle.config.requiredCapabilities,
        }) ?? context.llmProvider;
      let resolvedExecutionBudget: ResolvedSubAgentExecutionBudget | undefined;
      try {
        resolvedExecutionBudget =
          await this.config.resolveExecutionBudget?.({
            sessionIdentity,
            contextProvider: context.llmProvider,
            selectedProvider,
            task: handle.task,
            tools: handle.config.tools,
            requiredCapabilities: handle.config.requiredCapabilities,
          });
      } catch (error) {
        this.logger.warn(
          `Failed to resolve execution budget for sub-agent ${handle.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (handle.abortController.signal.aborted) return;

      const resolvedPromptBudget =
        resolvedExecutionBudget?.promptBudget ?? this.config.promptBudget;
      const resolvedSessionTokenBudget =
        resolvedExecutionBudget?.sessionTokenBudget ??
        this.config.sessionTokenBudget;
      const resolvedProviderProfile =
        resolvedExecutionBudget?.providerProfile;
      const defaultMaxToolRounds = this.config.resolveDefaultMaxToolRounds?.();
      const effectiveMaxToolRounds =
        typeof defaultMaxToolRounds === "number" &&
          Number.isFinite(defaultMaxToolRounds)
          ? resolveMaxToolRoundsForToolNames(
              Math.max(1, Math.floor(defaultMaxToolRounds)),
              handle.config.tools,
            )
          : undefined;
      const executor = new ChatExecutor({
        providers: [selectedProvider],
        toolHandler,
        allowedTools: handle.config.tools
          ? [...handle.config.tools]
          : undefined,
        promptBudget: resolvedPromptBudget,
        sessionTokenBudget: resolvedSessionTokenBudget,
        onCompaction: this.config.onCompaction,
        ...(typeof effectiveMaxToolRounds === "number"
          ? { maxToolRounds: effectiveMaxToolRounds }
          : {}),
      });

      const message = createGatewayMessage({
        channel: "sub-agent",
        senderId: handle.parentSessionId,
        senderName: "sub-agent",
        sessionId: handle.sessionId,
        content: handle.config.prompt ?? handle.task,
        scope: "dm",
      });

      const systemPrompt =
        this.config.systemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT;
      const subAgentTraceId = `subagent:${handle.sessionId}:${Date.now()}`;
      const unsafeBenchmarkMode = handle.config.unsafeBenchmarkMode === true;
      const traceEnabled =
        this.config.traceExecution === true ||
        this.config.traceProviderPayloads === true;
      const traceStaticFields = {
        parentSessionId: handle.parentSessionId,
        depth: handle.depth,
      };
      const providerTrace =
        traceEnabled
          ? {
            ...(this.config.traceProviderPayloads === true
              ? {
                includeProviderPayloads: true as const,
                onProviderTraceEvent: createProviderTraceEventLogger({
                  logger: this.logger,
                  traceLabel: "sub_agent.provider",
                  traceId: subAgentTraceId,
                  sessionId: handle.sessionId,
                  staticFields: traceStaticFields,
                }),
              }
              : {}),
            onExecutionTraceEvent: createExecutionTraceEventLogger({
              logger: this.logger,
              traceLabel: "sub_agent.executor",
              traceId: subAgentTraceId,
              sessionId: handle.sessionId,
              staticFields: traceStaticFields,
            }),
          }
          : undefined;

      if (traceEnabled) {
        logStructuredTraceEvent({
          logger: this.logger,
          traceLabel: "sub_agent.executor",
          traceId: subAgentTraceId,
          sessionId: handle.sessionId,
          eventType: "execution_profile_resolved",
          staticFields: traceStaticFields,
          payload: {
            provider: resolvedProviderProfile?.provider ?? selectedProvider.name,
            model: resolvedProviderProfile?.model,
            contextWindowTokens: resolvedProviderProfile?.contextWindowTokens,
            contextWindowSource: resolvedProviderProfile?.contextWindowSource,
            maxOutputTokens: resolvedProviderProfile?.maxOutputTokens,
            unsafeBenchmarkMode,
            sessionTokenBudget: resolvedSessionTokenBudget,
            promptBudget: resolvedPromptBudget
              ? {
                contextWindowTokens: resolvedPromptBudget.contextWindowTokens,
                maxOutputTokens: resolvedPromptBudget.maxOutputTokens,
                hardMaxPromptChars: resolvedPromptBudget.hardMaxPromptChars,
                safetyMarginTokens: resolvedPromptBudget.safetyMarginTokens,
                charPerToken: resolvedPromptBudget.charPerToken,
                maxRuntimeHints: resolvedPromptBudget.maxRuntimeHints,
              }
              : undefined,
          },
        });
      }

        const resultOrAbort = await raceAbort(
        executor.execute({
          message,
          history: handle.history,
          systemPrompt,
          sessionId: handle.sessionId,
          requiredToolEvidence: handle.config.requireToolCall
            ? {
              maxCorrectionAttempts: 1,
              delegationSpec: handle.config.delegationSpec,
            }
            : undefined,
          ...(providerTrace ? { trace: providerTrace } : {}),
        }),
        handle.abortController.signal,
      );

      // Guard: don't overwrite if cancelled/timed_out during execution
      if (resultOrAbort === ABORT_SENTINEL || handle.status !== "running")
        return;

      const successfulToolCalls = resultOrAbort.toolCalls.filter((toolCall) =>
        !didToolCallFail(toolCall.isError, toolCall.result)
      );
      const delegatedOutputValidation =
        handle.config.delegationSpec &&
          resultOrAbort.stopReason === "completed" &&
          !unsafeBenchmarkMode
        ? validateDelegatedOutputContract({
            spec: handle.config.delegationSpec,
            output: resultOrAbort.content,
            toolCalls: resultOrAbort.toolCalls,
            providerEvidence: resultOrAbort.providerEvidence,
            unsafeBenchmarkMode,
          })
          : undefined;
      const requireToolCallFailure = handle.config.requireToolCall === true &&
        resultOrAbort.stopReason === "completed" &&
        successfulToolCalls.length === 0 &&
        !delegatedOutputValidation?.error;
      const requireToolCallFailureDetail = requireToolCallFailure
        ? getMissingSuccessfulToolEvidenceMessage(
          resultOrAbort.toolCalls,
          handle.config.delegationSpec,
          resultOrAbort.providerEvidence,
        )
        : undefined;
      const enforcedStopReason = requireToolCallFailure ||
          delegatedOutputValidation?.error
        ? "validation_error"
        : resultOrAbort.stopReason;
      const enforcedStopReasonDetail = requireToolCallFailure
        ? requireToolCallFailureDetail
        : (delegatedOutputValidation?.error ?? resultOrAbort.stopReasonDetail);
      const validationCode = delegatedOutputValidation?.error
        ? delegatedOutputValidation.code
        : (requireToolCallFailure ? "missing_successful_tool_evidence" : undefined);
      const terminalStatus = mapChatStopReasonToSubAgentStatus(
        enforcedStopReason,
      );
      const success = enforcedStopReason === "completed";
      const output =
        success || !enforcedStopReasonDetail
          ? resultOrAbort.content
          : enforcedStopReasonDetail;

      if (success) {
        handle.history = [
          ...handle.history,
          { role: "user", content: handle.config.prompt ?? handle.task },
          { role: "assistant", content: output },
        ];
      }

      this.markTerminalState(handle, terminalStatus, {
        sessionId: handle.sessionId,
        output,
        success,
        durationMs: Date.now() - handle.startedAt,
        toolCalls: resultOrAbort.toolCalls,
        providerEvidence: resultOrAbort.providerEvidence,
        tokenUsage: resultOrAbort.tokenUsage,
        providerName: selectedProvider.name,
        stopReason: enforcedStopReason,
        stopReasonDetail: enforcedStopReasonDetail,
        validationCode,
      });

      if (success) {
        this.logger.info(`Sub-agent ${handle.sessionId} completed successfully`);
      } else {
        this.logger.warn(
          `Sub-agent ${handle.sessionId} stopped before completion (${enforcedStopReason})`,
          {
            stopReason: enforcedStopReason,
            stopReasonDetail: enforcedStopReasonDetail,
          },
        );
      }
    } catch (err) {
      // Guard: don't overwrite if cancelled/timed_out during execution
      if (handle.status !== "running") return;

      const failedOutput = err instanceof Error ? err.message : String(err);
      this.markTerminalState(handle, "failed", {
        sessionId: handle.sessionId,
        output: failedOutput,
        success: false,
        durationMs: Date.now() - handle.startedAt,
        toolCalls: [],
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        stopReason: "tool_error",
        stopReasonDetail: failedOutput,
      });

      this.logger.error(
        `Sub-agent ${handle.sessionId} failed: ${failedOutput}`,
      );
    } finally {
      // Clear timeout timer
      if (handle.timeoutTimer !== null) {
        clearTimeout(handle.timeoutTimer);
        handle.timeoutTimer = null;
      }

      // Best-effort context cleanup
      if (context) {
        try {
          await this.config.destroyContext(sessionIdentity);
        } catch (cleanupErr) {
          this.logger.warn(
            `Failed to destroy context for sub-agent ${handle.sessionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
    }
  }

  private markTerminalState(
    handle: SubAgentHandle,
    status: Exclude<SubAgentStatus, "running">,
    result: SubAgentResult,
  ): void {
    handle.status = status;
    handle.result = result;
    handle.finishedAt = Date.now();
    this.pruneTerminalHandles();
  }

  private pruneTerminalHandles(now = Date.now()): void {
    const terminal: SubAgentHandle[] = [];
    for (const handle of this.handles.values()) {
      if (handle.status === "running") continue;
      const finishedAt = handle.finishedAt ?? handle.startedAt;
      if (this.terminalHandleRetentionMs > 0) {
        const ageMs = now - finishedAt;
        if (ageMs > this.terminalHandleRetentionMs) {
          this.handles.delete(handle.sessionId);
          continue;
        }
      }
      terminal.push(handle);
    }

    const excess = terminal.length - this.maxRetainedTerminalHandles;
    if (excess <= 0) return;
    terminal.sort((a, b) => {
      const aFinishedAt = a.finishedAt ?? a.startedAt;
      const bFinishedAt = b.finishedAt ?? b.startedAt;
      return aFinishedAt - bFinishedAt;
    });
    for (const handle of terminal.slice(0, excess)) {
      this.handles.delete(handle.sessionId);
    }
  }

  private resolveSessionDepth(sessionId: string): number {
    const existing = this.handles.get(sessionId);
    if (existing) return existing.depth;
    return sessionId.startsWith(SUB_AGENT_SESSION_PREFIX) ? 1 : 0;
  }

  private resolveContinuationHandle(
    config: SubAgentConfig,
  ): SubAgentHandle | undefined {
    const continuationSessionId = config.continuationSessionId?.trim();
    if (!continuationSessionId) return undefined;

    const existing = this.handles.get(continuationSessionId);
    if (!existing) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" was not found`,
      );
    }
    if (existing.status === "running") {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" is still running`,
      );
    }
    if (existing.parentSessionId !== config.parentSessionId) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" belongs to a different parent session`,
      );
    }
    return existing;
  }

  private composeToolHandler(
    sessionIdentity: SubAgentSessionIdentity,
    context: IsolatedSessionContext,
    handle: SubAgentHandle,
  ): ToolHandler {
    const baseToolHandler = context.toolRegistry.createToolHandler();
    if (!this.config.composeToolHandler) {
      return baseToolHandler;
    }
    return this.config.composeToolHandler({
      sessionIdentity,
      context,
      baseToolHandler,
      task: handle.task,
      allowedToolNames: handle.config.tools
        ? [...handle.config.tools]
        : undefined,
      workingDirectory: handle.config.workingDirectory,
      desktopRoutingSessionId: this.resolveDesktopRoutingSessionId(
        handle.parentSessionId,
      ),
    });
  }

  private resolveDesktopRoutingSessionId(parentSessionId: string): string {
    const visited = new Set<string>();
    let current = parentSessionId;

    while (
      current.startsWith(SUB_AGENT_SESSION_PREFIX) &&
      !visited.has(current)
    ) {
      visited.add(current);
      const parentHandle = this.handles.get(current);
      if (!parentHandle) break;
      current = parentHandle.parentSessionId;
    }

    return current;
  }
}
