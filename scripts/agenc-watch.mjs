import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createOperatorInputBatcher,
  matchWatchCommands,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
  WATCH_COMMANDS,
} from "./lib/agenc-watch-helpers.mjs";

async function loadWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket;
  }

  for (const candidate of [
    "../runtime/node_modules/ws/wrapper.mjs",
    "../node_modules/ws/wrapper.mjs",
  ]) {
    try {
      return (await import(candidate)).default;
    } catch {}
  }

  throw new Error(
    "Unable to resolve a WebSocket implementation. Install `ws` or use a Node runtime with global WebSocket support.",
  );
}

const WebSocket = await loadWebSocketConstructor();

const wsUrl = process.env.AGENC_WATCH_WS_URL ?? "ws://127.0.0.1:3100";
const clientKey = process.env.AGENC_WATCH_CLIENT_KEY ?? "tmux-live-watch";
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
const maxStoredBodyChars = 48_000;
const enableMouseTracking = process.env.AGENC_WATCH_ENABLE_MOUSE !== "0";
const maxFeedPreviewLines = 3;
const maxPreviewSourceLines = 160;
const LOW_SIGNAL_SHELL_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc",
]);
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
const persistedWatchState = loadPersistedWatchState();

let requestCounter = 0;
let sessionId = persistedWatchState.sessionId;
let runState = "idle";
let runPhase = null;
let connectionState = "connecting";
let latestTool = null;
let latestToolState = null;
let latestAgentSummary = null;
let currentObjective = null;
let runDetail = null;
let activeRunStartedAtMs = null;
let runInspectPending = false;
let isOpen = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let bootstrapTimer = null;
let statusPollTimer = null;
let activityPulseTimer = null;
let bootstrapAttempts = 0;
let bootstrapReady = false;
let shuttingDown = false;
let ws = null;
let enteredAltScreen = false;
let renderPending = false;
let introDismissed = false;
let lastRenderedFrameLines = [];
let lastRenderedFrameWidth = 0;
let lastRenderedFrameHeight = 0;
const launchedAtMs = Date.now();
let sessionAttachedAtMs = launchedAtMs;
let transientStatus = "Booting watch client…";
let lastStatus = null;
let lastUsageSummary = null;
let lastActivityAt = null;
let configuredModelRoute = null;
let liveSessionModelRoute = null;
let ownerToken = persistedWatchState.ownerToken;
let manualStatusRequestPending = false;
let lastStatusFeedFingerprint = null;
let manualSessionsRequestPending = false;
let manualHistoryRequestPending = false;
let expandedEventId = null;
let composerInput = "";
let composerCursor = 0;
let composerHistory = [];
let composerHistoryIndex = -1;
let composerHistoryDraft = "";
let transcriptScrollOffset = 0;
let transcriptFollowMode = true;
let detailScrollOffset = 0;
let planStepSequence = 0;
const queuedOperatorInputs = [];
const subagentPlanSteps = new Map();
const subagentSessionPlanKeys = new Map();
const subagentLiveActivity = new Map();
const recentSubagentLifecycleFingerprints = new Map();
const plannerDagNodes = new Map();
let plannerDagEdges = [];
let plannerDagPipelineId = null;
let plannerDagStatus = "idle";
let plannerDagNote = null;
let plannerDagUpdatedAt = 0;
let plannerDagHydratedSessionId = null;
const operatorInputBatcher = createOperatorInputBatcher({
  onDispatch: (value) => {
    dispatchOperatorInput(value);
  },
});

const pendingFrames = [];
const events = [];
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

