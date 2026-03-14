import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOperatorInputBatcher,
  matchWatchCommands,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
  WATCH_COMMANDS,
} from "./agenc-watch-helpers.mjs";
import { readWatchDaemonLogTail } from "./agenc-watch-log-tail.mjs";
import { createWatchCommandController } from "./agenc-watch-commands.mjs";
import { createWatchEventStore } from "./agenc-watch-event-store.mjs";
import { createWatchFrameController } from "./agenc-watch-frame.mjs";
import { createWatchInputController } from "./agenc-watch-input.mjs";
import { createWatchPlannerController } from "./agenc-watch-planner.mjs";
import { createWatchSubagentController } from "./agenc-watch-subagents.mjs";
import { createWatchTransportController } from "./agenc-watch-transport.mjs";
import { loadOperatorEventHelpers } from "./agenc-watch-runtime.mjs";
import {
  buildWatchRenderCacheSignature,
  createWatchRenderCache,
  getCachedEventDisplayLines,
  getCachedWrappedDisplayLines,
} from "./agenc-watch-render-cache.mjs";
import {
  buildDiffDisplayLines,
  isDiffRenderableEvent,
} from "./agenc-watch-diff-render.mjs";
import { compactFileReference } from "./agenc-watch-file-links.mjs";
import {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  highlightSourceLine,
  renderDisplayLine,
  wrapRichDisplayLines,
} from "./agenc-watch-rich-text.mjs";
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

const APP_FILENAME = fileURLToPath(import.meta.url);
const APP_DIRNAME = path.dirname(APP_FILENAME);

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

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  border: "\x1b[38;5;54m",
  borderStrong: "\x1b[38;5;99m",
  ink: "\x1b[38;5;225m",
  softInk: "\x1b[38;5;189m",
  slate: "\x1b[38;5;141m",
  fog: "\x1b[38;5;97m",
  cyan: "\x1b[38;5;117m",
  teal: "\x1b[38;5;111m",
  blue: "\x1b[38;5;39m",
  green: "\x1b[38;5;50m",
  lime: "\x1b[38;5;87m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;213m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  panelBg: "\x1b[49m",
  panelAltBg: "\x1b[48;5;233m",
  panelHiBg: "\x1b[48;5;234m",
};

const toneTheme = {
  ink: { fg: color.ink, bg: "\x1b[49m" },
  slate: { fg: color.slate, bg: "\x1b[49m" },
  cyan: { fg: color.cyan, bg: "\x1b[49m" },
  teal: { fg: color.teal, bg: "\x1b[49m" },
  blue: { fg: color.blue, bg: "\x1b[49m" },
  green: { fg: color.green, bg: "\x1b[49m" },
  lime: { fg: color.lime, bg: "\x1b[49m" },
  yellow: { fg: color.yellow, bg: "\x1b[49m" },
  amber: { fg: color.amber, bg: "\x1b[49m" },
  magenta: { fg: color.magenta, bg: "\x1b[49m" },
  red: { fg: color.red, bg: "\x1b[49m" },
};

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
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return null;
  }
  return text.replace(/^session:/, "");
}

function sessionValuesMatch(left, right) {
  const normalizedLeft = normalizeSessionValue(left);
  const normalizedRight = normalizeSessionValue(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft === normalizedRight,
  );
}

function stable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function sanitizeLargeText(value) {
  return String(value)
    .replace(
      /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
      "(image omitted)",
    )
    .replace(/"data":"[A-Za-z0-9+/=\r\n]{120,}"/g, '"data":"(image omitted)"')
    .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(blob omitted)");
}

function sanitizeInlineText(value) {
  return sanitizeLargeText(value).replace(/\s+/g, " ").trim();
}

function stripTerminalControlSequences(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

function stripMarkdownDecorators(value) {
  return stripTerminalControlSequences(String(value ?? ""))
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");
}

function sanitizeDisplayText(value) {
  return stripMarkdownDecorators(sanitizeLargeText(value));
}

function tryPrettyJson(value) {
  const raw = typeof value === "string" ? sanitizeLargeText(value) : stable(value);
  if (typeof raw !== "string") {
    return stable(raw);
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    const parts = raw.split("\n");
    if (parts.length > 1) {
      return parts
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return "";
          try {
            return JSON.stringify(JSON.parse(trimmed), null, 2);
          } catch {
            return trimmed;
          }
        })
        .join("\n");
    }
    return raw;
  }
}

function tryParseJson(value) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? value : null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, maxChars = maxInlineChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: numeric >= 10_000 ? 0 : 1,
  }).format(numeric);
}

function dismissIntro() {
  watchState.introDismissed = true;
}

function toneColor(tone) {
  return color[tone] ?? color.ink;
}

function toneSpec(tone) {
  return toneTheme[tone] ?? toneTheme.slate;
}

function badge(label, tone = "ink") {
  const spec = toneSpec(tone);
  return `${spec.fg}${color.bold}${label}${color.reset}${color.borderStrong}::${color.reset}`;
}

