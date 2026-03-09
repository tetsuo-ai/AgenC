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

function createService(logContents = ""): ObservabilityService {
  const daemonLogPath = join(tempDir, "daemon.log");
  writeFileSync(daemonLogPath, logContents, "utf8");
  return new ObservabilityService({
    dbPath: join(tempDir, "observability.sqlite"),
    daemonLogPath,
  });
}

async function expectCompletedTraceState(
  service: ObservabilityService,
  traceId: string,
  lastEventName: string,
): Promise<void> {
  const traces = await service.listTraces();
  expect(traces).toHaveLength(1);
  expect(traces[0]?.traceId).toBe(traceId);
  expect(traces[0]?.status).toBe("completed");

  const detail = await service.getTrace(traceId);
  expect(detail?.summary.status).toBe("completed");
  expect(detail?.summary.lastEventName).toBe(lastEventName);
  expect(detail?.completeness.complete).toBe(true);

  const summary = await service.getSummary();
  expect(summary.traces.total).toBe(1);
  expect(summary.traces.completed).toBe(1);
  expect(summary.traces.open).toBe(0);
}

sqliteDescribe("ObservabilityService", () => {
  it("persists trace events and returns summaries/details", async () => {
    const artifact = persistTracePayloadArtifact({
      traceId: "trace-1",
      eventName: "webchat.provider.request",
      payload: { payload: { ok: true } },
    });
    expect(artifact?.path).toBeTruthy();
    const service = createService("line-1\nline-2 trace-1\n");

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
    expect(logs.path).toBe("daemon.log");
    expect(logs.lines).toEqual(["line-2 trace-1"]);

    await service.close();
  });

  it("marks traces incomplete when no terminal event is recorded", async () => {
    const service = createService();

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
    const service = createService();
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

    await expectCompletedTraceState(
      service,
      "trace-command",
      "webchat.command.handled",
    );

    await service.close();
  });

  it("treats working background cycle traces as completed cycle traces", async () => {
    const service = createService();
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

    await expectCompletedTraceState(
      service,
      "trace-background-cycle",
      "background_run.cycle.working_applied",
    );

    await service.close();
  });
});