function nextId(prefix = "req") {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function nowStamp() {
  return new Date().toLocaleTimeString("en-US", {
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

function loadPersistedWatchState() {
  try {
    const raw = fs.readFileSync(watchStateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.clientKey === clientKey
    ) {
      const ownerToken =
        typeof parsed.ownerToken === "string" &&
          parsed.ownerToken.trim().length > 0
          ? parsed.ownerToken.trim()
          : null;
      const sessionId =
        typeof parsed.sessionId === "string" &&
          parsed.sessionId.trim().length > 0
          ? parsed.sessionId.trim()
          : null;
      return { ownerToken, sessionId };
    }
  } catch {}
  return { ownerToken: null, sessionId: null };
}

function persistWatchState({
  nextOwnerToken = ownerToken,
  nextSessionId = sessionId,
} = {}) {
  try {
    fs.mkdirSync(path.dirname(watchStateFile), { recursive: true });
    fs.writeFileSync(
      watchStateFile,
      `${JSON.stringify({
        clientKey,
        ownerToken:
          typeof nextOwnerToken === "string" &&
            nextOwnerToken.trim().length > 0
            ? nextOwnerToken.trim()
            : null,
        sessionId:
          typeof nextSessionId === "string" &&
            nextSessionId.trim().length > 0
            ? nextSessionId.trim()
            : null,
        updatedAt: Date.now(),
      }, null, 2)}\n`,
    );
  } catch {}
}

function persistOwnerToken(nextOwnerToken) {
  persistWatchState({ nextOwnerToken });
}

function persistSessionId(nextSessionId) {
  persistWatchState({ nextSessionId });
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

function stripMarkdownDecorators(value) {
  return String(value ?? "")
    .replace(/```/g, "")
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
  introDismissed = true;
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

function centerAnsi(text, width) {
  const fitted = fitAnsi(text, width);
  const remaining = Math.max(0, width - visibleLength(fitted));
  const leftPad = Math.floor(remaining / 2);
  const rightPad = remaining - leftPad;
  return `${" ".repeat(leftPad)}${fitted}${" ".repeat(rightPad)}`;
}

function ruleLine(width) {
  return `${color.border}${"─".repeat(Math.max(12, width))}${color.reset}`;
}

function splashProgressLevel() {
  if (bootstrapReady && connectionState === "live") return 1;
  if (sessionId) return 0.8;
  if (isOpen) return 0.58;
  if (connectionState === "reconnecting") return 0.34;
  return 0.2;
}

function termWidth() {
  return Math.max(74, process.stdout.columns || 100);
}

function termHeight() {
  return Math.max(12, process.stdout.rows || 40);
}

function currentTranscriptLayout() {
  const width = termWidth();
  const height = termHeight();
  const footerRows = 3;
  const slashMode = !expandedEventId && currentInputValue().trimStart().startsWith("/");
  const popup = expandedEventId
    ? []
    : slashMode
      ? commandPaletteLines(
        Math.min(68, Math.max(38, width - 4)),
        Math.max(4, Math.min(8, height - 12)),
      )
      : [];
  const popupRows = popup.length > 0 ? popup.length + 1 : 0;
  const header = headerLines(width);
  const bodyHeight = Math.max(8, height - header.length - footerRows - popupRows);
  const useSidebar = !expandedEventId && !slashMode && width >= 118;
  const sidebarWidth = useSidebar
    ? Math.min(48, Math.max(36, Math.floor(width * 0.3)))
    : 0;
  const transcriptWidth = useSidebar
    ? Math.max(60, width - sidebarWidth - 2)
    : width;
  return { width, height, bodyHeight, transcriptWidth, useSidebar, sidebarWidth };
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
  return formatElapsedMs(Date.now() - sessionAttachedAtMs);
}

function currentRunElapsedLabel() {
  const startedAt = Number(activeRunStartedAtMs);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return currentSessionElapsedLabel();
  }
  return formatElapsedMs(Date.now() - startedAt);
}

function animatedWorkingGlyph() {
  const frames = ["◐", "◓", "◑", "◒"];
  const frameIndex = Math.floor(Date.now() / activityPulseIntervalMs) % frames.length;
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
      : Date.now(),
  };
}

function effectiveModelRoute() {
  return liveSessionModelRoute ?? configuredModelRoute;
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
  return liveSessionModelRoute ? "teal" : "slate";
}

const SOURCE_TOKEN_RE =
  /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:import|from|export|default|const|let|var|class|function|return|if|else|for|while|switch|case|break|continue|new|throw|try|catch|finally|await|async|true|false|null|undefined|print|fn)\b|\b\d+(?:\.\d+)?\b|\b[A-Z_]{2,}\b)/g;

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

function shellCommandTokens(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }
  const tokens = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function stripShellTokenQuotes(token) {
  if (typeof token !== "string" || token.length < 2) {
    return token;
  }
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === `"` || first === "'" || first === "`") && last === first) {
    return token.slice(1, -1);
  }
  return token;
}

function firstShellCommandToken(command) {
  const tokens = shellCommandTokens(command);
  for (const token of tokens) {
    const normalized = stripShellTokenQuotes(token);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) {
      continue;
    }
    return normalized;
  }
  return null;
}

function shellCommandBasename(payload) {
  const directCommand =
    typeof payload?.command === "string" && payload.command.trim().length > 0
      ? payload.command.trim()
      : "";
  const basenameSource =
    Array.isArray(payload?.args) && directCommand && !/\s/.test(directCommand)
      ? directCommand
      : firstShellCommandToken(directCommand);
  return basenameSource ? path.basename(basenameSource) : null;
}

function isLowSignalShellCommand(payload) {
  const basename = shellCommandBasename(payload);
  return Boolean(basename && LOW_SIGNAL_SHELL_COMMANDS.has(basename));
}

function isDesktopTextEditorReadCommand(payload) {
  return editorCommandName(payload) === "view";
}

function shouldSuppressToolTranscript(toolName, args, { isError = false } = {}) {
  if (isError) {
    return false;
  }
  switch (toolName) {
    case "system.readFile":
    case "system.listDir":
      return true;
    case "system.bash":
    case "desktop.bash":
      return isLowSignalShellCommand(args);
    case "desktop.text_editor":
      return isDesktopTextEditorReadCommand(args);
    default:
      return false;
  }
}

function shouldSuppressToolActivity(toolName, args, options = {}) {
  return shouldSuppressToolTranscript(toolName, args, options);
}

function editorCommandName(payload) {
  return sanitizeInlineText(
    payload?.command ?? payload?.action ?? "",
  ).toLowerCase();
}

function editorTargetPath(payload) {
  return compactPathForDisplay(payload?.path ?? payload?.filePath);
}

function editorBodyText(payload) {
  const candidates = [
    payload?.file_text,
    payload?.text,
    payload?.new_str,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

function describeDesktopTextEditorStart(payload) {
  const command = editorCommandName(payload);
  const filePath = editorTargetPath(payload);
  const sourceText = editorBodyText(payload);
  switch (command) {
    case "create":
      return {
        title: `Create ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(pending file create)",
        tone: "yellow",
        previewMode: "source-write",
      };
    case "str_replace":
      return {
        title: `Edit ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          typeof payload?.old_str === "string" && payload.old_str.trim().length > 0
            ? `replace: ${truncate(payload.old_str, 96)}`
            : null,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(pending text replace)",
        tone: "yellow",
        previewMode: "source-write",
      };
    case "insert":
      return {
        title: `Insert ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          Number.isFinite(Number(payload?.insert_line))
            ? `after line: ${Number(payload.insert_line)}`
            : null,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(pending text insert)",
        tone: "yellow",
        previewMode: "source-write",
      };
    case "view":
      return {
        title: `Read ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          Array.isArray(payload?.view_range) && payload.view_range.length === 2
            ? `range: ${payload.view_range[0]}-${payload.view_range[1]}`
            : null,
        ].filter(Boolean).join("\n") || filePath || "(pending read)",
        tone: "slate",
        previewMode: "source-read",
      };
    case "undo_edit":
      return {
        title: `Undo ${filePath || "file"}`,
        body: filePath ? `path: ${filePath}` : "(pending undo)",
        tone: "yellow",
      };
    default:
      return {
        title: `Edit ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(pending text editor command)",
        tone: "yellow",
        previewMode: sourceText ? "source-write" : undefined,
      };
  }
}

function describeDesktopTextEditorResult(payload, resultObject, isError) {
  const command = editorCommandName(payload);
  const filePath = editorTargetPath(payload);
  const sourceText = editorBodyText(payload);
  const outputText =
    typeof resultObject?.output === "string" && resultObject.output.trim().length > 0
      ? resultObject.output
      : null;
  switch (command) {
    case "create":
    case "str_replace":
    case "insert":
      return {
        title: `${command === "create" ? "Created" : "Edited"} ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          sourceText ? null : outputText,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(file updated)",
        tone: isError ? "red" : "green",
        previewMode: "source-write",
      };
    case "view":
      return {
        title: `Read ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          "",
          outputText,
        ].filter(Boolean).join("\n") || filePath || "(file read)",
        tone: isError ? "red" : "slate",
        previewMode: "source-read",
      };
    case "undo_edit":
      return {
        title: `Undid ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          outputText,
        ].filter(Boolean).join("\n") || filePath || "(edit restored)",
        tone: isError ? "red" : "green",
      };
    default:
      return {
        title: `${isError ? "Editor failed" : "Editor updated"} ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          outputText,
          "",
          sourceText,
        ].filter(Boolean).join("\n") || filePath || "(editor completed)",
        tone: isError ? "red" : "green",
        previewMode: sourceText ? "source-write" : undefined,
      };
  }
}

function highlightSourceLine(line) {
  const raw = String(line ?? "");
  if (raw.trim().length === 0) {
    return "";
  }
  if (/^\s*\/\//.test(raw)) {
    return `${color.fog}${raw}${color.reset}`;
  }
  if (/^\s*#/.test(raw)) {
    return `${color.magenta}${color.bold}${raw}${color.reset}`;
  }
  const metaMatch = raw.match(
    /^(\s*(?:path|cwd|session|provider|model|state|status|agent|channels|tool(?: calls)?|usage|exit|step|probe|category|validation|class|duration|objective|acceptance|command|error|reason|note):)(\s*)(.*)$/i,
  );
  if (metaMatch) {
    const [, label, spacing, value] = metaMatch;
    const valueTone =
      /^(\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(value) ? color.cyan : color.softInk;
    return `${color.teal}${label}${color.reset}${spacing}${valueTone}${value}${color.reset}`;
  }

  let output = "";
  let cursor = 0;
  for (const match of raw.matchAll(SOURCE_TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      output += raw.slice(cursor, index);
    }
    const tone =
      token.startsWith('"') || token.startsWith("'") || token.startsWith("`")
        ? color.green
        : /^\d/.test(token)
          ? color.yellow
          : /^[A-Z_]{2,}$/.test(token)
            ? color.cyan
            : color.magenta;
    output += `${tone}${token}${color.reset}`;
    cursor = index + token.length;
  }
  if (cursor < raw.length) {
    output += raw.slice(cursor);
  }
  return output.length > 0 ? output : `${color.softInk}${raw}${color.reset}`;
}

function shouldSurfaceTransientStatus(value = transientStatus) {
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
  return runPhase && runPhase !== "idle"
    ? runState && runState !== "idle" && runPhase !== runState
      ? `${runState} / ${runPhase}`
      : runPhase
    : runState;
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
    currentObjective ??
      runDetail?.objective ??
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
  return sanitizeInlineText(latestTool ?? "") || fallback;
}

function renderEventBodyLine(event, line, { inline = false } = {}) {
  if (!line || line.length === 0) {
    return "";
  }
  const guide = inline
    ? `${color.borderStrong}│${color.reset} `
    : `${color.border}│${color.reset} `;
  const prefix = `${inline ? "  " : ""}${guide}`;
  if (isSourcePreviewEvent(event)) {
    return `${prefix}${highlightSourceLine(line)}`;
  }
  return `${prefix}${color.fog}${line}${color.reset}`;
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

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(numeric >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
}

function compactPathForDisplay(value, maxChars = 76) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (text.length <= maxChars) {
    return text;
  }
  const parts = text.split("/");
  if (parts.length <= 3) {
    return truncate(text, maxChars);
  }
  return truncate(`${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}`, maxChars);
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

function formatShellCommand(command, args) {
  const base = typeof command === "string" ? command.trim() : "";
  if (!base) return null;
  const argv = Array.isArray(args)
    ? args.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];
  if (argv.length === 0) {
    return truncate(base, 180);
  }
  return truncate(
    [base, ...argv.map((value) => (
      /\s/.test(value) ? JSON.stringify(value) : value
    ))].join(" "),
    180,
  );
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
  plannerDagEdges = [];
  plannerDagPipelineId = null;
  plannerDagStatus = "idle";
  plannerDagNote = null;
  plannerDagUpdatedAt = 0;
  plannerDagHydratedSessionId = null;
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
  plannerDagUpdatedAt = Date.now();
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

  plannerDagEdges = nextEdges;
}

function recomputePlannerDagStatus() {
  const nodes = [...plannerDagNodes.values()];
  if (nodes.length === 0) {
    plannerDagStatus = "idle";
    return;
  }
  if (nodes.some((node) => node.status === "failed")) {
    plannerDagStatus = "failed";
    return;
  }
  if (nodes.some((node) => node.status === "blocked")) {
    plannerDagStatus = "blocked";
    return;
  }
  if (nodes.some((node) => node.status === "running")) {
    plannerDagStatus = "running";
    return;
  }
  if (nodes.every((node) => node.status === "completed")) {
    plannerDagStatus = "completed";
    return;
  }
  plannerDagStatus = "planned";
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
    plannerDagUpdatedAt = Date.now();
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
  plannerDagPipelineId = sanitizeInlineText(payload.pipelineId ?? "");
  plannerDagNote = sanitizeInlineText(
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
  if (!force && plannerDagHydratedSessionId === normalized && plannerDagNodes.size > 1) {
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
    plannerDagHydratedSessionId = normalized;
  }
  return hydrated;
}

function hydratePlannerDagForLiveSession(options = {}) {
  if (!sessionId) {
    return false;
  }
  const force = options?.force === true;
  if (!force && plannerDagNodes.size > 1) {
    return false;
  }
  return hydratePlannerDagFromTraceArtifacts(sessionId, { force });
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
      order: ++planStepSequence,
      stepName: stepName || null,
      objective: objective || null,
      status: "planned",
      note: null,
      subagentSessionId: sessionId || null,
      updatedAt: Date.now(),
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
  step.updatedAt = Date.now();
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

function subagentLabel(payload) {
  const token = compactSessionToken(payload?.subagentSessionId);
  const data = subagentPayloadData(payload);
  const step = ensureSubagentPlanStep({
    stepName: data.stepName,
    objective: data.objective,
    subagentSessionId: payload?.subagentSessionId,
  });
  const base = step
    ? planStepDisplayName(step, token ? 22 : 30)
    : "Delegated child";
  return token ? `${base} · ${token}` : base;
}

function formatValidationCode(value) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) return null;
  return text.replace(/_/g, " ");
}

function backgroundToolSurfaceLabel(toolName, args) {
  if (shouldSuppressToolActivity(toolName, args)) {
    return null;
  }
  const descriptor = describeToolStart(toolName, args);
  return sanitizeInlineText(descriptor?.title ?? "");
}

function describeSubagentStatus(type, payload) {
  const data = subagentPayloadData(payload);
  const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
  switch (type) {
    case "subagents.progress":
      return null;
    case "subagents.tool.executing":
    case "subagents.tool.result": {
      const toolName = payload?.toolName ?? data.toolName ?? "tool";
      const args =
        data.args ??
        latestSubagentToolArgs(payload?.subagentSessionId ?? null, toolName);
      const surfaceLabel = backgroundToolSurfaceLabel(toolName, args);
      if (surfaceLabel) {
        return surfaceLabel;
      }
      return currentDisplayObjective("child working");
    }
    case "subagents.acceptance_probe.started":
      return `child probe: ${truncate(probeName || "acceptance", 40)}`;
    case "subagents.acceptance_probe.completed":
      return `child probe ok: ${truncate(probeName || "acceptance", 40)}`;
    case "subagents.acceptance_probe.failed":
      return `child probe failed: ${truncate(probeName || "acceptance", 40)}`;
    case "subagents.synthesized": {
      const stopReason = sanitizeInlineText(data.stopReason ?? "");
      return stopReason
        ? `child synthesis: ${truncate(stopReason.replace(/_/g, " "), 40)}`
        : "child synthesis emitted";
    }
    default:
      return `${type.replace(/^subagents\./, "child ")}`;
  }
}

function subagentPayloadData(payload) {
  if (
    payload &&
    typeof payload.data === "object" &&
    payload.data &&
    !Array.isArray(payload.data)
  ) {
    return payload.data;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const {
      sessionId: _sessionId,
      parentSessionId: _parentSessionId,
      subagentSessionId: _subagentSessionId,
      toolName: _toolName,
      timestamp: _timestamp,
      traceId: _traceId,
      parentTraceId: _parentTraceId,
      ...rest
    } = payload;
    return rest;
  }
  return {};
}

function wrappedEventType(msg) {
  const payload =
    msg?.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
      ? msg.payload
      : {};
  return typeof payload.eventType === "string" ? payload.eventType : null;
}

function wrappedEventData(msg) {
  const payload =
    msg?.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
      ? msg.payload
      : {};
  return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : {};
}

function effectiveMessageType(msg) {
  if (msg?.type === "events.event") {
    return wrappedEventType(msg) ?? msg.type;
  }
  return typeof msg?.type === "string" ? msg.type : "";
}

function isSessionScopedMessageType(type) {
  return (
    type === "chat.message" ||
    type === "chat.stream" ||
    type === "chat.typing" ||
    type === "chat.cancelled" ||
    type === "run.inspect" ||
    type === "run.updated" ||
    type === "agent.status" ||
    type.startsWith("planner_") ||
    type.startsWith("subagents.") ||
    type === "tools.executing" ||
    type === "tools.result"
  );
}

function messageSessionIds(msg) {
  const payload =
    msg?.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
      ? msg.payload
      : {};
  const wrappedData = msg?.type === "events.event" ? wrappedEventData(msg) : {};
  return [
    msg?.sessionId,
    payload.sessionId,
    payload.parentSessionId,
    wrappedData.sessionId,
    wrappedData.parentSessionId,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function shouldIgnoreSessionScopedMessage(msg) {
  if (!sessionId || !isSessionScopedMessageType(effectiveMessageType(msg))) {
    return false;
  }
  const ids = messageSessionIds(msg);
  if (ids.length === 0) {
    return false;
  }
  return !ids.some((value) => sessionValuesMatch(value, sessionId));
}

function describeToolStart(toolName, args) {
  const payload =
    args && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  switch (toolName) {
    case "execute_with_agent": {
      const objective = sanitizeInlineText(
        payload.objective ?? payload.task ?? payload.inputContract ?? "",
      );
      const tools = Array.isArray(payload.tools)
        ? payload.tools.filter((value) => typeof value === "string")
        : [];
      return {
        title: `Delegate ${truncate(objective || "child task", 110)}`,
        body: [
          tools.length > 0 ? `tools: ${tools.join(", ")}` : null,
          typeof payload.workingDirectory === "string"
            ? `cwd: ${compactPathForDisplay(payload.workingDirectory)}`
            : null,
          Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length > 0
            ? `acceptance: ${truncate(
              payload.acceptanceCriteria
                .filter((value) => typeof value === "string")
                .join(" | "),
              180,
            )}`
            : null,
        ].filter(Boolean).join("\n") || objective || "(delegated child task)",
        tone: "magenta",
      };
    }
    case "system.writeFile":
    case "system.appendFile": {
      const filePath = compactPathForDisplay(payload.path);
      return {
        title: `${toolName === "system.appendFile" ? "Append" : "Edit"} ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          "",
          typeof payload.content === "string" && payload.content.trim().length > 0
            ? payload.content
            : null,
        ].filter(Boolean).join("\n") || filePath || "(pending file write)",
        tone: "yellow",
        previewMode: "source-write",
      };
    }
    case "system.readFile": {
      const filePath = compactPathForDisplay(payload.path);
      return {
        title: `Read ${filePath || "file"}`,
        body: filePath ? `path: ${filePath}` : "(pending read)",
        tone: "slate",
        previewMode: "source-read",
      };
    }
    case "system.listDir": {
      const dirPath = compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory);
      return {
        title: `List ${dirPath || "directory"}`,
        body: dirPath || "(pending directory listing)",
        tone: "slate",
      };
    }
    case "system.bash": {
      const command = formatShellCommand(payload.command, payload.args);
      const cwd = compactPathForDisplay(payload.cwd);
      return {
        title: `Run ${command || "command"}`,
        body: cwd ? `cwd: ${cwd}` : command || "(pending command)",
        tone: "yellow",
      };
    }
    case "desktop.text_editor":
      return describeDesktopTextEditorStart(payload);
    default:
      return {
        title: toolName,
        body: truncate(stable(payload), 220),
        tone: "yellow",
      };
  }
}

function describeToolResult(toolName, args, isError, result) {
  const payload =
    args && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  const parsed = tryParseJson(typeof result === "string" ? result : stable(result)) ?? {};
  const resultObject =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};

  switch (toolName) {
    case "execute_with_agent": {
      const outputPreview = firstMeaningfulLine(
        typeof resultObject.output === "string" ? resultObject.output : "",
      );
      const errorPreview = firstMeaningfulLine(
        typeof resultObject.error === "string" ? resultObject.error : "",
      );
      const childToken = compactSessionToken(resultObject.subagentSessionId);
      const status = sanitizeInlineText(resultObject.status ?? "");
      return {
        title: `${isError ? "Delegation failed" : "Delegated"} ${
          childToken ? `child ${childToken}` : "child task"
        }`,
        body: [
          status ? `status: ${status}` : null,
          typeof resultObject.toolCalls === "number"
            ? `tool calls: ${resultObject.toolCalls}`
            : null,
          "",
          typeof resultObject.error === "string" && resultObject.error.trim().length > 0
            ? resultObject.error
            : typeof resultObject.output === "string" && resultObject.output.trim().length > 0
              ? resultObject.output
              : errorPreview ?? outputPreview,
        ].filter((value) => value !== null).join("\n") || "(delegation finished)",
        tone: isError ? "red" : "magenta",
      };
    }
    case "system.writeFile":
    case "system.appendFile": {
      const filePath = compactPathForDisplay(
        resultObject.path ?? payload.path,
      );
      const sizeText = formatBytes(resultObject.bytesWritten);
      return {
        title: `${toolName === "system.appendFile" ? "Appended" : "Edited"} ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          sizeText ? `${sizeText} written` : null,
          "",
          typeof payload.content === "string" && payload.content.trim().length > 0
            ? payload.content
            : null,
        ].filter(Boolean).join("\n") || filePath || "(file updated)",
        tone: isError ? "red" : "green",
        previewMode: "source-write",
      };
    }
    case "system.readFile": {
      const filePath = compactPathForDisplay(
        resultObject.path ?? payload.path,
      );
      const sizeText = formatBytes(resultObject.size);
      return {
        title: `Read ${filePath || "file"}`,
        body: [
          filePath ? `path: ${filePath}` : null,
          sizeText,
          "",
          typeof resultObject.content === "string" && resultObject.content.trim().length > 0
            ? resultObject.content
            : null,
        ].filter(Boolean).join("\n") || filePath || "(file read)",
        tone: isError ? "red" : "slate",
        previewMode: "source-read",
      };
    }
    case "system.listDir": {
      const dirPath = compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory);
      const entries = Array.isArray(resultObject.entries)
        ? resultObject.entries
          .slice(0, 6)
          .map((entry) => typeof entry?.name === "string" ? entry.name : null)
          .filter(Boolean)
        : [];
      return {
        title: `Listed ${dirPath || "directory"}`,
        body: entries.length > 0 ? entries.join("  ") : dirPath || "(directory listed)",
        tone: isError ? "red" : "slate",
      };
    }
    case "desktop.text_editor":
      return describeDesktopTextEditorResult(payload, resultObject, isError);
    case "system.bash": {
      const command = formatShellCommand(payload.command, payload.args);
      const exitCode = resultObject.exitCode;
      const stdoutLine = firstMeaningfulLine(resultObject.stdout);
      const stderrLine = firstMeaningfulLine(resultObject.stderr);
      const cwd = compactPathForDisplay(payload.cwd);
      return {
        title: `${isError ? "Command failed" : "Ran"} ${command || "command"}`,
        body: [
          cwd ? `cwd: ${cwd}` : null,
          exitCode !== undefined ? `exit ${exitCode}` : null,
          isError ? stderrLine ?? stdoutLine : stdoutLine ?? stderrLine,
        ].filter(Boolean).join("\n") || command || "(command completed)",
        tone: isError ? "red" : "green",
      };
    }
    default: {
      const summary = buildToolSummary(parseStructuredJson(result));
      return {
        title: isError ? `${toolName} failed` : toolName,
        body:
          summary.length > 0
            ? summary.join("\n")
            : compactBodyLines(tryPrettyJson(result), maxEventBodyLines).join("\n"),
        tone: isError ? "red" : "green",
      };
    }
  }
}

function normalizeEventBody(body) {
  const normalizedBody = tryPrettyJson(body || "(empty)");
  return {
    body:
      normalizedBody.length > maxStoredBodyChars
        ? `${normalizedBody.slice(0, maxStoredBodyChars - 1)}…`
        : normalizedBody,
    bodyTruncated: normalizedBody.length > maxStoredBodyChars,
  };
}

function restoreTranscriptFromHistory(history) {
  if (!Array.isArray(history)) {
    return;
  }
  events.length = 0;
  transcriptScrollOffset = 0;
  transcriptFollowMode = true;
  detailScrollOffset = 0;
  for (const entry of history.slice(-maxEvents)) {
    const sender = String(entry?.sender ?? "").toLowerCase();
    const kind =
      sender === "user"
        ? "you"
        : sender === "agent" || sender === "assistant"
          ? "agent"
          : "history";
    const normalized = normalizeEventBody(entry?.content ?? "(empty)");
    const timestamp = entry?.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      : nowStamp();
    events.push({
      id: nextId("evt"),
      kind,
      title: sender === "user" ? "Prompt" : sender === "agent" ? "Agent Reply" : String(entry?.sender ?? "History"),
      tone: kind === "you" ? "teal" : kind === "agent" ? "cyan" : "slate",
      timestamp,
      createdAtMs: entry?.timestamp ? Number(new Date(entry.timestamp)) || Date.now() : Date.now(),
      body: normalized.body,
      bodyTruncated: normalized.bodyTruncated,
    });
    lastActivityAt = timestamp;
  }
  if (events.length === 0) {
    lastActivityAt = null;
  }
}

function shouldCoalesceRenderedEvent(previousEvent, nextEvent) {
  if (!previousEvent || !nextEvent) {
    return false;
  }
  if (previousEvent.kind !== nextEvent.kind) {
    return false;
  }
  if (previousEvent.title !== nextEvent.title || previousEvent.body !== nextEvent.body) {
    return false;
  }
  if ((previousEvent.subagentSessionId ?? null) !== (nextEvent.subagentSessionId ?? null)) {
    return false;
  }
  if ((previousEvent.toolName ?? null) !== (nextEvent.toolName ?? null)) {
    return false;
  }
  const previousCreatedAt = Number(previousEvent.createdAtMs);
  const nextCreatedAt = Number(nextEvent.createdAtMs);
  return Number.isFinite(previousCreatedAt) &&
    Number.isFinite(nextCreatedAt) &&
    nextCreatedAt - previousCreatedAt <= 2_500;
}

function pushEvent(kind, title, body, tone, metadata = {}) {
  return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
    const timestamp = nowStamp();
    const createdAtMs = Date.now();
    const normalized = normalizeEventBody(body);
    const nextEvent = {
      id: nextId("evt"),
      kind,
      title,
      tone,
      timestamp,
      createdAtMs,
      body: normalized.body,
      bodyTruncated: normalized.bodyTruncated,
      ...metadata,
    };
    const lastEvent = events[events.length - 1];
    if (shouldCoalesceRenderedEvent(lastEvent, nextEvent)) {
      lastEvent.timestamp = timestamp;
      lastEvent.createdAtMs = createdAtMs;
      lastEvent.tone = tone;
      lastEvent.bodyTruncated = normalized.bodyTruncated;
      lastActivityAt = timestamp;
      if (shouldFollow) {
        transcriptScrollOffset = 0;
        transcriptFollowMode = true;
      }
      scheduleRender();
      return;
    }
    events.push(nextEvent);
    if (introDismissKinds.has(kind)) {
      dismissIntro();
    }
    lastActivityAt = timestamp;
    while (events.length > maxEvents) {
      events.shift();
    }
    if (expandedEventId && !events.some((event) => event.id === expandedEventId)) {
      expandedEventId = null;
    }
    if (shouldFollow) {
      transcriptScrollOffset = 0;
      transcriptFollowMode = true;
    }
    scheduleRender();
  });
}

function upsertSubagentHeartbeatEvent(
  subagentSessionId,
  title,
  body,
  tone,
  metadata = {},
) {
  return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
    const timestamp = nowStamp();
    const normalized = normalizeEventBody(body);
    let heartbeatId = nextId("evt");

    if (typeof subagentSessionId === "string" && subagentSessionId.trim()) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
          event?.subagentHeartbeat &&
          event.subagentSessionId === subagentSessionId
        ) {
          heartbeatId = event.id;
          events.splice(index, 1);
          break;
        }
      }
    }

    events.push({
      id: heartbeatId,
      kind: "subagent",
      title,
      tone,
      timestamp,
      createdAtMs: Date.now(),
      body: normalized.body,
      bodyTruncated: normalized.bodyTruncated,
      ...metadata,
      subagentHeartbeat: true,
    });
    if (introDismissKinds.has("subagent")) {
      dismissIntro();
    }
    lastActivityAt = timestamp;
    while (events.length > maxEvents) {
      events.shift();
    }
    if (expandedEventId && !events.some((event) => event.id === expandedEventId)) {
      expandedEventId = null;
    }
    if (shouldFollow) {
      transcriptScrollOffset = 0;
      transcriptFollowMode = true;
    }
    scheduleRender();
  });
}

function clearSubagentHeartbeatEvents(subagentSessionId) {
  if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
    return;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.subagentHeartbeat &&
      event.subagentSessionId === subagentSessionId
    ) {
      events.splice(index, 1);
    }
  }
  if (expandedEventId && !events.some((event) => event.id === expandedEventId)) {
    expandedEventId = null;
  }
}

function replaceLatestToolEvent(toolName, isError, body, descriptor) {
  return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
    const lastEvent = events[events.length - 1];
    if (!lastEvent || lastEvent.kind !== "tool") {
      return false;
    }
    if (lastEvent.toolName !== toolName) {
      return false;
    }
    const normalized = normalizeEventBody(body);
    lastEvent.kind = isError ? "tool error" : "tool result";
    lastEvent.title = descriptor?.title ?? toolName;
    lastEvent.tone = descriptor?.tone ?? (isError ? "red" : "green");
    lastEvent.timestamp = nowStamp();
    lastEvent.createdAtMs = Date.now();
    lastEvent.body = normalized.body;
    lastEvent.bodyTruncated = normalized.bodyTruncated;
    if (descriptor?.previewMode) {
      lastEvent.previewMode = descriptor.previewMode;
    }
    lastActivityAt = lastEvent.timestamp;
    if (shouldFollow) {
      transcriptScrollOffset = 0;
      transcriptFollowMode = true;
    }
    scheduleRender();
    return true;
  });
}

function replaceLatestSubagentToolEvent(
  subagentSessionId,
  toolName,
  isError,
  body,
  descriptor,
) {
  return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
    let lastEvent = null;
    for (let index = events.length - 1; index >= Math.max(0, events.length - 6); index -= 1) {
      const candidate = events[index];
      if (
        candidate?.subagentHeartbeat &&
        candidate.subagentSessionId === subagentSessionId
      ) {
        continue;
      }
      lastEvent = candidate ?? null;
      break;
    }
    if (!lastEvent || lastEvent.kind !== "subagent tool") {
      return false;
    }
    if (
      lastEvent.toolName !== toolName ||
      lastEvent.subagentSessionId !== subagentSessionId
    ) {
      return false;
    }
    const normalized = normalizeEventBody(body);
    lastEvent.kind = isError ? "subagent error" : "subagent tool result";
    lastEvent.title = descriptor?.title ?? toolName;
    lastEvent.tone = descriptor?.tone ?? (isError ? "red" : "green");
    lastEvent.timestamp = nowStamp();
    lastEvent.createdAtMs = Date.now();
    lastEvent.body = normalized.body;
    lastEvent.bodyTruncated = normalized.bodyTruncated;
    if (descriptor?.previewMode) {
      lastEvent.previewMode = descriptor.previewMode;
    }
    lastActivityAt = lastEvent.timestamp;
    if (shouldFollow) {
      transcriptScrollOffset = 0;
      transcriptFollowMode = true;
    }
    scheduleRender();
    return true;
  });
}

