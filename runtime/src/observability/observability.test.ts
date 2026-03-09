import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ObservabilityService } from "./observability.js";
import { persistTracePayloadArtifact } from "../utils/trace-payload-store.js";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `agenc-observability-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function hasSqliteDependency(): boolean {
  try {
    require.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

const sqliteDescribe = hasSqliteDependency() ? describe : describe.skip;

sqliteDescribe("ObservabilityService", () => {
  it("persists trace events and returns summaries/details", async () => {
    const artifact = persistTracePayloadArtifact({
      traceId: "trace-1",
      eventName: "webchat.provider.request",
      payload: { payload: { ok: true } },
    });
    expect(artifact?.path).toBeTruthy();
    const logPath = join(tempDir, "daemon.log");
    writeFileSync(logPath, "line-1\nline-2 trace-1\n", "utf8");

    const service = new ObservabilityService({
      dbPath: join(tempDir, "observability.sqlite"),
      daemonLogPath: logPath,
    });

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-1",
      sessionId: "session-1",
      payloadPreview: { ok: true },
      rawPayload: { sessionId: "session-1" },
      artifact,
    });
    service.recordEvent({
      eventName: "webchat.chat.response",
      level: "info",
      traceId: "trace-1",
      sessionId: "session-1",
      payloadPreview: { stopReason: "completed" },
      rawPayload: { stopReason: "completed" },
    });

    const traces = await service.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe("trace-1");
    expect(traces[0]?.status).toBe("completed");

    const detail = await service.getTrace("trace-1");
    expect(detail?.events).toHaveLength(2);
    expect(detail?.completeness.complete).toBe(true);

    const summary = await service.getSummary();
    expect(summary.traces.total).toBe(1);
    expect(summary.traces.completed).toBe(1);

    const artifactBody = await service.getArtifact(artifact!.path);
    expect((artifactBody.body as Record<string, unknown>).payload).toEqual({
      payload: { ok: true },
    });

    const logs = await service.getLogTail({ lines: 10, traceId: "trace-1" });
    expect(logs.lines).toEqual(["line-2 trace-1"]);

    await service.close();
  });

  it("marks traces incomplete when no terminal event is recorded", async () => {
    const service = new ObservabilityService({
      dbPath: join(tempDir, "observability.sqlite"),
      daemonLogPath: join(tempDir, "daemon.log"),
    });
    writeFileSync(join(tempDir, "daemon.log"), "", "utf8");

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-open",
      payloadPreview: {},
    });

    const detail = await service.getTrace("trace-open");
    expect(detail?.summary.status).toBe("open");
    expect(detail?.completeness.complete).toBe(false);
    expect(detail?.completeness.issues[0]).toContain("no terminal");

    await service.close();
  });

  it("treats handled slash-command traces as completed terminal traces", async () => {
    const service = new ObservabilityService({
      dbPath: join(tempDir, "observability.sqlite"),
      daemonLogPath: join(tempDir, "daemon.log"),
    });
    writeFileSync(join(tempDir, "daemon.log"), "", "utf8");
    const now = Date.now();

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now,
      payloadPreview: { content: "/policy simulate system.delete {}" },
    });
    service.recordEvent({
      eventName: "webchat.command.reply",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now + 1,
      payloadPreview: { content: "Policy simulation..." },
    });
    service.recordEvent({
      eventName: "webchat.command.handled",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now + 2,
      payloadPreview: { command: "/policy simulate system.delete {}" },
    });

    const traces = await service.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe("trace-command");
    expect(traces[0]?.status).toBe("completed");

    const detail = await service.getTrace("trace-command");
    expect(detail?.summary.status).toBe("completed");
    expect(detail?.summary.lastEventName).toBe("webchat.command.handled");
    expect(detail?.completeness.complete).toBe(true);

    const summary = await service.getSummary();
    expect(summary.traces.total).toBe(1);
    expect(summary.traces.completed).toBe(1);
    expect(summary.traces.open).toBe(0);

    await service.close();
  });

  it("treats working background cycle traces as completed cycle traces", async () => {
    const service = new ObservabilityService({
      dbPath: join(tempDir, "observability.sqlite"),
      daemonLogPath: join(tempDir, "daemon.log"),
    });
    writeFileSync(join(tempDir, "daemon.log"), "", "utf8");
    const now = Date.now();

    service.recordEvent({
      eventName: "background_run.cycle.decision_resolved",
      level: "info",
      traceId: "trace-background-cycle",
      sessionId: "session-1",
      channel: "background_run",
      timestampMs: now,
      payloadPreview: { decisionState: "working" },
    });
    service.recordEvent({
      eventName: "background_run.cycle.working_applied",
      level: "info",
      traceId: "trace-background-cycle",
      sessionId: "session-1",
      channel: "background_run",
      timestampMs: now + 1,
      payloadPreview: { summary: "Managed process is still running." },
    });

    const traces = await service.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe("trace-background-cycle");
    expect(traces[0]?.status).toBe("completed");

    const detail = await service.getTrace("trace-background-cycle");
    expect(detail?.summary.status).toBe("completed");
    expect(detail?.summary.lastEventName).toBe("background_run.cycle.working_applied");
    expect(detail?.completeness.complete).toBe(true);

    const summary = await service.getSummary();
    expect(summary.traces.total).toBe(1);
    expect(summary.traces.completed).toBe(1);
    expect(summary.traces.open).toBe(0);

    await service.close();
  });

  it("filters trace listings and summaries by session scope", async () => {
    const service = new ObservabilityService({
      dbPath: join(tempDir, "observability.sqlite"),
      daemonLogPath: join(tempDir, "daemon.log"),
    });
    writeFileSync(join(tempDir, "daemon.log"), "", "utf8");
    const now = Date.now();

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-owned",
      sessionId: "session-owned",
      timestampMs: now,
      payloadPreview: {},
      rawPayload: { toolName: "system.fs.read" },
    });
    service.recordEvent({
      eventName: "webchat.chat.response",
      level: "info",
      traceId: "trace-owned",
      sessionId: "session-owned",
      timestampMs: now + 1,
      payloadPreview: { stopReason: "completed" },
      rawPayload: { stopReason: "completed" },
    });

    service.recordEvent({
      eventName: "webchat.provider.error",
      level: "error",
      traceId: "trace-foreign",
      sessionId: "session-foreign",
      timestampMs: now + 2,
      payloadPreview: {},
      rawPayload: { toolName: "system.browserSessionResume" },
    });

    const scopedTraces = await service.listTraces({
      sessionIds: ["session-owned"],
    });
    expect(scopedTraces).toHaveLength(1);
    expect(scopedTraces[0]?.traceId).toBe("trace-owned");

    const scopedSummary = await service.getSummary({
      sessionIds: ["session-owned"],
    });
    expect(scopedSummary.traces.total).toBe(1);
    expect(scopedSummary.traces.completed).toBe(1);
    expect(scopedSummary.traces.errors).toBe(0);
    expect(scopedSummary.events.providerErrors).toBe(0);
    expect(scopedSummary.topStopReasons).toEqual([{ name: "completed", count: 1 }]);

    await service.close();
  });
});
