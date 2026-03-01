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
  makeTool("system.readFile", "Read a file"),
  makeTool("system.writeFile", "Write a file"),
  makeTool("system.listDir", "List files in directory"),
  makeTool("system.httpGet", "HTTP GET request"),
  makeTool("desktop.click", "Click on screen"),
  makeTool("desktop.type", "Type into focused element"),
  makeTool("playwright.browser_navigate", "Navigate browser to a URL"),
  makeTool("playwright.browser_click", "Click browser element"),
  makeTool("agenc.createTask", "Create on-chain task"),
  makeTool("agenc.getTask", "Read task details"),
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
    expect(decision.routedToolNames.length).toBeLessThan(TOOLS.length);
    expect(decision.expandedToolNames.length).toBeGreaterThanOrEqual(
      decision.routedToolNames.length,
    );
    expect(decision.diagnostics.schemaCharsSaved).toBeGreaterThan(0);
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
});
