import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOperatorInputBatcher,
  matchWatchCommands,
  matchModelNames,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
  WATCH_COMMANDS,
} from "./agenc-watch-helpers.mjs";
import { readWatchDaemonLogTail } from "./agenc-watch-log-tail.mjs";
import { createWatchCommandController } from "./agenc-watch-commands.mjs";
import { createWatchVoiceController } from "./agenc-watch-voice.mjs";
import { createWatchEventStore } from "./agenc-watch-event-store.mjs";
import { createWatchFrameController } from "./agenc-watch-frame.mjs";
import { createWatchInputController } from "./agenc-watch-input.mjs";
import { createWatchPlannerController } from "./agenc-watch-planner.mjs";
import { createWatchSubagentController } from "./agenc-watch-subagents.mjs";
import { createWatchTransportController } from "./agenc-watch-transport.mjs";
import { loadOperatorEventHelpers } from "./agenc-watch-runtime.mjs";
import {
  createWatchRenderCache,
} from "./agenc-watch-render-cache.mjs";
import {
  isDiffRenderableEvent,
} from "./agenc-watch-diff-render.mjs";
import {
  clearSubagentToolArgs,
  createWatchState,
  createWatchStateBindings,
  loadPersistedWatchState,
  persistWatchState,
  readSubagentToolArgs,
  rememberSubagentToolArgs,
  resetDelegatedWatchState,
} from "./agenc-watch-state.mjs";
import {
  bindWatchSurfaceState,
  createWatchSurfaceDispatchBridge,
} from "./agenc-watch-surface-bridge.mjs";
import { dispatchOperatorSurfaceEvent } from "./agenc-watch-surface-dispatch.mjs";
import {
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  parseMouseWheelSequence,
  supportsTerminalHyperlinks,
} from "./agenc-watch-terminal-sequences.mjs";
import {
  findLatestPendingAgentEvent,
  nextAgentStreamState,
} from "./agenc-watch-agent-stream.mjs";
import {
  computeTranscriptPreviewMaxLines,
  splitTranscriptPreviewForHeadline,
} from "./agenc-watch-transcript-cards.mjs";
import {
  autocompleteComposerFileTag,
  autocompleteSlashComposerInput,
  buildComposerRenderLine,
  currentComposerInput,
  deleteComposerToLineEnd,
  getActiveFileTagQuery,
  getComposerFileTagSuggestions,
  insertComposerText,
  isSlashComposerInput,
  moveComposerCursorByWord,
  navigateComposerHistory,
  recordComposerHistory as rememberComposerHistory,
  resetComposerState,
  setComposerInputValue,
} from "./agenc-watch-composer.mjs";
import {
  applyScrollDelta as applyViewportScrollDelta,
  bottomAlignRows as bottomAlignViewportRows,
  isTranscriptFollowing as isViewportTranscriptFollowing,
  preserveManualTranscriptViewport,
  sliceRowsAroundRange as sliceViewportRowsAroundRange,
  sliceRowsFromBottom as sliceViewportRowsFromBottom,
} from "./agenc-watch-viewport.mjs";
import {
  buildCommandPaletteSummary,
  buildFileTagPaletteSummary,
  buildDetailPaneSummary,
  buildWatchFooterSummary,
  buildTranscriptEventSummary,
  buildWatchLayout,
  buildWatchSidebarPolicy,
  buildWatchSurfaceSummary,
  shouldShowWatchSplash,
} from "./agenc-watch-surface-summary.mjs";
import { createWatchToolPresentation } from "./agenc-watch-tool-presentation.mjs";
import { loadWorkspaceFileIndex } from "./agenc-watch-workspace-index.mjs";
import { loadWebSocketConstructor } from "./agenc-websocket.mjs";

// ─── Extracted modules ──────────────────────────────────────────────
import {
  sanitizeLargeText,
  sanitizeInlineText,
  stripTerminalControlSequences,
  stripMarkdownDecorators,
  sanitizeDisplayText,
  stable,
  tryPrettyJson,
  tryParseJson,
  truncate,
  formatCompactNumber,
  formatElapsedMs,
  formatClockLabel,
  visibleLength,
  truncateAnsi,
  fitAnsi,
  padAnsi,
  wrapLine,
  wrapBlock,
  parseStructuredJson,
} from "./agenc-watch-text-utils.mjs";

import {
  color,
  toneTheme,
  toneColor,
  toneSpec,
  badge,
  chip,
  stateTone,
  onSurface,
  paintSurface,
  flexBetween,
  blankRow,
  panelTop,
  panelBottom,
  panelRow,
  renderPanel,
  row,
  wrapAndLimit,
  formatMetric,
  joinColumns,
} from "./agenc-watch-ui-primitives.mjs";

import {
  eventBodyLines,
  createDisplayLine,
  displayLineText,
  displayLinePlainText,
  isMarkdownRenderableEvent,
  normalizeDisplayLines,
  eventPreviewMode,
  isSourcePreviewEvent,
  isMutationPreviewEvent,
  normalizeEventBody as _normalizeEventBody,
  normalizeOptionalEventText,
  normalizeOptionalFileRange,
  renderMetadataPayload,
  buildRenderSignature,
  applyDescriptorRenderingMetadata,
  descriptorEventMetadata,
  sourceFileRangeLabel,
  buildSourcePreviewDisplayLines,
  buildEventDisplayLines as _buildEventDisplayLines,
  wrapDisplayLines,
  wrapEventDisplayLines as _wrapEventDisplayLines,
  compactBodyLines as _compactBodyLines,
  renderEventBodyLine as _renderEventBodyLine,
} from "./agenc-watch-event-display.mjs";

