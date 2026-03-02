import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDynamicContextWindowCache,
  inferContextWindowTokens,
  inferGrokContextWindowTokens,
  normalizeGrokModel,
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
  });

  it("resolves model-specific windows for non-fast variants", () => {
    expect(inferGrokContextWindowTokens("grok-4-0709")).toBe(256_000);
    expect(inferGrokContextWindowTokens("grok-code-fast-1")).toBe(256_000);
    expect(inferGrokContextWindowTokens("grok-3")).toBe(131_072);
    expect(inferGrokContextWindowTokens("grok-3-mini")).toBe(131_072);
    expect(inferGrokContextWindowTokens("grok-2-vision-1212")).toBe(32_768);
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
    })).toBe(32_768);
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
});