function chip(label, value, tone = "ink") {
  return `${badge(label, tone)} ${toneColor(tone)}${color.bold}${truncate(String(value), 32)}${color.reset}`;
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

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateAnsi(text, maxChars = maxInlineChars) {
  if (visibleLength(text) <= maxChars) {
    return text;
  }
  let index = 0;
  let visible = 0;
  let output = "";
  while (index < text.length) {
    if (text[index] === "\x1b") {
      const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (visible >= Math.max(0, maxChars - 1)) {
      output += "…";
      break;
    }
    output += text[index];
    visible += 1;
    index += 1;
  }
  return `${output}${color.reset}`;
}

function fitAnsi(text, width) {
  return visibleLength(text) > width ? truncateAnsi(text, width) : text;
}

function padAnsi(text, width) {
  const fitted = fitAnsi(text, width);
  const needed = Math.max(0, width - visibleLength(fitted));
  return `${fitted}${" ".repeat(needed)}`;
}

function wrapLine(line, width) {
  if (visibleLength(line) <= width) {
    return [line];
  }
  const stripped = line;
  const lines = [];
  let remaining = stripped;
  while (visibleLength(remaining) > width) {
    let splitAt = width;
    const rawSlice = remaining.slice(0, width + 1);
    const spaceIndex = rawSlice.lastIndexOf(" ");
    if (spaceIndex > Math.floor(width * 0.45)) {
      splitAt = spaceIndex;
    }
    lines.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines;
}

function wrapBlock(text, width) {
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
}

function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatClockLabel(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "--:--:--";
  }
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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
  const frames = ["◐", "◓", "◑", "◒"];
  const frameIndex = Math.floor(nowMs() / activityPulseIntervalMs) % frames.length;
  return frames[frameIndex] ?? frames[0];
}

function onSurface(text, bg) {
  return `${bg}${String(text).replace(/\x1b\[0m/g, `${color.reset}${bg}`)}${color.reset}`;
}

function paintSurface(text, width, bg) {
  return onSurface(padAnsi(text, width), bg);
}

function flexBetween(left, right, width) {
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 1 > width) {
    return fitAnsi(`${left} ${right}`, width);
  }
  return `${left}${" ".repeat(Math.max(1, width - leftLen - rightLen))}${right}`;
}

function blankRow(width) {
  return " ".repeat(width);
}

function normalizeModelRoute(input = {}) {
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

function formatModelRouteLabel(route, { includeProvider = true } = {}) {
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

function modelRouteTone(route) {
  if (!route) return "slate";
  if (route.usedFallback) return "amber";
  return watchState.liveSessionModelRoute ? "teal" : "slate";
}

function eventPreviewMode(event) {
  return sanitizeInlineText(String(event?.previewMode ?? "")).toLowerCase();
}

function isSourcePreviewEvent(event) {
  const previewMode = eventPreviewMode(event);
  return (
    previewMode === "source" ||
    previewMode.startsWith("source-") ||
    /^Edit(?:ed)?\b|^Append(?:ed)?\b|^Read\b/i.test(String(event?.title ?? ""))
  );
}

function isMutationPreviewEvent(event) {
  const previewMode = eventPreviewMode(event);
  if (previewMode === "source-write" || previewMode === "source-mutation") {
    return true;
  }
  if (previewMode === "source-read") {
    return false;
  }
  return /^Edit(?:ed)?\b|^Append(?:ed)?\b/i.test(String(event?.title ?? ""));
}

function shouldSurfaceTransientStatus(value = watchState.transientStatus) {
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

function renderEventBodyLine(event, line, { inline = false } = {}) {
  const lineText = displayLineText(line);
  if (!lineText || lineText.length === 0) {
    return "";
  }
  const guide = inline
    ? `${color.borderStrong}│${color.reset} `
    : `${color.border}│${color.reset} `;
  const prefix = `${inline ? "  " : ""}${guide}`;
  const entry =
    typeof line === "string"
      ? createDisplayLine(line, isSourcePreviewEvent(event) ? "code" : "plain")
      : line;
  return `${prefix}${renderDisplayLine(entry, {
    color,
    cwd: process.cwd(),
    enableHyperlinks: enableWatchHyperlinks,
  })}`;
}

function stateTone(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (/(error|failed|stopped|cancelled|blocked)/.test(normalized)) return "red";
  if (/(live|running|ready|completed|ok)/.test(normalized)) return "cyan";
  if (/idle/.test(normalized)) return "magenta";
  if (/(typing|thinking|queued|starting|connecting|reconnecting|pause|pending|refresh)/.test(normalized)) return "amber";
  if (/(generating|active|stream)/.test(normalized)) return "magenta";
  return "slate";
}

function panelTop(width, tone = "slate") {
  const inner = width - 2;
  const accent = Math.min(10, Math.max(3, Math.floor(inner * 0.14)));
  return `${color.border}┌${toneColor(tone)}${"─".repeat(accent)}${color.borderStrong}${"─".repeat(Math.max(0, inner - accent))}${color.reset}${color.border}┐${color.reset}`;
}

function panelBottom(width) {
  return `${color.border}└${color.borderStrong}${"─".repeat(Math.max(0, width - 2))}${color.reset}${color.border}┘${color.reset}`;
}

function panelRow(text, width, bg = color.panelBg) {
  const inner = width - 2;
  return `${color.border}│${color.reset}${paintSurface(text, inner, bg)}${color.border}│${color.reset}`;
}

function renderPanel({ title, subtitle = null, tone = "slate", width, bg = color.panelBg, lines = [] }) {
  const inner = width - 2;
  const titleLine = subtitle
    ? flexBetween(
      `${toneColor(tone)}${color.bold}${title}${color.reset}`,
      `${color.fog}${subtitle}${color.reset}`,
      inner,
    )
    : `${toneColor(tone)}${color.bold}${title}${color.reset}`;
  const normalizedLines = lines.map((entry) => (
    typeof entry === "string" ? { text: entry, bg } : { text: entry?.text ?? "", bg: entry?.bg ?? bg }
  ));
  return [
    panelTop(width, tone),
    panelRow(titleLine, width, bg),
    ...normalizedLines.map((line) => panelRow(line.text, width, line.bg)),
    panelBottom(width),
  ];
}

function row(text = "", bg = color.panelBg) {
  return { text, bg };
}

function wrapAndLimit(text, width, maxLines = 2) {
  const lines = wrapBlock(sanitizeLargeText(String(text ?? "")), width);
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines), `+${lines.length - maxLines} more`];
}

function formatMetric(label, value, width, tone = "slate") {
  return flexBetween(
    `${color.fog}${label.toUpperCase()}${color.reset}`,
    `${toneColor(tone)}${color.bold}${truncate(sanitizeInlineText(String(value ?? "n/a")), 34)}${color.reset}`,
    width,
  );
}

function joinColumns(leftLines, rightLines, leftWidth, rightWidth, gap = 2) {
  const totalRows = Math.max(leftLines.length, rightLines.length);
  const gapSpacer = " ".repeat(gap);
  const lines = [];
  for (let index = 0; index < totalRows; index += 1) {
    const left = leftLines[index] ? padAnsi(leftLines[index], leftWidth) : blankRow(leftWidth);
    const right = rightLines[index] ? padAnsi(rightLines[index], rightWidth) : blankRow(rightWidth);
    lines.push(`${left}${gapSpacer}${right}`);
  }
  return lines;
}

function parseStructuredJson(value) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? [value] : [];
  }
  const single = tryParseJson(value);
  if (single && typeof single === "object" && !Array.isArray(single)) {
    return [single];
  }
  return value
    .split("\n")
    .map((line) => tryParseJson(line.trim()))
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function compactBodyLines(value, maxLines = 4) {
  const lines = sanitizeDisplayText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[\[\]{}(),]+$/.test(line));
  if (lines.length === 0) {
    const fallback = sanitizeInlineText(stripMarkdownDecorators(value ?? ""));
    return fallback ? [fallback] : [];
  }
  return lines.slice(0, maxLines).map((line) => truncate(line, maxInlineChars));
}

