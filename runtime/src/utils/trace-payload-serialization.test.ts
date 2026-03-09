import { describe, expect, it } from "vitest";
import {
  formatTracePayloadForLog,
  sanitizeTraceTextForLogSnippet,
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

  it("summarizes large ANSI terminal captures instead of logging raw escape sequences", () => {
    const capture = [
      "\u001b[H\u001b[2J\u001b[38;5;239m╭──────────╮\u001b[0m",
      "\u001b[38;5;239m│\u001b[0mAGEN C LIVE\u001b[38;5;239m│\u001b[0m",
      "\u001b[38;5;239m│\u001b[0mSTATUS connecting…\u001b[38;5;239m│\u001b[0m",
      "\u001b[38;5;239m╰──────────╯\u001b[0m",
      " ".repeat(80),
      " ".repeat(80),
    ].join("\n");

    const formatted = formatTracePayloadForLog({
      stdout: capture,
    });

    expect(formatted).toContain('"artifactType":"terminal_capture"');
    expect(formatted).not.toContain("\\u001b[H");
    expect(formatted).not.toContain("AGEN C LIVE");
  });

  it("summarizes binary-like text dumps instead of logging replacement noise", () => {
    const formatted = formatTracePayloadForLog({
      stdout: `\u007fELF\u0002\u0001\u0001\u0000${"\u0000".repeat(16)}${"\uFFFD".repeat(12)}`,
    });

    expect(formatted).toContain('"artifactType":"binary_like_text"');
    expect(formatted).not.toContain("\\u0000");
  });

  it("strips ANSI from short inline snippets while preserving the readable text", () => {
    const snippet = sanitizeTraceTextForLogSnippet(
      "\u001b[31mterminal check complete\u001b[0m",
      200,
    );

    expect(snippet).toBe("terminal check complete");
  });
});
