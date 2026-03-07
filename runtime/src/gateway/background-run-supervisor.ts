/**
 * BackgroundRunSupervisor — daemon-owned long-running task supervision for user sessions.
 *
 * Converts explicit long-running user objectives into a bounded background loop:
 * actor step (ChatExecutor + tools) -> verifier step (structured decision) -> reschedule/update.
 *
 * This keeps control in the runtime instead of trusting one chat turn to own
 * the entire task lifecycle.
 *
 * @module
 */

import type { ChatExecutor, ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMMessage, LLMProvider, ToolHandler } from "../llm/types.js";
import type { GatewayMessage } from "./message.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import type { ProgressTracker } from "./progress.js";

const DEFAULT_POLL_INTERVAL_MS = 8_000;
const BUSY_RETRY_INTERVAL_MS = 1_500;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const FAST_FOLLOWUP_POLL_INTERVAL_MS = 4_000;
const STABLE_POLL_STEP_MS = 8_000;
const ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS = 8_000;
const ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS = 15_000;
const HEARTBEAT_MIN_DELAY_MS = 10_000;
const HEARTBEAT_MAX_DELAY_MS = 20_000;
const MAX_BACKGROUND_CYCLES = 64;
const MAX_BACKGROUND_RUNTIME_MS = 30 * 60_000;
const MAX_RUN_HISTORY_MESSAGES = 12;
const MAX_TOOL_RESULT_PREVIEW_CHARS = 240;
const MAX_USER_UPDATE_CHARS = 240;
const BACKGROUND_RUN_MAX_TOOL_ROUNDS = 1;
const BACKGROUND_RUN_MAX_TOOL_BUDGET = 4;
const BACKGROUND_RUN_MAX_MODEL_RECALLS = 0;

const UNTIL_STOP_RE =
  /\buntil\s+(?:i|you)\s+(?:say|tell)\s+(?:me\s+)?(?:to\s+)?stop\b/i;
const KEEP_UPDATING_RE =
  /\b(?:keep\s+me\s+updated|give\s+me\s+(?:regular|periodic)?\s*updates|report\s+back|send\s+updates)\b/i;
const BACKGROUND_RE =
  /\b(?:in\s+the\s+background|background\s+(?:run|task|job|monitor|execution))\b/i;
const CONTINUOUS_RE =
  /\b(?:keep\s+(?:running|playing|watching|monitoring|checking|tracking)|stay\s+running|monitor(?:ing)?|watch(?:ing)?\s+for|poll(?:ing)?|continu(?:ous|ously))\b/i;
const STOP_REQUEST_RE =
  /^\s*(?:stop|cancel|halt|pause|end(?:\s+it|\s+that|\s+the\s+run)?|stop\s+that|stop\s+it)\b/i;
const STATUS_REQUEST_RE =
  /^\s*(?:status|update|progress|how(?:'s|\s+is)\s+it\s+going|what(?:'s|\s+is)\s+the\s+status)\b/i;

const BACKGROUND_ACTOR_SECTION =
  "## Background Run Mode\n" +
  "This is an internal long-running task supervisor cycle for a user-owned objective.\n" +
  "Take one bounded step toward the objective. Use tools when needed.\n" +
  "For long-running shell work, launch it so the tool call returns immediately: background the long-running process, redirect stdout/stderr, and verify in a later cycle instead of waiting inside one command.\n" +
  "Do not spend a whole tool call sleeping or waiting for a delayed effect when the objective is ongoing.\n" +
  "If the objective involves a process that should keep running after setup, do not treat a successful launch as final completion.\n" +
  "Do not claim the task is fully complete unless the user objective is actually satisfied.\n" +
  "Return a concise factual update. Avoid sign-off language.\n";

const DECISION_SYSTEM_PROMPT =
  "You are a runtime supervisor deciding whether a background task should keep running. " +
  "Return JSON only with no markdown.";

export type BackgroundRunState =
  | "pending"
  | "running"
  | "working"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface BackgroundRunStatusSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: BackgroundRunState;
  readonly cycleCount: number;
  readonly lastVerifiedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastUserUpdate?: string;
}

