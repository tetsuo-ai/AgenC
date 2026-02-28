import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import { LLMMessageValidationError } from "./errors.js";
import {
  findToolTurnValidationIssue,
  validateToolTurnSequence,
} from "./tool-turn-validator.js";

describe("tool-turn validator", () => {
  it("accepts a valid assistant tool_calls -> tool results sequence", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "run test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "desktop.bash", arguments: '{"command":"echo hi"}' },
          { id: "call_2", name: "desktop.bash", arguments: '{"command":"pwd"}' },
        ],
      },
      {
        role: "tool",
        content: '{"stdout":"hi\\n","exitCode":0}',
        toolCallId: "call_2",
      },
      {
        role: "tool",
        content: '{"stdout":"/tmp\\n","exitCode":0}',
        toolCallId: "call_1",
      },
      { role: "assistant", content: "done" },
    ];

    expect(() => validateToolTurnSequence(messages)).not.toThrow();
    expect(findToolTurnValidationIssue(messages)).toBeNull();
  });

  it("rejects one malformed pair (assistant without tool_calls + tool)", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "test" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"stdout":"","exitCode":0}', toolCallId: "call_1" },
    ];

    expect(() => validateToolTurnSequence(messages, { providerName: "grok" })).toThrow(
      LLMMessageValidationError,
    );

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "tool_result_without_assistant_call",
      index: 3,
    });
  });

  it("rejects two malformed pairs and fails fast at first invalid pair", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "test" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"stdout":"","exitCode":0}', toolCallId: "call_1" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"stdout":"","exitCode":0}', toolCallId: "call_2" },
    ];

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "tool_result_without_assistant_call",
      index: 2,
    });
  });

  it("rejects mixed valid/invalid sequence", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "step 1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "desktop.bash", arguments: '{"command":"echo ok"}' }],
      },
      { role: "tool", content: '{"stdout":"ok\\n","exitCode":0}', toolCallId: "call_1" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"stdout":"","exitCode":0}', toolCallId: "call_2" },
    ];

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "tool_result_without_assistant_call",
      index: 4,
    });
  });

  it("rejects duplicate tool_call ids declared by assistant", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "desktop.bash", arguments: '{}' },
          { id: "call_1", name: "desktop.bash", arguments: '{}' },
        ],
      },
    ];

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "assistant_tool_call_id_duplicate",
      index: 1,
    });
  });

  it("rejects non-tool messages while tool results are still pending", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "desktop.bash", arguments: '{}' }],
      },
      { role: "assistant", content: "done" },
    ];

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "tool_result_missing",
      index: 2,
    });
  });

  it("rejects duplicate tool result messages for the same toolCallId", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "desktop.bash", arguments: '{}' }],
      },
      { role: "tool", content: '{"stdout":"ok","exitCode":0}', toolCallId: "call_1" },
      { role: "tool", content: '{"stdout":"ok","exitCode":0}', toolCallId: "call_1" },
    ];

    const issue = findToolTurnValidationIssue(messages);
    expect(issue).toMatchObject({
      code: "tool_result_duplicate",
      index: 3,
    });
  });
});
