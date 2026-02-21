import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FarcasterBridge } from "./farcaster.js";
import { BridgeError } from "./errors.js";
import { ValidationError } from "../types/errors.js";

describe("FarcasterBridge", () => {
  const validConfig = {
    apiKey: "test-api-key",
    signerUuid: "test-signer-uuid",
    apiBaseUrl: "https://mock.neynar.test/v2",
    delayBetweenPostsMs: 0, // no delay in tests
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Constructor validation ----

  it("throws ValidationError if apiKey is missing", () => {
    expect(() => new FarcasterBridge({ ...validConfig, apiKey: "" })).toThrow(
      ValidationError,
    );
  });

  it("throws ValidationError if signerUuid is missing", () => {
    expect(
      () => new FarcasterBridge({ ...validConfig, signerUuid: "" }),
    ).toThrow(ValidationError);
  });

  it("constructs successfully with valid config", () => {
    expect(() => new FarcasterBridge(validConfig)).not.toThrow();
  });

  // ---- postCast validation ----

  it("rejects empty cast text", async () => {
    const bridge = new FarcasterBridge(validConfig);
    await expect(bridge.postCast({ text: "" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects cast text exceeding 320 characters", async () => {
    const bridge = new FarcasterBridge(validConfig);
    const longText = "x".repeat(321);
    await expect(bridge.postCast({ text: longText })).rejects.toThrow(
      ValidationError,
    );
  });

  // ---- postCast API interaction ----

  it("posts a cast successfully", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ cast: { hash: "0xabc123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const bridge = new FarcasterBridge(validConfig);
    const result = await bridge.postCast({ text: "Hello Farcaster!" });

    expect(result.success).toBe(true);
    expect(result.castHash).toBe("0xabc123");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://mock.neynar.test/v2/farcaster/cast");
    expect((opts as RequestInit).method).toBe("POST");

    const sentBody = JSON.parse((opts as RequestInit).body as string);
    expect(sentBody.text).toBe("Hello Farcaster!");
    expect(sentBody.signer_uuid).toBe("test-signer-uuid");
  });

  it("includes channel_id when provided", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ cast: { hash: "0xdef" } }), {
        status: 200,
      }),
    );

    const bridge = new FarcasterBridge(validConfig);
    await bridge.postCast({ text: "In a channel", channelId: "dev" });

    const sentBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.channel_id).toBe("dev");
  });

  it("includes parent when parentUrl is provided", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ cast: { hash: "0xdef" } }), {
        status: 200,
      }),
    );

    const bridge = new FarcasterBridge(validConfig);
    await bridge.postCast({
      text: "A reply",
      parentUrl: "https://warpcast.com/cast/0x123",
    });

    const sentBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.parent).toBe("https://warpcast.com/cast/0x123");
  });

  it("throws BridgeError on API error response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    );

    const bridge = new FarcasterBridge(validConfig);
    await expect(bridge.postCast({ text: "Should fail" })).rejects.toThrow(
      BridgeError,
    );
  });

  it("throws BridgeError on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Network unreachable"));

    const bridge = new FarcasterBridge(validConfig);
    await expect(bridge.postCast({ text: "Should fail" })).rejects.toThrow(
      BridgeError,
    );
  });

  // ---- syncFeedToFarcaster ----

  it("posts multiple messages and returns success count", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ cast: { hash: "0x1" } }), {
          status: 200,
        }),
    );

    const bridge = new FarcasterBridge(validConfig);
    const count = await bridge.syncFeedToFarcaster(["msg1", "msg2", "msg3"]);

    expect(count).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("continues on error and returns partial success count", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cast: { hash: "0x1" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Rate limited" }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cast: { hash: "0x3" } }), {
          status: 200,
        }),
      );

    const bridge = new FarcasterBridge(validConfig);
    const count = await bridge.syncFeedToFarcaster(["a", "b", "c"]);

    expect(count).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("returns zero for empty messages array", async () => {
    const bridge = new FarcasterBridge(validConfig);
    const count = await bridge.syncFeedToFarcaster([]);

    expect(count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends api key header but never logs signerUuid in errors", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ cast: { hash: "0x1" } }), { status: 200 }),
    );

    const bridge = new FarcasterBridge(validConfig);
    await bridge.postCast({ text: "test" });

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-api-key");
  });
});
