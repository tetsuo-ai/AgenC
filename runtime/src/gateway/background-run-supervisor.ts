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
import {
  BackgroundRunStore,
  type BackgroundRunCarryForwardState,
  type BackgroundRunContract,
  type BackgroundRunManagedProcessLaunchSpec,
  type BackgroundRunManagedProcessPolicy,
  type BackgroundRunObservedTarget,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunState,
  type BackgroundRunWakeReason,
  type PersistedBackgroundRun,
} from "./background-run-store.js";
import {
  didToolCallFail,
  extractToolFailureText,
  parseToolResultObject,
} from "../llm/chat-executor-tool-utils.js";

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
const MAX_BACKGROUND_CYCLES = 512;
const MAX_BACKGROUND_RUNTIME_MS = 7 * 24 * 60 * 60_000;
const MAX_RUN_HISTORY_MESSAGES = 12;
const HISTORY_COMPACTION_THRESHOLD = 10;
const MIN_CARRY_FORWARD_REFRESH_MS = 60_000;
const MAX_TOOL_RESULT_PREVIEW_CHARS = 240;
const MAX_USER_UPDATE_CHARS = 240;
const BACKGROUND_RUN_MAX_TOOL_ROUNDS = 1;
const BACKGROUND_RUN_MAX_TOOL_BUDGET = 4;
const BACKGROUND_RUN_MAX_MODEL_RECALLS = 0;
const MAX_CONSECUTIVE_ERROR_CYCLES = 3;
const DEFAULT_MANAGED_PROCESS_MAX_RESTARTS = 5;
const DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS = 5_000;

const UNTIL_STOP_RE =
  /\buntil\s+(?:i|you)\s+(?:say|tell)\s+(?:me\s+)?(?:to\s+)?stop\b/i;
const KEEP_UPDATING_RE =
  /\b(?:keep\s+me\s+updated|give\s+me\s+(?:regular|periodic)?\s*updates|report\s+back|send\s+updates)\b/i;
const BACKGROUND_RE =
  /\b(?:in\s+the\s+background|background\s+(?:run|task|job|monitor|execution))\b/i;
const CONTINUOUS_RE =
  /\b(?:keep\s+(?:running|playing|watching|monitoring|checking|tracking)|stay\s+running|monitor(?:ing)?|watch(?:ing)?\s+for|poll(?:ing)?|continu(?:ous|ously))\b/i;
const STOP_REQUEST_RE =
  /^\s*(?:stop|cancel|halt|end(?:\s+it|\s+that|\s+the\s+run)?|stop\s+that|stop\s+it)\b/i;
const PAUSE_REQUEST_RE =
  /^\s*(?:pause|hold|wait|pause\s+that|pause\s+it)\b/i;
const RESUME_REQUEST_RE =
  /^\s*(?:resume|continue|continue\s+it|continue\s+that|unpause|restart\s+the\s+run)\b/i;
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

const CONTRACT_SYSTEM_PROMPT =
  "You are a runtime planner for durable long-running task supervision. " +
  "Return JSON only with no markdown.";

const CARRY_FORWARD_SYSTEM_PROMPT =
  "You maintain durable runtime state for a long-running task. " +
  "Compress only the task-relevant context into concise JSON for the next cycle. " +
  "Return JSON only with no markdown.";

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
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly pendingSignals: number;
  readonly carryForwardSummary?: string;
}

interface BackgroundRunDecision {
  readonly state: Exclude<BackgroundRunState, "pending" | "running">;
  readonly userUpdate: string;
  readonly internalSummary: string;
  readonly nextCheckMs?: number;
  readonly shouldNotifyUser: boolean;
}

