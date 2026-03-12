export const LOW_SIGNAL_BROWSER_TOOL_NAMES = new Set([
  "mcp.browser.browser_tabs",
  "playwright.browser_tabs",
]);

export const HIGH_SIGNAL_BROWSER_TOOL_NAMES = new Set([
  "system.browserAction",
  "system.browserSessionStart",
  "system.browserSessionStatus",
  "system.browserSessionResume",
  "system.browserSessionArtifacts",
  "system.browserSessionStop",
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_click",
  "mcp.browser.browser_type",
  "mcp.browser.browser_wait_for",
  "mcp.browser.browser_run_code",
  "mcp.browser.browser_evaluate",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "playwright.browser_wait_for",
  "playwright.browser_run_code",
  "playwright.browser_evaluate",
]);

export const PRIMARY_BROWSER_START_TOOL_NAMES = new Set([
  "system.browserSessionStart",
  "system.browserAction",
  "mcp.browser.browser_navigate",
  "playwright.browser_navigate",
]);

export const PRIMARY_BROWSER_READ_TOOL_NAMES = new Set([
  "system.browse",
  "system.browserSessionStatus",
  "system.browserSessionArtifacts",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_run_code",
  "mcp.browser.browser_evaluate",
  "playwright.browser_snapshot",
  "playwright.browser_run_code",
  "playwright.browser_evaluate",
]);

export const DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES = new Set([
  "system.browserAction",
  "system.browserSessionStart",
  "system.browserSessionResume",
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_click",
  "mcp.browser.browser_type",
  "mcp.browser.browser_fill_form",
  "mcp.browser.browser_select_option",
  "mcp.browser.browser_hover",
  "mcp.browser.browser_wait_for",
  "mcp.browser.browser_run_code",
  "mcp.browser.browser_evaluate",
  "mcp.browser.browser_network_requests",
  "mcp.browser.browser_console_messages",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "playwright.browser_fill_form",
  "playwright.browser_select_option",
  "playwright.browser_hover",
  "playwright.browser_wait_for",
  "playwright.browser_run_code",
  "playwright.browser_evaluate",
  "playwright.browser_network_requests",
  "playwright.browser_console_messages",
]);

export const DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES = new Set([
  "system.browse",
  ...DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES,
]);

export const PREFERRED_RESEARCH_BROWSER_TOOL_NAMES = new Set([
  "system.browse",
  "system.browserSessionStart",
  "system.browserAction",
  "system.browserSessionResume",
  "system.browserSessionArtifacts",
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_click",
  "mcp.browser.browser_type",
  "mcp.browser.browser_fill_form",
  "mcp.browser.browser_select_option",
  "mcp.browser.browser_hover",
  "mcp.browser.browser_wait_for",
  "mcp.browser.browser_navigate_back",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "playwright.browser_fill_form",
  "playwright.browser_select_option",
  "playwright.browser_hover",
  "playwright.browser_wait_for",
  "playwright.browser_navigate_back",
]);

export const PREFERRED_VALIDATION_BROWSER_TOOL_NAMES = new Set([
  ...PREFERRED_RESEARCH_BROWSER_TOOL_NAMES,
  "system.browserSessionStatus",
  "mcp.browser.browser_console_messages",
  "mcp.browser.browser_network_requests",
  "playwright.browser_console_messages",
  "playwright.browser_network_requests",
]);

export const INITIAL_BROWSER_NAVIGATION_TOOL_NAMES = [
  "system.browserSessionStart",
  "system.browserAction",
  "mcp.browser.browser_navigate",
  "playwright.browser_navigate",
] as const;

export const INITIAL_RESEARCH_TOOL_NAMES = [
  "system.browse",
  ...INITIAL_BROWSER_NAVIGATION_TOOL_NAMES,
] as const;

function normalizeAllowedToolNames(
  toolNames: readonly string[],
): string[] {
  return toolNames
    .filter((toolName): toolName is string => typeof toolName === "string")
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0);
}

function hasAnyToolWithPrefix(
  toolNames: readonly string[],
  prefixes: readonly string[],
): boolean {
  return toolNames.some((toolName) =>
    prefixes.some((prefix) => toolName.startsWith(prefix))
  );
}

export function buildBrowserEvidenceRetryGuidance(
  allowedToolNames: readonly string[],
): string[] {
  const normalized = normalizeAllowedToolNames(allowedToolNames);
  const hasShell =
    normalized.includes("system.bash") || normalized.includes("desktop.bash");
  const hasHostBrowserSessionTools = normalized.some((toolName) =>
    toolName === "system.browse" ||
    toolName === "system.browserAction" ||
    toolName.startsWith("system.browserSession")
  );
  const hasInteractiveBrowserAutomation = hasAnyToolWithPrefix(normalized, [
    "mcp.browser.",
    "playwright.",
  ]);

  const lines = [
    "Use real browser interactions against concrete non-blank URLs or localhost pages. `browser_tabs` or about:blank state checks do not count as evidence.",
  ];

  if (hasInteractiveBrowserAutomation) {
    lines.push(
      "Use allowed browser tools like navigate, snapshot, or run_code on the target page and cite the visited URL in the output.",
    );
    return lines;
  }

  if (hasHostBrowserSessionTools && hasShell) {
    lines.push(
      "For localhost/private/internal targets on the HOST, do not use `system.browse` or `system.browserSession*`; those paths are blocked.",
    );
    lines.push(
      "Use `system.bash` to start/query the local service and run a host-side browser verification command (for example Playwright or Chromium) against `http://127.0.0.1:PORT`, then cite the observed result.",
    );
    return lines;
  }

  if (hasShell) {
    lines.push(
      "If browser tools cannot reach the target, use `system.bash` to start/query the local service and capture host-side verification evidence before answering.",
    );
  } else {
    lines.push(
      "Use the allowed browser tools to navigate to the target page, inspect it, and cite the visited URL in the output.",
    );
  }

  return lines;
}