function eventBodyLines(value, maxLines = Infinity) {
  const lines = sanitizeLargeText(String(value ?? "(empty)"))
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((line) => line.replace(/\r/g, "").replace(/\s+$/g, ""));
  const normalized = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push("");
    } else {
      blankRun = 0;
      normalized.push(line);
    }
    if (normalized.length >= maxLines) {
      break;
    }
  }
  if (normalized.length === 0) {
    return ["(empty)"];
  }
  return normalized;
}

function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text: String(text ?? ""),
    plainText: String(text ?? ""),
    mode,
    ...metadata,
  };
}

function displayLineText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.text ?? "");
}

function displayLinePlainText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.plainText ?? line?.text ?? "");
}

function isMarkdownRenderableEvent(event) {
  return (
    event?.renderMode === "markdown" ||
    event?.kind === "agent" ||
    event?.kind === "subagent"
  );
}

function normalizeDisplayLines(lines, maxLines = Infinity) {
  const normalized = [];
  let blankRun = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const entry =
      typeof line === "string" ? createDisplayLine(line) : line && typeof line === "object"
        ? line
        : createDisplayLine("", "blank");
    if (displayLineText(entry).trim().length === 0 || entry.mode === "blank") {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push(createDisplayLine("", "blank"));
    } else {
      blankRun = 0;
      normalized.push(entry);
    }
    if (normalized.length >= maxLines) {
      break;
    }
  }
  return normalized.length > 0 ? normalized : [createDisplayLine("(empty)", "plain")];
}

function buildEventDisplayLines(event, maxLines = Infinity) {
  const signature = buildWatchRenderCacheSignature(event);
  return getCachedEventDisplayLines(
    watchRenderCache,
    event,
    signature,
    () => {
      if (isDiffRenderableEvent(event)) {
        const diffLines = buildDiffDisplayLines(event, {
          cwd: process.cwd(),
          maxPathChars: 72,
        });
        if (diffLines.length > 0) {
          return normalizeDisplayLines(diffLines);
        }
      }
      if (isSourcePreviewEvent(event)) {
        return normalizeDisplayLines(buildSourcePreviewDisplayLines(event));
      }
      if (isMarkdownRenderableEvent(event)) {
        return normalizeDisplayLines(
          (event?.streamState === "streaming"
            ? buildStreamingMarkdownDisplayLines
            : buildMarkdownDisplayLines)(
            stripTerminalControlSequences(sanitizeLargeText(event.body ?? "")),
          ),
        );
      }
      return normalizeDisplayLines(
        eventBodyLines(event.body).map((line) => createDisplayLine(line, "plain")),
      );
    },
    { maxLines },
  );
}

function wrapDisplayLines(lines, width) {
  return wrapRichDisplayLines(lines, width);
}

function wrapEventDisplayLines(event, width, maxLines = Infinity) {
  const signature = buildWatchRenderCacheSignature(event);
  return getCachedWrappedDisplayLines(
    watchRenderCache,
    event,
    signature,
    width,
    maxLines,
    () => wrapDisplayLines(buildEventDisplayLines(event, maxLines), width),
  );
}

function summarizeUsage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const parts = [];
  const prompt = formatCompactNumber(payload.promptTokens);
  const total = formatCompactNumber(payload.totalTokens);
  const maxOutput = formatCompactNumber(payload.maxOutputTokens);
  if (prompt) parts.push(`${prompt} prompt`);
  if (total) parts.push(`${total} total`);
  if (maxOutput) parts.push(`${maxOutput} max out`);
  if (payload.compacted) parts.push("compacted");
  return parts.length > 0 ? parts.join(" / ") : null;
}

function firstMeaningfulLine(value) {
  if (typeof value !== "string") return null;
  const line = sanitizeLargeText(value)
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? truncate(line, 160) : null;
}