function setTransientStatus(value) {
  transientStatus = truncate(sanitizeInlineText(value || "idle"), 160);
  scheduleRender();
}

function authPayload(extra = {}) {
  const payload = { clientKey, ...extra };
  if (ownerToken) {
    payload.ownerToken = ownerToken;
  }
  return payload;
}

function currentInputValue() {
  return composerInput;
}

function currentSlashSuggestions(limit = 8) {
  return matchWatchCommands(currentInputValue(), { limit });
}

function resetComposer() {
  composerInput = "";
  composerCursor = 0;
  composerHistoryIndex = -1;
  composerHistoryDraft = "";
}

function setComposerInput(nextValue) {
  composerInput = String(nextValue ?? "");
  composerCursor = Math.max(0, Math.min(composerCursor, composerInput.length));
}

function insertComposerText(text) {
  if (!text) {
    return;
  }
  composerInput =
    composerInput.slice(0, composerCursor) +
    text +
    composerInput.slice(composerCursor);
  composerCursor += text.length;
}

function moveComposerCursorByWord(direction) {
  if (direction < 0) {
    while (composerCursor > 0 && /\s/.test(composerInput[composerCursor - 1])) {
      composerCursor -= 1;
    }
    while (composerCursor > 0 && !/\s/.test(composerInput[composerCursor - 1])) {
      composerCursor -= 1;
    }
    return;
  }

  while (
    composerCursor < composerInput.length &&
    !/\s/.test(composerInput[composerCursor])
  ) {
    composerCursor += 1;
  }
  while (
    composerCursor < composerInput.length &&
    /\s/.test(composerInput[composerCursor])
  ) {
    composerCursor += 1;
  }
}

function deleteComposerToLineEnd() {
  if (composerCursor >= composerInput.length) {
    return;
  }
  composerInput = composerInput.slice(0, composerCursor);
  composerHistoryIndex = -1;
}

function navigateComposerHistory(direction) {
  if (composerHistory.length === 0) {
    return;
  }
  if (direction < 0) {
    if (composerHistoryIndex === -1) {
      composerHistoryDraft = composerInput;
      composerHistoryIndex = composerHistory.length - 1;
    } else if (composerHistoryIndex > 0) {
      composerHistoryIndex -= 1;
    }
    setComposerInput(composerHistory[composerHistoryIndex] ?? "");
    composerCursor = composerInput.length;
    return;
  }
  if (composerHistoryIndex === -1) {
    return;
  }
  if (composerHistoryIndex < composerHistory.length - 1) {
    composerHistoryIndex += 1;
    setComposerInput(composerHistory[composerHistoryIndex] ?? "");
  } else {
    composerHistoryIndex = -1;
    setComposerInput(composerHistoryDraft);
  }
  composerCursor = composerInput.length;
}

function autocompleteSlashCommand() {
  const input = currentInputValue();
  if (!input.trimStart().startsWith("/")) {
    return false;
  }
  const [commandToken = "/"] = input.trimStart().split(/\s+/, 1);
  const matches = matchWatchCommands(commandToken, { limit: 1 });
  if (matches.length === 0) {
    return false;
  }
  const remainder = input.trimStart().slice(commandToken.length);
  const completed = `${matches[0].name}${remainder}`;
  const leadingWhitespaceMatch = input.match(/^\s*/);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
  setComposerInput(`${leadingWhitespace}${completed}`);
  composerCursor = composerInput.length;
  return true;
}

function composerRenderLine(width) {
  const prompt = promptLabel();
  const promptWidth = visibleLength(prompt);
  const available = Math.max(1, width - promptWidth);
  const maxStart = Math.max(0, composerInput.length - available);
  const start = Math.max(0, Math.min(maxStart, composerCursor - available + 1));
  const visibleInput = composerInput.slice(start, start + available);
  return {
    line: `${prompt}${visibleInput}`,
    cursorColumn: Math.max(1, promptWidth + (composerCursor - start) + 1),
  };
}

function shutdownWatch(exitCode = 0) {
  shuttingDown = true;
  operatorInputBatcher.dispose();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearBootstrapTimer();
  clearStatusPollTimer();
  clearActivityPulseTimer();
  try {
    ws?.close();
  } catch {}
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  leaveAltScreen();
  process.exit(exitCode);
}

function recordComposerHistory(value) {
  if (!value) {
    return;
  }
  if (composerHistory[composerHistory.length - 1] !== value) {
    composerHistory.push(value);
    if (composerHistory.length > 200) {
      composerHistory = composerHistory.slice(-200);
    }
  }
  composerHistoryIndex = -1;
  composerHistoryDraft = "";
}

function submitComposerInput() {
  const value = composerInput.trim();
  if (!value) {
    scheduleRender();
    return;
  }
  recordComposerHistory(value);
  resetComposer();
  operatorInputBatcher.push(value);
  scheduleRender();
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
  const frame = JSON.stringify({ type, payload, id: nextId(type) });
  if (!isOpen) {
    pendingFrames.push(frame);
    return;
  }
  ws?.send(frame);
}

function requireSession(command) {
  if (!sessionId) {
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

function summarizeRunDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const lines = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`${label}: ${String(value)}`);
  };
  add("objective", detail.objective ?? currentObjective);
  add("phase", detail.currentPhase ?? runPhase);
  add("state", detail.state ?? runState);
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
    !sessionId ||
    !isOpen ||
    runInspectPending ||
    (!force && !shouldAutoInspectRun(runDetail, runState))
  ) {
    return;
  }
  runInspectPending = true;
  send("run.inspect", { sessionId });
  setTransientStatus(`refreshing run card (${reason})`);
}

