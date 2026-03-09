import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  computeReconciliationChain,
  extractCompactionItemRefs,
  extractTraceToolNames,
  toSlimTool,
} from "./adapter-utils.js";

describe("grok adapter utils", () => {
  it("extracts trace tool names from mixed provider tool shapes", () => {
    expect(
      extractTraceToolNames([
        { type: "web_search" },
        { name: "system.bash" },
        {
          type: "function",
          function: {
            name: "desktop.screenshot",
          },
        },
      ]),
    ).toEqual([
      "web_search",
      "system.bash",
      "desktop.screenshot",
    ]);
  });

  it("keeps reconciliation hashes stable across tool-call order changes", () => {
    const first: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "b", name: "system.bash", arguments: "{\"command\":\"pwd\"}" },
          { id: "a", name: "system.bash", arguments: "{\"command\":\"ls\"}" },
        ],
      },
    ];
    const second: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "system.bash", arguments: "{\"command\":\"ls\"}" },
          { id: "b", name: "system.bash", arguments: "{\"command\":\"pwd\"}" },
        ],
      },
    ];

    expect(computeReconciliationChain(first, 8)).toEqual(
      computeReconciliationChain(second, 8),
    );
  });

  it("ignores dynamic system injections when hashing reconciliation state", () => {
    const first: LLMMessage[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const second: LLMMessage[] = [
      { role: "system", content: "base prompt updated" },
      { role: "system", content: "<memory>fresh working summary</memory>" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    expect(computeReconciliationChain(first, 8)).toEqual(
      computeReconciliationChain(second, 8),
    );
  });

  it("keeps recent anchors matchable after the reconciliation window shifts", () => {
    const first: LLMMessage[] = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index}`,
    }));
    const second: LLMMessage[] = [
      ...first,
      { role: "assistant", content: "turn-50" },
      { role: "user", content: "turn-51" },
    ];

    const firstChain = computeReconciliationChain(first, 48);
    const secondChain = computeReconciliationChain(second, 48);

    expect(secondChain.chain).toContain(firstChain.anchorHash);
    expect(firstChain.messageCountUsed).toBe(50);
    expect(secondChain.messageCountUsed).toBe(52);
    expect(firstChain.source).toBe("non_system_messages");
  });

  it("collapses oversized tool schemas to an open object", () => {
    const hugeProperties = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `field_${index}`,
        { type: "string", description: "x".repeat(32) },
      ]),
    );
    const tool: LLMTool = {
      type: "function",
      function: {
        name: "system.bash",
        description: "y".repeat(400),
        parameters: {
          type: "object",
          properties: hugeProperties,
        },
      },
    };

    const slim = toSlimTool(tool).tool;

    expect(slim.function.description?.length).toBeLessThanOrEqual(200);
    expect(slim.function.parameters).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("extracts opaque provider compaction items with digests", () => {
    const refs = extractCompactionItemRefs({
      output: [
        { type: "message", id: "msg_1" },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
    });

    expect(refs).toEqual([
      expect.objectContaining({
        type: "compaction",
        id: "cmp_1",
      }),
    ]);
    expect(refs[0]?.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});
