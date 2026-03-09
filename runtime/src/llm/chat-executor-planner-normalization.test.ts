import { describe, expect, it } from "vitest";

import { normalizePlannerResponse } from "./chat-executor-planner-normalization.js";

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

describe("chat-executor-planner-normalization", () => {
  it("returns strict planner json plans unchanged", () => {
    const result = normalizePlannerResponse({
      content: safeJson({
        reason: "strict_json",
        steps: [
          {
            name: "delegate",
            step_type: "subagent_task",
            objective: "Investigate issue",
            input_contract: "Return findings",
            acceptance_criteria: ["Return one finding"],
            required_tool_capabilities: ["desktop.bash"],
            context_requirements: ["repo_context"],
            max_budget_hint: "2m",
            can_run_parallel: false,
          },
        ],
      }),
      toolCalls: [],
    });

    expect(result.plan?.reason).toBe("strict_json");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
  });

  it("salvages direct planner tool calls and preserves parse diagnostics", () => {
    const result = normalizePlannerResponse({
      content: "",
      toolCalls: [
        {
          id: "tc-1",
          name: "execute_with_agent",
          arguments: safeJson({
            task: "Return exactly TOKEN=ONYX-SHARD-58",
            objective: "Output exactly TOKEN=ONYX-SHARD-58",
          }),
        },
      ],
    });

    expect(result.plan).toBeDefined();
    expect(result.plan?.reason).toBe("planner_tool_call_salvaged");
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "execute_with_agent",
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: "parse",
        code: "invalid_json",
      }),
      expect.objectContaining({
        category: "parse",
        code: "planner_tool_call_salvaged",
      }),
    ]);
  });

  it("surfaces salvage failures instead of inventing planner steps", () => {
    const result = normalizePlannerResponse({
      content: "",
      toolCalls: [
        {
          id: "tc-1",
          name: "execute_with_agent",
          arguments: "{not-json",
        },
      ],
    });

    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: "parse",
        code: "invalid_json",
      }),
      expect.objectContaining({
        category: "parse",
        code: "invalid_tool_args",
      }),
    ]);
  });
});