interface ActiveBackgroundRun {
  version: 1;
  id: string;
  sessionId: string;
  objective: string;
  contract: BackgroundRunContract;
  state: BackgroundRunState;
  createdAt: number;
  updatedAt: number;
  cycleCount: number;
  stableWorkingCycles: number;
  consecutiveErrorCycles: number;
  nextCheckAt?: number;
  nextHeartbeatAt?: number;
  lastVerifiedAt?: number;
  lastUserUpdate?: string;
  lastToolEvidence?: string;
  lastHeartbeatContent?: string;
  lastWakeReason?: BackgroundRunWakeReason;
  carryForward?: BackgroundRunCarryForwardState;
  pendingSignals: BackgroundRunSignal[];
  observedTargets: BackgroundRunObservedTarget[];
  internalHistory: LLMMessage[];
  leaseOwnerId?: string;
  leaseExpiresAt?: number;
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
  readonly runStore: BackgroundRunStore;
  readonly logger?: Logger;
  readonly instanceId?: string;
  readonly now?: () => number;
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

function truncateList(
  values: readonly string[],
  maxItems: number,
  maxChars = 100,
): string[] {
  return values.slice(0, maxItems).map((value) => truncate(value, maxChars));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeManagedProcessPolicyMode(
  value: unknown,
): "none" | "until_exit" | "keep_running" | "restart_on_exit" {
  if (
    value === "none" ||
    value === "until_exit" ||
    value === "keep_running" ||
    value === "restart_on_exit"
  ) {
    return value;
  }
  return "none";
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function getManagedProcessPolicy(
  run: ActiveBackgroundRun,
): BackgroundRunManagedProcessPolicy {
  const mode = normalizeManagedProcessPolicyMode(
    run.contract.managedProcessPolicy?.mode ??
      inferManagedProcessPolicyMode(run.objective),
  );
  return {
    mode,
    maxRestarts:
      mode === "restart_on_exit"
        ? normalizePositiveInteger(run.contract.managedProcessPolicy?.maxRestarts) ??
          DEFAULT_MANAGED_PROCESS_MAX_RESTARTS
        : undefined,
    restartBackoffMs:
      mode === "restart_on_exit"
        ? normalizePositiveInteger(
            run.contract.managedProcessPolicy?.restartBackoffMs,
          ) ?? DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS
        : undefined,
  };
}

function inferManagedProcessPolicyMode(objective: string): "none" | "until_exit" | "keep_running" | "restart_on_exit" {
  const text = objective.toLowerCase();
  if (/\b(restart|recover|relaunch|respawn)\b/.test(text)) {
    return "restart_on_exit";
  }
  if (/\buntil\b.*\b(exit|exits|exited|stop|stops|stopped|finish|finished|terminate|terminated)\b/.test(text)) {
    return "until_exit";
  }
  if (
    /\bkeep\b.*\b(running|alive|up)\b/.test(text) ||
    /\b(stay up|ensure .* running|monitor .* running)\b/.test(text)
  ) {
    return "keep_running";
  }
  return "none";
}

function getManagedProcessPolicyMode(run: ActiveBackgroundRun): "none" | "until_exit" | "keep_running" | "restart_on_exit" {
  return getManagedProcessPolicy(run).mode;
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

function formatCarryForwardState(
  carryForward: BackgroundRunCarryForwardState | undefined,
): string | undefined {
  if (!carryForward) return undefined;
  const parts = [`Summary: ${truncate(carryForward.summary, 240)}`];
  if (carryForward.verifiedFacts.length > 0) {
    parts.push(
      `Verified facts: ${truncateList(carryForward.verifiedFacts, 4).join(" | ")}`,
    );
  }
  if (carryForward.openLoops.length > 0) {
    parts.push(
      `Open loops: ${truncateList(carryForward.openLoops, 4).join(" | ")}`,
    );
  }
  if (carryForward.nextFocus) {
    parts.push(`Next focus: ${truncate(carryForward.nextFocus, 120)}`);
  }
  return parts.join("\n");
}

function formatSignals(signals: readonly BackgroundRunSignal[]): string | undefined {
  if (signals.length === 0) return undefined;
  return signals
    .map((signal) =>
      `- [${signal.type}] ${truncate(signal.content, 180)}`,
    )
    .join("\n");
}

function formatObservedTargets(
  observedTargets: readonly BackgroundRunObservedTarget[],
): string | undefined {
  if (observedTargets.length === 0) return undefined;
  return observedTargets
    .map((target) => {
      if (target.kind !== "managed_process") {
        return `- [unknown] ${truncate(JSON.stringify(target), 160)}`;
      }
      const label = target.label ? `"${target.label}" ` : "";
      return (
        `- [managed_process] ${label}(${target.processId}) ` +
        `current=${target.currentState} desired=${target.desiredState} policy=${target.exitPolicy}`
      );
    })
    .join("\n");
}

function cloneSignals(
  signals: readonly BackgroundRunSignal[],
): BackgroundRunSignal[] {
  return signals.map((signal) => ({
    ...signal,
    data: signal.data ? { ...signal.data } : undefined,
  }));
}

function removeConsumedSignals(
  signals: readonly BackgroundRunSignal[],
  consumedSignals: readonly BackgroundRunSignal[],
): BackgroundRunSignal[] {
  if (signals.length === 0 || consumedSignals.length === 0) return [...signals];
  const consumedIds = new Set(consumedSignals.map((signal) => signal.id));
  return signals.filter((signal) => !consumedIds.has(signal.id));
}

function buildActorPrompt(run: ActiveBackgroundRun): string {
  const recentHistory = run.lastUserUpdate
    ? `Latest published status: ${run.lastUserUpdate}\n`
    : "";
  const recentToolEvidence = run.lastToolEvidence
    ? `Latest tool evidence:\n${run.lastToolEvidence}\n`
    : "";
  const carryForward = formatCarryForwardState(run.carryForward);
  const carryForwardSection = carryForward
    ? `Carry-forward state:\n${carryForward}\n`
    : "";
  const pendingSignals = formatSignals(run.pendingSignals);
  const signalSection = pendingSignals
    ? `Pending external signals:\n${pendingSignals}\n`
    : "";
  const observedTargets = formatObservedTargets(run.observedTargets);
  const observedTargetSection = observedTargets
    ? `Runtime observed targets:\n${observedTargets}\n`
    : "";
  const contractSummary =
    `Run contract:\n${JSON.stringify(run.contract, null, 2)}\n`;
  const firstCycleGuidance = run.cycleCount === 1
    ? "This is the first cycle. Establish the baseline and start any required long-running process before relying on status checks alone.\n"
    : "";
  return (
    `Background objective:\n${run.objective}\n\n` +
    `Cycle: ${run.cycleCount}\n` +
    contractSummary +
    carryForwardSection +
    signalSection +
    observedTargetSection +
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
  contract: BackgroundRunContract;
  objective: string;
  actorResult: ChatExecutorResult;
  previousUpdate?: string;
}): string {
  const { contract, objective, actorResult, previousUpdate } = params;
  return (
    `Objective:\n${objective}\n\n` +
    `Run contract:\n${JSON.stringify(contract, null, 2)}\n\n` +
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

function buildContractPrompt(objective: string): string {
  return (
    `User objective:\n${objective}\n\n` +
    "Return JSON only in this shape:\n" +
    '{"kind":"finite|until_condition|until_stopped","successCriteria":["..."],"completionCriteria":["..."],"blockedCriteria":["..."],"nextCheckMs":8000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"none|until_exit|keep_running|restart_on_exit","maxRestarts":5,"restartBackoffMs":5000}}\n\n' +
    "Rules:\n" +
    "- Use until_stopped only when the user explicitly says the task should continue until they stop it.\n" +
    "- Use until_condition when the task should keep running until some external condition is observed.\n" +
    "- Use finite for bounded tasks that should complete on their own.\n" +
    "- Use managedProcessPolicy.mode = until_exit when the task is specifically to watch a managed process until it exits.\n" +
    "- Use managedProcessPolicy.mode = keep_running when the task is to keep a managed process/server/app running and alert on exits.\n" +
    "- Use managedProcessPolicy.mode = restart_on_exit when the task is to recover or restart a managed process after exit.\n" +
    "- When mode = restart_on_exit, set a bounded restart budget and backoff to avoid flapping loops.\n" +
    "- Use managedProcessPolicy.mode = none when the task is not centered on a managed process lifecycle.\n" +
    "- nextCheckMs should be a practical verification cadence in milliseconds.\n" +
    "- heartbeatMs is optional and should be omitted when no proactive heartbeat is useful.\n"
  );
}

function buildCarryForwardPrompt(params: {
  objective: string;
  contract: BackgroundRunContract;
  previous?: BackgroundRunCarryForwardState;
  actorResult?: ChatExecutorResult;
  latestUpdate?: string;
  latestToolEvidence?: string;
  pendingSignals: readonly BackgroundRunSignal[];
  observedTargets: readonly BackgroundRunObservedTarget[];
}): string {
  const {
    objective,
    contract,
    previous,
    actorResult,
    latestUpdate,
    latestToolEvidence,
    pendingSignals,
    observedTargets,
  } = params;
  return (
    `Objective:\n${objective}\n\n` +
    `Run contract:\n${JSON.stringify(contract, null, 2)}\n\n` +
    (previous
      ? `Previous carry-forward state:\n${JSON.stringify(previous, null, 2)}\n\n`
      : "") +
    (latestUpdate ? `Latest published update:\n${latestUpdate}\n\n` : "") +
    (latestToolEvidence ? `Latest tool evidence:\n${latestToolEvidence}\n\n` : "") +
    (observedTargets.length > 0
      ? `Runtime observed targets:\n${JSON.stringify(observedTargets, null, 2)}\n\n`
      : "") +
    (pendingSignals.length > 0
      ? `Pending external signals:\n${JSON.stringify(pendingSignals, null, 2)}\n\n`
      : "") +
    (actorResult
      ? `Latest actor response:\n${actorResult.content || "(empty)"}\n\n` +
        `Latest cycle tool evidence:\n${summarizeToolCalls(actorResult.toolCalls)}\n\n`
      : "") +
    "Return JSON only in this shape:\n" +
    '{"summary":"...","verifiedFacts":["..."],"openLoops":["..."],"nextFocus":"..."}\n\n' +
    "Rules:\n" +
    "- Keep only durable task-relevant context that the next cycle actually needs.\n" +
    "- Prefer verified facts over guesses.\n" +
    "- Include open loops that still require supervision.\n" +
    "- Include operator/user signals when they change the next step.\n" +
    "- Keep summary under 240 chars and each list item under 120 chars.\n"
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

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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

function parseContract(text: string): BackgroundRunContract | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const kind = parsed.kind;
    if (
      kind !== "finite" &&
      kind !== "until_condition" &&
      kind !== "until_stopped"
    ) {
      return undefined;
    }
    const nextCheckMs = clampPollIntervalMs(
      typeof parsed.nextCheckMs === "number" ? parsed.nextCheckMs : undefined,
    );
    const heartbeatMs =
      typeof parsed.heartbeatMs === "number" && Number.isFinite(parsed.heartbeatMs)
        ? clampPollIntervalMs(parsed.heartbeatMs)
        : undefined;
    const managedProcessPolicy =
      parsed.managedProcessPolicy &&
      typeof parsed.managedProcessPolicy === "object" &&
      !Array.isArray(parsed.managedProcessPolicy)
        ? parsed.managedProcessPolicy as Record<string, unknown>
        : undefined;
    const normalizeList = (value: unknown, fallback: string): string[] => {
      if (!Array.isArray(value)) return [fallback];
      const list = value.filter((item): item is string => typeof item === "string");
      return list.length > 0 ? list : [fallback];
    };
    return {
      kind,
      successCriteria: normalizeList(
        parsed.successCriteria,
        "Make forward progress on the objective with verified evidence.",
      ),
      completionCriteria: normalizeList(
        parsed.completionCriteria,
        "Only complete once the environment confirms the objective is satisfied.",
      ),
      blockedCriteria: normalizeList(
        parsed.blockedCriteria,
        "Block when required tools, permissions, or external preconditions are missing.",
      ),
      nextCheckMs,
      heartbeatMs,
      requiresUserStop:
        typeof parsed.requiresUserStop === "boolean"
          ? parsed.requiresUserStop
          : kind === "until_stopped",
      managedProcessPolicy:
        managedProcessPolicy !== undefined
          ? {
              mode: normalizeManagedProcessPolicyMode(managedProcessPolicy.mode),
              maxRestarts: normalizePositiveInteger(
                managedProcessPolicy.maxRestarts,
              ),
              restartBackoffMs: normalizePositiveInteger(
                managedProcessPolicy.restartBackoffMs,
              ),
            }
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseCarryForwardState(
  text: string,
  now: number,
): BackgroundRunCarryForwardState | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.summary !== "string") return undefined;
    const verifiedFacts = normalizeStringArray(parsed.verifiedFacts)
      .slice(0, 6)
      .map((item) => truncate(item, 120));
    const openLoops = normalizeStringArray(parsed.openLoops)
      .slice(0, 6)
      .map((item) => truncate(item, 120));
    return {
      summary: truncate(parsed.summary, 240),
      verifiedFacts,
      openLoops,
      nextFocus:
        typeof parsed.nextFocus === "string"
          ? truncate(parsed.nextFocus, 120)
          : undefined,
      lastCompactedAt: now,
    };
  } catch {
    return undefined;
  }
}

function buildFallbackCarryForwardState(params: {
  previous?: BackgroundRunCarryForwardState;
  latestUpdate?: string;
  latestToolEvidence?: string;
  pendingSignals: readonly BackgroundRunSignal[];
  now: number;
}): BackgroundRunCarryForwardState {
  const { previous, latestUpdate, latestToolEvidence, pendingSignals, now } = params;
  const verifiedFacts = [
    ...truncateList(previous?.verifiedFacts ?? [], 3, 120),
    ...(latestToolEvidence ? [truncate(latestToolEvidence, 120)] : []),
  ].slice(0, 4);
  const openLoops = [
    ...truncateList(previous?.openLoops ?? [], 3, 120),
    ...pendingSignals.slice(0, 2).map((signal) => truncate(signal.content, 120)),
  ].slice(0, 4);
  return {
    summary: truncate(
      latestUpdate ??
        previous?.summary ??
        "Task remains active and requires continued supervision.",
      240,
    ),
    verifiedFacts,
    openLoops,
    nextFocus:
      pendingSignals[0]?.content
        ? truncate(pendingSignals[0].content, 120)
        : previous?.nextFocus,
    lastCompactedAt: now,
  };
}

function buildFallbackContract(objective: string): BackgroundRunContract {
  const untilStopped = UNTIL_STOP_RE.test(objective);
  const continuous = CONTINUOUS_RE.test(objective) || BACKGROUND_RE.test(objective);
  const managedProcessPolicyMode = inferManagedProcessPolicyMode(objective);
  return {
    kind: untilStopped
      ? "until_stopped"
      : continuous
        ? "until_condition"
        : "finite",
    successCriteria: [
      "Use tools to make measurable progress and verify the result.",
    ],
    completionCriteria: [
      untilStopped
        ? "Do not complete until the user explicitly stops the run."
        : "Only complete once tool evidence shows the objective is satisfied.",
    ],
    blockedCriteria: [
      "Block when required approvals, credentials, or external preconditions are missing.",
    ],
    nextCheckMs: DEFAULT_POLL_INTERVAL_MS,
    heartbeatMs: continuous ? HEARTBEAT_MIN_DELAY_MS : undefined,
    requiresUserStop: untilStopped,
    managedProcessPolicy:
      managedProcessPolicyMode !== "none"
        ? {
            mode: managedProcessPolicyMode,
            maxRestarts:
              managedProcessPolicyMode === "restart_on_exit"
                ? DEFAULT_MANAGED_PROCESS_MAX_RESTARTS
                : undefined,
            restartBackoffMs:
              managedProcessPolicyMode === "restart_on_exit"
                ? DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS
                : undefined,
          }
        : undefined,
  };
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
  run: ActiveBackgroundRun,
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

  if (
    decision.state === "completed" &&
    run.contract.requiresUserStop
  ) {
    return {
      state: "working",
      userUpdate: truncate(
        decision.userUpdate || "Task is still running until you tell me to stop.",
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Rejected premature completion because the run contract requires an explicit user stop.",
      nextCheckMs: clampPollIntervalMs(run.contract.nextCheckMs),
      shouldNotifyUser: decision.shouldNotifyUser,
    };
  }

  if (
    decision.state === "completed" &&
    successfulToolCalls.length === 0 &&
    !run.lastToolEvidence
  ) {
    return {
      state: "blocked",
      userUpdate: truncate(
        "Background run cannot mark itself complete without verified tool evidence.",
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Rejected completion because there is no verified tool evidence in the current or previous cycle.",
      shouldNotifyUser: true,
    };
  }

  return decision;
}

function computeConsecutiveErrorCycles(
  run: ActiveBackgroundRun,
  actorResult: ChatExecutorResult,
): number {
  if (actorResult.toolCalls.length === 0) return 0;
  const allFailed = actorResult.toolCalls.every((toolCall) => toolCall.isError);
  return allFailed ? run.consecutiveErrorCycles + 1 : 0;
}

function applyRepeatedErrorGuard(
  decision: BackgroundRunDecision,
  consecutiveErrorCycles: number,
): BackgroundRunDecision {
  if (consecutiveErrorCycles < MAX_CONSECUTIVE_ERROR_CYCLES) return decision;
  if (decision.state !== "working") return decision;
  return {
    state: "blocked",
    userUpdate: truncate(
      "Background run is stuck on repeated tool errors and needs intervention or a different plan.",
      MAX_USER_UPDATE_CHARS,
    ),
    internalSummary:
      `Escalated after ${consecutiveErrorCycles} consecutive all-error cycles.`,
    shouldNotifyUser: true,
  };
}

function parseManagedProcessState(value: unknown): "running" | "exited" | undefined {
  if (value === "running" || value === "exited") {
    return value;
  }
  return undefined;
}

function parseManagedProcessLaunchSpec(
  payload: Record<string, unknown>,
): BackgroundRunManagedProcessLaunchSpec | undefined {
  if (typeof payload.command !== "string" || payload.command.trim().length === 0) {
    return undefined;
  }
  return {
    command: payload.command,
    args: normalizeStringArray(payload.args),
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    label: typeof payload.label === "string" ? payload.label : undefined,
    logPath: typeof payload.logPath === "string" ? payload.logPath : undefined,
  };
}

function findManagedProcessTarget(
  observedTargets: readonly BackgroundRunObservedTarget[],
  processId: string | undefined,
  label: string | undefined,
): Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> | undefined {
  if (processId) {
    const match = [...observedTargets]
      .reverse()
      .find((target) =>
        target.kind === "managed_process" && target.processId === processId,
      );
    if (match?.kind === "managed_process") {
      return match;
    }
  }
  if (label) {
    const match = [...observedTargets]
      .reverse()
      .find((target) =>
        target.kind === "managed_process" && target.label === label,
      );
    if (match?.kind === "managed_process") {
      return match;
    }
  }
  return [...observedTargets]
    .reverse()
    .find((target): target is Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> =>
      target.kind === "managed_process",
    );
}

function findLatestManagedProcessTarget(
  observedTargets: readonly BackgroundRunObservedTarget[],
): Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> | undefined {
  return [...observedTargets]
    .reverse()
    .find((target): target is Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> =>
      target.kind === "managed_process",
    );
}

function shouldKeepRunningAfterProcessExit(run: ActiveBackgroundRun): boolean {
  const policyMode = getManagedProcessPolicyMode(run);
  if (policyMode === "keep_running" || policyMode === "restart_on_exit") {
    return true;
  }
  const corpus = [
    run.objective,
    ...run.contract.successCriteria,
    ...run.contract.completionCriteria,
    ...run.contract.blockedCriteria,
    run.carryForward?.summary,
    ...(run.carryForward?.openLoops ?? []),
    run.carryForward?.nextFocus,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return /\b(restart|recover|relaunch|respawn|replace|resume|keep running|stay running|continue monitoring|continue supervising)\b/.test(
    corpus,
  );
}

function allowsHeuristicProcessExitCompletion(run: ActiveBackgroundRun): boolean {
  if (run.contract.requiresUserStop || run.contract.kind === "until_stopped") {
    return false;
  }
  if (shouldKeepRunningAfterProcessExit(run)) {
    return false;
  }

  const corpus = [
    run.objective,
    ...run.contract.successCriteria,
    ...run.contract.completionCriteria,
    run.carryForward?.summary,
    ...(run.carryForward?.verifiedFacts ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return /\b(exit|exits|exited|stop|stops|stopped|terminate|terminated|finish|finished|complete|completed|terminal state)\b/.test(
    corpus,
  );
}

function extractManagedProcessObservation(
  toolCall: ChatExecutorResult["toolCalls"][number],
  observedAt: number,
  existingTarget?: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): BackgroundRunObservedTarget | undefined {
  if (
    toolCall.isError ||
    (
      toolCall.name !== "desktop.process_start" &&
      toolCall.name !== "desktop.process_status" &&
      toolCall.name !== "desktop.process_stop"
    )
  ) {
    return undefined;
  }
  const payload = parseJsonRecord(toolCall.result);
  if (!payload) return undefined;
  const processId =
    typeof payload.processId === "string" && payload.processId.trim().length > 0
      ? payload.processId.trim()
      : undefined;
  const currentState = parseManagedProcessState(payload.state);
  if (!processId || !currentState) return undefined;
  return {
    kind: "managed_process",
    processId,
    label:
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : undefined,
    pid: typeof payload.pid === "number" ? payload.pid : undefined,
    pgid: typeof payload.pgid === "number" ? payload.pgid : undefined,
    desiredState: "running",
    exitPolicy: "keep_running",
    currentState,
    lastObservedAt: observedAt,
    exitCode:
      payload.exitCode === null || typeof payload.exitCode === "number"
        ? payload.exitCode
        : undefined,
    signal:
      payload.signal === null || typeof payload.signal === "string"
        ? payload.signal
        : undefined,
    launchSpec:
      parseManagedProcessLaunchSpec(payload) ??
      existingTarget?.launchSpec,
    restartCount: existingTarget?.restartCount,
    lastRestartAt: existingTarget?.lastRestartAt,
  };
}

function upsertObservedTarget(
  observedTargets: readonly BackgroundRunObservedTarget[],
  nextTarget: BackgroundRunObservedTarget,
): BackgroundRunObservedTarget[] {
  const next = [...observedTargets];
  const index = next.findIndex((target) =>
    target.kind === nextTarget.kind &&
    target.processId === nextTarget.processId,
  );
  if (index >= 0) {
    next[index] = nextTarget;
    return next;
  }
  next.push(nextTarget);
  return next;
}

function observeManagedProcessTargets(
  run: ActiveBackgroundRun,
  actorResult: ChatExecutorResult,
  now: number,
): void {
  const policyMode = getManagedProcessPolicyMode(run);
  for (const toolCall of actorResult.toolCalls) {
    const payload = parseJsonRecord(toolCall.result);
    const processId =
      payload && typeof payload.processId === "string"
        ? payload.processId
        : undefined;
    const label =
      payload && typeof payload.label === "string"
        ? payload.label
        : undefined;
    const existingTarget = findManagedProcessTarget(
      run.observedTargets,
      processId,
      label,
    );
    const observation = extractManagedProcessObservation(
      toolCall,
      now,
      existingTarget,
    );
    if (!observation) continue;
    const desiredState = policyMode === "until_exit" ? "exited" : "running";
    const exitPolicy =
      policyMode === "restart_on_exit"
        ? "restart_on_exit"
        : policyMode === "until_exit"
          ? "until_exit"
          : "keep_running";
    run.observedTargets = upsertObservedTarget(run.observedTargets, {
      ...observation,
      desiredState,
      exitPolicy,
    });
  }
}

function parseProcessExitSignalProcessId(signal: BackgroundRunSignal): string | undefined {
  const processId =
    signal.data && typeof signal.data === "object"
      ? signal.data.processId
      : undefined;
  if (typeof processId === "string" && processId.trim().length > 0) {
    return processId.trim();
  }
  return undefined;
}

function observeManagedProcessExitSignal(run: ActiveBackgroundRun): void {
  const processExitSignal = [...run.pendingSignals]
    .reverse()
    .find((signal) => signal.type === "process_exit");
  if (!processExitSignal) return;
  const processId = parseProcessExitSignalProcessId(processExitSignal);
  if (!processId) return;
  const existing = run.observedTargets.find((target) =>
    target.kind === "managed_process" && target.processId === processId,
  );
  if (!existing || existing.kind !== "managed_process") return;
  run.observedTargets = upsertObservedTarget(run.observedTargets, {
    ...existing,
    currentState: "exited",
    lastObservedAt: processExitSignal.timestamp,
    exitCode:
      processExitSignal.data?.exitCode === null ||
      typeof processExitSignal.data?.exitCode === "number"
        ? processExitSignal.data?.exitCode as number | null | undefined
        : existing.exitCode,
    signal:
      processExitSignal.data?.signal === null ||
      typeof processExitSignal.data?.signal === "string"
        ? processExitSignal.data?.signal as string | null | undefined
        : existing.signal,
  });
}

function buildManagedProcessCompletionDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  if (run.contract.requiresUserStop || run.contract.kind === "until_stopped") {
    return undefined;
  }
  const target = [...run.observedTargets]
    .reverse()
    .find((candidate) =>
      candidate.kind === "managed_process" &&
      candidate.exitPolicy === "until_exit" &&
      candidate.currentState === "exited" &&
      candidate.desiredState === "exited",
    );
  if (!target || target.kind !== "managed_process") {
    return undefined;
  }
  const matchingExitSignal = [...run.pendingSignals]
    .reverse()
    .find((signal) =>
      signal.type === "process_exit" &&
      parseProcessExitSignalProcessId(signal) === target.processId,
    );
  const targetLabel = target.label ? `"${target.label}" ` : "";
  const detail =
    matchingExitSignal?.content ??
    `Managed process ${targetLabel}(${target.processId}) exited.`;
  return {
    state: "completed",
    userUpdate: truncate(
      `${detail} Objective satisfied.`,
      MAX_USER_UPDATE_CHARS,
    ),
    internalSummary:
      "Completed deterministically from managed-process lifecycle target.",
    shouldNotifyUser: true,
  };
}

function buildHeuristicProcessExitCompletionDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  const processExitSignal = [...run.pendingSignals]
    .reverse()
    .find((signal) => signal.type === "process_exit");
  if (!processExitSignal) return undefined;
  if (!allowsHeuristicProcessExitCompletion(run)) return undefined;

  const detail = (processExitSignal.content ?? "").toLowerCase();
  const satisfiedByExit =
    detail.includes("exited") ||
    detail.includes("terminated") ||
    detail.includes("finished");
  if (!satisfiedByExit) {
    return undefined;
  }

  return {
    state: "completed",
    userUpdate: truncate(
      `${processExitSignal.content} Objective satisfied.`,
      MAX_USER_UPDATE_CHARS,
    ),
    internalSummary:
      "Completed deterministically from heuristic process_exit signal without waiting for another model cycle.",
    shouldNotifyUser: true,
  };
}

function buildDeterministicCompletionDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  return (
    buildManagedProcessCompletionDecision(run) ??
    buildHeuristicProcessExitCompletionDecision(run)
  );
}

interface NativeManagedProcessCycleResult {
  readonly actorResult: ChatExecutorResult;
  readonly decision: BackgroundRunDecision;
}

function hasOnlyNativeManagedProcessSignals(
  run: ActiveBackgroundRun,
): boolean {
  return run.pendingSignals.every((signal) => signal.type === "process_exit");
}

function shouldUseManagedProcessNativeCycle(
  run: ActiveBackgroundRun,
): boolean {
  if (getManagedProcessPolicyMode(run) === "none") return false;
  if (!findLatestManagedProcessTarget(run.observedTargets)) return false;
  if (run.pendingSignals.length === 0) return true;
  return hasOnlyNativeManagedProcessSignals(run);
}

function buildManagedProcessIdentity(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): string {
  return `${target.label ? `"${target.label}" ` : ""}(${target.processId})`;
}

function buildManagedProcessExitDetail(
  run: ActiveBackgroundRun,
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): string {
  const matchingExitSignal = [...run.pendingSignals]
    .reverse()
    .find((signal) =>
      signal.type === "process_exit" &&
      parseProcessExitSignalProcessId(signal) === target.processId,
    );
  if (matchingExitSignal?.content) {
    return matchingExitSignal.content;
  }
  const statusBits = [
    target.exitCode !== undefined && target.exitCode !== null
      ? `exitCode=${target.exitCode}`
      : undefined,
    target.signal ? `signal=${target.signal}` : undefined,
  ].filter(Boolean);
  return (
    `Managed process ${buildManagedProcessIdentity(target)} exited` +
    (statusBits.length > 0 ? ` (${statusBits.join(", ")}).` : ".")
  );
}

async function executeNativeToolCall(
  toolHandler: ToolHandler,
  name: string,
  args: Record<string, unknown>,
): Promise<ChatExecutorResult["toolCalls"][number]> {
  const startedAt = Date.now();
  try {
    const result = await toolHandler(name, args);
    return {
      name,
      args,
      result,
      isError: didToolCallFail(false, result),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    const result = JSON.stringify({ error: toErrorMessage(error) });
    return {
      name,
      args,
      result,
      isError: true,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

function buildNativeActorResult(
  toolCalls: readonly ChatExecutorResult["toolCalls"][number][],
  content: string,
): ChatExecutorResult {
  const durationMs = toolCalls.reduce((total, toolCall) => total + toolCall.durationMs, 0);
  return {
    content,
    provider: "runtime-native",
    model: "managed-process-supervisor",
    usedFallback: false,
    toolCalls,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    callUsage: [],
    durationMs,
    compacted: false,
    stopReason: "completed",
  };
}

function markManagedProcessRestart(
  run: ActiveBackgroundRun,
  previousTarget: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
  now: number,
): void {
  const nextTarget = findManagedProcessTarget(
    run.observedTargets,
    undefined,
    previousTarget.label,
  ) ?? findLatestManagedProcessTarget(run.observedTargets);
  if (!nextTarget) return;
  run.observedTargets = upsertObservedTarget(run.observedTargets, {
    ...nextTarget,
    restartCount: (previousTarget.restartCount ?? 0) + 1,
    lastRestartAt: now,
  });
}

async function executeManagedProcessNativeCycle(params: {
  run: ActiveBackgroundRun;
  toolHandler: ToolHandler;
  now: number;
}): Promise<NativeManagedProcessCycleResult | undefined> {
  const { run, toolHandler, now } = params;
  if (!shouldUseManagedProcessNativeCycle(run)) {
    return undefined;
  }

  const target = findLatestManagedProcessTarget(run.observedTargets);
  if (!target) {
    return undefined;
  }

  const policy = getManagedProcessPolicy(run);
  const statusArgs = target.label ? { label: target.label } : { processId: target.processId };
  const statusCall = await executeNativeToolCall(
    toolHandler,
    "desktop.process_status",
    statusArgs,
  );
  const toolCalls: ChatExecutorResult["toolCalls"][number][] = [statusCall];
  const actorResult = buildNativeActorResult(
    toolCalls,
    `Verified managed process ${buildManagedProcessIdentity(target)}.`,
  );

  observeManagedProcessTargets(run, actorResult, now);
  run.lastVerifiedAt = now;
  run.lastToolEvidence = summarizeToolCalls(toolCalls);

  const refreshedTarget =
    findManagedProcessTarget(run.observedTargets, target.processId, target.label) ??
    findLatestManagedProcessTarget(run.observedTargets);

  if (!refreshedTarget) {
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          "Managed process verification returned no usable state and will retry shortly.",
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: "Native managed-process verification produced no observable target.",
        nextCheckMs: MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      },
    };
  }

  if (statusCall.isError) {
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          `Managed process verification failed and will retry: ${extractToolFailureText(statusCall)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: `Native managed-process status probe failed: ${extractToolFailureText(statusCall)}`,
        nextCheckMs: MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      },
    };
  }

  if (refreshedTarget.currentState === "running") {
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          `Managed process ${buildManagedProcessIdentity(refreshedTarget)} is still running.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: "Native managed-process verifier confirmed the process is still running.",
        nextCheckMs: clampPollIntervalMs(run.contract.nextCheckMs),
        shouldNotifyUser: true,
      },
    };
  }

  if (policy.mode === "until_exit") {
    return {
      actorResult,
      decision:
        buildManagedProcessCompletionDecision(run) ?? {
          state: "completed",
          userUpdate: truncate(
            `${buildManagedProcessExitDetail(run, refreshedTarget)} Objective satisfied.`,
            MAX_USER_UPDATE_CHARS,
          ),
          internalSummary: "Completed from native managed-process status verification.",
          shouldNotifyUser: true,
        },
    };
  }

  if (policy.mode === "keep_running") {
    return {
      actorResult,
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `${buildManagedProcessExitDetail(run, refreshedTarget)} Restart is not configured, so the run is blocked until you give a new instruction.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          "Managed process exited under keep_running policy without auto-restart.",
        shouldNotifyUser: true,
      },
    };
  }

  if (policy.mode !== "restart_on_exit") {
    return undefined;
  }

  const launchSpec = refreshedTarget.launchSpec;
  if (!launchSpec) {
    return {
      actorResult,
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `${buildManagedProcessExitDetail(run, refreshedTarget)} Restart is configured but the runtime has no launch spec to use.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          "Managed process restart policy could not execute because no launch spec was persisted.",
        shouldNotifyUser: true,
      },
    };
  }

  const restartCount = refreshedTarget.restartCount ?? 0;
  if (
    policy.maxRestarts !== undefined &&
    restartCount >= policy.maxRestarts
  ) {
    return {
      actorResult,
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `${buildManagedProcessExitDetail(run, refreshedTarget)} Restart budget exhausted after ${restartCount} attempts.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          `Managed process restart budget exhausted at ${restartCount} attempts.`,
        shouldNotifyUser: true,
      },
    };
  }

  const restartBackoffMs = policy.restartBackoffMs ?? DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS;
  if (
    refreshedTarget.lastRestartAt !== undefined &&
    refreshedTarget.lastRestartAt + restartBackoffMs > now
  ) {
    const remainingMs = refreshedTarget.lastRestartAt + restartBackoffMs - now;
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          `${buildManagedProcessExitDetail(run, refreshedTarget)} Waiting ${Math.ceil(remainingMs / 1000)}s before restart.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          "Managed process restart deferred to honor restart backoff.",
        nextCheckMs: Math.max(MIN_POLL_INTERVAL_MS, remainingMs),
        shouldNotifyUser: true,
      },
    };
  }

  const restartArgs: Record<string, unknown> = {
    command: launchSpec.command,
    args: [...launchSpec.args],
  };
  if (launchSpec.cwd) restartArgs.cwd = launchSpec.cwd;
  if (launchSpec.label) restartArgs.label = launchSpec.label;
  if (launchSpec.logPath) restartArgs.logPath = launchSpec.logPath;
  const restartCall = await executeNativeToolCall(
    toolHandler,
    "desktop.process_start",
    restartArgs,
  );
  toolCalls.push(restartCall);
  const restartActorResult = buildNativeActorResult(
    toolCalls,
    `Recovered managed process ${buildManagedProcessIdentity(refreshedTarget)}.`,
  );
  observeManagedProcessTargets(run, restartActorResult, now);
  run.lastVerifiedAt = now;
  run.lastToolEvidence = summarizeToolCalls(toolCalls);

  if (restartCall.isError) {
    return {
      actorResult: restartActorResult,
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `${buildManagedProcessExitDetail(run, refreshedTarget)} Restart failed: ${extractToolFailureText(restartCall)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: `Managed process restart failed: ${extractToolFailureText(restartCall)}`,
        shouldNotifyUser: true,
      },
    };
  }

  markManagedProcessRestart(run, refreshedTarget, now);
  const restartedTarget =
    findManagedProcessTarget(
      run.observedTargets,
      parseToolResultObject(restartCall.result)?.processId as string | undefined,
      launchSpec.label,
    ) ?? findLatestManagedProcessTarget(run.observedTargets);

  return {
    actorResult: restartActorResult,
    decision: {
      state: "working",
      userUpdate: truncate(
        `${buildManagedProcessExitDetail(run, refreshedTarget)} Restarted ${restartedTarget ? buildManagedProcessIdentity(restartedTarget) : "the managed process"} and will keep monitoring.`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Managed process exited and was restarted by the native runtime verifier.",
      nextCheckMs: FAST_FOLLOWUP_POLL_INTERVAL_MS,
      shouldNotifyUser: true,
    },
  };
}

function toPersistedRun(run: ActiveBackgroundRun): PersistedBackgroundRun {
  return {
    version: 1,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    contract: run.contract,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    carryForward: run.carryForward,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    internalHistory: trimHistory([...run.internalHistory]),
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
  };
}

function toRecentSnapshot(run: ActiveBackgroundRun): BackgroundRunRecentSnapshot {
  return {
    version: 1,
    runId: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    state: run.state,
    contractKind: run.contract.kind,
    requiresUserStop: run.contract.requiresUserStop,
    cycleCount: run.cycleCount,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastVerifiedAt: run.lastVerifiedAt,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastWakeReason: run.lastWakeReason,
    pendingSignals: run.pendingSignals.length,
    carryForwardSummary: run.carryForward?.summary,
  };
}

function toActiveRun(run: PersistedBackgroundRun): ActiveBackgroundRun {
  return {
    version: 1,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    contract: run.contract,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    carryForward: run.carryForward,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    internalHistory: [...run.internalHistory],
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
    timer: null,
    heartbeatTimer: null,
    abortController: null,
  };
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

export function isBackgroundRunPauseRequest(message: string): boolean {
  return PAUSE_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunResumeRequest(message: string): boolean {
  return RESUME_REQUEST_RE.test(message.trim());
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
  private readonly runStore: BackgroundRunStore;
  private readonly logger: Logger;
  private readonly instanceId: string;
  private readonly now: () => number;
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
    this.runStore = config.runStore;
    this.logger = config.logger ?? silentLogger;
    this.instanceId =
      config.instanceId ??
      `background-supervisor-${Math.random().toString(36).slice(2, 10)}`;
    this.now = config.now ?? (() => Date.now());
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
      lastWakeReason: run.lastWakeReason,
      pendingSignals: run.pendingSignals.length,
      carryForwardSummary: run.carryForward?.summary,
    };
  }

  async getRecentSnapshot(
    sessionId: string,
  ): Promise<BackgroundRunRecentSnapshot | undefined> {
    const active = this.activeRuns.get(sessionId);
    if (active) return toRecentSnapshot(active);
    return this.runStore.loadRecentSnapshot(sessionId);
  }

  private isActiveRun(run: ActiveBackgroundRun): boolean {
    return this.activeRuns.get(run.sessionId) === run;
  }

  async recoverRuns(): Promise<number> {
    const persistedRuns = await this.runStore.listRuns();
    let recovered = 0;
    for (const persistedRun of persistedRuns) {
      if (
        persistedRun.state === "completed" ||
        persistedRun.state === "failed" ||
        persistedRun.state === "blocked" ||
        persistedRun.state === "cancelled"
      ) {
        await this.runStore.deleteRun(persistedRun.sessionId);
        continue;
      }
      const lease = await this.runStore.claimLease(
        persistedRun.sessionId,
        this.instanceId,
        this.now(),
      );
      if (!lease.claimed || !lease.run) continue;
      const run = toActiveRun(lease.run);
      if (run.state === "running") {
        run.state = "working";
        run.updatedAt = this.now();
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
      }
      this.activeRuns.set(run.sessionId, run);
      await this.persistRun(run, {
        type: "run_recovered",
        summary: `Recovered background run: ${truncate(run.objective, 200)}`,
        timestamp: this.now(),
        data: { previousState: lease.run.state },
      });
      if (run.state === "paused") {
        recovered += 1;
        continue;
      }
      const nextDelay =
        run.pendingSignals.length > 0
          ? 0
          : run.nextCheckAt !== undefined
          ? Math.max(0, run.nextCheckAt - this.now())
          : 0;
      this.schedule(run, nextDelay, "recovery");
      if (run.state === "working" && run.nextHeartbeatAt !== undefined) {
        const heartbeatDelay = Math.max(0, run.nextHeartbeatAt - this.now());
        this.scheduleHeartbeat(run, heartbeatDelay);
      }
      recovered += 1;
    }
    return recovered;
  }

  async startRun(params: StartBackgroundRunParams): Promise<BackgroundRunStatusSnapshot> {
    await this.cancelRun(params.sessionId, "Replaced by a new background run.");

    const now = this.now();
    const contract = await this.planRunContract(params.objective);
    const run: ActiveBackgroundRun = {
      version: 1,
      id: `bg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: params.sessionId,
      objective: params.objective.trim(),
      contract,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      cycleCount: 0,
      stableWorkingCycles: 0,
      consecutiveErrorCycles: 0,
      lastVerifiedAt: undefined,
      lastUserUpdate: undefined,
      lastToolEvidence: undefined,
      lastHeartbeatContent: undefined,
      lastWakeReason: "start",
      carryForward: undefined,
      pendingSignals: [],
      observedTargets: [],
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      internalHistory: [
        ...(this.seedHistoryForSession?.(params.sessionId)?.slice(-6) ?? []),
      ],
      leaseOwnerId: this.instanceId,
      leaseExpiresAt: now + 45_000,
      timer: null,
      heartbeatTimer: null,
      abortController: null,
    };

    this.activeRuns.set(params.sessionId, run);
    await this.persistRun(run, {
      type: "run_started",
      summary: `Background run started: ${truncate(run.objective, 200)}`,
      timestamp: now,
      data: {
        contractKind: run.contract.kind,
        nextCheckMs: run.contract.nextCheckMs,
      },
    });
    await this.progressTracker?.append({
      sessionId: params.sessionId,
      type: "task_started",
      summary: truncate(`Background run started: ${run.objective}`, 200),
    });

    await this.publishUpdate(
      params.sessionId,
      "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
    );
    this.schedule(run, 0, "start");
    return this.getStatusSnapshot(params.sessionId)!;
  }

  async signalRun(params: {
    sessionId: string;
    content: string;
    type?: Exclude<
      BackgroundRunWakeReason,
      "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
    >;
    data?: Record<string, unknown>;
  }): Promise<boolean> {
    const run = this.activeRuns.get(params.sessionId);
    if (!run) return false;

    const content = params.content.trim();
    if (!content) return false;

    const signal: BackgroundRunSignal = {
      id: `signal-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: params.type ?? "user_input",
      content,
      timestamp: this.now(),
      data: params.data ? { ...params.data } : undefined,
    };
    run.pendingSignals.push(signal);
    if (signal.type === "process_exit") {
      observeManagedProcessExitSignal(run);
    }
    run.updatedAt = this.now();
    run.lastWakeReason = signal.type;
    await this.persistRun(run, {
      type: "run_signalled",
      summary: truncate(`Background run signalled: ${content}`, 200),
      timestamp: this.now(),
      data: { signalType: signal.type },
    });

    if (run.state === "paused") {
      return true;
    }

    if (run.state !== "running") {
      const completionDecision = buildDeterministicCompletionDecision(run);
      if (completionDecision) {
        await this.finishRun(run, completionDecision);
        return true;
      }
      this.schedule(run, 0, signal.type);
    }
    return true;
  }

  async pauseRun(
    sessionId: string,
    reason = "Paused the active background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return false;
    if (run.state === "paused") return true;

    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    run.state = "paused";
    run.updatedAt = this.now();
    run.lastWakeReason = "user_input";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run paused: ${reason}`, 200),
    });
    await this.persistRun(run, {
      type: "run_paused",
      summary: truncate(`Background run paused: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    return true;
  }

  async resumeRun(
    sessionId: string,
    reason = "Resumed the background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run || run.state !== "paused") return false;

    run.state = "working";
    run.updatedAt = this.now();
    run.lastWakeReason = "user_input";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    run.lastHeartbeatContent = undefined;

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run resumed: ${reason}`, 200),
    });
    await this.persistRun(run, {
      type: "run_resumed",
      summary: truncate(`Background run resumed: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    this.schedule(run, 0, run.pendingSignals[0]?.type ?? "user_input");
    return true;
  }

  async cancelRun(sessionId: string, reason = "Stopped by user."): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return false;

    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    run.state = "cancelled";
    run.updatedAt = this.now();
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    this.activeRuns.delete(sessionId);
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(run));

    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "run_cancelled",
      summary: truncate(`Background run cancelled: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.runStore.deleteRun(sessionId);
    await this.progressTracker?.append({
      sessionId,
      type: "task_completed",
      summary: truncate(`Background run cancelled: ${reason}`, 200),
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    return true;
  }

  async shutdown(): Promise<void> {
    const runs = [...this.activeRuns.values()];
    for (const run of runs) {
      this.clearRunTimers(run);
      run.abortController?.abort();
      run.abortController = null;
      if (run.state === "running") {
        run.state = "working";
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
      }
      await this.runStore.releaseLease(
        run.sessionId,
        this.instanceId,
        this.now(),
        {
          ...toPersistedRun(run),
          state: run.state,
          nextCheckAt: run.nextCheckAt,
          nextHeartbeatAt: run.nextHeartbeatAt,
          lastWakeReason: "daemon_shutdown",
        },
      );
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_suspended",
        summary: "Background run suspended for daemon shutdown and will recover on next boot.",
        timestamp: this.now(),
      });
      await this.runStore.saveRecentSnapshot(toRecentSnapshot(run));
      this.activeRuns.delete(run.sessionId);
    }
  }

  private schedule(
    run: ActiveBackgroundRun,
    delayMs: number,
    wakeReason: BackgroundRunWakeReason = "timer",
  ): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    if (run.timer) clearTimeout(run.timer);
    run.nextCheckAt = this.now() + delayMs;
    run.lastWakeReason = wakeReason;
    void this.persistRun(run).catch((error) => {
      this.logger.debug("Failed to persist scheduled background run", {
        sessionId: run.sessionId,
        error: toErrorMessage(error),
      });
    });
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
    run.nextHeartbeatAt = this.now() + delayMs;
    void this.persistRun(run).catch((error) => {
      this.logger.debug("Failed to persist background heartbeat schedule", {
        sessionId: run.sessionId,
        error: toErrorMessage(error),
      });
    });
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
            ? `Next verification in ~${Math.max(1, Math.ceil((run.nextCheckAt - this.now()) / 1000))}s`
            : "Background run waiting for next verification",
      });
    await this.publishUpdate(sessionId, content);
    await this.persistRun(run);
  }

  private async executeCycle(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (run.state === "paused") return;
    const leasedRun = await this.runStore.renewLease(
      toPersistedRun(run),
      this.instanceId,
      this.now(),
    );
    if (!leasedRun) {
      this.clearRunTimers(run);
      this.activeRuns.delete(sessionId);
      return;
    }
    run.leaseOwnerId = leasedRun.leaseOwnerId;
    run.leaseExpiresAt = leasedRun.leaseExpiresAt;
    if (this.isSessionBusy?.(sessionId)) {
      this.schedule(run, BUSY_RETRY_INTERVAL_MS, "busy_retry");
      return;
    }
    if (
      !run.contract.requiresUserStop &&
      this.now() - run.createdAt > MAX_BACKGROUND_RUNTIME_MS
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run timed out before the objective was completed.",
        internalSummary: "Exceeded maximum background runtime budget.",
        shouldNotifyUser: true,
      });
      return;
    }
    if (!run.contract.requiresUserStop && run.cycleCount >= MAX_BACKGROUND_CYCLES) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run hit its cycle budget before completing.",
        internalSummary: "Exceeded maximum background cycle budget.",
        shouldNotifyUser: true,
      });
      return;
    }

