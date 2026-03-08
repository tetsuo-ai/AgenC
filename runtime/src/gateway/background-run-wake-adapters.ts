import { timingSafeEqual } from "node:crypto";

import type { DesktopBridgeEvent } from "../desktop/rest-bridge.js";
import {
  didToolCallFail,
  parseToolResultObject,
} from "../llm/chat-executor-tool-utils.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { BackgroundRunSupervisor } from "./background-run-supervisor.js";
import type { HookHandler } from "./hooks.js";
import type { WebhookRequest, WebhookResponse, WebhookRoute } from "./webhooks.js";

export interface BackgroundRunWakeSignalDescriptor {
  readonly type: "tool_result" | "process_exit" | "external_event" | "webhook";
  readonly content: string;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunToolResultPayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly durationMs: number;
  readonly toolCallId?: string;
  readonly backgroundRunId?: string;
}

export interface BackgroundRunWebhookPayload {
  readonly sessionId: string;
  readonly content: string;
  readonly eventId?: string;
  readonly source?: string;
  readonly data?: Record<string, unknown>;
}

export interface CreateBackgroundRunToolAfterHookOptions {
  readonly getSupervisor: () => Pick<
    BackgroundRunSupervisor,
    "hasActiveRun" | "signalRun"
  > | null;
  readonly logger?: Logger;
}

export interface CreateBackgroundRunWebhookRouteOptions {
  readonly getSupervisor: () => Pick<
    BackgroundRunSupervisor,
    "hasActiveRun" | "signalRun"
  > | null;
  readonly authSecret?: string;
  readonly logger?: Logger;
}

const MAX_CONTENT_CHARS = 240;
const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function truncate(text: string, maxChars = MAX_CONTENT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractPath(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) return direct;
  const obj = asObject(value);
  if (!obj) return undefined;
  return (
    asTrimmedString(obj.path) ??
    asTrimmedString(obj.filePath) ??
    asTrimmedString(obj.logPath) ??
    asTrimmedString(obj.outputPath) ??
    asTrimmedString(obj.downloadPath) ??
    asTrimmedString(obj.uploadPath) ??
    asTrimmedString(obj.destination)
  );
}

function extractUrl(
  args: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): string | undefined {
  return (
    asTrimmedString(args.url) ??
    asTrimmedString(parsed?.url) ??
    asTrimmedString(parsed?.finalUrl)
  );
}

function extractToolResultError(parsed: Record<string, unknown> | null): string | undefined {
  return (
    asTrimmedString(parsed?.error) ??
    asTrimmedString(parsed?.stderr) ??
    asTrimmedString(parsed?.message)
  );
}

function isBrowserTool(toolName: string): boolean {
  return (
    toolName.startsWith("mcp.browser.") ||
    toolName.startsWith("playwright.") ||
    toolName === "system.browse" ||
    toolName === "system.extractLinks" ||
    toolName === "system.browserAction" ||
    toolName === "system.browserSessionStart" ||
    toolName === "system.browserSessionStatus" ||
    toolName === "system.browserSessionResume" ||
    toolName === "system.browserSessionStop" ||
    toolName === "system.browserSessionArtifacts" ||
    toolName === "system.evaluateJs" ||
    toolName === "system.exportPdf" ||
    toolName === "system.screenshot"
  );
}

function isFilesystemTool(toolName: string): boolean {
  return (
    toolName === "system.readFile" ||
    toolName === "system.writeFile" ||
    toolName === "system.appendFile" ||
    toolName === "system.listDir" ||
    toolName === "system.stat" ||
    toolName === "system.mkdir" ||
    toolName === "system.delete" ||
    toolName === "system.move" ||
    toolName === "desktop.text_editor"
  );
}

function isManagedProcessTool(toolName: string): boolean {
  return (
    toolName === "desktop.process_start" ||
    toolName === "desktop.process_status" ||
    toolName === "desktop.process_stop" ||
    toolName === "system.processStart" ||
    toolName === "system.processStatus" ||
    toolName === "system.processResume" ||
    toolName === "system.processStop" ||
    toolName === "system.processLogs"
  );
}

function isHttpHealthTool(toolName: string): boolean {
  return (
    toolName === "system.httpGet" ||
    toolName === "system.httpPost" ||
    toolName === "system.httpFetch"
  );
}