interface BackgroundRunDecision {
  readonly state: Exclude<BackgroundRunState, "pending" | "running">;
  readonly userUpdate: string;
  readonly internalSummary: string;
  readonly nextCheckMs?: number;
  readonly shouldNotifyUser: boolean;
}

interface ActiveBackgroundRun {
  id: string;
  sessionId: string;
  objective: string;
  state: BackgroundRunState;
  createdAt: number;
  updatedAt: number;
  cycleCount: number;
  stableWorkingCycles: number;
  nextCheckAt?: number;
  nextHeartbeatAt?: number;
  lastVerifiedAt?: number;
  lastUserUpdate?: string;
  lastToolEvidence?: string;
  lastHeartbeatContent?: string;
  internalHistory: LLMMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export interface BackgroundRunSupervisorConfig {
  readonly chatExecutor: ChatExecutor;
  readonly supervisorLlm: LLMProvider;
  readonly getSystemPrompt: () => string;
  readonly createToolHandler: (params: {
    sessionId: string;
    runId: string;
    cycleIndex: number;
  }) => ToolHandler;
  readonly buildToolRoutingDecision?: (
    sessionId: string,
    messageText: string,
    history: readonly LLMMessage[],
  ) => ToolRoutingDecision | undefined;
  readonly seedHistoryForSession?: (sessionId: string) => readonly LLMMessage[];
  readonly isSessionBusy?: (sessionId: string) => boolean;
  readonly onStatus?: (
    sessionId: string,
    payload: { phase: string; detail?: string },
  ) => void;
  readonly publishUpdate: (sessionId: string, content: string) => Promise<void>;
  readonly progressTracker?: ProgressTracker;
  readonly logger?: Logger;
}

interface StartBackgroundRunParams {
  readonly sessionId: string;
  readonly objective: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function clampPollIntervalMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.floor(value)));
}

function toRunMessage(content: string, sessionId: string, runId: string, cycleIndex: number): GatewayMessage {
  return {
    id: `background-run:${runId}:${cycleIndex}:${Date.now()}`,
    channel: "webchat",
    senderId: `background-run:${runId}`,
    senderName: "Background Supervisor",
    sessionId,
    content,
    scope: "dm",
    attachments: [],
    timestamp: Date.now(),
  } as GatewayMessage;
}

function trimHistory(history: LLMMessage[]): LLMMessage[] {
  if (history.length <= MAX_RUN_HISTORY_MESSAGES) return history;
  return history.slice(history.length - MAX_RUN_HISTORY_MESSAGES);
}

function summarizeToolCalls(toolCalls: readonly ChatExecutorResult["toolCalls"][number][]): string {
  if (toolCalls.length === 0) return "No tool calls executed in this cycle.";
  return toolCalls
    .map((toolCall) => {
      const result = truncate(toolCall.result, MAX_TOOL_RESULT_PREVIEW_CHARS);
      const state = toolCall.isError ? "error" : "ok";
      return `- ${toolCall.name} [${state}] ${result}`;
    })
    .join("\n");
}

function buildActorPrompt(run: ActiveBackgroundRun): string {
  const recentHistory = run.lastUserUpdate
    ? `Latest published status: ${run.lastUserUpdate}\n`
    : "";
  const recentToolEvidence = run.lastToolEvidence
    ? `Latest tool evidence:\n${run.lastToolEvidence}\n`
    : "";
  const firstCycleGuidance = run.cycleCount === 1
    ? "This is the first cycle. Establish the baseline and start any required long-running process before relying on status checks alone.\n"
    : "";
  return (
    `Background objective:\n${run.objective}\n\n` +
    `Cycle: ${run.cycleCount}\n` +
    recentHistory +
    recentToolEvidence +
    firstCycleGuidance +
    "Take the next best bounded step toward this objective. " +
    "Use tools when necessary. If the task is already running independently, verify its current state instead of narrating.\n"
  );
}

