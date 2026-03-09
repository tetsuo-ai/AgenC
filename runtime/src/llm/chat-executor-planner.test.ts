import { describe, expect, it } from "vitest";

import {
  assessPlannerDecision,
  extractExplicitSubagentOrchestrationRequirements,
  salvagePlannerToolCallsAsPlan,
} from "./chat-executor-planner.js";

describe("chat-executor-planner explicit orchestration requirements", () => {
  it("treats execute_with_agent child-memory prompts as planner-worthy delegation turns", () => {
    const decision = assessPlannerDecision(
      true,
      "LIVE-ENDURANCE-R7 C1. Use execute_with_agent for this exact task. In the child agent, memorize token ONYX-SHARD-58 for later recall and answer exactly CHILD-STORED-R7-C1. Return exactly the child answer.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("delegation_cue");
  });

  it("extracts required subagent steps from the compact 'plan required' prompt shape", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Subagent context audit SG3. Sub-agent orchestration plan required: " +
        "1. recover_marker: recover the earlier continuity marker from parent conversation context only; do not invent missing facts. " +
        "2. echo_marker: using desktop.bash, run /usr/bin/printf so it prints the recovered marker exactly once. " +
        "Final deliverables: recovered marker, printed output, known limitations.",
    );

    expect(requirements).toBeDefined();
    expect(requirements?.stepNames).toEqual([
      "recover_marker",
      "echo_marker",
    ]);
    expect(requirements?.requiresSynthesis).toBe(true);
    expect(requirements?.steps[0]?.description).toContain(
      "recover the earlier continuity marker",
    );
  });

  it("salvages direct planner tool calls into deterministic steps", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        }),
      },
    ]);

    expect(result.plan).toBeDefined();
    expect(result.plan?.reason).toBe("planner_tool_call_salvaged");
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "execute_with_agent",
        args: {
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: "parse",
        code: "planner_tool_call_salvaged",
      }),
    ]);
  });
});