import {
  planStatusTone,
  planStatusGlyph,
  sanitizePlanLabel,
  plannerDagStatusTone,
  plannerDagStatusGlyph,
  plannerDagTypeGlyph,
  planStepDisplayName,
  resetPlannerDagState as _resetPlannerDagState,
  findTrackedPlannerDagKey as _findTrackedPlannerDagKey,
  ensurePlannerDagNode as _ensurePlannerDagNode,
  recomputePlannerDagStatus as _recomputePlannerDagStatus,
  syncPlannerDagEdges as _syncPlannerDagEdges,
  updatePlannerDagNode as _updatePlannerDagNode,
  retirePlannerDagOpenNodes as _retirePlannerDagOpenNodes,
  inferMergedPlannerDagOrder as _inferMergedPlannerDagOrder,
  ingestPlannerDag as _ingestPlannerDag,
  plannerTraceSessionPrefix,
  listPlannerTraceArtifactsForSession,
  readPlannerTracePayload,
  hydratePlannerDagFromTraceArtifacts as _hydratePlannerDagFromTraceArtifacts,
  hydratePlannerDagForLiveSession as _hydratePlannerDagForLiveSession,
  ensureSubagentPlanStep as _ensureSubagentPlanStep,
  updateSubagentPlanStep as _updateSubagentPlanStep,
} from "./agenc-watch-planner-dag.mjs";

import {
  formatCommandPaletteText as _formatCommandPaletteText,
  formatSessionSummaries,
  formatHistoryPayload,
  formatStatusPayload,
  statusFeedFingerprint,
  formatLogPayload,
  summarizeUsage,
  firstMeaningfulLine,
  contentPreviewLines,
  compactSessionToken,
  buildToolSummary,
  summarizeRunDetail as _summarizeRunDetail,
} from "./agenc-watch-format-payloads.mjs";

import {
  normalizeSessionValue as _normalizeSessionValue,
  sessionValuesMatch as _sessionValuesMatch,
  normalizeModelRoute as _normalizeModelRoute,
  formatModelRouteLabel,
  modelRouteTone as _modelRouteTone,
  shouldSurfaceTransientStatus,
  isExpectedMissingRunInspect,
  isUnavailableBackgroundRunInspect,
  isRetryableBootstrapError,
  buildSurfaceSummaryCacheKey,
  latestSessionSummary,
} from "./agenc-watch-session-utils.mjs";

// Re-export for external consumers (tests, harness)
export { buildSurfaceSummaryCacheKey, latestSessionSummary };

const APP_FILENAME = fileURLToPath(import.meta.url);
const APP_DIRNAME = path.dirname(APP_FILENAME);

export async function createWatchApp(runtime = {}) {
const process = runtime.processLike ?? globalThis.process;
const nowMs = runtime.nowMs ?? Date.now;
const setTimeout = runtime.setTimeout ?? globalThis.setTimeout.bind(globalThis);
const clearTimeout = runtime.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
const setInterval = runtime.setInterval ?? globalThis.setInterval.bind(globalThis);
const clearInterval = runtime.clearInterval ?? globalThis.clearInterval.bind(globalThis);
const WebSocket = runtime.WebSocket ?? await loadWebSocketConstructor();
const baseDir = runtime.baseDir ?? path.resolve(APP_DIRNAME, "..");

const {
  normalizeOperatorMessage,
  projectOperatorSurfaceEvent,
  shouldIgnoreOperatorMessage,
} = runtime.operatorEventHelpers ?? await loadOperatorEventHelpers({
  baseDir,
});

const wsUrl = process.env.AGENC_WATCH_WS_URL ?? "ws://127.0.0.1:3100";
const clientKey = process.env.AGENC_WATCH_CLIENT_KEY ?? "tmux-live-watch";
const resolvedProjectRoot = path.resolve(
  process.env.AGENC_WATCH_PROJECT_ROOT ?? process.cwd(),
);
const projectRoot = fs.existsSync(resolvedProjectRoot)
  ? fs.realpathSync.native(resolvedProjectRoot)
  : resolvedProjectRoot;
const watchStateFile =
  process.env.AGENC_WATCH_STATE_FILE ??
  path.join(
    os.homedir(),
    ".agenc",
    `watch-state-${clientKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`,
  );
const tracePayloadRoot = path.join(os.homedir(), ".agenc", "trace-payloads");
const reconnectMinDelayMs = 1_000;
const reconnectMaxDelayMs = 5_000;
const statusPollIntervalMs = 5_000;
const activityPulseIntervalMs = 200;
const startupSplashMinMs = 1_500;
const maxEvents = 140;
const maxInlineChars = 220;
const maxStoredBodyChars = 96_000;
const enableMouseTracking = process.env.AGENC_WATCH_ENABLE_MOUSE !== "0";
const maxFeedPreviewLines = 3;
const maxPreviewSourceLines = 160;
const LIVE_EVENT_FILTERS = Object.freeze([
  "subagents.*",
  "planner_*",
]);
const introDismissKinds = new Set([
  "you",
  "agent",
  "tool",
  "tool result",
  "tool error",
  "subagent",
  "subagent tool",
  "subagent tool result",
  "subagent error",
  "run",
  "approval",
  "social",
  "operator",
]);

const maxEventBodyLines = 5;
const DAG_NODE_IDS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const launchedAtMs = nowMs();
const persistedWatchState = loadPersistedWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
});
const watchState = createWatchState({ persistedWatchState, launchedAtMs });

let requestCounter = 0;
let shuttingDown = false;
const transportState = {
  isOpen: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  bootstrapTimer: null,
  statusPollTimer: null,
  activityPulseTimer: null,
  ws: null,
  connectionState: "connecting",
};
let watchCommandController = null;
let watchFrameController = null;
let watchInputController = null;
let watchPlannerController = null;
let watchSubagentController = null;
let watchTransportController = null;
let surfaceDispatchApi = null;
const watchRenderCache = createWatchRenderCache();
const enableWatchHyperlinks = supportsTerminalHyperlinks({
  stream: process.stdout,
  env: process.env,
});
const workspaceFileIndex = loadWorkspaceFileIndex({
  cwd: process.cwd(),
});
const operatorInputBatcher = createOperatorInputBatcher({
  onDispatch: (value) => {
    dispatchOperatorInput(value);
  },
  setTimer: setTimeout,
  clearTimer: clearTimeout,
});

