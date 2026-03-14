export const WATCH_STATE_PRIMITIVE_KEYS = Object.freeze([
  "sessionId",
  "runState",
  "runPhase",
  "connectionState",
  "latestTool",
  "latestToolState",
  "latestAgentSummary",
  "currentObjective",
  "runDetail",
  "activeRunStartedAtMs",
  "runInspectPending",
  "bootstrapAttempts",
  "bootstrapReady",
  "introDismissed",
  "sessionAttachedAtMs",
  "transientStatus",
  "lastStatus",
  "lastUsageSummary",
  "lastActivityAt",
  "configuredModelRoute",
  "liveSessionModelRoute",
  "ownerToken",
  "manualStatusRequestPending",
  "lastStatusFeedFingerprint",
  "manualSessionsRequestPending",
  "manualHistoryRequestPending",
  "expandedEventId",
  "composerInput",
  "composerCursor",
  "composerHistory",
  "composerHistoryIndex",
  "composerHistoryDraft",
  "transcriptScrollOffset",
  "transcriptFollowMode",
  "detailScrollOffset",
  "planStepSequence",
  "plannerDagPipelineId",
  "plannerDagStatus",
  "plannerDagNote",
  "plannerDagUpdatedAt",
  "plannerDagHydratedSessionId",
]);

const DEFAULT_BOUND_STATE_KEYS = Object.freeze([
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

function normalizeStoredValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function subagentToolKey(subagentSessionId, toolName) {
  const session = normalizeStoredValue(subagentSessionId);
  const tool = normalizeStoredValue(toolName);
  return session && tool ? `${session}::${tool}` : null;
}

export function loadPersistedWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
}) {
  try {
    const raw = fs.readFileSync(watchStateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.clientKey === clientKey) {
      return {
        ownerToken: normalizeStoredValue(parsed.ownerToken),
        sessionId: normalizeStoredValue(parsed.sessionId),
      };
    }
  } catch {}
  return { ownerToken: null, sessionId: null };
}

export function persistWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
  ownerToken,
  sessionId,
}) {
  try {
    fs.mkdirSync(path.dirname(watchStateFile), { recursive: true });
    fs.writeFileSync(
      watchStateFile,
      `${JSON.stringify(
        {
          clientKey,
          ownerToken: normalizeStoredValue(ownerToken),
          sessionId: normalizeStoredValue(sessionId),
          updatedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {}
}

export function createWatchState({
  persistedWatchState = {},
  launchedAtMs = Date.now(),
} = {}) {
  return {
    sessionId: normalizeStoredValue(persistedWatchState.sessionId),
    runState: "idle",
    runPhase: null,
    connectionState: "connecting",
    latestTool: null,
    latestToolState: null,
    latestAgentSummary: null,
    currentObjective: null,
    runDetail: null,
    activeRunStartedAtMs: null,
    runInspectPending: false,
    bootstrapAttempts: 0,
    bootstrapReady: false,
    introDismissed: false,
    sessionAttachedAtMs: launchedAtMs,
    transientStatus: "Booting watch client…",
    lastStatus: null,
    lastUsageSummary: null,
    lastActivityAt: null,
    configuredModelRoute: null,
    liveSessionModelRoute: null,
    ownerToken: normalizeStoredValue(persistedWatchState.ownerToken),
    manualStatusRequestPending: false,
    lastStatusFeedFingerprint: null,
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
    expandedEventId: null,
    composerInput: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    composerHistoryDraft: "",
    transcriptScrollOffset: 0,
    transcriptFollowMode: true,
    detailScrollOffset: 0,
    planStepSequence: 0,
    queuedOperatorInputs: [],
    subagentPlanSteps: new Map(),
    subagentSessionPlanKeys: new Map(),
    subagentLiveActivity: new Map(),
    recentSubagentLifecycleFingerprints: new Map(),
    subagentToolArgs: new Map(),
    plannerDagNodes: new Map(),
    plannerDagEdges: [],
    plannerDagPipelineId: null,
    plannerDagStatus: "idle",
    plannerDagNote: null,
    plannerDagUpdatedAt: 0,
    plannerDagHydratedSessionId: null,
    events: [],
  };
}

export function createWatchStateBindings({
  state,
  bindState,
  keys = DEFAULT_BOUND_STATE_KEYS,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("createWatchStateBindings requires a state object");
  }
  if (typeof bindState !== "function") {
    throw new TypeError("createWatchStateBindings requires a bindState function");
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      bindState(
        () => state[key],
        (value) => {
          state[key] = value;
        },
      ),
    ]),
  );
}

export function rememberSubagentToolArgs(state, subagentSessionId, toolName, args) {
  const key = subagentToolKey(subagentSessionId, toolName);
  if (!key || args === undefined) {
    return;
  }
  state.subagentToolArgs.set(key, args);
}

export function readSubagentToolArgs(state, subagentSessionId, toolName) {
  const key = subagentToolKey(subagentSessionId, toolName);
  return key ? state.subagentToolArgs.get(key) : undefined;
}

export function clearSubagentToolArgs(state, subagentSessionId, toolName = null) {
  const session = normalizeStoredValue(subagentSessionId);
  if (!session) {
    return;
  }
  if (toolName) {
    const key = subagentToolKey(session, toolName);
    if (key) {
      state.subagentToolArgs.delete(key);
    }
    return;
  }
  const prefix = `${session}::`;
  for (const key of state.subagentToolArgs.keys()) {
    if (key.startsWith(prefix)) {
      state.subagentToolArgs.delete(key);
    }
  }
}

export function resetDelegatedWatchState(state) {
  state.subagentPlanSteps.clear();
  state.subagentSessionPlanKeys.clear();
  state.subagentLiveActivity.clear();
  state.recentSubagentLifecycleFingerprints.clear();
  state.subagentToolArgs.clear();
  state.plannerDagNodes.clear();
  state.plannerDagEdges.length = 0;
  state.plannerDagPipelineId = null;
  state.plannerDagStatus = "idle";
  state.plannerDagNote = null;
  state.plannerDagUpdatedAt = 0;
  state.plannerDagHydratedSessionId = null;
}
