import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutonomyStages,
  deriveRunPort,
  evaluateAutonomyStage,
  isTypedHandleTool,
  normalizeInteractiveInput,
  parseStageSelection,
  pickLatestSession,
  pickTrackedSession,
  pickLatestTrace,
  replaceRunVariables,
  replaceRunToken,
} from "./lib/agenc-autonomy-ladder.mjs";

test("replaceRunToken substitutes every placeholder", () => {
  assert.equal(
    replaceRunToken("RUN_TOKEN::RUN_TOKEN", "abc123"),
    "abc123::abc123",
  );
});

test("replaceRunVariables substitutes token and derived port placeholders", () => {
  const port = deriveRunPort("abc123");
  assert.equal(
    replaceRunVariables("RUN_TOKEN::RUN_PORT", "abc123", port),
    `abc123::${port}`,
  );
});

test("normalizeInteractiveInput flattens multiline prompts for the tmux TUI", () => {
  assert.equal(
    normalizeInteractiveInput("line one\n\n  line two\n- bullet"),
    "line one line two - bullet",
  );
});

test("parseStageSelection expands ranges and dedupes ids", () => {
  const stages = buildAutonomyStages("token");
  const selected = parseStageSelection("0-2,2,4", stages);
  assert.deepEqual(
    selected.map((stage) => stage.id),
    ["0", "1", "2", "4"],
  );
});