function buildManagedProcessToolSignal(
  payload: BackgroundRunToolResultPayload,
  parsed: Record<string, unknown> | null,
  failed: boolean,
): BackgroundRunWakeSignalDescriptor {
  const processId = asTrimmedString(parsed?.processId);
  const label = asTrimmedString(parsed?.label);
  const state = asTrimmedString(parsed?.state);
  const errorText = extractToolResultError(parsed);
  const content = failed
    ? truncate(
        `Managed process tool ${payload.toolName} failed` +
          (errorText ? `: ${errorText}` : "."),
      )
    : truncate(
        `Managed process ${label ? `"${label}" ` : ""}${processId ? `(${processId}) ` : ""}` +
          `reported ${state ?? "an updated state"} via ${payload.toolName}.`,
      );
  return {
    type: "tool_result",
    content,
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "managed_process",
      failed,
      durationMs: payload.durationMs,
      ...(processId ? { processId } : {}),
      ...(label ? { label } : {}),
      ...(state ? { state } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function buildBrowserToolSignal(
  payload: BackgroundRunToolResultPayload,
  parsed: Record<string, unknown> | null,
  failed: boolean,
): BackgroundRunWakeSignalDescriptor {
  const url = extractUrl(payload.args, parsed);
  const title = asTrimmedString(parsed?.title);
  const artifactPath =
    extractPath(parsed?.artifact) ??
    extractPath(parsed?.output) ??
    extractPath(parsed);
  const errorText = extractToolResultError(parsed);
  const lowerName = payload.toolName.toLowerCase();
  let content: string;
  if (failed) {
    content =
      `Browser tool ${payload.toolName} failed` +
      (errorText ? `: ${errorText}` : ".");
  } else if (lowerName.includes("download")) {
    content =
      `Browser download completed` +
      (artifactPath ? ` at ${artifactPath}.` : ".");
  } else if (lowerName.includes("upload")) {
    content =
      `Browser upload completed` +
      (artifactPath ? ` from ${artifactPath}.` : ".");
  } else if (
    lowerName.includes("navigate") ||
    payload.toolName === "system.browse"
  ) {
    content =
      `Browser navigation completed` +
      (url ? ` for ${url}.` : ".");
  } else {
    content =
      `Browser page state changed via ${payload.toolName}` +
      (url ? ` (${url})` : "") +
      ".";
  }

  return {
    type: "tool_result",
    content: truncate(content),
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "browser",
      failed,
      durationMs: payload.durationMs,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function buildFilesystemToolSignal(
  payload: BackgroundRunToolResultPayload,
  parsed: Record<string, unknown> | null,
  failed: boolean,
): BackgroundRunWakeSignalDescriptor {
  const path =
    extractPath(payload.args.path) ??
    extractPath(payload.args.destination) ??
    extractPath(payload.args.filePath) ??
    extractPath(parsed?.path) ??
    extractPath(parsed?.destination);
  const destination =
    extractPath(payload.args.destination) ?? extractPath(parsed?.destination);
  const errorText = extractToolResultError(parsed);
  let content: string;
  if (failed) {
    content =
      `Filesystem tool ${payload.toolName} failed` +
      (errorText ? `: ${errorText}` : ".");
  } else if (payload.toolName === "system.move" && path && destination) {
    content = `Filesystem change observed: moved ${path} to ${destination}.`;
  } else {
    content =
      `Filesystem change observed via ${payload.toolName}` +
      (path ? ` at ${path}` : "") +
      ".";
  }
  return {
    type: "tool_result",
    content: truncate(content),
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "filesystem",
      failed,
      durationMs: payload.durationMs,
      ...(path ? { path } : {}),
      ...(destination ? { destination } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function buildHealthToolSignal(
  payload: BackgroundRunToolResultPayload,
  parsed: Record<string, unknown> | null,
  failed: boolean,
): BackgroundRunWakeSignalDescriptor {
  const state = asTrimmedString(parsed?.state);
  const url = extractUrl(payload.args, parsed);
  const status =
    typeof parsed?.status === "number"
      ? parsed.status
      : typeof parsed?.statusCode === "number"
        ? parsed.statusCode
        : undefined;
  const processId = asTrimmedString(parsed?.processId);
  const errorText = extractToolResultError(parsed);
  let content: string;
  if (failed) {
    content =
      `Health check via ${payload.toolName} failed` +
      (errorText ? `: ${errorText}` : ".");
  } else if (typeof status === "number") {
    content =
      `Server health transition observed via ${payload.toolName}: HTTP ${status}` +
      (url ? ` for ${url}` : "") +
      ".";
  } else {
    content =
      `Service state observed via ${payload.toolName}: ${state ?? "updated"}` +
      (processId ? ` (${processId})` : "") +
      ".";
  }
  return {
    type: "tool_result",
    content: truncate(content),
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "health",
      failed,
      durationMs: payload.durationMs,
      ...(state ? { state } : {}),
      ...(typeof status === "number" ? { status } : {}),
      ...(url ? { url } : {}),
      ...(processId ? { processId } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function buildMcpToolSignal(
  payload: BackgroundRunToolResultPayload,
  parsed: Record<string, unknown> | null,
  failed: boolean,
): BackgroundRunWakeSignalDescriptor {
  const errorText = extractToolResultError(parsed);
  const serverName = payload.toolName.split(".")[1];
  const jobId =
    asTrimmedString(parsed?.jobId) ??
    asTrimmedString(parsed?.taskId) ??
    asTrimmedString(parsed?.runId);
  const state = asTrimmedString(parsed?.state);
  const status =
    typeof parsed?.status === "number"
      ? parsed.status
      : typeof parsed?.statusCode === "number"
        ? parsed.statusCode
        : undefined;
  const content = failed
    ? `MCP tool ${payload.toolName} failed` +
      (errorText ? `: ${errorText}` : ".")
    : `MCP event observed from ${serverName ?? payload.toolName}` +
      (jobId ? ` (${jobId})` : "") +
      ".";
  return {
    type: "tool_result",
    content: truncate(content),
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "mcp",
      failed,
      durationMs: payload.durationMs,
      ...(serverName ? { serverName } : {}),
      ...(jobId ? { jobId } : {}),
      ...(state ? { state } : {}),
      ...(typeof status === "number" ? { status } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function buildGenericToolSignal(
  payload: BackgroundRunToolResultPayload,
  failed: boolean,
  parsed: Record<string, unknown> | null,
): BackgroundRunWakeSignalDescriptor {
  const errorText = extractToolResultError(parsed);
  const path =
    extractPath(payload.args.path) ??
    extractPath(payload.args.filePath) ??
    extractPath(parsed?.path);
  const destination =
    extractPath(payload.args.destination) ?? extractPath(parsed?.destination);
  const command = asTrimmedString(payload.args.command);
  return {
    type: "tool_result",
    content: truncate(
      failed
        ? `Tool ${payload.toolName} failed` +
            (errorText ? `: ${errorText}` : ".")
        : `Tool result observed for ${payload.toolName}.`,
    ),
    data: {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      category: "generic",
      failed,
      durationMs: payload.durationMs,
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(destination ? { destination } : {}),
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

function describeDesktopEvent(eventType: string, payload: Record<string, unknown>): string {
  if (eventType.startsWith("browser.download")) {
    const path = extractPath(payload);
    return `Browser download completed${path ? ` at ${path}` : ""}.`;
  }
  if (eventType.startsWith("browser.upload")) {
    const path = extractPath(payload);
    return `Browser upload completed${path ? ` from ${path}` : ""}.`;
  }
  if (eventType.startsWith("browser.")) {
    const url =
      asTrimmedString(payload.url) ?? asTrimmedString(payload.pageUrl);
    const title = asTrimmedString(payload.title);
    return (
      `Browser page state changed` +
      (url ? ` for ${url}` : "") +
      (title ? ` (${title})` : "") +
      "."
    );
  }
  if (eventType.startsWith("filesystem.")) {
    const path = extractPath(payload);
    return `Filesystem watcher event ${eventType}${path ? ` at ${path}` : ""}.`;
  }
  if (eventType.startsWith("socket.") || eventType.startsWith("server.")) {
    const target =
      asTrimmedString(payload.target) ??
      asTrimmedString(payload.host) ??
      asTrimmedString(payload.url);
    const state =
      asTrimmedString(payload.state) ??
      asTrimmedString(payload.status);
    return (
      `Service health event ${eventType}` +
      (target ? ` for ${target}` : "") +
      (state ? ` (${state})` : "") +
      "."
    );
  }
  if (eventType.startsWith("mcp.")) {
    const serverName =
      asTrimmedString(payload.serverName) ??
      asTrimmedString(payload.source);
    const eventName = asTrimmedString(payload.eventName);
    return (
      `External MCP event observed` +
      (serverName ? ` from ${serverName}` : "") +
      (eventName ? ` (${eventName})` : "") +
      "."
    );
  }
  return `Desktop event observed: ${eventType}`;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return typeof value === "string" && LOOPBACK_REMOTE_ADDRESSES.has(value);
}

function secretsMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function extractWebhookToken(headers: Readonly<Record<string, string>>): string | undefined {
  const bearer = asTrimmedString(headers.authorization);
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    return bearer.slice("bearer ".length).trim();
  }
  return asTrimmedString(headers["x-agenc-webhook-token"]);
}

function parseBackgroundRunWebhookPayload(
  body: unknown,
): { payload?: BackgroundRunWebhookPayload; error?: string } {
  const record = asObject(body);
  if (!record) {
    return { error: "Webhook body must be a JSON object." };
  }
  const sessionId = asTrimmedString(record.sessionId);
  if (!sessionId) {
    return { error: "Webhook body must include a non-empty sessionId." };
  }
  const content =
    asTrimmedString(record.content) ??
    asTrimmedString(record.summary) ??
    asTrimmedString(record.message);
  if (!content) {
    return { error: "Webhook body must include non-empty content." };
  }
  const source = asTrimmedString(record.source);
  const eventId = asTrimmedString(record.eventId);
  const data = asObject(record.data);
  return {
    payload: {
      sessionId,
      content,
      ...(eventId ? { eventId } : {}),
      ...(source ? { source } : {}),
      ...(data ? { data } : {}),
    },
  };
}

export function mapDesktopBridgeEventTypeToWebChatEvent(type: string): string {
  if (type === "managed_process.exited") {
    return "desktop.process.exited";
  }
  return `desktop.${type.replace(/_/g, ".")}`;
}

export function buildBackgroundRunSignalFromDesktopEvent(
  event: DesktopBridgeEvent,
): BackgroundRunWakeSignalDescriptor | undefined {
  if (event.type === "managed_process.exited") {
    const processId =
      asTrimmedString(event.payload.processId) ?? "unknown-process";
    const label = asTrimmedString(event.payload.label);
    const exitCode =
      typeof event.payload.exitCode === "number"
        ? `exitCode=${event.payload.exitCode}`
        : undefined;
    const signal = asTrimmedString(event.payload.signal);
    const signalDetail = signal ? `signal=${signal}` : undefined;
    const status = [exitCode, signalDetail].filter(Boolean).join(", ");
    return {
      type: "process_exit",
      content: truncate(
        `Managed process ${label ? `"${label}" ` : ""}(${processId}) exited` +
          (status ? ` (${status}).` : "."),
      ),
      data: {
        processId,
        ...(label ? { label } : {}),
        ...(typeof event.payload.pid === "number" ? { pid: event.payload.pid } : {}),
        ...(typeof event.payload.pgid === "number" ? { pgid: event.payload.pgid } : {}),
        ...(typeof event.payload.startedAt === "number"
          ? { startedAt: event.payload.startedAt }
          : {}),
        ...(typeof event.payload.endedAt === "number"
          ? { endedAt: event.payload.endedAt }
          : {}),
        ...(typeof event.payload.exitCode === "number" || event.payload.exitCode === null
          ? { exitCode: event.payload.exitCode }
          : {}),
        ...(typeof event.payload.signal === "string" || event.payload.signal === null
          ? { signal: event.payload.signal }
          : {}),
        ...(typeof event.payload.logPath === "string" ? { logPath: event.payload.logPath } : {}),
      },
    };
  }

  return {
    type: "external_event",
    content: truncate(describeDesktopEvent(event.type, event.payload)),
    data: {
      eventType: event.type,
      ...event.payload,
    },
  };
}

export function buildBackgroundRunSignalFromToolResult(
  payload: BackgroundRunToolResultPayload,
): BackgroundRunWakeSignalDescriptor | undefined {
  if (payload.backgroundRunId) {
    return undefined;
  }
  if (!payload.toolName.trim() || !payload.sessionId.trim()) {
    return undefined;
  }

  const parsed = parseToolResultObject(payload.result);
  const failed = didToolCallFail(false, payload.result);

  if (isManagedProcessTool(payload.toolName)) {
    return buildManagedProcessToolSignal(payload, parsed, failed);
  }
  if (isBrowserTool(payload.toolName)) {
    return buildBrowserToolSignal(payload, parsed, failed);
  }
  if (isFilesystemTool(payload.toolName)) {
    return buildFilesystemToolSignal(payload, parsed, failed);
  }
  if (isHttpHealthTool(payload.toolName)) {
    return buildHealthToolSignal(payload, parsed, failed);
  }
  if (payload.toolName.startsWith("mcp.")) {
    return buildMcpToolSignal(payload, parsed, failed);
  }
  return buildGenericToolSignal(payload, failed, parsed);
}

export function createBackgroundRunToolAfterHook(
  options: CreateBackgroundRunToolAfterHookOptions,
): HookHandler {
  const logger = options.logger ?? silentLogger;
  return {
    event: "tool:after",
    name: "background-run-tool-result-adapter",
    handler: async (context) => {
      const sessionId = asTrimmedString(context.payload.sessionId);
      const toolName = asTrimmedString(context.payload.toolName);
      const result = typeof context.payload.result === "string" ? context.payload.result : undefined;
      const args = asObject(context.payload.args);
      if (!sessionId || !toolName || !result || !args) {
        return { continue: true };
      }

      const supervisor = options.getSupervisor();
      if (!supervisor?.hasActiveRun(sessionId)) {
        return { continue: true };
      }

      const signal = buildBackgroundRunSignalFromToolResult({
        sessionId,
        toolName,
        args,
        result,
        durationMs:
          typeof context.payload.durationMs === "number"
            ? context.payload.durationMs
            : 0,
        toolCallId: asTrimmedString(context.payload.toolCallId),
        backgroundRunId: asTrimmedString(context.payload.backgroundRunId),
      });
      if (!signal) {
        return { continue: true };
      }

      try {
        await supervisor.signalRun({
          sessionId,
          type: signal.type,
          content: signal.content,
          data: signal.data,
        });
      } catch (error) {
        logger.debug("Failed to signal background run from tool result", {
          sessionId,
          toolName,
          error: toErrorMessage(error),
        });
      }

      return { continue: true };
    },
  };
}

export function createBackgroundRunWebhookRoute(
  options: CreateBackgroundRunWebhookRouteOptions,
): WebhookRoute {
  const logger = options.logger ?? silentLogger;
  return {
    method: "POST",
    path: "/webhooks/background-run",
    handler: async (request: WebhookRequest): Promise<WebhookResponse> => {
      if (options.authSecret) {
        const providedToken = extractWebhookToken(request.headers);
        if (!secretsMatch(options.authSecret, providedToken)) {
          return {
            status: 401,
            body: { error: "Webhook authentication failed." },
          };
        }
      } else if (!isLoopbackRemoteAddress(request.remoteAddress)) {
        return {
          status: 403,
          body: { error: "Webhook ingress requires loopback access or auth.secret." },
        };
      }

      const parsed = parseBackgroundRunWebhookPayload(request.body);
      if (parsed.error) {
        return { status: 400, body: { error: parsed.error } };
      }

      const payload = parsed.payload!;
      const supervisor = options.getSupervisor();
      if (!supervisor?.hasActiveRun(payload.sessionId)) {
        return {
          status: 404,
          body: { error: "No active background run for this session." },
        };
      }

      const content = payload.source
        ? `Webhook event from ${payload.source}: ${payload.content}`
        : payload.content;
      const data: Record<string, unknown> = {
        ...(payload.eventId ? { eventId: payload.eventId } : {}),
        ...(payload.source ? { source: payload.source } : {}),
        ...(payload.data ? payload.data : {}),
      };

      try {
        await supervisor.signalRun({
          sessionId: payload.sessionId,
          type: "webhook",
          content,
          data,
        });
      } catch (error) {
        logger.debug("Failed to signal background run from webhook ingress", {
          sessionId: payload.sessionId,
          error: toErrorMessage(error),
        });
        return {
          status: 500,
          body: { error: "Failed to enqueue webhook wake event." },
        };
      }

      return {
        status: 202,
        body: {
          accepted: true,
          sessionId: payload.sessionId,
        },
      };
    },
  };
}
