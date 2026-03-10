import { describe, expect, it } from "vitest";

import {
  assessPlannerDecision,
  buildPlannerMessages,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  salvagePlannerToolCallsAsPlan,
  validateExplicitDeterministicToolRequirements,
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

  it("extracts repeated deterministic tool counts and exact final literals from soak-style prompts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310a.\n" +
        "Use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "Recipients and themes:\n" +
        "- `agent-2`: throughput + backpressure\n" +
        "- `agent-3`: reputation gates + abuse resistance\n" +
        "- `agent-4`: restart/recovery + message durability\n" +
        "After the tool calls, reply with exactly `A1_R1_DONE`.",
      ["social.sendMessage"],
    );

    expect(requirements).toEqual({
      orderedToolNames: ["social.sendMessage"],
      minimumToolCallsByName: { "social.sendMessage": 3 },
      forcePlanner: true,
      exactResponseLiteral: "A1_R1_DONE",
    });
  });

  it("adds first-pass planner guidance for explicit deterministic tool contracts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const messages = buildPlannerMessages(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      [],
      256,
      requirements,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "The user supplied an explicit deterministic tool contract for this turn.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Use only these tools in this order: social.getRecentMessages -> social.sendMessage x3.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "do not emit `subagent_task` steps",
          ),
        }),
      ]),
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

  it("rejects planner plans that drift outside explicit deterministic social tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "read_tagged_message",
            stepType: "subagent_task",
            dependsOn: ["get_incoming_msgs"],
            objective: "Read the newest tagged message through email tools.",
            inputContract: "Return the exact tagged content",
            acceptanceCriteria: ["Message read"],
            requiredToolCapabilities: ["system.emailMessageInfo"],
            contextRequirements: ["get_incoming_msgs"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: ["read_tagged_message"],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_subagent_forbidden",
        }),
      ]),
    );
  });

  it("requires dependency gating between explicitly ordered deterministic tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_followup",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply"],
            tool: "social.sendMessage",
            args: { recipient: "agent-b", content: "followup", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_dependency_mismatch",
        }),
      ]),
    );
  });

  it("requires enough repeated deterministic calls for explicitly repeated tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.sendMessage exactly 3 times in off-chain mode. After the tool calls, reply with exactly DONE.",
      ["social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "send_reply_a",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_reply_b",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply_a"],
            tool: "social.sendMessage",
            args: {
              recipient: "agent-b",
              content: "followup",
              mode: "off-chain",
            },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_insufficient_tool_calls",
        }),
      ]),
    );
  });
});