function isExpectedMissingRunInspect(errorText) {
  return (
    typeof errorText === "string" &&
    errorText.includes("Background run") &&
    errorText.includes("not found")
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

function latestSessionSummary(payload, preferredSessionId = null) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  if (preferredSessionId) {
    const preferred = payload.find((session) => session?.sessionId === preferredSessionId);
    if (preferred && Number(preferred?.messageCount ?? 0) > 0) {
      return preferred;
    }
  }
  return [...payload].sort((left, right) => {
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

function clearBootstrapTimer() {
  if (!bootstrapTimer) {
    return;
  }
  clearTimeout(bootstrapTimer);
  bootstrapTimer = null;
}

function clearStatusPollTimer() {
  if (!statusPollTimer) {
    return;
  }
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function clearActivityPulseTimer() {
  if (!activityPulseTimer) {
    return;
  }
  clearInterval(activityPulseTimer);
  activityPulseTimer = null;
}

function ensureStatusPollTimer() {
  clearStatusPollTimer();
  statusPollTimer = setInterval(() => {
    if (!isOpen || shuttingDown) {
      return;
    }
    send("status.get", {});
  }, statusPollIntervalMs);
}

function ensureActivityPulseTimer() {
  if (activityPulseTimer) {
    return;
  }
  activityPulseTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    if (hasActiveSurfaceRun() || connectionState !== "live") {
      scheduleRender();
    }
  }, activityPulseIntervalMs);
}

function bootstrapPending() {
  return !bootstrapReady;
}

function queueOperatorInput(value, reason = "bootstrap pending") {
  queuedOperatorInputs.push(value);
  pushEvent(
    "queued",
    "Queued Input",
    `${value}\n\n${reason}`,
    "amber",
  );
  setTransientStatus(`queued ${value} until session restore completes`);
}

function flushQueuedOperatorInputs() {
  if (!isOpen || bootstrapPending() || queuedOperatorInputs.length === 0) {
    return;
  }
  while (queuedOperatorInputs.length > 0) {
    const value = queuedOperatorInputs.shift();
    if (!value) {
      continue;
    }
    dispatchOperatorInput(value, { replayed: true });
  }
}

function markBootstrapReady(statusText) {
  bootstrapReady = true;
  bootstrapAttempts = 0;
  clearBootstrapTimer();
  setTransientStatus(statusText);
  flushQueuedOperatorInputs();
}

function sendBootstrapProbe() {
  if (!isOpen || shuttingDown) {
    return;
  }
  send("chat.sessions", authPayload());
}

function scheduleBootstrap(reason = "restoring session") {
  if (shuttingDown || !isOpen) {
    return;
  }
  bootstrapReady = false;
  clearBootstrapTimer();
  const delayMs = Math.min(2_000, Math.max(250, bootstrapAttempts * 250));
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null;
    bootstrapAttempts += 1;
    sendBootstrapProbe();
  }, delayMs);
  setTransientStatus(`${reason}; retrying in ${delayMs}ms`);
}

const SPLASH_ART_LARGE = [
  { tone: "slate", text: "                  ░▒▓████████▓▒░                  " },
  { tone: "magenta", text: "               ░▓██████████████▓░               " },
  { tone: "magenta", text: "              ▒██████████████████▒              " },
  { tone: "softInk", text: "             ▓████████████████████▓             " },
  { tone: "softInk", text: "             ███████████████████▓██             " },
  { tone: "ink", text: "             █████████████████▓   ░             " },
  { tone: "ink", text: "             ████████████████▒                  " },
  { tone: "ink", text: "             ████████████████                   " },
  { tone: "magenta", text: "             ███████████████▓                   " },
  { tone: "magenta", text: "             ▓██████████████▒                   " },
  { tone: "slate", text: "              ▒████████████▓                    " },
  { tone: "slate", text: "               ▓███████████                     " },
  { tone: "slate", text: "                ▒█████████▓                     " },
  { tone: "fog", text: "                 ▒███████▓                      " },
  { tone: "fog", text: "                 ░██████▓                       " },
  { tone: "fog", text: "                  ▓████▓                        " },
  { tone: "fog", text: "                  ▒███▒                         " },
  { tone: "fog", text: "                   ▓█▓                          " },
];

const SPLASH_ART_SMALL = [
  { tone: "slate", text: "              ░▒▓████▓▒░             " },
  { tone: "magenta", text: "           ░▓██████████▓░            " },
  { tone: "softInk", text: "          ▒██████████████▒           " },
  { tone: "ink", text: "          ████████████▓ ░            " },
  { tone: "ink", text: "          ███████████▓               " },
  { tone: "magenta", text: "          ███████████▒               " },
  { tone: "slate", text: "           ▓████████▓                " },
  { tone: "slate", text: "            ▒██████▓                 " },
  { tone: "fog", text: "             ▓████▒                  " },
  { tone: "fog", text: "             ▒██▓                    " },
];

function shouldShowSplash() {
  if (introDismissed || currentObjective || currentInputValue().trim().length > 0) {
    return false;
  }
  if (!bootstrapReady) {
    return true;
  }
  return Date.now() - launchedAtMs < startupSplashMinMs &&
    !events.some((event) => introDismissKinds.has(event.kind));
}

function splashArtLines(width) {
  const source = width >= 96 ? SPLASH_ART_LARGE : SPLASH_ART_SMALL;
  return source.map((entry) =>
    centerAnsi(`${toneColor(entry.tone)}${entry.text}${color.reset}`, width),
  );
}

function splashProgressBar(width, level, tone = "magenta") {
  const clamped = Math.max(0, Math.min(1, Number(level) || 0));
  const fill = Math.max(0, Math.min(width, Math.round(clamped * width)));
  return `${toneColor(tone)}${"█".repeat(fill)}${color.fog}${"░".repeat(Math.max(0, width - fill))}${color.reset}`;
}

function renderCompactSplash(width, height) {
  const progress = splashProgressLevel();
  const tone = bootstrapReady && connectionState === "live" ? "teal" : "magenta";
  const statusLabel = bootstrapReady
    ? "READY"
    : connectionState === "reconnecting"
      ? "RECONNECTING"
      : "CONNECTING";
  const progressWidth = Math.max(14, Math.min(22, width - 22));
  const hint = bootstrapReady
    ? "session restored, console ready"
    : transientStatus;
  const content = [
    centerAnsi(
      `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.softInk}https://agenc.tech${color.reset}`,
      width,
    ),
    "",
    centerAnsi(`${toneColor(tone)}${color.bold}${statusLabel}${color.reset}`, width),
    centerAnsi(
      `${color.softInk}[${color.reset}${splashProgressBar(progressWidth, progress, tone)}${color.softInk}]${color.reset}`,
      width,
    ),
    centerAnsi(`${color.fog}${truncate(sanitizeInlineText(hint), Math.max(24, width - 6))}${color.reset}`, width),
  ];
  const visibleContent = content.slice(0, Math.max(4, height));
  const topPadding = Math.max(0, Math.floor((height - visibleContent.length) / 2));
  return [
    ...Array.from({ length: topPadding }, () => ""),
    ...visibleContent,
  ];
}

function renderSplash(width, height) {
  const progress = splashProgressLevel();
  const tone = bootstrapReady && connectionState === "live" ? "teal" : "magenta";
  const statusLabel = bootstrapReady
    ? "READY"
    : connectionState === "reconnecting"
      ? "RECONNECTING"
      : "CONNECTING TO AGENC";
  const hint = bootstrapReady
    ? "type a prompt to begin"
    : "initializing agent runtime...";
  const progressWidth = Math.max(18, Math.min(30, width - 28));
  const progressLine = centerAnsi(
    `${color.softInk}[${color.reset}${splashProgressBar(progressWidth, progress, tone)}${color.softInk}] ${String(Math.round(progress * 100)).padStart(3, " ")}%${color.reset}`,
    width,
  );
  const content = [
    centerAnsi(`${color.magenta}${color.bold}A G E N / C${color.reset} ${color.softInk}https://agenc.tech${color.reset}`, width),
    centerAnsi(`${color.fog}clean signal // low clutter // live autonomy${color.reset}`, width),
    "",
    ...splashArtLines(width),
    "",
    centerAnsi(`${toneColor(tone)}${color.bold}${statusLabel}${color.reset}`, width),
    progressLine,
    centerAnsi(`${color.fog}${hint}${color.reset}`, width),
  ];
  const topPadding = Math.max(0, Math.floor((height - content.length) / 2));
  return [
    ...Array.from({ length: topPadding }, () => ""),
    ...content,
  ];
}

function headerLines(width) {
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const elapsed = currentSessionElapsedLabel();
  const phaseLabel = effectiveSurfacePhaseLabel();
  const activeRun = hasActiveSurfaceRun();
  const modelRoute = effectiveModelRoute();
  const objective = currentDisplayObjective(
    sanitizeInlineText(runDetail?.explanation ?? "") || "No active objective",
  );

  const lines = [
    flexBetween(
      `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.fog}https://agenc.tech${color.reset}`,
      `${toneColor(stateTone(connectionState))}${connectionState}${color.reset} ${color.fog}${shortSession} ${elapsed}${color.reset}`,
      width,
    ),
  ];

  lines.push(
    `${color.softInk}  model${color.reset} ${toneColor(modelRouteTone(modelRoute))}${color.bold}${truncate(formatModelRouteLabel(modelRoute), Math.max(24, width - 10))}${color.reset}`,
  );

  if (
    activeRun &&
    objective &&
    objective !== "No active objective" &&
    !/^awaiting operator prompt$/i.test(objective) &&
    !new RegExp(`^working:?\\s*${phaseLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(objective)
  ) {
    lines.push(
      `${color.softInk}${truncate(sanitizeInlineText(objective), Math.max(28, width))}${color.reset}`,
    );
  }
  lines.push("");
  return lines;
}

function snapshotPanelLines(width) {
  const inner = width - 2;
  const objective = currentDisplayObjective();
  const surfaceTool = currentSurfaceToolLabel();
  const phaseLabel = effectiveSurfacePhaseLabel();
  const note =
    runDetail?.explanation ??
    runDetail?.lastUserUpdate ??
    latestAgentSummary ??
    transientStatus;
  return renderPanel({
    title: "SNAPSHOT",
    subtitle: lastActivityAt ? `@ ${lastActivityAt}` : "idle",
    tone: "magenta",
    width,
    bg: color.panelBg,
    lines: [
      row(`${color.fog}${color.bold}RUN${color.reset}`, color.panelHiBg),
      row(formatMetric("state", phaseLabel, inner, stateTone(phaseLabel)), color.panelBg),
      row(formatMetric("phase", runPhase ?? (currentPlanFocusStep() ? "delegated" : "idle"), inner, stateTone(runPhase ?? phaseLabel)), color.panelAltBg),
      ...wrapAndLimit(`objective ${objective}`, inner, 2).map((line, index) => (
        row(`${color.softInk}${line}${color.reset}`, index === 0 ? color.panelBg : color.panelAltBg)
      )),
      row("", color.panelBg),
      row(`${color.fog}${color.bold}SESSION${color.reset}`, color.panelHiBg),
      row(formatMetric("connection", connectionState, inner, stateTone(connectionState)), color.panelBg),
      row(formatMetric("session", sessionId ? sessionId.slice(-8) : "--------", inner, "slate"), color.panelAltBg),
      row(formatMetric("latest tool", surfaceTool, inner, stateTone(surfaceTool)), color.panelBg),
      row(formatMetric("usage", lastUsageSummary ?? "n/a", inner, lastUsageSummary ? "teal" : "slate"), color.panelAltBg),
      row("", color.panelBg),
      row(`${color.fog}${color.bold}NOTES${color.reset}`, color.panelHiBg),
      ...wrapAndLimit(note, inner, 3).map((line, index) => (
        row(`${color.softInk}${line}${color.reset}`, index % 2 === 0 ? color.panelBg : color.panelAltBg)
      )),
      row("", color.panelBg),
      row(`${color.fog}${color.bold}COMMANDS${color.reset}`, color.panelHiBg),
      row(`${color.softInk}/new  /inspect  /trace${color.reset}`, color.panelBg),
      row(`${color.softInk}/clear /pause /resume /stop${color.reset}`, color.panelAltBg),
    ],
  });
}

function compactSummaryLines(width) {
  const inner = width - 2;
  const objective = currentDisplayObjective();
  const surfaceTool = currentSurfaceToolLabel();
  const phaseLabel = effectiveSurfacePhaseLabel();
  const elapsed = hasActiveSurfaceRun()
    ? currentRunElapsedLabel()
    : currentSessionElapsedLabel();
  const planEntries = activePlanEntries(24);
  const focusStep = currentPlanFocusStep() ?? planEntries[planEntries.length - 1] ?? null;
  const moreSteps = Math.max(0, planEntries.length - (focusStep ? 1 : 0));
  const focusNote = sanitizeInlineText(
    focusStep?.note ??
      focusStep?.objective ??
      focusStep?.subagentSessionId ??
      "",
  );
  const lines = [
    row(
      flexBetween(
        `${chip("STATE", phaseLabel, stateTone(phaseLabel))}`,
        `${chip("UPLINK", connectionState, stateTone(connectionState))}`,
        inner,
      ),
      color.panelBg,
    ),
    row(
      flexBetween(
        `${chip("TOOL", surfaceTool, stateTone(surfaceTool))}`,
        `${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "green")}`,
        inner,
      ),
      color.panelAltBg,
    ),
    row(
      flexBetween(
        `${color.softInk}${truncate(sanitizeInlineText(objective), Math.max(24, inner - 10))}${color.reset}`,
        `${color.fog}${elapsed}${color.reset}`,
        inner,
      ),
      color.panelBg,
    ),
  ];

  if (focusStep) {
    const focusTone = planStatusTone(focusStep.status);
    lines.push(
      row(
        flexBetween(
          `${toneColor("teal")}${color.bold}PLAN${color.reset}`,
          `${color.fog}${planEntries.length} step${planEntries.length === 1 ? "" : "s"}${color.reset}`,
          inner,
        ),
        color.panelHiBg,
      ),
    );
    lines.push(
      row(
        `${toneColor(focusTone)}${planStatusGlyph(focusStep.status)} ${planStepDisplayName(
          focusStep,
          Math.max(18, inner - 6),
        )}${color.reset}`,
        color.panelBg,
      ),
    );
    if (focusNote) {
      for (const noteLine of wrapAndLimit(focusNote, inner, 2)) {
        lines.push(row(`${color.fog}${noteLine}${color.reset}`, color.panelAltBg));
      }
    }
    if (moreSteps > 0) {
      lines.push(
        row(
          `${color.fog}+${moreSteps} more${color.reset}`,
          focusNote ? color.panelBg : color.panelAltBg,
        ),
      );
    }
  }

  return renderPanel({
    title: "SNAPSHOT",
    subtitle: lastActivityAt ? `@ ${lastActivityAt}` : elapsed,
    tone: "magenta",
    width,
    bg: color.panelBg,
    lines,
  });
}

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

function dagMaskForChar(char) {
  switch (char) {
    case "─":
      return 0b0101;
    case "│":
      return 0b1010;
    case "┌":
      return 0b0110;
    case "┐":
      return 0b0011;
    case "└":
      return 0b1100;
    case "┘":
      return 0b1001;
    case "├":
      return 0b1110;
    case "┤":
      return 0b1011;
    case "┬":
      return 0b0111;
    case "┴":
      return 0b1101;
    case "┼":
      return 0b1111;
    default:
      return 0;
  }
}

function dagCharForMask(mask) {
  switch (mask) {
    case 0b0101:
      return "─";
    case 0b1010:
      return "│";
    case 0b0110:
      return "┌";
    case 0b0011:
      return "┐";
    case 0b1100:
      return "└";
    case 0b1001:
      return "┘";
    case 0b1110:
      return "├";
    case 0b1011:
      return "┤";
    case 0b0111:
      return "┬";
    case 0b1101:
      return "┴";
    case 0b1111:
      return "┼";
    default:
      return " ";
  }
}

function mergeDagCanvasChar(existing, next) {
  if (!next || next === " ") return existing;
  if (!existing || existing === " ") return next;
  if (existing === next) return existing;
  const mergedMask = dagMaskForChar(existing) | dagMaskForChar(next);
  return dagCharForMask(mergedMask) || next;
}

function buildPlannerDagSnapshot() {
  const nodes = [...plannerDagNodes.values()].sort((left, right) => left.order - right.order);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const childrenByKey = new Map(nodes.map((node) => [node.key, []]));
  const parentsByKey = new Map(nodes.map((node) => [node.key, []]));
  const incomingCounts = new Map(nodes.map((node) => [node.key, 0]));

  for (const edge of plannerDagEdges) {
    if (!nodeByKey.has(edge.from) || !nodeByKey.has(edge.to)) {
      continue;
    }
    childrenByKey.get(edge.from)?.push(edge.to);
    parentsByKey.get(edge.to)?.push(edge.from);
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  }

  for (const children of childrenByKey.values()) {
    children.sort((left, right) => (nodeByKey.get(left)?.order ?? 0) - (nodeByKey.get(right)?.order ?? 0));
  }

  const depthByKey = new Map(nodes.map((node) => [node.key, 0]));
  const queue = nodes
    .filter((node) => (incomingCounts.get(node.key) ?? 0) === 0)
    .map((node) => node.key);
  const remainingIncoming = new Map(incomingCounts);

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key) break;
    const nextDepth = (depthByKey.get(key) ?? 0) + 1;
    for (const child of childrenByKey.get(key) ?? []) {
      depthByKey.set(child, Math.max(depthByKey.get(child) ?? 0, nextDepth));
      remainingIncoming.set(child, Math.max(0, (remainingIncoming.get(child) ?? 0) - 1));
      if ((remainingIncoming.get(child) ?? 0) === 0) {
        queue.push(child);
      }
    }
  }

  const maxDepth = nodes.reduce((max, node) => Math.max(max, depthByKey.get(node.key) ?? 0), 0);
  return {
    nodes,
    nodeByKey,
    childrenByKey,
    parentsByKey,
    depthByKey,
    maxDepth,
  };
}

function plannerDagTypeTone(value) {
  switch (value) {
    case "subagent_task":
      return "magenta";
    case "deterministic_tool":
      return "teal";
    case "synthesis":
      return "yellow";
    default:
      return "slate";
  }
}

function plannerDagStatusShortLabel(value) {
  switch (value) {
    case "completed":
      return "done";
    case "running":
      return "live";
    case "failed":
      return "fail";
    case "cancelled":
      return "stop";
    case "blocked":
      return "hold";
    default:
      return "wait";
  }
}

function selectPlannerDagDisplayNodes(snapshot, maxRows) {
  const { nodes } = snapshot;
  if (nodes.length <= maxRows) {
    return {
      nodes,
      hiddenBefore: 0,
      hiddenAfter: 0,
    };
  }
  const start = Math.max(0, nodes.length - maxRows);
  const displayNodes = nodes.slice(start);
  return {
    nodes: displayNodes,
    hiddenBefore: start,
    hiddenAfter: 0,
  };
}

function plannerDagLabelLine(node, id, width) {
  const statusTone = plannerDagStatusTone(node.status);
  const typeTone = plannerDagTypeTone(node.stepType);
  const shortStatus = plannerDagStatusShortLabel(node.status);
  const baseLabel = sanitizePlanLabel(
    node.stepName ?? node.objective,
    node.tool || "unnamed step",
  );
  const left = `${toneColor(statusTone)}${color.bold}${id}${color.reset}${toneColor(typeTone)}${plannerDagTypeGlyph(node.stepType)}${color.reset} ${truncate(baseLabel, Math.max(10, width - 9))}`;
  const right = `${toneColor(statusTone)}${shortStatus}${color.reset}`;
  return flexBetween(left, right, width);
}

function plannerDagInfoLines(width, displayNodes, { hiddenBefore = 0, hiddenAfter = 0 } = {}) {
  const lines = [];
  if (hiddenBefore > 0 || hiddenAfter > 0) {
    const hiddenParts = [];
    if (hiddenBefore > 0) {
      hiddenParts.push(`${hiddenBefore} earlier`);
    }
    if (hiddenAfter > 0) {
      hiddenParts.push(`${hiddenAfter} later`);
    }
    lines.push(`${color.fog}… ${hiddenParts.join(" · ")} node${hiddenBefore + hiddenAfter === 1 ? "" : "s"} offstage${color.reset}`);
  }

  const focusNodes = displayNodes.filter((node) =>
    node.status === "running" || node.status === "failed" || node.status === "blocked"
  );
  const focusNote = focusNodes
    .map((node) => sanitizeInlineText(node.note || node.objective || ""))
    .find(Boolean);
  if (focusNote) {
    lines.push(`${color.softInk}${truncate(focusNote, width)}${color.reset}`);
  } else if (plannerDagNote) {
    lines.push(`${color.fog}${truncate(plannerDagNote, width)}${color.reset}`);
  }

  return lines.slice(0, 2);
}

function dagWidgetLines(width, maxCanvasLines = 8) {
  const snapshot = buildPlannerDagSnapshot();
  const { nodes, childrenByKey, depthByKey } = snapshot;
  const runningCount = nodes.filter((node) => node.status === "running").length;
  const failedCount = nodes.filter((node) => node.status === "failed").length;
  const completedCount = nodes.filter((node) => node.status === "completed").length;
  const updatedAt = plannerDagUpdatedAt > 0 ? formatClockLabel(plannerDagUpdatedAt) : "--:--:--";
  const header = flexBetween(
    `${toneColor(plannerDagStatusTone(plannerDagStatus))}${color.bold}LIVE DAG${color.reset}`,
    `${color.fog}${nodes.length} node${nodes.length === 1 ? "" : "s"}  ${updatedAt}${color.reset}`,
    width,
  );
  const metrics = flexBetween(
    `${chip("LIVE", runningCount, runningCount > 0 ? "cyan" : "slate")}  ${chip("DONE", completedCount, completedCount > 0 ? "green" : "slate")}`,
    `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
    width,
  );

  if (nodes.length === 0) {
    if (hasActiveSurfaceRun()) {
      const phaseLabel = sanitizeInlineText(currentPhaseLabel() || "thinking");
      const objective = currentDisplayObjective("planner reasoning");
      const pendingHeader = flexBetween(
        `${toneColor("cyan")}${color.bold}LIVE DAG${color.reset}`,
        `${color.fog}1 node  ${formatClockLabel(Date.now())}${color.reset}`,
        width,
      );
      const pendingMetrics = flexBetween(
        `${chip("LIVE", 1, "cyan")}  ${chip("DONE", 0, "slate")}`,
        `${chip("FAIL", 0, "slate")}`,
        width,
      );
      const pendingGraph = `${toneColor("cyan")}${plannerDagStatusGlyph("running")}${color.reset}──── ${color.softInk}${truncate(
        phaseLabel === "planner" ? "planner reasoning" : `${phaseLabel} pending`,
        Math.max(18, width - 6),
      )}${color.reset}`;
      return [
        pendingHeader,
        pendingMetrics,
        pendingGraph,
        `${color.fog}${truncate(objective, width)}${color.reset}`,
        `${color.fog}Waiting for the first planner_* event to materialize the full graph.${color.reset}`,
      ];
    }
    const lines = [
      header,
      metrics,
      `${color.softInk}No planner graph yet.${color.reset}`,
      `${color.fog}Waiting for planner_* events to draw the live node map.${color.reset}`,
    ];
    if (plannerDagNote) {
      lines.push(`${color.fog}${truncate(plannerDagNote, width)}${color.reset}`);
    }
    return lines;
  }

  const display = selectPlannerDagDisplayNodes(snapshot, Math.max(3, maxCanvasLines));
  const displayNodes = display.nodes;
  const displayIndexByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
  const maxDisplayDepth = displayNodes.reduce(
    (max, node) => Math.max(max, depthByKey.get(node.key) ?? 0),
    0,
  );
  const graphWidth = Math.max(
    12,
    Math.min(
      24,
      width - 14,
      maxDisplayDepth > 0 ? 4 + maxDisplayDepth * 5 : 12,
    ),
  );
  const labelWidth = Math.max(12, width - graphWidth - 2);
  const depthSpan = Math.max(1, maxDisplayDepth);
  const xByKey = new Map(
    displayNodes.map((node) => [
      node.key,
      maxDisplayDepth > 0
        ? Math.max(
          1,
          Math.min(
            graphWidth - 2,
            1 + Math.round(((depthByKey.get(node.key) ?? 0) * (graphWidth - 3)) / depthSpan),
          ),
        )
        : 1,
    ]),
  );
  const yByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
  const canvas = Array.from(
    { length: displayNodes.length },
    () => Array.from({ length: graphWidth }, () => " "),
  );
  const placeDagChar = (x, y, char) => {
    if (y < 0 || y >= displayNodes.length || x < 0 || x >= graphWidth) return;
    canvas[y][x] = mergeDagCanvasChar(canvas[y][x], char);
  };
  const drawHorizontal = (y, left, right) => {
    const start = Math.min(left, right);
    const end = Math.max(left, right);
    for (let x = start; x <= end; x += 1) {
      placeDagChar(x, y, "─");
    }
  };
  const drawVertical = (x, top, bottom) => {
    const start = Math.min(top, bottom);
    const end = Math.max(top, bottom);
    for (let y = start; y <= end; y += 1) {
      placeDagChar(x, y, "│");
    }
  };

  for (const node of displayNodes) {
    const childKeys = childrenByKey.get(node.key) ?? [];
    const fromX = xByKey.get(node.key) ?? 1;
    const fromY = yByKey.get(node.key) ?? 0;
    for (const childKey of childKeys) {
      if (!displayIndexByKey.has(childKey)) {
        continue;
      }
      const toX = xByKey.get(childKey) ?? fromX + 4;
      const toY = yByKey.get(childKey) ?? fromY;
      const startX = Math.min(graphWidth - 2, fromX + 1);
      const endX = toX > fromX
        ? Math.max(0, toX - 1)
        : Math.min(graphWidth - 2, toX + 1);
      const bendX = toX > fromX
        ? Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)))
        : Math.min(graphWidth - 2, Math.max(startX + 1, fromX + 2));
      drawHorizontal(fromY, startX, bendX);
      drawVertical(bendX, fromY, toY);
      drawHorizontal(toY, Math.min(bendX, endX), Math.max(bendX, endX));
    }
  }

  const idByKey = new Map(
    displayNodes.map((node, index) => [
      node.key,
      DAG_NODE_IDS[index] ?? String((index + 1) % 10),
    ]),
  );
  const nodeKeyByCoordinate = new Map(
    displayNodes.map((node) => [`${yByKey.get(node.key) ?? 0}:${xByKey.get(node.key) ?? 1}`, node.key]),
  );
  const lines = [
    header,
    metrics,
    ...displayNodes.map((node, rowIndex) => {
      let graphText = "";
      for (let columnIndex = 0; columnIndex < graphWidth; columnIndex += 1) {
        const key = nodeKeyByCoordinate.get(`${rowIndex}:${columnIndex}`);
        if (key) {
          const activeNode = snapshot.nodeByKey.get(key) ?? node;
          graphText += `${toneColor(plannerDagStatusTone(activeNode.status))}${plannerDagStatusGlyph(activeNode.status)}${color.reset}`;
          continue;
        }
        const char = canvas[rowIndex][columnIndex] ?? " ";
        graphText += char.trim().length > 0
          ? `${color.fog}${char}${color.reset}`
          : " ";
      }
      return `${fitAnsi(graphText.replace(/\s+$/g, ""), graphWidth)}  ${plannerDagLabelLine(node, idByKey.get(node.key) ?? "?", labelWidth)}`;
    }),
    ...plannerDagInfoLines(width, displayNodes, display),
  ];

  return lines;
}

