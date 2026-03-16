/**
 * Managed-process lifecycle domain and run-domain resolution for the BackgroundRunSupervisor.
 *
 * Extracted from background-run-supervisor.ts. Contains:
 * - Managed process surface tool mapping
 * - Managed process observation, bootstrap, and native cycle execution
 * - MANAGED_PROCESS_RUN_DOMAIN definition
 * - Run domain resolution (getRunDomain)
 * - Deterministic domain decision builders
 * - Watch registration helpers
 *
 * @module
 */

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { ToolHandler } from "../llm/types.js";
import {
  type BackgroundRunManagedProcessLaunchSpec,
  type BackgroundRunManagedProcessPolicy,
  type BackgroundRunObservedTarget,
  type BackgroundRunWatchRegistration,
} from "./background-run-store.js";
import {
  extractToolFailureText,
} from "../llm/chat-executor-tool-utils.js";
import {
  buildNativeActorResult,
  executeNativeToolCall,
} from "./run-domain-native-tools.js";
import { parseDirectCommandLine } from "../tools/system/command-line.js";
import {
  createApprovalRunDomain,
  createBrowserRunDomain,
  createDesktopGuiRunDomain,
  createGenericRunDomain,
  createPipelineRunDomain,
  createRemoteMcpRunDomain,
  createResearchRunDomain,
  createWorkspaceRunDomain,
  type RunDomain,
  type RunDomainNativeCycleResult,
  type RunDomainVerification,
  verificationSupportsContinuation,
} from "./run-domains.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
  ManagedProcessCommandSpec,
  NativeManagedProcessCycleResult,
} from "./background-run-supervisor-types.js";
import {
  clampPollIntervalMs,
  normalizeStringArray,
  normalizePositiveInteger,
  parseJsonRecord,
  truncate,
  recordToolEvidence,
  normalizeManagedProcessPolicyMode,
  inferManagedProcessPolicyMode,
} from "./background-run-supervisor-helpers.js";
import {
  MIN_POLL_INTERVAL_MS,
  MAX_USER_UPDATE_CHARS,
  FAST_FOLLOWUP_POLL_INTERVAL_MS,
  DEFAULT_MANAGED_PROCESS_MAX_RESTARTS,
  DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS,
  EVENT_DRIVEN_MANAGED_PROCESS_RECONCILE_MS,
  MANAGED_PROCESS_BOOTSTRAP_QUOTED_COMMAND_RE,
  MANAGED_PROCESS_BOOTSTRAP_COMMAND_RE,
  MANAGED_PROCESS_BOOTSTRAP_LABEL_RE,
  NON_EXECUTABLE_BOOTSTRAP_TOKENS,
  DEFAULT_NATIVE_SERVER_PROTOCOL,
  DEFAULT_NATIVE_SERVER_HEALTH_PATH,
  DEFAULT_NATIVE_SERVER_READY_STATUS_CODES,
  DEFAULT_NATIVE_SERVER_READINESS_TIMEOUT_MS,
} from "./background-run-supervisor-constants.js";

// ---------------------------------------------------------------------------
// Run domain singleton instances
// ---------------------------------------------------------------------------

const GENERIC_RUN_DOMAIN = createGenericRunDomain();
const APPROVAL_RUN_DOMAIN = createApprovalRunDomain();
const BROWSER_RUN_DOMAIN = createBrowserRunDomain();
const DESKTOP_GUI_RUN_DOMAIN = createDesktopGuiRunDomain();
const WORKSPACE_RUN_DOMAIN = createWorkspaceRunDomain();
const RESEARCH_RUN_DOMAIN = createResearchRunDomain();
const PIPELINE_RUN_DOMAIN = createPipelineRunDomain();
const REMOTE_MCP_RUN_DOMAIN = createRemoteMcpRunDomain();

// ---------------------------------------------------------------------------
// Managed process policy helpers
// ---------------------------------------------------------------------------

