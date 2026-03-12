import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const reconnectMinDelayMs = 1_000;
const reconnectMaxDelayMs = 5_000;
const maxEvents = 60;
const maxInlineChars = 220;
const maxStoredBodyChars = 20_000;
const maxFeedPreviewLines = 2;
const maxPreviewSourceLines = 32;
const introDismissKinds = new Set([
  "you",
  "agent",
  "tool",
  "tool result",
  "tool error",
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

let requestCounter = 0;
let sessionId = null;
let runState = "idle";
let runPhase = null;
let connectionState = "connecting";
let latestTool = null;
let latestToolState = null;
let latestAgentSummary = null;
let currentObjective = null;
let runDetail = null;
let runInspectPending = false;
let isOpen = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let bootstrapTimer = null;
let bootstrapAttempts = 0;
let bootstrapReady = false;
let shuttingDown = false;
let ws = null;
let enteredAltScreen = false;
let renderPending = false;
let introDismissed = false;
let transientStatus = "Booting watch client…";
let lastStatus = null;
let lastUsageSummary = null;
let lastActivityAt = null;
let ownerToken = loadPersistedOwnerToken();
let manualSessionsRequestPending = false;
let manualHistoryRequestPending = false;
let expandedEventId = null;
let composerInput = "";
let composerCursor = 0;
let composerHistory = [];
let composerHistoryIndex = -1;
let composerHistoryDraft = "";
const queuedOperatorInputs = [];
const operatorInputBatcher = createOperatorInputBatcher({
  onDispatch: (value) => {
    dispatchOperatorInput(value);
  },
});

const pendingFrames = [];
const events = [];
readline.emitKeypressEvents(process.stdin);
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

function stable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function loadPersistedOwnerToken() {
  try {
    const raw = fs.readFileSync(watchStateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.clientKey === clientKey &&
      typeof parsed.ownerToken === "string" &&
      parsed.ownerToken.trim().length > 0
    ) {
      return parsed.ownerToken.trim();
    }
  } catch {}
  return null;
}

function persistOwnerToken(nextOwnerToken) {
  try {
    fs.mkdirSync(path.dirname(watchStateFile), { recursive: true });
    fs.writeFileSync(
      watchStateFile,
      `${JSON.stringify({
        clientKey,
        ownerToken: nextOwnerToken,
        updatedAt: Date.now(),
      }, null, 2)}\n`,
    );
  } catch {}
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
  return Math.max(74, Math.min(process.stdout.columns || 100, 170));
}

function termHeight() {
  return Math.max(12, process.stdout.rows || 40);
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

function pushEvent(kind, title, body, tone) {
  const timestamp = nowStamp();
  const normalizedBody = tryPrettyJson(body || "(empty)");
  events.push({
    id: nextId("evt"),
    kind,
    title,
    tone,
    timestamp,
    body:
      normalizedBody.length > maxStoredBodyChars
        ? `${normalizedBody.slice(0, maxStoredBodyChars - 1)}…`
        : normalizedBody,
    bodyTruncated: normalizedBody.length > maxStoredBodyChars,
  });
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
  scheduleRender();
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
  return [
    `state: ${payload.state ?? "unknown"}`,
    `uptime: ${formatCompactNumber(payload.uptimeMs) ?? payload.uptimeMs ?? "n/a"} ms`,
    `active sessions: ${payload.activeSessions ?? "n/a"}`,
    `control plane: ${payload.controlPlanePort ?? "n/a"}`,
    `agent: ${payload.agentName ?? "n/a"}`,
    `channels: ${Array.isArray(payload.channels) ? payload.channels.join(", ") : "n/a"}`,
  ].join("\n");
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

function requestRunInspect(reason) {
  if (
    !sessionId ||
    !isOpen ||
    runInspectPending ||
    !shouldAutoInspectRun(runDetail, runState)
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
    if (preferred) {
      return preferred;
    }
  }
  return [...payload].sort((left, right) => {
    const leftTime = Number(left?.lastActiveAt ?? 0);
    const rightTime = Number(right?.lastActiveAt ?? 0);
    return rightTime - leftTime;
  })[0] ?? null;
}

function clearBootstrapTimer() {
  if (!bootstrapTimer) {
    return;
  }
  clearTimeout(bootstrapTimer);
  bootstrapTimer = null;
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
  return !events.some((event) => introDismissKinds.has(event.kind));
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
    centerAnsi(`${color.magenta}${color.bold}A G E N / C${color.reset} ${color.softInk}operator console${color.reset}`, width),
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
  const phaseLabel = runPhase ? `${runState} / ${runPhase}` : runState;
  const objective =
    currentObjective ??
    runDetail?.objective ??
    latestAgentSummary ??
    "Awaiting operator prompt";
  const statusSummary = lastUsageSummary
    ? `usage ${lastUsageSummary}`
    : transientStatus;
  return [
    flexBetween(
      `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.fog}operator console${color.reset}`,
      `${toneColor(stateTone(connectionState))}${connectionState}${color.reset} ${color.fog}${shortSession}${color.reset} ${toneColor(stateTone(phaseLabel))}${truncate(phaseLabel, 16)}${color.reset}`,
      width,
    ),
    `${color.softInk}${truncate(sanitizeInlineText(objective), Math.max(28, width))}${color.reset}`,
    `${color.fog}${truncate(`tool ${latestTool ?? "idle"}  ${statusSummary}`, Math.max(28, width))}${color.reset}`,
    "",
  ];
}

function snapshotPanelLines(width) {
  const inner = width - 2;
  const objective = currentObjective ?? runDetail?.objective ?? "No active objective";
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
      row(formatMetric("state", runState, inner, stateTone(runState)), color.panelBg),
      row(formatMetric("phase", runPhase ?? "idle", inner, stateTone(runPhase ?? runState)), color.panelAltBg),
      ...wrapAndLimit(`objective ${objective}`, inner, 2).map((line, index) => (
        row(`${color.softInk}${line}${color.reset}`, index === 0 ? color.panelBg : color.panelAltBg)
      )),
      row("", color.panelBg),
      row(`${color.fog}${color.bold}SESSION${color.reset}`, color.panelHiBg),
      row(formatMetric("connection", connectionState, inner, stateTone(connectionState)), color.panelBg),
      row(formatMetric("session", sessionId ? sessionId.slice(-8) : "--------", inner, "slate"), color.panelAltBg),
      row(formatMetric("latest tool", latestTool ?? "none", inner, stateTone(latestToolState ?? "idle")), color.panelBg),
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
  const objective = currentObjective ?? runDetail?.objective ?? "No active objective";
  const phaseLabel = runPhase ? `${runState} / ${runPhase}` : runState;
  return renderPanel({
    title: "SNAPSHOT",
    subtitle: lastActivityAt ? `@ ${lastActivityAt}` : "idle",
    tone: "magenta",
    width,
    bg: color.panelBg,
    lines: [
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
          `${chip("TOOL", latestTool ?? "idle", stateTone(latestToolState ?? "idle"))}`,
          `${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "green")}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${color.softInk}${truncate(sanitizeInlineText(objective), Math.max(24, inner - 10))}${color.reset}`,
          `${color.fog}${truncate(lastUsageSummary ?? "n/a", 18)}${color.reset}`,
          inner,
        ),
        color.panelBg,
      ),
    ],
  });
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
      `${color.fog}ctrl+o close detail${color.reset}`,
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
      ? `enter send  / commands${latestExpandable ? "  ctrl+o detail" : ""}`
      : `/ commands${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+l clear`;
  return flexBetween(
    `${color.fog}${truncate(leftHint, Math.max(16, width - 22))}${color.reset}`,
    `${color.fog}${rightHint}${color.reset}`,
    width,
  );
}

function resetLiveRunSurface() {
  latestAgentSummary = null;
  latestTool = null;
  latestToolState = null;
  lastUsageSummary = null;
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
  const maxLines =
    event.kind === "help" ||
    event.kind === "history" ||
    event.kind === "logs" ||
    event.kind === "trace" ||
    event.kind === "status" ||
    event.kind === "session" ||
    event.kind === "runs"
      ? 8
      : event.kind === "operator" ||
          event.kind === "you" ||
          event.kind === "queued"
        ? 3
      : event.kind === "agent"
        ? maxFeedPreviewLines
        : event.kind === "tool result" || event.kind === "tool error"
          ? maxFeedPreviewLines
          : 2;
  const wrapped = eventBodyLines(event.body, maxPreviewSourceLines)
    .flatMap((line) => wrapLine(line, width));
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const preview = wrapped.slice(0, maxLines);
  const lastIndex = preview.length - 1;
  preview[lastIndex] = `${truncate(preview[lastIndex].trimEnd(), Math.max(8, width - 1))}…`;
  return preview;
}

function eventHasHiddenPreview(event, width) {
  const wrapped = eventBodyLines(event.body, maxPreviewSourceLines)
    .flatMap((line) => wrapLine(line, width));
  return event.bodyTruncated || wrapped.length > eventPreviewLines(event, width).length;
}

function latestExpandableEvent() {
  const width = Math.max(24, termWidth() - 4);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (eventHasHiddenPreview(events[index], width)) {
      return events[index];
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
    setTransientStatus("detail closed");
    return;
  }
  const target = latestExpandableEvent();
  if (!target) {
    setTransientStatus("no detail available");
    return;
  }
  expandedEventId = target.id;
  setTransientStatus(`detail open: ${target.title}`);
}

function renderEventBlock(event, width) {
  const rows = [];
  const badgeSpec = eventBadge(event.kind);
  const title = flexBetween(
    `${toneColor(badgeSpec.tone)}${color.bold}${badgeSpec.label.toLowerCase()}${color.reset} ${color.softInk}${truncate(sanitizeDisplayText(event.title), Math.max(20, width - 18))}${color.reset}`,
    `${color.fog}${event.timestamp}${color.reset}`,
    width,
  );
  rows.push(title);

  const bodyLines = eventPreviewLines(event, Math.max(12, width - 2));
  bodyLines.forEach((line) => {
    rows.push(line.length > 0 ? `${color.softInk}  ${line}${color.reset}` : "");
  });
  return rows;
}

function collectEventRows(width, maxRows) {
  if (events.length === 0) {
    return [
      `${color.softInk}No signal packets on the uplink yet.${color.reset}`,
      `${color.fog}Operator prompts, execution returns, and core replies will surface here.${color.reset}`,
    ];
  }

  const blocks = [];
  let usedRows = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const block = renderEventBlock(events[index], width);
    const needed = block.length + (blocks.length > 0 ? 1 : 0);
    if (blocks.length > 0 && usedRows + needed > maxRows) {
      break;
    }
    blocks.unshift(block);
    usedRows += needed;
  }

  const rows = [];
  blocks.forEach((block, index) => {
    if (index > 0) {
      rows.push("");
    }
    rows.push(...block);
  });
  return rows;
}

function activityPanelLines(width, targetHeight) {
  const lines = collectEventRows(width, Math.max(8, targetHeight)).slice(-Math.max(8, targetHeight));
  while (lines.length < targetHeight) {
    lines.push("");
  }
  return lines;
}

function expandedDetailLines(width, targetHeight) {
  const event = currentExpandedEvent();
  if (!event) {
    expandedEventId = null;
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
  const visibleBody = body.slice(0, availableRows);
  const rows = [
    ...header,
    ...visibleBody.map((line) => (line.length > 0 ? `${color.softInk}${line}${color.reset}` : "")),
  ];
  while (rows.length < targetHeight - 1) {
    rows.push("");
  }
  rows.push(
    `${color.fog}${Math.min(body.length, visibleBody.length)} of ${body.length} lines${event.bodyTruncated ? "  stored body truncated" : ""}${color.reset}`,
  );
  return rows.slice(0, targetHeight);
}

function enterAltScreen() {
  if (!process.stdout.isTTY || enteredAltScreen) {
    return;
  }
  process.stdout.write("\x1b[?1049h\x1b[?25h");
  enteredAltScreen = true;
}

function leaveAltScreen() {
  if (!enteredAltScreen) {
    return;
  }
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  enteredAltScreen = false;
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
  const footerRows = 2;
  let frame;
  const slashMode = currentInputValue().trimStart().startsWith("/");

  if (shouldShowSplash() && height >= 18) {
    frame = renderSplash(width, height - footerRows);
  } else {
    const header = headerLines(width);
    const popup = expandedEventId
      ? []
      : slashMode
        ? commandPaletteLines(Math.min(68, Math.max(38, width - 4)), Math.max(4, Math.min(8, height - 12)))
        : [];
    const popupRows = popup.length > 0 ? popup.length + 1 : 0;
    const bodyHeight = Math.max(8, height - header.length - footerRows - popupRows);
    const transcript = expandedEventId
      ? expandedDetailLines(width, bodyHeight)
      : activityPanelLines(width, bodyHeight);
    frame = [
      ...header,
      ...transcript,
      ...(popup.length > 0 ? ["", ...popup.map((line) => `  ${line}`)] : []),
    ];
  }

  process.stdout.write(`${color.panelBg}\x1b[H\x1b[2J`);
  process.stdout.write(frame.map((line) => paintSurface(line, width, color.panelBg)).join("\n"));
  process.stdout.write(`\x1b[${height - 1};1H${paintSurface(footerHintLine(width), width, color.panelBg)}`);
  const composer = composerRenderLine(width);
  process.stdout.write(`\x1b[${height};1H${paintSurface(composer.line, width, color.panelBg)}`);
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

function handleToolResult(toolName, isError, result) {
  latestTool = toolName;
  latestToolState = isError ? "error" : "ok";
  setTransientStatus(
    isError ? `${toolName} failed` : `${toolName} completed`,
  );
  const parsedEntries = parseStructuredJson(result);
  const summary = buildToolSummary(parsedEntries);
  const body =
    summary.length > 0
      ? summary.join("\n")
      : compactBodyLines(tryPrettyJson(result), maxEventBodyLines).join("\n");
  pushEvent(isError ? "tool error" : "tool result", toolName, body, isError ? "red" : "green");
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

    switch (msg.type) {
      case "chat.session":
        sessionId = msg.payload?.sessionId ?? sessionId;
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
        markBootstrapReady(`session resumed: ${sessionId}`);
        requestRunInspect("resume");
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
          markBootstrapReady(`history restored: ${history.length} item(s)`);
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
      case "tools.executing":
        latestTool = msg.payload?.toolName ?? "unknown";
        latestToolState = "running";
        pushEvent(
          "tool",
          `Starting ${latestTool}`,
          `${latestTool} ${truncate(stable(msg.payload?.args ?? {}), 260)}`,
          "yellow",
        );
        requestRunInspect("tool start");
        break;
      case "tools.result":
        handleToolResult(
          msg.payload?.toolName ?? "unknown",
          Boolean(msg.payload?.isError),
          msg.payload?.result ?? "",
        );
        requestRunInspect("tool result");
        break;
      case "chat.usage":
        lastUsageSummary = summarizeUsage(msg.payload);
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
        setTransientStatus(`run inspect loaded: ${runState ?? "unknown"}`);
        break;
      case "run.updated":
        runState = msg.payload?.state ?? runState;
        runPhase = msg.payload?.currentPhase ?? runPhase;
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
        setTransientStatus("gateway status loaded");
        pushEvent("status", "Gateway Status", formatStatusPayload(msg.payload), "blue");
        break;
      case "agent.status":
        runPhase = msg.payload?.phase ?? runPhase;
        setTransientStatus(tryPrettyJson(msg.payload ?? {}));
        requestRunInspect("agent status");
        break;
      case "approval.request":
        pushEvent("approval", "Approval Request", tryPrettyJson(msg.payload ?? {}), "red");
        break;
      case "error":
        runInspectPending = false;
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
      "Ctrl+O toggles the latest verbose event into a full detail view.",
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
      setTransientStatus("console cleared");
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

    if (canonicalName === "/new") {
      resetLiveRunSurface();
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
  runState = "starting";
  runPhase = "queued";
  pushEvent("you", "Prompt", value, "teal");
  send("chat.message", authPayload({ content: value }));
  return true;
}

connect();
scheduleRender();

process.stdin.on("keypress", (_str, key) => {
  if (shuttingDown) {
    return;
  }
  if (key?.ctrl && key.name === "c") {
    shutdownWatch(0);
    return;
  }
  if (
    !introDismissed &&
    !key?.ctrl &&
    !key?.meta &&
    typeof _str === "string" &&
    _str.length > 0 &&
    _str !== "\u007f"
  ) {
    dismissIntro();
  }
  if (key?.ctrl && key.name === "o") {
    toggleExpandedEvent();
    scheduleRender();
    return;
  }
  if (key?.ctrl && key.name === "l") {
    events.length = 0;
    expandedEventId = null;
    setTransientStatus("view cleared");
    scheduleRender();
    return;
  }
  if (expandedEventId && key?.name === "escape") {
    expandedEventId = null;
    setTransientStatus("detail closed");
    scheduleRender();
    return;
  }
  if (key?.name === "return" || key?.name === "enter") {
    submitComposerInput();
    return;
  }
  if (key?.name === "tab") {
    autocompleteSlashCommand();
    scheduleRender();
    return;
  }
  if (key?.name === "backspace") {
    if (composerCursor > 0) {
      composerInput =
        composerInput.slice(0, composerCursor - 1) +
        composerInput.slice(composerCursor);
      composerCursor -= 1;
      composerHistoryIndex = -1;
    }
    scheduleRender();
    return;
  }
  if (key?.name === "delete") {
    if (composerCursor < composerInput.length) {
      composerInput =
        composerInput.slice(0, composerCursor) +
        composerInput.slice(composerCursor + 1);
      composerHistoryIndex = -1;
    }
    scheduleRender();
    return;
  }
  if (key?.name === "left") {
    composerCursor = Math.max(0, composerCursor - 1);
    scheduleRender();
    return;
  }
  if (key?.name === "right") {
    composerCursor = Math.min(composerInput.length, composerCursor + 1);
    scheduleRender();
    return;
  }
  if (key?.name === "home" || (key?.ctrl && key.name === "a")) {
    composerCursor = 0;
    scheduleRender();
    return;
  }
  if (key?.name === "end" || (key?.ctrl && key.name === "e")) {
    composerCursor = composerInput.length;
    scheduleRender();
    return;
  }
  if (key?.name === "up") {
    navigateComposerHistory(-1);
    scheduleRender();
    return;
  }
  if (key?.name === "down") {
    navigateComposerHistory(1);
    scheduleRender();
    return;
  }
  if (
    typeof _str === "string" &&
    _str.length > 0 &&
    !key?.ctrl &&
    !key?.meta
  ) {
    insertComposerText(_str);
    composerHistoryIndex = -1;
    scheduleRender();
    return;
  }
  scheduleRender();
});

process.stdout.on("resize", () => {
  scheduleRender();
});
