import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MediaPipeline,
  NoopTranscriptionProvider,
  NoopImageDescriptionProvider,
  defaultMediaPipelineConfig,
  type MediaPipelineConfig,
  type TranscriptionProvider,
  type ImageDescriptionProvider,
} from "./media.js";
import type { GatewayMessage, MessageAttachment } from "./message.js";

// ============================================================================
// Test helpers
// ============================================================================

function makeConfig(
  overrides?: Partial<MediaPipelineConfig>,
): MediaPipelineConfig {
  return defaultMediaPipelineConfig(overrides);
}

function makeAttachment(
  overrides?: Partial<MessageAttachment>,
): MessageAttachment {
  return {
    type: "audio",
    mimeType: "audio/ogg",
    data: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<GatewayMessage>): GatewayMessage {
  return {
    id: "test-id",
    channel: "telegram",
    senderId: "user-123",
    senderName: "Alice",
    sessionId: "session-abc",
    content: "Hello world",
    timestamp: Date.now(),
    scope: "dm",
    ...overrides,
  };
}

// ============================================================================
// Setup / teardown
// ============================================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "media-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// validate
// ============================================================================

describe("validate", () => {
  it("rejects exceeding max size", () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, maxAttachmentBytes: 25 * 1024 * 1024 }),
    );
    const att = makeAttachment({ sizeBytes: 30 * 1024 * 1024 });
    const result = pipeline.validate(att);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds maximum"))).toBe(true);
  });

  it("accepts within limits", () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, maxAttachmentBytes: 25 * 1024 * 1024 }),
    );
    const att = makeAttachment({ sizeBytes: 1000 });
    const result = pipeline.validate(att);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects large data buffer when sizeBytes is absent", () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, maxAttachmentBytes: 100 }),
    );
    const att = makeAttachment({
      data: new Uint8Array(200),
      sizeBytes: undefined,
    });
    const result = pipeline.validate(att);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("byteLength"))).toBe(true);
  });
});

// ============================================================================
// process
// ============================================================================

describe("process", () => {
  it("voice → transcription text", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const mockProvider: TranscriptionProvider = {
      async transcribe() {
        return "Hello from voice";
      },
    };
    pipeline.setTranscriptionProvider(mockProvider);

    const result = await pipeline.process(makeAttachment());
    expect(result.success).toBe(true);
    expect(result.text).toBe("Hello from voice");
  });

  it("image → description text", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const mockProvider: ImageDescriptionProvider = {
      async describe() {
        return "A cat sitting on a mat";
      },
    };
    pipeline.setImageProvider(mockProvider);

    const att = makeAttachment({ type: "image", mimeType: "image/png" });
    const result = await pipeline.process(att);
    expect(result.success).toBe(true);
    expect(result.text).toBe("A cat sitting on a mat");
  });

  it("unsupported type → error result", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const att = makeAttachment({ mimeType: "application/pdf" });
    const result = await pipeline.process(att);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported MIME type");
  });

  it("rejects oversized attachment inline", async () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, maxAttachmentBytes: 10 }),
    );
    const att = makeAttachment({ data: new Uint8Array(50) });
    const result = await pipeline.process(att);
    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds maximum");
  });
});

// ============================================================================
// enrichMessage
// ============================================================================

