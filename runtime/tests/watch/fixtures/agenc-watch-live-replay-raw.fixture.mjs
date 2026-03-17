function freeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freeze(entry)));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, freeze(entry)]),
      ),
    );
  }
  return value;
}

function directEnvelope(type, payload, id) {
  return freeze({
    type,
    payload,
    ...(id ? { id } : {}),
  });
}

function wrappedEnvelope(eventType, data, options = {}) {
  const { timestamp = 0, traceId, parentTraceId, id } = options;
  return freeze({
    type: "events.event",
    payload: {
      eventType,
      data,
      timestamp,
      ...(traceId ? { traceId } : {}),
      ...(parentTraceId ? { parentTraceId } : {}),
    },
    ...(id ? { id } : {}),
  });
}

function openSocketStep() {
  return freeze({ kind: "open" });
}

function closeSocketStep() {
  return freeze({ kind: "close" });
}

function socketMessageStep(message) {
  return freeze({ kind: "socket", message });
}

function inputStep(value) {
  return freeze({ kind: "input", value });
}

function flushStep() {
  return freeze({ kind: "flush" });
}

function captureStep(label) {
  return freeze({ kind: "capture", label });
}

export const WATCH_LIVE_REPLAY_RAW_SCENARIOS = freeze({
  bootstrapChat: {
    width: 110,
    height: 24,
    startMs: Date.UTC(2026, 2, 14, 12, 0, 0),
    scenario: "bootstrap-chat",
    steps: [
      openSocketStep(),
      socketMessageStep(
        directEnvelope("status.update", {
          state: "live",
          llmProvider: "grok",
          llmModel: "grok-4.20-beta-0309-reasoning",
          backgroundRuns: {
            enabled: true,
            operatorAvailable: true,
            activeTotal: 0,
            queuedSignalsTotal: 0,
          },
        }),
      ),
      socketMessageStep(
        directEnvelope("chat.session", {
          sessionId: "session-live-1",
        }),
      ),
      captureStep("ready"),
      inputStep("show me a linked list in c\r"),
      flushStep(),
      captureStep("prompt"),
      socketMessageStep(
        directEnvelope("chat.stream", {
          content: "Linked List in C\n\n```c\n#include <stdio.h>",
          done: false,
        }),
      ),
      captureStep("stream"),
      socketMessageStep(
        directEnvelope("chat.message", {
          content:
            "Linked List in C\n\n```c\n#include <stdio.h>\nint main(void) {\n  return 0;\n}\n```",
        }),
      ),
      captureStep("final"),
    ],
  },
  plannerSubagent: {
    width: 128,
    height: 26,
    startMs: Date.UTC(2026, 2, 14, 12, 5, 0),
    scenario: "planner-subagent",
    steps: [
      openSocketStep(),
      socketMessageStep(
        directEnvelope("status.update", {
          state: "live",
          llmProvider: "grok",
          llmModel: "grok-4.20-beta-0309-reasoning",
          backgroundRuns: {
            enabled: true,
            operatorAvailable: true,
            activeTotal: 1,
            queuedSignalsTotal: 2,
          },
        }),
      ),
      socketMessageStep(
        directEnvelope("chat.session", {
          sessionId: "session-plan-1",
        }),
      ),
      inputStep("ship operator console polish\r"),
      flushStep(),
      socketMessageStep(
        wrappedEnvelope(
          "planner_plan_parsed",
          {
            sessionId: "session-plan-1",
            pipelineId: "pipe-1",
            routeReason: "delegating for verification",
            steps: [
              {
                name: "Inspect runtime",
                objective: "Inspect runtime",
                stepType: "subagent_task",
              },
              {
                name: "Patch frame",
                objective: "Patch frame",
                stepType: "deterministic_tool",
                dependsOn: ["Inspect runtime"],
              },
            ],
            edges: [{ from: "Inspect runtime", to: "Patch frame" }],
          },
          { timestamp: Date.UTC(2026, 2, 14, 12, 5, 1) },
        ),
      ),
      socketMessageStep(
        wrappedEnvelope(
          "planner_pipeline_started",
          {
            sessionId: "session-plan-1",
            pipelineId: "pipe-1",
            routeReason: "delegating for verification",
          },
          { timestamp: Date.UTC(2026, 2, 14, 12, 5, 1) },
        ),
      ),
      socketMessageStep(
        wrappedEnvelope(
          "planner_step_started",
          {
            sessionId: "session-plan-1",
            pipelineId: "pipe-1",
            stepName: "Inspect runtime",
            tool: "spawn_agent",
            args: { objective: "Inspect runtime" },
          },
          { timestamp: Date.UTC(2026, 2, 14, 12, 5, 1) },
        ),
      ),
      socketMessageStep(
        wrappedEnvelope(
          "subagents.spawned",
          {
            parentSessionId: "session-plan-1",
            subagentSessionId: "subagent:child-1",
            stepName: "Inspect runtime",
            objective: "Inspect runtime",
            workingDirectory: "/home/tetsuo/git/AgenC/runtime",
            tools: ["system.bash", "system.writeFile"],
          },
          {
            timestamp: Date.UTC(2026, 2, 14, 12, 5, 1),
            traceId: "trace-child-1",
            parentTraceId: "trace-parent-1",
          },
        ),
      ),
      socketMessageStep(
        wrappedEnvelope(
          "subagents.tool.executing",
          {
            parentSessionId: "session-plan-1",
            subagentSessionId: "subagent:child-1",
            toolName: "system.bash",
            stepName: "Inspect runtime",
            objective: "Inspect runtime",
            args: { command: "pwd" },
          },
          {
            timestamp: Date.UTC(2026, 2, 14, 12, 5, 1),
            traceId: "trace-child-1",
            parentTraceId: "trace-parent-1",
          },
        ),
      ),
      captureStep("delegating"),
      socketMessageStep(
        wrappedEnvelope(
          "subagents.progress",
          {
            parentSessionId: "session-plan-1",
            subagentSessionId: "subagent:child-1",
            stepName: "Inspect runtime",
            objective: "Inspect runtime",
            elapsedMs: 42000,
          },
          {
            timestamp: Date.UTC(2026, 2, 14, 12, 5, 43),
            traceId: "trace-child-1",
            parentTraceId: "trace-parent-1",
          },
        ),
      ),
      captureStep("child-progress"),
    ],
  },
  reconnect: {
    width: 96,
    height: 20,
    startMs: Date.UTC(2026, 2, 14, 12, 10, 0),
    scenario: "reconnect",
    steps: [
      openSocketStep(),
      socketMessageStep(
        directEnvelope("status.update", {
          state: "live",
          llmProvider: "grok",
          llmModel: "grok-4.20-beta-0309-reasoning",
          backgroundRuns: {
            enabled: true,
            operatorAvailable: true,
            activeTotal: 0,
            queuedSignalsTotal: 1,
          },
        }),
      ),
      socketMessageStep(
        directEnvelope("chat.session", {
          sessionId: "session-reconnect-1",
        }),
      ),
      captureStep("live"),
      closeSocketStep(),
      captureStep("reconnecting"),
      flushStep(),
      openSocketStep(),
      socketMessageStep(
        directEnvelope("status.update", {
          state: "live",
          llmProvider: "grok",
          llmModel: "grok-4.20-beta-0309-reasoning",
          backgroundRuns: {
            enabled: true,
            operatorAvailable: true,
            activeTotal: 0,
            queuedSignalsTotal: 1,
          },
        }),
      ),
      socketMessageStep(
        directEnvelope("chat.session", {
          sessionId: "session-reconnect-1",
        }),
      ),
      captureStep("reconnected"),
    ],
  },
});