function buildHeartbeatMessage(run: ActiveBackgroundRun): string {
  const nextCheckMs =
    run.nextCheckAt !== undefined
      ? Math.max(0, run.nextCheckAt - Date.now())
      : undefined;
  const lastVerifiedAgeMs =
    run.lastVerifiedAt !== undefined
      ? Math.max(0, Date.now() - run.lastVerifiedAt)
      : undefined;
  const lastVerifiedText = run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "Task is still active.";

  return truncate(
    "Still working in the background. " +
      `Last verified update: ${lastVerifiedText}` +
      (lastVerifiedAgeMs !== undefined
        ? ` (${Math.max(1, Math.round(lastVerifiedAgeMs / 1000))}s ago). `
        : " ") +
      (nextCheckMs !== undefined
        ? `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s.`
        : "Next verification is pending."),
    MAX_USER_UPDATE_CHARS,
  );
}

function buildActiveCycleHeartbeatMessage(run: ActiveBackgroundRun): string {
  const lastVerifiedText = run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "No verified update has been published yet.";
  const cycleAgeMs = Math.max(0, Date.now() - run.updatedAt);

  return truncate(
    "Still working on the current background cycle. " +
      `Last verified update: ${lastVerifiedText} ` +
      `(cycle active for ~${Math.max(1, Math.ceil(cycleAgeMs / 1000))}s).`,
    MAX_USER_UPDATE_CHARS,
  );
}

function buildDecisionPrompt(params: {
  objective: string;
  actorResult: ChatExecutorResult;
  previousUpdate?: string;
}): string {
  const { objective, actorResult, previousUpdate } = params;
  return (
    `Objective:\n${objective}\n\n` +
    (previousUpdate ? `Previous published update:\n${previousUpdate}\n\n` : "") +
    `Actor stop reason: ${actorResult.stopReason}\n` +
    `Actor stop detail: ${actorResult.stopReasonDetail ?? "none"}\n\n` +
    `Actor response:\n${actorResult.content || "(empty)"}\n\n` +
    `Tool evidence:\n${summarizeToolCalls(actorResult.toolCalls)}\n\n` +
    "Return JSON only in this shape:\n" +
    '{"state":"working|completed|blocked|failed","userUpdate":"...","internalSummary":"...","nextCheckMs":8000,"shouldNotifyUser":true}\n\n' +
    "Rules:\n" +
    "- Use `working` when the task should keep running or keep being supervised.\n" +
    "- Use `completed` only when the user's objective is fully satisfied.\n" +
    "- Use `blocked` when more user input, approval, or impossible preconditions are needed.\n" +
    "- Use `failed` for unrecoverable failure.\n" +
    "- If a process or monitor was started and verified but should continue in the background, prefer `working`.\n" +
    "- If the actor hit a bounded cycle budget after successful tool calls, prefer `working` over `failed`.\n" +
    `- Keep userUpdate under ${MAX_USER_UPDATE_CHARS} chars.\n`
  );
}

function shouldTreatStopReasonAsBoundedStep(
  actorResult: ChatExecutorResult,
): boolean {
  if (!actorResult.toolCalls.some((toolCall) => !toolCall.isError)) return false;
  return (
    actorResult.stopReason === "budget_exceeded" ||
    actorResult.stopReason === "tool_calls"
  );
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function parseDecision(text: string): BackgroundRunDecision | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = typeof parsed.state === "string" ? parsed.state : "";
    if (
      state !== "working" &&
      state !== "completed" &&
      state !== "blocked" &&
      state !== "failed"
    ) {
      return undefined;
    }
    const userUpdate = truncate(
      typeof parsed.userUpdate === "string" ? parsed.userUpdate : "Background run updated.",
      MAX_USER_UPDATE_CHARS,
    );
    const internalSummary =
      typeof parsed.internalSummary === "string"
        ? parsed.internalSummary
        : userUpdate;
    return {
      state,
      userUpdate,
      internalSummary,
      nextCheckMs: clampPollIntervalMs(
        typeof parsed.nextCheckMs === "number" ? parsed.nextCheckMs : undefined,
      ),
      shouldNotifyUser:
        typeof parsed.shouldNotifyUser === "boolean"
          ? parsed.shouldNotifyUser
          : true,
    };
  } catch {
    return undefined;
  }
}