test("buildAutonomyStages supports the server scenario", () => {
  const stages = buildAutonomyStages("token", "server");
  assert.deepEqual(
    stages.map((stage) => stage.id),
    ["srv1", "srv2", "srv3", "srv4", "srv5"],
  );
  assert.match(stages[0].actions[0].input, /http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(stages[0].actions[0].input, /system.*server|typed server handle tools/i);
});

test("buildAutonomyStages supports the spreadsheet scenario", () => {
  const stages = buildAutonomyStages("token", "spreadsheet");
  assert.deepEqual(stages.map((stage) => stage.id), ["sheet1"]);
  assert.match(stages[0].actions[0].input, /typed spreadsheet tools/i);
  assert.match(stages[0].actions[0].input, /roster\.xlsx/i);
});

test("buildAutonomyStages supports the office-document scenario", () => {
  const stages = buildAutonomyStages("token", "office-document");
  assert.deepEqual(stages.map((stage) => stage.id), ["doc1"]);
  assert.match(stages[0].actions[0].input, /typed office document tools/i);
  assert.match(stages[0].actions[0].input, /launch-brief\.docx/i);
});

test("buildAutonomyStages supports the productivity scenario", () => {
  const stages = buildAutonomyStages("token", "productivity");
  assert.deepEqual(stages.map((stage) => stage.id), ["mail1", "cal1"]);
  assert.match(stages[0].actions[0].input, /typed email message tools/i);
  assert.match(stages[1].actions[0].input, /typed calendar tools/i);
  assert.equal(stages[0].timeoutMs, 35_000);
  assert.equal(stages[1].timeoutMs, 35_000);
});

test("buildAutonomyStages supports the delegation scenario", () => {
  const stages = buildAutonomyStages("token", "delegation");
  assert.deepEqual(stages.map((stage) => stage.id), ["del1"]);
  assert.match(stages[0].actions[0].input, /execute_with_agent/i);
  assert.match(stages[0].actions[0].input, /system\.bash/i);
  assert.match(stages[0].actions[0].input, /\/bin\/pwd/i);
});

test("pickLatestSession returns the most recent session", () => {
  const latest = pickLatestSession([
    { sessionId: "older", lastActiveAt: 10 },
    { sessionId: "newer", lastActiveAt: 20 },
  ]);
  assert.equal(latest.sessionId, "newer");
});

test("pickTrackedSession prefers the current tracked session when present", () => {
  const tracked = pickTrackedSession(
    [
      { sessionId: "older", lastActiveAt: 10 },
      { sessionId: "tracked", lastActiveAt: 5 },
      { sessionId: "newer", lastActiveAt: 20 },
    ],
    "tracked",
  );
  assert.equal(tracked.sessionId, "tracked");
});

test("pickLatestTrace prefers traces at or after the stage start", () => {
  const picked = pickLatestTrace(
    [
      { traceId: "old", updatedAt: 10 },
      { traceId: "new", updatedAt: 30 },
    ],
    20,
  );
  assert.equal(picked.traceId, "new");
});

test("pickLatestTrace prefers the parent session trace over newer subtraces", () => {
  const picked = pickLatestTrace(
    [
      { traceId: "session-1:root:sub:child-2", updatedAt: 40 },
      { traceId: "session-1:root", updatedAt: 35 },
      { traceId: "session-1:root:sub:child-1", updatedAt: 30 },
    ],
    20,
  );
  assert.equal(picked.traceId, "session-1:root");
});

test("pickLatestTrace does not fall back to stale traces before the stage start", () => {
  const picked = pickLatestTrace(
    [
      { traceId: "session-1:root", updatedAt: 30 },
      { traceId: "session-1:root:sub:child-1", updatedAt: 40 },
    ],
    50,
  );
  assert.equal(picked, undefined);
});

test("isTypedHandleTool recognizes structured long-lived tools", () => {
  assert.equal(isTypedHandleTool("system.processStart"), true);
  assert.equal(isTypedHandleTool("desktop.process_start"), true);
  assert.equal(isTypedHandleTool("system.bash"), false);
});

test("evaluateAutonomyStage stage0 rejects tool usage", () => {
  const result = evaluateAutonomyStage("stage0", {
    runToken: "abc",
    paneText: "AUTONOMY_STAGE0::abc",
    traceDetail: {
      summary: { status: "completed" },
      events: [{ toolName: "system.bash" }],
    },
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /no-tool stage/i);
});

test("evaluateAutonomyStage stage0 waits for a completed trace", () => {
  const result = evaluateAutonomyStage("stage0", {
    runToken: "abc",
    paneText: "AUTONOMY_STAGE0::abc",
    traceDetail: {
      summary: { status: "open" },
      events: [],
    },
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /completed status/i);
});

test("evaluateAutonomyStage stage4 requires typed handle evidence", () => {
  const result = evaluateAutonomyStage("stage4", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "watching run",
    runDetail: {
      runId: "run-1",
      state: "working",
      lastToolEvidence: "system.processStatus [ok] running",
      observedTargets: [{ processId: "proc-1" }],
    },
    traceDetail: {
      summary: { status: "completed" },
      events: [{ toolName: "system.processStart" }],
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.runId, "run-1");
});

test("evaluateAutonomyStage stage4 accepts typed handle evidence from run state", () => {
  const result = evaluateAutonomyStage("stage4", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "watching run",
    runDetail: {
      runId: "run-1",
      state: "working",
      lastToolEvidence:
        "system.processStatus [ok] {\"processId\":\"proc-1\",\"state\":\"running\"}",
      observedTargets: [{ processId: "proc-1" }],
    },
    traceDetail: {
      summary: { status: "completed" },
      events: [{ toolName: "background.placeholder" }],
    },
    traceText: "",
    runText:
      "{\"lastToolEvidence\":\"system.processStatus [ok] {\\\"processId\\\":\\\"proc-1\\\"}\"}",
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage server_stage_start requires server-handle readiness evidence", () => {
  const result = evaluateAutonomyStage("server_stage_start", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "watching run",
    runDetail: {
      runId: "run-1",
      state: "working",
      observedTargets: [{ processId: "proc-1" }],
    },
    traceDetail: {
      summary: { status: "completed" },
      events: [],
    },
    runText:
      "{\"lastToolEvidence\":\"- system.serverStart [ok] {\\\"serverId\\\":\\\"server-1\\\",\\\"ready\\\":true,\\\"healthUrl\\\":\\\"http://127.0.0.1:9300/\\\"}\\n- system.serverStatus [ok] {\\\"ready\\\":true}\"}",
  });
  assert.equal(result.passed, true);
  assert.equal(result.runId, "run-1");
});

test("evaluateAutonomyStage server_stage_start accepts structured server readiness evidence", () => {
  const result = evaluateAutonomyStage("server_stage_start", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "watching run",
    runDetail: {
      runId: "run-1",
      state: "working",
      observedTargets: [
        {
          kind: "managed_process",
          surface: "host_server",
          processId: "proc-1",
          serverId: "server-1",
          ready: true,
          launchSpec: {
            kind: "server",
            healthUrl: "http://127.0.0.1:9300/",
          },
        },
      ],
      artifacts: [{ source: "system.serverStart" }],
    },
    traceDetail: {
      summary: { status: "completed" },
      events: [],
    },
    runText: "",
  });
  assert.equal(result.passed, true);
  assert.equal(result.runId, "run-1");
});

test("evaluateAutonomyStage stage1 accepts desktop.bash in desktop mode", () => {
  const result = evaluateAutonomyStage("stage1", {
    runToken: "abc",
    paneText: "AUTONOMY_STAGE1::abc",
    traceDetail: {
      summary: { status: "completed" },
      events: [{ toolName: "desktop.bash" }],
    },
    traceText: "desktop.bash",
    runText: "",
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage spreadsheet_stage_read requires typed spreadsheet evidence", () => {
  const result = evaluateAutonomyStage("spreadsheet_stage_read", {
    runToken: "abc",
    paneText:
      "Exact row count: **2**\n- Ada -> admin\n- Linus -> user",
    traceDetail: {
      summary: { status: "completed" },
      events: [
        { toolName: "system.spreadsheetInfo" },
        { toolName: "system.spreadsheetRead" },
      ],
    },
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage office_document_stage_read requires typed office document evidence", () => {
  const result = evaluateAutonomyStage("office_document_stage_read", {
    runToken: "abc",
    paneText:
      "Format: DOCX\nLaunch Brief\nAgenC Smoke\nHello DOCX Brief\nStatus update line two.",
    traceDetail: {
      summary: { status: "completed" },
      events: [
        { toolName: "system.officeDocumentInfo" },
        { toolName: "system.officeDocumentExtractText" },
      ],
    },
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage email_message_stage_read requires typed email evidence", () => {
  const result = evaluateAutonomyStage("email_message_stage_read", {
    runToken: "abc",
    paneText:
      "Sprint update\nalice@example.com\nbob@example.com\nHello team,\nSprint review is at 10:00 AM.",
    traceDetail: {
      summary: { status: "completed" },
      events: [
        { toolName: "system.emailMessageInfo" },
        { toolName: "system.emailMessageExtractText" },
      ],
    },
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage calendar_stage_read requires typed calendar evidence", () => {
  const result = evaluateAutonomyStage("calendar_stage_read", {
    runToken: "abc",
    paneText:
      "Team Calendar\nExact event count: **2**\nProduct Review\nPlanning Day\nbob@example.com\ncarol@example.com",
    traceDetail: {
      summary: { status: "completed" },
      events: [
        { toolName: "system.calendarInfo" },
        { toolName: "system.calendarRead" },
      ],
    },
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage delegation_stage_child requires the full delegated child lifecycle", () => {
  const result = evaluateAutonomyStage("delegation_stage_child", {
    runToken: "abc",
    sessionId: "session-1",
    paneText:
      "Delegated child 4bb58574\n/home/tetsuo/git/AgenC\nexecute_with_agent",
    traceSummaries: [
      { lastEventName: "subagents.spawned" },
      { lastEventName: "subagents.started" },
      { lastEventName: "subagents.tool.executing" },
      { lastEventName: "subagents.tool.result" },
      { lastEventName: "subagents.completed" },
    ],
    traceDetail: {
      summary: {
        status: "completed",
        traceId: "trace-1",
        sessionId: "session-1",
      },
      events: [
        { toolName: "execute_with_agent" },
        { toolName: "system.bash" },
      ],
      completeness: { complete: true, issues: [] },
    },
    traceText: [
      "subagents.spawned",
      "subagents.started",
      "subagents.tool.executing",
      "subagents.tool.result",
      "subagents.completed",
    ].join("\n"),
    runText: "",
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage delegation_stage_child accepts durable parent evidence when tool subtraces rotate out", () => {
  const result = evaluateAutonomyStage("delegation_stage_child", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "Delegated child 4bb58574\n/home/tetsuo/git/AgenC\nexecute_with_agent",
    traceSummaries: [
      { lastEventName: "webchat.chat.response" },
      { lastEventName: "subagents.synthesized" },
      { lastEventName: "subagents.completed" },
      { lastEventName: "subagents.started" },
      { lastEventName: "subagents.spawned" },
    ],
    traceDetail: {
      summary: {
        status: "completed",
        traceId: "trace-1",
        sessionId: "session-1",
      },
      events: [{ toolName: "execute_with_agent" }],
      completeness: { complete: true, issues: [] },
    },
    traceText: [
      "webchat.executor.tool_dispatch_finished",
      "webchat.tool.result",
      "{\"success\":true,\"status\":\"completed\",\"output\":\"/home/tetsuo/git/AgenC\"}",
    ].join("\n"),
    runText: "",
  });
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage delegation_stage_child rejects incomplete delegated child traces", () => {
  const result = evaluateAutonomyStage("delegation_stage_child", {
    runToken: "abc",
    sessionId: "session-1",
    paneText: "Delegated child 4bb58574\n/home/tetsuo/git/AgenC",
    traceSummaries: [
      { lastEventName: "subagents.spawned" },
      { lastEventName: "subagents.started" },
      { lastEventName: "subagents.tool.executing" },
      { lastEventName: "subagents.tool.result" },
    ],
    traceDetail: {
      summary: {
        status: "completed",
        traceId: "trace-1",
        sessionId: "session-1",
      },
      events: [{ toolName: "execute_with_agent" }],
      completeness: { complete: true, issues: [] },
    },
    traceText: [
      "subagents.spawned",
      "subagents.started",
      "subagents.tool.executing",
      "subagents.tool.result",
    ].join("\n"),
    runText: "",
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /full delegated child lifecycle/i);
});

test("evaluateAutonomyStage stage7 preserves the durable run id across restart", () => {
  const result = evaluateAutonomyStage(
    "stage7",
    {
      runToken: "abc",
      sessionId: "session-1",
      paneText: "session healthy session-1",
      runDetail: {
        runId: "run-1",
        state: "working",
      },
    },
    { runId: "run-1" },
  );
  assert.equal(result.passed, true);
});

test("evaluateAutonomyStage stage7 rejects a still-reconnecting operator console", () => {
  const result = evaluateAutonomyStage(
    "stage7",
    {
      runToken: "abc",
      sessionId: "session-1",
      paneText: "[LINK] reconnecting\nUnknown message type: chat.new",
      runDetail: {
        runId: "run-1",
        state: "working",
      },
    },
    { runId: "run-1" },
  );
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /operator console/i);
});

test("evaluateAutonomyStage stage7 rejects a bootstrap-retrying operator console", () => {
  const result = evaluateAutonomyStage(
    "stage7",
    {
      runToken: "abc",
      sessionId: "session-1",
      paneText: "[INFO] webchat handler still starting; retrying in 1500ms",
      runDetail: {
        runId: "run-1",
        state: "running",
      },
    },
    { runId: "run-1" },
  );
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /operator console/i);
});

test("evaluateAutonomyStage stage7 rejects the wrong resumed session", () => {
  const result = evaluateAutonomyStage(
    "stage7",
    {
      runToken: "abc",
      sessionId: "session-1",
      paneText: "session healthy but attached to session-9",
      runDetail: {
        runId: "run-1",
        state: "working",
      },
    },
    { runId: "run-1" },
  );
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /different session/i);
});
