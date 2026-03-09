import readline from "node:readline";
import WebSocket from "file:///home/tetsuo/git/AgenC/node_modules/ws/wrapper.mjs";

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
  border: "\x1b[38;5;238m",
  ink: "\x1b[38;5;255m",
  slate: "\x1b[38;5;246m",
  cyan: "\x1b[38;5;81m",
  teal: "\x1b[38;5;44m",
  blue: "\x1b[38;5;75m",
  green: "\x1b[38;5;42m",
  lime: "\x1b[38;5;119m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;214m",
  magenta: "\x1b[38;5;213m",
  red: "\x1b[38;5;203m",
};

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
let shuttingDown = false;
let ws = null;
let enteredAltScreen = false;
let renderPending = false;
let transientStatus = "Booting watch client…";

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

function tryPrettyJson(value) {
  if (typeof value !== "string") {
    return stable(value);
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
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

function toneColor(tone) {
  return color[tone] ?? color.ink;
}

function badge(label, tone = "ink") {
  return `${toneColor(tone)}${color.bold}[${label}]${color.reset}`;
}

function termWidth() {
  return Math.max(74, Math.min(process.stdout.columns || 100, 170));
}

function termHeight() {
  return Math.max(24, process.stdout.rows || 40);
}

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padAnsi(text, width) {
  const needed = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(needed)}`;
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

function pushEvent(kind, title, body, tone) {
  events.push({
    kind,
    title,
    tone,
    timestamp: nowStamp(),
    body: truncate(body || "(empty)", maxBodyChars),
  });
  while (events.length > maxEvents) {
    events.shift();
  }
  scheduleRender();
}

function setTransientStatus(value) {
  transientStatus = truncate(value, 160);
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
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const lines = [];
  const add = (key, value) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    lines.push(`${key}: ${String(value)}`);
  };
  add("state", parsed.state);
  add("ready", parsed.ready);
  add("label", parsed.label);
  add("serverId", parsed.serverId);
  add("processId", parsed.processId);
  add("sessionId", parsed.sessionId);
  add("port", parsed.port);
  add("url", parsed.healthUrl ?? parsed.currentUrl ?? parsed.url);
  add("title", parsed.title);
  add("pid", parsed.pid);
  add("exitCode", parsed.exitCode);
  if (typeof parsed.recentOutput === "string" && parsed.recentOutput.trim()) {
    lines.push(`recentOutput: ${truncate(parsed.recentOutput.trim(), 280)}`);
  }
  return lines;
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

function headerLines(width) {
  const inner = width - 2;
  const shortSession = sessionId ? sessionId.slice(-8) : "--------";
  const runLabel = `${runState ?? "idle"}${runPhase ? ` / ${runPhase}` : ""}`;
  const linkTone = connectionState === "live" ? "green" : "amber";
  const toolTone =
    latestToolState === "error"
      ? "red"
      : latestToolState === "ok"
        ? "green"
        : latestToolState === "running"
          ? "yellow"
          : "slate";

  const lines = [];
  const top = `${color.border}╔${"═".repeat(inner)}╗${color.reset}`;
  const bottom = `${color.border}╚${"═".repeat(inner)}╝${color.reset}`;
  lines.push(top);
  lines.push(
    `${color.border}║${color.reset}${padAnsi(`${color.cyan}${color.bold}AGEN C // AUTONOMY CONSOLE${color.reset}`, inner)}${color.border}║${color.reset}`,
  );
  lines.push(
    `${color.border}║${color.reset}${padAnsi(`${badge("SESSION", "teal")} ${shortSession}  ${badge("RUN", "magenta")} ${runLabel}  ${badge("LINK", linkTone)} ${connectionState}`, inner)}${color.border}║${color.reset}`,
  );
  lines.push(
    `${color.border}║${color.reset}${padAnsi(`${badge("TOOL", toolTone)} ${latestTool ?? "none"}  ${badge("LAST", "slate")} ${truncate(latestAgentSummary ?? "waiting for agent output", maxSummaryChars)}`, inner)}${color.border}║${color.reset}`,
  );
  lines.push(
    `${color.border}║${color.reset}${padAnsi(`${badge("INFO", "blue")} ${transientStatus}`, inner)}${color.border}║${color.reset}`,
  );
  lines.push(
    `${color.border}║${color.reset}${padAnsi(`${badge("CMDS", "yellow")} /new /runs /inspect /trace /status /pause /resume /stop /cancel /clear /help /quit`, inner)}${color.border}║${color.reset}`,
  );
  lines.push(bottom);
  return lines;
}

function runCardLines(width) {
  const inner = width - 2;
  const top = `${color.border}╔${"═".repeat(inner)}╗${color.reset}`;
  const bottom = `${color.border}╚${"═".repeat(inner)}╝${color.reset}`;
  const lines = [
    top,
    `${color.border}║${color.reset}${padAnsi(`${color.magenta}${color.bold}CURRENT RUN${color.reset}`, inner)}${color.border}║${color.reset}`,
  ];
  const detailLines = summarizeRunDetail(runDetail) ?? [
    `objective: ${currentObjective ?? "waiting for a durable run"}`,
    `state: ${runState}`,
    `phase: ${runPhase ?? "idle"}`,
    `explanation: no run inspection loaded yet`,
  ];
  for (const rawLine of detailLines) {
    for (const wrapped of wrapLine(rawLine, inner)) {
      lines.push(
        `${color.border}║${color.reset}${padAnsi(wrapped, inner)}${color.border}║${color.reset}`,
      );
    }
  }
  lines.push(bottom);
  return lines;
}

function formatEventLines(width) {
  const inner = Math.max(24, width - 6);
  const blocks = [];
  for (const event of events) {
    const tone = toneColor(event.tone);
    const title = `${badge(event.kind.toUpperCase(), event.tone)} ${tone}${color.bold}${event.title}${color.reset} ${color.slate}${event.timestamp}${color.reset}`;
    blocks.push(...wrapLine(title, width));
    const bodyLines = wrapBlock(event.body, inner);
    for (const line of bodyLines) {
      blocks.push(`  ${line}`);
    }
    blocks.push(`${color.border}${"─".repeat(Math.max(16, width - 2))}${color.reset}`);
  }
  return blocks;
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
  return `${color.lime}${color.bold}agenc${color.reset}${color.slate}:${shortSession}${runLabel ? ` ${runLabel}` : ""}${color.reset}> `;
}

function render() {
  renderPending = false;
  enterAltScreen();
  const width = termWidth();
  const height = termHeight();
  const header = headerLines(width);
  const runCard = runCardLines(width);
  const footerRows = 2;
  const availableEventRows = Math.max(6, height - header.length - runCard.length - footerRows);
  const allEventLines = formatEventLines(width);
  const eventLines = allEventLines.slice(-availableEventRows);
  const blankRows = Math.max(0, availableEventRows - eventLines.length);
  const frame = [
    ...header,
    ...runCard,
    ...eventLines,
    ...Array.from({ length: blankRows }, () => ""),
  ];

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
  const parsed = tryParseJson(result);
  const summary = buildToolSummary(parsed);
  const formatted = tryPrettyJson(result);
  const body =
    summary.length > 0
      ? `${summary.join("\n")}\n\n${truncate(formatted, maxBodyChars)}`
      : truncate(formatted, maxBodyChars);
  pushEvent(isError ? "tool error" : "tool result", toolName, body, isError ? "red" : "green");
}

function attachSocket(socket) {
  socket.addEventListener("open", () => {
    ws = socket;
    isOpen = true;
    reconnectAttempts = 0;
    connectionState = "live";
    setTransientStatus(`connected to ${wsUrl}`);
    while (pendingFrames.length > 0) {
      socket.send(pendingFrames.shift());
    }
    send("chat.new", { clientKey });
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
        setTransientStatus(`session ready: ${sessionId}`);
        break;
      case "chat.resumed":
        sessionId = msg.payload?.sessionId ?? sessionId;
        setTransientStatus(`session resumed: ${sessionId}`);
        requestRunInspect("resume");
        break;
      case "chat.history": {
        const history = Array.isArray(msg.payload) ? msg.payload : [];
        setTransientStatus(`history restored: ${history.length} item(s)`);
        break;
      }
      case "chat.message":
        latestAgentSummary = msg.payload?.content ?? null;
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
      case "runs.list":
        pushEvent("runs", "Run List", tryPrettyJson(msg.payload ?? []), "blue");
        break;
      case "run.inspect":
        runInspectPending = false;
        runDetail = msg.payload ?? null;
        currentObjective = msg.payload?.objective ?? currentObjective;
        runState = msg.payload?.state ?? runState;
        runPhase = msg.payload?.currentPhase ?? runPhase;
        pushEvent("inspect", "Run Inspect", tryPrettyJson(msg.payload ?? {}), "blue");
        break;
      case "run.updated":
        runState = msg.payload?.state ?? runState;
        runPhase = msg.payload?.currentPhase ?? runPhase;
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
        pushEvent("trace", "Trace List", tryPrettyJson(msg.payload ?? []), "slate");
        break;
      case "observability.trace":
        pushEvent(
          "trace",
          "Trace Detail",
          tryPrettyJson(msg.payload?.summary ?? msg.payload ?? {}),
          "slate",
        );
        break;
      case "status.update":
        lastStatus = msg.payload ?? lastStatus;
        pushEvent("status", "Gateway Status", tryPrettyJson(msg.payload ?? {}), "blue");
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
    connectionState = "reconnecting";
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

connect();
scheduleRender();

rl.on("line", (input) => {
  const value = input.trim();
  if (!value) {
    scheduleRender();
    return;
  }

  if (value === "/quit" || value === "/exit") {
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    rl.close();
    ws?.close();
    leaveAltScreen();
    return;
  }

  if (value === "/help") {
    printHelp();
    return;
  }

  if (value === "/clear") {
    events.length = 0;
    setTransientStatus("console cleared");
    return;
  }

  if (value === "/new") {
    currentObjective = null;
    runDetail = null;
    runState = "idle";
    runPhase = null;
    pushEvent("operator", "New Session", "Requested a fresh chat session.", "teal");
    send("chat.new", { clientKey });
    return;
  }

  if (value === "/runs") {
    pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
    send("runs.list", sessionId ? { sessionId } : {});
    return;
  }

  if (value === "/inspect") {
    if (!requireSession("/inspect")) return;
    runInspectPending = true;
    pushEvent("operator", "Run Inspect", `Inspecting run for ${sessionId}.`, "teal");
    send("run.inspect", { sessionId });
    return;
  }

  if (value === "/trace") {
    pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
    send("observability.traces", sessionId ? { sessionId, limit: 5 } : { limit: 5 });
    return;
  }

  if (value === "/status") {
    pushEvent("operator", "Gateway Status", "Requested daemon status.", "teal");
    send("status.get", {});
    return;
  }

  if (value === "/cancel") {
    pushEvent("operator", "Cancel Chat", `Cancelling chat for ${clientKey}.`, "teal");
    send("chat.cancel", { clientKey });
    return;
  }

  if (value === "/pause") {
    if (!requireSession("/pause")) return;
    runInspectPending = true;
    pushEvent("operator", "Pause Run", `Pausing run for ${sessionId}.`, "teal");
    send("run.control", { action: "pause", sessionId, reason: "operator pause" });
    return;
  }

  if (value === "/resume") {
    if (!requireSession("/resume")) return;
    runInspectPending = true;
    pushEvent("operator", "Resume Run", `Resuming run for ${sessionId}.`, "teal");
    send("run.control", { action: "resume", sessionId, reason: "operator resume" });
    return;
  }

  if (value === "/stop") {
    if (!requireSession("/stop")) return;
    runInspectPending = true;
    pushEvent("operator", "Stop Run", `Stopping run for ${sessionId}.`, "teal");
    send("run.control", { action: "stop", sessionId, reason: "operator stop" });
    return;
  }

  currentObjective = value;
  runState = "starting";
  runPhase = "queued";
  pushEvent("you", "Prompt", value, "teal");
  send("chat.message", { content: value, clientKey });
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
  try {
    ws?.close();
  } catch {}
  leaveAltScreen();
  process.exit(0);
});

process.stdout.on("resize", () => {
  scheduleRender();
});
