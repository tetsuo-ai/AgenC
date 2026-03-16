import { describe, expect, it } from "vitest";

import {
  buildToolExecutionGroundingMessage,
  generateFallbackContent,
  reconcileDirectShellObservationContent,
  reconcileExactResponseContract,
  reconcileStructuredToolOutcome,
  reconcileVerifiedFileWorkflowContent,
  reconcileTerminalFailureContent,
  summarizeToolCalls,
} from "./chat-executor-text.js";

describe("chat-executor-text", () => {
  it("builds an authoritative runtime tool ledger with tool calls and provider citations", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [
        {
          name: "desktop.bash",
          args: { command: "mkdir -p /workspace/pong" },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 11,
        },
        {
          name: "execute_with_agent",
          args: { objective: "Research mechanics" },
          result: JSON.stringify({
            success: false,
            error: "Delegated task required browser-grounded evidence",
          }),
          isError: true,
          durationMs: 37,
        },
      ],
      providerEvidence: {
        citations: ["https://docs.x.ai/developers/tools/web-search"],
      },
    });

    expect(message).toBeDefined();
    expect(message?.role).toBe("system");
    expect(String(message?.content)).toContain("Runtime execution ledger");
    expect(String(message?.content)).toContain('"tool":"desktop.bash"');
    expect(String(message?.content)).toContain('"tool":"execute_with_agent"');
    expect(String(message?.content)).toContain('"providerCitations"');
    expect(String(message?.content)).toContain(
      "https://docs.x.ai/developers/tools/web-search",
    );
  });

  it("keeps oversized runtime tool ledgers bounded and marks them truncated", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: Array.from({ length: 30 }, (_, index) => ({
        name: index === 0 ? "execute_with_agent" : "desktop.bash",
        args: {
          command: `echo ${"x".repeat(400)}`,
          index,
        },
        result: JSON.stringify({
          stdout: "y".repeat(4_000),
          stderr: index === 0 ? "delegated child failed" : "",
          exitCode: index === 0 ? 1 : 0,
        }),
        isError: index === 0,
        durationMs: 10 + index,
      })),
    });

    expect(message).toBeDefined();
    expect(String(message?.content).length).toBeLessThanOrEqual(100_000);
    expect(String(message?.content)).toContain('"failedToolNames":["execute_with_agent"]');
  });

  it("replaces unsolicited shell advice with the direct command output for simple successful shell calls", () => {
    const content = reconcileDirectShellObservationContent(
      "Note: `desktop.bash` spawns fresh shells from `/workspace` each time (non-persistent).\n\nTo work in `~` (/home/agenc): Prefix like `cd ~ && your_command`.\n\nDemo:\n```sh\ncd ~ && pwd\n```",
      [
        {
          name: "desktop.bash",
          args: { command: "pwd" },
          result: JSON.stringify({
            stdout: "/workspace\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 7,
        },
      ],
    );

    expect(content).toBe("/workspace");
  });

  it("preserves shell follow-up text that already includes the actual command output", () => {
    const content = reconcileDirectShellObservationContent(
      "Current directory: /workspace",
      [
        {
          name: "desktop.bash",
          args: { command: "pwd" },
          result: JSON.stringify({
            stdout: "/workspace\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 7,
        },
      ],
    );

    expect(content).toBe("Current directory: /workspace");
  });

  it("reconciles verified file workflow output when final synthesis mangles the absolute path", () => {
    const content = reconcileVerifiedFileWorkflowContent(
      "/ tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE",
      [
        {
          name: "desktop.bash",
          args: {
            command: "echo -n 'AUTONOMY_STAGE2::LIVE' > /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::LIVE",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
    );

    expect(content).toBe("/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE");
  });

  it("preserves verified file workflow output when the exact absolute path is already present", () => {
    const content = reconcileVerifiedFileWorkflowContent(
      "/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE",
      [
        {
          name: "desktop.bash",
          args: {
            command: "echo -n 'AUTONOMY_STAGE2::LIVE' > /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::LIVE",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
    );

    expect(content).toBe("/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE");
  });

  it("enforces exact-output contracts when synthesis includes extra verified context", () => {
    const content = reconcileExactResponseContract(
      "/workspace/autonomy_stage2.txt\nAUTONOMY_STAGE2::FILE_OK",
      [
        {
          name: "desktop.bash",
          args: {
            command: "printf 'AUTONOMY_STAGE2::FILE_OK\n' > /workspace/autonomy_stage2.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /workspace/autonomy_stage2.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::FILE_OK\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
      "Create the file, verify it, and finally return exactly AUTONOMY_STAGE2::FILE_OK and nothing else.",
    );

    expect(content).toBe("AUTONOMY_STAGE2::FILE_OK");
  });

  it("enforces quoted exact-output contracts for direct shell observations", () => {
    const content = reconcileExactResponseContract(
      "Current token: AUTONOMY_STAGE0::SMOKE",
      [
        {
          name: "desktop.bash",
          args: { command: "printf 'AUTONOMY_STAGE0::SMOKE\n'" },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE0::SMOKE\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 3,
        },
      ],
      'Reply with exactly "AUTONOMY_STAGE0::SMOKE" and nothing else.',
    );

    expect(content).toBe("AUTONOMY_STAGE0::SMOKE");
  });

  it("preserves unquoted exact-output contracts with delimiters like equals and pipe", () => {
    const content = reconcileExactResponseContract(
      "TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD",
      [],
      "Return exactly TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD with no extra text.",
    );

    expect(content).toBe("TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD");
  });

  it("preserves unquoted exact-output contracts with spaces", () => {
    const content = reconcileExactResponseContract(
      "terminal check complete",
      [],
      "Reply with exactly terminal check complete and nothing else.",
    );

    expect(content).toBe("terminal check complete");
  });

  it("supports answer exactly directives and strips formatting drift", () => {
    const content = reconcileExactResponseContract(
      "**PARENT-STORED-P1**",
      [],
      "Parent endurance P1. Memorize token OBSIDIAN-SIGNAL-61 for later recall and answer exactly PARENT-STORED-P1.",
    );

    expect(content).toBe("PARENT-STORED-P1");
  });

  it("supports exact-as directives for recall prompts", () => {
    const content = reconcileExactResponseContract(
      "**TOKEN=OBSIDIAN-SIGNAL-61**",
      [],
      "After compaction, without extra words return the parent token from P1 exactly as TOKEN=OBSIDIAN-SIGNAL-61.",
    );

    expect(content).toBe("TOKEN=OBSIDIAN-SIGNAL-61");
  });

  it("supports as-literal child-answer directives", () => {
    const content = reconcileExactResponseContract(
      "**TOKEN=ONYX-SHARD-58**",
      [],
      "In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
    );

    expect(content).toBe("TOKEN=ONYX-SHARD-58");
  });

  it("forces literal compliance for exact-response turns when the model only acknowledges", () => {
    const content = reconcileExactResponseContract(
      "Memorized.",
      [],
      "Task: Child endurance F2 exact task\nObjective: In the child agent only, memorize token TOKEN=LUNAR-NOVA-88 for later recall, do not reveal it now, and answer exactly CHILD-STORED-F2.",
      { forceLiteralWhenNoToolEvidence: true },
    );

    expect(content).toBe("CHILD-STORED-F2");
  });

  it("does not force literal compliance over explicit refusal text", () => {
    const content = reconcileExactResponseContract(
      "I cannot comply with that request.",
      [],
      "Reply with exactly ACK and nothing else.",
      { forceLiteralWhenNoToolEvidence: true },
    );

    expect(content).toBe("I cannot comply with that request.");
  });

  it("recovers exact-output contracts from successful delegated child output", () => {
    const content = reconcileExactResponseContract(
      "Completed execute_with_agent",
      [
        {
          name: "execute_with_agent",
          args: {
            task: "Recall the token",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "TOKEN=IVORY-CIRCUIT-92",
            subagentSessionId: "subagent:memory",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 12,
        },
      ],
      "Reply with exactly TOKEN=IVORY-CIRCUIT-92 and nothing else.",
    );

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("overrides exact success sentinels when a tool failed", () => {
    const content = reconcileStructuredToolOutcome(
      "R2_DONE_A2",
      [
        {
          name: "social.requestCollaboration",
          args: {
            title: "Launch Ritual Drill",
          },
          result: JSON.stringify({
            error:
              "Collaboration request failed: Feed post failed: AnchorError thrown in src/instructions/post_to_feed.rs:62. Error Code: InsufficientReputation.",
          }),
          isError: true,
          durationMs: 0,
        },
      ],
      "Use social.requestCollaboration, then after the tool calls finish, reply with exactly R2_DONE_A2.",
    );

    expect(content).toContain(
      "Execution could not be completed due to unresolved tool errors.",
    );
    expect(content).toContain("social.requestCollaboration");
    expect(content).not.toBe("R2_DONE_A2");
  });

  it("overrides paraphrased invocation text when every tool in the turn failed", () => {
    const content = reconcileStructuredToolOutcome(
      "invoke social.requestCollaboration with title is Launch Ritual Drill",
      [
        {
          name: "social.requestCollaboration",
          args: {
            requiredCapabilities: "3",
            maxMembers: 3,
          },
          result: JSON.stringify({
            error: "title must be a non-empty string",
          }),
          isError: true,
          durationMs: 3,
        },
      ],
      "Use social.requestCollaboration with title Launch Ritual Drill, then reply with exactly R5_DONE_A2.",
    );

    expect(content).toContain(
      "Execution could not be completed due to unresolved tool errors.",
    );
    expect(content).toContain("title must be a non-empty string");
    expect(content).not.toContain(
      "invoke social.requestCollaboration with title is Launch Ritual Drill",
    );
  });

  it("restores prefixed exact literals from delegated child recall output", () => {
    const content = reconcileExactResponseContract(
      "ONYX-SHARD-58",
      [
        {
          name: "execute_with_agent",
          args: {
            task: "Return memorized token from C1 without extra words as TOKEN=ONYX-SHARD-58",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "ONYX-SHARD-58",
            subagentSessionId: "subagent:memory",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 12,
        },
      ],
      "Use execute_with_agent for this exact task. In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
    );

    expect(content).toBe("TOKEN=ONYX-SHARD-58");
  });

  it("uses successful delegated child output in fallback summaries", () => {
    const content = summarizeToolCalls([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("propagates delegated child output from generateFallbackContent", () => {
    const content = generateFallbackContent([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("replaces low-information partial timeout completions with a failure fallback", () => {
    const content = reconcileTerminalFailureContent({
      content: "Completed execute_with_agent\nCompleted execute_with_agent",
      stopReason: "timeout",
      stopReasonDetail:
        "Request exceeded end-to-end timeout (600000ms) during planner pipeline execution",
      toolCalls: [
        {
          name: "execute_with_agent",
          args: { task: "core_implementation" },
          result: JSON.stringify({
            error:
              "Delegated task required file creation/edit evidence but child used no file mutation tools",
          }),
          isError: true,
          durationMs: 0,
        },
      ],
    });

    expect(content).toContain("Execution stopped before completion (timeout).");
    expect(content).toContain("execute_with_agent");
    expect(content).not.toContain("Partial response before failure:");
    expect(content).not.toContain("Completed execute_with_agent");
  });
});
