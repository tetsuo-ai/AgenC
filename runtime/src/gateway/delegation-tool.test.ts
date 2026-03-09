import { describe, expect, it } from "vitest";
import {
  createExecuteWithAgentTool,
  EXECUTE_WITH_AGENT_TOOL_NAME,
  parseExecuteWithAgentInput,
} from "./delegation-tool.js";

describe("delegation-tool", () => {
  it("parses execute_with_agent input with task and scoped options", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect runtime planner flow",
      tools: ["system.readFile", "system.readFile", " system.listDir "],
      requiredToolCapabilities: ["system.readFile", "system.listDir"],
      timeoutMs: 25_000,
      acceptanceCriteria: ["return findings", "include one risk"],
      spawnDecisionScore: 0.77,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("inspect runtime planner flow");
    expect(parsed.value.tools).toEqual(["system.readFile", "system.listDir"]);
    expect(parsed.value.requiredToolCapabilities).toEqual([
      "system.readFile",
      "system.listDir",
    ]);
    expect(parsed.value.timeoutMs).toBe(25_000);
    expect(parsed.value.acceptanceCriteria).toEqual([
      "return findings",
      "include one risk",
    ]);
    expect(parsed.value.spawnDecisionScore).toBe(0.77);
  });

  it("accepts objective as task fallback", () => {
    const parsed = parseExecuteWithAgentInput({
      objective: "compare three modules",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("compare three modules");
    expect(parsed.value.objective).toBe("compare three modules");
  });

  it("preserves explicit task scope when task and objective are both provided", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "Inspect docs/RUNTIME_API.md sections 4b and 8",
      objective: "Extract one autonomy-validation risk with a direct reference",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("Inspect docs/RUNTIME_API.md sections 4b and 8");
    expect(parsed.value.objective).toBe(
      "Extract one autonomy-validation risk with a direct reference",
    );
  });

  it("rejects missing task/objective", () => {
    const parsed = parseExecuteWithAgentInput({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("non-empty");
  });

  it("creates a canonical execute_with_agent tool definition", async () => {
    const tool = createExecuteWithAgentTool();
    expect(tool.name).toBe(EXECUTE_WITH_AGENT_TOOL_NAME);
    const direct = await tool.execute({ task: "do work" });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("session-scoped tool handler");
  });
});
