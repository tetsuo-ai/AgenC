import { describe, expect, it } from "vitest";
import type {
  PipelinePlannerContext,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { PlannerSubAgentTaskStepIntent } from "./chat-executor-types.js";
import { evaluateSubagentDeterministicChecks } from "./chat-executor-verifier.js";

function createStep(
  overrides: Partial<PlannerSubAgentTaskStepIntent> = {},
): PlannerSubAgentTaskStepIntent {
  return {
    name: "delegate_logs",
    stepType: "subagent_task",
    objective: "Analyze logs",
    inputContract: "Return JSON object with findings",
    acceptanceCriteria: ["Exactly 3 references with valid URLs"],
    requiredToolCapabilities: ["system.readFile"],
    contextRequirements: ["logs"],
    maxBudgetHint: "2m",
    canRunParallel: true,
    ...overrides,
  };
}

function createPipelineResult(
  raw: string,
  stepName = "delegate_logs",
): PipelineResult {
  return {
    status: "completed",
    context: {
      results: {
        [stepName]: raw,
      },
    },
    completedSteps: 1,
    totalSteps: 1,
  };
}

function createPlannerContext(): PipelinePlannerContext {
  return {
    parentRequest: "analyze the logs",
    history: [],
    memory: [],
    toolOutputs: [],
  };
}

describe("evaluateSubagentDeterministicChecks", () => {
  it("treats numeric toolCalls counts as evidence of tool execution", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep({
        acceptanceCriteria: ["Include findings and evidence"],
      })],
      createPipelineResult(
        '{"success":true,"status":"completed","output":"{\\"findings\\":[{\\"summary\\":\\"error line 42\\"}]}","toolCalls":2}',
      ),
      createPlannerContext(),
    );

    expect(decision.steps[0]?.issues).not.toContain(
      "missing_tool_result_consistency_signal",
    );
  });

  it("marks acceptance-count contract mismatches for retry", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep()],
      createPipelineResult(
        '{"success":true,"status":"completed","output":"{\\"references\\":[{\\"url\\":\\"a\\"},{\\"url\\":\\"b\\"},{\\"url\\":\\"c\\"},{\\"url\\":\\"d\\"}]}","toolCalls":1}',
      ),
      createPlannerContext(),
    );

    expect(decision.overall).toBe("retry");
    expect(decision.steps[0]?.issues).toContain(
      "contract_violation_acceptance_criteria_count",
    );
  });

  it("marks contradictory completion claims for retry", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep({
        name: "add_tests",
        objective:
          "Create Vitest tests that match the implemented CLI and core contracts",
        inputContract: "Core library and CLI already exist",
        acceptanceCriteria: [
          "Tests compile against the current CLI/core APIs",
          "Tests cover requirements",
        ],
      })],
      createPipelineResult(
        '{"success":true,"status":"completed","output":"**add_tests complete**: tests written. Note: some tests may need minor impl tweaks due to code mismatches in cli/GridMap methods like parse/getGoal.","toolCalls":[{"name":"system.writeFile","args":{"path":"/workspace/grid-router-ts/tests/map.test.ts","content":"it(\\"works\\", () => {})"},"result":"{\\"path\\":\\"/workspace/grid-router-ts/tests/map.test.ts\\",\\"bytesWritten\\":24}","isError":false}]}',
        "add_tests",
      ),
      createPlannerContext(),
    );

    expect(decision.overall).toBe("retry");
    expect(decision.steps[0]?.issues).toContain(
      "child_claimed_completion_with_unresolved_work",
    );
  });

  it("marks missing successful tool evidence when every child tool call failed", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep({
        acceptanceCriteria: ["Use official docs"],
      })],
      createPipelineResult(
        '{"success":true,"status":"completed","output":"{\\"selected\\":\\"pixi\\"}","toolCalls":1,"failedToolCalls":1}',
      ),
      createPlannerContext(),
    );

    expect(decision.overall).toBe("retry");
    expect(decision.steps[0]?.issues).toContain(
      "missing_successful_tool_evidence",
    );
  });

  it("marks low-signal browser evidence for retry", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep({
        name: "design_research",
        objective: "Research 3 reference games with browser tools and cite sources",
        inputContract: "Return markdown with 3 cited references and tuning targets",
        acceptanceCriteria: ["Include citations and tuning targets"],
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      })],
      {
        status: "completed",
        context: {
          results: {
            design_research:
              '{"success":true,"status":"completed","output":"Heat Signature; Gunpoint; Monaco","toolCalls":[{"name":"mcp.browser.browser_tabs","args":{"action":"list"},"result":"### Result\\n- 0: (current) [](about:blank)","isError":false}]}',
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      },
      createPlannerContext(),
    );

    expect(decision.overall).toBe("retry");
    expect(decision.steps[0]?.issues).toContain(
      "low_signal_browser_evidence",
    );
  });

  it("accepts provider-native search citations as research evidence", () => {
    const decision = evaluateSubagentDeterministicChecks(
      [createStep({
        name: "tech_research",
        objective:
          "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
        inputContract:
          "Return JSON with selected framework, rationale, and citations",
        acceptanceCriteria: ["Include citations"],
        requiredToolCapabilities: ["web_search"],
      })],
      {
        status: "completed",
        context: {
          results: {
            tech_research:
              '{"success":true,"status":"completed","output":"{\\"selected\\":\\"pixi\\",\\"citations\\":[\\"https://pixijs.com\\",\\"https://docs.phaser.io\\"]}","toolCalls":0,"providerEvidence":{"citations":["https://pixijs.com","https://docs.phaser.io"]}}',
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      },
      createPlannerContext(),
    );

    expect(decision.overall).toBe("pass");
    expect(decision.steps[0]?.issues).not.toContain(
      "missing_successful_tool_evidence",
    );
  });
});
