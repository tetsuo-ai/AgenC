/**
 * DesktopRESTBridge — connects to the in-container REST API and exposes
 * desktop tools as runtime Tool objects.
 *
 * Each tool is namespaced as "desktop.{name}" (e.g. desktop.screenshot).
 * Uses fetch() (Node.js 18+ built-in) — no new dependencies.
 */

import { createHash } from "node:crypto";
import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import { createDesktopAuthHeaders } from "./auth.js";
import { DesktopSandboxConnectionError } from "./errors.js";

// ============================================================================
// Constants
// ============================================================================

/** Timeout for health check and tool-list fetch during connect(). */
const CONNECT_TIMEOUT_MS = 5_000;
/** Default timeout for individual tool execution calls. */
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 180_000;
/** Hard cap for individual tool execution calls (matches container bash upper bound + slack). */
const MAX_TOOL_EXECUTION_TIMEOUT_MS = 660_000;
const EVENT_STREAM_RETRY_INITIAL_MS = 500;
const EVENT_STREAM_RETRY_MAX_MS = 5_000;

// ============================================================================
// Types for REST API responses
// ============================================================================

interface RESTToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DesktopHealthResponse {
  readonly status: "ok";
  readonly display?: string;
  readonly uptime?: number;
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string | null;
  readonly features?: readonly string[];
}

const REQUIRED_DESKTOP_SERVER_FEATURES = ["foreground_bash_cwd"] as const;

export interface DesktopBridgeEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}

function resolveToolExecutionTimeoutMs(args: Record<string, unknown>): number {
  const requestedTimeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? Math.floor(args.timeoutMs)
      : undefined;
  if (requestedTimeoutMs === undefined || requestedTimeoutMs <= 0) {
    return DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  }
  // Add a small transport cushion over the command timeout.
  const withBuffer = requestedTimeoutMs + 15_000;
  return Math.min(MAX_TOOL_EXECUTION_TIMEOUT_MS, withBuffer);
}

// ============================================================================
// Bridge
// ============================================================================

export interface DesktopRESTBridgeOptions {
  apiHostPort: number;
  containerId: string;
  authToken: string;
  logger?: Logger;
  onEvent?: (event: DesktopBridgeEvent) => void | Promise<void>;
}

export class DesktopRESTBridge {
  private readonly baseUrl: string;
  private readonly containerId: string;
  private readonly authToken: string;
  private readonly logger: Logger;
  private readonly onEvent?: (event: DesktopBridgeEvent) => void | Promise<void>;
  private connected = false;
  private tools: Tool[] = [];
  private eventStreamAbort: AbortController | null = null;
  private eventStreamLoop: Promise<void> | null = null;

  constructor(options: DesktopRESTBridgeOptions) {
    this.baseUrl = `http://localhost:${options.apiHostPort}`;
    this.containerId = options.containerId;
    this.authToken = options.authToken;
    this.logger = options.logger ?? silentLogger;
    this.onEvent = options.onEvent;
  }

  /** Fetch tool definitions from the container and create bridged Tool objects. */
  async connect(): Promise<void> {
    const health = await this.fetchJsonOrThrow<DesktopHealthResponse>(
      `${this.baseUrl}/health`,
      "Health check failed",
    );

    const features = Array.isArray(health.features)
      ? health.features.filter((value): value is string => typeof value === "string")
      : [];
    const missingFeatures = REQUIRED_DESKTOP_SERVER_FEATURES.filter((feature) =>
      !features.includes(feature)
    );
    if (missingFeatures.length > 0) {
      this.logger.warn?.(
        `Desktop REST bridge ${this.containerId} is connected to a server missing required features: ${missingFeatures.join(", ")}. ` +
        "This usually means the desktop image is stale and may ignore requested cwd values for desktop.bash.",
      );
    }

    const definitions = await this.fetchJsonOrThrow<RESTToolDefinition[]>(
      `${this.baseUrl}/tools`,
      "Failed to fetch tool definitions",
    );

    this.tools = definitions.map((def) => this.createBridgedTool(def));
    this.connected = true;
    this.startEventStream();

    this.logger.info(
      `Desktop REST bridge connected to ${this.containerId} (${this.tools.length} tools, cwd=${health.workingDirectory ?? "unknown"}, workspace=${health.workspaceRoot ?? "none"}, features=${features.length > 0 ? features.join(",") : "none"})`,
    );
  }

  /** Mark bridge as disconnected. */
  disconnect(): void {
    this.connected = false;
    this.tools = [];
    this.stopEventStream();
  }

