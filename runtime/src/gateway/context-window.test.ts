import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDynamicContextWindowCache,
  inferContextWindowTokens,
  inferGrokContextWindowTokens,
  listKnownGrokModels,
  normalizeGrokModel,
  resolveContextWindowProfile,
  resolveDynamicContextWindowTokens,
} from "./context-window.js";

beforeEach(() => {
  clearDynamicContextWindowCache();
});

describe("normalizeGrokModel", () => {
  it("maps legacy grok-4 aliases to current fast variants", () => {
    expect(normalizeGrokModel("grok-4")).toBe("grok-4-1-fast-reasoning");
    expect(normalizeGrokModel("grok-4-fast-reasoning")).toBe("grok-4-1-fast-reasoning");
    expect(normalizeGrokModel("grok-4-fast-non-reasoning")).toBe("grok-4-1-fast-non-reasoning");
  });
});

describe("inferGrokContextWindowTokens", () => {
  it("resolves 2M windows for grok-4 fast models", () => {
    expect(inferGrokContextWindowTokens("grok-4-1-fast")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4-1-fast-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4-1-fast-non-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4-fast")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4-fast-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4-fast-non-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4.20-experimental-beta-0304-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4.20-experimental-beta-0304-non-reasoning")).toBe(2_000_000);
    expect(inferGrokContextWindowTokens("grok-4.20-multi-agent-experimental-beta-0304")).toBe(2_000_000);
  });

  it("resolves model-specific windows for non-fast variants", () => {
    expect(inferGrokContextWindowTokens("grok-4-0709")).toBe(256_000);
    expect(inferGrokContextWindowTokens("grok-code-fast-1")).toBe(256_000);
    expect(inferGrokContextWindowTokens("grok-3")).toBe(131_072);
    expect(inferGrokContextWindowTokens("grok-3-mini")).toBe(131_072);
    expect(inferGrokContextWindowTokens("grok-2-vision-1212")).toBe(32_768);
  });
});

describe("listKnownGrokModels", () => {
  it("returns canonical model ids with legacy aliases attached", () => {
    const models = listKnownGrokModels();
    expect(models.find((entry) => entry.id === "grok-4-1-fast-reasoning")).toMatchObject({
      id: "grok-4-1-fast-reasoning",
      aliases: expect.arrayContaining(["grok-4", "grok-4-fast-reasoning"]),
    });
    expect(models.find((entry) => entry.id === "grok-3-mini")).toMatchObject({
      id: "grok-3-mini",
      contextWindowTokens: 131_072,
    });
  });
});

describe("inferContextWindowTokens", () => {
  it("uses explicit llm.contextWindowTokens when set", () => {
    expect(inferContextWindowTokens({
      provider: "grok",
      contextWindowTokens: 123_456,
    })).toBe(123_456);
  });

  it("infers per-model windows for grok and provider default for ollama", () => {
    expect(inferContextWindowTokens({
      provider: "grok",
      model: "grok-3-mini",
    })).toBe(131_072);
    expect(inferContextWindowTokens({
      provider: "grok",
      model: "grok-4-1-fast-reasoning",
    })).toBe(2_000_000);
    expect(inferContextWindowTokens({
      provider: "ollama",
    })).toBe(4_096);
  });
});

describe("resolveDynamicContextWindowTokens", () => {
  it("uses /models metadata when available", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "grok-4-1-fast-reasoning", context_window: 2_000_000 },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await resolveDynamicContextWindowTokens({
      provider: "grok",
      apiKey: "xai-key",
      model: "grok-4-1-fast-reasoning",
    }, {
      fetchImpl: fetchMock,
      cacheTtlMs: 60_000,
    });

    expect(result).toBe(2_000_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to /language-models and supports nested/string values", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "grok-3-mini",
              capabilities: {
                context_window_tokens: "131,072",
              },
            },
          ],
        }),
      }) as unknown as typeof fetch;

    const result = await resolveDynamicContextWindowTokens({
      provider: "grok",
      apiKey: "xai-key",
      model: "grok-3-mini",
    }, {
      fetchImpl: fetchMock,
      cacheTtlMs: 60_000,
    });

    expect(result).toBe(131_072);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/models"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/language-models"),
      expect.any(Object),
    );
  });

  it("caches metadata between lookups", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "grok-4-0709", context_length: 256_000 },
        ],
      }),
    })) as unknown as typeof fetch;

    const first = await resolveDynamicContextWindowTokens({
      provider: "grok",
      apiKey: "xai-key",
      model: "grok-4-0709",
    }, {
      fetchImpl: fetchMock,
      cacheTtlMs: 60_000,
    });
    const second = await resolveDynamicContextWindowTokens({
      provider: "grok",
      apiKey: "xai-key",
      model: "grok-4-0709",
    }, {
      fetchImpl: fetchMock,
      cacheTtlMs: 60_000,
    });

    expect(first).toBe(256_000);
    expect(second).toBe(256_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Ollama runtime metadata from /api/ps when available", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: "codellama:latest",
            context_length: 16_384,
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await resolveDynamicContextWindowTokens(
      {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "codellama",
      },
      {
        fetchImpl: fetchMock,
        ollamaRuntimeCacheTtlMs: 60_000,
      },
    );

    expect(result).toBe(16_384);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/ps",
      expect.any(Object),
    );
  });
});

describe("resolveContextWindowProfile", () => {
  it("reports explicit Ollama request context as num_ctx-backed budgeting", async () => {
    await expect(
      resolveContextWindowProfile({
        provider: "ollama",
        model: "qwen2.5-coder",
        contextWindowTokens: 32_768,
        maxTokens: 2_048,
      }),
    ).resolves.toEqual({
      provider: "ollama",
      model: "qwen2.5-coder",
      contextWindowTokens: 32_768,
      contextWindowSource: "ollama_request_num_ctx",
      maxOutputTokens: 2_048,
    });
  });
});
