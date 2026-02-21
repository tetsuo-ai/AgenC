import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage } from "../types.js";
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

// Mock the ollama module
const mockChat = vi.fn();
const mockList = vi.fn();

vi.mock("ollama", () => {
  return {
    Ollama: class MockOllama {
      chat = mockChat;
      list = mockList;
      constructor(_opts: any) {}
    },
  };
});

import { OllamaProvider } from "./adapter.js";

function makeResponse(overrides: Record<string, any> = {}) {
  return {
    message: { content: "Hello!", role: "assistant", tool_calls: [] },
    model: "llama3",
    prompt_eval_count: 10,
    eval_count: 5,
    ...overrides,
  };
}

describe("OllamaProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends messages in correct format", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({});
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const response = await provider.chat(messages);

    expect(mockChat).toHaveBeenCalledOnce();
    const params = mockChat.mock.calls[0][0];
    expect(params.model).toBe("llama3");
    expect(params.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
    expect(response.content).toBe("Hello!");
  });

  it("passes options for temperature and context", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      temperature: 0.7,
      numCtx: 8192,
      numGpu: 1,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.options).toEqual({
      temperature: 0.7,
      num_ctx: 8192,
      num_gpu: 1,
    });
  });

  it("uses custom model", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({ model: "mistral" });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.model).toBe("mistral");
  });

  it("parses tool calls", async () => {
    const response = makeResponse({
      message: {
        content: "",
        role: "assistant",
        tool_calls: [
          { function: { name: "search", arguments: { q: "test" } } },
        ],
      },
    });
    mockChat.mockResolvedValueOnce(response);

    const provider = new OllamaProvider({});
    const result = await provider.chat([{ role: "user", content: "test" }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.toolCalls[0].arguments).toBe('{"q":"test"}');
    expect(result.finishReason).toBe("tool_calls");
  });

  it("handles streaming via async iterable", async () => {
    const chunks = [
      { message: { content: "Hello" }, model: "llama3" },
      {
        message: { content: " world" },
        model: "llama3",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];
    mockChat.mockResolvedValueOnce(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const provider = new OllamaProvider({});
    const onChunk = vi.fn();
    const result = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(result.content).toBe("Hello world");
    expect(onChunk).toHaveBeenCalledWith({ content: "Hello", done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: " world", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("returns usage information", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({});
    const result = await provider.chat([{ role: "user", content: "test" }]);

    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("healthCheck returns true when server is running", async () => {
    mockList.mockResolvedValueOnce({ models: [] });

    const provider = new OllamaProvider({});
    const result = await provider.healthCheck();
    expect(result).toBe(true);
    expect(mockList).toHaveBeenCalledOnce();
  });

  it("healthCheck returns false when server is not running", async () => {
    mockList.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const provider = new OllamaProvider({});
    const result = await provider.healthCheck();
    expect(result).toBe(false);
  });

  it("maps ECONNREFUSED to descriptive error", async () => {
    mockChat.mockRejectedValueOnce({
      code: "ECONNREFUSED",
      message: "Connection refused",
    });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(/Cannot connect to Ollama/);
  });

  it("maps general errors to LLMProviderError", async () => {
    mockChat.mockRejectedValueOnce({ message: "model not found" });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMProviderError);
  });

  it("maps 500 errors to LLMServerError", async () => {
    mockChat.mockRejectedValueOnce({
      status: 500,
      message: "Internal server error",
    });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMServerError);
  });

  it("maps 401 to LLMAuthenticationError", async () => {
    mockChat.mockRejectedValueOnce({ status: 401, message: "Unauthorized" });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMAuthenticationError);
  });

  it("maps AbortError to LLMTimeoutError", async () => {
    mockChat.mockRejectedValueOnce({ name: "AbortError", message: "aborted" });

    const provider = new OllamaProvider({ timeoutMs: 1000 });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("returns partial streamed content on mid-stream failure", async () => {
    mockChat.mockResolvedValueOnce(
      (async function* () {
        yield { message: { content: "partial " }, model: "llama3" };
        yield { message: { content: "response" }, model: "llama3" };
        throw { name: "AbortError", message: "stream interrupted" };
      })(),
    );

    const provider = new OllamaProvider({ timeoutMs: 1000 });
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      () => undefined,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial response");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it("throws when stream fails before any content is received", async () => {
    mockChat.mockResolvedValueOnce(
      (async function* () {
        throw new Error("stream failed");
      })(),
    );

    const provider = new OllamaProvider({});
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it("passes keepAlive configuration", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({ keepAlive: "10m" });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.keep_alive).toBe("10m");
  });

  it("passes tools in OpenAI-compatible format", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].function.name).toBe("lookup");
  });
});