const pendingFrames = [];
const queuedOperatorInputs = watchState.queuedOperatorInputs;
const subagentPlanSteps = watchState.subagentPlanSteps;
const subagentSessionPlanKeys = watchState.subagentSessionPlanKeys;
const subagentLiveActivity = watchState.subagentLiveActivity;
const recentSubagentLifecycleFingerprints = watchState.recentSubagentLifecycleFingerprints;
const plannerDagNodes = watchState.plannerDagNodes;
const plannerDagEdges = watchState.plannerDagEdges;
const events = watchState.events;
let inputListener = null;
let resizeListener = null;
let startupTimer = null;
let started = false;
let disposed = false;
let resolvedExitCode = null;
let resolveClosed = () => {};
const closed = new Promise((resolve) => {
  resolveClosed = resolve;
});

function nextId(prefix = "req") {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function nowStamp() {
  return new Date(nowMs()).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeSessionValue(value) {
  return _normalizeSessionValue(value);
}

function sessionValuesMatch(left, right) {
  return _sessionValuesMatch(left, right);
}

function persistOwnerToken(nextOwnerToken) {
  persistWatchState({
    fs,
    path,
    watchStateFile,
    clientKey,
    ownerToken: nextOwnerToken,
    sessionId: watchState.sessionId,
  });
}

function persistSessionId(nextSessionId) {
  persistWatchState({
    fs,
    path,
    watchStateFile,
    clientKey,
    ownerToken: watchState.ownerToken,
    sessionId: nextSessionId,
  });
}

function dismissIntro() {
  watchState.introDismissed = true;
}

function termWidth() {
  return Math.max(74, process.stdout.columns || 100);
}

function termHeight() {
  return Math.max(12, process.stdout.rows || 40);
}

function currentTranscriptLayout() {
  return watchFrameController?.currentTranscriptLayout() ?? buildWatchLayout({
    width: termWidth(),
    height: termHeight(),
    headerRows: 4,
    popupRows: 0,
    slashMode: false,
    detailOpen: Boolean(watchState.expandedEventId),
  });
}

function currentSessionElapsedLabel() {
  return formatElapsedMs(nowMs() - watchState.sessionAttachedAtMs);
}

function currentRunElapsedLabel() {
  const startedAt = Number(watchState.activeRunStartedAtMs);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return currentSessionElapsedLabel();
  }
  return formatElapsedMs(nowMs() - startedAt);
}

function animatedWorkingGlyph() {
  const frames = ["\u25d0", "\u25d3", "\u25d1", "\u25d2"];
  const frameIndex = Math.floor(nowMs() / activityPulseIntervalMs) % frames.length;
  return frames[frameIndex] ?? frames[0];
}

function normalizeModelRoute(input = {}) {
  return _normalizeModelRoute(input, nowMs);
}

function effectiveModelRoute() {
  return watchState.liveSessionModelRoute ?? watchState.configuredModelRoute;
}

let cachedSurfaceSummaryKey = null;
let cachedSurfaceSummary = null;

function activePlanEntries(limit = 10) {
  return [...subagentPlanSteps.values()]
    .sort((left, right) => left.order - right.order)
    .slice(-limit);
}

function activeAgentEntries(limit = 24) {
  return activePlanEntries(limit).filter((step) =>
    step.status === "running" || step.status === "planned"
  );
}

function currentActiveAgentFocus() {
  const step = currentPlanFocusStep();
  if (!step) {
    return {
      label: null,
      activity: null,
    };
  }
  const label = planStepDisplayName(step, 48);
  const activity = sanitizeInlineText(
    step.subagentSessionId
      ? watchState.subagentLiveActivity.get(step.subagentSessionId) ?? step.note ?? ""
      : step.note ?? "",
  );
  return {
    label,
    activity: activity || null,
  };
}

function currentSurfaceSummary() {
  const route = effectiveModelRoute();
  const planEntries = activePlanEntries(24);
  const activeAgents = activeAgentEntries(24);
  const lastEvent = events[events.length - 1] ?? null;
  const activeAgentFocus = currentActiveAgentFocus();
  const summaryKey = buildSurfaceSummaryCacheKey({
    connectionState: transportState.connectionState,
    phaseLabel: effectiveSurfacePhaseLabel(),
    route,
    backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
    runtimeStatus: watchState.lastStatus ?? null,
    objective: currentDisplayObjective("No active objective"),
    lastUsageSummary: watchState.lastUsageSummary,
    latestTool: watchState.latestTool,
    latestToolState: watchState.latestToolState,
    queuedInputCount: queuedOperatorInputs.length,
    eventsLength: events.length,
    lastEventId: lastEvent?.id ?? null,
    planCount: planEntries.length,
    activeAgentCount: activeAgents.length,
    activeAgentLabel: activeAgentFocus.label,
    activeAgentActivity: activeAgentFocus.activity,
    plannerStatus: watchState.plannerDagStatus,
    plannerNote: watchState.plannerDagNote,
    sessionId: watchState.sessionId,
    following: isTranscriptFollowing(),
    detailOpen: Boolean(watchState.expandedEventId),
    transcriptScrollOffset: watchState.transcriptScrollOffset,
    lastActivityAt: watchState.lastActivityAt,
  });
  if (summaryKey === cachedSurfaceSummaryKey && cachedSurfaceSummary) {
    return cachedSurfaceSummary;
  }
  cachedSurfaceSummary = buildWatchSurfaceSummary({
    connectionState: transportState.connectionState,
    phaseLabel: effectiveSurfacePhaseLabel(),
    route,
    fallbackRoute: route?.usedFallback === true ? route : null,
    backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
    objective: currentDisplayObjective("No active objective"),
    lastUsageSummary: watchState.lastUsageSummary,
    latestTool: watchState.latestTool,
    latestToolState: watchState.latestToolState,
    queuedInputCount: queuedOperatorInputs.length,
    events,
    planCount: planEntries.length,
    activeAgentCount: activeAgents.length,
    sessionId: watchState.sessionId,
    following: isTranscriptFollowing(),
    detailOpen: Boolean(watchState.expandedEventId),
    transcriptScrollOffset: watchState.transcriptScrollOffset,
    lastActivityAt: watchState.lastActivityAt,
    runtimeStatus: watchState.lastStatus ?? null,
    activeAgentLabel: activeAgentFocus.label,
    activeAgentActivity: activeAgentFocus.activity,
    plannerStatus: watchState.plannerDagStatus,
    plannerNote: watchState.plannerDagNote,
  });
  cachedSurfaceSummaryKey = summaryKey;
  return cachedSurfaceSummary;
}

function modelRouteTone(route) {
  return _modelRouteTone(route, Boolean(watchState.liveSessionModelRoute));
}

function currentPhaseLabel() {
  return watchState.runPhase && watchState.runPhase !== "idle"
    ? watchState.runState && watchState.runState !== "idle" && watchState.runPhase !== watchState.runState
      ? `${watchState.runState} / ${watchState.runPhase}`
      : watchState.runPhase
    : watchState.runState;
}

function currentPlanFocusStep() {
  return [...subagentPlanSteps.values()]
    .filter((step) => step.status === "running" || step.status === "planned")
    .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)[0] ?? null;
}

