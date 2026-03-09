import { describe, expect, it } from "vitest";
import {
  formatTracePayloadForLog,
  sanitizeTracePayloadForArtifact,
  summarizeTracePayloadForPreview,
} from "./trace-payload-serialization.js";

describe("trace-payload-serialization", () => {
  it("preserves repeated references in preview mode and only marks true cycles", () => {
    const shared = ["mcp.doom.start_game"];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const preview = summarizeTracePayloadForPreview(
      {
        requestedToolNames: shared,
        missingRequestedToolNames: shared,
        cyclic,
      },
      20_000,
    ) as {
      requestedToolNames: string[];
      missingRequestedToolNames: string[];
      cyclic: { self: string };
    };

    expect(preview.requestedToolNames).toEqual(["mcp.doom.start_game"]);
    expect(preview.missingRequestedToolNames).toEqual([
      "mcp.doom.start_game",
    ]);
    expect(preview.cyclic.self).toBe("[circular]");
  });

  it("keeps artifact sanitization aligned with preview-safe cycle handling", () => {
    const shared = ["system.bash"];
    const sanitized = sanitizeTracePayloadForArtifact({
      requestedToolNames: shared,
      missingRequestedToolNames: shared,
    }) as {
      requestedToolNames: string[];
      missingRequestedToolNames: string[];
    };

    expect(sanitized.requestedToolNames).toEqual(["system.bash"]);
    expect(sanitized.missingRequestedToolNames).toEqual(["system.bash"]);
  });

  it("formats preview payloads as JSON with externalized binary summaries", () => {
    const formatted = formatTracePayloadForLog({
      image: "data:image/png;base64,AAAA",
      nested: { ok: true },
    });

    expect(formatted).toContain('"artifactType":"image_data_url"');
    expect(formatted).toContain('"nested":{"ok":true}');
  });
});