function contextPanelLines(width) {
  const inner = width - 2;
  const elapsed = currentSessionElapsedLabel();
  const planEntries = activePlanEntries(24);
  const activeAgents = activeAgentEntries(24);
  const latestEvent = events[events.length - 1] ?? null;
  const followText = isTranscriptFollowing() ? "live tail" : `manual +${transcriptScrollOffset}`;
  const detailText = expandedEventId ? "open" : "closed";
  const usageText = lastUsageSummary ?? "n/a";
  const objective = currentDisplayObjective("No active objective");
  const focus = latestEvent ? sanitizeInlineText(latestEvent.title) : "no live event";
  return renderPanel({
    title: "CONTEXT",
    subtitle: `${elapsed} attached`,
    tone: lastUsageSummary ? "teal" : "slate",
    width,
    bg: color.panelBg,
    lines: [
      row(
        flexBetween(
          `${chip("LIVE", elapsed, "teal")}`,
          `${chip("FOLLOW", followText, isTranscriptFollowing() ? "green" : "amber")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("PROMPT", usageText, lastUsageSummary ? "teal" : "slate")}`,
          `${chip("DETAIL", detailText, expandedEventId ? "cyan" : "slate")}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${chip("TRANSCRIPT", `${events.length} evt`, "blue")}`,
          `${chip("AGENTS", `${activeAgents.length} active`, activeAgents.length > 0 ? "green" : "slate")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("PLAN", `${planEntries.length} step${planEntries.length === 1 ? "" : "s"}`, planEntries.length > 0 ? "magenta" : "slate")}`,
          `${chip("SESS", sessionId ? sessionId.slice(-8) : "--------", "slate")}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row("", color.panelBg),
      row(`${color.fog}${color.bold}MAP${color.reset}`, color.panelHiBg),
      ...wrapAndLimit(`objective ${objective}`, inner, 2).map((line, index) => (
        row(`${color.softInk}${line}${color.reset}`, index % 2 === 0 ? color.panelBg : color.panelAltBg)
      )),
      ...wrapAndLimit(`focus ${focus}`, inner, 2).map((line, index) => (
        row(`${color.softInk}${line}${color.reset}`, index % 2 === 0 ? color.panelBg : color.panelAltBg)
      )),
    ],
  });
}

function agentsPanelLines(width, limit = 6, showSessionTokens = true) {
  const inner = width - 2;
  const planEntries = activePlanEntries(24);
  const activeAgents = activeAgentEntries(24);
  const completedCount = planEntries.filter((step) => step.status === "completed").length;
  const failedCount = planEntries.filter((step) => step.status === "failed").length;
  const lines = [
    row(
      flexBetween(
        `${chip("ACTIVE", activeAgents.length, activeAgents.length > 0 ? "green" : "slate")}`,
        `${chip("DONE", completedCount, completedCount > 0 ? "teal" : "slate")}`,
        inner,
      ),
      color.panelBg,
    ),
    row(
      flexBetween(
        `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
        `${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "slate")}`,
        inner,
      ),
      color.panelAltBg,
    ),
  ];

  if (activeAgents.length === 0) {
    lines.push(row(`${color.softInk}No delegated agents running.${color.reset}`, color.panelBg));
  } else {
    for (const [index, step] of activeAgents.slice(0, limit).entries()) {
      const tone = planStatusTone(step.status);
      const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
      const label = `${toneColor(tone)}${planStatusGlyph(step.status)} ${planStepDisplayName(step, Math.max(16, inner - 6))}${color.reset}`;
      const token = compactSessionToken(step.subagentSessionId);
      const note = sanitizeInlineText(step.note || step.objective || "");
      lines.push(row(label, bg));
      if (note) {
        lines.push(
          row(
            `${color.fog}${truncate(note, inner)}${color.reset}`,
            bg,
          ),
        );
      } else if (token && showSessionTokens) {
        lines.push(
          row(
            `${color.fog}${truncate(`child ${token}`, inner)}${color.reset}`,
            bg,
          ),
        );
      }
    }
  }

  return renderPanel({
    title: "AGENTS",
    subtitle: `${activeAgents.length} active`,
    tone: activeAgents.length > 0 ? "green" : "slate",
    width,
    bg: color.panelBg,
    lines,
  });
}

function sidebarLines(width, targetHeight) {
  const compactAgentLimit = targetHeight >= 52 ? 3 : targetHeight >= 42 ? 2 : 1;
  const minDagRows = targetHeight >= 40 ? 12 : targetHeight >= 32 ? 10 : 8;
  const summarySection = compactSummaryLines(width);
  const dagSnapshot = buildPlannerDagSnapshot();
  const dagDesiredRows = Math.max(minDagRows, Math.min(
    Math.max(0, targetHeight - summarySection.length - 1),
    dagSnapshot.nodes.length > 0 ? dagSnapshot.nodes.length + 4 : 5,
  ));
  const optionalSections = [];
  const agentsSection =
    targetHeight >= 58 ? agentsPanelLines(width, compactAgentLimit, targetHeight >= 30) : null;
  const contextSection =
    targetHeight >= 72 ? contextPanelLines(width) : null;
  for (const candidate of [agentsSection, contextSection]) {
    if (!candidate) {
      continue;
    }
    const reservedIfIncluded =
      summarySection.length +
      1 +
      dagDesiredRows +
      optionalSections.reduce((total, section) => total + 1 + section.length, 0) +
      1 +
      candidate.length;
    if (reservedIfIncluded <= targetHeight) {
      optionalSections.push(candidate);
    }
  }

  const reservedOptionalRows = optionalSections.reduce(
    (total, section) => total + 1 + section.length,
    0,
  );
  const dagAvailableRows = Math.max(
    minDagRows,
    targetHeight - summarySection.length - 1 - reservedOptionalRows,
  );
  const dagSection = dagWidgetLines(
    width,
    Math.max(3, dagAvailableRows - 4),
  );

  const sections = [summarySection, dagSection, ...optionalSections];
  const rows = [];
  for (const section of sections) {
    if (rows.length > 0) {
      rows.push("");
    }
    rows.push(...section);
  }
  while (rows.length < targetHeight) {
    rows.push(blankRow(width));
  }
  return rows;
}

function commandPaletteLines(width, limit = 7) {
  const inner = width - 2;
  const input = currentInputValue().trimStart();
  const suggestions = currentSlashSuggestions(limit);
  const lines = [];
  if (suggestions.length === 0) {
    lines.push(row(`${color.red}No matching slash command.${color.reset}`, color.panelBg));
    lines.push(row(`${color.softInk}Use /help for the full command reference.${color.reset}`, color.panelBg));
  } else {
    for (const command of suggestions) {
      const [usageLine, descriptionLine = ""] = formatCommandPaletteText(command).split("\n");
      lines.push(row(usageLine, color.panelBg));
      if (descriptionLine) {
        lines.push(row(truncate(descriptionLine, inner), color.panelBg));
      }
    }
  }
  return renderPanel({
    title: input.length > 0 ? truncate(input, 22) : "/ commands",
    tone: "teal",
    width,
    bg: color.panelBg,
    lines,
  });
}

function footerHintLine(width) {
  const input = currentInputValue();
  if (expandedEventId) {
    return flexBetween(
      `${color.fog}${enableMouseTracking ? "mouse wheel / " : ""}pgup pgdn scroll  ctrl+o close detail  ctrl+y copy${color.reset}`,
      `${color.fog}${connectionState}${color.reset}`,
      width,
    );
  }
  if (input.trimStart().startsWith("/")) {
    const suggestions = currentSlashSuggestions(6);
    const suggestionText =
      suggestions.length > 0
        ? suggestions.map((command) => command.name).join("  ")
        : "no matching command";
    return flexBetween(
      `${color.fog}${truncate(suggestionText, Math.max(20, width - 24))}${color.reset}`,
      `${color.fog}enter run${color.reset}`,
      width,
    );
  }
  const rightHint =
    !isOpen
      ? "reconnecting"
      : bootstrapPending()
        ? "restoring session"
        : sessionId
          ? sessionId.slice(-8)
          : "no session";
  const latestExpandable = latestExpandableEvent();
  const leftHint =
    input.trim().length > 0
      ? `enter send  ctrl+k kill  ctrl+←/→ word${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  pgup/pgdn scroll`
      : `/ commands${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  /export save  pgup/pgdn scroll  ctrl+l clear`;
  return flexBetween(
    `${color.fog}${truncate(leftHint, Math.max(16, width - 22))}${color.reset}`,
    `${color.fog}${rightHint}${color.reset}`,
    width,
  );
}

function footerStatusLine(width) {
  const phaseLabel = effectiveSurfacePhaseLabel();
  const activeRun = hasActiveSurfaceRun();
  const elapsedLabel = activeRun ? currentRunElapsedLabel() : currentSessionElapsedLabel();
  const workingPrefix =
    activeRun && connectionState === "live"
      ? `${animatedWorkingGlyph()} `
      : "";
  const statusLabel =
    connectionState !== "live"
      ? `Link ${connectionState}`
      : activeRun
        ? `${workingPrefix}Working ${phaseLabel} ${elapsedLabel}`
        : "Awaiting operator prompt";
  const leftParts = [];
  const surfaceTool = currentSurfaceToolLabel("");
  if (surfaceTool) {
    leftParts.push(
      latestToolState && latestToolState !== "ok" && surfaceTool === latestTool
        ? `${surfaceTool} ${latestToolState}`
        : surfaceTool,
    );
  }
  if (expandedEventId) {
    leftParts.push("detail");
  } else if (isTranscriptFollowing()) {
    leftParts.push("live follow");
  } else if (transcriptScrollOffset > 0) {
    leftParts.push(`scroll ${transcriptScrollOffset}`);
  }
  if (lastUsageSummary) {
    leftParts.push(`usage ${lastUsageSummary}`);
  }

  const rightStatus =
    shouldSurfaceTransientStatus()
      ? sanitizeInlineText(transientStatus)
      : latestAgentSummary ??
        (activeRun
          ? currentDisplayObjective("")
          : sessionId
            ? `session ${sessionId.slice(-8)}`
            : connectionState);

  const left = leftParts.length > 0
    ? `${toneColor(stateTone(connectionState !== "live" ? connectionState : phaseLabel))}${color.bold}${statusLabel}${color.reset}${color.softInk}  ${leftParts.join("  ")}${color.reset}`
    : `${toneColor(stateTone(connectionState !== "live" ? connectionState : phaseLabel))}${color.bold}${statusLabel}${color.reset}`;

  return flexBetween(
    left,
    `${color.fog}${truncate(rightStatus || "idle", Math.max(18, Math.floor(width * 0.38)))}${color.reset}`,
    width,
  );
}

function resetLiveRunSurface() {
  latestAgentSummary = null;
  latestTool = null;
  latestToolState = null;
  lastUsageSummary = null;
  liveSessionModelRoute = null;
  activeRunStartedAtMs = null;
}

function styleEventBodyLine(line) {
  return `${color.softInk}${line}${color.reset}`;
}

function eventBadge(kind) {
  switch (kind) {
    case "tool result":
      return { label: "RETURN", tone: "green" };
    case "tool error":
      return { label: "FAULT", tone: "red" };
    case "tool":
      return { label: "EXEC", tone: "yellow" };
    case "agent":
      return { label: "CORE", tone: "cyan" };
    case "you":
      return { label: "YOU", tone: "teal" };
    case "operator":
      return { label: "CTRL", tone: "teal" };
    case "run":
    case "inspect":
      return { label: "STATE", tone: "magenta" };
    case "trace":
      return { label: "TRACE", tone: "slate" };
    case "logs":
      return { label: "LOGS", tone: "slate" };
    case "history":
      return { label: "HISTORY", tone: "slate" };
    case "help":
      return { label: "HELP", tone: "slate" };
    case "status":
      return { label: "STATUS", tone: "blue" };
    case "session":
      return { label: "SESS", tone: "teal" };
    case "approval":
      return { label: "AUTH", tone: "red" };
    default:
      return { label: kind.toUpperCase().slice(0, 10), tone: "slate" };
  }
}

function eventPreviewLines(event, width) {
  const sourcePreview = isSourcePreviewEvent(event);
  const mutationPreview = isMutationPreviewEvent(event);
  const latestEvent = events[events.length - 1] ?? null;
  const latestIsCurrent = latestEvent?.id === event?.id;
  const viewportLines = Math.max(12, termHeight() - 9);
  const sourceInlineBudget = mutationPreview
    ? Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 32 : 18,
        Math.floor(viewportLines * (latestIsCurrent ? 0.84 : 0.56)),
      ),
    )
    : Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 12 : 6,
        Math.floor(viewportLines * (latestIsCurrent ? 0.32 : 0.2)),
      ),
    );
  const maxLines =
    mutationPreview
      ? sourceInlineBudget
      : sourcePreview
        ? Math.min(sourceInlineBudget, latestIsCurrent ? 10 : 6)
      : event.kind === "agent"
        ? 5
        : event.kind === "subagent"
          ? 4
          : event.kind === "subagent tool" || event.kind === "subagent tool result" || event.kind === "subagent error"
            ? 4
        : event.kind === "you" || event.kind === "operator" || event.kind === "queued"
          ? 3
          : event.kind === "tool" || event.kind === "tool result" || event.kind === "tool error"
            ? 3
            : event.kind === "error" || event.kind === "approval"
              ? 3
              : 2;
  const sourceLines =
    sourcePreview || event.kind === "agent" || event.kind === "you" || event.kind === "subagent"
      ? eventBodyLines(event.body, maxPreviewSourceLines)
      : compactBodyLines(event.body, Math.max(maxLines + 2, 4));
  const wrapped = sourceLines.flatMap((line) => wrapLine(line, width));
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const preview = wrapped.slice(0, maxLines);
  const lastIndex = preview.length - 1;
  preview[lastIndex] = `${truncate(preview[lastIndex].trimEnd(), Math.max(8, width - 1))}…`;
  return preview;
}

function eventHasHiddenPreview(event, width) {
  const sourcePreview = isSourcePreviewEvent(event);
  const wrapped = (
    sourcePreview
      ? eventBodyLines(event.body, maxPreviewSourceLines)
      : compactBodyLines(event.body, maxPreviewSourceLines)
  )
    .flatMap((line) => wrapLine(line, width));
  return event.bodyTruncated || wrapped.length > eventPreviewLines(event, width).length;
}

function latestExpandableEvent() {
  const { transcriptWidth } = currentTranscriptLayout();
  const previewWidth = Math.max(12, transcriptWidth - 4);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !isSourcePreviewEvent(event)) {
      continue;
    }
    if (eventHasHiddenPreview(event, previewWidth)) {
      return event;
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isSourcePreviewEvent(event)) {
      return event;
    }
  }
  return events[events.length - 1] ?? null;
}

function currentExpandedEvent() {
  if (!expandedEventId) {
    return null;
  }
  return events.find((event) => event.id === expandedEventId) ?? null;
}

function toggleExpandedEvent() {
  if (expandedEventId) {
    expandedEventId = null;
    detailScrollOffset = 0;
    setTransientStatus("detail closed");
    return;
  }
  const target = latestExpandableEvent();
  if (!target) {
    setTransientStatus("no detail available");
    return;
  }
  expandedEventId = target.id;
  detailScrollOffset = 0;
  setTransientStatus(`detail open: ${target.title}`);
}

function eventPrefix(kind) {
  switch (kind) {
    case "you":
    case "operator":
    case "queued":
      return ">";
    case "tool":
    case "tool result":
    case "subagent tool":
    case "subagent tool result":
      return "↳";
    case "subagent":
      return "◦";
    case "tool error":
    case "subagent error":
    case "approval":
    case "error":
    case "ws-error":
      return "!";
    default:
      return "•";
  }
}

function eventPrefixTone(kind) {
  switch (kind) {
    case "you":
    case "operator":
    case "queued":
      return "teal";
    case "tool":
      return "yellow";
    case "tool result":
      return "green";
    case "subagent":
      return "magenta";
    case "subagent tool":
      return "amber";
    case "subagent tool result":
      return "green";
    case "subagent error":
      return "red";
    case "tool error":
    case "approval":
    case "error":
    case "ws-error":
      return "red";
    case "agent":
      return "cyan";
    default:
      return "slate";
  }
}

function eventHeadline(event, previewLines) {
  switch (event.kind) {
    case "you":
      return previewLines.shift() ?? sanitizeDisplayText(event.title);
    case "tool":
    case "tool result":
    case "tool error":
    case "subagent":
    case "subagent tool":
    case "subagent tool result":
    case "subagent error":
      return sanitizeDisplayText(event.title);
    case "queued":
      return previewLines.shift() ?? "Queued input";
    case "operator":
      return sanitizeDisplayText(event.title);
    case "agent":
      return previewLines.shift() ?? sanitizeDisplayText(event.title);
    default:
      return sanitizeDisplayText(event.title);
  }
}

function shouldShowEventBody(event, { showBody = true } = {}) {
  return showBody && event.kind !== "queued";
}

function renderEventBlock(event, width, { showBody = true } = {}) {
  const rows = [];
  const prefix = `${toneColor(eventPrefixTone(event.kind))}${color.bold}${eventPrefix(event.kind)}${color.reset}`;
  const previewLines = eventPreviewLines(event, Math.max(12, width - 4));
  const headline = eventHeadline(event, previewLines);
  const headlineTone =
    event.kind === "agent" || event.kind === "you"
      ? color.ink
      : color.softInk;
  rows.push(
    fitAnsi(
      `${prefix} ${headlineTone}${truncate(sanitizeDisplayText(headline), Math.max(12, width - 2))}${color.reset}`,
      width,
    ),
  );

  if (shouldShowEventBody(event, { showBody })) {
    previewLines.forEach((line) => {
      rows.push(renderEventBodyLine(event, line, { inline: true }));
    });
  }
  return rows;
}

function flattenTranscriptView(width) {
  if (events.length === 0) {
    return {
      rows: [
        `${color.softInk}No activity yet.${color.reset}`,
        `${color.fog}Prompts, tool runs, and agent replies will appear here.${color.reset}`,
      ],
      ranges: new Map(),
    };
  }

  const rows = [];
  const ranges = new Map();
  const latestEvent = events[events.length - 1] ?? null;
  const richBodyWindow = isSourcePreviewEvent(latestEvent) ? 4 : 6;
  const recentSourcePreviewIds = new Set(
    events
      .filter((event) => isSourcePreviewEvent(event))
      .slice(-8)
      .map((event) => event.id),
  );
  events.forEach((event, index) => {
    const showBody =
      recentSourcePreviewIds.has(event.id) ||
      index >= Math.max(0, events.length - richBodyWindow) ||
      event.id === latestEvent?.id;
    const start = rows.length + (index > 0 ? 1 : 0);
    const block = renderEventBlock(event, width, { showBody });
    if (index > 0) {
      rows.push("");
    }
    rows.push(...block);
    ranges.set(event.id, { start, end: rows.length });
  });
  return { rows, ranges };
}

function currentTranscriptRowCount() {
  const { transcriptWidth } = currentTranscriptLayout();
  return flattenTranscriptView(transcriptWidth).rows.length;
}

function withPreservedManualTranscriptViewport(mutator) {
  const shouldFollow = isTranscriptFollowing();
  const beforeRows = shouldFollow ? null : currentTranscriptRowCount();
  const result = mutator({ shouldFollow });
  if (beforeRows !== null) {
    const afterRows = currentTranscriptRowCount();
    transcriptScrollOffset = Math.max(0, transcriptScrollOffset + (afterRows - beforeRows));
    transcriptFollowMode = transcriptScrollOffset === 0;
  }
  return result;
}

function recentSourceFocusRange(ranges) {
  for (let index = events.length - 1; index >= Math.max(0, events.length - 10); index -= 1) {
    const candidate = events[index];
    if (!candidate || !isMutationPreviewEvent(candidate)) {
      continue;
    }
    return ranges.get(candidate.id) ?? null;
  }
  return null;
}

function sliceRowsAroundRange(allRows, targetHeight, range, trailingPad = 6) {
  const viewHeight = Math.max(8, targetHeight);
  const maxStart = Math.max(0, allRows.length - viewHeight);
  const preferredStart = Math.max(0, range.start - 1);
  let start = Math.min(preferredStart, maxStart);
  let end = Math.min(allRows.length, Math.max(start + viewHeight, range.end + trailingPad));
  if (end - start > viewHeight) {
    end = start + viewHeight;
  }
  if (end > allRows.length) {
    end = allRows.length;
    start = Math.max(0, end - viewHeight);
  }
  return {
    rows: allRows.slice(start, end),
    maxOffset: maxStart,
    normalizedOffset: 0,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, allRows.length - end),
  };
}