function buildFallbackDecision(run: ActiveBackgroundRun, actorResult: ChatExecutorResult): BackgroundRunDecision {
  if (shouldTreatStopReasonAsBoundedStep(actorResult)) {
    const detail =
      actorResult.stopReasonDetail ??
      actorResult.content ??
      "Completed a bounded background step and will verify again shortly.";
    return {
      state: "working",
      userUpdate: truncate(
        actorResult.content || "Completed a bounded background step and will verify again shortly.",
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary: detail,
      nextCheckMs: DEFAULT_POLL_INTERVAL_MS,
      shouldNotifyUser: true,
    };
  }
  if (actorResult.stopReason !== "completed") {
    const detail = actorResult.stopReasonDetail ?? actorResult.content ?? "Background run did not complete cleanly.";
    return {
      state: "failed",
      userUpdate: truncate(detail, MAX_USER_UPDATE_CHARS),
      internalSummary: detail,
      shouldNotifyUser: true,
    };
  }
  if (actorResult.toolCalls.length > 0) {
    return {
      state: "working",
      userUpdate: truncate(
        actorResult.content || `Background run cycle ${run.cycleCount} completed.`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary: actorResult.content || "Cycle completed with tool calls.",
      nextCheckMs: DEFAULT_POLL_INTERVAL_MS,
      shouldNotifyUser: true,
    };
  }
  return {
    state: "blocked",
    userUpdate: truncate(
      actorResult.content || "Background run made no actionable progress.",
      MAX_USER_UPDATE_CHARS,
    ),
    internalSummary: actorResult.content || "No tool calls or actionable output.",
    shouldNotifyUser: true,
  };
}

function groundDecision(
  actorResult: ChatExecutorResult,
  decision: BackgroundRunDecision,
): BackgroundRunDecision {
  const successfulToolCalls = actorResult.toolCalls.filter((toolCall) => !toolCall.isError);
  const failedToolCalls = actorResult.toolCalls.filter((toolCall) => toolCall.isError);

  if (
    (decision.state === "working" || decision.state === "completed") &&
    successfulToolCalls.length === 0 &&
    failedToolCalls.length > 0
  ) {
    const failurePreview = truncate(
      failedToolCalls[0]?.result || "All tool calls in the latest cycle failed.",
      120,
    );
    return {
      state: "working",
      userUpdate: truncate(
        `Latest cycle hit only tool errors and will retry: ${failurePreview}`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary: `Grounded optimistic decision after all tool calls failed: ${failurePreview}`,
      nextCheckMs: MIN_POLL_INTERVAL_MS,
      shouldNotifyUser: true,
    };
  }

  return decision;
}

function chooseNextCheckMs(params: {
  run: ActiveBackgroundRun;
  actorResult: ChatExecutorResult;
  decision: BackgroundRunDecision;
  previousToolEvidence?: string;
}): { nextCheckMs: number; stableWorkingCycles: number; heartbeatMs?: number } {
  const { run, actorResult, decision, previousToolEvidence } = params;
  const successfulToolCalls = actorResult.toolCalls.filter((toolCall) => !toolCall.isError);
  const failedToolCalls = actorResult.toolCalls.filter((toolCall) => toolCall.isError);
  const currentEvidence = summarizeToolCalls(actorResult.toolCalls);
  const evidenceChanged = currentEvidence !== previousToolEvidence;
  const nextUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
  const updateChanged = nextUserUpdate !== run.lastUserUpdate;

  if (failedToolCalls.length > 0) {
    return {
      nextCheckMs: MIN_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (run.cycleCount === 1 && successfulToolCalls.length > 0) {
    return {
      nextCheckMs: FAST_FOLLOWUP_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (successfulToolCalls.length > 0 && (evidenceChanged || updateChanged)) {
    return {
      nextCheckMs: Math.min(
        clampPollIntervalMs(decision.nextCheckMs),
        DEFAULT_POLL_INTERVAL_MS,
      ),
      stableWorkingCycles: 0,
    };
  }

  const stableWorkingCycles = evidenceChanged || updateChanged
    ? 0
    : run.stableWorkingCycles + 1;
  const nextCheckMs = clampPollIntervalMs(
    DEFAULT_POLL_INTERVAL_MS + (stableWorkingCycles * STABLE_POLL_STEP_MS),
  );

  return {
    nextCheckMs,
    stableWorkingCycles,
    heartbeatMs:
      nextCheckMs >= HEARTBEAT_MIN_DELAY_MS
        ? Math.min(
          HEARTBEAT_MAX_DELAY_MS,
          Math.max(HEARTBEAT_MIN_DELAY_MS, Math.floor(nextCheckMs / 2)),
        )
        : undefined,
  };
}

export function inferBackgroundRunIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return (
    UNTIL_STOP_RE.test(text) ||
    KEEP_UPDATING_RE.test(text) ||
    BACKGROUND_RE.test(text) ||
    CONTINUOUS_RE.test(text)
  );
}

export function isBackgroundRunStopRequest(message: string): boolean {
  return STOP_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunStatusRequest(message: string): boolean {
  return STATUS_REQUEST_RE.test(message.trim());
}

export class BackgroundRunSupervisor {
  private readonly chatExecutor: ChatExecutor;
  private readonly supervisorLlm: LLMProvider;
  private readonly getSystemPrompt: () => string;
  private readonly createToolHandler: BackgroundRunSupervisorConfig["createToolHandler"];
  private readonly buildToolRoutingDecision?: BackgroundRunSupervisorConfig["buildToolRoutingDecision"];
  private readonly seedHistoryForSession?: BackgroundRunSupervisorConfig["seedHistoryForSession"];
  private readonly isSessionBusy?: BackgroundRunSupervisorConfig["isSessionBusy"];
  private readonly onStatus?: BackgroundRunSupervisorConfig["onStatus"];
  private readonly publishUpdate: BackgroundRunSupervisorConfig["publishUpdate"];
  private readonly progressTracker?: ProgressTracker;
  private readonly logger: Logger;
  private readonly activeRuns = new Map<string, ActiveBackgroundRun>();

  constructor(config: BackgroundRunSupervisorConfig) {
    this.chatExecutor = config.chatExecutor;
    this.supervisorLlm = config.supervisorLlm;
    this.getSystemPrompt = config.getSystemPrompt;
    this.createToolHandler = config.createToolHandler;
    this.buildToolRoutingDecision = config.buildToolRoutingDecision;
    this.seedHistoryForSession = config.seedHistoryForSession;
    this.isSessionBusy = config.isSessionBusy;
    this.onStatus = config.onStatus;
    this.publishUpdate = config.publishUpdate;
    this.progressTracker = config.progressTracker;
    this.logger = config.logger ?? silentLogger;
  }

  hasActiveRun(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  getStatusSnapshot(sessionId: string): BackgroundRunStatusSnapshot | undefined {
    const run = this.activeRuns.get(sessionId);
    if (!run) return undefined;
    return {
      id: run.id,
      sessionId: run.sessionId,
      objective: run.objective,
      state: run.state,
      cycleCount: run.cycleCount,
      lastVerifiedAt: run.lastVerifiedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nextCheckAt: run.nextCheckAt,
      nextHeartbeatAt: run.nextHeartbeatAt,
      lastUserUpdate: run.lastUserUpdate,
    };
  }

  async startRun(params: StartBackgroundRunParams): Promise<BackgroundRunStatusSnapshot> {
    await this.cancelRun(params.sessionId, "Replaced by a new background run.");

    const now = Date.now();
    const run: ActiveBackgroundRun = {
      id: `bg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: params.sessionId,
      objective: params.objective.trim(),
      state: "pending",
      createdAt: now,
      updatedAt: now,
      cycleCount: 0,
      stableWorkingCycles: 0,
      lastVerifiedAt: undefined,
      lastUserUpdate: undefined,
      lastToolEvidence: undefined,
      lastHeartbeatContent: undefined,
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      internalHistory: [
        ...(this.seedHistoryForSession?.(params.sessionId)?.slice(-6) ?? []),
      ],
      timer: null,
      heartbeatTimer: null,
      abortController: null,
    };

    this.activeRuns.set(params.sessionId, run);
    await this.progressTracker?.append({
      sessionId: params.sessionId,
      type: "task_started",
      summary: truncate(`Background run started: ${run.objective}`, 200),
    });

    await this.publishUpdate(
      params.sessionId,
      "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
    );
    this.schedule(run, 0);
    return this.getStatusSnapshot(params.sessionId)!;
  }

  async cancelRun(sessionId: string, reason = "Stopped by user."): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return false;

    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    run.state = "cancelled";
    run.updatedAt = Date.now();
    this.activeRuns.delete(sessionId);

    await this.progressTracker?.append({
      sessionId,
      type: "task_completed",
      summary: truncate(`Background run cancelled: ${reason}`, 200),
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    return true;
  }

  async shutdown(): Promise<void> {
    const sessionIds = [...this.activeRuns.keys()];
    for (const sessionId of sessionIds) {
      await this.cancelRun(sessionId, "Background run stopped because the daemon is shutting down.");
    }
  }

  private schedule(run: ActiveBackgroundRun, delayMs: number): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    if (run.timer) clearTimeout(run.timer);
    run.nextCheckAt = Date.now() + delayMs;
    run.timer = setTimeout(() => {
      void this.executeCycle(run.sessionId);
    }, Math.max(0, delayMs));
  }

  private clearRunTimers(run: ActiveBackgroundRun): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
  }

  private scheduleHeartbeat(run: ActiveBackgroundRun, delayMs: number | undefined): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextHeartbeatAt = undefined;
    if (delayMs === undefined || delayMs <= 0) return;
    run.nextHeartbeatAt = Date.now() + delayMs;
    run.heartbeatTimer = setTimeout(() => {
      void this.emitHeartbeat(run.sessionId);
    }, delayMs);
  }

  private async emitHeartbeat(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;

    if (this.isSessionBusy?.(sessionId)) {
      this.scheduleHeartbeat(run, BUSY_RETRY_INTERVAL_MS);
      return;
    }

    if (run.state === "running") {
      const content = buildActiveCycleHeartbeatMessage(run);
      run.lastHeartbeatContent = content;
      run.nextHeartbeatAt = undefined;
      this.onStatus?.(sessionId, {
        phase: "background_run",
        detail: `Background run cycle ${run.cycleCount} is still in progress`,
      });
      await this.publishUpdate(sessionId, content);
      this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS);
      return;
    }

    if (run.state !== "working") return;

    const content = buildHeartbeatMessage(run);
    if (run.lastHeartbeatContent === content) return;

    run.lastHeartbeatContent = content;
    run.nextHeartbeatAt = undefined;
    this.onStatus?.(sessionId, {
      phase: "background_wait",
      detail:
        run.nextCheckAt !== undefined
          ? `Next verification in ~${Math.max(1, Math.ceil((run.nextCheckAt - Date.now()) / 1000))}s`
          : "Background run waiting for next verification",
    });
    await this.publishUpdate(sessionId, content);
  }

  private async executeCycle(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (this.isSessionBusy?.(sessionId)) {
      this.schedule(run, BUSY_RETRY_INTERVAL_MS);
      return;
    }
    if (Date.now() - run.createdAt > MAX_BACKGROUND_RUNTIME_MS) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run timed out before the objective was completed.",
        internalSummary: "Exceeded maximum background runtime budget.",
        shouldNotifyUser: true,
      });
      return;
    }
    if (run.cycleCount >= MAX_BACKGROUND_CYCLES) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run hit its cycle budget before completing.",
        internalSummary: "Exceeded maximum background cycle budget.",
        shouldNotifyUser: true,
      });
      return;
    }

    run.state = "running";
    run.updatedAt = Date.now();
    run.cycleCount += 1;
    run.nextHeartbeatAt = undefined;
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.abortController = new AbortController();
    this.onStatus?.(sessionId, {
      phase: "background_run",
      detail: `Background run cycle ${run.cycleCount}`,
    });
    this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS);

    const actorPrompt = buildActorPrompt(run);
    const actorSystemPrompt = `${this.getSystemPrompt()}\n\n${BACKGROUND_ACTOR_SECTION}`;
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    try {
      const previousToolEvidence = run.lastToolEvidence;
      const toolRoutingDecision = this.buildToolRoutingDecision?.(
        sessionId,
        actorPrompt,
        run.internalHistory,
      );
      actorResult = await this.chatExecutor.execute({
        message: toRunMessage(actorPrompt, sessionId, run.id, run.cycleCount),
        history: run.internalHistory,
        systemPrompt: actorSystemPrompt,
        sessionId,
        toolHandler: this.createToolHandler({
          sessionId,
          runId: run.id,
          cycleIndex: run.cycleCount,
        }),
        signal: run.abortController.signal,
        maxToolRounds: BACKGROUND_RUN_MAX_TOOL_ROUNDS,
        toolBudgetPerRequest: BACKGROUND_RUN_MAX_TOOL_BUDGET,
        maxModelRecallsPerRequest: BACKGROUND_RUN_MAX_MODEL_RECALLS,
        toolRouting: toolRoutingDecision
          ? {
            routedToolNames: toolRoutingDecision.routedToolNames,
            expandedToolNames: toolRoutingDecision.expandedToolNames,
            expandOnMiss: true,
          }
          : undefined,
      });

      run.internalHistory = trimHistory([
        ...run.internalHistory,
        { role: "user", content: actorPrompt },
        { role: "assistant", content: actorResult.content },
      ]);
      run.lastVerifiedAt = Date.now();
      run.lastToolEvidence = summarizeToolCalls(actorResult.toolCalls);

      decision =
        (await this.evaluateDecision(run, actorResult)) ??
        buildFallbackDecision(run, actorResult);
      decision = groundDecision(actorResult, decision);
      if (decision.state === "working") {
        const cadence = chooseNextCheckMs({
          run,
          actorResult,
          decision,
          previousToolEvidence,
        });
        run.stableWorkingCycles = cadence.stableWorkingCycles;
        decision = {
          ...decision,
          nextCheckMs: cadence.nextCheckMs,
        };
        heartbeatMs = cadence.heartbeatMs;
      } else {
        run.stableWorkingCycles = 0;
      }
    } catch (error) {
      if (run.abortController?.signal.aborted) {
        return;
      }
      decision = {
        state: "failed",
        userUpdate: truncate(
          `Background run failed: ${toErrorMessage(error)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: toErrorMessage(error),
        shouldNotifyUser: true,
      };
    } finally {
      run.abortController = null;
    }

    if (decision.state === "working") {
      run.state = "working";
      run.updatedAt = Date.now();
      await this.progressTracker?.append({
        sessionId,
        type: "decision",
        summary: truncate(
          `Background run working: ${decision.internalSummary}`,
          200,
        ),
      });
      if (decision.shouldNotifyUser) {
        await this.publishUpdateIfChanged(run, decision.userUpdate);
      }
      this.scheduleHeartbeat(run, heartbeatMs);
      this.onStatus?.(sessionId, {
        phase: "background_wait",
        detail: `Next verification in ~${Math.max(1, Math.ceil((decision.nextCheckMs ?? DEFAULT_POLL_INTERVAL_MS) / 1000))}s`,
      });
      this.schedule(run, clampPollIntervalMs(decision.nextCheckMs));
      return;
    }

    await this.finishRun(run, decision);
  }

  private async evaluateDecision(
    run: ActiveBackgroundRun,
    actorResult: ChatExecutorResult,
  ): Promise<BackgroundRunDecision | undefined> {
    try {
      const response = await this.supervisorLlm.chat([
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDecisionPrompt({
            objective: run.objective,
            actorResult,
            previousUpdate: run.lastUserUpdate,
          }),
        },
      ], {
        toolChoice: "none",
      });
      return parseDecision(response.content);
    } catch (error) {
      this.logger.debug("Background run decision evaluation failed", {
        sessionId: run.sessionId,
        runId: run.id,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  private async publishUpdateIfChanged(
    run: ActiveBackgroundRun,
    content: string,
  ): Promise<void> {
    const next = truncate(content, MAX_USER_UPDATE_CHARS);
    if (run.lastUserUpdate === next) return;
    run.lastUserUpdate = next;
    run.lastHeartbeatContent = undefined;
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
      run.nextHeartbeatAt = undefined;
    }
    await this.publishUpdate(run.sessionId, next);
  }

  private async finishRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    run.state = decision.state;
    run.updatedAt = Date.now();
    this.activeRuns.delete(run.sessionId);

    const progressType = decision.state === "completed"
      ? "task_completed"
      : "error";
    await this.progressTracker?.append({
      sessionId: run.sessionId,
      type: progressType,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
    });

    if (decision.shouldNotifyUser) {
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }
}
