import { describe, it, expect } from "vitest";
import type { LLMTool } from "../llm/types.js";
import { ToolRouter } from "./tool-routing.js";

function makeTool(name: string, description: string): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    },
  };
}

const TOOLS: LLMTool[] = [
  makeTool("system.bash", "Run terminal commands"),
  makeTool("desktop.bash", "Run shell commands in desktop sandbox"),
  makeTool(
    "desktop.process_start",
    "Start a long-running background process with executable plus args and return a stable processId",
  ),
  makeTool(
    "desktop.process_status",
    "Check managed background process status and recent log output",
  ),
  makeTool(
    "desktop.process_stop",
    "Stop a managed background process by processId, label, or pid",
  ),
  makeTool("execute_with_agent", "Delegate a child objective to a subagent"),
  makeTool("system.readFile", "Read a file"),
  makeTool("system.writeFile", "Write a file"),
  makeTool("system.listDir", "List files in directory"),
  makeTool("system.httpGet", "HTTP GET request"),
  makeTool("desktop.click", "Click on screen"),
  makeTool("desktop.type", "Type into focused element"),
  makeTool("playwright.browser_navigate", "Navigate browser to a URL"),
  makeTool("playwright.browser_click", "Click browser element"),
  makeTool("playwright.browser_snapshot", "Read browser page content"),
  makeTool("playwright.browser_tabs", "List open browser tabs"),
  makeTool("agenc.createTask", "Create on-chain task"),
  makeTool("agenc.getTask", "Read task details"),
  makeTool("mcp.doom.start_game", "Start a Doom scenario"),
  makeTool("mcp.doom.stop_game", "Stop the current Doom game"),
  makeTool("mcp.doom.get_state", "Read current Doom state"),
];

const MCP_TERMINAL_TOOLS: LLMTool[] = [
  ...TOOLS,
  makeTool("desktop.window_list", "List desktop windows"),
  makeTool("desktop.window_focus", "Focus a desktop window"),
  makeTool("desktop.keyboard_key", "Press desktop keyboard shortcut"),
  makeTool("mcp.kitty.launch", "Launch kitty terminal window"),
  makeTool("mcp.kitty.close", "Close kitty terminal window"),
  makeTool("mcp.kitty.send_text", "Send text to a kitty instance"),
  makeTool("mcp.tmux.execute-command", "Execute command in tmux session"),
  makeTool("mcp.tmux.list-sessions", "List tmux sessions"),
];