    run.state = "running";
    run.updatedAt = this.now();
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
    await this.persistRun(run, {
      type: "cycle_started",
      summary: `Background run cycle ${run.cycleCount} started.`,
      timestamp: this.now(),
    });
    this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS);

    const cycleToolHandler = this.createToolHandler({
      sessionId,
      runId: run.id,
      cycleIndex: run.cycleCount,
    });
    const actorPrompt = buildActorPrompt(run);
    const actorSystemPrompt = `${this.getSystemPrompt()}\n\n${BACKGROUND_ACTOR_SECTION}`;
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    let consecutiveErrorCycles = run.consecutiveErrorCycles;
    try {
      const previousToolEvidence = run.lastToolEvidence;
      const nativeCycle = await executeManagedProcessNativeCycle({
        run,
        toolHandler: cycleToolHandler,
        now: this.now(),
      });
      if (nativeCycle) {
        actorResult = nativeCycle.actorResult;
        decision = nativeCycle.decision;
      } else {
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
          toolHandler: cycleToolHandler,
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
        run.lastVerifiedAt = this.now();
        run.lastToolEvidence = summarizeToolCalls(actorResult.toolCalls);
        observeManagedProcessTargets(run, actorResult, run.lastVerifiedAt);
        decision =
          buildDeterministicCompletionDecision(run) ??
          (await this.evaluateDecision(run, actorResult)) ??
          buildFallbackDecision(run, actorResult);
      }

      consecutiveErrorCycles = computeConsecutiveErrorCycles(run, actorResult);
      run.consecutiveErrorCycles = consecutiveErrorCycles;
      decision = groundDecision(run, actorResult, decision);
      decision = applyRepeatedErrorGuard(decision, consecutiveErrorCycles);
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
      run.consecutiveErrorCycles += 1;
      decision = {
        state:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? "failed"
            : "working",
        userUpdate: truncate(
          `Background run failed: ${toErrorMessage(error)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: toErrorMessage(error),
        nextCheckMs:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? undefined
            : MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      };
    } finally {
      run.abortController = null;
    }

    const signalDrivenCompletion = buildDeterministicCompletionDecision(run);
    if (signalDrivenCompletion) {
      decision = signalDrivenCompletion;
    }

    if (decision.state === "working") {
      const carryForwardSignalSnapshot = cloneSignals(run.pendingSignals);
      await this.refreshCarryForwardState({
        run,
        actorResult,
        signalSnapshot: carryForwardSignalSnapshot,
      });
      if (!this.isActiveRun(run)) {
        return;
      }
      const postRefreshSignalDrivenCompletion = buildDeterministicCompletionDecision(run);
      if (postRefreshSignalDrivenCompletion) {
        await this.finishRun(run, postRefreshSignalDrivenCompletion);
        return;
      }

      const pendingSignalWake = run.pendingSignals[0];
      const hasPendingSignals = pendingSignalWake !== undefined;
      const nextWakeReason = pendingSignalWake?.type ?? "timer";
      const nextCheckMs = hasPendingSignals
        ? 0
        : clampPollIntervalMs(decision.nextCheckMs);

      run.state = "working";
      run.updatedAt = this.now();
      await this.progressTracker?.append({
        sessionId,
        type: "decision",
        summary: truncate(
          `Background run working: ${decision.internalSummary}`,
          200,
        ),
      });
      if (decision.shouldNotifyUser && !hasPendingSignals) {
        await this.publishUpdateIfChanged(run, decision.userUpdate);
      }
      if (!this.isActiveRun(run)) {
        return;
      }
      if (!hasPendingSignals) {
        this.scheduleHeartbeat(run, heartbeatMs);
      }
      this.onStatus?.(sessionId, {
        phase: "background_wait",
        detail: hasPendingSignals
          ? "Processing newly arrived external signals"
          : `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s`,
      });
      await this.persistRun(run, {
        type: "cycle_working",
        summary: truncate(
          `Background run working: ${decision.internalSummary}`,
          200,
        ),
        timestamp: this.now(),
        data: {
          nextCheckMs,
          consecutiveErrorCycles: run.consecutiveErrorCycles,
          pendingSignals: run.pendingSignals.length,
        },
      });
      if (!this.isActiveRun(run)) {
        return;
      }
      this.schedule(run, nextCheckMs, nextWakeReason);
      return;
    }

    await this.refreshCarryForwardState({ run, actorResult, force: true });
    if (!this.isActiveRun(run)) {
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
            contract: run.contract,
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

  private async refreshCarryForwardState(params: {
    run: ActiveBackgroundRun;
    actorResult?: ChatExecutorResult;
    force?: boolean;
    signalSnapshot?: readonly BackgroundRunSignal[];
  }): Promise<void> {
    const { run, actorResult, force, signalSnapshot } = params;
    const pendingSignals = signalSnapshot ?? run.pendingSignals;
    const hasSuccessfulToolCalls =
      actorResult?.toolCalls.some((toolCall) => !toolCall.isError) ?? false;
    const carryForwardAgeMs =
      run.carryForward !== undefined
        ? this.now() - run.carryForward.lastCompactedAt
        : undefined;
    const shouldRefresh =
      force === true ||
      !run.carryForward ||
      pendingSignals.length > 0 ||
      run.internalHistory.length >= HISTORY_COMPACTION_THRESHOLD ||
      (
        hasSuccessfulToolCalls &&
        (carryForwardAgeMs === undefined ||
          carryForwardAgeMs >= MIN_CARRY_FORWARD_REFRESH_MS)
      );
    if (!shouldRefresh) return;

    try {
      const response = await this.supervisorLlm.chat([
        { role: "system", content: CARRY_FORWARD_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildCarryForwardPrompt({
            objective: run.objective,
            contract: run.contract,
            previous: run.carryForward,
            actorResult,
            latestUpdate: run.lastUserUpdate,
            latestToolEvidence: run.lastToolEvidence,
            pendingSignals,
            observedTargets: run.observedTargets,
          }),
        },
      ], {
        toolChoice: "none",
      });
      run.carryForward =
        parseCarryForwardState(response.content, this.now()) ??
        buildFallbackCarryForwardState({
          previous: run.carryForward,
          latestUpdate: run.lastUserUpdate,
          latestToolEvidence: run.lastToolEvidence,
          pendingSignals,
          now: this.now(),
        });
    } catch (error) {
      this.logger.debug("Background run carry-forward refresh failed", {
        sessionId: run.sessionId,
        runId: run.id,
        error: toErrorMessage(error),
      });
      run.carryForward = buildFallbackCarryForwardState({
        previous: run.carryForward,
        latestUpdate: run.lastUserUpdate,
        latestToolEvidence: run.lastToolEvidence,
        pendingSignals,
        now: this.now(),
      });
    }

    if (pendingSignals.length > 0) {
      run.pendingSignals = removeConsumedSignals(run.pendingSignals, pendingSignals);
    }
  }

  private async planRunContract(objective: string): Promise<BackgroundRunContract> {
    try {
      const response = await this.supervisorLlm.chat([
        { role: "system", content: CONTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildContractPrompt(objective) },
      ], {
        toolChoice: "none",
      });
      return parseContract(response.content) ?? buildFallbackContract(objective);
    } catch (error) {
      this.logger.debug("Background run contract planning failed", {
        objective: truncate(objective, 120),
        error: toErrorMessage(error),
      });
      return buildFallbackContract(objective);
    }
  }

  private async persistRun(
    run: ActiveBackgroundRun,
    event?: {
      type: string;
      summary: string;
      timestamp: number;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.runStore.saveRun(toPersistedRun(run));
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(run));
    if (event) {
      await this.runStore.appendEvent(toPersistedRun(run), event);
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
    await this.persistRun(run, {
      type: "user_update",
      summary: next,
      timestamp: this.now(),
    });
  }

  private async finishRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    run.state = decision.state;
    run.updatedAt = this.now();
    if (decision.shouldNotifyUser) {
      run.lastUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
    }
    this.activeRuns.delete(run.sessionId);
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(run));

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
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: `run_${decision.state}`,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
      timestamp: this.now(),
    });
    await this.runStore.deleteRun(run.sessionId);

    if (decision.shouldNotifyUser) {
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }
}
