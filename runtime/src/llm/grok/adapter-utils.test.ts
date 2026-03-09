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
