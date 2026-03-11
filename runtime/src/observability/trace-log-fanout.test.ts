import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TraceLogFanout,
  classifyTraceLogFanoutCategories,
  deriveTraceLogFanoutPaths,
} from "./trace-log-fanout.js";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `agenc-trace-fanout-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("deriveTraceLogFanoutPaths", () => {
  it("derives sibling files from a standard daemon log path", () => {
    const paths = deriveTraceLogFanoutPaths(join(tempDir, "daemon.log"));

    expect(paths.errors).toBe(join(tempDir, "daemon.errors.log"));
    expect(paths.provider).toBe(join(tempDir, "daemon.provider.log"));
    expect(paths.executor).toBe(join(tempDir, "daemon.executor.log"));
    expect(paths.subagents).toBe(join(tempDir, "daemon.subagents.log"));
  });

  it("adds a log suffix when the daemon path has no extension", () => {
    const paths = deriveTraceLogFanoutPaths(join(tempDir, "agent-1"));

    expect(paths.provider).toBe(join(tempDir, "agent-1.provider.log"));
  });
});

describe("classifyTraceLogFanoutCategories", () => {
  it("routes error/provider/executor/subagent concerns into stable categories", () => {
    expect(
      classifyTraceLogFanoutCategories({
        eventName: "webchat.provider.error",
        level: "error",
      }),
    ).toEqual(["errors", "provider"]);

    expect(
      classifyTraceLogFanoutCategories({
        eventName: "webchat.executor.tool_dispatch_finished",
        level: "info",
      }),
    ).toEqual(["executor"]);

    expect(
      classifyTraceLogFanoutCategories({
        eventName: "webchat.subagents.completed",
        level: "info",
      }),
    ).toEqual(["subagents"]);

    expect(
      classifyTraceLogFanoutCategories({
        eventName: "sub_agent.executor.tool_dispatch_finished",
        level: "info",
      }),
    ).toEqual(["executor", "subagents"]);
  });
});

describe("TraceLogFanout", () => {
  it("writes a single trace event to every matching derived view", async () => {
    const fanout = new TraceLogFanout({
      enabled: true,
      daemonLogPath: join(tempDir, "daemon.log"),
    });

    await fanout.writeEvent({
      id: "trace-1:event-1",
      eventName: "webchat.provider.error",
      level: "error",
      traceId: "trace-1",
      sessionId: "session-1",
      timestampMs: 1_773_184_952_570,
      routingMiss: false,
      payloadPreview: {
        traceId: "trace-1",
        sessionId: "session-1",
        provider: "grok",
      },
    });
    await fanout.close();

    expect(readFileSync(join(tempDir, "daemon.errors.log"), "utf8")).toContain(
      "webchat.provider.error",
    );
    expect(readFileSync(join(tempDir, "daemon.provider.log"), "utf8")).toContain(
      "\"provider\":\"grok\"",
    );
  });
});