function sliceRowsFromBottom(allRows, targetHeight, offset) {
  const viewHeight = Math.max(8, targetHeight);
  const maxOffset = Math.max(0, allRows.length - viewHeight);
  const normalizedOffset = Math.max(0, Math.min(offset, maxOffset));
  const end = Math.max(0, allRows.length - normalizedOffset);
  const start = Math.max(0, end - viewHeight);
  return {
    rows: allRows.slice(start, end),
    maxOffset,
    normalizedOffset,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, allRows.length - end),
  };
}

function bottomAlignRows(rows, targetHeight) {
  const padding = Math.max(0, targetHeight - rows.length);
  return padding > 0 ? Array.from({ length: padding }, () => "").concat(rows) : rows;
}

function activityPanelLines(width, targetHeight) {
  const transcriptView = flattenTranscriptView(width);
  const focusRange =
    transcriptScrollOffset === 0 && transcriptFollowMode
      ? recentSourceFocusRange(transcriptView.ranges)
      : null;
  const sliced = focusRange
    ? sliceRowsAroundRange(transcriptView.rows, targetHeight, focusRange)
    : sliceRowsFromBottom(
      transcriptView.rows,
      targetHeight,
      transcriptScrollOffset,
    );
  transcriptScrollOffset = sliced.normalizedOffset;
  const lines = bottomAlignRows([...sliced.rows], targetHeight);
  return {
    lines,
    hiddenAbove: sliced.hiddenAbove,
    hiddenBelow: sliced.hiddenBelow,
  };
}

function isTranscriptFollowing() {
  return transcriptFollowMode || transcriptScrollOffset === 0;
}

function expandedDetailLines(width, targetHeight) {
  const event = currentExpandedEvent();
  if (!event) {
    expandedEventId = null;
    detailScrollOffset = 0;
    return activityPanelLines(width, targetHeight);
  }
  const body = eventBodyLines(event.body, maxPreviewSourceLines * 8)
    .flatMap((line) => wrapLine(line, width));
  const header = [
    flexBetween(
      `${toneColor(event.tone)}${color.bold}${truncate(sanitizeDisplayText(event.title), Math.max(20, width - 18))}${color.reset}`,
      `${color.fog}${event.timestamp}${color.reset}`,
      width,
    ),
    `${color.fog}${eventBadge(event.kind).label.toLowerCase()}  ctrl+o close${color.reset}`,
    "",
  ];
  const availableRows = Math.max(4, targetHeight - header.length - 1);
  const sliced = sliceRowsFromBottom(body, availableRows, detailScrollOffset);
  detailScrollOffset = sliced.normalizedOffset;
  const visibleBody = sliced.rows;
  const rows = [
    ...header,
    ...visibleBody.map((line) => renderEventBodyLine(event, line)),
  ];
  while (rows.length < targetHeight - 1) {
    rows.push("");
  }
  rows.push(
    `${color.fog}${visibleBody.length} of ${body.length} lines` +
      `${sliced.hiddenAbove > 0 ? `  ${sliced.hiddenAbove} above` : ""}` +
      `${sliced.hiddenBelow > 0 ? `  ${sliced.hiddenBelow} below` : ""}` +
      `${event.bodyTruncated ? "  stored body truncated" : ""}${color.reset}`,
  );
  return {
    lines: rows.slice(0, targetHeight),
    hiddenAbove: sliced.hiddenAbove,
    hiddenBelow: sliced.hiddenBelow,
  };
}

function copyableTranscriptText() {
  if (expandedEventId) {
    const event = currentExpandedEvent();
    if (!event) {
      return "";
    }
    return [
      `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
      event.body,
    ].join("\n\n").trim();
  }

  return events
    .map((event) => [
      `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
      event.body,
    ].join("\n"))
    .join("\n\n")
    .trim();
}

function exportViewText(text, mode = expandedEventId ? "detail" : "transcript") {
  const safeMode = String(mode ?? "view")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "view";
  const exportPath = path.join(
    os.tmpdir(),
    `agenc-watch-${safeMode}-${Date.now()}.txt`,
  );
  fs.writeFileSync(exportPath, `${text}\n`);
  return exportPath;
}

function exportCurrentView({ announce = false } = {}) {
  const text = copyableTranscriptText();
  if (!text) {
    setTransientStatus("nothing to export");
    scheduleRender();
    return null;
  }

  const mode = expandedEventId ? "detail" : "transcript";
  const exportPath = exportViewText(text, mode);
  if (announce) {
    pushEvent(
      "operator",
      mode === "detail" ? "Detail Export" : "Transcript Export",
      `${mode[0].toUpperCase()}${mode.slice(1)} exported to ${exportPath}.`,
      "teal",
    );
  } else {
    setTransientStatus(`${mode} exported to ${exportPath}`);
    scheduleRender();
  }
  return exportPath;
}

function copyCurrentView() {
  const text = copyableTranscriptText();
  if (!text) {
    setTransientStatus("nothing to copy");
    scheduleRender();
    return;
  }

  const destinations = [];
  let clipboardCommand = null;
  const clipboardCommands = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
  for (const [command, args] of clipboardCommands) {
    try {
      execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      clipboardCommand = command;
      destinations.push(`clipboard via ${command}`);
      break;
    } catch {}
  }

  try {
    if (process.env.TMUX) {
      execFileSync("tmux", ["load-buffer", "-"], { input: text });
      destinations.push("tmux buffer");
    }
  } catch {}

  if (!clipboardCommand) {
    destinations.push(exportViewText(text));
  }

  const viewLabel = expandedEventId ? "detail" : "transcript";
  setTransientStatus(`${viewLabel} copied: ${destinations.join(" / ")}`);
  scheduleRender();
}

function scrollTranscriptBy(delta) {
  transcriptScrollOffset = Math.max(0, transcriptScrollOffset + delta);
  transcriptFollowMode = transcriptScrollOffset === 0;
  scheduleRender();
}

function scrollDetailBy(delta) {
  detailScrollOffset = Math.max(0, detailScrollOffset + delta);
  scheduleRender();
}

function scrollCurrentViewBy(delta) {
  if (expandedEventId) {
    scrollDetailBy(delta);
    return;
  }
  scrollTranscriptBy(delta);
}

function enterAltScreen() {
  if (!process.stdout.isTTY || enteredAltScreen) {
    return;
  }
  process.stdout.write(
    enableMouseTracking
      ? "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25h"
      : "\x1b[?1049h\x1b[?25h",
  );
  enteredAltScreen = true;
}

function leaveAltScreen() {
  if (!enteredAltScreen) {
    return;
  }
  process.stdout.write(
    enableMouseTracking
      ? "\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l"
      : "\x1b[?25h\x1b[?1049l",
  );
  enteredAltScreen = false;
  lastRenderedFrameLines = [];
  lastRenderedFrameWidth = 0;
  lastRenderedFrameHeight = 0;
}

function promptLabel() {
  const slashMode = currentInputValue().trimStart().startsWith("/");
  const promptTone = slashMode ? color.teal : color.magenta;
  return `${promptTone}${color.bold}>${color.reset} `;
}

function render() {
  renderPending = false;
  enterAltScreen();
  const width = termWidth();
  const height = termHeight();
  const footerRows = 3;
  let frame;
  const slashMode = currentInputValue().trimStart().startsWith("/");

  if (shouldShowSplash()) {
    const splashHeight = Math.max(8, height - footerRows);
    frame = splashHeight >= 16
      ? renderSplash(width, splashHeight)
      : renderCompactSplash(width, splashHeight);
  } else {
    const header = headerLines(width);
    const popup = expandedEventId
      ? []
      : slashMode
        ? commandPaletteLines(Math.min(68, Math.max(38, width - 4)), Math.max(4, Math.min(8, height - 12)))
        : [];
    const { bodyHeight, useSidebar, sidebarWidth, transcriptWidth } = currentTranscriptLayout();
    const transcriptView = expandedEventId
      ? expandedDetailLines(transcriptWidth, bodyHeight)
      : activityPanelLines(transcriptWidth, bodyHeight);
    const transcript = useSidebar
      ? joinColumns(
        transcriptView.lines,
        sidebarLines(sidebarWidth, bodyHeight),
        transcriptWidth,
        sidebarWidth,
        2,
      )
      : transcriptView.lines;
    frame = [
      ...header,
      ...transcript,
      ...(popup.length > 0 ? ["", ...popup.map((line) => `  ${line}`)] : []),
    ];
  }
  const composer = composerRenderLine(width);
  const bodyRows = Math.max(0, height - footerRows);
  const nextFrameLines = [];
  for (let rowIndex = 0; rowIndex < bodyRows; rowIndex += 1) {
    nextFrameLines.push(paintSurface(frame[rowIndex] ?? "", width, color.panelBg));
  }
  nextFrameLines.push(paintSurface(footerStatusLine(width), width, color.panelBg));
  nextFrameLines.push(paintSurface(footerHintLine(width), width, color.panelBg));
  nextFrameLines.push(paintSurface(composer.line, width, color.panelBg));

  const requiresFullClear =
    lastRenderedFrameWidth !== width ||
    lastRenderedFrameHeight !== height ||
    lastRenderedFrameLines.length !== nextFrameLines.length;

  process.stdout.write("\x1b[?25l");
  if (requiresFullClear) {
    process.stdout.write(`${color.panelBg}\x1b[H\x1b[2J`);
    for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
      process.stdout.write(`\x1b[${rowIndex + 1};1H${nextFrameLines[rowIndex]}`);
    }
  } else {
    for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
      if (nextFrameLines[rowIndex] === lastRenderedFrameLines[rowIndex]) {
        continue;
      }
      process.stdout.write(`\x1b[${rowIndex + 1};1H\x1b[2K${nextFrameLines[rowIndex]}`);
    }
  }
  lastRenderedFrameLines = nextFrameLines;
  lastRenderedFrameWidth = width;
  lastRenderedFrameHeight = height;
  process.stdout.write(`\x1b[${height};${composer.cursorColumn}H\x1b[?25h`);
  process.stdout.write(color.reset);
}

function scheduleRender() {
  if (renderPending) {
    return;
  }
  renderPending = true;
  setTimeout(render, 0);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) {
    return;
  }
  const delayMs = Math.min(
    reconnectMaxDelayMs,
    reconnectMinDelayMs * Math.max(1, reconnectAttempts),
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
  setTransientStatus(`websocket disconnected, retrying in ${delayMs}ms`);
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
    latestTool = toolName;
    latestToolState = isError ? "error" : "ok";
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
    {
      toolName,
      toolArgs: args,
      previewMode: descriptor.previewMode,
    },
  );
}

function latestSubagentToolArgs(subagentSessionId, toolName) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.subagentSessionId === subagentSessionId &&
      event.toolName === toolName &&
      event.toolArgs
    ) {
      return event.toolArgs;
    }
  }
  return undefined;
}

function setSubagentLiveActivity(subagentSessionId, value) {
  if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
    return;
  }
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    subagentLiveActivity.delete(subagentSessionId);
    return;
  }
  subagentLiveActivity.set(subagentSessionId, text);
}

function getSubagentLiveActivity(subagentSessionId) {
  if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
    return null;
  }
  return subagentLiveActivity.get(subagentSessionId) ?? null;
}

function clearSubagentLiveActivity(subagentSessionId) {
  if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
    return;
  }
  subagentLiveActivity.delete(subagentSessionId);
}

function resetDelegationState() {
  subagentPlanSteps.clear();
  subagentSessionPlanKeys.clear();
  subagentLiveActivity.clear();
  recentSubagentLifecycleFingerprints.clear();
  resetPlannerDagState();
}

function subagentLifecycleFingerprint(type, payload) {
  const data = subagentPayloadData(payload);
  const subagentSessionId = sanitizeInlineText(
    payload?.subagentSessionId ?? data.subagentSessionId ?? "",
  );
  if (!subagentSessionId) {
    return null;
  }
  const traceId = sanitizeInlineText(payload?.traceId ?? data.traceId ?? "");
  const toolCallId = sanitizeInlineText(payload?.toolCallId ?? data.toolCallId ?? "");
  const eventStamp = Number(payload?.timestamp ?? data.timestamp);
  const discriminator = traceId ||
    toolCallId ||
    (Number.isFinite(eventStamp) ? String(eventStamp) : "") ||
    sanitizeInlineText(payload?.toolName ?? data.toolName ?? "") ||
    sanitizeInlineText(payload?.probeName ?? data.probeName ?? data.category ?? "");
  if (!discriminator) {
    return null;
  }
  return `${type}|${subagentSessionId}|${discriminator}`;
}

function shouldSkipDuplicateSubagentLifecycleEvent(type, payload) {
  const fingerprint = subagentLifecycleFingerprint(type, payload);
  if (!fingerprint) {
    return false;
  }
  const now = Date.now();
  for (const [key, seenAt] of recentSubagentLifecycleFingerprints.entries()) {
    if (now - seenAt > 60_000) {
      recentSubagentLifecycleFingerprints.delete(key);
    }
  }
  if (recentSubagentLifecycleFingerprints.has(fingerprint)) {
    return true;
  }
  recentSubagentLifecycleFingerprints.set(fingerprint, now);
  return false;
}

