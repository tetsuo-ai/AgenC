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
import type { IsolatedSessionContext } from "./session-isolation.js";
import { createGatewayMessage } from "./message.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import type { ToolCallRecord } from "../llm/chat-executor.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { SubAgentSpawnError } from "./errors.js";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 3_600_000; // 60 min
export const MAX_CONCURRENT_SUB_AGENTS = 16;
export const SUB_AGENT_SESSION_PREFIX = "subagent:";

const DEFAULT_SUB_AGENT_SYSTEM_PROMPT =
  "You are a sub-agent. Complete the assigned task and report your results concisely.";

const ABORT_SENTINEL = Symbol("abort");

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
  readonly timeoutMs?: number;
  readonly workspace?: string;
  readonly tools?: readonly string[];
}

export interface SubAgentResult {
  readonly sessionId: string;
  readonly output: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface SubAgentManagerConfig {
  readonly createContext: (
    workspaceId: string,
  ) => Promise<IsolatedSessionContext>;
  readonly destroyContext: (workspaceId: string) => Promise<void>;
  readonly defaultWorkspaceId?: string;
  readonly maxConcurrent?: number;
  readonly systemPrompt?: string;
  readonly logger?: Logger;
}

export interface SubAgentInfo {
  readonly sessionId: string;
  readonly parentSessionId: string;
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
  readonly task: string;
  readonly config: SubAgentConfig;
  readonly startedAt: number;
  status: SubAgentStatus;
  result: SubAgentResult | null;
  readonly abortController: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  execution: Promise<void>;
}

// ============================================================================
// SubAgentManager
// ============================================================================

export class SubAgentManager {
  private readonly handles = new Map<string, SubAgentHandle>();
  private readonly config: SubAgentManagerConfig;
  private readonly maxConcurrent: number;
  private readonly logger: Logger;

  constructor(config: SubAgentManagerConfig) {
    this.config = config;
    this.maxConcurrent = config.maxConcurrent ?? MAX_CONCURRENT_SUB_AGENTS;
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

    const sessionId = `${SUB_AGENT_SESSION_PREFIX}${randomUUID()}`;
    const timeoutMs = config.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS;
    const abortController = new AbortController();

    const handle: SubAgentHandle = {
      sessionId,
      parentSessionId: config.parentSessionId,
      task: config.task,
      config,
      startedAt: Date.now(),
      status: "running",
      result: null,
      abortController,
      timeoutTimer: null,
      execution: Promise.resolve(),
    };

    // Set timeout timer
    handle.timeoutTimer = setTimeout(() => {
      if (handle.status === "running") {
        handle.status = "timed_out";
        handle.result = {
          sessionId,
          output: `Sub-agent timed out after ${timeoutMs}ms`,
          success: false,
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
        };
        abortController.abort();
        this.logger.warn(
          `Sub-agent ${sessionId} timed out after ${timeoutMs}ms`,
        );
      }
    }, timeoutMs);

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
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    if (handle.status === "running") return null;
    return handle.result;
  }

  cancel(sessionId: string): boolean {
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    if (handle.status !== "running") return false;

    handle.status = "cancelled";
    handle.result = {
      sessionId,
      output: "Sub-agent was cancelled",
      success: false,
      durationMs: Date.now() - handle.startedAt,
      toolCalls: [],
    };
    handle.abortController.abort();
    if (handle.timeoutTimer !== null) {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = null;
    }
    this.logger.info(`Sub-agent ${sessionId} cancelled`);
    return true;
  }

  listActive(): readonly string[] {
    const active: string[] = [];
    for (const handle of this.handles.values()) {
      if (handle.status === "running") active.push(handle.sessionId);
    }
    return active;
  }

  listAll(): readonly SubAgentInfo[] {
    const infos: SubAgentInfo[] = [];
    for (const handle of this.handles.values()) {
      infos.push({
        sessionId: handle.sessionId,
        parentSessionId: handle.parentSessionId,
        status: handle.status,
        startedAt: handle.startedAt,
        task: handle.task,
      });
    }
    return infos;
  }

  async destroyAll(): Promise<void> {
    // Cancel all running sub-agents
    for (const handle of this.handles.values()) {
      if (handle.status === "running") {
        handle.status = "cancelled";
        handle.result = {
          sessionId: handle.sessionId,
          output: "Sub-agent was cancelled",
          success: false,
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
        };
        handle.abortController.abort();
        if (handle.timeoutTimer !== null) {
          clearTimeout(handle.timeoutTimer);
          handle.timeoutTimer = null;
        }
      }
    }

    // Await all executions
    const executions = Array.from(this.handles.values()).map(
      (h) => h.execution,
    );
    await Promise.allSettled(executions);

    this.handles.clear();
    this.logger.info("All sub-agents destroyed");
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async executeSubAgent(handle: SubAgentHandle): Promise<void> {
    const workspaceId =
      handle.config.workspace ?? this.config.defaultWorkspaceId ?? "default";
    const contextKey = `${workspaceId}:${handle.sessionId}`;

    let context: IsolatedSessionContext | undefined;
    try {
      // Check abort before context creation
      if (handle.abortController.signal.aborted) return;

      const contextOrAbort = await raceAbort(
        this.config.createContext(contextKey),
        handle.abortController.signal,
      );
      if (contextOrAbort === ABORT_SENTINEL) return;
      context = contextOrAbort;

      // Check abort after context creation
      if (handle.abortController.signal.aborted) return;

      const executor = new ChatExecutor({
        providers: [context.llmProvider],
        toolHandler: context.toolRegistry.createToolHandler(),
        allowedTools: handle.config.tools
          ? [...handle.config.tools]
          : undefined,
      });

      const message = createGatewayMessage({
        channel: "sub-agent",
        senderId: handle.parentSessionId,
        senderName: "sub-agent",
        sessionId: handle.sessionId,
        content: handle.task,
        scope: "dm",
      });

      const systemPrompt =
        this.config.systemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT;

      const resultOrAbort = await raceAbort(
        executor.execute({
          message,
          history: [],
          systemPrompt,
          sessionId: handle.sessionId,
        }),
        handle.abortController.signal,
      );

      // Guard: don't overwrite if cancelled/timed_out during execution
      if (resultOrAbort === ABORT_SENTINEL || handle.status !== "running")
        return;

      handle.status = "completed";
      handle.result = {
        sessionId: handle.sessionId,
        output: resultOrAbort.content,
        success: true,
        durationMs: Date.now() - handle.startedAt,
        toolCalls: resultOrAbort.toolCalls,
      };

      this.logger.info(`Sub-agent ${handle.sessionId} completed successfully`);
    } catch (err) {
      // Guard: don't overwrite if cancelled/timed_out during execution
      if (handle.status !== "running") return;

      handle.status = "failed";
      handle.result = {
        sessionId: handle.sessionId,
        output: err instanceof Error ? err.message : String(err),
        success: false,
        durationMs: Date.now() - handle.startedAt,
        toolCalls: [],
      };

      this.logger.error(
        `Sub-agent ${handle.sessionId} failed: ${handle.result.output}`,
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
          await this.config.destroyContext(contextKey);
        } catch (cleanupErr) {
          this.logger.warn(
            `Failed to destroy context for sub-agent ${handle.sessionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
    }
  }
}
