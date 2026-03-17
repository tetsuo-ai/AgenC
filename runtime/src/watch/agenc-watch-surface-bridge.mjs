const REQUIRED_STATE_KEYS = Object.freeze([
  "sessionId",
  "ownerToken",
  "sessionAttachedAtMs",
  "runDetail",
  "runState",
  "runPhase",
  "bootstrapReady",
  "manualSessionsRequestPending",
  "manualHistoryRequestPending",
  "currentObjective",
  "activeRunStartedAtMs",
  "latestAgentSummary",
  "latestTool",
  "latestToolState",
  "runInspectPending",
  "lastUsageSummary",
  "liveSessionModelRoute",
  "lastStatus",
  "configuredModelRoute",
  "manualStatusRequestPending",
  "lastStatusFeedFingerprint",
]);

const REQUIRED_HELPER_KEYS = Object.freeze([
  "now",
  "setTransientStatus",
  "persistSessionId",
  "persistOwnerToken",
  "resetLiveRunSurface",
  "markBootstrapReady",
  "clearBootstrapTimer",
  "send",
  "authPayload",
  "requestRunInspect",
  "eventStore",
  "formatSessionSummaries",
  "latestSessionSummary",
  "formatHistoryPayload",
  "shouldAutoInspectRun",
  "sanitizeInlineText",
  "truncate",
  "summarizeUsage",
  "normalizeModelRoute",
  "describeToolStart",
  "shouldSuppressToolTranscript",
  "shouldSuppressToolActivity",
  "handleToolResult",
  "tryPrettyJson",
  "formatLogPayload",
  "formatStatusPayload",
  "statusFeedFingerprint",
  "handlePlannerTraceEvent",
  "handleSubagentLifecycleMessage",
  "hydratePlannerDagFromTraceArtifacts",
  "isExpectedMissingRunInspect",
  "isUnavailableBackgroundRunInspect",
  "isRetryableBootstrapError",
  "scheduleBootstrap",
]);

function assertStateBinding(key, binding) {
  if (!binding || typeof binding !== "object") {
    throw new TypeError(`Missing required watch surface state binding: ${key}`);
  }
  if (typeof binding.get !== "function" || typeof binding.set !== "function") {
    throw new TypeError(
      `Invalid watch surface state binding for ${key}; expected { get, set } functions`,
    );
  }
}

function assertHelperBinding(key, helpers) {
  if (!(key in helpers)) {
    throw new TypeError(`Missing required watch surface helper: ${key}`);
  }
}

function assertEventStoreBinding(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Missing required watch surface helper: eventStore");
  }
  const requiredMethods = [
    "pushEvent",
    "appendAgentStreamChunk",
    "commitAgentMessage",
    "cancelAgentStream",
    "restoreTranscriptFromHistory",
    "clearLiveTranscriptView",
    "replaceLatestToolEvent",
    "replaceLatestSubagentToolEvent",
    "clearSubagentHeartbeatEvents",
  ];
  for (const method of requiredMethods) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`Invalid watch surface eventStore; missing ${method}()`);
    }
  }
}

export function bindWatchSurfaceState(get, set) {
  if (typeof get !== "function" || typeof set !== "function") {
    throw new TypeError("bindWatchSurfaceState expects getter and setter functions");
  }
  return { get, set };
}

export function createWatchSurfaceDispatchBridge({ stateBindings, helpers }) {
  const state = {};

  for (const key of REQUIRED_STATE_KEYS) {
    const binding = stateBindings?.[key];
    assertStateBinding(key, binding);
    Object.defineProperty(state, key, {
      enumerable: true,
      configurable: false,
      get: binding.get,
      set: binding.set,
    });
  }

  for (const key of REQUIRED_HELPER_KEYS) {
    assertHelperBinding(key, helpers ?? {});
  }
  assertEventStoreBinding(helpers?.eventStore);

  return {
    state,
    api: {
      state,
      ...helpers,
    },
  };
}

export { REQUIRED_HELPER_KEYS, REQUIRED_STATE_KEYS };