function effectiveSurfacePhaseLabel() {
  const phaseLabel = currentPhaseLabel();
  if (phaseLabel && phaseLabel !== "idle") {
    return phaseLabel;
  }
  if (watchState.runState === "idle" || phaseLabel === "idle") {
    return "idle";
  }
  return currentPlanFocusStep() ? "delegating" : phaseLabel || "idle";
}

function hasActiveSurfaceRun() {
  return effectiveSurfacePhaseLabel() !== "idle";
}

function currentDisplayObjective(fallback = "No active objective") {
  const liveStep = currentPlanFocusStep();
  const candidate = sanitizeInlineText(
    watchState.currentObjective ??
      watchState.runDetail?.objective ??
      liveStep?.objective ??
      liveStep?.note ??
      "",
  );
  return candidate || fallback;
}

function currentSurfaceToolLabel(fallback = "idle") {
  const liveStep = currentPlanFocusStep();
  const note = sanitizeInlineText(liveStep?.note ?? "");
  const objective = sanitizeInlineText(liveStep?.objective ?? "");
  if (liveStep?.status === "running" && note && note !== objective) {
    return note;
  }
  return sanitizeInlineText(watchState.latestTool ?? "") || fallback;
}

// ─── Thin wrappers binding closure state to extracted pure functions ─

function normalizeEventBody(body) {
  return _normalizeEventBody(body, maxStoredBodyChars);
}

function compactBodyLines(value, maxLines = 4) {
  return _compactBodyLines(value, maxLines, maxInlineChars);
}

function renderEventBodyLine(event, line, { inline = false } = {}) {
  return _renderEventBodyLine(event, line, {
    inline,
    color,
    cwd: process.cwd(),
    enableHyperlinks: enableWatchHyperlinks,
    isSourcePreview: isSourcePreviewEvent(event),
  });
}

function buildEventDisplayLines(event, maxLines = Infinity) {
  return _buildEventDisplayLines(event, watchRenderCache, {
    cwd: process.cwd(),
    maxInlineChars,
    maxPreviewSourceLines,
  }, maxLines);
}

function wrapEventDisplayLines(event, width, maxLines = Infinity) {
  return _wrapEventDisplayLines(event, watchRenderCache, {
    cwd: process.cwd(),
    maxInlineChars,
    maxPreviewSourceLines,
  }, width, maxLines);
}

function formatCommandPaletteText(command) {
  return _formatCommandPaletteText(command, color);
}

function summarizeRunDetail(detail) {
  return _summarizeRunDetail(detail, watchState);
}

// ─── Planner DAG wrappers binding closure state ─────────────────────

function resetPlannerDagState() {
  _resetPlannerDagState(watchState, plannerDagNodes, plannerDagEdges);
}

function findTrackedPlannerDagKey(input = {}) {
  return _findTrackedPlannerDagKey(plannerDagNodes, input);
}

function ensurePlannerDagNode(input = {}) {
  return _ensurePlannerDagNode(watchState, plannerDagNodes, nowMs, input);
}

function syncPlannerDagEdges(steps = [], edges = [], options = {}) {
  return _syncPlannerDagEdges(plannerDagEdges, steps, edges, options);
}

function recomputePlannerDagStatus() {
  return _recomputePlannerDagStatus(watchState, plannerDagNodes);
}

function updatePlannerDagNode(input = {}) {
  return _updatePlannerDagNode(watchState, plannerDagNodes, nowMs, input);
}

function retirePlannerDagOpenNodes(status = "cancelled", note = null) {
  return _retirePlannerDagOpenNodes(watchState, plannerDagNodes, nowMs, status, note);
}

function ingestPlannerDag(payload = {}, options = {}) {
  return _ingestPlannerDag(watchState, plannerDagNodes, plannerDagEdges, nowMs, payload, options);
}

function hydratePlannerDagFromTraceArtifacts(sessionValue, options = {}) {
  return _hydratePlannerDagFromTraceArtifacts(
    watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
    sessionValue, options,
  );
}

function hydratePlannerDagForLiveSession(options = {}) {
  return _hydratePlannerDagForLiveSession(
    watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
    options,
  );
}