export function getManagedProcessPolicy(
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

export function getManagedProcessPolicyMode(run: ActiveBackgroundRun): "none" | "until_exit" | "keep_running" | "restart_on_exit" {
  return getManagedProcessPolicy(run).mode;
}

// ---------------------------------------------------------------------------
// Managed process surface tool mapping
// ---------------------------------------------------------------------------

export function getManagedProcessSurfaceFromToolName(
  toolName: string,
): "desktop" | "host" | "host_server" | undefined {
  if (toolName.startsWith("desktop.process_")) {
    return "desktop";
  }
  if (toolName.startsWith("system.process")) {
    return "host";
  }
  if (toolName.startsWith("system.server")) {
    return "host_server";
  }
  return undefined;
}

export function getManagedProcessSurface(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): "desktop" | "host" | "host_server" {
  return target.surface ?? "desktop";
}

export function managedProcessStatusToolName(
  surface: "desktop" | "host" | "host_server",
): "desktop.process_status" | "system.processStatus" | "system.serverStatus" {
  if (surface === "host") {
    return "system.processStatus";
  }
  if (surface === "host_server") {
    return "system.serverStatus";
  }
  return "desktop.process_status";
}

export function managedProcessStartToolName(
  surface: "desktop" | "host" | "host_server",
): "desktop.process_start" | "system.processStart" | "system.serverStart" {
  if (surface === "host") {
    return "system.processStart";
  }
  if (surface === "host_server") {
    return "system.serverStart";
  }
  return "desktop.process_start";
}

export function managedProcessStopToolName(
  surface: "desktop" | "host" | "host_server",
): "desktop.process_stop" | "system.processStop" | "system.serverStop" {
  if (surface === "host") {
    return "system.processStop";
  }
  if (surface === "host_server") {
    return "system.serverStop";
  }
  return "desktop.process_stop";
}

export function buildManagedProcessStopArgs(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): Record<string, unknown> {
  const surface = getManagedProcessSurface(target);
  if (surface === "host_server") {
    return {
      ...(target.serverId ? { serverId: target.serverId } : {}),
      ...(target.label ? { label: target.label } : {}),
      ...(target.launchSpec?.idempotencyKey
        ? { idempotencyKey: target.launchSpec.idempotencyKey }
        : {}),
    };
  }
  return {
    processId: target.processId,
    ...(target.label ? { label: target.label } : {}),
    ...(target.launchSpec?.idempotencyKey
      ? { idempotencyKey: target.launchSpec.idempotencyKey }
      : {}),
  };
}

export function buildManagedProcessStatusArgs(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): Record<string, unknown> {
  return getManagedProcessSurface(target) === "host_server"
    ? target.label
      ? { label: target.label }
      : target.serverId
        ? { serverId: target.serverId }
        : { processId: target.processId }
    : target.label
      ? { label: target.label }
      : { processId: target.processId };
}

// ---------------------------------------------------------------------------
// Managed process launch spec parsing
// ---------------------------------------------------------------------------

export function parseManagedProcessLaunchSpec(
  payload: Record<string, unknown>,
  toolName: string,
): BackgroundRunManagedProcessLaunchSpec | undefined {
  if (typeof payload.command !== "string" || payload.command.trim().length === 0) {
    return undefined;
  }
  const isServerHandle = toolName.startsWith("system.server");
  return {
    kind: isServerHandle ? "server" : "process",
    command: payload.command,
    args: normalizeStringArray(payload.args),
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    label: typeof payload.label === "string" ? payload.label : undefined,
    logPath: typeof payload.logPath === "string" ? payload.logPath : undefined,
    idempotencyKey:
      typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined,
    healthUrl: typeof payload.healthUrl === "string" ? payload.healthUrl : undefined,
    host: typeof payload.host === "string" ? payload.host : undefined,
    port:
      typeof payload.port === "number" && Number.isInteger(payload.port)
        ? payload.port
        : undefined,
    protocol:
      payload.protocol === "http" || payload.protocol === "https"
        ? payload.protocol
        : undefined,
    readyStatusCodes: Array.isArray(payload.readyStatusCodes)
      ? payload.readyStatusCodes.filter(
        (item): item is number =>
          typeof item === "number" &&
          Number.isInteger(item) &&
          item >= 100 &&
          item <= 599,
      )
      : undefined,
    readinessTimeoutMs:
      typeof payload.readinessTimeoutMs === "number" &&
      Number.isFinite(payload.readinessTimeoutMs)
        ? Math.floor(payload.readinessTimeoutMs)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Managed process state parsing & observation
// ---------------------------------------------------------------------------

export function parseManagedProcessState(value: unknown): "running" | "exited" | undefined {
  if (value === "running" || value === "exited") {
    return value;
  }
  if (value === "starting") {
    return "running";
  }
  if (value === "stopped" || value === "failed") {
    return "exited";
  }
  return undefined;
}

export function findManagedProcessTarget(
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

export function findLatestManagedProcessTarget(
  observedTargets: readonly BackgroundRunObservedTarget[],
): Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> | undefined {
  return [...observedTargets]
    .reverse()
    .find((target): target is Extract<BackgroundRunObservedTarget, { kind: "managed_process" }> =>
      target.kind === "managed_process",
    );
}

export function extractManagedProcessObservation(
  toolCall: ChatExecutorResult["toolCalls"][number],
  observedAt: number,
  existingTarget?: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): BackgroundRunObservedTarget | undefined {
  const surface = getManagedProcessSurfaceFromToolName(toolCall.name);
  if (
    toolCall.isError ||
    !surface
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
    serverId:
      typeof payload.serverId === "string" && payload.serverId.trim().length > 0
        ? payload.serverId.trim()
        : undefined,
    surface,
    pid: typeof payload.pid === "number" ? payload.pid : undefined,
    pgid: typeof payload.pgid === "number" ? payload.pgid : undefined,
    desiredState: "running",
    exitPolicy: "keep_running",
    currentState,
    ready: typeof payload.ready === "boolean" ? payload.ready : undefined,
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
      parseManagedProcessLaunchSpec(payload, toolCall.name) ??
      existingTarget?.launchSpec,
    restartCount: existingTarget?.restartCount,
    lastRestartAt: existingTarget?.lastRestartAt,
  };
}

export function upsertObservedTarget(
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

export function observeManagedProcessTargets(
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
    run.watchRegistrations = upsertWatchRegistration(
      run.watchRegistrations,
      buildManagedProcessWatchRegistration({
        ...observation,
        desiredState,
        exitPolicy,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Watch registration helpers
// ---------------------------------------------------------------------------

export function buildManagedProcessWatchRegistration(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): BackgroundRunWatchRegistration {
  return {
    id: `watch:managed_process:${target.processId}`,
    kind: "managed_process",
    targetId: target.processId,
    label: target.label,
    wakeOn: ["process_exit", "tool_result"],
    registeredAt: target.lastObservedAt,
    lastTriggeredAt:
      target.currentState === "exited" ? target.lastObservedAt : undefined,
  };
}

export function upsertWatchRegistration(
  registrations: readonly BackgroundRunWatchRegistration[],
  nextRegistration: BackgroundRunWatchRegistration,
): BackgroundRunWatchRegistration[] {
  const next = [...registrations];
  const index = next.findIndex((registration) => registration.id === nextRegistration.id);
  if (index >= 0) {
    next[index] = nextRegistration;
    return next;
  }
  next.push(nextRegistration);
  return next;
}

// ---------------------------------------------------------------------------
// Process exit signal observation
// ---------------------------------------------------------------------------

export function parseProcessExitSignalProcessId(signal: { data?: Record<string, unknown> | null }): string | undefined {
  const processId =
    signal.data && typeof signal.data === "object"
      ? signal.data.processId
      : undefined;
  if (typeof processId === "string" && processId.trim().length > 0) {
    return processId.trim();
  }
  return undefined;
}

export function observeManagedProcessExitSignal(run: ActiveBackgroundRun): void {
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
  run.watchRegistrations = upsertWatchRegistration(
    run.watchRegistrations,
    {
      ...buildManagedProcessWatchRegistration({
        ...existing,
        currentState: "exited",
        lastObservedAt: processExitSignal.timestamp,
      }),
      lastTriggeredAt: processExitSignal.timestamp,
    },
  );
}

// ---------------------------------------------------------------------------
// Deterministic completion decisions
// ---------------------------------------------------------------------------

export function shouldKeepRunningAfterProcessExit(run: ActiveBackgroundRun): boolean {
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

export function allowsHeuristicProcessExitCompletion(run: ActiveBackgroundRun): boolean {
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

export function buildManagedProcessIdentity(
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): string {
  return `${target.label ? `"${target.label}" ` : ""}(${target.processId})`;
}

export function buildManagedProcessCompletionDecision(
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

export function buildHeuristicProcessExitCompletionDecision(
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

export function buildDeterministicCompletionDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  return (
    buildManagedProcessCompletionDecision(run) ??
    buildHeuristicProcessExitCompletionDecision(run)
  );
}

// ---------------------------------------------------------------------------
// Native cycle helpers
// ---------------------------------------------------------------------------

export function hasOnlyNativeManagedProcessSignals(
  run: ActiveBackgroundRun,
): boolean {
  return run.pendingSignals.every((signal) => signal.type === "process_exit");
}

export function shouldUseManagedProcessNativeCycle(
  run: ActiveBackgroundRun,
): boolean {
  if (getManagedProcessPolicyMode(run) === "none") return false;
  if (!findLatestManagedProcessTarget(run.observedTargets)) {
    return extractManagedProcessBootstrapCommandLine(run) !== undefined;
  }
  if (run.pendingSignals.length === 0) return true;
  return hasOnlyNativeManagedProcessSignals(run);
}

export function hasManagedProcessExitWatch(
  run: ActiveBackgroundRun,
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): boolean {
  return run.watchRegistrations.some(
    (registration) =>
      registration.kind === "managed_process" &&
      registration.targetId === target.processId &&
      registration.wakeOn.includes("process_exit"),
  );
}

export function computeManagedProcessReconcileIntervalMs(
  run: ActiveBackgroundRun,
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): number {
  const requestedNextCheckMs = clampPollIntervalMs(run.contract.nextCheckMs);
  if (target.surface === "host_server" && target.ready === false) {
    return requestedNextCheckMs;
  }
  if (!hasManagedProcessExitWatch(run, target)) {
    return requestedNextCheckMs;
  }
  return Math.max(
    requestedNextCheckMs,
    EVENT_DRIVEN_MANAGED_PROCESS_RECONCILE_MS,
  );
}

export function buildManagedProcessRetryPolicy(
  run: ActiveBackgroundRun,
): import("./run-domains.js").RunDomainRetryPolicy {
  const target = findLatestManagedProcessTarget(run.observedTargets);
  const requestedNextCheckMs = clampPollIntervalMs(run.contract.nextCheckMs);
  const idleNextCheckMs =
    target
      ? computeManagedProcessReconcileIntervalMs(run, target)
      : requestedNextCheckMs;
  return {
    fastFollowupMs: Math.max(
      MIN_POLL_INTERVAL_MS,
      Math.min(requestedNextCheckMs, FAST_FOLLOWUP_POLL_INTERVAL_MS),
    ),
    idleNextCheckMs,
    stableStepMs: 0,
    maxNextCheckMs: idleNextCheckMs,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap helpers
// ---------------------------------------------------------------------------

export function listManagedProcessBootstrapCandidates(
  run: ActiveBackgroundRun,
): readonly string[] {
  return [
    run.objective,
    ...run.contract.successCriteria,
    ...run.contract.completionCriteria,
    ...run.contract.blockedCriteria,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

export function extractManagedProcessBootstrapCommandLine(
  run: ActiveBackgroundRun,
): string | undefined {
  const isLikelyBootstrapCommand = (candidate: string): boolean => {
    const parsed = parseDirectCommandLine(candidate);
    if (!parsed) {
      return false;
    }
    const command = parsed.command.trim();
    if (!command) {
      return false;
    }
    const normalizedCommand = command.toLowerCase();
    if (NON_EXECUTABLE_BOOTSTRAP_TOKENS.has(normalizedCommand)) {
      return false;
    }
    return /^(?:\.{1,2}\/|\/)?[A-Za-z0-9_][A-Za-z0-9_./:+%@=-]*$/.test(command);
  };

  for (const candidate of listManagedProcessBootstrapCandidates(run)) {
    for (const match of candidate.matchAll(/`([^`]+)`/g)) {
      const commandLine = match[1]?.trim();
      if (commandLine && isLikelyBootstrapCommand(commandLine)) {
        return commandLine;
      }
    }

    const quotedMatch = candidate.match(MANAGED_PROCESS_BOOTSTRAP_QUOTED_COMMAND_RE);
    const quotedCommand = quotedMatch?.[1]?.trim() ?? quotedMatch?.[2]?.trim();
    if (quotedCommand && isLikelyBootstrapCommand(quotedCommand)) {
      return quotedCommand;
    }

    const plainMatch = candidate.match(MANAGED_PROCESS_BOOTSTRAP_COMMAND_RE);
    const plainCommand = plainMatch?.[1]?.trim();
    if (plainCommand && isLikelyBootstrapCommand(plainCommand)) {
      return plainCommand;
    }
  }
  return undefined;
}

export function extractManagedProcessBootstrapLabel(
  run: ActiveBackgroundRun,
): string | undefined {
  for (const candidate of listManagedProcessBootstrapCandidates(run)) {
    const label = candidate
      .match(MANAGED_PROCESS_BOOTSTRAP_LABEL_RE)?.[1]
      ?.trim()
      .replace(/[.,;:]+$/g, "");
    if (label) {
      return label;
    }
  }
  return undefined;
}

export function extractBootstrapHealthUrl(run: ActiveBackgroundRun): URL | undefined {
  const urlPattern = /https?:\/\/[^\s`"'<>]+/g;
  for (const candidate of listManagedProcessBootstrapCandidates(run)) {
    for (const match of candidate.matchAll(urlPattern)) {
      const raw = match[0]?.trim();
      if (!raw) {
        continue;
      }
      try {
        const parsed = new URL(raw);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return parsed;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function extractBootstrapPortFromArgs(args: readonly string[]): number | undefined {
  for (const value of args) {
    if (!/^\d{2,5}$/.test(value)) {
      continue;
    }
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  }
  return undefined;
}

export function wantsManagedServerBootstrap(
  run: ActiveBackgroundRun,
  commandSpec: ManagedProcessCommandSpec,
): boolean {
  const objectiveCorpus = listManagedProcessBootstrapCandidates(run)
    .join(" ")
    .toLowerCase();
  const explicitUrl = extractBootstrapHealthUrl(run);
  const commandText = [commandSpec.command, ...commandSpec.args].join(" ").toLowerCase();
  const commandLooksLikeServer =
    commandText.includes("http.server") ||
    commandText.includes("http-server") ||
    commandText.includes("python -m http.server") ||
    commandText.includes("python3 -m http.server");
  const objectiveLooksLikeServer =
    /\b(server|service)\b/.test(objectiveCorpus) &&
    /\b(http|https|health|ready|readiness|localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(
      objectiveCorpus,
    );
  return Boolean(explicitUrl) || commandLooksLikeServer || objectiveLooksLikeServer;
}

export function buildManagedProcessBootstrapIdempotencyKey(
  run: ActiveBackgroundRun,
  label: string | undefined,
): string {
  if (label && label.length > 0) {
    return `background-run:${run.id}:${label}`;
  }
  return `background-run:${run.id}:managed-process`;
}

export function buildManagedProcessBootstrapStartSpec(
  run: ActiveBackgroundRun,
  commandSpec: ManagedProcessCommandSpec,
  label: string | undefined,
): {
  readonly surface: "host" | "host_server";
  readonly toolName: "system.processStart" | "system.serverStart";
  readonly args: Record<string, unknown>;
} {
  const idempotencyKey = buildManagedProcessBootstrapIdempotencyKey(run, label);
  const baseArgs: Record<string, unknown> = {
    command: commandSpec.command,
    args: [...commandSpec.args],
    ...(label ? { label } : {}),
    idempotencyKey,
  };
  if (wantsManagedServerBootstrap(run, commandSpec)) {
    const explicitHealthUrl = extractBootstrapHealthUrl(run);
    const port = explicitHealthUrl
      ? Number(explicitHealthUrl.port || (explicitHealthUrl.protocol === "https:" ? 443 : 80))
      : extractBootstrapPortFromArgs(commandSpec.args);
    return {
      surface: "host_server",
      toolName: "system.serverStart",
      args: {
        ...baseArgs,
        ...(explicitHealthUrl
          ? { healthUrl: explicitHealthUrl.toString() }
          : port
            ? {
                host: "127.0.0.1",
                port,
                protocol: DEFAULT_NATIVE_SERVER_PROTOCOL,
                healthPath: DEFAULT_NATIVE_SERVER_HEALTH_PATH,
              }
            : {}),
        readyStatusCodes: [...DEFAULT_NATIVE_SERVER_READY_STATUS_CODES],
        readinessTimeoutMs: DEFAULT_NATIVE_SERVER_READINESS_TIMEOUT_MS,
      },
    };
  }
  return {
    surface: "host",
    toolName: "system.processStart",
    args: baseArgs,
  };
}

export function shouldUpgradeManagedProcessTargetToServerHandle(
  run: ActiveBackgroundRun,
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>,
): boolean {
  if (target.surface !== "host") {
    return false;
  }
  if (target.currentState !== "running") {
    return false;
  }
  const launchSpec = target.launchSpec;
  if (!launchSpec) {
    return false;
  }
  return wantsManagedServerBootstrap(run, {
    command: launchSpec.command,
    args: launchSpec.args,
  });
}

// ---------------------------------------------------------------------------
// Managed process detail/restart helpers
// ---------------------------------------------------------------------------

export function listRunningManagedProcessTargets(
  run: ActiveBackgroundRun,
): Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>[] {
  const seen = new Set<string>();
  const targets: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>[] = [];
  for (const target of [...run.observedTargets].reverse()) {
    if (target.kind !== "managed_process") continue;
    if (target.currentState !== "running") continue;
    if (seen.has(target.processId)) continue;
    seen.add(target.processId);
    targets.push(target);
  }
  return targets;
}

export function buildManagedProcessExitDetail(
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

export function markManagedProcessRestart(
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

// ---------------------------------------------------------------------------
// Native cycle execution
// ---------------------------------------------------------------------------

export async function executeManagedServerUpgradeCycle(params: {
  run: ActiveBackgroundRun;
  toolHandler: ToolHandler;
  now: number;
  target: Extract<BackgroundRunObservedTarget, { kind: "managed_process" }>;
}): Promise<NativeManagedProcessCycleResult> {
  const { run, toolHandler, now, target } = params;
  const launchSpec = target.launchSpec;
  if (!launchSpec) {
    return {
      actorResult: buildNativeActorResult([], "Missing launch spec for server upgrade.", "managed-process-supervisor"),
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `Managed process ${buildManagedProcessIdentity(target)} cannot be upgraded to a typed server handle because the launch spec is missing.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          "Native managed-process server upgrade failed because no launch spec was persisted.",
        shouldNotifyUser: true,
      },
    };
  }

  const label = target.label ?? launchSpec.label;
  const bootstrapSpec = buildManagedProcessBootstrapStartSpec(
    run,
    {
      command: launchSpec.command,
      args: launchSpec.args,
    },
    label,
  );
  const toolCalls: ChatExecutorResult["toolCalls"][number][] = [];
  const stopCall = await executeNativeToolCall(
    toolHandler,
    "system.processStop",
    buildManagedProcessStopArgs(target),
  );
  toolCalls.push(stopCall);
  if (stopCall.isError) {
    return {
      actorResult: buildNativeActorResult(
        toolCalls,
        `Failed to stop ${buildManagedProcessIdentity(target)} before server-handle upgrade.`,
        "managed-process-supervisor",
      ),
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `Failed to stop ${buildManagedProcessIdentity(target)} before upgrading to a typed server handle: ${extractToolFailureText(stopCall)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          `Native managed-process server upgrade could not stop the existing process: ${extractToolFailureText(stopCall)}`,
        shouldNotifyUser: true,
      },
    };
  }

  const startCall = await executeNativeToolCall(
    toolHandler,
    bootstrapSpec.toolName,
    bootstrapSpec.args,
  );
  toolCalls.push(startCall);
  const startActorResult = buildNativeActorResult(
    toolCalls,
    `Upgrading ${buildManagedProcessIdentity(target)} to a typed server handle.`,
    "managed-process-supervisor",
  );
  observeManagedProcessTargets(run, startActorResult, now);
  run.lastVerifiedAt = now;
  recordToolEvidence(run, toolCalls);

  if (startCall.isError) {
    return {
      actorResult: startActorResult,
      decision: {
        state: "blocked",
        userUpdate: truncate(
          `Server-handle upgrade failed after stopping ${buildManagedProcessIdentity(target)}: ${extractToolFailureText(startCall)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          `Native managed-process server upgrade failed to start the typed server handle: ${extractToolFailureText(startCall)}`,
        shouldNotifyUser: true,
      },
    };
  }

  const upgradedTarget =
    findLatestManagedProcessTarget(run.observedTargets) ?? target;
  const statusCall = await executeNativeToolCall(
    toolHandler,
    managedProcessStatusToolName(getManagedProcessSurface(upgradedTarget)),
    buildManagedProcessStatusArgs(upgradedTarget),
  );
  toolCalls.push(statusCall);
  const actorResult = buildNativeActorResult(
    toolCalls,
    `Upgraded ${buildManagedProcessIdentity(target)} to typed server supervision.`,
    "managed-process-supervisor",
  );
  observeManagedProcessTargets(run, actorResult, now);
  run.lastVerifiedAt = now;
  recordToolEvidence(run, toolCalls);

  if (statusCall.isError) {
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          `Started typed server supervision for ${buildManagedProcessIdentity(upgradedTarget)} but readiness verification failed and will retry: ${extractToolFailureText(statusCall)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          `Native managed-process server upgrade started the typed server handle but status verification failed: ${extractToolFailureText(statusCall)}`,
        nextCheckMs: MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      },
    };
  }

  return {
    actorResult,
    decision: {
      state: "working",
      userUpdate: truncate(
        `Run ${run.id} in session ${run.sessionId}: upgraded to typed server supervision for ${buildManagedProcessIdentity(upgradedTarget)} and verified readiness state=${upgradedTarget.currentState}.`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Native managed-process verifier upgraded a plain host process bootstrap to a typed server handle.",
      nextCheckMs: FAST_FOLLOWUP_POLL_INTERVAL_MS,
      shouldNotifyUser: true,
    },
  };
}

export async function executeManagedProcessNativeCycle(params: {
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
    const commandLine = extractManagedProcessBootstrapCommandLine(run);
    if (!commandLine) {
      return undefined;
    }
    const parsed = parseDirectCommandLine(commandLine);
    if (!parsed) {
      return undefined;
    }
    const label = extractManagedProcessBootstrapLabel(run);
    const bootstrapSpec = buildManagedProcessBootstrapStartSpec(run, parsed, label);
    const startCall = await executeNativeToolCall(
      toolHandler,
      bootstrapSpec.toolName,
      bootstrapSpec.args,
    );
    const toolCalls: ChatExecutorResult["toolCalls"][number][] = [startCall];
    const startActorResult = buildNativeActorResult(
      toolCalls,
      `Started managed ${bootstrapSpec.surface === "host_server" ? "server" : "process"} ${label ? `"${label}" ` : ""}for background supervision.`,
      "managed-process-supervisor",
    );
    observeManagedProcessTargets(run, startActorResult, now);
    run.lastVerifiedAt = now;
    recordToolEvidence(run, toolCalls);

    if (startCall.isError) {
      return {
        actorResult: startActorResult,
        decision: {
          state: "blocked",
          userUpdate: truncate(
            `Managed process launch failed: ${extractToolFailureText(startCall)}`,
            MAX_USER_UPDATE_CHARS,
          ),
          internalSummary: `Native managed-process bootstrap failed: ${extractToolFailureText(startCall)}`,
          shouldNotifyUser: true,
        },
      };
    }

    const startedTarget =
      findLatestManagedProcessTarget(run.observedTargets);
    if (!startedTarget) {
      return {
        actorResult: startActorResult,
        decision: {
          state: "blocked",
          userUpdate: truncate(
            "Managed process launch returned no durable process identity.",
            MAX_USER_UPDATE_CHARS,
          ),
          internalSummary:
            "Native managed-process bootstrap succeeded but no observed target was recorded.",
          shouldNotifyUser: true,
        },
      };
    }

    const statusCall = await executeNativeToolCall(
      toolHandler,
      managedProcessStatusToolName(getManagedProcessSurface(startedTarget)),
      buildManagedProcessStatusArgs(startedTarget),
    );
    toolCalls.push(statusCall);
    const actorResult = buildNativeActorResult(
      toolCalls,
      `Bootstrapped managed process ${buildManagedProcessIdentity(startedTarget)}.`,
      "managed-process-supervisor",
    );
    observeManagedProcessTargets(run, actorResult, now);
    run.lastVerifiedAt = now;
    recordToolEvidence(run, toolCalls);
    const verifiedTarget =
      findManagedProcessTarget(
        run.observedTargets,
        startedTarget.processId,
        startedTarget.label,
      ) ?? startedTarget;

    if (statusCall.isError) {
      return {
        actorResult,
        decision: {
          state: "working",
          userUpdate: truncate(
            `Started ${buildManagedProcessIdentity(verifiedTarget)} but status verification failed and will retry: ${extractToolFailureText(statusCall)}`,
            MAX_USER_UPDATE_CHARS,
          ),
          internalSummary:
            `Native managed-process bootstrap started the process but status verification failed: ${extractToolFailureText(statusCall)}`,
          nextCheckMs: MIN_POLL_INTERVAL_MS,
          shouldNotifyUser: true,
        },
      };
    }

    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          `Run ${run.id} in session ${run.sessionId}: started ${buildManagedProcessIdentity(verifiedTarget)} and verified state=${verifiedTarget.currentState}.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary:
          "Native managed-process bootstrap launched and verified the durable handle.",
        nextCheckMs: FAST_FOLLOWUP_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      },
    };
  }

  const policy = getManagedProcessPolicy(run);
  if (shouldUpgradeManagedProcessTargetToServerHandle(run, target)) {
    return executeManagedServerUpgradeCycle({
      run,
      toolHandler,
      now,
      target,
    });
  }
  const surface = getManagedProcessSurface(target);
  const statusArgs = buildManagedProcessStatusArgs(target);
  const statusCall = await executeNativeToolCall(
    toolHandler,
    managedProcessStatusToolName(surface),
    statusArgs,
  );
  const toolCalls: ChatExecutorResult["toolCalls"][number][] = [statusCall];
  const actorResult = buildNativeActorResult(
    toolCalls,
    `Verified managed process ${buildManagedProcessIdentity(target)}.`,
    "managed-process-supervisor",
  );

  observeManagedProcessTargets(run, actorResult, now);
  run.lastVerifiedAt = now;
  recordToolEvidence(run, toolCalls);

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
    const isHealthyServer = surface !== "host_server" || refreshedTarget.ready !== false;
    return {
      actorResult,
      decision: {
        state: "working",
        userUpdate: truncate(
          isHealthyServer
            ? `Managed process ${buildManagedProcessIdentity(refreshedTarget)} is still running.`
            : `Server handle ${buildManagedProcessIdentity(refreshedTarget)} is running but failed its latest readiness probe and will be rechecked.`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: isHealthyServer
          ? "Native managed-process verifier confirmed the process is still running."
          : "Native managed-process verifier observed a running server handle that is currently not ready.",
        nextCheckMs: isHealthyServer
          ? computeManagedProcessReconcileIntervalMs(run, refreshedTarget)
          : clampPollIntervalMs(run.contract.nextCheckMs),
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
  if (launchSpec.idempotencyKey) restartArgs.idempotencyKey = launchSpec.idempotencyKey;
  if (surface !== "host_server" && launchSpec.logPath) {
    restartArgs.logPath = launchSpec.logPath;
  }
  if (surface === "host_server") {
    if (launchSpec.healthUrl) restartArgs.healthUrl = launchSpec.healthUrl;
    if (launchSpec.host) restartArgs.host = launchSpec.host;
    if (launchSpec.port !== undefined) restartArgs.port = launchSpec.port;
    if (launchSpec.protocol) restartArgs.protocol = launchSpec.protocol;
    if (launchSpec.readyStatusCodes) {
      restartArgs.readyStatusCodes = [...launchSpec.readyStatusCodes];
    }
    if (launchSpec.readinessTimeoutMs !== undefined) {
      restartArgs.readinessTimeoutMs = launchSpec.readinessTimeoutMs;
    }
  }
  const restartCall = await executeNativeToolCall(
    toolHandler,
    managedProcessStartToolName(surface),
    restartArgs,
  );
  toolCalls.push(restartCall);
  const restartActorResult = buildNativeActorResult(
    toolCalls,
    `Recovered managed process ${buildManagedProcessIdentity(refreshedTarget)}.`,
    "managed-process-supervisor",
  );
  observeManagedProcessTargets(run, restartActorResult, now);
  run.lastVerifiedAt = now;
  recordToolEvidence(run, toolCalls);

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
      (parseJsonRecord(restartCall.result) as Record<string, unknown> | undefined)?.processId as string | undefined,
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

// ---------------------------------------------------------------------------
// Domain verification conversions
// ---------------------------------------------------------------------------

export function toDecisionFromDomainVerification(
  verification: RunDomainVerification,
): BackgroundRunDecision {
  switch (verification.state) {
    case "success":
      return {
        state: "completed",
        userUpdate: verification.userUpdate,
        internalSummary: verification.summary,
        shouldNotifyUser: true,
      };
    case "blocked":
      return {
        state: "blocked",
        userUpdate: verification.userUpdate,
        internalSummary: verification.summary,
        shouldNotifyUser: true,
      };
    case "needs_attention":
      return {
        state: "blocked",
        userUpdate: verification.userUpdate,
        internalSummary: verification.summary,
        shouldNotifyUser: true,
      };
    case "safe_to_continue":
      return {
        state: "working",
        userUpdate: verification.userUpdate,
        internalSummary: verification.summary,
        nextCheckMs: verification.nextCheckMs,
        shouldNotifyUser: true,
      };
  }
}

function toDomainVerificationFromDecision(
  decision: BackgroundRunDecision,
): RunDomainVerification {
  switch (decision.state) {
    case "completed":
      return {
        state: "success",
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
        safeToContinue: false,
      };
    case "blocked":
      return {
        state: "blocked",
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
        safeToContinue: false,
      };
    case "failed":
      return {
        state: "needs_attention",
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
        safeToContinue: false,
      };
    case "working":
      return {
        state: "safe_to_continue",
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
        safeToContinue: true,
        nextCheckMs: decision.nextCheckMs,
      };
  }
  throw new Error(`Unhandled background run decision state: ${(decision as { state?: string }).state ?? "unknown"}`);
}

// ---------------------------------------------------------------------------
// MANAGED_PROCESS_RUN_DOMAIN
// ---------------------------------------------------------------------------

const MANAGED_PROCESS_RUN_DOMAIN: RunDomain<ActiveBackgroundRun> = {
  id: "managed_process",
  matches: (run) =>
    run.contract.domain === "managed_process" ||
    getManagedProcessPolicyMode(run) !== "none" ||
    run.observedTargets.some((target) => target.kind === "managed_process"),
  plannerContract: () => [
    "Use deterministic managed-process lifecycle evidence as the source of truth.",
    "Persist launch specs when restart_on_exit behavior is required.",
  ],
  verifierContract: () => [
    "Map process lifecycle into typed success, blocked, needs_attention, or safe_to_continue states.",
    "Reject assistant completion claims while the managed process is still running.",
  ],
  eventSubscriptions: () => ["process_exit", "tool_result", "user_input", "approval"],
  artifactContract: () => [
    "Managed process identity, pid/pgid, launch spec, and log path are durable artifacts.",
  ],
  retryPolicy: (run) => buildManagedProcessRetryPolicy(run),
  recoveryStrategy: () =>
    "Recover the last observed process identity, probe status deterministically, and only restart within bounded restart policy.",
  summarizeStatus: (run) => {
    const target = findLatestManagedProcessTarget(run.observedTargets);
    if (!target) {
      return run.lastUserUpdate;
    }
    return truncate(
      `Managed process ${buildManagedProcessIdentity(target)} is ${target.currentState}.`,
      MAX_USER_UPDATE_CHARS,
    );
  },
  detectBlocker: (run) => {
    if (run.blocker?.code === "managed_process_exit") {
      return {
        state: "blocked",
        summary: run.blocker.summary,
        userUpdate: truncate(run.blocker.summary, MAX_USER_UPDATE_CHARS),
        safeToContinue: false,
        blockerCode: run.blocker.code,
      };
    }
    return undefined;
  },
  detectDeterministicVerification: (run) => {
    const terminalDecision = buildDeterministicCompletionDecision(run);
    if (terminalDecision) {
      return toDomainVerificationFromDecision(terminalDecision);
    }
    const target = findLatestManagedProcessTarget(run.observedTargets);
    if (target && shouldUpgradeManagedProcessTargetToServerHandle(run, target)) {
      return {
        state: "safe_to_continue",
        summary:
          "Managed-process domain detected a server-like host process without a typed server handle and will upgrade it deterministically.",
        userUpdate: truncate(
          `Upgrading ${buildManagedProcessIdentity(target)} to a typed server handle so readiness can be verified.`,
          MAX_USER_UPDATE_CHARS,
        ),
        safeToContinue: true,
        nextCheckMs: 0,
      };
    }
    if (target?.currentState === "running") {
      return {
        state: "safe_to_continue",
        summary:
          "Managed-process domain verified the process is still running.",
        userUpdate: truncate(
          `Managed process ${buildManagedProcessIdentity(target)} is still running.`,
          MAX_USER_UPDATE_CHARS,
        ),
        safeToContinue: true,
        nextCheckMs: computeManagedProcessReconcileIntervalMs(run, target),
      };
    }
    if (target?.currentState === "exited") {
      if (target.exitPolicy === "keep_running") {
        return {
          state: "blocked",
          summary:
            "Managed-process domain detected an exited process under keep_running policy.",
          userUpdate: truncate(
            `${buildManagedProcessExitDetail(run, target)} Restart is not configured, so the run is blocked until you give a new instruction.`,
            MAX_USER_UPDATE_CHARS,
          ),
          safeToContinue: false,
          blockerCode: "managed_process_exit",
        };
      }
      if (target.exitPolicy === "restart_on_exit") {
        if (!target.launchSpec) {
          return {
            state: "blocked",
            summary:
              "Managed-process domain cannot restart because no launch spec was persisted.",
            userUpdate: truncate(
              `${buildManagedProcessExitDetail(run, target)} Restart is configured but the runtime has no launch spec to use.`,
              MAX_USER_UPDATE_CHARS,
            ),
            safeToContinue: false,
            blockerCode: "missing_prerequisite",
          };
        }
        return {
          state: "safe_to_continue",
          summary:
            "Managed-process domain detected an exited process and will hand off to native restart handling.",
          userUpdate: truncate(
            `${buildManagedProcessExitDetail(run, target)} Restart policy is active and the runtime will verify recovery.`,
            MAX_USER_UPDATE_CHARS,
          ),
          safeToContinue: true,
          nextCheckMs: 0,
        };
      }
    }
    return undefined;
  },
  observeActorResult: (run, actorResult, now) => {
    observeManagedProcessTargets(run, actorResult, now);
  },
  executeNativeCycle: async (
    run,
    context,
  ): Promise<RunDomainNativeCycleResult | undefined> => {
    const nativeResult = await executeManagedProcessNativeCycle({
      run,
      toolHandler: context.toolHandler,
      now: context.now,
    });
    if (!nativeResult) {
      return undefined;
    }
    return {
      actorResult: nativeResult.actorResult,
      verification: toDomainVerificationFromDecision(nativeResult.decision),
    };
  },
};

// ---------------------------------------------------------------------------
// Run domain resolution
// ---------------------------------------------------------------------------

export function getRunDomain(run: ActiveBackgroundRun): RunDomain<ActiveBackgroundRun> {
  if (APPROVAL_RUN_DOMAIN.matches(run)) {
    return APPROVAL_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (MANAGED_PROCESS_RUN_DOMAIN.matches(run)) {
    return MANAGED_PROCESS_RUN_DOMAIN;
  }
  if (BROWSER_RUN_DOMAIN.matches(run)) {
    return BROWSER_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (DESKTOP_GUI_RUN_DOMAIN.matches(run)) {
    return DESKTOP_GUI_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (WORKSPACE_RUN_DOMAIN.matches(run)) {
    return WORKSPACE_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (RESEARCH_RUN_DOMAIN.matches(run)) {
    return RESEARCH_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (PIPELINE_RUN_DOMAIN.matches(run)) {
    return PIPELINE_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  if (REMOTE_MCP_RUN_DOMAIN.matches(run)) {
    return REMOTE_MCP_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
  }
  return GENERIC_RUN_DOMAIN as RunDomain<ActiveBackgroundRun>;
}

// ---------------------------------------------------------------------------
// Deterministic domain decision builders
// ---------------------------------------------------------------------------

export function buildDeterministicRunDomainDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  const domain = getRunDomain(run);
  const blocker = domain.detectBlocker(run);
  if (blocker && !verificationSupportsContinuation(blocker)) {
    if (
      domain.id === "approval" &&
      run.pendingSignals.some((signal) =>
        /\b(approved|approval granted|authorized|token granted|continue)\b/i.test(
          signal.content,
        ),
      )
    ) {
      return undefined;
    }
    return toDecisionFromDomainVerification(blocker);
  }
  const verification = domain.detectDeterministicVerification(run);
  return verification ? toDecisionFromDomainVerification(verification) : undefined;
}

export function buildPreCycleDomainDecision(
  run: ActiveBackgroundRun,
): BackgroundRunDecision | undefined {
  const domain = getRunDomain(run);
  if (domain.id === "managed_process") {
    return undefined;
  }
  if (run.pendingSignals.length === 0 && !run.blocker) {
    return undefined;
  }
  return buildDeterministicRunDomainDecision(run);
}