function contentPreviewLines(value, maxLines = 3) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  return sanitizeLargeText(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r/g, "").trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .map((line) => truncate(line, 160));
}

function compactSessionToken(value, maxChars = 8) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) return null;
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function planStatusTone(value) {
  switch (value) {
    case "completed":
      return "green";
    case "running":
      return "magenta";
    case "failed":
      return "red";
    case "cancelled":
      return "amber";
    case "blocked":
      return "amber";
    default:
      return "slate";
  }
}

function planStatusGlyph(value) {
  switch (value) {
    case "completed":
      return "[x]";
    case "running":
      return "[~]";
    case "failed":
      return "[!]";
    case "cancelled":
      return "[-]";
    case "blocked":
      return "[?]";
    default:
      return "[ ]";
  }
}

function sanitizePlanLabel(value, fallback = "unnamed task") {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return fallback;
  }
  return text.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function plannerDagStatusTone(value) {
  switch (value) {
    case "completed":
      return "green";
    case "running":
      return "cyan";
    case "failed":
      return "red";
    case "cancelled":
      return "amber";
    case "blocked":
      return "amber";
    default:
      return "slate";
  }
}

function plannerDagStatusGlyph(value) {
  switch (value) {
    case "completed":
      return "●";
    case "running":
      return "◉";
    case "failed":
      return "✕";
    case "cancelled":
      return "◌";
    case "blocked":
      return "◍";
    default:
      return "○";
  }
}

function plannerDagTypeGlyph(value) {
  switch (value) {
    case "subagent_task":
      return "A";
    case "deterministic_tool":
      return "T";
    case "synthesis":
      return "Σ";
    default:
      return "•";
  }
}

function resetPlannerDagState() {
  plannerDagNodes.clear();
  plannerDagEdges.length = 0;
  watchState.plannerDagPipelineId = null;
  watchState.plannerDagStatus = "idle";
  watchState.plannerDagNote = null;
  watchState.plannerDagUpdatedAt = 0;
  watchState.plannerDagHydratedSessionId = null;
}

