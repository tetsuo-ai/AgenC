import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

// Mock the openai module
const mockCreate = vi.fn();
const mockModelsListFn = vi.fn();
const mockOpenAIConstructor = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = { create: mockCreate };
      models = { list: mockModelsListFn };
      constructor(opts: any) {
        mockOpenAIConstructor(opts);
      }
    },
  };
});

// Import after mock setup
import { GrokProvider } from "./adapter.js";

function makeCompletion(overrides: Record<string, any> = {}) {
  return {
    status: "completed",
    output_text: "Hello!",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello!" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    model: "grok-4-1-fast-reasoning",
    ...overrides,
  };
}

describe("GrokProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("applies a default request timeout when timeoutMs is omitted", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([{ role: "user", content: "test" }]);

    expect(mockOpenAIConstructor).toHaveBeenCalledOnce();
    expect(mockOpenAIConstructor.mock.calls[0][0].timeout).toBe(60_000);
  });

  it("coerces non-positive timeoutMs to the default request timeout", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 0 });
    await provider.chat([{ role: "user", content: "test" }]);

    expect(mockOpenAIConstructor).toHaveBeenCalledOnce();
    expect(mockOpenAIConstructor.mock.calls[0][0].timeout).toBe(60_000);
  });

  it("sends messages in Responses-compatible format", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];

    const response = await provider.chat(messages);

    expect(mockCreate).toHaveBeenCalledOnce();
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe("grok-4-1-fast-reasoning");
    expect(params.input).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
    expect(response.content).toBe("Hello!");
    expect(response.finishReason).toBe("stop");
    expect(response.requestMetrics).toBeDefined();
    expect(response.requestMetrics?.messageCount).toBeGreaterThan(0);
    expect(response.requestMetrics?.systemMessages).toBe(1);
    expect(response.requestMetrics?.userMessages).toBe(1);
  });

  it("includes tool schema diagnostics in requestMetrics", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
    });

    const response = await provider.chat([{ role: "user", content: "run ls" }]);
    expect(response.requestMetrics).toBeDefined();
    expect(response.requestMetrics?.toolCount).toBeGreaterThan(0);
    expect(response.requestMetrics?.toolSchemaChars).toBeGreaterThan(0);
  });

  it("parses tool calls from response", async () => {
    const completion = makeCompletion({
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"test"}',
        },
      ],
    });
    mockCreate.mockResolvedValueOnce(completion);

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([
      { role: "user", content: "search for test" },
    ]);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe("search");
    expect(response.finishReason).toBe("tool_calls");
  });

  it("injects web_search tool when webSearch is true", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key", webSearch: true });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools.some((t: any) => t.type === "web_search")).toBe(true);
  });

  it("disables parallel tool calls by default when tools are present", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    });

    await provider.chat([{ role: "user", content: "run ls" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.parallel_tool_calls).toBe(false);
  });

  it("honors parallelToolCalls override when enabled", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      parallelToolCalls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    });

    await provider.chat([{ role: "user", content: "run ls" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.parallel_tool_calls).toBe(true);
  });

  it("sanitizes oversized tool schemas and strips verbose metadata", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const noisyTool: LLMTool = {
      type: "function",
      function: {
        name: "noisy.tool",
        description: "D".repeat(800),
        parameters: {
          type: "object",
          description: "Top-level schema description",
          properties: {
            command: {
              type: "string",
              description: "Very long per-field description",
            },
          },
          required: ["command"],
        },
      },
    };

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [noisyTool],
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    const tool = params.tools[0];
    expect(tool.description.length).toBeLessThanOrEqual(200);
    const paramsJson = JSON.stringify(tool.parameters);
    expect(paramsJson.includes("description")).toBe(false);
  });

  it("omits tools on follow-up turns when tool payload is large", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const manyTools: LLMTool[] = Array.from({ length: 120 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool ${i}`,
        parameters: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
            d: { type: "string" },
            e: { type: "string" },
            f: { type: "string" },
          },
          required: ["a"],
        },
      },
    }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: manyTools,
    });
    await provider.chat([
      { role: "user", content: "run tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "tool_1",
            arguments: '{"a":"value"}',
          },
        ],
      },
      {
        role: "tool",
        content: "{\"ok\":true}",
        toolCallId: "call_1",
        toolName: "tool_1",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
  });

  it("passes usage information", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([{ role: "user", content: "test" }]);

    expect(response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("handles streaming", async () => {
    const chunks = [
      {
        type: "response.output_text.delta",
        delta: "Hello",
      },
      {
        type: "response.output_text.delta",
        delta: " world",
      },
      {
        type: "response.completed",
        response: makeCompletion({
          output_text: "Hello world",
          model: "grok-3",
        }),
      },
    ];
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.content).toBe("Hello world");
    expect(onChunk).toHaveBeenCalledWith({ content: "Hello", done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: " world", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("maps 429 error to LLMRateLimitError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 429,
      message: "Rate limited",
      headers: {},
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMRateLimitError);
  });

  it("maps 500 errors to LLMServerError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 500,
      message: "Internal server error",
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMServerError);
  });

  it("maps 401 to LLMAuthenticationError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 401,
      message: "Invalid API key",
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMAuthenticationError);
  });

  it("maps AbortError to LLMTimeoutError", async () => {
    mockCreate.mockRejectedValueOnce({
      name: "AbortError",
      message: "signal aborted",
    });

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("returns partial streamed content on mid-stream failure", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "partial ",
        };
        yield {
          type: "response.output_text.delta",
          delta: "response",
        };
        throw { name: "AbortError", message: "stream interrupted" };
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial response");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it("times out stalled streaming responses and returns partial output", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "partial ",
        };
        await new Promise(() => undefined);
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 20 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial ");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
    expect(onChunk).toHaveBeenCalledWith({ content: "partial ", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("throws when stream fails before any content is received", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        throw new Error("stream failed");
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it("healthCheck returns true on success", async () => {
    mockModelsListFn.mockResolvedValueOnce({ data: [] });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const result = await provider.healthCheck();
    expect(result).toBe(true);
  });

  it("healthCheck returns false on failure", async () => {
    mockModelsListFn.mockRejectedValueOnce(new Error("fail"));

    const provider = new GrokProvider({ apiKey: "test-key" });
    const result = await provider.healthCheck();
    expect(result).toBe(false);
  });

  it("uses custom model", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-3-mini",
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe("grok-3-mini");
  });

  it("formats tool result messages correctly", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "search",
            arguments: '{"query":"test"}',
          },
        ],
      },
      {
        role: "tool",
        content: "result data",
        toolCallId: "call_1",
        toolName: "search",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "result data",
    });
  });

  it("formats assistant tool_calls for follow-up turns", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "user", content: "open terminal" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "desktop.bash",
            arguments: '{"command":"xfce4-terminal >/dev/null 2>&1 &"}',
          },
        ],
      },
      {
        role: "tool",
        content: '{"stdout":"","stderr":"","exitCode":0}',
        toolCallId: "call_1",
        toolName: "desktop.bash",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.input[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "desktop.bash",
      arguments: '{"command":"xfce4-terminal >/dev/null 2>&1 &"}',
    });
  });

  it("rejects orphan tool messages without matching assistant tool_calls", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    await expect(
      provider.chat([
        { role: "user", content: "test" },
        { role: "assistant", content: "" },
        {
          role: "tool",
          content: '{"stdout":"","stderr":"","exitCode":0}',
          toolCallId: "call_1",
          toolName: "desktop.bash",
        },
      ]),
    ).rejects.toThrow(LLMProviderError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects non-tool messages before pending tool results are resolved", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    await expect(
      provider.chat([
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo hi"}',
            },
          ],
        },
        { role: "assistant", content: "done" },
      ]),
    ).rejects.toThrow(LLMProviderError);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
