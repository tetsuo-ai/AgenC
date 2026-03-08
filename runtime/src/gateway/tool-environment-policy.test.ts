import { describe, expect, it } from "vitest";
import type { LLMTool } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import {
  filterLlmToolsByEnvironment,
  filterNamedToolsByEnvironment,
  filterToolNamesByEnvironment,
  isToolAllowedForEnvironment,
} from "./tool-environment-policy.js";

function makeLlmTool(name: string): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object" },
    },
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    execute: async () => ({ content: "{}" }),
  };
}

describe("tool-environment-policy", () => {
  it("treats all system.* tools as host-only in desktop mode", () => {
    expect(isToolAllowedForEnvironment("system.bash", "desktop")).toBe(false);
    expect(isToolAllowedForEnvironment("system.open", "desktop")).toBe(false);
    expect(
      isToolAllowedForEnvironment("system.browserSessionStart", "desktop"),
    ).toBe(false);
    expect(isToolAllowedForEnvironment("execute_with_agent", "desktop")).toBe(
      true,
    );
  });

  it("keeps host-scoped browser session tools available outside desktop-only mode", () => {
    expect(isToolAllowedForEnvironment("system.browserSessionStart", "host")).toBe(true);
    expect(isToolAllowedForEnvironment("system.browserSessionStart", "both")).toBe(true);
    expect(isToolAllowedForEnvironment("mcp.browser.browser_navigate", "host")).toBe(false);
    expect(isToolAllowedForEnvironment("mcp.browser.browser_navigate", "both")).toBe(true);
  });

  it("filters llm tools for desktop-only mode", () => {
    const filtered = filterLlmToolsByEnvironment([
      makeLlmTool("system.bash"),
      makeLlmTool("desktop.bash"),
      makeLlmTool("playwright.browser_navigate"),
      makeLlmTool("execute_with_agent"),
    ], "desktop");

    expect(filtered.map((tool) => tool.function.name)).toEqual([
      "desktop.bash",
      "playwright.browser_navigate",
      "execute_with_agent",
    ]);
  });

  it("filters registry tools for host-only mode", () => {
    const filtered = filterNamedToolsByEnvironment([
      makeTool("system.bash"),
      makeTool("desktop.bash"),
      makeTool("mcp.browser.browser_snapshot"),
      makeTool("execute_with_agent"),
    ], "host");

    expect(filtered.map((tool) => tool.name)).toEqual([
      "system.bash",
      "execute_with_agent",
    ]);
  });

  it("filters plain tool-name allowlists", () => {
    expect(
      filterToolNamesByEnvironment([
        "system.bash",
        "desktop.bash",
        "mcp.browser.browser_snapshot",
        "execute_with_agent",
      ], "desktop"),
    ).toEqual([
      "desktop.bash",
      "mcp.browser.browser_snapshot",
      "execute_with_agent",
    ]);
  });
});