function findTrackedPlannerDagKey(input = {}) {
  const candidates = [
    sanitizeInlineText(input.stepName ?? input.name ?? ""),
    sanitizeInlineText(input.objective ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (plannerDagNodes.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function ensurePlannerDagNode(input = {}) {
  const stepName = sanitizeInlineText(
    input.stepName ?? input.name ?? input.objective ?? "",
  );
  if (!stepName) {
    return null;
  }
  let node = plannerDagNodes.get(stepName);
  if (!node) {
    node = {
      key: stepName,
      stepName,
      objective: null,
      stepType: "subagent_task",
      status: "planned",
      note: null,
      order: Number.isFinite(Number(input.order))
        ? Number(input.order)
        : plannerDagNodes.size,
      tool: null,
      subagentSessionId: null,
    };
    plannerDagNodes.set(stepName, node);
  }
  if (typeof input.objective === "string" && input.objective.trim()) {
    node.objective = sanitizeInlineText(input.objective);
  }
  if (typeof input.stepType === "string" && input.stepType.trim()) {
    node.stepType = sanitizeInlineText(input.stepType);
  }
  if (typeof input.status === "string" && input.status.trim()) {
    node.status = sanitizeInlineText(input.status);
  }
  if (typeof input.note === "string" && input.note.trim()) {
    node.note = sanitizeInlineText(input.note);
  }
  if (typeof input.tool === "string" && input.tool.trim()) {
    node.tool = sanitizeInlineText(input.tool);
  }
  if (typeof input.subagentSessionId === "string" && input.subagentSessionId.trim()) {
    node.subagentSessionId = sanitizeInlineText(input.subagentSessionId);
  }
  if (Number.isFinite(Number(input.order))) {
    node.order = Number(input.order);
  }
  watchState.plannerDagUpdatedAt = nowMs();
  return node;
}

function syncPlannerDagEdges(steps = [], edges = [], options = {}) {
  const merge = options?.merge === true;
  const nextEdges = merge
    ? plannerDagEdges.map((edge) => ({ from: edge.from, to: edge.to }))
    : [];
  const seen = new Set(nextEdges.map((edge) => `${edge.from}->${edge.to}`));
  const pushEdge = (from, to) => {
    const left = sanitizeInlineText(from);
    const right = sanitizeInlineText(to);
    if (!left || !right || left === right) {
      return;
    }
    const fingerprint = `${left}->${right}`;
    if (seen.has(fingerprint)) {
      return;
    }
    seen.add(fingerprint);
    nextEdges.push({ from: left, to: right });
  };

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge || typeof edge !== "object") {
      continue;
    }
    pushEdge(edge.from, edge.to);
  }

  for (const step of Array.isArray(steps) ? steps : []) {
    const stepName = sanitizeInlineText(step?.name ?? "");
    if (!stepName || !Array.isArray(step?.dependsOn)) {
      continue;
    }
    for (const dependency of step.dependsOn) {
      pushEdge(dependency, stepName);
    }
  }

  plannerDagEdges.length = 0;
  plannerDagEdges.push(...nextEdges);
}

function recomputePlannerDagStatus() {
  const nodes = [...plannerDagNodes.values()];
  if (nodes.length === 0) {
    watchState.plannerDagStatus = "idle";
    return;
  }
  if (nodes.some((node) => node.status === "failed")) {
    watchState.plannerDagStatus = "failed";
    return;
  }
  if (nodes.some((node) => node.status === "blocked")) {
    watchState.plannerDagStatus = "blocked";
    return;
  }
  if (nodes.some((node) => node.status === "running")) {
    watchState.plannerDagStatus = "running";
    return;
  }
  if (nodes.every((node) => node.status === "completed")) {
    watchState.plannerDagStatus = "completed";
    return;
  }
  watchState.plannerDagStatus = "planned";
}

function updatePlannerDagNode(input = {}) {
  const node = ensurePlannerDagNode(input);
  if (!node) {
    return null;
  }
  recomputePlannerDagStatus();
  return node;
}

function retirePlannerDagOpenNodes(status = "cancelled", note = null) {
  const nextStatus = sanitizeInlineText(status) || "cancelled";
  const nextNote = sanitizeInlineText(note ?? "");
  let changed = false;
  for (const node of plannerDagNodes.values()) {
    if (
      node.status !== "planned" &&
      node.status !== "running" &&
      node.status !== "blocked"
    ) {
      continue;
    }
    node.status = nextStatus;
    if (
      nextNote &&
      (
        !node.note ||
        node.note === sanitizeInlineText(node.stepName ?? "") ||
        node.note === sanitizeInlineText(node.objective ?? "") ||
        node.note === "planner refinement requested"
      )
    ) {
      node.note = nextNote;
    }
    changed = true;
  }
  if (changed) {
    watchState.plannerDagUpdatedAt = nowMs();
  }
}

function inferMergedPlannerDagOrder(stepName, payload = {}, fallbackOrder = 0) {
  const parents = Array.isArray(payload?.dependsOn)
    ? payload.dependsOn
      .map((dependency) => plannerDagNodes.get(sanitizeInlineText(dependency))?.order)
      .filter((value) => Number.isFinite(value))
    : [];
  if (parents.length > 0) {
    return Math.max(...parents) + 1;
  }

  const children = (Array.isArray(payload?.edges) ? payload.edges : [])
    .filter((edge) => sanitizeInlineText(edge?.from ?? "") === stepName)
    .map((edge) => plannerDagNodes.get(sanitizeInlineText(edge?.to ?? ""))?.order)
    .filter((value) => Number.isFinite(value));
  if (children.length > 0) {
    return Math.min(...children) - 1;
  }

  return fallbackOrder;
}

function ingestPlannerDag(payload = {}, options = {}) {
  const merge = options?.merge === true;
  if (!merge) {
    resetPlannerDagState();
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  let nextMergedOrder = plannerDagNodes.size > 0
    ? Math.max(...[...plannerDagNodes.values()].map((node) => node.order)) + 10
    : 0;
  for (const [index, step] of steps.entries()) {
    const stepName = sanitizeInlineText(step?.name ?? "");
    const alreadyTracked = stepName ? plannerDagNodes.has(stepName) : false;
    let order = index * 10;
    if (merge && !alreadyTracked) {
      order = inferMergedPlannerDagOrder(stepName, payload, nextMergedOrder);
      nextMergedOrder = Math.max(nextMergedOrder + 10, Math.ceil(order) + 10);
    }
    ensurePlannerDagNode({
      stepName,
      objective: step?.objective,
      stepType: step?.stepType,
      status: "planned",
      note: step?.objective ?? step?.stepType ?? null,
      ...(merge && alreadyTracked ? {} : { order }),
    });
  }
  syncPlannerDagEdges(steps, payload.edges, { merge });
  watchState.plannerDagPipelineId = sanitizeInlineText(payload.pipelineId ?? "");
  watchState.plannerDagNote = sanitizeInlineText(
    payload.routeReason ??
      payload.reason ??
      payload.stopReasonDetail ??
      payload.stopReason ??
      "",
  ) || null;
  recomputePlannerDagStatus();
}

function plannerTraceSessionPrefix(sessionValue) {
  const normalized = normalizeSessionValue(sessionValue);
  if (!normalized) {
    return null;
  }
  return `session_${normalized.replace(/[^a-zA-Z0-9._-]+/g, "_")}_`;
}

function listPlannerTraceArtifactsForSession(sessionValue) {
  const prefix = plannerTraceSessionPrefix(sessionValue);
  if (!prefix || !fs.existsSync(tracePayloadRoot)) {
    return [];
  }
  const artifacts = [];
  for (const entry of fs.readdirSync(tracePayloadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const directoryPath = path.join(tracePayloadRoot, entry.name);
    for (const fileName of fs.readdirSync(directoryPath)) {
      if (!fileName.includes("planner_plan_parsed") || !fileName.endsWith(".json")) {
        continue;
      }
      const artifactPath = path.join(directoryPath, fileName);
      let sortStamp = 0;
      const prefixMatch = fileName.match(/^(\d+)-/);
      if (prefixMatch) {
        sortStamp = Number(prefixMatch[1]) || 0;
      }
      if (!Number.isFinite(sortStamp) || sortStamp <= 0) {
        try {
          sortStamp = fs.statSync(artifactPath).mtimeMs;
        } catch {
          sortStamp = 0;
        }
      }
      artifacts.push({ artifactPath, sortStamp });
    }
  }
  artifacts.sort((left, right) => left.sortStamp - right.sortStamp);
  return artifacts.map((entry) => entry.artifactPath);
}

function readPlannerTracePayload(artifactPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const payload =
      parsed?.payload?.payload &&
      typeof parsed.payload.payload === "object" &&
      !Array.isArray(parsed.payload.payload)
        ? parsed.payload.payload
        : parsed?.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
          ? parsed.payload
          : null;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function hydratePlannerDagFromTraceArtifacts(sessionValue, options = {}) {
  const normalized = normalizeSessionValue(sessionValue);
  if (!normalized) {
    return false;
  }
  const force = options?.force === true;
  if (!force && watchState.plannerDagHydratedSessionId === normalized && plannerDagNodes.size > 1) {
    return false;
  }
  if (!force && plannerDagNodes.size > 1) {
    return false;
  }
  const artifacts = listPlannerTraceArtifactsForSession(sessionValue);
  if (artifacts.length === 0) {
    return false;
  }
  let hydrated = false;
  resetPlannerDagState();
  for (const [index, artifactPath] of artifacts.entries()) {
    const payload = readPlannerTracePayload(artifactPath);
    if (!payload) {
      continue;
    }
    const attempt = Number(payload.attempt);
    ingestPlannerDag(payload, {
      merge: hydrated && Number.isFinite(attempt) ? attempt > 1 : index > 0,
    });
    hydrated = true;
  }
  if (hydrated) {
    watchState.plannerDagHydratedSessionId = normalized;
  }
  return hydrated;
}

function hydratePlannerDagForLiveSession(options = {}) {
  if (!watchState.sessionId) {
    return false;
  }
  const force = options?.force === true;
  if (!force && plannerDagNodes.size > 1) {
    return false;
  }
  return hydratePlannerDagFromTraceArtifacts(watchState.sessionId, { force });
}

function ensureSubagentPlanStep(input = {}) {
  const stepName = sanitizeInlineText(input.stepName ?? "");
  const objective = sanitizeInlineText(input.objective ?? "");
  const sessionId = sanitizeInlineText(input.subagentSessionId ?? "");

  let key = null;
  if (sessionId && subagentSessionPlanKeys.has(sessionId)) {
    key = subagentSessionPlanKeys.get(sessionId);
  }
  if (!key && stepName) {
    key = `step:${stepName}`;
  }
  if (!key && sessionId) {
    key = `child:${sessionId}`;
  }
  if (!key && objective) {
    key = `objective:${objective}`;
  }
  if (!key) {
    return null;
  }

  let step = subagentPlanSteps.get(key);
  if (!step) {
    step = {
      key,
      order: ++watchState.planStepSequence,
      stepName: stepName || null,
      objective: objective || null,
      status: "planned",
      note: null,
      subagentSessionId: sessionId || null,
      updatedAt: nowMs(),
    };
    subagentPlanSteps.set(key, step);
  }

  if (stepName) {
    step.stepName = stepName;
  }
  if (objective) {
    step.objective = objective;
  }
  if (sessionId) {
    step.subagentSessionId = sessionId;
    subagentSessionPlanKeys.set(sessionId, key);
  }
  step.updatedAt = nowMs();
  return step;
}

function updateSubagentPlanStep(input = {}) {
  const step = ensureSubagentPlanStep(input);
  if (!step) {
    return null;
  }
  if (input.status) {
    step.status = input.status;
  }
  if (input.note) {
    step.note = sanitizeInlineText(input.note);
  }
  const dagKey = findTrackedPlannerDagKey({
    stepName: step.stepName,
    objective: step.objective,
  });
  if (dagKey || plannerDagNodes.size === 0) {
    updatePlannerDagNode({
      stepName: dagKey ?? step.stepName ?? step.objective,
      objective: step.objective,
      status: step.status,
      note: step.note,
      stepType: "subagent_task",
      subagentSessionId: step.subagentSessionId,
    });
  }
  return step;
}

function planStepDisplayName(step, maxChars = 28) {
  const base = step?.stepName ||
    sanitizePlanLabel(step?.objective, step?.subagentSessionId || "child");
  return truncate(base, maxChars);
}

function normalizeEventBody(body) {
  const normalizedBody = stripTerminalControlSequences(tryPrettyJson(body || "(empty)"));
  return {
    body:
      normalizedBody.length > maxStoredBodyChars
        ? `${normalizedBody.slice(0, maxStoredBodyChars - 1)}…`
        : normalizedBody,
    bodyTruncated: normalizedBody.length > maxStoredBodyChars,
  };
}

function normalizeOptionalEventText(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return normalizeEventBody(value).body;
}

function normalizeOptionalFileRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next = {};
  for (const key of ["afterLine", "startLine", "endLine", "startColumn", "endColumn"]) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) {
      next[key] = numeric;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function renderMetadataPayload(metadata = {}) {
  return {
    previewMode: metadata.previewMode ?? null,
    filePath: metadata.filePath ?? null,
    fileRange: metadata.fileRange ?? null,
    mutationKind: metadata.mutationKind ?? null,
    mutationBeforeText: metadata.mutationBeforeText ?? null,
    mutationAfterText: metadata.mutationAfterText ?? null,
  };
}

function buildRenderSignature(metadata = {}) {
  return stable(renderMetadataPayload(metadata));
}

function applyDescriptorRenderingMetadata(target, descriptor = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  const previewMode =
    typeof descriptor.previewMode === "string" && descriptor.previewMode.trim().length > 0
      ? descriptor.previewMode
      : undefined;
  const filePath =
    typeof descriptor.filePath === "string" && descriptor.filePath.trim().length > 0
      ? sanitizeInlineText(descriptor.filePath)
      : undefined;
  const fileRange = normalizeOptionalFileRange(descriptor.fileRange);
  const mutationKind =
    typeof descriptor.mutationKind === "string" && descriptor.mutationKind.trim().length > 0
      ? descriptor.mutationKind.trim().toLowerCase()
      : undefined;
  const mutationBeforeText = normalizeOptionalEventText(descriptor.mutationBeforeText);
  const mutationAfterText = normalizeOptionalEventText(descriptor.mutationAfterText);

  for (const [key, value] of Object.entries({
    previewMode,
    filePath,
    fileRange,
    mutationKind,
    mutationBeforeText,
    mutationAfterText,
  })) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  target.renderSignature = buildRenderSignature(target);
  return target;
}

function descriptorEventMetadata(descriptor = {}, extra = {}) {
  return applyDescriptorRenderingMetadata({ ...extra }, descriptor);
}

function sourceFileRangeLabel(fileRange) {
  if (!fileRange || typeof fileRange !== "object") {
    return null;
  }
  if (Number.isFinite(Number(fileRange.afterLine))) {
    return `after line ${Number(fileRange.afterLine)}`;
  }
  if (
    Number.isFinite(Number(fileRange.startLine)) &&
    Number.isFinite(Number(fileRange.endLine))
  ) {
    return `lines ${Number(fileRange.startLine)}-${Number(fileRange.endLine)}`;
  }
  if (Number.isFinite(Number(fileRange.startLine))) {
    return `line ${Number(fileRange.startLine)}`;
  }
  return null;
}

function buildSourcePreviewDisplayLines(event) {
  const rawLines = eventBodyLines(event.body);
  const lines = [];
  const filePath =
    typeof event?.filePath === "string" && event.filePath.trim().length > 0
      ? event.filePath
      : null;
  const rangeLabel = sourceFileRangeLabel(event?.fileRange);

  let contentLines = rawLines;
  if (filePath && /^path:\s+/i.test(String(rawLines[0] ?? ""))) {
    contentLines = rawLines.slice(1);
    while (contentLines.length > 0 && contentLines[0].trim().length === 0) {
      contentLines = contentLines.slice(1);
    }
  }

  if (filePath) {
    const compactPath = compactFileReference(filePath, {
      cwd: process.cwd(),
      maxChars: 72,
    });
    lines.push(
      createDisplayLine(
        rangeLabel ? `${compactPath} · ${rangeLabel}` : compactPath,
        "file-link",
        {
          filePath,
          fileRange: event?.fileRange,
          fileLinkText: compactPath,
        },
      ),
    );
    if (contentLines.length > 0) {
      lines.push(createDisplayLine("", "blank"));
    }
  }

  return lines.concat(contentLines.map((line) => createDisplayLine(line, "code")));
}

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

function formatCommandPaletteText(command) {
  const aliasSuffix =
    Array.isArray(command.aliases) && command.aliases.length > 0
      ? `  ${color.fog}${command.aliases.join(", ")}${color.reset}`
      : "";
  return `${color.magenta}${command.usage}${color.reset}${aliasSuffix}\n${color.softInk}${command.description}${color.reset}`;
}

function formatSessionSummaries(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return "No resumable sessions found.";
  }
  return payload
    .map((session) => {
      const when = session?.lastActiveAt
        ? new Date(session.lastActiveAt).toLocaleString("en-US", {
          hour12: false,
        })
        : "unknown";
      return [
        `session: ${session?.sessionId ?? "unknown"}`,
        `label: ${session?.label ?? "n/a"}`,
        `messages: ${session?.messageCount ?? 0}`,
        `last active: ${when}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatHistoryPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return "No history for this session.";
  }
  return payload
    .map((entry) => {
      const stamp = entry?.timestamp
        ? new Date(entry.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
        })
        : "--:--:--";
      const sender = String(entry?.sender ?? "unknown").toUpperCase();
      const content = sanitizeDisplayText(entry?.content ?? "(empty)");
      return `${stamp} ${sender}\n${content}`;
    })
    .join("\n\n");
}

function formatStatusPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return tryPrettyJson(payload ?? {});
  }
  const heapUsedMB = Number(payload.memoryUsage?.heapUsedMB);
  const rssMB = Number(payload.memoryUsage?.rssMB);
  const backgroundRuns = payload.backgroundRuns;
  return [
    `state: ${payload.state ?? "unknown"}`,
    `uptime: ${formatCompactNumber(payload.uptimeMs) ?? payload.uptimeMs ?? "n/a"} ms`,
    `active sessions: ${payload.activeSessions ?? "n/a"}`,
    `control plane: ${payload.controlPlanePort ?? "n/a"}`,
    `pid: ${payload.pid ?? "n/a"}`,
    `heap: ${Number.isFinite(heapUsedMB) ? `${heapUsedMB.toFixed(2)} MB` : "n/a"}`,
    `rss: ${Number.isFinite(rssMB) ? `${rssMB.toFixed(2)} MB` : "n/a"}`,
    `llm: ${payload.llmProvider && payload.llmModel ? `${payload.llmProvider}:${payload.llmModel}` : "n/a"}`,
    `agent: ${payload.agentName ?? "n/a"}`,
    `channels: ${Array.isArray(payload.channels) ? payload.channels.join(", ") : "n/a"}`,
    `durable runs: ${!backgroundRuns
      ? "pending"
      : backgroundRuns.enabled
        ? "enabled"
        : `disabled (${backgroundRuns.disabledReason ?? backgroundRuns.disabledCode ?? "unknown"})`}`,
    `durable operator: ${!backgroundRuns
      ? "pending"
      : backgroundRuns.operatorAvailable
        ? "ready"
        : backgroundRuns.disabledReason ?? "unavailable"}`,
    `active durable runs: ${Number.isFinite(Number(backgroundRuns?.activeTotal))
      ? Number(backgroundRuns.activeTotal)
      : "n/a"}`,
    `queued wake signals: ${Number.isFinite(Number(backgroundRuns?.queuedSignalsTotal))
      ? Number(backgroundRuns.queuedSignalsTotal)
      : "n/a"}`,
  ].join("\n");
}

function statusFeedFingerprint(payload) {
  if (!payload || typeof payload !== "object") {
    return "none";
  }
  return JSON.stringify({
    state: typeof payload.state === "string" ? payload.state : null,
    agentName: typeof payload.agentName === "string" ? payload.agentName : null,
    pid: Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
    activeSessions: Number.isFinite(Number(payload.activeSessions))
      ? Number(payload.activeSessions)
      : null,
    activeRuns: Number.isFinite(Number(payload.backgroundRuns?.activeTotal))
      ? Number(payload.backgroundRuns.activeTotal)
      : null,
    queuedSignals: Number.isFinite(Number(payload.backgroundRuns?.queuedSignalsTotal))
      ? Number(payload.backgroundRuns.queuedSignalsTotal)
      : null,
    durableRunsEnabled:
      typeof payload.backgroundRuns?.enabled === "boolean"
        ? payload.backgroundRuns.enabled
        : null,
    durableOperatorAvailable:
      typeof payload.backgroundRuns?.operatorAvailable === "boolean"
        ? payload.backgroundRuns.operatorAvailable
        : null,
    durableDisabledCode:
      typeof payload.backgroundRuns?.disabledCode === "string"
        ? payload.backgroundRuns.disabledCode
        : null,
  });
}

function formatLogPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return tryPrettyJson(payload ?? {});
  }
  if (Array.isArray(payload.lines) && payload.lines.length > 0) {
    return payload.lines.join("\n");
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text;
  }
  return tryPrettyJson(payload);
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

function buildToolSummary(parsed) {
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? [parsed]
      : [];
  if (entries.length === 0) {
    return [];
  }
  const lines = [];
  const seen = new Set();
  const add = (key, value) => {
    if (value === undefined || value === null || value === "" || seen.has(key)) {
      return;
    }
    lines.push(`${key}: ${String(value)}`);
    seen.add(key);
  };
  for (const parsedEntry of entries) {
    add("state", parsedEntry.executor_state ?? parsedEntry.state);
    add("status", parsedEntry.status);
    add("ready", parsedEntry.ready);
    add("label", parsedEntry.label);
    add("serverId", parsedEntry.serverId);
    add("processId", parsedEntry.processId);
    add("sessionId", parsedEntry.sessionId);
    add("port", parsedEntry.port);
    add("url", parsedEntry.healthUrl ?? parsedEntry.currentUrl ?? parsedEntry.url);
    add("title", parsedEntry.title);
    add("pid", parsedEntry.pid);
    add("exitCode", parsedEntry.exitCode);
    add("scenario", parsedEntry.scenario);
    add("god mode", parsedEntry.god_mode_enabled);
    add("artifact", parsedEntry.mimeType);
    if (typeof parsedEntry.error === "string") {
      add("error", sanitizeInlineText(parsedEntry.error));
    }
    if (typeof parsedEntry.message === "string") {
      add("message", sanitizeInlineText(parsedEntry.message));
    }
    if (typeof parsedEntry.stderr === "string" && parsedEntry.stderr.trim()) {
      add("stderr", sanitizeInlineText(parsedEntry.stderr.split("\n")[0]));
    }
    if (Array.isArray(parsedEntry.objectives) && parsedEntry.objectives.length > 0) {
      add("objective", parsedEntry.objectives[0]?.type);
    }
    if (
      parsedEntry.objective &&
      typeof parsedEntry.objective === "object" &&
      !Array.isArray(parsedEntry.objective)
    ) {
      add("objective", parsedEntry.objective.type);
    }
    if (
      parsedEntry.game_variables &&
      typeof parsedEntry.game_variables === "object" &&
      !Array.isArray(parsedEntry.game_variables)
    ) {
      add("health", parsedEntry.game_variables.HEALTH);
      add("armor", parsedEntry.game_variables.ARMOR);
      add("kills", parsedEntry.game_variables.KILLCOUNT);
    }
    if (
      typeof parsedEntry.recentOutput === "string" &&
      parsedEntry.recentOutput.trim()
    ) {
      lines.push(`recent output: ${truncate(sanitizeInlineText(parsedEntry.recentOutput.trim()), 180)}`);
    }
  }
  return lines.slice(0, 8);
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

function summarizeRunDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const lines = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`${label}: ${String(value)}`);
  };
  add("objective", detail.objective ?? watchState.currentObjective);
  add("phase", detail.currentPhase ?? watchState.runPhase);
  add("state", detail.state ?? watchState.runState);
  add("explanation", detail.explanation);
  add("last update", detail.lastUserUpdate);
  add("verified evidence", detail.lastToolEvidence);
  add("carry-forward", detail.carryForwardSummary);
  add("blocker", detail.blockerSummary);
  add("next check", detail.nextCheckAt ? new Date(detail.nextCheckAt).toLocaleTimeString("en-US", { hour12: false }) : undefined);
  add("next heartbeat", detail.nextHeartbeatAt ? new Date(detail.nextHeartbeatAt).toLocaleTimeString("en-US", { hour12: false }) : undefined);
  add("pending signals", detail.pendingSignals);
  add("watches", detail.watchCount);
  return lines.slice(0, 10);
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

function isExpectedMissingRunInspect(errorText, errorPayload) {
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

function isUnavailableBackgroundRunInspect(errorPayload) {
  return (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    errorPayload.code === "background_run_unavailable"
  );
}

function isRetryableBootstrapError(errorText) {
  return (
    typeof errorText === "string" &&
    (
      errorText === "Unknown message type: chat.new" ||
      errorText === "Unknown message type: chat.sessions" ||
      errorText === "Unknown message type: chat.resume"
    )
  );
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
