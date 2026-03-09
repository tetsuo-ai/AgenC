import readline from "node:readline";
import WebSocket from "../node_modules/ws/wrapper.mjs";

const wsUrl = process.env.AGENC_WATCH_WS_URL ?? "ws://127.0.0.1:3100";
const clientKey = process.env.AGENC_WATCH_CLIENT_KEY ?? "tmux-live-watch";
const reconnectMinDelayMs = 1_000;
const reconnectMaxDelayMs = 5_000;
const maxEvents = 80;
const maxInlineChars = 220;
const maxBodyChars = 900;
const maxSummaryChars = 120;

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  border: "\x1b[38;5;54m",
  borderStrong: "\x1b[38;5;45m",
  ink: "\x1b[38;5;225m",
  softInk: "\x1b[38;5;189m",
  slate: "\x1b[38;5;141m",
  fog: "\x1b[38;5;97m",
  cyan: "\x1b[38;5;51m",
  teal: "\x1b[38;5;45m",
  blue: "\x1b[38;5;39m",
  green: "\x1b[38;5;50m",
  lime: "\x1b[38;5;87m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;213m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  heroBg: "\x1b[49m",
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
let transientStatus = "Booting watch client…";
let lastStatus = null;
let lastUsageSummary = null;
let lastActivityAt = null;
const queuedOperatorInputs = [];

const pendingFrames = [];
const events = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

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

function meterBar(level, width = 10, tone = "green") {
  const clamped = Math.max(0, Math.min(1, Number(level) || 0));
  const fill = Math.max(0, Math.min(width, Math.round(clamped * width)));
  return `${toneColor(tone)}${"█".repeat(fill)}${color.border}${"·".repeat(Math.max(0, width - fill))}${color.reset}`;
}

function meter(label, level, tone = "green", width = 10) {
  return `${badge(label, tone)} ${meterBar(level, width, tone)}`;
}

function connectionLevel() {
  if (connectionState === "live") return 1;
  if (connectionState === "reconnecting") return 0.55;
  if (connectionState === "connecting") return 0.35;
  return 0.15;
}

function cognitionLevel() {
  const phase = String(runPhase ?? runState ?? "").toLowerCase();
  if (phase.includes("tool")) return 0.9;
  if (phase.includes("thinking")) return 0.76;
  if (phase.includes("typing") || phase.includes("stream")) return 0.68;
  if (phase.includes("idle")) return 0.32;
  return 0.5;
}

function queueLevel() {
  return Math.min(1, queuedOperatorInputs.length / 4);
}

function activityLevel() {
  return Math.min(1, events.length / 12);
}

function bannerMood() {
  if (!bootstrapReady) return "carrier acquisition in progress";
  if (latestToolState === "error") return "fault recovery path engaged";
  if (latestToolState === "running") return "execution bus hot";
  if ((runPhase ?? "").toLowerCase().includes("thinking")) return "cognitive loop engaged";
  if (connectionState === "live") return "neural uplink nominal";
  return "standby for operator signal";
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
  events.push({
    kind,
    title,
    tone,
    timestamp,
    body: truncate(tryPrettyJson(body || "(empty)"), maxBodyChars),
  });
  lastActivityAt = timestamp;
  while (events.length > maxEvents) {
    events.shift();
  }
  scheduleRender();
}

function setTransientStatus(value) {
  transientStatus = truncate(sanitizeInlineText(value || "idle"), 160);
  scheduleRender();
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
  if (!sessionId || !isOpen || runInspectPending) {
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
  send("chat.sessions", { clientKey });
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

function heroLines(width) {
  const inner = width - 2;
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const runLabel = `${runState ?? "idle"}${runPhase ? ` / ${runPhase}` : ""}`;
  const objective = currentObjective ?? runDetail?.objective ?? "No active run";
  const heroTone = connectionState === "live" ? "cyan" : "amber";
  const toolSummary = latestTool ?? "waiting";
  const toolTone =
    latestToolState === "error"
      ? "red"
      : latestToolState === "ok"
        ? "green"
        : latestToolState === "running"
          ? "magenta"
          : "slate";

  return renderPanel({
    title: "A G E N / C",
    subtitle: connectionState === "live" ? `carrier ${lastActivityAt ?? "--:--:--"}` : "carrier scan",
    tone: heroTone,
    width,
    bg: color.heroBg,
    lines: [
      row(
        flexBetween(
          `${color.cyan}${color.bold}COGNITIVE UPLINK // AUTONOMOUS TERMINAL${color.reset}`,
          `${color.magenta}${color.bold}SYSOP LINK :: ${connectionState.toUpperCase()}${color.reset}`,
          inner,
        ),
        color.heroBg,
      ),
      row(
        `${color.fog}${truncate("0101 1100 0011 1010 1110 0111 0001 1010 0100 1110", Math.max(22, inner - 28))}${color.reset} ${color.borderStrong}//${color.reset} ${color.softInk}${bannerMood()}${color.reset}`,
        color.heroBg,
      ),
      row(
        flexBetween(
          `${chip("NODE", shortSession, "slate")} ${chip("UPLINK", connectionState, stateTone(connectionState))} ${chip("CORE", runLabel, stateTone(runLabel))}`,
          `${chip("LOG", events.length, "blue")} ${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "green")}`,
          inner,
        ),
        color.heroBg,
      ),
      row(
        `${badge("FOCUS", currentObjective || runDetail?.objective ? "magenta" : "slate")} ${color.softInk}${truncate(sanitizeInlineText(objective), Math.max(24, inner - 12))}${color.reset}`,
        color.heroBg,
      ),
      row(
        flexBetween(
          `${badge("STATUS", stateTone(transientStatus))} ${color.softInk}${truncate(transientStatus, Math.max(18, inner - 38))}${color.reset}`,
          lastUsageSummary
            ? `${badge("TOKENS", "teal")} ${color.teal}${truncate(lastUsageSummary, 32)}${color.reset}`
            : `${chip("MODE", bootstrapReady ? "synced" : "restoring", bootstrapReady ? "green" : "amber")}`,
          inner,
        ),
        color.heroBg,
      ),
      row(
        flexBetween(
          `${meter("LINK", connectionLevel(), stateTone(connectionState), 10)} ${meter("CORE", cognitionLevel(), stateTone(runPhase ?? runState), 10)}`,
          `${meter("QUEUE", queueLevel(), queuedOperatorInputs.length > 0 ? "amber" : "green", 8)} ${meter("LOG", activityLevel(), "blue", 8)}`,
          inner,
        ),
        color.heroBg,
      ),
      row(
        `${color.fog}SYSOP${color.reset} ${color.softInk}/help  /clear  enter${color.reset}  ${color.fog}SURFACE${color.reset} ${color.softInk}signal feed + trace bus${color.reset}`,
        color.heroBg,
      ),
    ],
  });
}

function compactHeroLines(width) {
  const inner = width - 2;
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const runLabel = `${runState ?? "idle"}${runPhase ? ` / ${runPhase}` : ""}`;
  return renderPanel({
    title: "A G E N / C",
    subtitle: connectionState === "live" ? `carrier ${lastActivityAt ?? "--:--:--"}` : "carrier scan",
    tone: connectionState === "live" ? "cyan" : "amber",
    width,
    bg: color.heroBg,
    lines: [
      row(
        flexBetween(
          `${color.cyan}${color.bold}COGNITIVE UPLINK${color.reset} ${chip("NODE", shortSession, "slate")} ${chip("CORE", runLabel, stateTone(runLabel))}`,
          `${chip("LOG", events.length, "blue")}`,
          inner,
        ),
        color.heroBg,
      ),
      row(
        flexBetween(
          `${badge("STATUS", stateTone(transientStatus))} ${color.softInk}${truncate(transientStatus, Math.max(18, inner - 18))}${color.reset}`,
          `${meter("LINK", connectionLevel(), stateTone(connectionState), 8)}`,
          inner,
        ),
        color.heroBg,
      ),
    ],
  });
}

function runPanelLines(width) {
  const inner = width - 2;
  const objective = currentObjective ?? runDetail?.objective ?? "No active run";
  const explanation = runDetail?.explanation ?? "No durable run inspection loaded yet.";
  const evidence =
    runDetail?.lastToolEvidence ??
    runDetail?.carryForwardSummary ??
    runDetail?.lastUserUpdate ??
    "No verified evidence yet.";
  const nextCheck = runDetail?.nextCheckAt
    ? new Date(runDetail.nextCheckAt).toLocaleTimeString("en-US", { hour12: false })
    : "pending";
  const subtitle = runDetail ? truncate(sanitizeInlineText(runDetail.state ?? runState), 20) : "idle";
  const lines = [
    row(
      flexBetween(
        `${chip("STATE", runState, stateTone(runState))}`,
        `${chip("PHASE", runPhase ?? "idle", stateTone(runPhase ?? runState))}`,
        inner,
      ),
      color.panelHiBg,
    ),
    row(formatMetric("next check", nextCheck, inner, nextCheck === "pending" ? "amber" : "green"), color.panelAltBg),
    ...wrapAndLimit(`objective: ${objective}`, inner, 2).map((line, index) => (
      row(`${color.softInk}${line}${color.reset}`, index === 0 ? color.panelBg : color.panelAltBg)
    )),
    ...wrapAndLimit(`evidence: ${evidence}`, inner, 1).map((line, index) => (
      row(`${color.fog}${line}${color.reset}`, index === 0 ? color.panelBg : color.panelAltBg)
    )),
    ...wrapAndLimit(`note: ${explanation}`, inner, 1).map((line, index) => (
      row(`${color.fog}${line}${color.reset}`, index === 0 ? color.panelAltBg : color.panelBg)
    )),
  ];
  return renderPanel({
    title: "NET // STATE",
    subtitle,
    tone: stateTone(runState),
    width,
    bg: color.panelBg,
    lines,
  });
}

function signalPanelLines(width) {
  const inner = width - 2;
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const queued = queuedOperatorInputs.length;
  const summary = latestAgentSummary
    ? truncate(sanitizeInlineText(latestAgentSummary), maxSummaryChars)
    : "waiting for agent output";
  const lines = [
    row(
      flexBetween(
        `${chip("SESSION", shortSession, "slate")}`,
        `${chip("QUEUE", queued, queued > 0 ? "amber" : "green")}`,
        inner,
      ),
      color.panelHiBg,
    ),
    row(formatMetric("connection", connectionState, inner, stateTone(connectionState)), color.panelAltBg),
    row(formatMetric("latest tool", latestTool ?? "none", inner, stateTone(latestToolState ?? "idle")), color.panelBg),
    row(formatMetric("usage", lastUsageSummary ?? "n/a", inner, lastUsageSummary ? "teal" : "slate"), color.panelAltBg),
    row(`${color.softInk}${truncate(summary, inner)}${color.reset}`, color.panelBg),
  ];
  return renderPanel({
    title: "SYS // LINK",
    subtitle: lastActivityAt ? `carrier ${lastActivityAt}` : "carrier locked",
    tone: connectionState === "live" ? "teal" : "amber",
    width,
    bg: color.panelAltBg,
    lines,
  });
}

function compactSummaryLines(width) {
  const inner = width - 2;
  const objective = currentObjective ?? runDetail?.objective ?? "No active run";
  const toolSummary = latestTool ?? "none";
  const toolTone =
    latestToolState === "error"
      ? "red"
      : latestToolState === "ok"
        ? "green"
        : latestToolState === "running"
          ? "magenta"
          : "slate";
  const rightSummary = lastUsageSummary
    ? `usage ${lastUsageSummary}`
    : `queue ${queuedOperatorInputs.length}`;
  return renderPanel({
    title: "NODE // SNAPSHOT",
    subtitle: runDetail ? truncate(sanitizeInlineText(runDetail.state ?? runState), 18) : "idle",
    tone: stateTone(runState),
    width,
    bg: color.panelBg,
    lines: [
      row(
        flexBetween(
          `${color.softInk}${truncate(`objective ${sanitizeInlineText(objective)}`, 56)}${color.reset}`,
          `${chip("TOOL", toolSummary, toolTone)}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${color.fog}phase${color.reset} ${color.softInk}${runPhase ?? "idle"}${color.reset}  ${color.fog}next${color.reset} ${color.softInk}${runDetail?.nextCheckAt ? new Date(runDetail.nextCheckAt).toLocaleTimeString("en-US", { hour12: false }) : "pending"}${color.reset}`,
          `${color.fog}${truncate(rightSummary, 28)}${color.reset}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ],
  });
}

function styleEventBodyLine(line) {
  const match = line.match(/^([A-Za-z0-9 _./-]{2,26}):(.*)$/);
  if (!match) {
    return `${color.softInk}${line}${color.reset}`;
  }
  return `${color.fog}${match[1]}:${color.reset}${color.softInk}${match[2]}${color.reset}`;
}

function eventBadgeLabel(kind) {
  switch (kind) {
    case "tool result":
      return "RETURN";
    case "tool error":
      return "FAULT";
    case "tool":
      return "EXEC";
    case "agent":
      return "CORE";
    case "you":
      return "SYSOP";
    case "operator":
      return "CTRL";
    case "run":
    case "inspect":
      return "STATE";
    case "trace":
      return "TRACE";
    case "approval":
      return "AUTH";
    default:
      return kind.toUpperCase().slice(0, 10);
  }
}

function eventPreviewLines(event, width) {
  const maxLines =
    event.kind === "agent"
      ? 3
      : event.kind === "tool result" || event.kind === "tool error"
        ? 3
        : 2;
  const preview = compactBodyLines(event.body, 8)
    .flatMap((line) => wrapLine(line, width))
    .slice(0, maxLines);
  return preview;
}

function renderEventBlock(event, width) {
  const rows = [];
  const title = flexBetween(
    `${badge(eventBadgeLabel(event.kind), event.tone)} ${toneColor(event.tone)}${color.bold}${truncate(sanitizeDisplayText(event.title), 34)}${color.reset}`,
    `${color.fog}@${event.timestamp}${color.reset}`,
    width,
  );
  rows.push(row(title, color.panelHiBg));

  const bodyLines = eventPreviewLines(event, Math.max(12, width - 2));
  bodyLines.forEach((line, index) => {
    rows.push(row(`${color.softInk}${index === 0 ? ":: " : "   "}${styleEventBodyLine(line)}${color.reset}`, color.panelBg));
  });
  const hiddenCount = Math.max(0, compactBodyLines(event.body, 8).length - bodyLines.length);
  if (hiddenCount > 0) {
    rows.push(
      row(
        `${color.fog}+${hiddenCount} more line(s)${color.reset}`,
        color.panelBg,
      ),
    );
  }
  return rows;
}

function collectEventRows(width, maxRows) {
  if (events.length === 0) {
    return [
      row(`${color.softInk}No signal packets on the uplink yet.${color.reset}`, color.panelBg),
      row(`${color.fog}Operator prompts, execution returns, and core replies will surface here.${color.reset}`, color.panelAltBg),
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
      rows.push(row("", color.panelBg));
    }
    rows.push(...block);
  });
  return rows;
}

function activityPanelLines(width, targetHeight) {
  const chromeRows = 3;
  const contentRows = Math.max(8, targetHeight - chromeRows);
  const lines = collectEventRows(width - 2, contentRows).slice(-contentRows);
  while (lines.length < contentRows) {
    lines.push(row("", color.panelBg));
  }
  return renderPanel({
    title: "SIGNAL FEED",
    subtitle: events.length > 0 ? `${events.length} records` : "quiet",
    tone: "blue",
    width,
    bg: color.panelBg,
    lines,
  });
}

function enterAltScreen() {
  if (!process.stdout.isTTY || enteredAltScreen) {
    return;
  }
  process.stdout.write("\x1b[?1049h\x1b[?25l");
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
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const runLabel = runPhase ? `${runState}/${runPhase}` : runState;
  return `${color.amber}${color.bold}SYSOP${color.reset}${color.borderStrong}::${color.reset} ${color.slate}${shortSession}${color.reset} ${toneColor(stateTone(runLabel))}${runLabel}${color.reset} >> `;
}

function render() {
  renderPending = false;
  enterAltScreen();
  const width = termWidth();
  const height = termHeight();
  const footerRows = 2;
  const compactHeightMode = height <= 22;
  const hero = compactHeightMode ? compactHeroLines(width) : heroLines(width);
  const bodyHeight = Math.max(8, height - hero.length - footerRows);
  let frame;

  if (compactHeightMode) {
    const summary = compactSummaryLines(width);
    const activityPanel = activityPanelLines(width, Math.max(6, bodyHeight - summary.length));
    frame = [
      ...hero,
      ...summary,
      ...activityPanel,
    ];
  } else if (width >= 92) {
    const gap = 2;
    const leftWidth = Math.floor((width - gap) / 2);
    const rightWidth = width - leftWidth - gap;
    const runPanel = runPanelLines(leftWidth);
    const sessionPanel = signalPanelLines(rightWidth);
    const summaryRows = joinColumns(runPanel, sessionPanel, leftWidth, rightWidth, gap);
    const activityPanel = activityPanelLines(width, Math.max(8, bodyHeight - summaryRows.length - 1));
    frame = [
      ...hero,
      ...summaryRows,
      "",
      ...activityPanel,
    ];
  } else {
    const runPanel = runPanelLines(width);
    const sessionPanel = signalPanelLines(width);
    const activityPanel = activityPanelLines(width, Math.max(8, bodyHeight - runPanel.length - sessionPanel.length));
    frame = [
      ...hero,
      ...runPanel,
      ...sessionPanel,
      ...activityPanel,
    ];
  }

  process.stdout.write("\x1b[H\x1b[2J");
  process.stdout.write(frame.join("\n"));
  process.stdout.write(`\x1b[${height - 1};1H${color.border}${"─".repeat(Math.max(10, width))}${color.reset}`);
  process.stdout.write(`\x1b[${height};1H`);
  rl.setPrompt(promptLabel());
  rl.prompt();
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
        runDetail = null;
        runState = "idle";
        runPhase = null;
        markBootstrapReady(`session ready: ${sessionId}`);
        break;
      case "chat.resumed":
        sessionId = msg.payload?.sessionId ?? sessionId;
        markBootstrapReady(`session resumed: ${sessionId}`);
        requestRunInspect("resume");
        break;
      case "chat.sessions": {
        const target = latestSessionSummary(msg.payload, sessionId);
        if (target?.sessionId) {
          sessionId = target.sessionId;
          setTransientStatus(`resuming session ${sessionId}`);
          send("chat.resume", { sessionId: target.sessionId, clientKey });
        } else {
          setTransientStatus("no existing session; creating a new one");
          send("chat.new", { clientKey });
        }
        break;
      }
      case "chat.history": {
        const history = Array.isArray(msg.payload) ? msg.payload : [];
        if (!bootstrapReady && sessionId) {
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
        if (currentObjective) {
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
      case "status.update":
        lastStatus = msg.payload ?? lastStatus;
        setTransientStatus("gateway status loaded");
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
        if (isExpectedMissingRunInspect(msg.error)) {
          runDetail = null;
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
    pushEvent("ws-error", "WebSocket Error", error?.message ?? String(error), "red");
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
      "Type a prompt and press Enter.",
      "Session: /new /runs /inspect /trace /status",
      "Run controls: /pause /resume /stop /cancel",
      "Console: /clear /help /quit",
    ].join("\n"),
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
  const maybeQueue = (reason) => {
    if (replayed) {
      pushEvent("error", "Queued Input Failed", `${value}\n\n${reason}`, "red");
      return true;
    }
    queueOperatorInput(value, reason);
    return true;
  };

  if (value === "/quit" || value === "/exit") {
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearBootstrapTimer();
    rl.close();
    ws?.close();
    leaveAltScreen();
    return true;
  }

  if (value === "/help") {
    printHelp();
    return true;
  }

  if (value === "/clear") {
    events.length = 0;
    setTransientStatus("console cleared");
    return true;
  }

  if (value === "/new") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    currentObjective = null;
    runDetail = null;
    runState = "idle";
    runPhase = null;
    bootstrapAttempts = 0;
    clearBootstrapTimer();
    pushEvent("operator", "New Session", "Requested a fresh chat session.", "teal");
    send("chat.new", { clientKey });
    return true;
  }

  if (value === "/runs") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
    send("runs.list", sessionId ? { sessionId } : {});
    return true;
  }

  if (value === "/inspect") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    if (!requireSession("/inspect")) return;
    runInspectPending = true;
    pushEvent("operator", "Run Inspect", `Inspecting run for ${sessionId}.`, "teal");
    send("run.inspect", { sessionId });
    return true;
  }

  if (value === "/trace") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
    send("observability.traces", sessionId ? { sessionId, limit: 5 } : { limit: 5 });
    return true;
  }

  if (value === "/status") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    pushEvent("operator", "Gateway Status", "Requested daemon status.", "teal");
    send("status.get", {});
    return true;
  }

  if (value === "/cancel") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    pushEvent("operator", "Cancel Chat", `Cancelling chat for ${clientKey}.`, "teal");
    send("chat.cancel", { clientKey });
    return true;
  }

  if (value === "/pause") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    if (!requireSession("/pause")) return;
    runInspectPending = true;
    pushEvent("operator", "Pause Run", `Pausing run for ${sessionId}.`, "teal");
    send("run.control", { action: "pause", sessionId, reason: "operator pause" });
    return true;
  }

  if (value === "/resume") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    if (!requireSession("/resume")) return;
    runInspectPending = true;
    pushEvent("operator", "Resume Run", `Resuming run for ${sessionId}.`, "teal");
    send("run.control", { action: "resume", sessionId, reason: "operator resume" });
    return true;
  }

  if (value === "/stop") {
    if (shouldQueueOperatorInput(value)) {
      return maybeQueue("session bootstrap not complete");
    }
    if (!requireSession("/stop")) return;
    runInspectPending = true;
    pushEvent("operator", "Stop Run", `Stopping run for ${sessionId}.`, "teal");
    send("run.control", { action: "stop", sessionId, reason: "operator stop" });
    return true;
  }

  if (shouldQueueOperatorInput(value)) {
    return maybeQueue("session bootstrap not complete");
  }
  currentObjective = value;
  runState = "starting";
  runPhase = "queued";
  pushEvent("you", "Prompt", value, "teal");
  send("chat.message", { content: value, clientKey });
  return true;
}

connect();
scheduleRender();

rl.on("line", (input) => {
  const value = input.trim();
  if (!value) {
    scheduleRender();
    return;
  }
  dispatchOperatorInput(value);
});

rl.on("SIGINT", () => {
  shuttingDown = true;
  leaveAltScreen();
  process.exit(0);
});

rl.on("close", () => {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearBootstrapTimer();
  try {
    ws?.close();
  } catch {}
  leaveAltScreen();
  process.exit(0);
});

process.stdout.on("resize", () => {
  scheduleRender();
});