  /** Whether the bridge is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Return the bridged Tool array. Empty if disconnected. */
  getTools(): readonly Tool[] {
    return this.connected ? this.tools : [];
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Fetch JSON from a URL, wrapping failures as DesktopSandboxConnectionError. */
  private async fetchJsonOrThrow<T>(url: string, context: string): Promise<T> {
    try {
      const res = await fetch(url, {
        headers: createDesktopAuthHeaders(this.authToken),
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      throw new DesktopSandboxConnectionError(
        this.containerId,
        `${context}: ${toErrorMessage(err)}`,
      );
    }
  }

  private createBridgedTool(def: RESTToolDefinition): Tool {
    const name = `desktop.${def.name}`;
    const baseUrl = this.baseUrl;
    const authToken = this.authToken;
    const containerId = this.containerId;
    const logger = this.logger;
    const bridgeRef = this;

    return {
      name,
      description: def.description,
      inputSchema: def.inputSchema,
      async execute(
        args: Record<string, unknown>,
      ): Promise<ToolResult> {
        try {
          const timeoutMs = resolveToolExecutionTimeoutMs(args);
          const res = await fetch(`${baseUrl}/tools/${def.name}`, {
            method: "POST",
            headers: createDesktopAuthHeaders(authToken, {
              "Content-Type": "application/json",
            }),
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(timeoutMs),
          });

          const raw = await res.json() as Record<string, unknown>;

          // The container returns a ToolResult wrapper: { content: '{"image":"..."}' }
          // Unwrap the inner content if it's a JSON string.
          let inner: Record<string, unknown>;
          if (typeof raw.content === "string") {
            try {
              const parsed = JSON.parse(raw.content) as unknown;
              inner = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : { result: raw.content };
            } catch {
              inner = { result: raw.content };
            }
          } else {
            inner = raw;
          }

          // Special handling for screenshot — keep raw image out-of-band.
          if (
            def.name === "screenshot" &&
            typeof inner.image === "string"
          ) {
            const { image, ...rest } = inner;
            const imageBuffer = Buffer.from(image, "base64");
            const digest = createHash("sha256").update(imageBuffer).digest("hex");
            return {
              content: safeStringify({
                ...rest,
                imageDigest: `sha256:${digest}`,
                imageBytes: imageBuffer.byteLength,
                imageMimeType: "image/png",
                artifactExternalized: true,
              }),
            };
          }

          return {
            content: safeStringify(inner),
            isError: raw.isError === true,
          };
        } catch (err) {
          // Network-level failures usually mean the container API is unhealthy.
          // Mark disconnected so callers can recycle/reconnect the bridge.
          bridgeRef.connected = false;
          bridgeRef.stopEventStream();
          logger.error(
            `Desktop tool ${name} failed [${containerId}]: ${toErrorMessage(err)}`,
          );
          return {
            content: safeStringify({
              error: `Tool execution failed: ${toErrorMessage(err)}`,
            }),
            isError: true,
          };
        }
      },
    };
  }

  private startEventStream(): void {
    if (!this.onEvent || this.eventStreamLoop || !this.connected) {
      return;
    }

    const controller = new AbortController();
    this.eventStreamAbort = controller;
    this.eventStreamLoop = this.runEventStreamLoop(controller).finally(() => {
      if (this.eventStreamAbort === controller) {
        this.eventStreamAbort = null;
      }
      if (this.eventStreamLoop !== null) {
        this.eventStreamLoop = null;
      }
    });
  }

  private stopEventStream(): void {
    this.eventStreamAbort?.abort();
    this.eventStreamAbort = null;
    this.eventStreamLoop = null;
  }

  private async runEventStreamLoop(controller: AbortController): Promise<void> {
    let retryDelayMs = EVENT_STREAM_RETRY_INITIAL_MS;
    while (this.connected && !controller.signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/events`, {
          headers: createDesktopAuthHeaders(this.authToken),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error("Event stream body missing");
        }

        retryDelayMs = EVENT_STREAM_RETRY_INITIAL_MS;
        await this.consumeEventStream(res.body, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || !this.connected) {
          return;
        }
        this.logger.debug("Desktop event stream disconnected", {
          containerId: this.containerId,
          error: toErrorMessage(error),
        });
        await this.sleepWithAbort(retryDelayMs, controller.signal);
        retryDelayMs = Math.min(
          EVENT_STREAM_RETRY_MAX_MS,
          retryDelayMs * 2,
        );
      }
    }
  }

  private async consumeEventStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        ({ buffer } = await this.drainEventBuffer(buffer));
      }
      buffer += decoder.decode();
      await this.drainEventBuffer(buffer, true);
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  private async drainEventBuffer(
    buffer: string,
    flushRemainder = false,
  ): Promise<{ buffer: string }> {
    let nextBuffer = buffer;
    while (true) {
      const separatorIndex = nextBuffer.indexOf("\n\n");
      if (separatorIndex < 0) {
        if (flushRemainder && nextBuffer.trim().length > 0) {
          await this.handleEventChunk(nextBuffer);
          nextBuffer = "";
        }
        return { buffer: nextBuffer };
      }
      const chunk = nextBuffer.slice(0, separatorIndex);
      nextBuffer = nextBuffer.slice(separatorIndex + 2);
      await this.handleEventChunk(chunk);
    }
  }

  private async handleEventChunk(chunk: string): Promise<void> {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !line.startsWith(":"));
    if (lines.length === 0) return;

    let eventType = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0 || !this.onEvent) {
      return;
    }

    try {
      const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      const timestamp =
        typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      const payload =
        parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
          ? parsed.payload as Record<string, unknown>
          : {};
      await this.onEvent({
        type:
          typeof parsed.type === "string" && parsed.type.trim().length > 0
            ? parsed.type
            : eventType,
        timestamp,
        payload,
      });
    } catch (error) {
      this.logger.debug("Failed to parse desktop event stream payload", {
        containerId: this.containerId,
        error: toErrorMessage(error),
        chunk,
      });
    }
  }

  private async sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
