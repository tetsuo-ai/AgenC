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

// ============================================================================
// Types for REST API responses
// ============================================================================

interface RESTToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  logger?: Logger;
}

export class DesktopRESTBridge {
  private readonly baseUrl: string;
  private readonly containerId: string;
  private readonly logger: Logger;
  private connected = false;
  private tools: Tool[] = [];

  constructor(options: DesktopRESTBridgeOptions) {
    this.baseUrl = `http://localhost:${options.apiHostPort}`;
    this.containerId = options.containerId;
    this.logger = options.logger ?? silentLogger;
  }

  /** Fetch tool definitions from the container and create bridged Tool objects. */
  async connect(): Promise<void> {
    await this.fetchJsonOrThrow<unknown>(
      `${this.baseUrl}/health`,
      "Health check failed",
    );

    const definitions = await this.fetchJsonOrThrow<RESTToolDefinition[]>(
      `${this.baseUrl}/tools`,
      "Failed to fetch tool definitions",
    );

    this.tools = definitions.map((def) => this.createBridgedTool(def));
    this.connected = true;

    this.logger.info(
      `Desktop REST bridge connected to ${this.containerId} (${this.tools.length} tools)`,
    );
  }

  /** Mark bridge as disconnected. */
  disconnect(): void {
    this.connected = false;
    this.tools = [];
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
            headers: { "Content-Type": "application/json" },
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
}
