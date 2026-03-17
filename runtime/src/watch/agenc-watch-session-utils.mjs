/**
 * Session, model route, and transport error classification utilities
 * for the watch TUI.
 *
 * Pure functions — no watch state or side-effect dependencies.
 */

import { sanitizeInlineText } from "./agenc-watch-text-utils.mjs";

export function normalizeSessionValue(value) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return null;
  }
  return text.replace(/^session:/, "");
}

export function sessionValuesMatch(left, right) {
  const normalizedLeft = normalizeSessionValue(left);
  const normalizedRight = normalizeSessionValue(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft === normalizedRight,
  );
}

export function normalizeModelRoute(input = {}, nowMs) {
  const provider = sanitizeInlineText(
    input.provider ??
      input.llmProvider ??
      "",
  );
  const model = sanitizeInlineText(
    input.model ??
      input.llmModel ??
      "",
  );
  if (!provider && !model) {
    return null;
  }
  return {
    provider: provider || "unknown",
    model: model || "unknown",
    usedFallback: input.usedFallback === true,
    updatedAt: Number.isFinite(Number(input.updatedAt))
      ? Number(input.updatedAt)
      : nowMs(),
  };
}

export function formatModelRouteLabel(route, { includeProvider = true } = {}) {
  if (!route) {
    return "routing pending";
  }
  const provider = sanitizeInlineText(route.provider ?? "");
  const model = sanitizeInlineText(route.model ?? "");
  const parts = [];
  if (model) {
    parts.push(model);
  }
  if (includeProvider && provider) {
    parts.push(`via ${provider}`);
  }
  if (route.usedFallback) {
    parts.push("fallback");
  }
  return parts.join(" ").trim() || "routing pending";
}

export function modelRouteTone(route, hasLiveRoute) {
  if (!route) return "slate";
  if (route.usedFallback) return "amber";
  return hasLiveRoute ? "teal" : "slate";
}

export function shouldSurfaceTransientStatus(value) {
  const text = sanitizeInlineText(value ?? "");
  return Boolean(
    text &&
    !/^agent reply received$/i.test(text) &&
    !/^gateway status loaded$/i.test(text) &&
    !/^history restored:/i.test(text) &&
    !/^session ready:/i.test(text) &&
    !/^run inspect loaded:/i.test(text),
  );
}

export function isExpectedMissingRunInspect(errorText, errorPayload) {
  if (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    errorPayload.code === "background_run_missing"
  ) {
    return true;
  }
  return (
    typeof errorText === "string" &&
    (
      (
        errorText.includes("Background run") &&
        errorText.includes("not found")
      ) ||
      errorText.includes("No active durable background run")
    )
  );
}

export function isUnavailableBackgroundRunInspect(errorPayload) {
  return (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    errorPayload.code === "background_run_unavailable"
  );
}

export function isRetryableBootstrapError(errorText) {
  return (
    typeof errorText === "string" &&
    (
      errorText === "Unknown message type: chat.new" ||
      errorText === "Unknown message type: chat.sessions" ||
      errorText === "Unknown message type: chat.resume"
    )
  );
}

export function buildSurfaceSummaryCacheKey(input = {}) {
  return JSON.stringify({
    connectionState: input.connectionState ?? null,
    phaseLabel: input.phaseLabel ?? null,
    routeProvider: input.route?.provider ?? null,
    routeModel: input.route?.model ?? null,
    routeFallback: input.route?.usedFallback === true,
    durableRunsEnabled:
      typeof input.backgroundRunStatus?.enabled === "boolean"
        ? input.backgroundRunStatus.enabled
        : null,
    durableOperatorAvailable:
      typeof input.backgroundRunStatus?.operatorAvailable === "boolean"
        ? input.backgroundRunStatus.operatorAvailable
        : null,
    durableDisabledCode:
      typeof input.backgroundRunStatus?.disabledCode === "string"
        ? input.backgroundRunStatus.disabledCode
        : null,
    durableActiveTotal: Number.isFinite(Number(input.backgroundRunStatus?.activeTotal))
      ? Number(input.backgroundRunStatus.activeTotal)
      : null,
    durableQueuedSignalsTotal: Number.isFinite(Number(input.backgroundRunStatus?.queuedSignalsTotal))
      ? Number(input.backgroundRunStatus.queuedSignalsTotal)
      : null,
    runtimeState: typeof input.runtimeStatus?.state === "string"
      ? input.runtimeStatus.state
      : null,
    objective: input.objective ?? null,
    usage: input.lastUsageSummary ?? null,
    latestTool: input.latestTool ?? null,
    latestToolState: input.latestToolState ?? null,
    queuedInputs: Number.isFinite(Number(input.queuedInputCount)) ? Number(input.queuedInputCount) : 0,
    eventsLength: Number.isFinite(Number(input.eventsLength)) ? Number(input.eventsLength) : 0,
    lastEventId: input.lastEventId ?? null,
    planCount: Number.isFinite(Number(input.planCount)) ? Number(input.planCount) : 0,
    activeAgentCount: Number.isFinite(Number(input.activeAgentCount)) ? Number(input.activeAgentCount) : 0,
    activeAgentLabel: input.activeAgentLabel ?? null,
    activeAgentActivity: input.activeAgentActivity ?? null,
    plannerStatus: input.plannerStatus ?? null,
    plannerNote: input.plannerNote ?? null,
    sessionId: input.sessionId ?? null,
    following: input.following === true,
    detailOpen: input.detailOpen === true,
    transcriptScrollOffset: Number.isFinite(Number(input.transcriptScrollOffset))
      ? Number(input.transcriptScrollOffset)
      : 0,
    lastActivityAt: input.lastActivityAt ?? null,
  });
}

export function latestSessionSummary(
  payload,
  preferredSessionId = null,
  preferredWorkspaceRoot = null,
) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const sameWorkspaceSessions =
    typeof preferredWorkspaceRoot === "string" && preferredWorkspaceRoot
      ? payload.filter(
          (session) => session?.workspaceRoot === preferredWorkspaceRoot,
        )
      : payload;
  if (preferredSessionId) {
    const preferred = sameWorkspaceSessions.find(
      (session) => session?.sessionId === preferredSessionId,
    );
    if (preferred && Number(preferred?.messageCount ?? 0) > 0) {
      return preferred;
    }
  }
  const candidateSessions =
    sameWorkspaceSessions.length > 0 ? sameWorkspaceSessions : payload;
  return [...candidateSessions].sort((left, right) => {
    const leftMessageCount = Number(left?.messageCount ?? 0);
    const rightMessageCount = Number(right?.messageCount ?? 0);
    const leftHasMessages = leftMessageCount > 0 ? 1 : 0;
    const rightHasMessages = rightMessageCount > 0 ? 1 : 0;
    if (leftHasMessages !== rightHasMessages) {
      return rightHasMessages - leftHasMessages;
    }
    const leftTime = Number(left?.lastActiveAt ?? 0);
    const rightTime = Number(right?.lastActiveAt ?? 0);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return rightMessageCount - leftMessageCount;
  })[0] ?? null;
}
