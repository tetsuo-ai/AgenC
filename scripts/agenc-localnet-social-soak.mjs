#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  waitForAllAgentRuntimesReady,
} from "./agenc-social-readiness.mjs";
import { loadWebSocketConstructor } from "./lib/agenc-websocket.mjs";

const WebSocket = await loadWebSocketConstructor();

const DEFAULT_SUMMARY_PATH = path.join(
  process.env.HOME ?? "/tmp",
  ".agenc",
  "localnet-soak",
  "default",
  "social",
  "summary.json",
);
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_INTER_TURN_MS = 2_000;
const DEFAULT_CONNECT_RETRIES = 3;
const DEFAULT_STARTUP_TIMEOUT_MS = DEFAULT_READINESS_TIMEOUT_MS;

function nowIso() {
  return new Date().toISOString();
}

function logProgress(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function onSocketOpen(socket, handler) {
  if (typeof socket.on === "function") {
    socket.on("open", handler);
    return;
  }
  socket.addEventListener("open", handler);
}

function onSocketMessage(socket, handler) {
  if (typeof socket.on === "function") {
    socket.on("message", (data) => handler(data));
    return;
  }
  socket.addEventListener("message", (event) => handler(event.data));
}

function onSocketClose(socket, handler) {
  if (typeof socket.on === "function") {
    socket.on("close", handler);
    return;
  }
  socket.addEventListener("close", handler);
}

function onSocketError(socket, handler) {
  if (typeof socket.on === "function") {
    socket.on("error", handler);
    return;
  }
  socket.addEventListener("error", handler);
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/agenc-localnet-social-soak.mjs [options]

Options:
  --summary-path <path>        Social summary path
  --run-token <token>          Stable run token for prompts and artifacts
  --request-timeout-ms <ms>    Direct request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
  --turn-timeout-ms <ms>       Per-turn timeout (default: ${DEFAULT_TURN_TIMEOUT_MS})
  --inter-turn-ms <ms>         Delay between turns (default: ${DEFAULT_INTER_TURN_MS})
  --connect-retries <count>    Connection/bootstrap retries per agent (default: ${DEFAULT_CONNECT_RETRIES})
  --startup-timeout-ms <ms>    Daemon readiness wait timeout (default: ${DEFAULT_STARTUP_TIMEOUT_MS})
  --continue-on-error          Continue remaining turns after a failure
  --help                       Show this help
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRunToken() {
  const date = new Date();
  return [
    "social-soak",
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

function parseArgs(argv) {
  const options = {
    summaryPath: DEFAULT_SUMMARY_PATH,
    runToken: nextRunToken(),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    interTurnMs: DEFAULT_INTER_TURN_MS,
    connectRetries: DEFAULT_CONNECT_RETRIES,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    continueOnError: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary-path" && argv[index + 1]) {
      options.summaryPath = path.resolve(argv[++index]);
      continue;
    }
    if (arg === "--run-token" && argv[index + 1]) {
      options.runToken = String(argv[++index]);
      continue;
    }
    if (arg === "--request-timeout-ms" && argv[index + 1]) {
      options.requestTimeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--turn-timeout-ms" && argv[index + 1]) {
      options.turnTimeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--inter-turn-ms" && argv[index + 1]) {
      options.interTurnMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--connect-retries" && argv[index + 1]) {
      options.connectRetries = Number(argv[++index]);
      continue;
    }
    if (arg === "--startup-timeout-ms" && argv[index + 1]) {
      options.startupTimeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--continue-on-error") {
      options.continueOnError = true;
      continue;
    }
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function summarizeToolResult(toolName, rawResult) {
  if (typeof rawResult !== "string" || rawResult.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawResult);
    if (toolName === "social.sendMessage") {
      return {
        requestedRecipient:
          typeof parsed.requestedRecipient === "string"
            ? parsed.requestedRecipient
            : null,
        recipientLabel:
          typeof parsed.recipientLabel === "string"
            ? parsed.recipientLabel
            : null,
        threadId:
          typeof parsed.threadId === "string" ? parsed.threadId : null,
        mode: typeof parsed.mode === "string" ? parsed.mode : null,
        onChain:
          typeof parsed.onChain === "boolean" ? parsed.onChain : null,
      };
    }

    if (toolName === "social.getRecentMessages") {
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      return {
        count: typeof parsed.count === "number" ? parsed.count : messages.length,
        messageThreadIds: [
          ...new Set(
            messages
              .map((message) =>
                typeof message?.threadId === "string" ? message.threadId : null,
              )
              .filter(Boolean),
          ),
        ],
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildToolCalls(events) {
  const executions = events.filter((event) => event.type === "tools.executing");
  const resultQueues = new Map();

  for (const event of events.filter((entry) => entry.type === "tools.result")) {
    const toolName =
      typeof event.payload?.toolName === "string" ? event.payload.toolName : null;
    if (!toolName) {
      continue;
    }
    const queue = resultQueues.get(toolName) ?? [];
    queue.push(event.payload);
    resultQueues.set(toolName, queue);
  }

  return executions.map((event) => {
    const toolName =
      typeof event.payload?.toolName === "string" ? event.payload.toolName : "unknown";
    const queue = resultQueues.get(toolName) ?? [];
    const resultPayload = queue.length > 0 ? queue.shift() : null;
    return {
      toolName,
      args:
        event.payload && typeof event.payload.args === "object"
          ? event.payload.args
          : {},
      durationMs:
        typeof resultPayload?.durationMs === "number"
          ? resultPayload.durationMs
          : null,
      isError: Boolean(resultPayload?.isError),
      resultSummary: summarizeToolResult(
        toolName,
        typeof resultPayload?.result === "string" ? resultPayload.result : "",
      ),
    };
  });
}

function validateToolSequence(turn, toolCalls, issues) {
  const actualToolNames = toolCalls.map((call) => call.toolName);
  const expectedToolNames = turn.expectations.toolSequence;

  if (actualToolNames.length !== expectedToolNames.length) {
    issues.push(
      `Tool count mismatch: expected ${expectedToolNames.length}, got ${actualToolNames.length}`,
    );
  }

  if (actualToolNames.join(" -> ") !== expectedToolNames.join(" -> ")) {
    issues.push(
      `Tool order mismatch: expected ${expectedToolNames.join(" -> ")} but got ${actualToolNames.join(" -> ") || "<none>"}`,
    );
  }

  const failedCalls = toolCalls.filter((call) => call.isError);
  if (failedCalls.length > 0) {
    issues.push(
      `Tool failures observed: ${failedCalls.map((call) => call.toolName).join(", ")}`,
    );
  }
}

function validateSendMessageCalls(turn, toolCalls, issues) {
  const sendCalls = toolCalls.filter(
    (call) => call.toolName === "social.sendMessage",
  );
  const actualRecipients = sendCalls.map((call) =>
    typeof call.args?.recipient === "string" ? call.args.recipient : null,
  );
  const expectedRecipients = turn.expectations.sendRecipients;

  if (actualRecipients.join(" -> ") !== expectedRecipients.join(" -> ")) {
    issues.push(
      `Recipient order mismatch: expected ${expectedRecipients.join(" -> ")} but got ${actualRecipients.join(" -> ") || "<none>"}`,
    );
  }

  for (const call of sendCalls) {
    if (call.args?.threadId !== turn.runToken) {
      issues.push(
        `social.sendMessage threadId mismatch for ${call.args?.recipient ?? "unknown"}: expected ${turn.runToken}`,
      );
    }
    if (call.args?.mode !== "off-chain") {
      issues.push(
        `social.sendMessage mode mismatch for ${call.args?.recipient ?? "unknown"}: expected off-chain`,
      );
    }
    if (call.resultSummary?.threadId !== turn.runToken) {
      issues.push(
        `social.sendMessage result threadId mismatch for ${call.args?.recipient ?? "unknown"}: expected ${turn.runToken}`,
      );
    }
    if (call.resultSummary?.mode !== "off-chain") {
      issues.push(
        `social.sendMessage result mode mismatch for ${call.args?.recipient ?? "unknown"}: expected off-chain`,
      );
    }
    if (call.resultSummary?.onChain !== false) {
      issues.push(
        `social.sendMessage result onChain mismatch for ${call.args?.recipient ?? "unknown"}: expected false`,
      );
    }
  }
}

function validateRecentMessagesCall(turn, toolCalls, issues) {
  const getMessagesCall = toolCalls.find(
    (call) => call.toolName === "social.getRecentMessages",
  );
  if (turn.expectations.minimumIncomingMessages <= 0) {
    return;
  }

  const observedCount =
    typeof getMessagesCall?.resultSummary?.count === "number"
      ? getMessagesCall.resultSummary.count
      : 0;
  if (observedCount < turn.expectations.minimumIncomingMessages) {
    issues.push(
      `social.getRecentMessages returned ${observedCount}, expected at least ${turn.expectations.minimumIncomingMessages}`,
    );
  }

  const observedThreadIds = Array.isArray(getMessagesCall?.resultSummary?.messageThreadIds)
    ? getMessagesCall.resultSummary.messageThreadIds
    : [];
  if (observedThreadIds.some((threadId) => threadId !== turn.runToken)) {
    issues.push(
      `social.getRecentMessages returned messages outside thread ${turn.runToken}`,
    );
  }
}

function validateTurnExecution(turn, summaryResult) {
  const issues = [];
  validateToolSequence(turn, summaryResult.toolCalls, issues);
  validateSendMessageCalls(turn, summaryResult.toolCalls, issues);
  validateRecentMessagesCall(turn, summaryResult.toolCalls, issues);

  return {
    ok: issues.length === 0,
    issues,
  };
}

class GatewayTurnClient {
  constructor({ label, gatewayPort, clientKey, requestTimeoutMs }) {
    this.label = label;
    this.gatewayPort = gatewayPort;
    this.clientKey = clientKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.url = `ws://127.0.0.1:${gatewayPort}`;
    this.socket = null;
    this.openPromise = null;
    this.pendingRequests = new Map();
    this.requestCounter = 0;
    this.sessionId = null;
    this.sessionWaiters = [];
    this.turnState = null;
    this.socialEvents = [];
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.openPromise) {
      await this.openPromise;
      return;
    }

    this.openPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        this.openPromise = null;
        callback(value);
      };
      const connectTimeout = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        finish(
          reject,
          new Error(`${this.label} timed out connecting to ${this.url}`),
        );
      }, this.requestTimeoutMs);

      onSocketOpen(socket, () => {
        finish(resolve);
      });

      onSocketMessage(socket, (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        this.handleMessage(message);
      });

      onSocketClose(socket, () => {
        const error = new Error(`${this.label} websocket closed`);
        if (!settled) {
          finish(reject, error);
          return;
        }
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pendingRequests.clear();
        if (this.turnState && !this.turnState.done) {
          this.turnState.done = true;
          clearTimeout(this.turnState.timeout);
          this.turnState.reject(error);
        }
        this.socket = null;
      });

      onSocketError(socket, (error) => {
        if (!settled) {
          finish(reject, error);
          return;
        }
      });
    });

    await this.openPromise;
  }

  handleMessage(message) {
    if (message?.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      pending.resolve(message);
    }

    if (message?.type === "chat.session") {
      this.sessionId = message.payload?.sessionId ?? this.sessionId;
      if (this.sessionId) {
        this.resolveSessionWaiters(this.sessionId);
      }
    }

    if (message?.type === "social.message") {
      this.socialEvents.push({
        receivedAt: Date.now(),
        payload: message.payload ?? null,
      });
    }

    if (!this.turnState || this.turnState.done) {
      return;
    }

    if (message?.type === "tools.executing") {
      this.turnState.events.push({
        type: "tools.executing",
        at: Date.now(),
        payload: message.payload ?? null,
      });
      return;
    }

    if (message?.type === "tools.result") {
      this.turnState.events.push({
        type: "tools.result",
        at: Date.now(),
        payload: message.payload ?? null,
      });
      return;
    }

    if (message?.type === "social.message") {
      this.turnState.events.push({
        type: "social.message",
        at: Date.now(),
        payload: message.payload ?? null,
      });
      return;
    }

    if (message?.type === "error") {
      this.turnState.done = true;
      clearTimeout(this.turnState.timeout);
      this.turnState.reject(
        new Error(message.error ?? `${this.label} turn failed`),
      );
      return;
    }

    if (message?.type === "chat.cancelled") {
      this.turnState.done = true;
      clearTimeout(this.turnState.timeout);
      this.turnState.reject(new Error(`${this.label} turn cancelled`));
      return;
    }

    if (message?.type === "chat.message") {
      const reply = typeof message.payload?.content === "string"
        ? message.payload.content
        : "";
      this.turnState.done = true;
      clearTimeout(this.turnState.timeout);
      this.turnState.resolve({
        reply,
        events: [...this.turnState.events],
      });
    }
  }

  async request(type, payload = {}) {
    await this.connect();
    const id = `${type}-${this.label}-${++this.requestCounter}`;
    const frame = JSON.stringify({ type, payload, id });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${this.label} timed out waiting for ${type}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.socket.send(frame);
    });
  }

  async startFreshSession() {
    const responsePromise = this.request("chat.new", {
      clientKey: this.clientKey,
    }).catch(() => null);
    const sessionPromise = this.waitForSessionId().catch(() => null);
    const first = await Promise.race([
      responsePromise.then((response) => ({ response })),
      sessionPromise.then((sessionId) => ({ sessionId })),
    ]);
    const sessionId =
      first.response?.payload?.sessionId ??
      first.sessionId ??
      this.sessionId ??
      await sessionPromise;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`${this.label} did not receive a session id`);
    }
    this.sessionId = sessionId;
    return sessionId;
  }

  async runPrompt(content, timeoutMs) {
    await this.connect();
    if (!this.sessionId) {
      await this.startFreshSession();
    }

    if (this.turnState && !this.turnState.done) {
      throw new Error(`${this.label} already has an active turn`);
    }

    const requestId = `chat-message-${this.label}-${++this.requestCounter}`;
    const startedAt = Date.now();
    const turnPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.turnState || this.turnState.done) {
          return;
        }
        this.turnState.done = true;
        reject(new Error(`${this.label} turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.turnState = {
        requestId,
        startedAt,
        done: false,
        events: [],
        resolve,
        reject,
        timeout,
      };
    });

    this.socket.send(
      JSON.stringify({
        type: "chat.message",
        id: requestId,
        payload: {
          clientKey: this.clientKey,
          content,
        },
      }),
    );

    const result = await turnPromise;
    this.turnState = null;
    return {
      startedAt,
      completedAt: Date.now(),
      ...result,
    };
  }

  close() {
    this.rejectSessionWaiters(new Error(`${this.label} websocket closed`));
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
  }

  waitForSessionId() {
    if (typeof this.sessionId === "string" && this.sessionId.length > 0) {
      return Promise.resolve(this.sessionId);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.sessionWaiters = this.sessionWaiters.filter(
          (entry) => entry.timeout !== timeout,
        );
        reject(new Error(`${this.label} timed out waiting for chat.session`));
      }, this.requestTimeoutMs);
      this.sessionWaiters.push({ resolve, reject, timeout });
    });
  }

  resolveSessionWaiters(sessionId) {
    const waiters = this.sessionWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(sessionId);
    }
  }

  rejectSessionWaiters(error) {
    const waiters = this.sessionWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

function buildScenario(runToken) {
  return [
    {
      phase: 1,
      actor: "agent-1",
      runToken,
      sentinel: "A1_R1_DONE",
      expectations: {
        toolSequence: [
          "social.sendMessage",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-2", "agent-3", "agent-4"],
        minimumIncomingMessages: 0,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.sendMessage\` exactly 3 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`.\n` +
        "Recipients and themes:\n" +
        "- `agent-2`: throughput + backpressure\n" +
        "- `agent-3`: reputation gates + abuse resistance\n" +
        "- `agent-4`: restart/recovery + message durability\n" +
        "Each message must be under 220 chars, start with the run token, include one concrete question, and ask the peer to answer agent-1 plus one other peer.\n" +
        "After the tool calls, reply with exactly `A1_R1_DONE`.",
    },
    {
      phase: 2,
      actor: "agent-2",
      runToken,
      sentinel: "A2_R2_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-3"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 12, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1`\n" +
        "- one to `agent-3`\n" +
        "Each message must mention one concrete point from your inbox, add one new mitigation, and keep the conversation focused on scalable social throughput.\n" +
        "After the tool calls, reply with exactly `A2_R2_DONE`.",
    },
    {
      phase: 2,
      actor: "agent-3",
      runToken,
      sentinel: "A3_R2_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-4"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 12, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1`\n" +
        "- one to `agent-4`\n" +
        "Each message must cite one inbox detail, add one abuse/safety concern, and propose one concrete instrumentation or policy response.\n" +
        "After the tool calls, reply with exactly `A3_R2_DONE`.",
    },
    {
      phase: 2,
      actor: "agent-4",
      runToken,
      sentinel: "A4_R2_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-2"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 12, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1`\n" +
        "- one to `agent-2`\n" +
        "Each message must cite one inbox detail, add one resilience/restart concern, and propose one concrete recovery or replay safeguard.\n" +
        "After the tool calls, reply with exactly `A4_R2_DONE`.",
    },
    {
      phase: 3,
      actor: "agent-1",
      runToken,
      sentinel: "A1_R3_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-2", "agent-3", "agent-4"],
        minimumIncomingMessages: 3,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 3 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\` for \`agent-2\`, \`agent-3\`, and \`agent-4\`.\n` +
        "Each message must synthesize one concrete point from that peer's latest reply, name one tradeoff, and ask for a final decision or counterargument.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
    },
    {
      phase: 4,
      actor: "agent-2",
      runToken,
      sentinel: "A2_R4_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-4"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1` with your final decision\n" +
        "- one to `agent-4` with one challenge or agreement\n" +
        "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
        "After the tool calls, reply with exactly `A2_R4_DONE`.",
    },
    {
      phase: 4,
      actor: "agent-3",
      runToken,
      sentinel: "A3_R4_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-2"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1` with your final decision\n" +
        "- one to `agent-2` with one challenge or agreement\n" +
        "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
        "After the tool calls, reply with exactly `A3_R4_DONE`.",
    },
    {
      phase: 4,
      actor: "agent-4",
      runToken,
      sentinel: "A4_R4_DONE",
      expectations: {
        toolSequence: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.sendMessage",
        ],
        sendRecipients: ["agent-1", "agent-3"],
        minimumIncomingMessages: 1,
      },
      prompt:
        `Run token: ${runToken}.\n` +
        `Use \`social.getRecentMessages\` first with \`{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"${runToken}\" }\`.\n` +
        `Then use \`social.sendMessage\` exactly 2 times in \`off-chain\` mode with \`threadId\` set to \`${runToken}\`:\n` +
        "- one to `agent-1` with your final decision\n" +
        "- one to `agent-3` with one challenge or agreement\n" +
        "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
        "After the tool calls, reply with exactly `A4_R4_DONE`.",
    },
  ];
}