function handleSubagentLifecycleEvent(type, payload) {
  const data = subagentPayloadData(payload);
  const label = subagentLabel(payload);
  const objective = sanitizeInlineText(data.objective ?? "");
  const stepName = sanitizeInlineText(data.stepName ?? "");
  const baseMetadata = {
    subagentSessionId: payload?.subagentSessionId ?? null,
    toolName: payload?.toolName ?? null,
  };

  switch (type) {
    case "subagents.planned":
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "planned",
        note: objective || stepName,
      });
      pushEvent(
        "subagent",
        stepName ? `Plan ${stepName}` : "Delegation planned",
        objective || stepName || label,
        "magenta",
        baseMetadata,
      );
      return;
    case "subagents.policy_bypassed":
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        note: "unsafe benchmark mode active",
      });
      pushEvent(
        "subagent",
        "Unsafe delegation policy bypassed",
        [
          objective ? `objective: ${objective}` : null,
          "unsafe benchmark mode is active for this delegated child",
        ].filter(Boolean).join("\n"),
        "amber",
        baseMetadata,
      );
      return;
    case "subagents.spawned":
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        note: objective || stepName,
      });
      pushEvent(
        "subagent",
        `${label} spawned${objective ? ` · ${truncate(objective, 88)}` : ""}`,
        [
          objective ? `objective: ${objective}` : null,
          stepName ? `step: ${stepName}` : null,
          typeof data.workingDirectory === "string"
            ? `cwd: ${compactPathForDisplay(data.workingDirectory)}`
            : null,
          Array.isArray(data.tools) && data.tools.length > 0
            ? `tools: ${data.tools.join(", ")}`
            : null,
        ].filter(Boolean).join("\n") || label,
        "magenta",
        baseMetadata,
      );
      return;
    case "subagents.started":
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        note: objective || stepName,
      });
      pushEvent(
        "subagent",
        `${label} started${objective ? ` · ${truncate(objective, 88)}` : ""}`,
        [
          objective ? `objective: ${objective}` : null,
          stepName ? `step: ${stepName}` : null,
          label,
        ].filter(Boolean).join("\n"),
        "magenta",
        baseMetadata,
      );
      return;
    case "subagents.progress":
      {
        const liveActivity = getSubagentLiveActivity(payload?.subagentSessionId);
        const elapsedSeconds = Number.isFinite(Number(data.elapsedMs))
          ? Math.round(Number(data.elapsedMs) / 1000)
          : null;
        const note = [
          liveActivity,
          elapsedSeconds !== null ? `elapsed ${elapsedSeconds}s` : null,
        ].filter(Boolean).join(" · ");
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: note || objective || stepName,
        });
        setTransientStatus(
          [
            label,
            liveActivity || "working",
            elapsedSeconds !== null ? `${elapsedSeconds}s` : null,
          ].filter(Boolean).join(" · "),
        );
      }
      return;
    case "subagents.tool.executing": {
      const toolName = payload?.toolName ?? "tool";
      const descriptor = describeToolStart(toolName, data.args);
      const suppressTranscript = shouldSuppressToolTranscript(toolName, data.args);
      const suppressActivity = shouldSuppressToolActivity(toolName, data.args);
      if (!suppressActivity) {
        setSubagentLiveActivity(payload?.subagentSessionId, descriptor.title);
      }
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        ...(suppressActivity ? {} : { note: descriptor.title }),
      });
      if (!suppressTranscript) {
        pushEvent(
          "subagent tool",
          `${label} ${descriptor.title}`,
          [
            objective ? `objective: ${objective}` : null,
            descriptor.body,
          ].filter(Boolean).join("\n"),
          descriptor.tone,
          {
            ...baseMetadata,
            toolArgs: data.args,
            previewMode: descriptor.previewMode,
          },
        );
      }
      return;
    }
    case "subagents.tool.result": {
      const toolName = payload?.toolName ?? "tool";
      const args =
        data.args ??
        latestSubagentToolArgs(payload?.subagentSessionId, toolName);
      const descriptor = describeToolResult(
        toolName,
        args,
        false,
        data.result ?? "",
      );
      const suppressTranscript = shouldSuppressToolTranscript(toolName, args);
      const suppressActivity = shouldSuppressToolActivity(toolName, args);
      if (!suppressActivity) {
        setSubagentLiveActivity(payload?.subagentSessionId, descriptor.title);
      }
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        ...(suppressActivity ? {} : { note: descriptor.title }),
      });
      if (suppressTranscript) {
        return;
      }
      if (
        replaceLatestSubagentToolEvent(
          payload?.subagentSessionId ?? null,
          toolName,
          false,
          descriptor.body,
          {
            ...descriptor,
            title: `${label} ${descriptor.title}`,
          },
        )
      ) {
        return;
      }
      pushEvent(
        "subagent tool result",
        `${label} ${descriptor.title}`,
        descriptor.body,
        descriptor.tone,
        {
          ...baseMetadata,
          toolArgs: args,
          previewMode: descriptor.previewMode,
        },
      );
      return;
    }
    case "subagents.completed":
      clearSubagentHeartbeatEvents(payload?.subagentSessionId);
      clearSubagentLiveActivity(payload?.subagentSessionId);
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "completed",
        note: firstMeaningfulLine(typeof data.output === "string" ? data.output : "") ||
          `tool calls ${Number.isFinite(Number(data.toolCalls)) ? data.toolCalls : 0}`,
      });
      pushEvent(
        "subagent",
        `${label} completed`,
        [
          objective ? `objective: ${objective}` : null,
          Number.isFinite(Number(data.toolCalls))
            ? `tool calls: ${data.toolCalls}`
            : null,
          Number.isFinite(Number(data.durationMs))
            ? `duration: ${Math.round(Number(data.durationMs) / 1000)}s`
            : null,
          firstMeaningfulLine(typeof data.output === "string" ? data.output : ""),
        ].filter(Boolean).join("\n") || "delegated child completed",
        "green",
        baseMetadata,
      );
      return;
    case "subagents.acceptance_probe.started": {
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        note: sanitizeInlineText(data.probeName ?? data.category ?? "acceptance probe"),
      });
      const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
      const command = formatShellCommand(data.command, data.args);
      pushEvent(
        "subagent",
        `${label} probe ${truncate(probeName || "acceptance", 64)} started`,
        [
          stepName ? `step: ${stepName}` : null,
          probeName ? `probe: ${probeName}` : null,
          typeof data.category === "string"
            ? `category: ${sanitizeInlineText(data.category)}`
            : null,
          command ? `command: ${command}` : null,
          typeof data.cwd === "string"
            ? `cwd: ${compactPathForDisplay(data.cwd)}`
            : null,
        ].filter(Boolean).join("\n") || "delegated acceptance probe started",
        "slate",
        {
          ...baseMetadata,
          probeName: data.probeName ?? null,
          category: data.category ?? null,
        },
      );
      return;
    }
    case "subagents.acceptance_probe.completed": {
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "running",
        note: `${sanitizeInlineText(data.probeName ?? data.category ?? "acceptance")} passed`,
      });
      const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
      pushEvent(
        "subagent",
        `${label} probe ${truncate(probeName || "acceptance", 64)} passed`,
        [
          stepName ? `step: ${stepName}` : null,
          probeName ? `probe: ${probeName}` : null,
          typeof data.category === "string"
            ? `category: ${sanitizeInlineText(data.category)}`
            : null,
          Number.isFinite(Number(data.durationMs))
            ? `duration: ${Math.round(Number(data.durationMs) / 1000)}s`
            : null,
          firstMeaningfulLine(typeof data.result === "string" ? data.result : ""),
        ].filter(Boolean).join("\n") || "delegated acceptance probe passed",
        "green",
        {
          ...baseMetadata,
          probeName: data.probeName ?? null,
          category: data.category ?? null,
        },
      );
      return;
    }
    case "subagents.acceptance_probe.failed": {
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "failed",
        note:
          firstMeaningfulLine(typeof data.error === "string" ? data.error : "") ||
          `${sanitizeInlineText(data.probeName ?? data.category ?? "acceptance")} failed`,
      });
      const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
      const command = formatShellCommand(data.command, data.args);
      pushEvent(
        "subagent error",
        `${label} probe ${truncate(probeName || "acceptance", 64)} failed`,
        [
          stepName ? `step: ${stepName}` : null,
          probeName ? `probe: ${probeName}` : null,
          typeof data.category === "string"
            ? `category: ${sanitizeInlineText(data.category)}`
            : null,
          command ? `command: ${command}` : null,
          typeof data.cwd === "string"
            ? `cwd: ${compactPathForDisplay(data.cwd)}`
            : null,
          firstMeaningfulLine(typeof data.error === "string" ? data.error : ""),
        ].filter(Boolean).join("\n") || "delegated acceptance probe failed",
        "red",
        {
          ...baseMetadata,
          probeName: data.probeName ?? null,
          category: data.category ?? null,
        },
      );
      return;
    }
    case "subagents.failed":
      clearSubagentHeartbeatEvents(payload?.subagentSessionId);
      clearSubagentLiveActivity(payload?.subagentSessionId);
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "failed",
        note:
          firstMeaningfulLine(typeof data.reason === "string" ? data.reason : "") ??
          firstMeaningfulLine(typeof data.error === "string" ? data.error : "") ??
          formatValidationCode(data.validationCode) ??
          objective,
      });
      pushEvent(
        "subagent error",
        `${label} failed${data.retrying ? ` · retry ${data.retryAttempt}/${data.maxRetries}` : ""}`,
        [
          stepName ? `step: ${stepName}` : null,
          formatValidationCode(data.validationCode)
            ? `validation: ${formatValidationCode(data.validationCode)}`
            : null,
          typeof data.failureClass === "string"
            ? `class: ${sanitizeInlineText(data.failureClass)}`
            : null,
          data.retrying && Number.isFinite(Number(data.nextRetryDelayMs))
            ? `next retry: ${Math.round(Number(data.nextRetryDelayMs))}ms`
            : null,
          firstMeaningfulLine(typeof data.reason === "string" ? data.reason : "") ??
            firstMeaningfulLine(typeof data.error === "string" ? data.error : ""),
          firstMeaningfulLine(typeof data.output === "string" ? data.output : ""),
        ].filter(Boolean).join("\n") || "delegated child failed",
        "red",
        {
          ...baseMetadata,
          validationCode: data.validationCode ?? null,
          failureClass: data.failureClass ?? null,
          retrying: data.retrying === true,
        },
      );
      return;
    case "subagents.cancelled":
      clearSubagentHeartbeatEvents(payload?.subagentSessionId);
      clearSubagentLiveActivity(payload?.subagentSessionId);
      updateSubagentPlanStep({
        stepName,
        objective,
        subagentSessionId: payload?.subagentSessionId,
        status: "cancelled",
        note: objective || stepName || "cancelled",
      });
      pushEvent(
        "subagent error",
        `${label} cancelled`,
        objective || "delegated child cancelled",
        "amber",
        baseMetadata,
      );
      return;
    case "subagents.synthesized":
      clearSubagentHeartbeatEvents(payload?.subagentSessionId);
      clearSubagentLiveActivity(payload?.subagentSessionId);
      {
        const stopReason = sanitizeInlineText(data.stopReason ?? "");
        const stopReasonDetail = firstMeaningfulLine(
          typeof data.stopReasonDetail === "string" ? data.stopReasonDetail : "",
        );
        const outputPreview = firstMeaningfulLine(
          typeof data.outputPreview === "string"
            ? data.outputPreview
            : typeof data.output === "string"
              ? data.output
              : "",
        );
        const nextStatus =
          stopReason === "completed"
            ? "completed"
            : stopReason === "cancelled"
              ? "cancelled"
              : "failed";
        const synthesizedStep = updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: nextStatus,
        });
        const currentNote = sanitizeInlineText(synthesizedStep?.note ?? "");
        const synthesisNote =
          outputPreview ||
          stopReasonDetail ||
          (Number.isFinite(Number(data.toolCalls))
            ? `parent synthesis after ${data.toolCalls} tool calls`
            : "parent synthesis emitted");
        if (
          synthesizedStep &&
          (
            !currentNote ||
            currentNote === sanitizeInlineText(synthesizedStep.objective ?? "") ||
            currentNote === sanitizeInlineText(synthesizedStep.stepName ?? "") ||
            currentNote === "parent synthesis emitted"
          )
        ) {
          synthesizedStep.note = synthesisNote;
        }
        const titleSuffix =
          stopReason && stopReason !== "completed"
            ? ` · ${stopReason.replace(/_/g, " ")}`
            : "";
        const tone =
          nextStatus === "completed"
            ? "cyan"
            : nextStatus === "cancelled"
              ? "amber"
              : "red";
        pushEvent(
          "subagent",
          stepName || objective
            ? `${label} synthesis ready${titleSuffix}`
            : `Delegated synthesis ready${titleSuffix}`,
          [
            objective ? `objective: ${objective}` : null,
            stepName ? `step: ${stepName}` : null,
            stopReason ? `stop: ${stopReason.replace(/_/g, " ")}` : null,
            Number.isFinite(Number(data.toolCalls))
              ? `tool calls: ${data.toolCalls}`
              : null,
            stopReasonDetail,
            outputPreview && outputPreview !== stopReasonDetail ? outputPreview : null,
          ].filter(Boolean).join("\n") || synthesisNote,
          tone,
          baseMetadata,
        );
      }
      return;
    default:
      pushEvent("subagent", type, tryPrettyJson(payload ?? {}), "slate", baseMetadata);
  }
}

function handleSubagentLifecycleMessage(type, payload) {
  if (plannerDagNodes.size <= 1) {
    hydratePlannerDagForLiveSession({ force: plannerDagNodes.size === 1 });
  }
  if (shouldSkipDuplicateSubagentLifecycleEvent(type, payload ?? {})) {
    return true;
  }
  handleSubagentLifecycleEvent(type, payload ?? {});
  const statusText = describeSubagentStatus(type, payload ?? {});
  if (statusText) {
    setTransientStatus(statusText);
  }
  requestRunInspect(type);
  return true;
}

function handleWrappedLifecycleEvent(msg) {
  const eventType = wrappedEventType(msg);
  if (!eventType || !eventType.startsWith("subagents.")) {
    return false;
  }
  return handleSubagentLifecycleMessage(eventType, wrappedEventData(msg));
}

function handlePlannerTraceEvent(type, payload) {
  const stepName = sanitizeInlineText(payload?.stepName ?? "");
  const eventSessionId = sanitizeInlineText(
    payload?.sessionId ?? payload?.parentSessionId ?? "",
  );
  if (
    sessionId &&
    eventSessionId &&
    !sessionValuesMatch(eventSessionId, sessionId)
  ) {
    return false;
  }
  if (type !== "planner_plan_parsed" && plannerDagNodes.size <= 1) {
    hydratePlannerDagForLiveSession({ force: plannerDagNodes.size === 1 });
  }
  switch (type) {
    case "planner_plan_parsed":
      ingestPlannerDag(payload ?? {});
      return true;
    case "planner_pipeline_started":
      plannerDagPipelineId = sanitizeInlineText(payload?.pipelineId ?? "") || plannerDagPipelineId;
      plannerDagNote = sanitizeInlineText(payload?.routeReason ?? "") || plannerDagNote;
      plannerDagStatus = plannerDagNodes.size > 0 ? "planned" : plannerDagStatus;
      plannerDagUpdatedAt = Date.now();
      return true;
    case "planner_step_started":
      updatePlannerDagNode({
        stepName,
        status: "running",
        tool: payload?.tool,
        note: describeToolStart(payload?.tool ?? "tool", payload?.args).title,
      });
      plannerDagPipelineId = sanitizeInlineText(payload?.pipelineId ?? "") || plannerDagPipelineId;
      return true;
    case "planner_step_finished": {
      const isError = payload?.isError === true || typeof payload?.error === "string";
      const toolName = sanitizeInlineText(payload?.tool ?? "tool");
      const descriptor = describeToolResult(
        toolName || "tool",
        payload?.args,
        isError,
        typeof payload?.error === "string" ? payload.error : payload?.result ?? "",
      );
      updatePlannerDagNode({
        stepName,
        status: isError ? "failed" : "completed",
        tool: toolName,
        note: descriptor.title,
      });
      plannerDagPipelineId = sanitizeInlineText(payload?.pipelineId ?? "") || plannerDagPipelineId;
      return true;
    }
    case "planner_refinement_requested":
      retirePlannerDagOpenNodes(
        "blocked",
        sanitizeInlineText(
          payload?.reason ??
            payload?.routeReason ??
            payload?.verificationRequirementDiagnostics?.[0]?.message ??
            "",
        ) || "planner refinement requested",
      );
      plannerDagStatus = "blocked";
      plannerDagNote = sanitizeInlineText(
        payload?.reason ??
          payload?.routeReason ??
          payload?.verificationRequirementDiagnostics?.[0]?.message ??
          "",
      ) || "planner refinement requested";
      plannerDagUpdatedAt = Date.now();
      return true;
    case "planner_pipeline_finished":
    case "planner_path_finished": {
      const stopReason = sanitizeInlineText(
        payload?.stopReason ?? payload?.stopReasonHint ?? "",
      );
      const stopReasonDetail = sanitizeInlineText(
        payload?.stopReasonDetail ??
          payload?.error ??
          payload?.diagnostics?.[0]?.message ??
          payload?.reason ??
          "",
      );
      retirePlannerDagOpenNodes(
        stopReason === "completed" || stopReason === "cancelled"
          ? "cancelled"
          : "failed",
        stopReasonDetail ||
          (stopReason
            ? stopReason.replace(/_/g, " ")
            : "planner path finished"),
      );
      if (stopReason) {
        plannerDagStatus = stopReason === "completed"
          ? "completed"
          : stopReason === "cancelled"
            ? "cancelled"
            : "failed";
      }
      const terminalStopReason = new Set([
        "",
        "completed",
        "cancelled",
        "failed",
        "validation_error",
        "timeout",
      ]);
      runPhase = null;
      runState = terminalStopReason.has(stopReason) ? "idle" : stopReason;
      if (terminalStopReason.has(stopReason)) {
        activeRunStartedAtMs = null;
      }
      plannerDagNote = stopReasonDetail || plannerDagNote;
      plannerDagUpdatedAt = Date.now();
      return true;
    }
    default:
      return false;
  }
}

function handleWrappedPlannerEvent(msg) {
  const eventType = wrappedEventType(msg);
  if (!eventType || !eventType.startsWith("planner_")) {
    return false;
  }
  return handlePlannerTraceEvent(eventType, wrappedEventData(msg));
}

