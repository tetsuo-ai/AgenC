/**
 * macOS native automation tools.
 *
 * Provides AppleScript, JXA (JavaScript for Automation), `open`, and
 * notification tools. Only available on macOS (`process.platform === 'darwin'`).
 *
 * Security: Denies Keychain access patterns and admin shell scripts.
 * Uses `execFile` (no shell injection).
 *
 * Follows the same `Tool` interface as `createBashTool` so tools can be
 * registered directly with `ToolRegistry.registerAll()`.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "../types.js";
import type { Logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Security patterns
// ============================================================================

const DENIED_PATTERNS = [
  /keychain/i,
  /security\s+(find|delete|add|dump)/i,
  /do\s+shell\s+script.*with\s+administrator/i,
  /System\s+Events.*keystroke/i,
  /delete\s+every/i,
];

function isDenied(script: string): string | null {
  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(script)) {
      return `Script denied: matches security pattern ${pattern.source}`;
    }
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

const MAX_OUTPUT_LENGTH = 8192;
const EXEC_TIMEOUT_MS = 30_000;

function errorResult(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function successResult(data: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify(data) };
}

// ============================================================================
// Config
// ============================================================================

export interface MacOSToolsConfig {
  logger?: Logger;
  /** Max execution time in ms (default: 30000). */
  timeoutMs?: number;
}

// ============================================================================
// Tool factories
// ============================================================================

function createAppleScriptTool(timeout: number): Tool {
  return {
    name: "system.applescript",
    description:
      "Execute an AppleScript script on macOS. Can automate apps, control system settings, show dialogs, etc. " +
      "Keychain access and admin shell scripts are blocked for security.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "AppleScript source code to execute" },
      },
      required: ["script"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const script = String(args.script ?? "");
      if (!script.trim()) return errorResult("Empty script");

      const denied = isDenied(script);
      if (denied) return errorResult(denied);

      try {
        const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
          timeout,
          maxBuffer: MAX_OUTPUT_LENGTH * 2,
        });
        const out = (stdout || "").slice(0, MAX_OUTPUT_LENGTH);
        const err = (stderr || "").slice(0, 1024);
        return successResult({ output: out, ...(err ? { stderr: err } : {}) });
      } catch (error) {
        return errorResult((error as Error).message);
      }
    },
  };
}

function createJXATool(timeout: number): Tool {
  return {
    name: "system.jxa",
    description:
      "Execute a JXA (JavaScript for Automation) script on macOS. " +
      "JXA provides JavaScript access to macOS automation APIs (equivalent to AppleScript but in JS).",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JXA JavaScript source code to execute" },
      },
      required: ["script"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const script = String(args.script ?? "");
      if (!script.trim()) return errorResult("Empty script");

      const denied = isDenied(script);
      if (denied) return errorResult(denied);

      try {
        const { stdout, stderr } = await execFileAsync(
          "osascript",
          ["-l", "JavaScript", "-e", script],
          { timeout, maxBuffer: MAX_OUTPUT_LENGTH * 2 },
        );
        const out = (stdout || "").slice(0, MAX_OUTPUT_LENGTH);
        const err = (stderr || "").slice(0, 1024);
        return successResult({ output: out, ...(err ? { stderr: err } : {}) });
      } catch (error) {
        return errorResult((error as Error).message);
      }
    },
  };
}

function createOpenTool(timeout: number): Tool {
  return {
    name: "system.open",
    description:
      "Open a file, URL, or application on macOS using the `open` command. " +
      "Can optionally specify which application to use.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path, URL, or application name to open" },
        application: { type: "string", description: "Application to open the target with (optional)" },
      },
      required: ["target"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.target ?? "");
      if (!target.trim()) return errorResult("Empty target");

      const execArgs = [target];
      if (args.application) {
        execArgs.unshift("-a", String(args.application));
      }

      try {
        const { stdout } = await execFileAsync("open", execArgs, { timeout });
        return successResult({ success: true, output: stdout || "" });
      } catch (error) {
        return errorResult((error as Error).message);
      }
    },
  };
}

function createNotificationTool(): Tool {
  return {
    name: "system.notification",
    description:
      "Show a macOS notification with a title and message. Optionally plays a sound.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body text" },
        sound: { type: "string", description: "Sound name (e.g. 'Glass', 'Ping', 'Pop'). Omit for silent." },
      },
      required: ["title", "message"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const title = String(args.title ?? "").replace(/"/g, '\\"');
      const message = String(args.message ?? "").replace(/"/g, '\\"');
      if (!title || !message) return errorResult("Title and message are required");

      const soundClause = args.sound
        ? ` sound name "${String(args.sound).replace(/"/g, '\\"')}"`
        : "";
      const script = `display notification "${message}" with title "${title}"${soundClause}`;

      try {
        await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
        return successResult({ success: true });
      } catch (error) {
        return errorResult((error as Error).message);
      }
    },
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create macOS automation tools. Returns empty array on non-Darwin platforms.
 *
 * Returns `Tool[]` compatible with `ToolRegistry.registerAll()`.
 */
export function createMacOSTools(config: MacOSToolsConfig = {}): Tool[] {
  if (process.platform !== "darwin") return [];

  const timeout = config.timeoutMs ?? EXEC_TIMEOUT_MS;

  return [
    createAppleScriptTool(timeout),
    createJXATool(timeout),
    createOpenTool(timeout),
    createNotificationTool(),
  ];
}