function summarizeTurnResult(turn, result) {
  const toolCalls = buildToolCalls(result.events);
  const toolNames = toolCalls.map((call) => call.toolName);
  const socialMessages = result.events
    .filter((event) => event.type === "social.message")
    .map((event) => event.payload ?? null)
    .filter(Boolean);
  const validation = validateTurnExecution(turn, {
    toolCalls,
  });

  return {
    phase: turn.phase,
    actor: turn.actor,
    runToken: turn.runToken,
    sentinel: turn.sentinel,
    prompt: turn.prompt,
    startedAt: new Date(result.startedAt).toISOString(),
    completedAt: new Date(result.completedAt).toISOString(),
    durationMs: result.completedAt - result.startedAt,
    reply: result.reply,
    sentinelMatched: result.reply.trim() === turn.sentinel,
    toolNames,
    toolCalls,
    validation,
    socialMessages,
    eventCount: result.events.length,
  };
}

function buildSentinelMismatchFailure(turn, summaryResult) {
  return {
    phase: turn.phase,
    actor: turn.actor,
    sentinel: turn.sentinel,
    prompt: turn.prompt,
    error: `Sentinel mismatch: expected ${turn.sentinel} but got ${summaryResult.reply}`,
    reply: summaryResult.reply,
    toolNames: summaryResult.toolNames,
    eventCount: summaryResult.eventCount,
  };
}

