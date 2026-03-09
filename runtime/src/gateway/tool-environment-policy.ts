/**
 * Shared tool-environment filtering helpers.
 *
 * Desktop-only mode excludes raw host-mutation tools like `system.bash`, but it
 * keeps the structured durable-handle families available so the runtime can
 * still supervise long-lived host resources deterministically.
 * Host-only mode excludes desktop/container surfaces instead.
 *
 * @module
 */

import type { LLMTool } from "../llm/types.js";

export type ToolEnvironmentMode = "both" | "desktop" | "host";

const HOST_TOOL_PREFIX = "system.";
const DESKTOP_ALLOWED_HOST_TOOL_PREFIXES = [
  "system.process",
  "system.server",
  "system.browserSession",
  "system.browserTransfer",
  "system.remoteJob",
  "system.research",
  "system.sandbox",
  "system.sqlite",
  "system.pdf",
  "system.spreadsheet",
  "system.officeDocument",
  "system.emailMessage",
  "system.calendar",
] as const;
const DESKTOP_TOOL_PREFIXES = [
  "desktop.",
  "playwright.",
  "mcp.tmux.",
  "mcp.neovim.",
  "mcp.kitty.",
  "mcp.browser.",
] as const;

function isDesktopScopedToolName(name: string): boolean {
  return DESKTOP_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isStructuredHostControlToolName(name: string): boolean {
  return DESKTOP_ALLOWED_HOST_TOOL_PREFIXES.some((prefix) =>
    name.startsWith(prefix)
  );
}

export function isToolAllowedForEnvironment(
  toolName: string,
  environment: ToolEnvironmentMode,
): boolean {
  if (environment === "both") return true;
  if (environment === "desktop") {
    return (
      !toolName.startsWith(HOST_TOOL_PREFIX) ||
      isStructuredHostControlToolName(toolName)
    );
  }
  return !isDesktopScopedToolName(toolName);
}

export function filterToolNamesByEnvironment(
  toolNames: readonly string[],
  environment: ToolEnvironmentMode,
): string[] {
  return toolNames.filter((toolName) =>
    isToolAllowedForEnvironment(toolName, environment)
  );
}

export function filterNamedToolsByEnvironment<T extends { readonly name: string }>(
  tools: readonly T[],
  environment: ToolEnvironmentMode,
): T[] {
  return tools.filter((tool) =>
    isToolAllowedForEnvironment(tool.name, environment)
  );
}

export function filterLlmToolsByEnvironment(
  tools: readonly LLMTool[],
  environment: ToolEnvironmentMode,
): LLMTool[] {
  return tools.filter((tool) =>
    isToolAllowedForEnvironment(tool.function.name, environment)
  );
}
