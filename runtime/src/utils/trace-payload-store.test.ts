import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { persistTracePayloadArtifact } from "./trace-payload-store.js";

describe("persistTracePayloadArtifact", () => {
  it("writes an exact JSON artifact and sanitizes binary-like payload strings", () => {
    const ref = persistTracePayloadArtifact({
      traceId: "trace-store-test",
      eventName: "webchat.provider.request",
      payload: {
        message: "hello",
        image: "data:image/png;base64,AAAA",
      },
    });

    expect(ref).toBeDefined();
    const artifact = JSON.parse(readFileSync(ref!.path, "utf8")) as {
      eventName: string;
      traceId: string;
      payload: {
        message: string;
        image: { kind: string; mediaType: string; sha256: string };
      };
    };
    expect(artifact.eventName).toBe("webchat.provider.request");
    expect(artifact.traceId).toBe("trace-store-test");
    expect(artifact.payload.message).toBe("hello");
    expect(artifact.payload.image.kind).toBe("data_url_base64");
    expect(artifact.payload.image.mediaType).toBe("image/png");
    expect(artifact.payload.image.sha256).toHaveLength(64);

    rmSync(ref!.path, { force: true });
    rmSync(dirname(ref!.path), { recursive: true, force: true });
  });

  it("preserves repeated references and only marks true cycles as circular", () => {
    const shared = ["mcp.doom.start_game"];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const ref = persistTracePayloadArtifact({
      traceId: "trace-store-duplicates",
      eventName: "webchat.provider.request",
      payload: {
        requestedToolNames: shared,
        missingRequestedToolNames: shared,
        cyclic,
      },
    });

    expect(ref).toBeDefined();
    const artifact = JSON.parse(readFileSync(ref!.path, "utf8")) as {
      payload: {
        requestedToolNames: string[];
        missingRequestedToolNames: string[];
        cyclic: { self: string };
      };
    };
    expect(artifact.payload.requestedToolNames).toEqual(["mcp.doom.start_game"]);
    expect(artifact.payload.missingRequestedToolNames).toEqual([
      "mcp.doom.start_game",
    ]);
    expect(artifact.payload.cyclic.self).toBe("[circular]");

    rmSync(ref!.path, { force: true });
    rmSync(dirname(ref!.path), { recursive: true, force: true });
  });
});
