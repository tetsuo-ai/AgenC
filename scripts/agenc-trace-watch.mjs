import readline from "node:readline";

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  slate: "\x1b[38;5;246m",
  blue: "\x1b[38;5;75m",
  cyan: "\x1b[38;5;81m",
  teal: "\x1b[38;5;44m",
  green: "\x1b[38;5;42m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;214m",
  magenta: "\x1b[38;5;213m",
  red: "\x1b[38;5;203m",
  border: "\x1b[38;5;238m",
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
  return `${tone}${color.bold}[${label}]${color.reset}`;
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
      process.stdout.write(`${badge("ERROR", color.red)} ${line}\n`);
      return;
    }
    if (line.includes("WARN")) {
      process.stdout.write(`${badge("WARN", color.amber)} ${line}\n`);
      return;
    }
    return;
  }

  const tone = toneForLabel(parsed.label);
  const facts = extractKeyFacts(parsed.payload);
  const time = parsed.ts.split("T")[1]?.replace("Z", "") ?? parsed.ts;
  const head = `${color.slate}${time}${color.reset} ${badge("TRACE", tone)} ${tone}${parsed.label}${color.reset}`;
  process.stdout.write(`${head}\n`);
  if (facts.length > 0) {
    process.stdout.write(`  ${color.slate}${facts.join("  ")}${color.reset}\n`);
  }
  process.stdout.write(`${color.border}${"─".repeat(68)}${color.reset}\n`);
}

process.stdout.write(
  `${color.border}${"═".repeat(72)}${color.reset}\n` +
  `${color.cyan}${color.bold}AgenC High-Signal Trace${color.reset}\n` +
  `${color.border}${"═".repeat(72)}${color.reset}\n`,
);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  renderTrace(line);
});