describe("ToolRouter", () => {
  it("returns full toolset when disabled", () => {
    const router = new ToolRouter(TOOLS, { enabled: false });
    const decision = router.route({
      sessionId: "s1",
      messageText: "run ls",
      history: [],
    });

    expect(decision.routedToolNames.length).toBe(TOOLS.length);
    expect(decision.expandedToolNames.length).toBe(TOOLS.length);
    expect(decision.diagnostics.invalidatedReason).toBe("disabled");
  });

  it("routes to a compact subset and keeps mandatory tools pinned", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minToolsPerTurn: 4,
      maxExpandedToolsPerTurn: 10,
    });

    const decision = router.route({
      sessionId: "s2",
      messageText: "open the browser and click the page",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.bash");
    expect(decision.routedToolNames).toContain("desktop.bash");
    expect(decision.routedToolNames).toContain("execute_with_agent");
    expect(decision.routedToolNames.length).toBeLessThan(TOOLS.length);
    expect(decision.expandedToolNames.length).toBeGreaterThanOrEqual(
      decision.routedToolNames.length,
    );
    expect(decision.diagnostics.schemaCharsSaved).toBeGreaterThan(0);
  });

  it("prefers navigation-oriented browser tools over tab state checks", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-browser",
      messageText: "research the website in the browser and inspect the page",
      history: [],
    });

    expect(decision.routedToolNames).toContain("playwright.browser_navigate");
    expect(decision.routedToolNames).toContain("playwright.browser_snapshot");
    const tabIndex = decision.routedToolNames.indexOf("playwright.browser_tabs");
    if (tabIndex >= 0) {
      expect(
        decision.routedToolNames.indexOf("playwright.browser_navigate"),
      ).toBeLessThan(tabIndex);
    }
  });

  it("keeps browser tab tools when the intent explicitly mentions tabs", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-tabs",
      messageText: "list the browser tabs and switch windows",
      history: [],
    });

    expect(decision.routedToolNames).toContain("playwright.browser_tabs");
  });

  it("reuses cached routing decision for similar turns", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minCacheConfidence: 0,
      pivotSimilarityThreshold: 0,
    });

    const first = router.route({
      sessionId: "s3",
      messageText: "read a file and write changes",
      history: [],
    });

    const second = router.route({
      sessionId: "s3",
      messageText: "also read files in this folder",
      history: [],
    });

    expect(second.diagnostics.cacheHit).toBe(true);
    expect(second.routedToolNames).toEqual(first.routedToolNames);
  });

  it("invalidates cached cluster on explicit pivot", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minCacheConfidence: 0,
    });

    router.route({
      sessionId: "s4",
      messageText: "read a file and write changes",
      history: [],
    });

    const next = router.route({
      sessionId: "s4",
      messageText: "instead switch to browser navigation",
      history: [],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("explicit_redirect");
  });

  it("invalidates cached route when explicit tmux intent needs mcp.tmux family", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    const first = router.route({
      sessionId: "s-tmux",
      messageText: "open a kitty terminal and keep using it",
      history: [],
    });
    expect(first.routedToolNames.some((name) => name.startsWith("mcp.kitty."))).toBe(true);
    expect(first.routedToolNames.some((name) => name.startsWith("mcp.tmux."))).toBe(false);

    const second = router.route({
      sessionId: "s-tmux",
      messageText: "in that same terminal start tmux",
      history: [{ role: "user", content: "open a kitty terminal", toolCalls: undefined }],
    });

    expect(second.diagnostics.cacheHit).toBe(false);
    expect(second.diagnostics.invalidatedReason).toBe("missing_required_family");
    expect(second.routedToolNames.some((name) => name.startsWith("mcp.tmux."))).toBe(true);
  });

  it("prefers direct kitty open and close tools for terminal window actions", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    const openDecision = router.route({
      sessionId: "s-kitty-open",
      messageText: "open a terminal",
      history: [],
    });
    const closeDecision = router.route({
      sessionId: "s-kitty-close",
      messageText: "close the terminal",
      history: [],
    });

    expect(openDecision.routedToolNames).toContain("mcp.kitty.launch");
    expect(closeDecision.routedToolNames).toContain("mcp.kitty.close");
    const windowListIndex = closeDecision.routedToolNames.indexOf("desktop.window_list");
    if (windowListIndex >= 0) {
      expect(
        closeDecision.routedToolNames.indexOf("mcp.kitty.close"),
      ).toBeLessThan(windowListIndex);
    }
  });

  it("invalidates cached open-terminal route when the user switches to closing the terminal", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    router.route({
      sessionId: "s-kitty-pivot",
      messageText: "open a terminal",
      history: [],
    });

    const next = router.route({
      sessionId: "s-kitty-pivot",
      messageText: "close the terminal",
      history: [{ role: "user", content: "open a terminal", toolCalls: undefined }],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("terminal_action_shift");
    expect(next.routedToolNames).toContain("mcp.kitty.close");
  });

  it("invalidates cache after repeated routing misses", () => {
    const router = new ToolRouter(TOOLS, {
      minCacheConfidence: 0,
      pivotMissThreshold: 2,
    });

    router.route({
      sessionId: "s5",
      messageText: "read files",
      history: [],
    });

    router.recordOutcome("s5", {
      enabled: true,
      initialToolCount: 4,
      finalToolCount: 8,
      routeMisses: 1,
      expanded: true,
    });
    router.recordOutcome("s5", {
      enabled: true,
      initialToolCount: 4,
      finalToolCount: 8,
      routeMisses: 1,
      expanded: true,
    });

    const next = router.route({
      sessionId: "s5",
      messageText: "read files",
      history: [],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("tool_miss_threshold");
  });

  it("prefers structured desktop process tools for background process workflows", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-process",
      messageText:
        "start a background server, check its status and logs, then stop it when I ask",
      history: [],
    });

    expect(decision.routedToolNames).toContain("desktop.process_start");
    expect(decision.routedToolNames).toContain("desktop.process_status");
    expect(decision.expandedToolNames).toContain("desktop.process_stop");
  });

  it("prefers the Doom MCP stop tool over generic process stop tools", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-doom-stop",
      messageText: "stop Doom now",
      history: [],
    });

    expect(decision.routedToolNames).toContain("mcp.doom.stop_game");
    const doomStopIndex = decision.routedToolNames.indexOf("mcp.doom.stop_game");
    const processStopIndex = decision.routedToolNames.indexOf("desktop.process_stop");
    if (processStopIndex >= 0) {
      expect(doomStopIndex).toBeLessThan(processStopIndex);
    }
  });
});
