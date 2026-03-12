import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";
import { sanitizeToolCallArgumentsForReplay } from "../chat-executor-tool-utils.js";

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

  it("reports execution profile from explicit context window overrides", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-3-mini",
      contextWindowTokens: 99_999,
      maxTokens: 4_096,
    });

    await expect(provider.getExecutionProfile?.()).resolves.toEqual({
      provider: "grok",
      model: "grok-3-mini",
      contextWindowTokens: 99_999,
      contextWindowSource: "explicit_config",
      maxOutputTokens: 4_096,
    });
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

  it("applies per-call routed tool subset when provided", async () => {
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
            },
          },
        },
        {
          type: "function",
          function: {
            name: "system.httpGet",
            description: "http get",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "run ls" }],
      { toolRouting: { allowedToolNames: ["system.bash"] } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("system.bash");
  });

  it("normalizes required single-tool choice to a named function for the Responses API", async () => {
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
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      { toolChoice: "required" },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tool_choice).toEqual({
      type: "function",
      name: "system.bash",
    });
  });

  it("captures selected tools and tool_choice in request metrics", async () => {
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
            },
          },
        },
        {
          type: "function",
          function: {
            name: "system.httpGet",
            description: "http get",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["system.bash"] },
        toolChoice: "required",
      },
    );

    expect(response.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["system.bash"],
      requestedToolNames: ["system.bash"],
      missingRequestedToolNames: [],
      toolResolution: "subset_exact",
      toolChoice: "function:system.bash",
      store: false,
    });
  });

  it("treats an empty routed allowlist as no attached tools", async () => {
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
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "reply with exactly ACK" }],
      {
        toolRouting: { allowedToolNames: [] },
        toolChoice: "none",
      },
    );

    const params = mockCreate.mock.calls.at(-1)?.[0];
    expect(params.tools).toBeUndefined();
    expect(response.requestMetrics).toMatchObject({
      toolCount: 0,
      toolNames: [],
      requestedToolNames: [],
      toolResolution: "all_tools_empty_filter",
      toolsAttached: false,
      store: false,
    });
  });

  it("normalizes forced function tool_choice for the Responses API", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "mcp.browser.browser_navigate",
            description: "open a url",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "open the docs" }],
      { toolChoice: { type: "function", name: "mcp.browser.browser_navigate" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tool_choice).toEqual({
      type: "function",
      name: "mcp.browser.browser_navigate",
    });
  });

  it("emits raw provider request and response trace events when enabled", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
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
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["system.bash"] },
        toolChoice: "required",
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "request",
      transport: "chat",
      provider: "grok",
      context: {
        requestedToolNames: ["system.bash"],
        resolvedToolNames: ["system.bash"],
        missingRequestedToolNames: [],
        toolResolution: "subset_exact",
        messageCount: 1,
        systemMessages: 0,
        userMessages: 1,
        assistantMessages: 0,
        toolMessages: 0,
      },
      payload: {
        tool_choice: {
          type: "function",
          name: "system.bash",
        },
      },
    });
    expect((events[0].payload as { tools?: Array<{ name?: string }> }).tools?.[0]?.name).toBe(
      "system.bash",
    );
    expect(events[1]).toMatchObject({
      kind: "response",
      transport: "chat",
      provider: "grok",
    });
    expect((events[1].payload as { output_text?: string }).output_text).toBe("Hello!");
  });

  it("records provider tool-resolution fallback when routed tools cannot be resolved", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
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
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["mcp.doom.start_game"] },
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(response.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["system.bash"],
      requestedToolNames: ["mcp.doom.start_game"],
      missingRequestedToolNames: ["mcp.doom.start_game"],
      toolResolution: "fallback_full_catalog_no_matches",
      providerCatalogToolCount: 1,
    });
    expect(events[0]).toMatchObject({
      kind: "request",
      context: {
        requestedToolNames: ["mcp.doom.start_game"],
        resolvedToolNames: ["system.bash"],
        missingRequestedToolNames: ["mcp.doom.start_game"],
        toolResolution: "fallback_full_catalog_no_matches",
        providerCatalogToolCount: 1,
      },
    });
  });

  it("records persisted stateful anchor details on provider response traces", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        id: "resp_trace_stateful_1",
        output_text: "Stored",
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "Persist the anchor." }],
      {
        stateful: { sessionId: "sess-trace-stateful" },
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: "response",
      transport: "chat",
      context: {
        statefulResponseId: "resp_trace_stateful_1",
        statefulContinued: false,
      },
    });
    expect((events[1].context as Record<string, unknown>).statefulReconciliationHash)
      .toEqual(expect.any(String));
  });

  it("preserves explicitly routed tools even when they were dropped from the slimmed full catalog", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const bulkySystemTools: LLMTool[] = Array.from({ length: 180 }, (_, index) => ({
      type: "function",
      function: {
        name: `system.tool_${String(index).padStart(3, "0")}`,
        description: `tool ${index} ` + "x".repeat(240),
        parameters: {
          type: "object",
          properties: {
            payload: {
              type: "string",
              description: "y".repeat(500),
            },
          },
        },
      },
    }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        ...bulkySystemTools,
        {
          type: "function",
          function: {
            name: "mcp.doom.start_game",
            description: "start doom",
            parameters: {
              type: "object",
              properties: {
                scenario: { type: "string" },
                async_player: { type: "boolean" },
              },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "start doom" }],
      { toolRouting: { allowedToolNames: ["mcp.doom.start_game"] } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("mcp.doom.start_game");
    expect(response.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["mcp.doom.start_game"],
      requestedToolNames: ["mcp.doom.start_game"],
      missingRequestedToolNames: [],
      toolResolution: "subset_exact",
    });
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

  it("surfaces provider citations as provider evidence", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        citations: [
          "https://docs.phaser.io",
          "https://pixijs.com",
        ],
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key", webSearch: true });
    const response = await provider.chat([
      { role: "user", content: "Compare Phaser and Pixi from official docs" },
    ]);

    expect(response.providerEvidence?.citations).toEqual([
      "https://docs.phaser.io",
      "https://pixijs.com",
    ]);
  });

  it("injects web_search tool when webSearch is true", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-1-fast-reasoning",
      webSearch: true,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools.some((t: any) => t.type === "web_search")).toBe(true);
  });

  it("does not inject web_search tool for unsupported Grok models", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-code-fast-1",
      webSearch: true,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
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

  it("surfaces provider error details on non-stream failed responses", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        status: "failed",
        output_text: "",
        error: {
          message: "upstream failure",
          code: 502,
        },
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([{ role: "user", content: "test" }]);

    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(LLMProviderError);
    expect(response.error?.message).toContain("upstream failure");
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

  it("uses the per-call timeout override and forwards the abort signal", async () => {
    mockCreate.mockImplementationOnce(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject({ name: "AbortError", message: "signal aborted" });
          }, { once: true });
        }),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 60_000 });
    await expect(
      provider.chat(
        [{ role: "user", content: "test" }],
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow(LLMTimeoutError);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
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

  it("surfaces provider error details on response.failed stream events", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "stream failed", code: 503 },
          },
        };
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(LLMProviderError);
    expect(response.error?.message).toContain("stream failed");
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("stops on response.completed even if trailing stream noise follows", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.completed",
          response: makeCompletion({
            output_text: "done",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
        };
        // Provider-side trailing noise should be ignored after completion.
        yield {
          type: "response.output_text.delta",
          delta: "ignored",
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

    expect(response.finishReason).toBe("stop");
    expect(response.error).toBeUndefined();
    expect(response.content).toBe("done");
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
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

  it("suppresses async cleanup rejections from streamIterator.return", async () => {
    const returnSpy = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("cleanup failed")),
    );

    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          async next() {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return {
              done: false,
              value: {
                type: "response.completed",
                response: makeCompletion({
                  output_text: "done",
                }),
              },
            };
          },
          return: returnSpy,
        };
      },
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      () => undefined,
    );

    expect(response.content).toBe("done");
    expect(returnSpy).toHaveBeenCalledOnce();
  });

  it("enforces an absolute stream timeout even when chunks keep arriving", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        while (true) {
          yield {
            type: "response.output_text.delta",
            delta: "",
          };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 35 });
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMTimeoutError);
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

  it("preserves assistant phase on Responses API assistant input items", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Start working." },
      { role: "assistant", content: "Checking the environment first.", phase: "commentary" },
      { role: "user", content: "Continue." },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.input).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Start working." },
      {
        role: "assistant",
        content: "Checking the environment first.",
        phase: "commentary",
      },
      { role: "user", content: "Continue." },
    ]);
  });

  it("retries without assistant phase when the provider rejects the field", async () => {
    mockCreate
      .mockRejectedValueOnce({
        status: 400,
        message: "Unknown field 'phase' on assistant input item",
      })
      .mockResolvedValueOnce(makeCompletion({ id: "resp_phase_retry" }));

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([
      { role: "user", content: "Start." },
      { role: "assistant", content: "Working...", phase: "commentary" },
      { role: "user", content: "Continue." },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].input[1]).toMatchObject({
      role: "assistant",
      phase: "commentary",
    });
    expect(mockCreate.mock.calls[1][0].input[1]).toEqual({
      role: "assistant",
      content: "Working...",
    });
    expect(response.content).toBe("Hello!");
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
    ).rejects.toThrow(LLMMessageValidationError);
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
    ).rejects.toThrow(/tool_result_without_assistant_call/);
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
          phase: "commentary",
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
    ).rejects.toThrow(LLMMessageValidationError);
    await expect(
      provider.chat([
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
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
    ).rejects.toThrow(/tool_result_missing/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects two malformed orphan pairs without making provider calls", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    await expect(
      provider.chat([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "test" },
        { role: "assistant", content: "" },
        {
          role: "tool",
          content: '{"stdout":"","exitCode":0}',
          toolCallId: "call_1",
        },
        { role: "assistant", content: "" },
        {
          role: "tool",
          content: '{"stdout":"","exitCode":0}',
          toolCallId: "call_2",
        },
      ]),
    ).rejects.toThrow(/message\[3\]/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects mixed valid/invalid tool-turn history", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    await expect(
      provider.chat([
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo hi"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"hi\\n","exitCode":0}',
          toolCallId: "call_1",
        },
        { role: "assistant", content: "" },
        {
          role: "tool",
          content: '{"stdout":"","exitCode":0}',
          toolCallId: "call_2",
        },
      ]),
    ).rejects.toThrow(/tool_result_without_assistant_call/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("uses previous_response_id for safe stateful continuation", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "Hello",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_2",
          output_text: "Follow-up",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-1" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "follow up" },
      ],
      { stateful: { sessionId: "sess-1" } },
    );

    const firstParams = mockCreate.mock.calls[0][0];
    const secondParams = mockCreate.mock.calls[1][0];
    expect(firstParams.previous_response_id).toBeUndefined();
    expect(firstParams.store).toBe(true);
    expect(secondParams.previous_response_id).toBe("resp_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.responseId).toBe("resp_2");
  });

  it("does not persist previous_response_id anchors for empty assistant turns", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_empty",
          output_text: "",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_fresh",
          output_text: "Recovered statelessly",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-empty-anchor" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "user", content: "follow up after empty turn" },
      ],
      { stateful: { sessionId: "sess-empty-anchor" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.continued).toBe(false);
  });

  it("keeps previous_response_id continuity across a tool turn and the next user turn", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_initial",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_followup",
          output_text: "TOKEN=ONYX-SHARD-58",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_next",
          output_text: "confirmed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [{ role: "user", content: "find the token" }],
      { stateful: { sessionId: "sess-tool-turn" } },
    );
    const second = await provider.chat(
      [
        { role: "user", content: "find the token" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"TOKEN=ONYX-SHARD-58\\n","exitCode":0}',
          toolCallId: "call_1",
          toolName: "desktop.bash",
        },
      ],
      { stateful: { sessionId: "sess-tool-turn" } },
    );
    const third = await provider.chat(
      [
        { role: "user", content: "find the token" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"TOKEN=ONYX-SHARD-58\\n","exitCode":0}',
          toolCallId: "call_1",
          toolName: "desktop.bash",
        },
        { role: "assistant", content: "TOKEN=ONYX-SHARD-58" },
        { role: "user", content: "repeat the token" },
      ],
      { stateful: { sessionId: "sess-tool-turn" } },
    );

    expect(first.finishReason).toBe("tool_calls");
    expect(second.content).toBe("TOKEN=ONYX-SHARD-58");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe(
      "resp_tool_initial",
    );
    expect(JSON.stringify(mockCreate.mock.calls[1][0].input)).not.toContain(
      "find the token",
    );
    expect(JSON.stringify(mockCreate.mock.calls[1][0].input)).toContain(
      "TOKEN=ONYX-SHARD-58",
    );
    expect(second.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(second.requestMetrics?.statefulOmittedMessageCount).toBeGreaterThan(0);
    expect(mockCreate.mock.calls[2][0].previous_response_id).toBe(
      "resp_tool_followup",
    );
    expect(JSON.stringify(mockCreate.mock.calls[2][0].input)).not.toContain(
      "find the token",
    );
    expect(JSON.stringify(mockCreate.mock.calls[2][0].input)).toContain(
      "repeat the token",
    );
    expect(third.stateful?.continued).toBe(true);
    expect(third.stateful?.fallbackReason).toBeUndefined();
  });

  it("keeps previous_response_id continuity when replayed tool-call arguments are sanitized", async () => {
    const rawArguments = JSON.stringify({
      path: "packages/core/src/routing.test.ts",
      content: "x".repeat(5_000),
    });
    const replayArguments = sanitizeToolCallArgumentsForReplay(rawArguments);

    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_large_tool_initial",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_large_1",
              name: "system.writeFile",
              arguments: rawArguments,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_large_tool_followup",
          output_text: "patched",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [{ role: "user", content: "write the large routing test file" }],
      { stateful: { sessionId: "sess-large-tool-turn" } },
    );
    const second = await provider.chat(
      [
        { role: "user", content: "write the large routing test file" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_large_1",
              name: "system.writeFile",
              arguments: replayArguments,
            },
          ],
        },
        {
          role: "tool",
          content:
            '{"path":"packages/core/src/routing.test.ts","bytesWritten":5000}',
          toolCallId: "call_large_1",
          toolName: "system.writeFile",
        },
      ],
      { stateful: { sessionId: "sess-large-tool-turn" } },
    );

    expect(first.finishReason).toBe("tool_calls");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe(
      "resp_large_tool_initial",
    );
    expect(second.content).toBe("patched");
    expect(second.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("advances the continuation anchor across consecutive tool rounds", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_1",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_2",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_round_2",
              name: "system.readFile",
              arguments: '{"path":"phase-1.txt"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_3",
          output_text: "phase-2 complete",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "multi-step tool loop" }],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    await provider.chat(
      [
        { role: "user", content: "multi-step tool loop" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"phase-1\\n","exitCode":0}',
          toolCallId: "call_round_1",
          toolName: "system.bash",
        },
      ],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    const third = await provider.chat(
      [
        { role: "user", content: "multi-step tool loop" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"phase-1\\n","exitCode":0}',
          toolCallId: "call_round_1",
          toolName: "system.bash",
        },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_2",
              name: "system.readFile",
              arguments: '{"path":"phase-1.txt"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"content":"phase-2 complete","path":"phase-1.txt"}',
          toolCallId: "call_round_2",
          toolName: "system.readFile",
        },
      ],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    const thirdParams = mockCreate.mock.calls[2][0];
    const thirdInput = JSON.stringify(thirdParams.input);

    expect(thirdParams.previous_response_id).toBe("resp_round_2");
    expect(third.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(third.requestMetrics?.statefulOmittedMessageCount).toBeGreaterThan(1);
    expect(thirdInput).not.toContain("multi-step tool loop");
    expect(thirdInput).not.toContain("phase-1\\n");
    expect(thirdInput).toContain("phase-2 complete");
  });

  it("requests server-side compaction when configured", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion({ id: "resp_compact_req" }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        compaction: {
          enabled: true,
          compactThreshold: 12_000,
        },
      },
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { stateful: { sessionId: "sess-compact" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.context_management).toEqual({ compact_threshold: 12_000 });
    expect(response.compaction).toMatchObject({
      enabled: true,
      requested: true,
      active: true,
      threshold: 12_000,
      observedItemCount: 0,
    });
  });

  it("parses opaque provider compaction items into response diagnostics", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        id: "resp_compacted",
        output: [
          {
            type: "compaction",
            id: "cmp_1",
            encrypted_content: "opaque",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello after compaction!" }],
          },
        ],
      }),
    );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        compaction: {
          enabled: true,
          compactThreshold: 8_000,
        },
      },
    });

    const response = await provider.chat(
      [{ role: "user", content: "compact if needed" }],
      { stateful: { sessionId: "sess-compact-items" } },
    );

    expect(response.compaction).toMatchObject({
      enabled: true,
      requested: true,
      active: true,
      observedItemCount: 1,
      latestItem: {
        type: "compaction",
        id: "cmp_1",
      },
    });
    expect(response.compaction?.latestItem?.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("retries without server-side compaction when the provider rejects context_management", async () => {
    mockCreate
      .mockRejectedValueOnce({
        status: 400,
        message: "Unknown field 'context_management.compact_threshold'",
      })
      .mockResolvedValueOnce(makeCompletion({ id: "resp_compact_retry" }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        compaction: {
          enabled: true,
          compactThreshold: 20_000,
          fallbackOnUnsupported: true,
        },
      },
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { stateful: { sessionId: "sess-compact-retry" } },
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].context_management).toEqual({
      compact_threshold: 20_000,
    });
    expect(mockCreate.mock.calls[1][0].context_management).toBeUndefined();
    expect(response.compaction).toMatchObject({
      enabled: true,
      requested: true,
      active: false,
      fallbackReason: "request_rejected",
    });
  });

  it("keeps continuation behavior stable with and without provider compaction", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_plain_1",
          output_text: "Plain first",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_plain_2",
          output_text: "Stable follow-up",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compact_1",
          output_text: "Compact first",
          output: [
            { type: "compaction", id: "cmp_ab_1", encrypted_content: "opaque" },
            {
              type: "message",
              content: [{ type: "output_text", text: "Compact first" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compact_2",
          output_text: "Stable follow-up",
        }),
      );

    const plainProvider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });
    const compactProvider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
        compaction: {
          enabled: true,
          compactThreshold: 10_000,
        },
      },
    });

    await plainProvider.chat(
      [{ role: "user", content: "first" }],
      { stateful: { sessionId: "sess-ab-plain" } },
    );
    const plainFollowUp = await plainProvider.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "Plain first", phase: "final_answer" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-ab-plain" } },
    );

    await compactProvider.chat(
      [{ role: "user", content: "first" }],
      { stateful: { sessionId: "sess-ab-compact" } },
    );
    const compactFollowUp = await compactProvider.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "Compact first", phase: "final_answer" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-ab-compact" } },
    );

    expect(plainFollowUp.content).toBe("Stable follow-up");
    expect(compactFollowUp.content).toBe("Stable follow-up");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe("resp_plain_1");
    expect(mockCreate.mock.calls[1][0].context_management).toBeUndefined();
    expect(mockCreate.mock.calls[3][0].previous_response_id).toBe("resp_compact_1");
    expect(mockCreate.mock.calls[3][0].context_management).toEqual({
      compact_threshold: 10_000,
    });
    expect(compactFollowUp.compaction).toMatchObject({
      enabled: true,
      active: true,
    });
  });

  it("falls back stateless on reconciliation mismatch and emits mismatch diagnostics", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "First",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_2",
          output_text: "Fresh",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "first turn" },
      ],
      { stateful: { sessionId: "sess-mismatch" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "totally different turn" },
      ],
      { stateful: { sessionId: "sess-mismatch" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.fallbackReason).toBe("state_reconciliation_mismatch");
    expect(second.stateful?.previousReconciliationHash).toBeDefined();
    expect(second.stateful?.reconciliationMessageCount).toBe(1);
    expect(second.stateful?.reconciliationSource).toBe("non_system_messages");
    expect(second.stateful?.anchorMatched).toBe(false);
    expect(second.stateful?.events?.some((event) =>
      event.type === "state_reconciliation_mismatch"
    )).toBe(true);
  });

  it("trusts a known local compaction boundary and keeps previous_response_id", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compacted_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compacted_2",
          output_text: "Resumed after compaction",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "first turn" },
      ],
      { stateful: { sessionId: "sess-compacted-trust" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "[Compacted: 51 earlier messages removed]" },
        { role: "user", content: "follow up after local compaction" },
      ],
      {
        stateful: {
          sessionId: "sess-compacted-trust",
          historyCompacted: true,
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_compacted_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(false);
    expect(second.stateful?.historyCompacted).toBe(true);
    expect(second.stateful?.compactedHistoryTrusted).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("retries stateless when previous_response_id retrieval fails", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "First",
        }),
      )
      .mockRejectedValueOnce({
        status: 404,
        message: "previous_response_id not found",
      })
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_3",
          output_text: "Recovered",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-stale" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "First" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-stale" } },
    );

    expect(mockCreate).toHaveBeenCalledTimes(3);
    const attemptedParams = mockCreate.mock.calls[1][0];
    const retryParams = mockCreate.mock.calls[2][0];
    expect(attemptedParams.previous_response_id).toBe("resp_1");
    expect(retryParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.fallbackReason).toBe("provider_retrieval_failure");
    expect(second.stateful?.events?.some((event) =>
      event.reason === "provider_retrieval_failure"
    )).toBe(true);
  });

  it("falls back with missing_previous_response_id after provider restart", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion({
        id: "resp_restart",
        output_text: "Stateless",
      }),
    );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const response = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "assistant", content: "previous local history only" },
        { role: "user", content: "continue after restart" },
      ],
      { stateful: { sessionId: "sess-restart" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.previous_response_id).toBeUndefined();
    expect(response.stateful?.fallbackReason).toBe(
      "missing_previous_response_id",
    );
  });

  it("uses a persisted resume anchor after provider restart", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_anchor",
          output_text: "Hello",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_resumed",
          output_text: "Resumed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-resume" } },
    );
    provider.clearSessionState();

    const response = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "continue after restart" },
      ],
      {
        stateful: {
          sessionId: "sess-resume",
          resumeAnchor: {
            previousResponseId: "resp_anchor",
            reconciliationHash: first.stateful?.reconciliationHash,
          },
        },
      },
    );

    const params = mockCreate.mock.calls[1][0];
    expect(params.previous_response_id).toBe("resp_anchor");
    expect(response.stateful?.continued).toBe(true);
    expect(response.stateful?.responseId).toBe("resp_resumed");
  });

  it("continues statefully across changing system context injections", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_dynamic_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_dynamic_2",
          output_text: "BLACK-ORBIT|8771|SIGMA-42",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test A3" },
      ],
      { stateful: { sessionId: "sess-dynamic-context" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "system", content: "## Recent Progress\nupdated working summary" },
        { role: "user", content: "Stateful continuity test A3" },
        { role: "assistant", content: "Stored", phase: "final_answer" },
        { role: "user", content: "Stateful continuity test B3" },
      ],
      { stateful: { sessionId: "sess-dynamic-context" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_dynamic_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.reconciliationMessageCount).toBe(3);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("continues statefully when reconciliation history replays assistant commentary", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_commentary_1",
          output_text: "**BLOCKED**: missing grounded evidence",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_commentary_2",
          output_text: "Recovered",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "Implement the delegated phase." }],
      { stateful: { sessionId: "sess-commentary-retry" } },
    );
    const second = await provider.chat(
      [{ role: "system", content: "Retry with tool-grounded evidence." }],
      {
        stateful: {
          sessionId: "sess-commentary-retry",
          reconciliationMessages: [
            { role: "user", content: "Implement the delegated phase." },
            {
              role: "assistant",
              content: "**BLOCKED**: missing grounded evidence",
              phase: "commentary",
            },
            { role: "system", content: "Retry with tool-grounded evidence." },
          ],
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_commentary_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("uses reconciliationMessages when prompt budgeting trims the provider payload", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trim_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trim_2",
          output_text: "Resumed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test A5" },
      ],
      { stateful: { sessionId: "sess-trimmed-reconciliation" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test B5" },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-reconciliation",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Stateful continuity test A5" },
            { role: "assistant", content: "Stored", phase: "final_answer" },
            { role: "user", content: "Stateful continuity test B5" },
          ],
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_trim_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.reconciliationMessageCount).toBe(3);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("persists stateful anchors from reconciliationMessages when the first replay turn is already prompt-trimmed", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trimmed_anchor_1",
          output_text: "Continued from trimmed replay",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trimmed_anchor_2",
          output_text: "Resumed safely",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Implement phase two only." },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-anchor-persist",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Implement phase one." },
            {
              role: "assistant",
              content: "Phase one complete.",
              phase: "final_answer",
            },
            { role: "user", content: "Implement phase two only." },
          ],
        },
      },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Add tests for phases one and two." },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-anchor-persist",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Implement phase one." },
            {
              role: "assistant",
              content: "Phase one complete.",
              phase: "final_answer",
            },
            { role: "user", content: "Implement phase two only." },
            {
              role: "assistant",
              content: "Continued from trimmed replay",
              phase: "final_answer",
            },
            { role: "user", content: "Add tests for phases one and two." },
          ],
        },
      },
    );

    const firstParams = mockCreate.mock.calls[0][0];
    const secondParams = mockCreate.mock.calls[1][0];
    expect(firstParams.previous_response_id).toBeUndefined();
    expect(secondParams.previous_response_id).toBe("resp_trimmed_anchor_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });
});