describe("enrichMessage", () => {
  it("injects transcription text", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const mockProvider: TranscriptionProvider = {
      async transcribe() {
        return "Transcribed speech";
      },
    };
    pipeline.setTranscriptionProvider(mockProvider);

    const msg = makeMessage({
      attachments: [makeAttachment()],
    });
    const enriched = await pipeline.enrichMessage(msg);
    expect(enriched.content).toContain(
      "[Voice transcription: Transcribed speech]",
    );
  });

  it("no attachments passthrough", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const msg = makeMessage();
    const result = await pipeline.enrichMessage(msg);
    expect(result).toEqual(msg);
  });

  it("multiple attachments", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    pipeline.setTranscriptionProvider({
      async transcribe() {
        return "Voice text";
      },
    });
    pipeline.setImageProvider({
      async describe() {
        return "Image text";
      },
    });

    const msg = makeMessage({
      attachments: [
        makeAttachment({ type: "audio", mimeType: "audio/ogg" }),
        makeAttachment({ type: "image", mimeType: "image/png" }),
      ],
    });
    const enriched = await pipeline.enrichMessage(msg);
    expect(enriched.content).toContain("[Voice transcription: Voice text]");
    expect(enriched.content).toContain("[Image description: Image text]");
  });

  it("empty content becomes enrichment directly (voice-only)", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    pipeline.setTranscriptionProvider({
      async transcribe() {
        return "Voice message text";
      },
    });

    const msg = makeMessage({
      content: "",
      attachments: [makeAttachment()],
    });
    const enriched = await pipeline.enrichMessage(msg);
    expect(enriched.content).toBe("[Voice transcription: Voice message text]");
    expect(enriched.content.startsWith("\n")).toBe(false);
  });

  it("skips audio when autoTranscribeVoice is false", async () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, autoTranscribeVoice: false }),
    );
    pipeline.setTranscriptionProvider({
      async transcribe() {
        return "Should not appear";
      },
    });

    const msg = makeMessage({
      content: "Original",
      attachments: [makeAttachment({ type: "audio", mimeType: "audio/ogg" })],
    });
    const enriched = await pipeline.enrichMessage(msg);
    expect(enriched.content).toBe("Original");
  });

  it("skips attachments without data (URL-only)", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    pipeline.setTranscriptionProvider({
      async transcribe() {
        return "Should not appear";
      },
    });

    const msg = makeMessage({
      content: "Original",
      attachments: [
        makeAttachment({
          type: "audio",
          mimeType: "audio/ogg",
          data: undefined,
          url: "https://example.com/voice.ogg",
        }),
      ],
    });
    const enriched = await pipeline.enrichMessage(msg);
    expect(enriched.content).toBe("Original");
  });
});

// ============================================================================
// cleanup
// ============================================================================

describe("cleanup", () => {
  it("removes expired files", async () => {
    const filePath = join(tempDir, "old-file.tmp");
    await writeFile(filePath, "data");
    // Backdate mtime to 2 hours ago
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(filePath, past, past);

    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, tempFileTtlMs: 60 * 60 * 1000 }),
    );
    const removed = await pipeline.cleanup();
    expect(removed).toBe(1);
  });

  it("preserves fresh files", async () => {
    const filePath = join(tempDir, "fresh-file.tmp");
    await writeFile(filePath, "data");

    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, tempFileTtlMs: 24 * 60 * 60 * 1000 }),
    );
    const removed = await pipeline.cleanup();
    expect(removed).toBe(0);
  });
});

// ============================================================================
// Noop providers
// ============================================================================

describe("NoopTranscriptionProvider", () => {
  it("returns placeholder text", async () => {
    const provider = new NoopTranscriptionProvider();
    const ac = new AbortController();
    const text = await provider.transcribe(
      new Uint8Array([1]),
      "audio/ogg",
      ac.signal,
    );
    expect(text).toContain("placeholder");
    expect(text).toContain("audio/ogg");
  });
});

describe("NoopImageDescriptionProvider", () => {
  it("returns placeholder text", async () => {
    const provider = new NoopImageDescriptionProvider();
    const ac = new AbortController();
    const text = await provider.describe(
      new Uint8Array([1]),
      "image/png",
      ac.signal,
    );
    expect(text).toContain("placeholder");
    expect(text).toContain("image/png");
  });
});

// ============================================================================
// setTranscriptionProvider
// ============================================================================

describe("setTranscriptionProvider", () => {
  it("swaps provider", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const custom: TranscriptionProvider = {
      async transcribe() {
        return "custom transcription";
      },
    };
    pipeline.setTranscriptionProvider(custom);

    const result = await pipeline.process(makeAttachment());
    expect(result.success).toBe(true);
    expect(result.text).toBe("custom transcription");
  });
});

// ============================================================================
// timeout
// ============================================================================

describe("timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforced on slow provider", async () => {
    const pipeline = new MediaPipeline(
      makeConfig({ tempDir, processingTimeoutMs: 50 }),
    );
    const slowProvider: TranscriptionProvider = {
      transcribe() {
        return new Promise((resolve) =>
          setTimeout(() => resolve("late"), 10_000),
        );
      },
    };
    pipeline.setTranscriptionProvider(slowProvider);

    const resultPromise = pipeline.process(makeAttachment());
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });
});

// ============================================================================
// error handling
// ============================================================================

describe("error handling", () => {
  it("returns error result instead of throwing", async () => {
    const pipeline = new MediaPipeline(makeConfig({ tempDir }));
    const failingProvider: TranscriptionProvider = {
      async transcribe() {
        throw new Error("provider exploded");
      },
    };
    pipeline.setTranscriptionProvider(failingProvider);

    const result = await pipeline.process(makeAttachment());
    expect(result.success).toBe(false);
    expect(result.error).toContain("provider exploded");
  });
});
