import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
  logStructuredTraceEvent,
} from "./provider-trace-logger.js";

describe("createProviderTraceEventLogger", () => {
  it("serializes nested payloads as single-line JSON", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      setLevel: vi.fn(),
    };

    const logEvent = createProviderTraceEventLogger({
      logger,
      traceLabel: "webchat.provider",
      traceId: "trace-1",
      sessionId: "session-1",
      staticFields: { stage: "test" },
    });

    logEvent({
      kind: "request",
      transport: "chat",
      provider: "grok",
      model: "grok-test",
      callIndex: 2,
      callPhase: "evaluator",
      payload: {
        tool_choice: "required",
        nested: {
          ok: true,
        },
      },
      context: {
        requestedToolNames: ["system.bash"],
        resolvedToolNames: ["system.bash"],
      },
    });

    expect(logger.info).toHaveBeenCalledOnce();
    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain("[trace] webchat.provider.request ");
    expect(line).toContain('"traceId":"trace-1"');
    expect(line).toContain('"stage":"test"');
    expect(line).toContain('"callPhase":"evaluator"');
    expect(line).toContain('"contextPreview"');
    expect(line).toContain('"payloadPreview"');
    expect(line).toContain('"tool_choice":"required"');
    expect(line).toContain('"ok":true');
    expect(line).not.toContain("[Object]");
    const payloadArtifactMatch = line.match(
      /"payloadArtifact":\{"path":"([^"]+)"/,
    );
    expect(payloadArtifactMatch?.[1]).toBeTruthy();
    const artifactPath = payloadArtifactMatch?.[1];
    expect(artifactPath).toBeTruthy();
    const artifact = JSON.parse(readFileSync(artifactPath!, "utf8")) as {
      payload: {
        payload?: { nested?: { ok?: boolean }; tool_choice?: string };
        context?: { requestedToolNames?: string[] };
      };
    };
    expect(artifact.payload.payload?.tool_choice).toBe("required");
    expect(artifact.payload.payload?.nested?.ok).toBe(true);
    expect(artifact.payload.context?.requestedToolNames).toEqual(["system.bash"]);
    rmSync(artifactPath!, { force: true });
  });

  it("preserves duplicate trace context arrays in persisted artifacts", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      setLevel: vi.fn(),
    };

    const shared = ["mcp.doom.start_game"];
    const logEvent = createProviderTraceEventLogger({
      logger,
      traceLabel: "webchat.provider",
      traceId: "trace-shared",
      sessionId: "session-shared",
    });

    logEvent({
      kind: "request",
      transport: "chat",
      provider: "grok",
      model: "grok-test",
      payload: { tool_choice: "required" },
      context: {
        requestedToolNames: shared,
        resolvedToolNames: [],
        missingRequestedToolNames: shared,
        toolResolution: "fallback_full_catalog_no_matches",
      },
    });

    const line = logger.info.mock.calls[0]?.[0] as string;
    const payloadArtifactMatch = line.match(
      /"payloadArtifact":\{"path":"([^"]+)"/,
    );
    expect(payloadArtifactMatch?.[1]).toBeTruthy();
    const artifactPath = payloadArtifactMatch?.[1]!;
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      payload: {
        context?: {
          requestedToolNames?: string[];
          missingRequestedToolNames?: string[];
        };
      };
    };
    expect(artifact.payload.context?.requestedToolNames).toEqual([
      "mcp.doom.start_game",
    ]);
    expect(artifact.payload.context?.missingRequestedToolNames).toEqual([
      "mcp.doom.start_game",
    ]);
    rmSync(artifactPath, { force: true });
  });

  it("serializes execution trace events as single-line JSON", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      setLevel: vi.fn(),
    };

    const logEvent = createExecutionTraceEventLogger({
      logger,
      traceLabel: "webchat.executor",
      traceId: "trace-2",
      sessionId: "session-2",
    });

    logEvent({
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: 3,
      payload: {
        tool: "mcp.doom.new_episode",
        routingMiss: true,
      },
    });

    expect(logger.info).toHaveBeenCalledOnce();
    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain("[trace] webchat.executor.tool_rejected ");
    expect(line).toContain('"traceId":"trace-2"');
    expect(line).toContain('"callIndex":3');
    expect(line).toContain('"callPhase":"tool_followup"');
    expect(line).toContain('"mcp.doom.new_episode"');
    expect(line).not.toContain("[Object]");
    const payloadArtifactMatch = line.match(
      /"payloadArtifact":\{"path":"([^"]+)"/,
    );
    expect(payloadArtifactMatch?.[1]).toBeTruthy();
    rmSync(payloadArtifactMatch![1], { force: true });
  });

  it("serializes structured runtime trace events as single-line JSON", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      setLevel: vi.fn(),
    };

    logStructuredTraceEvent({
      logger,
      traceLabel: "background_run.cycle",
      traceId: "trace-3",
      sessionId: "session-3",
      eventType: "decision_resolved",
      payload: {
        decisionState: "blocked",
        actor: {
          present: true,
          stopReason: "completed",
        },
      },
      staticFields: {
        runId: "bg-1",
        cycleCount: 3,
      },
    });

    expect(logger.info).toHaveBeenCalledOnce();
    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain("[trace] background_run.cycle.decision_resolved ");
    expect(line).toContain('"traceId":"trace-3"');
    expect(line).toContain('"runId":"bg-1"');
    expect(line).toContain('"cycleCount":3');
    expect(line).toContain('"decisionState":"blocked"');
    const payloadArtifactMatch = line.match(
      /"payloadArtifact":\{"path":"([^"]+)"/,
    );
    expect(payloadArtifactMatch?.[1]).toBeTruthy();
    rmSync(payloadArtifactMatch![1], { force: true });
  });
});