function groupTurnsByPhase(scenario) {
  const phases = new Map();
  for (const turn of scenario) {
    const turns = phases.get(turn.phase) ?? [];
    turns.push(turn);
    phases.set(turn.phase, turns);
  }
  return Array.from(phases.entries())
    .sort(([left], [right]) => left - right)
    .map(([, turns]) => turns);
}

async function initializeClient(client, connectRetries) {
  let lastError = null;
  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      logProgress(`${client.label}: connect attempt ${attempt}/${connectRetries}`);
      await client.connect();
      const sessionId = await client.startFreshSession();
      logProgress(`${client.label}: session ready ${sessionId}`);
      return;
    } catch (error) {
      lastError = error;
      logProgress(
        `${client.label}: bootstrap attempt ${attempt} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      client.close();
      if (attempt < connectRetries) {
        await sleep(1_000 * attempt);
      }
    }
  }
  throw lastError ?? new Error(`${client.label} failed to initialize`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = JSON.parse(
    await readFile(options.summaryPath, "utf8"),
  );
  const reportDir = path.join(path.dirname(options.summaryPath), "reports");
  await mkdir(reportDir, { recursive: true });

  const clients = new Map();
  for (const agent of summary.agents) {
    clients.set(
      agent.label,
      new GatewayTurnClient({
        label: agent.label,
        gatewayPort: agent.gatewayPort,
        clientKey: `social-soak-${options.runToken}-${agent.label}-${randomUUID()}`,
        requestTimeoutMs: options.requestTimeoutMs,
      }),
    );
  }

  const results = [];
  const failures = [];
  const startedAt = new Date().toISOString();

  try {
    await waitForAllAgentRuntimesReady(summary.agents, {
      timeoutMs: options.startupTimeoutMs,
      onProgress: logProgress,
    });

    for (const client of clients.values()) {
      await initializeClient(client, options.connectRetries);
    }

    const scenario = buildScenario(options.runToken).map((turn, index) => ({
      ...turn,
      order: index,
    }));
    for (const phaseTurns of groupTurnsByPhase(scenario)) {
      const phase = phaseTurns[0]?.phase ?? 0;
      logProgress(
        `phase ${phase}: starting ${phaseTurns.map((turn) => turn.sentinel).join(", ")}`,
      );

      const phaseOutcomes = await Promise.all(
        phaseTurns.map(async (turn) => {
          const client = clients.get(turn.actor);
          if (!client) {
            throw new Error(`Missing client for ${turn.actor}`);
          }

          try {
            logProgress(`${turn.actor}: starting ${turn.sentinel}`);
            const result = await client.runPrompt(
              turn.prompt,
              options.turnTimeoutMs,
            );
            const summaryResult = summarizeTurnResult(turn, result);
            logProgress(
              `${turn.actor}: completed ${turn.sentinel} reply=${summaryResult.reply}`,
            );
            return {
              kind: "result",
              order: turn.order,
              turn,
              summaryResult,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logProgress(`${turn.actor}: failed ${turn.sentinel}: ${message}`);
            return {
              kind: "failure",
              order: turn.order,
              failure: {
                phase: turn.phase,
                actor: turn.actor,
                sentinel: turn.sentinel,
                prompt: turn.prompt,
                error: message,
              },
            };
          }
        }),
      );

      let shouldStop = false;
      for (const outcome of phaseOutcomes) {
        if (outcome.kind === "result") {
          const resultEntry = { ...outcome.summaryResult, order: outcome.order };
          results.push(resultEntry);
          if (!outcome.summaryResult.sentinelMatched) {
            failures.push({
              ...buildSentinelMismatchFailure(outcome.turn, outcome.summaryResult),
              order: outcome.order,
            });
            logProgress(
              `${outcome.turn.actor}: sentinel mismatch expected=${outcome.turn.sentinel} actual=${outcome.summaryResult.reply}`,
            );
            if (!options.continueOnError) {
              shouldStop = true;
            }
          }
          if (!outcome.summaryResult.validation.ok) {
            failures.push({
              phase: outcome.turn.phase,
              actor: outcome.turn.actor,
              sentinel: outcome.turn.sentinel,
              prompt: outcome.turn.prompt,
              error: `Execution validation failed: ${outcome.summaryResult.validation.issues.join("; ")}`,
              reply: outcome.summaryResult.reply,
              toolNames: outcome.summaryResult.toolNames,
              eventCount: outcome.summaryResult.eventCount,
              validation: outcome.summaryResult.validation,
            });
            logProgress(
              `${outcome.turn.actor}: execution validation failed ${outcome.summaryResult.validation.issues.join(" | ")}`,
            );
            if (!options.continueOnError) {
              shouldStop = true;
            }
          }
          continue;
        }

        failures.push({ ...outcome.failure, order: outcome.order });
        if (!options.continueOnError) {
          shouldStop = true;
        }
      }

      if (shouldStop) {
        break;
      }

      await sleep(options.interTurnMs);
    }
  } finally {
    for (const client of clients.values()) {
      client.close();
    }
  }

  const socialEvents = Object.fromEntries(
    Array.from(clients.entries()).map(([label, client]) => [
      label,
      client.socialEvents,
    ]),
  );
  const orderedResults = results
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...result }) => result);
  const orderedFailures = failures
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...failure }) => failure);
  const report = {
    status: orderedFailures.length === 0 ? "ok" : orderedResults.length > 0 ? "partial" : "failed",
    runToken: options.runToken,
    startedAt,
    finishedAt: new Date().toISOString(),
    summaryPath: options.summaryPath,
    turnCount: orderedResults.length,
    failureCount: orderedFailures.length,
    results: orderedResults,
    failures: orderedFailures,
    socialEvents,
  };

  const reportPath = path.join(reportDir, `${options.runToken}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  logProgress(
    `report written ${reportPath} status=${report.status} failures=${report.failureCount}`,
  );
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
