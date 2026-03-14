import { describe, expect, it } from "vitest";
import {
  normalizeOperatorMessage,
  projectOperatorSurfaceEvent,
  shouldIgnoreOperatorMessage,
} from "./operator-events.js";

describe("operator event normalization", () => {
  it("unwraps wrapped planner events", () => {
    expect(
      normalizeOperatorMessage({
        type: "events.event",
        payload: {
          eventType: "planner_step_started",
          data: {
            sessionId: "session:abc123",
            stepName: "Compile",
            tool: "system.bash",
            args: { command: "npm", args: ["test"] },
          },
        },
      }),
    ).toEqual({
      type: "planner_step_started",
      kind: "planner",
      transportType: "events.event",
      wrapped: true,
      payload: {
        sessionId: "session:abc123",
        stepName: "Compile",
        tool: "system.bash",
        args: { command: "npm", args: ["test"] },
      },
      data: {
        sessionId: "session:abc123",
        stepName: "Compile",
        tool: "system.bash",
        args: { command: "npm", args: ["test"] },
      },
      sessionIds: ["session:abc123"],
      sessionId: "session:abc123",
    });
  });

  it("normalizes direct and wrapped subagent events to the same semantic shape", () => {
    const direct = normalizeOperatorMessage({
      type: "subagents.completed",
      payload: {
        sessionId: "parent-1",
        parentSessionId: "parent-1",
        subagentSessionId: "subagent:2",
        toolName: "execute_with_agent",
        timestamp: 123,
        data: {
          objective: "Inspect runtime",
          stepName: "Research",
          output: "done",
        },
      },
    });
    const wrapped = normalizeOperatorMessage({
      type: "events.event",
      payload: {
        eventType: "subagents.completed",
        data: {
          sessionId: "parent-1",
          parentSessionId: "parent-1",
          subagentSessionId: "subagent:2",
          toolName: "execute_with_agent",
          timestamp: 123,
          objective: "Inspect runtime",
          stepName: "Research",
          output: "done",
        },
      },
    });

    expect({
      type: direct.type,
      kind: direct.kind,
      data: direct.data,
      sessionIds: direct.sessionIds,
      sessionId: direct.sessionId,
      parentSessionId: direct.parentSessionId,
      subagentSessionId: direct.subagentSessionId,
      toolName: direct.toolName,
      timestamp: direct.timestamp,
    }).toEqual({
      type: wrapped.type,
      kind: wrapped.kind,
      data: wrapped.data,
      sessionIds: wrapped.sessionIds,
      sessionId: wrapped.sessionId,
      parentSessionId: wrapped.parentSessionId,
      subagentSessionId: wrapped.subagentSessionId,
      toolName: wrapped.toolName,
      timestamp: wrapped.timestamp,
    });
  });

  it("keeps tool events intact", () => {
    expect(
      normalizeOperatorMessage({
        type: "tools.result",
        payload: {
          toolName: "system.bash",
          result: "ok",
          durationMs: 12,
          isError: false,
          subagentSessionId: "subagent:2",
        },
      }),
    ).toEqual({
      type: "tools.result",
      kind: "tool",
      transportType: "tools.result",
      wrapped: false,
      payload: {
        toolName: "system.bash",
        result: "ok",
        durationMs: 12,
        isError: false,
        subagentSessionId: "subagent:2",
      },
      data: {
        toolName: "system.bash",
        result: "ok",
        durationMs: 12,
        isError: false,
        subagentSessionId: "subagent:2",
      },
      sessionIds: [],
      subagentSessionId: "subagent:2",
      toolName: "system.bash",
    });
  });

  it("uses parent session ids for delegated events", () => {
    const message = {
      type: "subagents.progress",
      payload: {
        parentSessionId: "session:abc123",
        subagentSessionId: "subagent:2",
        timestamp: 456,
        data: {
          elapsedMs: 1200,
        },
      },
    };

    expect(shouldIgnoreOperatorMessage(message, "abc123")).toBe(false);
    expect(shouldIgnoreOperatorMessage(message, "session:abc123")).toBe(false);
    expect(shouldIgnoreOperatorMessage(message, "other-session")).toBe(true);
  });

  it("tolerates wrapped events without eventType", () => {
    expect(
      normalizeOperatorMessage({
        type: "events.event",
        payload: {
          data: {
            sessionId: "session:abc123",
            state: "running",
          },
        },
      }),
    ).toEqual({
      type: "events.event",
      kind: "unknown",
      transportType: "events.event",
      wrapped: true,
      payload: {
        sessionId: "session:abc123",
        state: "running",
      },
      data: {
        sessionId: "session:abc123",
        state: "running",
      },
      sessionIds: ["session:abc123"],
      sessionId: "session:abc123",
    });
  });

  it("tolerates wrapped events with non-object payloads", () => {
    expect(
      normalizeOperatorMessage({
        type: "events.event",
        payload: "oops",
      }),
    ).toEqual({
      type: "events.event",
      kind: "unknown",
      transportType: "events.event",
      wrapped: true,
      payload: "oops",
      data: {},
      sessionIds: [],
    });
  });

  it("tolerates wrapped events missing data", () => {
    expect(
      normalizeOperatorMessage({
        type: "events.event",
        payload: {
          eventType: "subagents.progress",
        },
      }),
    ).toEqual({
      type: "subagents.progress",
      kind: "subagent",
      transportType: "events.event",
      wrapped: true,
      payload: {},
      data: {},
      sessionIds: [],
    });
  });

  it("projects semantic surface-event families for control-plane and lifecycle messages", () => {
    expect(
      projectOperatorSurfaceEvent({
        type: "events.subscribed",
        payload: { active: true, filters: ["subagents.*"] },
      }),
    ).toMatchObject({
      family: "subscription",
      type: "events.subscribed",
      payloadRecord: { active: true, filters: ["subagents.*"] },
      payloadList: null,
      isSessionScoped: false,
    });

    expect(
      projectOperatorSurfaceEvent({
        type: "chat.sessions",
        payload: [{ sessionId: "session:1" }],
      }),
    ).toMatchObject({
      family: "session",
      type: "chat.sessions",
      payloadRecord: {},
      payloadList: [{ sessionId: "session:1" }],
      isSessionScoped: false,
    });

    expect(
      projectOperatorSurfaceEvent({
        type: "subagents.progress",
        payload: {
          parentSessionId: "session:1",
          subagentSessionId: "subagent:1",
          timestamp: 42,
          data: { elapsedMs: 1200 },
        },
      }),
    ).toMatchObject({
      family: "subagent",
      type: "subagents.progress",
      isSessionScoped: true,
    });
  });

  it("preserves top-level error strings on normalized messages and surface events", () => {
    const normalized = normalizeOperatorMessage({
      type: "error",
      error: "boom",
      payload: {
        code: "E_RUNTIME",
      },
    });
    const surface = projectOperatorSurfaceEvent(normalized);

    expect(normalized.error).toBe("boom");
    expect(surface).toMatchObject({
      family: "error",
      type: "error",
      payloadRecord: { code: "E_RUNTIME" },
      message: {
        error: "boom",
      },
    });
  });
});
