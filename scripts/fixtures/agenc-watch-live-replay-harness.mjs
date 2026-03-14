import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { createWatchApp } from "../lib/agenc-watch-app.mjs";
import { loadOperatorEventHelpers } from "../lib/agenc-watch-runtime.mjs";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(FIXTURES_DIR, "..");

export const IDENTITY_OPERATOR_EVENT_HELPERS = Object.freeze({
  normalizeOperatorMessage: (value) => value,
  projectOperatorSurfaceEvent: (value) => value,
  shouldIgnoreOperatorMessage: () => false,
});

export class FakeStream extends EventEmitter {
  constructor({ throwsOnResize = false, columns = 120, rows = 40 } = {}) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.rawModes = [];
    this.resumeCalls = 0;
    this.writes = [];
    this.throwsOnResize = throwsOnResize;
  }

  setRawMode(value) {
    this.rawModes.push(Boolean(value));
  }

  resume() {
    this.resumeCalls += 1;
  }

  write(value) {
    this.writes.push(String(value ?? ""));
    return true;
  }

  on(eventName, listener) {
    if (this.throwsOnResize && eventName === "resize") {
      throw new Error("resize listener failed");
    }
    return super.on(eventName, listener);
  }
}

export class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  emit(name, payload) {
    for (const handler of this.listeners.get(name) ?? []) {
      handler(payload);
    }
  }

  open(payload = {}) {
    this.emit("open", payload);
  }

  message(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", { data });
  }

  error(error = new Error("socket error")) {
    this.emit("error", error);
  }

  close(payload = {}) {
    this.closed = true;
    this.emit("close", payload);
  }

  send(value) {
    this.sent.push(value);
  }
}

export function createReplayClock({ startMs = Date.UTC(2026, 2, 14, 18, 0, 0) } = {}) {
  let currentMs = Number(startMs);
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  function setTimeoutFn(callback, delay = 0) {
    const id = nextId++;
    timeouts.set(id, {
      id,
      callback,
      at: currentMs + Math.max(0, Number(delay) || 0),
    });
    return id;
  }

  function clearTimeoutFn(id) {
    timeouts.delete(id);
  }

  function setIntervalFn(callback, delay = 0) {
    const id = nextId++;
    intervals.set(id, {
      id,
      callback,
      delay: Math.max(1, Number(delay) || 1),
      at: currentMs + Math.max(1, Number(delay) || 1),
    });
    return id;
  }

  function clearIntervalFn(id) {
    intervals.delete(id);
  }

  function flushTimeouts({ maxSteps = 128 } = {}) {
    let executed = 0;
    while (executed < maxSteps) {
      let nextEntry = null;
      for (const entry of timeouts.values()) {
        if (!nextEntry || entry.at < nextEntry.at || (entry.at === nextEntry.at && entry.id < nextEntry.id)) {
          nextEntry = entry;
        }
      }
      if (!nextEntry) {
        break;
      }
      timeouts.delete(nextEntry.id);
      currentMs = Math.max(currentMs, nextEntry.at);
      nextEntry.callback();
      executed += 1;
    }
    return executed;
  }

  function tickIntervals({ maxSteps = 1 } = {}) {
    let executed = 0;
    while (executed < maxSteps) {
      let nextEntry = null;
      for (const entry of intervals.values()) {
        if (!nextEntry || entry.at < nextEntry.at || (entry.at === nextEntry.at && entry.id < nextEntry.id)) {
          nextEntry = entry;
        }
      }
      if (!nextEntry) {
        break;
      }
      currentMs = Math.max(currentMs, nextEntry.at);
      nextEntry.callback();
      nextEntry.at = currentMs + nextEntry.delay;
      intervals.set(nextEntry.id, nextEntry);
      executed += 1;
    }
    return executed;
  }

  return {
    nowMs: () => currentMs,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    flushTimeouts,
    tickIntervals,
    advanceBy(ms = 0) {
      currentMs += Math.max(0, Number(ms) || 0);
      return currentMs;
    },
  };
}

export function normalizeReplayFrame(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) =>
      String(line ?? "")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\s+$/g, ""),
    )
    .join("\n");
}

function sanitizeReplayMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta ?? null;
  }
  const next = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/token|auth|owner|temp|path|frameId|requestId/i.test(key)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function summarizeReplayCheckpoint(checkpoint) {
  const overview = checkpoint.summary?.overview ?? {};
  return {
    label: checkpoint.label,
    meta: sanitizeReplayMeta(checkpoint.meta),
    summary: {
      connectionState: overview.connectionState ?? null,
      phaseLabel: overview.phaseLabel ?? null,
      latestTool: overview.latestTool ?? null,
      latestToolState: overview.latestToolState ?? null,
      fallbackState: overview.fallbackState ?? null,
      runtimeState: overview.runtimeState ?? null,
      activeLine: overview.activeLine ?? null,
      activeAgentCount: overview.activeAgentCount ?? null,
      planCount: overview.planCount ?? null,
      objective: checkpoint.summary?.objective ?? null,
      routeLabel: checkpoint.summary?.routeLabel ?? null,
      providerLabel: checkpoint.summary?.providerLabel ?? null,
    },
    state: {
      connectionState: checkpoint.state?.connectionState ?? null,
      sessionId: checkpoint.state?.sessionId ?? null,
      objective: checkpoint.state?.objective ?? null,
      phaseLabel: checkpoint.state?.phaseLabel ?? null,
      runState: checkpoint.state?.runState ?? null,
      runPhase: checkpoint.state?.runPhase ?? null,
      latestTool: checkpoint.state?.latestTool ?? null,
      latestToolState: checkpoint.state?.latestToolState ?? null,
      eventCount: checkpoint.state?.eventCount ?? 0,
      expandedEventId: checkpoint.state?.expandedEventId ?? null,
    },
    frame: normalizeReplayFrame(checkpoint.snapshot?.lines ?? []),
  };
}

async function resolveReplayOperatorEventHelpers({
  operatorEventHelpers,
  cwd,
} = {}) {
  if (operatorEventHelpers) {
    return operatorEventHelpers;
  }
  return loadOperatorEventHelpers({
    baseDir: SCRIPTS_DIR,
    cwd,
  });
}

export async function createWatchLiveReplayHarness(options = {}) {
  const {
    width = 120,
    height = 40,
    cwd = "/home/tetsuo/git/AgenC",
    stdoutThrows = false,
    operatorEventHelpers = null,
    env = {},
    startMs,
  } = options;

  FakeWebSocket.instances.length = 0;
  const timer = createReplayClock({ startMs });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-replay-"));
  const stdin = new FakeStream({ columns: width, rows: height });
  const stdout = new FakeStream({ columns: width, rows: height, throwsOnResize: stdoutThrows });
  const stderr = new FakeStream({ columns: width, rows: height });
  const exits = [];
  const checkpoints = [];
  const resolvedOperatorEventHelpers = await resolveReplayOperatorEventHelpers({
    operatorEventHelpers,
    cwd,
  });

  const app = await createWatchApp({
    processLike: {
      stdin,
      stdout,
      stderr,
      env: {
        PATH: process.env.PATH ?? "",
        AGENC_WATCH_STATE_FILE: path.join(tmpDir, "watch-state.json"),
        AGENC_WATCH_ENABLE_MOUSE: "0",
        ...env,
      },
      cwd: () => cwd,
      exit: (code) => {
        exits.push(code);
      },
      argv: ["node", "scripts/agenc-watch.mjs"],
    },
    WebSocket: FakeWebSocket,
    operatorEventHelpers: resolvedOperatorEventHelpers,
    nowMs: timer.nowMs,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    flushTimers: () => timer.flushTimeouts(),
  });

  return {
    app,
    stdin,
    stdout,
    stderr,
    exits,
    tmpDir,
    timer,
    checkpoints,
    latestSocket() {
      return FakeWebSocket.instances.at(-1) ?? null;
    },
    openSocket() {
      const socket = this.latestSocket();
      assert.ok(socket, "expected a websocket instance");
      socket.open();
      return socket;
    },
    socketMessage(payload, { socket = this.latestSocket() } = {}) {
      assert.ok(socket, "expected a websocket instance");
      socket.message(payload);
    },
    closeSocket(payload = {}, { socket = this.latestSocket() } = {}) {
      assert.ok(socket, "expected a websocket instance");
      socket.close(payload);
    },
    input(text) {
      stdin.emit("data", Buffer.from(String(text ?? ""), "utf8"));
    },
    async start() {
      await app.start();
      return this;
    },
    dispose(exitCode = 0) {
      return app.dispose(exitCode);
    },
    flushTimers() {
      return app.flushReplayTimers();
    },
    capture(label, { width: captureWidth = width, height: captureHeight = height, meta = null } = {}) {
      const checkpoint = summarizeReplayCheckpoint(
        app.captureReplayCheckpoint(label, {
          width: captureWidth,
          height: captureHeight,
          meta,
        }),
      );
      checkpoints.push(checkpoint);
      return checkpoint;
    },
    buildBundle(meta = {}) {
      return {
        meta: sanitizeReplayMeta({
          width,
          height,
          ...meta,
        }),
        checkpoints: [...checkpoints],
      };
    },
  };
}