function ensureSubagentPlanStep(input = {}) {
  return _ensureSubagentPlanStep(watchState, subagentPlanSteps, subagentSessionPlanKeys, nowMs, input);
}

function updateSubagentPlanStep(input = {}) {
  return _updateSubagentPlanStep(
    watchState, plannerDagNodes, plannerDagEdges,
    subagentPlanSteps, subagentSessionPlanKeys, nowMs,
    input,
  );
}

// ─── Transient status & event store ─────────────────────────────────

function setTransientStatus(value) {
  watchState.transientStatus = truncate(sanitizeInlineText(value || "idle"), 160);
  scheduleRender();
}

const eventStore = createWatchEventStore({
  watchState,
  events,
  maxEvents,
  introDismissKinds,
  nextId,
  nowStamp,
  normalizeEventBody,
  sanitizeLargeText,
  sanitizeInlineText,
  stripTerminalControlSequences,
  dismissIntro,
  scheduleRender,
  withPreservedManualTranscriptViewport,
  findLatestPendingAgentEvent,
  nextAgentStreamState,
  setTransientStatus,
  resetDelegationState,
  applyDescriptorRenderingMetadata,
  nowMs,
});

const {
  pushEvent,
  appendAgentStreamChunk,
  commitAgentMessage,
  cancelAgentStream,
  restoreTranscriptFromHistory,
  upsertSubagentHeartbeatEvent,
  clearSubagentHeartbeatEvents,
  replaceLatestToolEvent,
  replaceLatestSubagentToolEvent,
  clearLiveTranscriptView,
} = eventStore;

function authPayload(extra = {}) {
  const payload = { clientKey, workspaceRoot: projectRoot, ...extra };
  if (watchState.ownerToken) {
    payload.ownerToken = watchState.ownerToken;
  }
  return payload;
}

function currentInputValue() {
  return currentComposerInput(watchState);
}

function currentSlashSuggestions(limit = 8) {
  return matchWatchCommands(currentInputValue(), { limit });
}

function currentModelSuggestions(limit = 6) {
  const input = currentInputValue().trimStart();
  const match = input.match(/^\/models?\s+(.*)/i);
  if (!match) return [];
  return matchModelNames(match[1].trim(), { limit });
}

function currentFileTagQuery() {
  return getActiveFileTagQuery({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
  });
}

function currentFileTagSuggestions(limit = 8) {
  return getComposerFileTagSuggestions({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
    fileIndex: workspaceFileIndex,
    limit,
  });
}

function currentFileTagPalette(limit = 8) {
  const activeTag = currentFileTagQuery();
  const suggestions = activeTag ? currentFileTagSuggestions(limit) : [];
  return {
    activeTag,
    suggestions,
    summary: buildFileTagPaletteSummary({
      inputValue: currentInputValue(),
      query: activeTag?.query ?? null,
      suggestions,
      indexReady: workspaceFileIndex.ready,
      indexError: workspaceFileIndex.error,
    }),
  };
}

function resetComposer() {
  resetComposerState(watchState);
}

function insertComposerTextValue(text) {
  insertComposerText(watchState, text);
}

function moveComposerCursor(direction) {
  moveComposerCursorByWord(watchState, direction);
}

function deleteComposerTail() {
  deleteComposerToLineEnd(watchState);
}

function navigateComposer(direction) {
  navigateComposerHistory(watchState, direction);
}

function autocompleteComposerInput() {
  if (autocompleteComposerFileTag(watchState, workspaceFileIndex, { limit: 8 })) {
    return true;
  }
  return autocompleteSlashComposerInput(watchState, matchWatchCommands);
}

function composerRenderLine(width) {
  return buildComposerRenderLine({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
    prompt: promptLabel(),
    width,
    visibleLength,
  });
}

function resolveExit(exitCode = 0) {
  if (resolvedExitCode !== null) {
    return resolvedExitCode;
  }
  resolvedExitCode = exitCode;
  resolveClosed(exitCode);
  return exitCode;
}

