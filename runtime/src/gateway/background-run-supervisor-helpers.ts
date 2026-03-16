/**
 * Pure helper functions for the BackgroundRunSupervisor.
 *
 * Extracted from background-run-supervisor.ts. These functions handle:
 * - Text truncation and formatting
 * - Signal/artifact management
 * - Carry-forward state building, parsing, and repair
 * - Decision building/grounding
 * - JSON parsing
 * - Prompt construction
 * - Run state utilities
 * - Operator summary building
 * - Scheduling cadence
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import {
  inferAgentRunDomain,
  isAgentRunDomain,
} from "./agent-run-contract.js";
import {
  buildBackgroundRunExplanation,
  type BackgroundRunOperatorSummary,
} from "./background-run-operator.js";
import {
  DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
  DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
  deriveDefaultBackgroundRunMaxCycles,
  type BackgroundRunApprovalState,
  type BackgroundRunArtifactRef,
  type BackgroundRunBlockerState,
  type BackgroundRunBudgetState,
  type BackgroundRunCarryForwardState,
  type BackgroundRunCompactionState,
  type BackgroundRunContract,
  type BackgroundRunMemoryAnchor,
  type BackgroundRunObservedTarget,
  type BackgroundRunProviderContinuation,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunWakeReason,
  type BackgroundRunWorkerPool,
} from "./background-run-store.js";
import { buildBackgroundRunSignalFromToolResult } from "./background-run-wake-adapters.js";
import {
  parseToolResultObject,
} from "../llm/chat-executor-tool-utils.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
  CarryForwardRefreshReason,
} from "./background-run-supervisor-types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  HEARTBEAT_MIN_DELAY_MS,
  HISTORY_COMPACTION_THRESHOLD,
  MAX_TOOL_RESULT_PREVIEW_CHARS,
  MAX_USER_UPDATE_CHARS,
  MAX_MEMORY_FACTS,
  MAX_MEMORY_OPEN_LOOPS,
  MAX_MEMORY_ARTIFACTS,
  MAX_MEMORY_ANCHORS,
  MAX_CONSECUTIVE_ERROR_CYCLES,
  DEFAULT_MANAGED_PROCESS_MAX_RESTARTS,
  DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS,
  UNTIL_STOP_RE,
  CONTINUOUS_RE,
  BACKGROUND_RE,
} from "./background-run-supervisor-constants.js";

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function clampPollIntervalMs(
  value: number | undefined,
  options?: { readonly maxMs?: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const maxMs =
    typeof options?.maxMs === "number" && Number.isFinite(options.maxMs)
      ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(options.maxMs))
      : MAX_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(maxMs, Math.floor(value)));
}

export function truncateList(
  values: readonly string[],
  maxItems: number,
  maxChars = 100,
): string[] {
  return values.slice(0, maxItems).map((value) => truncate(value, maxChars));
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

export function normalizeOperatorStringList(
  value: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const normalized = (value ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [...fallback];
}

export function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sanitizeMemoryText(text: string, maxChars: number): string {
  const dataUriMatch = text.match(/data:[^;]+;base64,[A-Za-z0-9+/=\r\n]+/);
  if (dataUriMatch) {
    const digest = hashOpaqueValue(dataUriMatch[0]);
    return truncate(`[binary artifact omitted sha256:${digest}]`, maxChars);
  }
  const base64Match = text.match(/[A-Za-z0-9+/=\r\n]{512,}/);
  if (base64Match) {
    const digest = hashOpaqueValue(base64Match[0]);
    return truncate(`[large binary-like payload omitted sha256:${digest}]`, maxChars);
  }
  return truncate(text, maxChars);
}

// ---------------------------------------------------------------------------
// JSON extraction and parsing
// ---------------------------------------------------------------------------

export function extractJsonObject(text: string): string | undefined {
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

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
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

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

export function cloneSignals(
  signals: readonly BackgroundRunSignal[],
): BackgroundRunSignal[] {
  return signals.map((signal) => ({
    ...signal,
    data: signal.data ? { ...signal.data } : undefined,
  }));
}

export function removeConsumedSignals(
  signals: readonly BackgroundRunSignal[],
  consumedSignals: readonly BackgroundRunSignal[],
): BackgroundRunSignal[] {
  if (signals.length === 0 || consumedSignals.length === 0) return [...signals];
  const consumedIds = new Set(consumedSignals.map((signal) => signal.id));
  return signals.filter((signal) => !consumedIds.has(signal.id));
}

export function dropSyntheticInternalSignals(
  signals: readonly BackgroundRunSignal[],
): BackgroundRunSignal[] {
  return signals.filter((signal) => {
    const data =
      signal.data && typeof signal.data === "object" && !Array.isArray(signal.data)
        ? signal.data as Record<string, unknown>
        : undefined;
    return data?.syntheticInternal !== true;
  });
}

export function formatSignals(signals: readonly BackgroundRunSignal[]): string | undefined {
  if (signals.length === 0) return undefined;
  return signals
    .map((signal) =>
      `- [${signal.type}] ${truncate(signal.content, 180)}`,
    )
    .join("\n");
}

export function buildInternalToolSignals(params: {
  sessionId: string;
  cycleCount: number;
  actorResult: ChatExecutorResult;
  observedAt: number;
}): BackgroundRunSignal[] {
  const { sessionId, cycleCount, actorResult, observedAt } = params;
  return actorResult.toolCalls.flatMap((toolCall, index) => {
    const signal = buildBackgroundRunSignalFromToolResult({
      sessionId,
      toolName: toolCall.name,
      args: toolCall.args,
      result: toolCall.result,
      durationMs: toolCall.durationMs,
    });
    if (!signal) {
      return [];
    }
    return [{
      id: `internal:${cycleCount}:${index}:${toolCall.name}`,
      type: signal.type,
      content: signal.content,
      timestamp: observedAt,
      data: {
        ...(signal.data ?? {}),
        syntheticInternal: true,
      },
    }];
  });
}

// ---------------------------------------------------------------------------
// Wake event helpers
// ---------------------------------------------------------------------------

export function getWakeEventDomain(
  type: BackgroundRunWakeReason,
): "scheduler" | "operator" | "approval" | "tool" | "process" | "webhook" | "external" {
  switch (type) {
    case "start":
    case "timer":
    case "busy_retry":
    case "recovery":
    case "daemon_shutdown":
      return "scheduler";
    case "user_input":
      return "operator";
    case "approval":
      return "approval";
    case "tool_result":
      return "tool";
    case "process_exit":
      return "process";
    case "webhook":
      return "webhook";
    case "external_event":
      return "external";
  }
}

export function buildWakeDedupeKey(params: {
  sessionId: string;
  runId?: string;
  type: BackgroundRunWakeReason;
  data?: Record<string, unknown>;
}): string | undefined {
  switch (params.type) {
    case "start":
    case "timer":
    case "busy_retry":
    case "recovery":
      return `scheduled:${params.sessionId}:${params.runId ?? "pending"}`;
    case "process_exit": {
      const processId =
        typeof params.data?.processId === "string" ? params.data.processId : undefined;
      const exitCode =
        typeof params.data?.exitCode === "number" ? params.data.exitCode : undefined;
      return processId
        ? `process_exit:${processId}:${exitCode ?? "unknown"}`
        : undefined;
    }
    case "approval": {
      const requestId =
        typeof params.data?.requestId === "string" ? params.data.requestId : undefined;
      return requestId ? `approval:${requestId}` : undefined;
    }
    case "tool_result": {
      const toolCallId =
        typeof params.data?.toolCallId === "string" ? params.data.toolCallId : undefined;
      return toolCallId ? `tool_result:${toolCallId}` : undefined;
    }
    case "webhook": {
      const eventId =
        typeof params.data?.eventId === "string" ? params.data.eventId : undefined;
      return eventId ? `webhook:${eventId}` : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

export function summarizeToolCalls(toolCalls: readonly ChatExecutorResult["toolCalls"][number][]): string {
  if (toolCalls.length === 0) return "No tool calls executed in this cycle.";
  return toolCalls
    .map((toolCall) => {
      const result = sanitizeMemoryText(
        toolCall.result,
        MAX_TOOL_RESULT_PREVIEW_CHARS,
      );
      const state = toolCall.isError ? "error" : "ok";
      return `- ${toolCall.name} [${state}] ${result}`;
    })
    .join("\n");
}

export function extractArtifactRefsFromToolCalls(
  toolCalls: readonly ChatExecutorResult["toolCalls"][number][],
  observedAt: number,
): BackgroundRunArtifactRef[] {
  const artifacts: BackgroundRunArtifactRef[] = [];
  for (const toolCall of toolCalls) {
    const payload = parseToolResultObject(toolCall.result);
    if (!payload) {
      if (/data:image\//i.test(toolCall.result)) {
        artifacts.push({
          kind: "opaque_provider_state",
          locator: `inline:${toolCall.name}:${hashOpaqueValue(toolCall.result)}`,
          label: toolCall.name,
          source: toolCall.name,
          observedAt,
          digest: hashOpaqueValue(toolCall.result),
        });
      }
      continue;
    }

    const candidateEntries: Array<{
      kind: BackgroundRunArtifactRef["kind"];
      locator?: string;
      label?: string;
      digest?: string;
    }> = [
      {
        kind: "file",
        locator:
          typeof payload.filePath === "string"
            ? payload.filePath
            : typeof payload.path === "string"
            ? payload.path
            : typeof payload.artifactPath === "string"
            ? payload.artifactPath
            : undefined,
      },
      {
        kind: "download",
        locator:
          typeof payload.downloadPath === "string"
            ? payload.downloadPath
            : typeof payload.destination === "string"
            ? payload.destination
            : undefined,
        label: typeof payload.filename === "string" ? payload.filename : undefined,
      },
      {
        kind: "url",
        locator: typeof payload.url === "string" ? payload.url : undefined,
        label: typeof payload.title === "string" ? payload.title : undefined,
      },
      {
        kind: "log",
        locator: typeof payload.logPath === "string" ? payload.logPath : undefined,
        label: typeof payload.label === "string" ? payload.label : undefined,
      },
      {
        kind: "process",
        locator:
          typeof payload.processId === "string" ? payload.processId : undefined,
        label: typeof payload.label === "string" ? payload.label : undefined,
      },
    ];

    for (const entry of candidateEntries) {
      if (!entry.locator || entry.locator.trim().length === 0) continue;
      artifacts.push({
        kind: entry.kind,
        locator: entry.locator,
        label: entry.label,
        source: toolCall.name,
        observedAt,
        digest: entry.digest,
      });
    }
  }

  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}:${artifact.locator}:${artifact.source}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function extractProviderCompactionArtifacts(
  actorResult: ChatExecutorResult,
  observedAt: number,
): BackgroundRunArtifactRef[] {
  const artifacts: BackgroundRunArtifactRef[] = [];
  for (const entry of actorResult.callUsage) {
    const latestItem = entry.compactionDiagnostics?.latestItem;
    if (!latestItem) continue;
    artifacts.push({
      kind: "opaque_provider_state",
      locator: `provider:${entry.provider}:compaction:${latestItem.id ?? latestItem.digest}`,
      label: `${entry.provider} compaction item`,
      source: `${entry.provider}:context_management`,
      observedAt,
      digest: latestItem.digest,
    });
  }
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}:${artifact.locator}:${artifact.source}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mergeArtifactRefs(
  previous: readonly BackgroundRunArtifactRef[],
  next: readonly BackgroundRunArtifactRef[],
): BackgroundRunArtifactRef[] {
  const merged = [...previous];
  for (const artifact of next) {
    const existingIndex = merged.findIndex((candidate) =>
      candidate.kind === artifact.kind &&
      candidate.locator === artifact.locator &&
      candidate.source === artifact.source,
    );
    if (existingIndex >= 0) {
      merged[existingIndex] = artifact;
      continue;
    }
    merged.push(artifact);
  }
  return merged.slice(-MAX_MEMORY_ARTIFACTS);
}

export function mergeArtifactsIntoRun(
  run: ActiveBackgroundRun,
  artifacts: readonly BackgroundRunArtifactRef[],
  observedAt: number,
): void {
  if (artifacts.length === 0) {
    return;
  }
  const previous = run.carryForward?.artifacts ?? [];
  const nextArtifacts = mergeArtifactRefs(previous, artifacts);
  run.carryForward = {
    ...(run.carryForward ?? buildEmptyCarryForwardState(observedAt)),
    artifacts: nextArtifacts,
    lastCompactedAt: run.carryForward?.lastCompactedAt ?? observedAt,
  };
}

export function recordToolEvidence(
  run: ActiveBackgroundRun,
  toolCalls: readonly ChatExecutorResult["toolCalls"][number][],
): void {
  if (toolCalls.length === 0) {
    return;
  }
  run.lastToolEvidence = summarizeToolCalls(toolCalls);
  const artifacts = extractArtifactRefsFromToolCalls(toolCalls, run.lastVerifiedAt ?? Date.now());
  mergeArtifactsIntoRun(run, artifacts, run.lastVerifiedAt ?? Date.now());
}

export function recordProviderCompactionArtifacts(
  run: ActiveBackgroundRun,
  actorResult: ChatExecutorResult,
): void {
  mergeArtifactsIntoRun(
    run,
    extractProviderCompactionArtifacts(actorResult, run.lastVerifiedAt ?? Date.now()),
    run.lastVerifiedAt ?? Date.now(),
  );
}

// ---------------------------------------------------------------------------
// Carry-forward state
// ---------------------------------------------------------------------------

export function buildEmptyCarryForwardState(
  now = Date.now(),
): BackgroundRunCarryForwardState {
  return {
    summary: "Task remains active and requires continued supervision.",
    verifiedFacts: [],
    openLoops: [],
    nextFocus: undefined,
    artifacts: [],
    memoryAnchors: [],
    providerContinuation: undefined,
    summaryHealth: {
      status: "healthy",
      driftCount: 0,
    },
    lastCompactedAt: now,
  };
}

export function formatCarryForwardState(
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
  if (carryForward.artifacts.length > 0) {
    parts.push(
      `Artifacts: ${carryForward.artifacts
        .slice(0, 4)
        .map((artifact) =>
          `${artifact.kind}:${truncate(artifact.locator, 64)}`
        )
        .join(" | ")}`,
    );
  }
  if (carryForward.providerContinuation) {
    parts.push(
      `Provider continuation: ${carryForward.providerContinuation.provider}#${carryForward.providerContinuation.responseId}`,
    );
  }
  if (carryForward.summaryHealth.status === "repairing") {
    parts.push(
      `Summary health: repairing (${carryForward.summaryHealth.lastDriftReason ?? "detected drift"})`,
    );
  }
  return parts.join("\n");
}

export function buildFallbackCarryForwardState(params: {
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
  ].slice(0, MAX_MEMORY_FACTS);
  const openLoops = [
    ...truncateList(previous?.openLoops ?? [], 3, 120),
    ...pendingSignals.slice(0, 2).map((signal) => truncate(signal.content, 120)),
  ].slice(0, MAX_MEMORY_OPEN_LOOPS);
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
    artifacts: previous?.artifacts ?? [],
    memoryAnchors: previous?.memoryAnchors ?? [],
    providerContinuation: previous?.providerContinuation,
    summaryHealth: previous?.summaryHealth ?? {
      status: "healthy",
      driftCount: 0,
    },
    lastCompactedAt: now,
  };
}

export function buildMemoryAnchor(
  kind: BackgroundRunMemoryAnchor["kind"],
  reference: string,
  summary: string,
  createdAt: number,
): BackgroundRunMemoryAnchor {
  return {
    kind,
    reference,
    summary: truncate(summary, 160),
    createdAt,
  };
}

export function mergeMemoryAnchors(
  previous: readonly BackgroundRunMemoryAnchor[],
  additions: readonly BackgroundRunMemoryAnchor[],
): BackgroundRunMemoryAnchor[] {
  const merged = [...previous];
  for (const anchor of additions) {
    const existingIndex = merged.findIndex((candidate) =>
      candidate.kind === anchor.kind && candidate.reference === anchor.reference,
    );
    if (existingIndex >= 0) {
      merged[existingIndex] = anchor;
      continue;
    }
    merged.push(anchor);
  }
  return merged.slice(-MAX_MEMORY_ANCHORS);
}

export function extractLatestProviderContinuation(
  actorResult: ChatExecutorResult | undefined,
  now: number,
): BackgroundRunProviderContinuation | undefined {
  if (!actorResult) return undefined;
  const latestUsage = [...actorResult.callUsage]
    .reverse()
    .find((entry) => entry.statefulDiagnostics?.responseId);
  const responseId = latestUsage?.statefulDiagnostics?.responseId;
  if (!latestUsage || !responseId) {
    return undefined;
  }
  return {
    provider: latestUsage.provider,
    responseId,
    reconciliationHash: latestUsage.statefulDiagnostics?.reconciliationHash,
    updatedAt: now,
    mode: "previous_response_id",
  };
}

export function buildCarryForwardAnchors(params: {
  previous: readonly BackgroundRunMemoryAnchor[];
  providerContinuation?: BackgroundRunProviderContinuation;
  pendingSignals: readonly BackgroundRunSignal[];
  actorResult?: ChatExecutorResult;
  now: number;
}): BackgroundRunMemoryAnchor[] {
  const additions: BackgroundRunMemoryAnchor[] = [];
  if (params.providerContinuation) {
    additions.push(
      buildMemoryAnchor(
        "provider_response",
        params.providerContinuation.responseId,
        `${params.providerContinuation.provider} previous_response_id anchor`,
        params.providerContinuation.updatedAt,
      ),
    );
  }
  const signalAnchor = params.pendingSignals[0];
  if (signalAnchor) {
    additions.push(
      buildMemoryAnchor(
        "event",
        signalAnchor.id,
        signalAnchor.content,
        signalAnchor.timestamp,
      ),
    );
  }
  if (params.actorResult?.content) {
    additions.push(
      buildMemoryAnchor(
        "progress",
        `cycle:${params.now}`,
        params.actorResult.content,
        params.now,
      ),
    );
  }
  return mergeMemoryAnchors(params.previous, additions);
}

export function deriveCarryForwardRefreshReason(params: {
  run: ActiveBackgroundRun;
  actorResult?: ChatExecutorResult;
  force?: boolean;
  pendingSignals: readonly BackgroundRunSignal[];
}): CarryForwardRefreshReason | undefined {
  if (params.force === true) {
    return "forced";
  }
  if (!params.run.carryForward) {
    return "milestone";
  }
  if (params.pendingSignals.length > 0) {
    return "milestone";
  }
  if (params.actorResult?.toolCalls.some((toolCall) => !toolCall.isError)) {
    return "milestone";
  }
  if (params.run.internalHistory.length >= HISTORY_COMPACTION_THRESHOLD) {
    return "history_threshold";
  }
  return undefined;
}

export function detectCarryForwardDrift(params: {
  candidate: BackgroundRunCarryForwardState;
  actorResult?: ChatExecutorResult;
  previous?: BackgroundRunCarryForwardState;
}): string | undefined {
  const corpus = [
    params.candidate.summary,
    ...params.candidate.verifiedFacts,
    ...params.candidate.openLoops,
    params.candidate.nextFocus ?? "",
  ].join("\n");
  if (/data:image\/|[A-Za-z0-9+/=\r\n]{512,}/.test(corpus)) {
    return "carry_forward_contains_binary_payload";
  }

  const actorResult = params.actorResult;
  if (!actorResult) {
    return undefined;
  }

  const onlyToolErrors =
    actorResult.toolCalls.length > 0 &&
    actorResult.toolCalls.every((toolCall) => toolCall.isError);
  if (
    onlyToolErrors &&
    /\b(succeeded|completed|finished|generated|downloaded|uploaded|deployed|ready)\b/i.test(
      corpus,
    )
  ) {
    return "carry_forward_claims_success_after_error_cycle";
  }

  const previousSummary = params.previous?.summary?.trim();
  if (
    previousSummary &&
    previousSummary === params.candidate.summary.trim() &&
    actorResult.toolCalls.some((toolCall) => !toolCall.isError)
  ) {
    return "carry_forward_failed_to_refresh_after_new_evidence";
  }

  return undefined;
}

export function repairCarryForwardState(params: {
  previous?: BackgroundRunCarryForwardState;
  latestUpdate?: string;
  latestToolEvidence?: string;
  pendingSignals: readonly BackgroundRunSignal[];
  actorResult?: ChatExecutorResult;
  now: number;
  reason: string;
  providerContinuation?: BackgroundRunProviderContinuation;
}): BackgroundRunCarryForwardState {
  const repaired = buildFallbackCarryForwardState({
    previous: params.previous,
    latestUpdate: params.latestUpdate,
    latestToolEvidence: params.latestToolEvidence,
    pendingSignals: params.pendingSignals,
    now: params.now,
  });
  return {
    ...repaired,
    artifacts: params.previous?.artifacts ?? [],
    memoryAnchors: buildCarryForwardAnchors({
      previous: params.previous?.memoryAnchors ?? [],
      providerContinuation: params.providerContinuation ?? params.previous?.providerContinuation,
      pendingSignals: params.pendingSignals,
      actorResult: params.actorResult,
      now: params.now,
    }),
    providerContinuation:
      params.providerContinuation ?? params.previous?.providerContinuation,
    summaryHealth: {
      status: "repairing",
      driftCount: (params.previous?.summaryHealth.driftCount ?? 0) + 1,
      lastDriftAt: params.now,
      lastRepairAt: params.now,
      lastDriftReason: params.reason,
    },
  };
}

export function parseCarryForwardState(
  text: string,
  now: number,
): BackgroundRunCarryForwardState | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.summary !== "string") return undefined;
    const verifiedFacts = normalizeStringArray(parsed.verifiedFacts)
      .slice(0, MAX_MEMORY_FACTS)
      .map((item) => sanitizeMemoryText(item, 120));
    const openLoops = normalizeStringArray(parsed.openLoops)
      .slice(0, MAX_MEMORY_OPEN_LOOPS)
      .map((item) => sanitizeMemoryText(item, 120));
    return {
      summary: sanitizeMemoryText(parsed.summary, 240),
      verifiedFacts,
      openLoops,
      nextFocus:
        typeof parsed.nextFocus === "string"
          ? sanitizeMemoryText(parsed.nextFocus, 120)
          : undefined,
      artifacts: [],
      memoryAnchors: [],
      providerContinuation: undefined,
      summaryHealth: {
        status: "healthy",
        driftCount: 0,
      },
      lastCompactedAt: now,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Run state utilities
// ---------------------------------------------------------------------------

export function sanitizeWorkerPools(
  pools: readonly BackgroundRunWorkerPool[] | undefined,
): readonly BackgroundRunWorkerPool[] {
  const defaults: readonly BackgroundRunWorkerPool[] = [
    "generic",
    "browser",
    "desktop",
    "code",
    "research",
    "approval",
    "remote_mcp",
  ];
  const normalized = [...new Set<BackgroundRunWorkerPool>(pools ?? defaults)];
  return normalized;
}

export function buildInitialBudgetState(
  contract: BackgroundRunContract,
  now: number,
): BackgroundRunBudgetState {
  return {
    runtimeStartedAt: now,
    lastActivityAt: now,
    lastProgressAt: now,
    totalTokens: 0,
    lastCycleTokens: 0,
    managedProcessCount: 0,
    maxRuntimeMs: DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
    maxCycles: deriveDefaultBackgroundRunMaxCycles({
      maxRuntimeMs: DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
      nextCheckMs: contract.nextCheckMs,
    }),
    maxIdleMs: contract.requiresUserStop ? undefined : DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
    nextCheckIntervalMs: contract.nextCheckMs,
    heartbeatIntervalMs: contract.heartbeatMs,
  };
}

export function buildInitialCompactionState(): BackgroundRunCompactionState {
  return {
    lastCompactedAt: undefined,
    lastCompactedCycle: 0,
    refreshCount: 0,
    lastHistoryLength: 0,
    lastMilestoneAt: undefined,
    lastCompactionReason: undefined,
    repairCount: 0,
    lastProviderAnchorAt: undefined,
  };
}

export function recordRunActivity(
  run: ActiveBackgroundRun,
  now: number,
  kind: "activity" | "progress" = "activity",
): void {
  run.budgetState = {
    ...run.budgetState,
    lastActivityAt: now,
    lastProgressAt:
      kind === "progress" ? now : run.budgetState.lastProgressAt,
    nextCheckIntervalMs: run.contract.nextCheckMs,
    heartbeatIntervalMs: run.contract.heartbeatMs,
  };
}

export function countRunningManagedProcesses(
  observedTargets: readonly BackgroundRunObservedTarget[],
): number {
  return observedTargets.reduce((count, target) => {
    return count +
      (target.kind === "managed_process" && target.currentState === "running"
        ? 1
        : 0);
  }, 0);
}

export function refreshDerivedBudgetState(run: ActiveBackgroundRun): void {
  run.budgetState = {
    ...run.budgetState,
    managedProcessCount: countRunningManagedProcesses(run.observedTargets),
  };
}

export function clearRunBlockers(run: ActiveBackgroundRun): void {
  run.blocker = undefined;
  run.approvalState = { status: "none" };
}

export function resolveWorkerPool(
  run: {
    readonly contract: ActiveBackgroundRun["contract"];
    readonly observedTargets: readonly BackgroundRunObservedTarget[];
  },
): BackgroundRunWorkerPool {
  switch (run.contract.domain) {
    case "browser":
      return "browser";
    case "desktop_gui":
      return "desktop";
    case "workspace":
    case "pipeline":
      return "code";
    case "research":
      return "research";
    case "approval":
      return "approval";
    case "remote_mcp":
      return "remote_mcp";
    case "managed_process": {
      const desktopObserved = run.observedTargets.some(
        (target) => target.kind === "managed_process" && target.surface === "desktop",
      );
      return desktopObserved ? "desktop" : "generic";
    }
    case "generic":
      return "generic";
  }
}

export function resolveWorkerAffinityKey(
  run: {
    readonly sessionId: string;
    readonly workerAffinityKey?: string;
    readonly observedTargets: readonly BackgroundRunObservedTarget[];
    readonly contract: ActiveBackgroundRun["contract"];
  },
): string {
  if (run.workerAffinityKey) {
    return run.workerAffinityKey;
  }
  const observedManagedProcess = run.observedTargets.find(
    (target) => target.kind === "managed_process",
  );
  if (observedManagedProcess?.kind === "managed_process") {
    if (observedManagedProcess.surface === "desktop") {
      return `desktop:${observedManagedProcess.processId}`;
    }
    return `process:${observedManagedProcess.processId}`;
  }
  if (run.contract.domain === "workspace" || run.contract.domain === "pipeline") {
    return `workspace:${run.sessionId}`;
  }
  return `session:${run.sessionId}`;
}

export function getScopedAllowedTools(
  run: ActiveBackgroundRun,
): readonly string[] | undefined {
  const tools = run.lineage?.scope.allowedTools;
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return [...new Set(tools.filter((tool: string) => tool.trim().length > 0))];
}

export function applyRunToolScopeDecision(params: {
  readonly allowedTools: readonly string[] | undefined;
  readonly toolRoutingDecision: ToolRoutingDecision | undefined;
}): {
  readonly routedToolNames: readonly string[];
  readonly expandedToolNames: readonly string[];
} | undefined {
  const { allowedTools, toolRoutingDecision } = params;
  if (!allowedTools || allowedTools.length === 0) {
    return toolRoutingDecision
      ? {
        routedToolNames: toolRoutingDecision.routedToolNames,
        expandedToolNames: toolRoutingDecision.expandedToolNames,
      }
      : undefined;
  }
  if (!toolRoutingDecision) {
    return {
      routedToolNames: allowedTools,
      expandedToolNames: allowedTools,
    };
  }
  const allowed = new Set(allowedTools);
  const routed = toolRoutingDecision.routedToolNames.filter((tool) => allowed.has(tool));
  const expanded = toolRoutingDecision.expandedToolNames.filter((tool) => allowed.has(tool));
  const routedToolNames = routed.length > 0 ? routed : allowedTools;
  const expandedToolNames = expanded.length > 0 ? expanded : routedToolNames;
  return {
    routedToolNames,
    expandedToolNames,
  };
}

// ---------------------------------------------------------------------------
// Blocker state
// ---------------------------------------------------------------------------

export function buildBlockerState(
  decision: BackgroundRunDecision,
  now: number,
): {
  blocker: BackgroundRunBlockerState;
  approvalState: BackgroundRunApprovalState;
} {
  const corpus = `${decision.userUpdate}\n${decision.internalSummary}`.toLowerCase();
  const requiresApproval = /\bapprove|approval|authorization|authorize\b/.test(corpus);
  const needsOperatorInput =
    requiresApproval ||
    /\b(user input|instruction|tell me|give a new instruction|waiting for you)\b/.test(corpus);
  const code: BackgroundRunBlockerState["code"] = requiresApproval
    ? "approval_required"
    : /\brestart\b.*\bfailed|tool\b.*\bfail/.test(corpus)
      ? "tool_failure"
      : /\bprocess\b.*\bexited/.test(corpus)
        ? "managed_process_exit"
        : needsOperatorInput
          ? "operator_input_required"
          : "missing_prerequisite";
  const blocker: BackgroundRunBlockerState = {
    code,
    summary: decision.userUpdate,
    details: decision.internalSummary,
    since: now,
    requiresOperatorAction: needsOperatorInput,
    requiresApproval,
    retryable: decision.state !== "failed",
  };
  return {
    blocker,
    approvalState: requiresApproval
      ? {
          status: "waiting",
          requestedAt: now,
          summary: decision.userUpdate,
        }
      : { status: "none" },
  };
}

// ---------------------------------------------------------------------------
// Decision building
// ---------------------------------------------------------------------------

export function shouldTreatStopReasonAsBoundedStep(
  actorResult: ChatExecutorResult,
): boolean {
  if (!actorResult.toolCalls.some((toolCall) => !toolCall.isError)) return false;
  return (
    actorResult.stopReason === "budget_exceeded" ||
    actorResult.stopReason === "tool_calls"
  );
}

export function buildFallbackDecision(run: ActiveBackgroundRun, actorResult: ChatExecutorResult): BackgroundRunDecision {
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

export function groundDecision(
  run: ActiveBackgroundRun,
  actorResult: ChatExecutorResult,
  decision: BackgroundRunDecision,
  domainDecision?: BackgroundRunDecision,
): BackgroundRunDecision {
  if (domainDecision?.state === "working") {
    if (decision.state !== "working") {
      return domainDecision;
    }
    const normalizedActorContent = truncate(
      actorResult.content || "",
      MAX_USER_UPDATE_CHARS,
    );
    if (
      normalizedActorContent.length > 0 &&
      decision.userUpdate === normalizedActorContent
    ) {
      return domainDecision;
    }
  }

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

export function computeConsecutiveErrorCycles(
  run: ActiveBackgroundRun,
  actorResult: ChatExecutorResult,
): number {
  if (actorResult.toolCalls.length === 0) return 0;
  const allFailed = actorResult.toolCalls.every((toolCall) => toolCall.isError);
  return allFailed ? run.consecutiveErrorCycles + 1 : 0;
}

export function applyRepeatedErrorGuard(
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

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDecisionPrompt(params: {
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

export function buildContractPrompt(objective: string): string {
  return (
    `User objective:\n${objective}\n\n` +
    "Return JSON only in this shape:\n" +
    '{"domain":"generic|managed_process|approval|browser|desktop_gui|workspace|research|pipeline|remote_mcp","kind":"finite|until_condition|until_stopped","successCriteria":["..."],"completionCriteria":["..."],"blockedCriteria":["..."],"nextCheckMs":8000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"none|until_exit|keep_running|restart_on_exit","maxRestarts":5,"restartBackoffMs":5000}}\n\n' +
    "Rules:\n" +
    "- Choose the domain that best matches the primary runtime surface being supervised.\n" +
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

export function buildCarryForwardPrompt(params: {
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
    "- Do not invent artifact paths, URLs, or provider checkpoint IDs.\n" +
    "- Include open loops that still require supervision.\n" +
    "- Include operator/user signals when they change the next step.\n" +
    "- Keep summary under 240 chars and each list item under 120 chars.\n"
  );
}

// ---------------------------------------------------------------------------
// Contract parsing
// ---------------------------------------------------------------------------

export function normalizeManagedProcessPolicyMode(
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

export function parseDecision(text: string): BackgroundRunDecision | undefined {
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

export function parseContract(
  text: string,
  objective?: string,
): BackgroundRunContract | undefined {
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
    const successCriteria = normalizeList(
      parsed.successCriteria,
      "Make forward progress on the objective with verified evidence.",
    );
    const completionCriteria = normalizeList(
      parsed.completionCriteria,
      "Only complete once the environment confirms the objective is satisfied.",
    );
    const blockedCriteria = normalizeList(
      parsed.blockedCriteria,
      "Block when required tools, permissions, or external preconditions are missing.",
    );
    const requiresUserStop =
      typeof parsed.requiresUserStop === "boolean"
        ? parsed.requiresUserStop
        : kind === "until_stopped";
    const normalizedManagedProcessPolicy =
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
        : undefined;
    const inferredDomain = inferAgentRunDomain({
      objective,
      successCriteria,
      completionCriteria,
      blockedCriteria,
      requiresUserStop,
      managedProcessPolicy: normalizedManagedProcessPolicy,
    });
    return {
      domain:
        inferredDomain !== "generic"
          ? inferredDomain
          : isAgentRunDomain(parsed.domain)
          ? parsed.domain
          : inferredDomain,
      kind,
      successCriteria,
      completionCriteria,
      blockedCriteria,
      nextCheckMs,
      heartbeatMs,
      requiresUserStop,
      managedProcessPolicy: normalizedManagedProcessPolicy,
    };
  } catch {
    return undefined;
  }
}

export function buildFallbackContract(objective: string): BackgroundRunContract {
  const untilStopped = UNTIL_STOP_RE.test(objective);
  const continuous = CONTINUOUS_RE.test(objective) || BACKGROUND_RE.test(objective);
  const managedProcessPolicyMode = inferManagedProcessPolicyMode(objective);
  const successCriteria = [
    "Use tools to make measurable progress and verify the result.",
  ];
  const completionCriteria = [
    untilStopped
      ? "Do not complete until the user explicitly stops the run."
      : "Only complete once tool evidence shows the objective is satisfied.",
  ];
  const blockedCriteria = [
    "Block when required approvals, credentials, or external preconditions are missing.",
  ];
  const managedProcessPolicy =
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
      : undefined;
  return {
    domain: inferAgentRunDomain({
      objective,
      successCriteria,
      completionCriteria,
      blockedCriteria,
      requiresUserStop: untilStopped,
      managedProcessPolicy,
    }),
    kind: untilStopped
      ? "until_stopped"
      : continuous
        ? "until_condition"
        : "finite",
    successCriteria,
    completionCriteria,
    blockedCriteria,
    nextCheckMs: DEFAULT_POLL_INTERVAL_MS,
    heartbeatMs: continuous ? HEARTBEAT_MIN_DELAY_MS : undefined,
    requiresUserStop: untilStopped,
    managedProcessPolicy,
  };
}

export function inferManagedProcessPolicyMode(objective: string): "none" | "until_exit" | "keep_running" | "restart_on_exit" {
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

// buildHeartbeatMessage, buildActiveCycleHeartbeatMessage, and buildActorPrompt
// remain in background-run-supervisor.ts because they depend on getRunDomain
// which lives in the managed-process module, and moving them here would create
// a circular dependency.

export function formatObservedTargets(
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

// ---------------------------------------------------------------------------
// Trace helpers
// ---------------------------------------------------------------------------

export function buildBackgroundRunTraceIds(
  run: Pick<ActiveBackgroundRun, "id" | "cycleCount">,
  name: string,
): { traceId: string; spanId: string } {
  const traceId = createHash("sha256")
    .update(`background-run:${run.id}`)
    .digest("hex")
    .slice(0, 32);
  const spanId = createHash("sha256")
    .update(`background-run:${run.id}:${run.cycleCount}:${name}`)
    .digest("hex")
    .slice(0, 16);
  return { traceId, spanId };
}

// ---------------------------------------------------------------------------
// Operator summary
// ---------------------------------------------------------------------------

export function toOperatorSummary(params: {
  snapshot: BackgroundRunRecentSnapshot;
  contract?: BackgroundRunContract;
  blocker?: BackgroundRunBlockerState;
  approvalState?: BackgroundRunApprovalState;
  checkpointAvailable: boolean;
  now?: number;
}): BackgroundRunOperatorSummary {
  const explanation = buildBackgroundRunExplanation({
    state: params.snapshot.state,
    blocker: params.blocker,
    approval: params.approvalState ?? { status: "none" },
    nextCheckAt: params.snapshot.nextCheckAt,
    nextHeartbeatAt: params.snapshot.nextHeartbeatAt,
    lastWakeReason: params.snapshot.lastWakeReason,
    requiresUserStop:
      params.contract?.requiresUserStop ?? params.snapshot.requiresUserStop,
    now: params.now,
  });

  return {
    runId: params.snapshot.runId,
    sessionId: params.snapshot.sessionId,
    objective: params.snapshot.objective,
    state: params.snapshot.state,
    currentPhase: explanation.currentPhase,
    explanation: explanation.explanation,
    unsafeToContinue: explanation.unsafeToContinue,
    createdAt: params.snapshot.createdAt,
    updatedAt: params.snapshot.updatedAt,
    lastVerifiedAt: params.snapshot.lastVerifiedAt,
    nextCheckAt: params.snapshot.nextCheckAt,
    nextHeartbeatAt: params.snapshot.nextHeartbeatAt,
    cycleCount: params.snapshot.cycleCount,
    contractKind: params.snapshot.contractKind,
    contractDomain: params.contract?.domain ?? "generic",
    requiresUserStop:
      params.contract?.requiresUserStop ?? params.snapshot.requiresUserStop,
    pendingSignals: params.snapshot.pendingSignals,
    watchCount: params.snapshot.watchCount,
    fenceToken: params.snapshot.fenceToken,
    lastUserUpdate: params.snapshot.lastUserUpdate,
    lastToolEvidence: params.snapshot.lastToolEvidence,
    lastWakeReason: params.snapshot.lastWakeReason,
    carryForwardSummary: params.snapshot.carryForwardSummary,
    blockerSummary: params.snapshot.blockerSummary,
    approvalRequired:
      params.approvalState?.status === "waiting" ||
      params.blocker?.requiresApproval === true,
    approvalState: params.approvalState?.status ?? "none",
    preferredWorkerId: params.snapshot.preferredWorkerId,
    workerAffinityKey: params.snapshot.workerAffinityKey,
    checkpointAvailable: params.checkpointAvailable,
  };
}

// resolveRunNextCheckClampMaxMs and chooseNextCheckMs remain in
// background-run-supervisor.ts because they depend on getRunDomain.