function attachSocket(socket) {
  socket.addEventListener("open", () => {
    ws = socket;
    isOpen = true;
    reconnectAttempts = 0;
    bootstrapAttempts = 0;
    bootstrapReady = false;
    connectionState = "live";
    setTransientStatus(`connected to ${wsUrl}`);
    while (pendingFrames.length > 0) {
      socket.send(pendingFrames.shift());
    }
    send("events.subscribe", { filters: [...LIVE_EVENT_FILTERS] });
    send("status.get", {});
    ensureStatusPollTimer();
    sendBootstrapProbe();
  });

  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      pushEvent("raw", "Unparsed Event", raw, "slate");
      return;
    }
    if (shouldIgnoreSessionScopedMessage(msg)) {
      return;
    }

    switch (msg.type) {
      case "events.subscribed":
        setTransientStatus(
          `event stream ready: ${Array.isArray(msg.payload?.filters) && msg.payload.filters.length > 0
            ? msg.payload.filters.join(", ")
            : "all events"}`,
        );
        break;
      case "events.event": {
        if (handleWrappedPlannerEvent(msg)) {
          break;
        }
        if (handleWrappedLifecycleEvent(msg)) {
          break;
        }
        break;
      }
      case "chat.session":
        sessionId = msg.payload?.sessionId ?? sessionId;
        persistSessionId(sessionId);
        sessionAttachedAtMs = Date.now();
        resetLiveRunSurface();
        runDetail = null;
        runState = "idle";
        runPhase = null;
        markBootstrapReady(`session ready: ${sessionId}`);
        break;
      case "chat.owner":
        if (typeof msg.payload?.ownerToken === "string" && msg.payload.ownerToken.trim()) {
          ownerToken = msg.payload.ownerToken.trim();
          persistOwnerToken(ownerToken);
        }
        break;
      case "chat.resumed":
        sessionId = msg.payload?.sessionId ?? sessionId;
        persistSessionId(sessionId);
        sessionAttachedAtMs = Date.now();
        bootstrapReady = false;
        clearBootstrapTimer();
        setTransientStatus(`session resumed: ${sessionId}; restoring history`);
        send("chat.history", authPayload({ limit: 50 }));
        requestRunInspect("resume", { force: true });
        break;
      case "chat.sessions": {
        if (manualSessionsRequestPending) {
          manualSessionsRequestPending = false;
          pushEvent("session", "Sessions", formatSessionSummaries(msg.payload), "teal");
          setTransientStatus("session list loaded");
          break;
        }
        const target = latestSessionSummary(msg.payload, sessionId);
        if (target?.sessionId) {
          sessionId = target.sessionId;
          persistSessionId(sessionId);
          setTransientStatus(`resuming session ${sessionId}`);
          send("chat.resume", authPayload({ sessionId: target.sessionId }));
        } else {
          setTransientStatus("no existing session; creating a new one");
          send("chat.new", authPayload());
        }
        break;
      }
      case "chat.history": {
        const history = Array.isArray(msg.payload) ? msg.payload : [];
        if (manualHistoryRequestPending) {
          manualHistoryRequestPending = false;
          pushEvent("history", "Chat History", formatHistoryPayload(history), "slate");
          setTransientStatus(`history loaded: ${history.length} item(s)`);
        } else if (!bootstrapReady && sessionId) {
          restoreTranscriptFromHistory(history);
          markBootstrapReady(`history restored: ${history.length} item(s)`);
          requestRunInspect("history restore", { force: true });
        } else {
          setTransientStatus(`history restored: ${history.length} item(s)`);
        }
        break;
      }
      case "chat.message":
        latestAgentSummary = sanitizeInlineText(msg.payload?.content ?? "") || null;
        setTransientStatus("agent reply received");
        pushEvent("agent", "Agent Reply", msg.payload?.content ?? "", "cyan");
        if (currentObjective && shouldAutoInspectRun(runDetail, runState)) {
          requestRunInspect("agent reply");
        }
        break;
      case "chat.stream":
        if (msg.payload?.delta) {
          setTransientStatus(`streaming: ${truncate(msg.payload.delta, 72)}`);
        }
        break;
      case "chat.typing":
        setTransientStatus("agent is typing…");
        break;
      case "chat.cancelled":
        setTransientStatus("chat cancelled");
        pushEvent("cancelled", "Chat Cancelled", tryPrettyJson(msg.payload ?? {}), "amber");
        break;
      case "subagents.planned":
      case "subagents.policy_bypassed":
      case "subagents.spawned":
      case "subagents.started":
      case "subagents.progress":
      case "subagents.tool.executing":
      case "subagents.tool.result":
      case "subagents.acceptance_probe.started":
      case "subagents.acceptance_probe.completed":
      case "subagents.acceptance_probe.failed":
      case "subagents.completed":
      case "subagents.failed":
      case "subagents.cancelled":
      case "subagents.synthesized":
        handleSubagentLifecycleMessage(msg.type, msg.payload ?? {});
        break;
      case "planner_plan_parsed":
      case "planner_pipeline_started":
      case "planner_step_started":
      case "planner_step_finished":
      case "planner_refinement_requested":
      case "planner_pipeline_finished":
      case "planner_path_finished":
        handlePlannerTraceEvent(msg.type, msg.payload ?? {});
        break;
      case "tools.executing":
        {
          const toolName = msg.payload?.toolName ?? "unknown";
          const descriptor = describeToolStart(
            toolName,
            msg.payload?.args,
          );
          const suppressTranscript = shouldSuppressToolTranscript(toolName, msg.payload?.args);
          const suppressActivity = shouldSuppressToolActivity(toolName, msg.payload?.args);
          if (!suppressActivity) {
            latestTool = toolName;
            latestToolState = "running";
            setTransientStatus(descriptor.title);
          }
          if (!suppressTranscript) {
            pushEvent(
              "tool",
              descriptor.title,
              descriptor.body,
              descriptor.tone,
              {
                toolName,
                toolArgs: msg.payload?.args,
                previewMode: descriptor.previewMode,
              },
            );
          }
        }
        requestRunInspect("tool start");
        break;
      case "tools.result":
        handleToolResult(
          msg.payload?.toolName ?? "unknown",
          Boolean(msg.payload?.isError),
          msg.payload?.result ?? "",
          msg.payload?.args,
        );
        requestRunInspect("tool result");
        break;
      case "chat.usage":
        lastUsageSummary = summarizeUsage(msg.payload);
        liveSessionModelRoute = normalizeModelRoute(msg.payload) ?? liveSessionModelRoute;
        break;
      case "social.message":
        setTransientStatus(
          `social message from ${truncate(msg.payload?.sender ?? "unknown", 32)}`,
        );
        pushEvent(
          "social",
          "Social Message",
          [
            `from: ${msg.payload?.sender ?? "unknown"}`,
            `to: ${msg.payload?.recipient ?? "unknown"}`,
            `mode: ${msg.payload?.mode ?? "unknown"}`,
            `messageId: ${msg.payload?.messageId ?? "unknown"}`,
            `threadId: ${msg.payload?.threadId ?? "none"}`,
            "",
            msg.payload?.content ?? "",
          ].join("\n"),
          "blue",
        );
        break;
      case "runs.list":
        pushEvent("runs", "Run List", tryPrettyJson(msg.payload ?? []), "blue");
        break;
      case "run.inspect":
        runInspectPending = false;
        runDetail = msg.payload ?? null;
        currentObjective = msg.payload?.objective ?? currentObjective;
        runState = msg.payload?.state ?? runState;
        runPhase = msg.payload?.currentPhase ?? runPhase;
        activeRunStartedAtMs = Number.isFinite(Number(msg.payload?.createdAt))
          ? Number(msg.payload.createdAt)
          : activeRunStartedAtMs ?? Date.now();
        hydratePlannerDagFromTraceArtifacts(msg.payload?.sessionId ?? sessionId);
        setTransientStatus(`run inspect loaded: ${runState ?? "unknown"}`);
        break;
      case "run.updated":
        runState = msg.payload?.state ?? runState;
        runPhase = msg.payload?.currentPhase ?? runPhase;
        if (!Number.isFinite(Number(activeRunStartedAtMs))) {
          activeRunStartedAtMs = Date.now();
        }
        setTransientStatus(`run updated: ${runState ?? "unknown"}`);
        pushEvent(
          "run",
          "Run Update",
          [
            `state: ${runState ?? "unknown"}`,
            `phase: ${runPhase ?? "unknown"}`,
            `session: ${msg.payload?.sessionId ?? sessionId ?? "unknown"}`,
            msg.payload?.explanation ? `explanation: ${msg.payload.explanation}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "magenta",
        );
        requestRunInspect("run update");
        break;
      case "observability.traces":
        setTransientStatus("trace list loaded");
        pushEvent("trace", "Trace List", tryPrettyJson(msg.payload ?? []), "slate");
        break;
      case "observability.trace":
        setTransientStatus("trace detail loaded");
        pushEvent(
          "trace",
          "Trace Detail",
          tryPrettyJson(msg.payload?.summary ?? msg.payload ?? {}),
          "slate",
        );
        break;
      case "observability.logs":
        setTransientStatus("log bundle loaded");
        pushEvent("logs", "Daemon Logs", formatLogPayload(msg.payload), "slate");
        break;
      case "status.update":
        lastStatus = msg.payload ?? lastStatus;
        configuredModelRoute = normalizeModelRoute(msg.payload) ?? configuredModelRoute;
        setTransientStatus("gateway status loaded");
        {
          const fingerprint = statusFeedFingerprint(msg.payload);
          const shouldEmit =
            manualStatusRequestPending ||
            lastStatusFeedFingerprint === null ||
            fingerprint !== lastStatusFeedFingerprint;
          manualStatusRequestPending = false;
          lastStatusFeedFingerprint = fingerprint;
          if (shouldEmit) {
            pushEvent("status", "Gateway Status", formatStatusPayload(msg.payload), "blue");
          }
        }
        break;
      case "agent.status":
        runPhase = msg.payload?.phase ?? runPhase;
        setTransientStatus(
          msg.payload?.phase
            ? `phase ${msg.payload.phase}`
            : "agent status updated",
        );
        requestRunInspect("agent status");
        break;
      case "approval.request":
        pushEvent("approval", "Approval Request", tryPrettyJson(msg.payload ?? {}), "red");
        break;
      case "error":
        runInspectPending = false;
        manualStatusRequestPending = false;
        manualSessionsRequestPending = false;
        manualHistoryRequestPending = false;
        if (isExpectedMissingRunInspect(msg.error)) {
          runDetail = null;
          runState = "idle";
          runPhase = null;
          setTransientStatus("no active background run for this session");
          break;
        }
        if (isRetryableBootstrapError(msg.error)) {
          scheduleBootstrap("webchat handler still starting");
          break;
        }
        setTransientStatus("runtime error");
        pushEvent("error", "Runtime Error", msg.error ?? tryPrettyJson(msg.payload ?? msg), "red");
        break;
      default:
        pushEvent(msg.type, msg.type, tryPrettyJson(msg.payload ?? msg), "slate");
        break;
    }
    scheduleRender();
  });

  socket.addEventListener("close", () => {
    isOpen = false;
    ws = null;
    bootstrapReady = false;
    manualSessionsRequestPending = false;
    manualHistoryRequestPending = false;
    connectionState = "reconnecting";
    clearBootstrapTimer();
    clearStatusPollTimer();
    if (shuttingDown) {
      leaveAltScreen();
      process.exit(0);
      return;
    }
    reconnectAttempts += 1;
    scheduleReconnect();
  });

  socket.addEventListener("error", (error) => {
    const message =
      typeof error?.message === "string" && error.message.trim().length > 0
        ? error.message.trim()
        : "";
    if (message) {
      pushEvent("ws-error", "WebSocket Error", message, "red");
    } else {
      setTransientStatus("websocket reconnecting");
    }
    if (!isOpen) {
      scheduleReconnect();
    }
  });
}

function connect() {
  if (shuttingDown) {
    return;
  }
  connectionState = reconnectAttempts > 0 ? "reconnecting" : "connecting";
  setTransientStatus(`${connectionState}…`);
  const socket = new WebSocket(wsUrl);
  attachSocket(socket);
}

function printHelp() {
  pushEvent(
    "help",
    "Command Help",
    [
      "Keyboard",
      "Ctrl+O opens the newest event in a full detail view.",
      "Ctrl+Y copies the current detail view or transcript to tmux/system clipboard.",
      "Ctrl+L clears the visible transcript without leaving the session.",
      "",
      ...WATCH_COMMANDS.map((command) => {
        const aliasText =
          Array.isArray(command.aliases) && command.aliases.length > 0
            ? ` (${command.aliases.join(", ")})`
            : "";
        return `${command.usage}${aliasText}\n${command.description}`;
      }),
    ].join("\n\n"),
    "slate",
  );
}

function shouldQueueOperatorInput(value) {
  if (!isOpen || bootstrapPending()) {
    return true;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  return false;
}

function dispatchOperatorInput(value, { replayed = false } = {}) {
  dismissIntro();
  transcriptScrollOffset = 0;
  transcriptFollowMode = true;
  const maybeQueue = (reason) => {
    if (replayed) {
      pushEvent("error", "Queued Input Failed", `${value}\n\n${reason}`, "red");
      return true;
    }
    queueOperatorInput(value, reason);
    return true;
  };

  if (value.trim() === "/") {
    printHelp();
    return true;
  }

  const parsedSlash = parseWatchSlashCommand(value);
  if (parsedSlash) {
    const canonicalName = parsedSlash.command?.name ?? null;
    const firstArg = parsedSlash.args[0];

    if (canonicalName === "/quit") {
      shutdownWatch(0);
      return true;
    }

    if (canonicalName === "/help") {
      printHelp();
      return true;
    }

    if (canonicalName === "/clear") {
      events.length = 0;
      resetDelegationState();
      transcriptScrollOffset = 0;
      transcriptFollowMode = true;
      detailScrollOffset = 0;
      setTransientStatus("console cleared");
      return true;
    }

    if (canonicalName === "/export") {
      exportCurrentView({ announce: true });
      return true;
    }

    if (!canonicalName) {
      pushEvent(
        "error",
        "Unknown Command",
        `${parsedSlash.commandToken} is not a supported command.\n\nUse /help for the full command list.`,
        "red",
      );
      return true;
    }

    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }

    if (canonicalName === "/model") {
      pushEvent(
        "operator",
        "Model Query",
        "Requested current model routing and the known Grok model catalog.",
        "teal",
      );
      send("chat.message", authPayload({ content: value }));
      return true;
    }

    if (canonicalName === "/new") {
      resetLiveRunSurface();
      resetDelegationState();
      currentObjective = null;
      runDetail = null;
      runState = "idle";
      runPhase = null;
      bootstrapAttempts = 0;
      clearBootstrapTimer();
      pushEvent("operator", "New Session", "Requested a fresh chat session.", "teal");
      send("chat.new", authPayload());
      return true;
    }

    if (canonicalName === "/sessions") {
      manualSessionsRequestPending = true;
      pushEvent("operator", "Session List", "Requested resumable sessions.", "teal");
      send("chat.sessions", authPayload());
      return true;
    }

    if (canonicalName === "/session") {
      if (!firstArg) {
        pushEvent(
          "error",
          "Missing Session Id",
          "Usage: /session <sessionId>",
          "red",
        );
        return true;
      }
      sessionId = firstArg;
      persistSessionId(sessionId);
      pushEvent("operator", "Session Resume", `Resuming ${firstArg}.`, "teal");
      send("chat.resume", authPayload({ sessionId: firstArg }));
      return true;
    }

    if (canonicalName === "/history") {
      manualHistoryRequestPending = true;
      const limit = Number(firstArg);
      const payload = Number.isFinite(limit) && limit > 0
        ? authPayload({ limit: Math.floor(limit) })
        : authPayload();
      pushEvent("operator", "History Query", "Requested recent chat history.", "teal");
      send("chat.history", payload);
      return true;
    }

    if (canonicalName === "/runs") {
      pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
      send("runs.list", sessionId ? { sessionId } : {});
      return true;
    }

    if (canonicalName === "/inspect") {
      if (!requireSession("/inspect")) return;
      runInspectPending = true;
      pushEvent("operator", "Run Inspect", `Inspecting run for ${sessionId}.`, "teal");
      send("run.inspect", { sessionId });
      return true;
    }

    if (canonicalName === "/trace") {
      if (firstArg) {
        pushEvent("operator", "Trace Detail", `Inspecting trace ${firstArg}.`, "teal");
        send("observability.trace", { traceId: firstArg });
      } else {
        pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
        send("observability.traces", sessionId ? { sessionId, limit: 5 } : { limit: 5 });
      }
      return true;
    }

    if (canonicalName === "/logs") {
      const lines = Number(firstArg);
      const payload =
        Number.isFinite(lines) && lines > 0
          ? { lines: Math.floor(lines) }
          : { lines: 80 };
      pushEvent("operator", "Log Query", `Requested recent daemon logs (${payload.lines} lines).`, "teal");
      send("observability.logs", payload);
      return true;
    }

    if (canonicalName === "/status") {
      manualStatusRequestPending = true;
      pushEvent("operator", "Gateway Status", "Requested daemon status.", "teal");
      send("status.get", {});
      return true;
    }

    if (canonicalName === "/cancel") {
      pushEvent("operator", "Cancel Chat", `Cancelling chat for ${clientKey}.`, "teal");
      send("chat.cancel", authPayload());
      return true;
    }

    if (canonicalName === "/pause" || canonicalName === "/resume" || canonicalName === "/stop") {
      if (!requireSession(canonicalName)) return;
      runInspectPending = true;
      const action = canonicalName.slice(1);
      const title = action[0].toUpperCase() + action.slice(1);
      const progressiveVerb =
        action === "pause"
          ? "Pausing"
          : action === "resume"
            ? "Resuming"
            : "Stopping";
      pushEvent("operator", `${title} Run`, `${progressiveVerb} run for ${sessionId}.`, "teal");
      send("run.control", {
        action,
        sessionId,
        reason: `operator ${action}`,
      });
      return true;
    }
  }

  if (shouldQueueOperatorInput(value)) {
    return maybeQueue("session bootstrap not complete");
  }
  currentObjective = value;
  persistSessionId(sessionId);
  runState = "starting";
  runPhase = "queued";
  activeRunStartedAtMs = Date.now();
  resetDelegationState();
  pushEvent("you", "Prompt", value, "teal");
  send("chat.message", authPayload({ content: value }));
  return true;
}

connect();
scheduleRender();
ensureActivityPulseTimer();
setTimeout(() => {
  scheduleRender();
}, startupSplashMinMs);

function clearLiveTranscriptView() {
  events.length = 0;
  resetDelegationState();
  expandedEventId = null;
  transcriptScrollOffset = 0;
  transcriptFollowMode = true;
  detailScrollOffset = 0;
  setTransientStatus("view cleared");
}

function handleTerminalEscapeSequence(input, index) {
  const rest = input.slice(index);
  const sequenceTable = [
    { seq: "\x1b[1;5D", run: () => moveComposerCursorByWord(-1) },
    { seq: "\x1b[5D", run: () => moveComposerCursorByWord(-1) },
    { seq: "\x1bb", run: () => moveComposerCursorByWord(-1) },
    { seq: "\x1b[1;5C", run: () => moveComposerCursorByWord(1) },
    { seq: "\x1b[5C", run: () => moveComposerCursorByWord(1) },
    { seq: "\x1bf", run: () => moveComposerCursorByWord(1) },
    { seq: "\x1b[5~", run: () => scrollCurrentViewBy(12) },
    { seq: "\x1b[6~", run: () => scrollCurrentViewBy(-12) },
    { seq: "\x1b[3~", run: () => {
      if (composerCursor < composerInput.length) {
        composerInput =
          composerInput.slice(0, composerCursor) +
          composerInput.slice(composerCursor + 1);
        composerHistoryIndex = -1;
      }
    } },
    { seq: "\x1b[A", run: () => navigateComposerHistory(-1) },
    { seq: "\x1b[B", run: () => navigateComposerHistory(1) },
    { seq: "\x1b[D", run: () => {
      composerCursor = Math.max(0, composerCursor - 1);
    } },
    { seq: "\x1b[C", run: () => {
      composerCursor = Math.min(composerInput.length, composerCursor + 1);
    } },
    { seq: "\x1b[H", run: () => {
      composerCursor = 0;
    } },
    { seq: "\x1b[F", run: () => {
      composerCursor = composerInput.length;
    } },
    { seq: "\x1b[1~", run: () => {
      composerCursor = 0;
    } },
    { seq: "\x1b[4~", run: () => {
      composerCursor = composerInput.length;
    } },
  ];

  for (const entry of sequenceTable) {
    if (rest.startsWith(entry.seq)) {
      entry.run();
      return index + entry.seq.length;
    }
  }

  if (expandedEventId) {
    expandedEventId = null;
    detailScrollOffset = 0;
    setTransientStatus("detail closed");
  }
  return index + 1;
}

function handleTerminalInput(input) {
  if (shuttingDown || input.length === 0) {
    return;
  }

  let index = 0;
  let didMutate = false;

  while (index < input.length) {
    const mouseMatch = input.slice(index).match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const buttonCode = Number(mouseMatch[1]);
      if (Number.isFinite(buttonCode) && (buttonCode & 64) !== 0) {
        const direction = (buttonCode & 1) === 1 ? -3 : 3;
        scrollCurrentViewBy(direction);
      }
      didMutate = true;
      index += mouseMatch[0].length;
      continue;
    }

    const char = input[index];
    if (char === "\x03") {
      shutdownWatch(0);
      return;
    }
    if (char === "\x0f") {
      toggleExpandedEvent();
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x19") {
      copyCurrentView();
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x0c") {
      clearLiveTranscriptView();
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x0b") {
      deleteComposerToLineEnd();
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x01") {
      composerCursor = 0;
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x05") {
      composerCursor = composerInput.length;
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      submitComposerInput();
      didMutate = true;
      index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\t") {
      autocompleteSlashCommand();
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      if (composerCursor > 0) {
        composerInput =
          composerInput.slice(0, composerCursor - 1) +
          composerInput.slice(composerCursor);
        composerCursor -= 1;
        composerHistoryIndex = -1;
      }
      didMutate = true;
      index += 1;
      continue;
    }
    if (char === "\x1b") {
      index = handleTerminalEscapeSequence(input, index);
      didMutate = true;
      continue;
    }
    if (char < " ") {
      index += 1;
      continue;
    }

    if (!introDismissed) {
      dismissIntro();
    }
    insertComposerText(char);
    composerHistoryIndex = -1;
    didMutate = true;
    index += 1;
  }

  if (didMutate) {
    scheduleRender();
  }
}

process.stdin.on("data", (chunk) => {
  const input = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  handleTerminalInput(input);
});

process.stdout.on("resize", () => {
  scheduleRender();
});
