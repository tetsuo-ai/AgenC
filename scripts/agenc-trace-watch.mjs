import readline from "node:readline";

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  slate: "\x1b[38;5;141m",
  fog: "\x1b[38;5;97m",
  blue: "\x1b[38;5;39m",
  cyan: "\x1b[38;5;51m",
  teal: "\x1b[38;5;45m",
  green: "\x1b[38;5;50m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;213m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  border: "\x1b[38;5;54m",
  borderStrong: "\x1b[38;5;45m",
};

function toneForLabel(label) {
  if (label.includes("error") || label.includes("failed")) return color.red;
  if (label.includes("working_applied") || label.includes("completed")) return color.green;
  if (label.includes("decision_resolved") || label.includes("planner")) return color.magenta;
  if (label.includes("tool")) return color.yellow;
  if (label.includes("provider")) return color.blue;
  if (label.includes("webchat")) return color.teal;
  return color.cyan;
}

function short(value, max = 48) {
  if (typeof value !== "string") return String(value);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function badge(label, tone) {
  return `${tone}${color.bold}${label}${color.reset}${color.borderStrong}::${color.reset}`;
}

function frameWidth() {
  return Math.max(52, Math.min(process.stdout.columns || 72, 120));
}

function divider(width = frameWidth()) {
  return `${color.border}${"─".repeat(width)}${color.reset}`;
}

function frameLine(left, right = "", leftTone = color.cyan, rightTone = color.magenta) {
  const width = frameWidth();
  const inner = width - 2;
  const safeLeft = short(left, Math.max(12, inner - right.length - 1));
  const spaces = " ".repeat(Math.max(1, inner - safeLeft.length - right.length));
  return `${color.border}│${color.reset}${leftTone}${color.bold}${safeLeft}${color.reset}${spaces}${right ? `${rightTone}${color.bold}${right}${color.reset}` : ""}${color.border}│${color.reset}`;
}

function extractKeyFacts(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const facts = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    facts.push(`${label}=${short(value)}`);
  };
  add("session", payload.sessionId?.slice?.(-8) ?? payload.sessionId);
  add("run", payload.runId);
  add("cycle", payload.cycleCount);
  add("phase", payload.phase);
  add("tool", payload.tool);
  add("state", payload.payloadPreview?.decisionState ?? payload.state);
  add("stop", payload.payloadPreview?.actor?.stopReason ?? payload.stopReason);
  add("summary", payload.payloadPreview?.summary ?? payload.payloadPreview?.decisionInternalSummary);
  add("user", payload.payloadPreview?.decisionUserUpdate ?? payload.payloadPreview?.userUpdate);
  add("event", payload.eventType);
  add("command", payload.command);
  return facts.slice(0, 6);
}

function parseTraceLine(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+\[AgenC Daemon\]\s+\[trace\]\s+([^\s]+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  const [, ts, level, label, rest] = match;
  let payload = null;
  try {
    payload = JSON.parse(rest);
  } catch {
    payload = { raw: rest };
  }
  return { ts, level, label, payload };
}

function renderTrace(line) {
  const parsed = parseTraceLine(line);
  if (!parsed) {
    if (line.includes("ERROR")) {
      process.stdout.write(`${badge("FAULT", color.red)} ${line}\n${divider()}\n`);
      return;
    }
    if (line.includes("WARN")) {
      process.stdout.write(`${badge("WARN", color.amber)} ${line}\n${divider()}\n`);
      return;
    }
    return;
  }

  const tone = toneForLabel(parsed.label);
  const facts = extractKeyFacts(parsed.payload);
  const time = parsed.ts.split("T")[1]?.replace("Z", "") ?? parsed.ts;
  const width = frameWidth();
  const head = `${color.slate}${time}${color.reset} ${badge("TRACE", tone)} ${tone}${parsed.label}${color.reset}`;
  process.stdout.write(`${head}\n`);
  if (facts.length > 0) {
    process.stdout.write(`  ${color.fog}${short(facts.join(" // "), Math.max(20, width - 2))}${color.reset}\n`);
  }
  process.stdout.write(`${divider(width)}\n`);
}

{
  const width = frameWidth();
  const inner = width - 2;
  const top = `${color.border}┌${color.borderStrong}${"─".repeat(inner)}${color.reset}${color.border}┐${color.reset}`;
  const bottom = `${color.border}└${color.borderStrong}${"─".repeat(inner)}${color.reset}${color.border}┘${color.reset}`;
  const title = frameLine(" A G E N / C TRACE BUS", "HIGH SIGNAL ");
  const subtitle = frameLine(" provider / tool / background diagnostics", "", color.fog, color.fog);
  process.stdout.write(`${top}\n${title}\n${subtitle}\n${bottom}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  renderTrace(line);
});