function dispose(exitCode = 0) {
  if (disposed) {
    return resolveExit(exitCode);
  }
  disposed = true;
  shuttingDown = true;
  operatorInputBatcher.dispose();
  watchTransportController?.dispose();
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (inputListener) {
    process.stdin.off("data", inputListener);
    inputListener = null;
  }
  if (resizeListener) {
    process.stdout.off("resize", resizeListener);
    resizeListener = null;
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  leaveAltScreen();
  return resolveExit(exitCode);
}

function shutdownWatch(exitCode = 0) {
  return dispose(exitCode);
}

function recordComposerHistory(value) {
  rememberComposerHistory(watchState, value);
}

function requestRunInspect(reason, { force = false } = {}) {
  if (
    !watchState.sessionId ||
    !transportState.isOpen ||
    watchState.runInspectPending ||
    (!force && !shouldAutoInspectRun(watchState.runDetail, watchState.runState))
  ) {
    return;
  }
  watchState.runInspectPending = true;
  send("run.inspect", { sessionId: watchState.sessionId });
  setTransientStatus(`refreshing run card (${reason})`);
}

function clearBootstrapTimer() {
  return watchTransportController.clearBootstrapTimer();
}

function clearStatusPollTimer() {
  return watchTransportController.clearStatusPollTimer();
}

function clearActivityPulseTimer() {
  return watchTransportController.clearActivityPulseTimer();
}

function ensureStatusPollTimer() {
  return watchTransportController.ensureStatusPollTimer();
}

function ensureActivityPulseTimer() {
  return watchTransportController.ensureActivityPulseTimer();
}

function bootstrapPending() {
  return watchTransportController.bootstrapPending();
}

function markBootstrapReady(statusText) {
  return watchTransportController.markBootstrapReady(statusText);
}

function sendBootstrapProbe() {
  return watchTransportController.sendBootstrapProbe();
}

function scheduleBootstrap(reason = "restoring session") {
  return watchTransportController.scheduleBootstrap(reason);
}

const watchVoiceController = createWatchVoiceController({
  send,
  authPayload,
  pushEvent,
  setTransientStatus,
  watchState,
});

watchCommandController = createWatchCommandController({
  watchState,
  queuedOperatorInputs,
  WATCH_COMMANDS,
  parseWatchSlashCommand,
  authPayload,
  send,
  shutdownWatch,
  dismissIntro,
  clearLiveTranscriptView,
  exportCurrentView,
  resetLiveRunSurface,
  resetDelegationState,
  persistSessionId,
  clearBootstrapTimer,
  pushEvent,
  setTransientStatus,
  readWatchDaemonLogTail,
  formatLogPayload,
  currentClientKey: () => clientKey,
  isOpen: () => transportState.isOpen,
  bootstrapPending,
  voiceController: watchVoiceController,
  nowMs,
});

function shouldShowSplash() {
  return watchFrameController?.shouldShowSplash() ?? false;
}

function resetLiveRunSurface() {
  watchState.latestAgentSummary = null;
  watchState.latestTool = null;
  watchState.latestToolState = null;
  watchState.lastUsageSummary = null;
  watchState.liveSessionModelRoute = null;
  watchState.activeRunStartedAtMs = null;
}

function latestExpandableEvent() {
  return watchFrameController?.latestExpandableEvent() ?? (events[events.length - 1] ?? null);
}

function currentExpandedEvent() {
  return watchFrameController?.currentExpandedEvent() ??
    (watchState.expandedEventId
      ? events.find((event) => event.id === watchState.expandedEventId) ?? null
      : null);
}

function toggleExpandedEvent() {
  watchFrameController?.toggleExpandedEvent();
}

function currentTranscriptRowCount() {
  return watchFrameController?.currentTranscriptRowCount() ?? 0;
}

function withPreservedManualTranscriptViewport(mutator) {
  if (watchFrameController) {
    return watchFrameController.withPreservedManualTranscriptViewport(mutator);
  }
  return mutator({ shouldFollow: isTranscriptFollowing() });
}

function isTranscriptFollowing() {
  return isViewportTranscriptFollowing({
    transcriptFollowMode: watchState.transcriptFollowMode,
    transcriptScrollOffset: watchState.transcriptScrollOffset,
  });
}

function exportCurrentView({ announce = false } = {}) {
  return watchFrameController?.exportCurrentView({ announce }) ?? null;
}

function copyCurrentView() {
  watchFrameController?.copyCurrentView();
}

function scrollCurrentViewBy(delta) {
  watchFrameController?.scrollCurrentViewBy(delta);
}

function leaveAltScreen() {
  watchFrameController?.leaveAltScreen();
}

function promptLabel() {
  const slashMode = isSlashComposerInput(currentInputValue());
  const promptTone = slashMode ? color.teal : color.magenta;
  return `${promptTone}${color.bold}>${color.reset} `;
}

function render() {
  watchFrameController?.render();
}

function scheduleRender() {
  watchFrameController?.scheduleRender();
}

function scheduleReconnect() {
  return watchTransportController.scheduleReconnect();
}

function handleToolResult(toolName, isError, result, toolArgs) {
  const lastEvent = events[events.length - 1];
  const args = toolArgs ?? (lastEvent?.toolName === toolName ? lastEvent.toolArgs : undefined);
  const descriptor = describeToolResult(
    toolName,
    args,
    isError,
    result,
  );
  if (!shouldSuppressToolActivity(toolName, args, { isError })) {
    watchState.latestTool = toolName;
    watchState.latestToolState = isError ? "error" : "ok";
    setTransientStatus(isError ? `${descriptor.title}` : descriptor.title);
  }
  if (replaceLatestToolEvent(toolName, isError, descriptor.body, descriptor)) {
    return;
  }
  if (shouldSuppressToolTranscript(toolName, args, { isError })) {
    return;
  }
  pushEvent(
    isError ? "tool error" : "tool result",
    descriptor.title,
    descriptor.body,
    descriptor.tone,
    descriptorEventMetadata(descriptor, {
      toolName,
      toolArgs: args,
    }),
  );
}

function resetDelegationState() {
  return watchSubagentController.resetDelegationState();
}

function handleSubagentLifecycleMessage(type, payload) {
  return watchSubagentController.handleSubagentLifecycleMessage(type, payload);
}

function handlePlannerTraceEvent(type, payload) {
  return watchPlannerController.handlePlannerTraceEvent(type, payload);
}

function send(type, payload) {
  return watchTransportController.send(type, payload);
}

function requireSession(command) {
  if (!watchState.sessionId) {
    pushEvent("error", "Session Error", `${command} requires an active session`, "red");
    return false;
  }
  return true;
}

const {
  backgroundToolSurfaceLabel,
  compactPathForDisplay,
  describeToolResult,
  describeToolStart,
  formatShellCommand,
  shouldSuppressToolActivity,
  shouldSuppressToolTranscript,
} = createWatchToolPresentation({
  sanitizeInlineText,
  sanitizeLargeText,
  sanitizeDisplayText,
  truncate,
  stable,
  tryParseJson,
  tryPrettyJson,
  parseStructuredJson,
  buildToolSummary,
  maxEventBodyLines,
});

watchPlannerController = createWatchPlannerController({
  watchState,
  plannerDagNodeCount: () => plannerDagNodes.size,
  sessionValuesMatch,
  hydratePlannerDagForLiveSession,
  ingestPlannerDag,
  updatePlannerDagNode,
  retirePlannerDagOpenNodes,
  sanitizeInlineText,
  describeToolStart,
  describeToolResult,
  nowMs,
});

watchSubagentController = createWatchSubagentController({
  watchState,
  recentSubagentLifecycleFingerprints,
  subagentLiveActivity,
  resetDelegatedWatchState,
  plannerDagNodeCount: () => plannerDagNodes.size,
  hydratePlannerDagForLiveSession,
  updateSubagentPlanStep,
  ensureSubagentPlanStep,
  planStepDisplayName,
  compactSessionToken,
  sanitizeInlineText,
  truncate,
  pushEvent,
  setTransientStatus,
  requestRunInspect,
  describeToolStart,
  describeToolResult,
  descriptorEventMetadata,
  shouldSuppressToolTranscript,
  shouldSuppressToolActivity,
  rememberSubagentToolArgs,
  readSubagentToolArgs: (state, subagentSessionId, toolName) =>
    readSubagentToolArgs(state, subagentSessionId, toolName),
  clearSubagentToolArgs,
  replaceLatestSubagentToolEvent,
  clearSubagentHeartbeatEvents,
  compactPathForDisplay,
  formatShellCommand,
  currentDisplayObjective,
  backgroundToolSurfaceLabel,
  retirePlannerDagOpenNodes,
  firstMeaningfulLine,
  tryPrettyJson,
  nowMs,
});

watchTransportController = createWatchTransportController({
  transportState,
  watchState,
  pendingFrames,
  liveEventFilters: LIVE_EVENT_FILTERS,
  connectedStatusText: `connected to ${wsUrl}`,
  reconnectMinDelayMs,
  reconnectMaxDelayMs,
  statusPollIntervalMs,
  activityPulseIntervalMs,
  createSocket: () => new WebSocket(wsUrl),
  nextFrameId: nextId,
  normalizeOperatorMessage,
  projectOperatorSurfaceEvent,
  shouldIgnoreOperatorMessage,
  dispatchOperatorSurfaceEvent: (surfaceEvent, rawMessage) => {
    const rawType = rawMessage?.type;
    // Intercept voice messages
    if (typeof rawType === "string" && rawType.startsWith("voice.")) {
      const handled = watchVoiceController.handleVoiceMessage(
        rawType,
        rawMessage?.payload ?? {},
      );
      if (handled) return;
    }
    // Intercept memory responses
    if (rawType === "memory.results") {
      const entries = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      if (entries.length === 0) {
        pushEvent("memory", "Memory", "No results found.", "slate");
      } else {
        const lines = entries.map((e) => {
          const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : "";
          const role = e.role === "user" ? "YOU" : "AGENT";
          const text = (e.content ?? "").slice(0, 200);
          return `${ts}  ${role}  ${text}`;
        });
        pushEvent("memory", "Memory Search", lines.join("\n"), "teal");
      }
      setTransientStatus(`memory: ${entries.length} result(s)`);
      return;
    }
    if (rawType === "memory.sessions") {
      const sessions = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      if (sessions.length === 0) {
        pushEvent("memory", "Memory", "No memory sessions found.", "slate");
      } else {
        const lines = sessions.map((s) => {
          const lastActive = s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString() : "never";
          return `${s.id.slice(0, 24)}\u2026  ${s.messageCount} msgs  last: ${lastActive}`;
        });
        pushEvent("memory", "Memory Sessions", lines.join("\n"), "teal");
      }
      setTransientStatus(`memory: ${sessions.length} session(s)`);
      return;
    }
    dispatchOperatorSurfaceEvent(surfaceEvent, rawMessage, surfaceDispatchApi);
  },
  scheduleRender,
  setTransientStatus,
  pushEvent,
  authPayload,
  hasActiveSurfaceRun,
  shuttingDown: () => shuttingDown,
  flushQueuedOperatorInputs: () => {
    watchCommandController?.flushQueuedOperatorInputs();
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});

({ api: surfaceDispatchApi } = createWatchSurfaceDispatchBridge({
  stateBindings: createWatchStateBindings({
    state: watchState,
    bindState: bindWatchSurfaceState,
  }),
  helpers: {
    now: () => nowMs(),
    setTransientStatus,
    persistSessionId,
    persistOwnerToken,
    resetLiveRunSurface,
    markBootstrapReady,
    clearBootstrapTimer,
    send,
    authPayload,
    requestRunInspect,
    eventStore,
    formatSessionSummaries,
    latestSessionSummary: (payload, preferredSessionId = null) =>
      latestSessionSummary(payload, preferredSessionId, projectRoot),
    formatHistoryPayload,
    shouldAutoInspectRun,
    sanitizeInlineText,
    truncate,
    summarizeUsage,
    normalizeModelRoute,
    describeToolStart,
    descriptorEventMetadata,
    shouldSuppressToolTranscript,
    shouldSuppressToolActivity,
    handleToolResult,
    tryPrettyJson,
    formatLogPayload,
    formatStatusPayload,
    statusFeedFingerprint,
    handlePlannerTraceEvent,
    handleSubagentLifecycleMessage,
    hydratePlannerDagFromTraceArtifacts,
    isExpectedMissingRunInspect,
    isUnavailableBackgroundRunInspect,
    isRetryableBootstrapError,
    scheduleBootstrap,
  },
}));

function attachSocket(socket) {
  return watchTransportController.attachSocket(socket);
}

function connect() {
  return watchTransportController.connect();
}

function printHelp() {
  return watchCommandController.printHelp();
}

function shouldQueueOperatorInput(value) {
  return watchCommandController.shouldQueueOperatorInput(value);
}

function dispatchOperatorInput(value, { replayed = false } = {}) {
  return watchCommandController.dispatchOperatorInput(value, { replayed });
}

watchFrameController = createWatchFrameController({
  fs,
  watchState,
  transportState,
  events,
  queuedOperatorInputs,
  subagentPlanSteps,
  subagentLiveActivity,
  plannerDagNodes,
  plannerDagEdges,
  workspaceFileIndex,
  color,
  enableMouseTracking,
  launchedAtMs,
  startupSplashMinMs,
  introDismissKinds,
  maxInlineChars,
  maxPreviewSourceLines,
  currentSurfaceSummary,
  currentInputValue,
  currentSlashSuggestions,
  currentModelSuggestions,
  currentFileTagPalette,
  currentSessionElapsedLabel,
  currentRunElapsedLabel,
  currentDisplayObjective,
  currentPhaseLabel,
  currentSurfaceToolLabel,
  hasActiveSurfaceRun,
  bootstrapPending,
  shouldShowWatchSplash,
  buildWatchLayout,
  buildWatchFooterSummary,
  buildWatchSidebarPolicy,
  buildTranscriptEventSummary,
  buildDetailPaneSummary,
  buildCommandPaletteSummary,
  buildFileTagPaletteSummary,
  computeTranscriptPreviewMaxLines,
  splitTranscriptPreviewForHeadline,
  buildEventDisplayLines,
  wrapEventDisplayLines,
  wrapDisplayLines,
  compactBodyLines,
  createDisplayLine,
  displayLineText,
  displayLinePlainText,
  renderEventBodyLine,
  isDiffRenderableEvent,
  isSourcePreviewEvent,
  isMarkdownRenderableEvent,
  isMutationPreviewEvent,
  isSlashComposerInput,
  composerRenderLine,
  fitAnsi,
  truncate,
  sanitizeInlineText,
  sanitizeDisplayText,
  toneColor,
  stateTone,
  badge,
  chip,
  row,
  renderPanel,
  joinColumns,
  blankRow,
  paintSurface,
  flexBetween,
  termWidth,
  termHeight,
  formatClockLabel,
  animatedWorkingGlyph,
  compactSessionToken,
  sanitizePlanLabel,
  plannerDagStatusTone,
  plannerDagStatusGlyph,
  plannerDagTypeGlyph,
  planStatusTone,
  planStatusGlyph,
  planStepDisplayName,
  applyViewportScrollDelta,
  preserveManualTranscriptViewport,
  sliceViewportRowsAroundRange,
  sliceViewportRowsFromBottom,
  bottomAlignViewportRows,
  isViewportTranscriptFollowing,
  setTransientStatus,
  pushEvent,
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  stdout: process.stdout,
  nowMs,
  setTimer: setTimeout,
});

watchInputController = createWatchInputController({
  watchState,
  shuttingDown: () => shuttingDown,
  parseMouseWheelSequence,
  scrollCurrentViewBy,
  shutdownWatch,
  toggleExpandedEvent,
  currentDiffNavigationState: () => watchFrameController?.currentDiffNavigationState() ?? { enabled: false },
  jumpCurrentDiffHunk: (direction) => watchFrameController?.jumpCurrentDiffHunk(direction) ?? false,
  copyCurrentView,
  clearLiveTranscriptView,
  deleteComposerTail,
  autocompleteComposerInput,
  navigateComposer,
  moveComposerCursorByWord: moveComposerCursor,
  insertComposerTextValue,
  dismissIntro,
  resetComposer,
  recordComposerHistory,
  operatorInputBatcher,
  setTransientStatus,
  cancelActiveChat: () => {
    send("chat.cancel", authPayload());
    setTransientStatus("cancelled");
  },
  scheduleRender,
});

function handleTerminalEscapeSequence(input, index) {
  return watchInputController.handleTerminalEscapeSequence(input, index);
}

function handleTerminalInput(input) {
  return watchInputController.handleTerminalInput(input);
}

function buildVisibleFrameSnapshot({ width, height } = {}) {
  return watchFrameController?.buildVisibleFrameSnapshot({ width, height }) ?? {
    lines: [],
    width: Number(width) || 0,
    height: Number(height) || 0,
    composer: { line: "", cursorColumn: 1 },
    diffNavigation: null,
  };
}

function captureReplayCheckpoint(label, { width, height, meta = null } = {}) {
  return {
    label: sanitizeInlineText(label || "checkpoint") || "checkpoint",
    snapshot: buildVisibleFrameSnapshot({ width, height }),
    summary: currentSurfaceSummary(),
    state: {
      connectionState: transportState.connectionState,
      sessionId: normalizeSessionValue(watchState.sessionId),
      objective: currentDisplayObjective("No active objective"),
      phaseLabel: effectiveSurfacePhaseLabel(),
      runState: watchState.runState ?? null,
      runPhase: watchState.runPhase ?? null,
      latestTool: watchState.latestTool ?? null,
      latestToolState: watchState.latestToolState ?? null,
      latestAgentSummary: watchState.latestAgentSummary ?? null,
      eventCount: events.length,
      expandedEventId: watchState.expandedEventId ?? null,
    },
    meta,
  };
}

function flushReplayTimers() {
  if (typeof runtime.flushTimers !== "function") {
    return 0;
  }
  return runtime.flushTimers();
}

async function start() {
  if (started) {
    return;
  }
  started = true;
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    inputListener = (chunk) => {
      const input = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      handleTerminalInput(input);
    };
    resizeListener = () => {
      scheduleRender();
    };
    process.stdin.on("data", inputListener);
    process.stdout.on("resize", resizeListener);
    connect();
    scheduleRender();
    ensureActivityPulseTimer();
    startupTimer = setTimeout(() => {
      startupTimer = null;
      scheduleRender();
    }, startupSplashMinMs);
  } catch (error) {
    dispose(1);
    throw error;
  }
}

return {
  closed,
  start,
  dispose,
  shutdownWatch,
  buildVisibleFrameSnapshot,
  captureReplayCheckpoint,
  flushReplayTimers,
};
}

export async function runWatchApp(runtime = {}) {
  const app = await createWatchApp(runtime);
  try {
    await app.start();
    return await app.closed;
  } catch (error) {
    app.dispose(1);
    throw error;
  }
}
