#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "../node_modules/ws/wrapper.mjs";
import {
  buildAutonomyStages,
  evaluateAutonomyStage,
  parseStageSelection,
  pickTrackedSession,
  pickLatestTrace,
} from "./lib/agenc-autonomy-ladder.mjs";

const DEFAULT_WS_URL = "ws://127.0.0.1:3100";
const DEFAULT_TMUX_TARGET = "agenc-watch:live.0";
const DEFAULT_CLIENT_KEY = "tmux-live-watch";
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PANE_CAPTURE_LINES = 220;
const DEFAULT_DAEMON_CONFIG = "/home/tetsuo/.agenc/config.json";
const DEFAULT_DAEMON_PID_PATH = "/home/tetsuo/.agenc/daemon.pid";

function nextRunToken() {
  const date = new Date();
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  return `ladder-${stamp}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function execFileOutput(command, args, options = {}) {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectExec);
    child.on("close", (code) => {
      if (code === 0) {
        resolveExec({ stdout, stderr, code });
        return;
      }
      rejectExec(
        new Error(
          `${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`,
        ),
      );
    });
  });
}

class WebchatInspector {
  constructor({ wsUrl, clientKey, requestTimeoutMs }) {
    this.wsUrl = wsUrl;
    this.clientKey = clientKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.openPromise = null;
    this.pending = new Map();
    this.requestCounter = 0;
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.openPromise) {
      await this.openPromise;
      return;
    }

    this.openPromise = new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.openPromise = null;
        resolveOpen();
      });
      socket.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (!message?.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.resolve(message);
      });
      socket.addEventListener("close", () => {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`WebSocket closed before response for ${id}`));
        }
        this.pending.clear();
        this.socket = null;
        this.openPromise = null;
      });
      socket.addEventListener("error", (error) => {
        if (this.openPromise) {
          this.openPromise = null;
          rejectOpen(error);
          return;
        }
      });
    });

    await this.openPromise;
    await this.request("chat.sessions", { clientKey: this.clientKey }).catch(() => undefined);
  }

  async request(type, payload) {
    await this.connect();
    const id = `${type}-${++this.requestCounter}`;
    const frame = JSON.stringify({ type, payload, id });
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for ${type}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.socket.send(frame);
    });
  }

  async listSessions() {
    const response = await this.request("chat.sessions", {
      clientKey: this.clientKey,
    });
    return Array.isArray(response.payload) ? response.payload : [];
  }

  async inspectRun(sessionId) {
    try {
      const response = await this.request("run.inspect", { sessionId });
      return response.payload ?? undefined;
    } catch (error) {
      if (String(error?.message ?? error).includes("not found")) {
        return undefined;
      }
      throw error;
    }
  }

  async listTraces(sessionId) {
    const response = await this.request("observability.traces", {
      sessionId,
      limit: 10,
    });
    return Array.isArray(response.payload) ? response.payload : [];
  }

  async getTrace(traceId) {
    const response = await this.request("observability.trace", { traceId });
    return response.payload ?? undefined;
  }

  async close() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {}
    this.socket = null;
  }
}

function parseArgs(argv) {
  const options = {
    scenario: "baseline",
    wsUrl: DEFAULT_WS_URL,
    tmuxTarget: DEFAULT_TMUX_TARGET,
    clientKey: DEFAULT_CLIENT_KEY,
    pollMs: DEFAULT_POLL_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    paneCaptureLines: DEFAULT_PANE_CAPTURE_LINES,
    daemonConfig: DEFAULT_DAEMON_CONFIG,
    daemonPidPath: DEFAULT_DAEMON_PID_PATH,
    resetSession: true,
    runToken: nextRunToken(),
    stages: "0-8",
    artifactsDir: resolve(
      process.cwd(),
      ".tmp",
      "autonomy-ladder",
      nextRunToken(),
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ws-url" && argv[index + 1]) {
      options.wsUrl = argv[++index];
      continue;
    }
    if (arg === "--scenario" && argv[index + 1]) {
      options.scenario = argv[++index];
      continue;
    }
    if (arg === "--tmux-target" && argv[index + 1]) {
      options.tmuxTarget = argv[++index];
      continue;
    }
    if (arg === "--client-key" && argv[index + 1]) {
      options.clientKey = argv[++index];
      continue;
    }
    if (arg === "--poll-ms" && argv[index + 1]) {
      options.pollMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--request-timeout-ms" && argv[index + 1]) {
      options.requestTimeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--pane-capture-lines" && argv[index + 1]) {
      options.paneCaptureLines = Number(argv[++index]);
      continue;
    }
    if (arg === "--run-token" && argv[index + 1]) {
      options.runToken = argv[++index];
      continue;
    }
    if (arg === "--stages" && argv[index + 1]) {
      options.stages = argv[++index];
      continue;
    }
    if (arg === "--artifacts-dir" && argv[index + 1]) {
      options.artifactsDir = resolve(process.cwd(), argv[++index]);
      continue;
    }
    if (arg === "--daemon-config" && argv[index + 1]) {
      options.daemonConfig = argv[++index];
      continue;
    }
    if (arg === "--daemon-pid-path" && argv[index + 1]) {
      options.daemonPidPath = argv[++index];
      continue;
    }
    if (arg === "--no-reset") {
      options.resetSession = false;
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: node scripts/run-autonomy-ladder.mjs [options]",
          "",
          "Options:",
          `  --tmux-target <pane>        Default: ${DEFAULT_TMUX_TARGET}`,
          `  --client-key <key>         Default: ${DEFAULT_CLIENT_KEY}`,
          `  --ws-url <url>             Default: ${DEFAULT_WS_URL}`,
          "  --scenario <name>          baseline | server | spreadsheet | office-document | productivity",
          "  --stages <ids>             Example: 0-4,6,8",
          "  --run-token <token>        Reuse a stable stage token",
          "  --artifacts-dir <path>     Output directory for JSON/txt artifacts",
          "  --poll-ms <ms>             Poll interval for evidence capture",
          "  --request-timeout-ms <ms>  Inspector request timeout",
          "  --pane-capture-lines <n>   tmux capture depth",
          "  --daemon-config <path>     Config used for restart stage",
          "  --daemon-pid-path <path>   PID file used for restart stage",
          "  --no-reset                 Keep the current chat session instead of /new",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  if (!options.artifactsDir.endsWith(options.runToken)) {
    options.artifactsDir = resolve(options.artifactsDir, options.runToken);
  }
  return options;
}

async function verifyTmuxTarget(tmuxTarget) {
  const result = await execFileOutput("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}:#{window_name}.#{pane_index}",
  ]);
  const panes = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!panes.includes(tmuxTarget)) {
    throw new Error(`tmux target ${tmuxTarget} not found. Available: ${panes.join(", ")}`);
  }
}

async function sendTmuxInput(tmuxTarget, input) {
  await execFileOutput("tmux", ["send-keys", "-t", tmuxTarget, "C-u"]);
  await execFileOutput("tmux", ["send-keys", "-t", tmuxTarget, "-l", "--", input]);
  await execFileOutput("tmux", ["send-keys", "-t", tmuxTarget, "Enter"]);
}

async function capturePane(tmuxTarget, paneCaptureLines) {
  const result = await execFileOutput("tmux", [
    "capture-pane",
    "-p",
    "-J",
    "-t",
    tmuxTarget,
    "-S",
    `-${paneCaptureLines}`,
  ]);
  return result.stdout;
}

async function restartDaemon(options) {
  await execFileOutput(
    "node",
    [
      "runtime/dist/bin/agenc-runtime.js",
      "restart",
      "--config",
      options.daemonConfig,
      "--pid-path",
      options.daemonPidPath,
    ],
    { cwd: process.cwd() },
  );
}

async function collectEvidence(inspector, options, stageStartedAt, context) {
  const paneText = await capturePane(options.tmuxTarget, options.paneCaptureLines);
  const sessions = await inspector.listSessions();
  const session = pickTrackedSession(sessions, context.sessionId);
  const sessionId = session?.sessionId;
  let runDetail;
  let traceSummary;
  let traceDetail;
  if (sessionId) {
    runDetail = await inspector.inspectRun(sessionId);
    const traces = await inspector.listTraces(sessionId);
    traceSummary = pickLatestTrace(traces, stageStartedAt);
    if (traceSummary?.traceId) {
      traceDetail = await inspector.getTrace(traceSummary.traceId);
    }
  }

  return {
    runToken: options.runToken,
    sessionId,
    session,
    runDetail,
    traceSummary,
    traceDetail,
    paneText,
    runText: runDetail ? JSON.stringify(runDetail, null, 2) : "",
    traceText: traceDetail ? JSON.stringify(traceDetail, null, 2) : "",
    context,
  };
}

async function waitForStageEvaluation({
  inspector,
  options,
  action,
  timeoutMs,
  context,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const evidence = await collectEvidence(inspector, options, startedAt, context);
    const evaluation = evaluateAutonomyStage(action.evaluationId, evidence, context);
    if (evaluation.passed) {
      return {
        startedAt,
        completedAt: Date.now(),
        evidence,
        evaluation,
      };
    }
    await sleep(options.pollMs);
  }

  const evidence = await collectEvidence(inspector, options, startedAt, context);
  const evaluation = evaluateAutonomyStage(action.evaluationId, evidence, context);
  return {
    startedAt,
    completedAt: Date.now(),
    evidence,
    evaluation,
  };
}

async function runStage(stage, inspector, options, context) {
  const stageArtifact = {
    stageId: stage.id,
    title: stage.title,
    startedAt: Date.now(),
    actions: [],
  };

  for (const action of stage.actions) {
    if (action.kind === "input" || action.kind === "command") {
      await sendTmuxInput(options.tmuxTarget, action.input);
    } else if (action.kind === "restart") {
      await restartDaemon(options);
    } else {
      throw new Error(`Unsupported action kind: ${action.kind}`);
    }

    const result = await waitForStageEvaluation({
      inspector,
      options,
      action,
      timeoutMs: stage.timeoutMs,
      context,
    });
    stageArtifact.actions.push({
      id: action.id,
      kind: action.kind,
      input: action.input,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      passed: result.evaluation.passed,
      reasons: result.evaluation.reasons,
      sessionId: result.evidence.sessionId,
      runId: result.evidence.runDetail?.runId,
      traceId: result.evidence.traceSummary?.traceId,
      runState: result.evidence.runDetail?.state,
      paneText: result.evidence.paneText,
      runDetail: result.evidence.runDetail,
      traceSummary: result.evidence.traceSummary,
      traceDetail: result.evidence.traceDetail,
    });

    if (!result.evaluation.passed) {
      stageArtifact.passed = false;
      stageArtifact.completedAt = Date.now();
      stageArtifact.runId = result.evidence.runDetail?.runId ?? context.runId;
      stageArtifact.sessionId = result.evidence.sessionId ?? context.sessionId;
      stageArtifact.traceId = result.evidence.traceSummary?.traceId;
      stageArtifact.failureReasons = result.evaluation.reasons;
      return stageArtifact;
    }

    context.sessionId = result.evidence.sessionId ?? context.sessionId;
    context.runId = result.evaluation.runId ?? result.evidence.runDetail?.runId ?? context.runId;
    context.traceId = result.evidence.traceSummary?.traceId ?? context.traceId;
    context.lastStageCompletedAt = result.completedAt;
  }

  stageArtifact.passed = true;
  stageArtifact.completedAt = Date.now();
  stageArtifact.runId = context.runId;
  stageArtifact.sessionId = context.sessionId;
  stageArtifact.traceId = context.traceId;
  return stageArtifact;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stages = parseStageSelection(
    options.stages,
    buildAutonomyStages(options.runToken, options.scenario),
  );
  await verifyTmuxTarget(options.tmuxTarget);
  await mkdir(options.artifactsDir, { recursive: true });

  const inspector = new WebchatInspector({
    wsUrl: options.wsUrl,
    clientKey: options.clientKey,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  const runArtifact = {
    runToken: options.runToken,
    tmuxTarget: options.tmuxTarget,
    wsUrl: options.wsUrl,
    scenario: options.scenario,
    clientKey: options.clientKey,
    startedAt: Date.now(),
    stages: [],
  };
  const context = {};

  try {
    if (options.resetSession) {
      await sendTmuxInput(options.tmuxTarget, "/new");
      await sleep(1_000);
    }

    for (const stage of stages) {
      console.log(`[autonomy] running stage ${stage.id}: ${stage.title}`);
      const stageArtifact = await runStage(stage, inspector, options, context);
      runArtifact.stages.push(stageArtifact);
      const stagePath = resolve(options.artifactsDir, `stage-${stage.id}.json`);
      await writeFile(`${stagePath}`, `${JSON.stringify(stageArtifact, null, 2)}\n`, "utf8");
      if (!stageArtifact.passed) {
        runArtifact.completedAt = Date.now();
        runArtifact.passed = false;
        runArtifact.failedStage = stage.id;
        runArtifact.failureReasons = stageArtifact.failureReasons;
        await writeFile(
          resolve(options.artifactsDir, "run.json"),
          `${JSON.stringify(runArtifact, null, 2)}\n`,
          "utf8",
        );
        console.error(
          `[autonomy] stage ${stage.id} failed: ${(stageArtifact.failureReasons ?? []).join("; ")}`,
        );
        process.exit(1);
      }
    }

    runArtifact.completedAt = Date.now();
    runArtifact.passed = true;
    await writeFile(
      resolve(options.artifactsDir, "run.json"),
      `${JSON.stringify(runArtifact, null, 2)}\n`,
      "utf8",
    );
    console.log(
      [
        `[autonomy] completed ${runArtifact.stages.length} stages`,
        `[autonomy] artifacts: ${resolve(options.artifactsDir, "run.json")}`,
        `[autonomy] run token: ${options.runToken}`,
      ].join("\n"),
    );
  } finally {
    await inspector.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[autonomy] runner failed: ${message}`);
  process.exit(1);
});
