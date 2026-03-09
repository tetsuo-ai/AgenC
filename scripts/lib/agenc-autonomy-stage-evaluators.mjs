const TYPED_PROCESS_TOOL_NAMES = new Set([
  "system.processStart",
  "system.processStatus",
  "system.processResume",
  "system.processStop",
  "system.processLogs",
  "desktop.process_start",
  "desktop.process_status",
  "desktop.process_stop",
  "system.serverStart",
  "system.serverStatus",
  "system.serverStop",
  "system.sandboxStart",
  "system.sandboxExec",
  "system.sandboxStop",
]);

const TYPED_PROCESS_TOOL_NAME_LIST = [...TYPED_PROCESS_TOOL_NAMES];

function extractToolNames(traceDetail) {
  if (!traceDetail || !Array.isArray(traceDetail.events)) {
    return [];
  }
  return traceDetail.events
    .map((event) => event?.toolName)
    .filter((toolName) => typeof toolName === "string");
}

function containsAll(text, parts) {
  return parts.every((part) => text.includes(part));
}

function containsOne(text, parts) {
  return parts.some((part) => text.includes(part));
}

function textOfEvidence(evidence) {
  return [evidence.paneText ?? "", evidence.traceText ?? "", evidence.runText ?? ""]
    .filter(Boolean)
    .join("\n");
}

function stagePass(passed, reasons, extra = {}) {
  return { passed, reasons, ...extra };
}

function buildStageEvaluationContext(evidence, context = {}) {
  const paneText = evidence.paneText ?? "";
  const traceDetail = evidence.traceDetail;
  const runDetail = evidence.runDetail;
  return {
    paneText,
    traceDetail,
    runDetail,
    toolNames: extractToolNames(traceDetail),
    combinedText: textOfEvidence(evidence),
    runToken: evidence.runToken,
    sessionId: evidence.sessionId,
    currentRunId: runDetail?.runId,
    traceCompleted: traceDetail?.summary?.status === "completed",
    paneBusy:
      paneText.includes("agent is typing") ||
      paneText.includes("[INFO] agent is typing"),
    priorRunId: context.runId,
  };
}

function evaluateStage0(ctx) {
  const expectedToken = `AUTONOMY_STAGE0::${ctx.runToken}`;
  return stagePass(
    ctx.paneText.includes(expectedToken) &&
      ctx.toolNames.length === 0 &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      ctx.paneText.includes(expectedToken)
        ? undefined
        : `pane did not contain ${expectedToken}`,
      ctx.toolNames.length === 0 ? undefined : "trace recorded tool usage for a no-tool stage",
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
  );
}

function evaluateStage1(ctx) {
  const expectedToken = `AUTONOMY_STAGE1::${ctx.runToken}`;
  const shellToolSeen =
    ctx.toolNames.includes("desktop.bash") || ctx.toolNames.includes("system.bash");
  return stagePass(
    ctx.paneText.includes(expectedToken) &&
      shellToolSeen &&
      containsOne(ctx.combinedText, ["desktop.bash", "system.bash"]) &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      ctx.paneText.includes(expectedToken)
        ? undefined
        : `pane did not contain ${expectedToken}`,
      shellToolSeen
        ? undefined
        : "trace did not record a supported shell tool",
      containsOne(ctx.combinedText, ["desktop.bash", "system.bash"])
        ? undefined
        : "user-visible output did not mention the shell tool that was used",
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
  );
}

function evaluateStage2(ctx) {
  const expectedToken = `AUTONOMY_STAGE2::${ctx.runToken}`;
  const expectedPath = `/tmp/agenc-autonomy-${ctx.runToken}.txt`;
  return stagePass(
    containsAll(ctx.paneText, [expectedToken, expectedPath]) &&
      ctx.toolNames.length >= 2 &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      containsAll(ctx.paneText, [expectedToken, expectedPath])
        ? undefined
        : "pane did not show the verified path and contents",
      ctx.toolNames.length >= 2
        ? undefined
        : "trace did not show at least two tool calls for write/read verification",
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
  );
}

function evaluateStage3(ctx) {
  return stagePass(
    containsAll(ctx.combinedText, ["system.delete"]) &&
      containsOne(ctx.combinedText.toLowerCase(), [
        "allowed",
        "denied",
        "approval",
        "requires approval",
      ]) &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      ctx.combinedText.includes("system.delete")
        ? undefined
        : "policy preview did not mention system.delete",
      containsOne(ctx.combinedText.toLowerCase(), [
        "allowed",
        "denied",
        "approval",
        "requires approval",
      ])
        ? undefined
        : "policy preview did not state allow/deny/approval outcome",
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
  );
}

function evaluateStage4(ctx) {
  const typedToolSeen =
    ctx.toolNames.some((toolName) => isTypedHandleTool(toolName)) ||
    containsOne(ctx.combinedText, TYPED_PROCESS_TOOL_NAME_LIST);
  const observedTargetSeen =
    Array.isArray(ctx.runDetail?.observedTargets) &&
    ctx.runDetail.observedTargets.length > 0;
  const activeState =
    ctx.runDetail?.state === "working" ||
    ctx.runDetail?.state === "running" ||
    ctx.runDetail?.state === "paused" ||
    ctx.runDetail?.state === "completed";
  const evidenceSeen =
    typeof ctx.runDetail?.lastToolEvidence === "string" &&
    ctx.runDetail.lastToolEvidence.trim().length > 0;
  return stagePass(
    Boolean(ctx.sessionId) &&
      Boolean(ctx.currentRunId) &&
      typedToolSeen &&
      observedTargetSeen &&
      activeState &&
      evidenceSeen &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      ctx.sessionId ? undefined : "no durable session id was observed",
      ctx.currentRunId ? undefined : "run.inspect did not return a run id",
      typedToolSeen ? undefined : "trace did not show a typed long-lived handle tool",
      observedTargetSeen ? undefined : "run.inspect did not show any observed targets",
      activeState ? undefined : `run state was not active: ${ctx.runDetail?.state ?? "missing"}`,
      evidenceSeen ? undefined : "run.inspect did not include verified tool evidence",
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
    { runId: ctx.currentRunId },
  );
}

function evaluateServerStageStart(ctx) {
  const structuredServerTargetSeen = Array.isArray(ctx.runDetail?.observedTargets)
    ? ctx.runDetail.observedTargets.some((target) => {
        const launchSpec = target?.launchSpec;
        return (
          target?.kind === "managed_process" &&
          (target?.surface === "host_server" ||
            typeof target?.serverId === "string" ||
            launchSpec?.kind === "server")
        );
      })
    : false;
  const serverToolSeen =
    structuredServerTargetSeen ||
    containsOne(ctx.combinedText, ["system.serverStart", "system.serverStatus"]) ||
    (Array.isArray(ctx.runDetail?.artifacts) &&
      ctx.runDetail.artifacts.some(
        (artifact) =>
          artifact?.source === "system.serverStart" ||
          artifact?.source === "system.serverStatus",
      ));
  const structuredReadinessSeen = Array.isArray(ctx.runDetail?.observedTargets)
    ? ctx.runDetail.observedTargets.some((target) => {
        const launchSpec = target?.launchSpec;
        const healthUrl = launchSpec?.healthUrl;
        return (
          target?.kind === "managed_process" &&
          target?.ready === true &&
          typeof target?.serverId === "string" &&
          typeof healthUrl === "string" &&
          healthUrl.startsWith("http://127.0.0.1:")
        );
      })
    : false;
  const readinessSeen =
    structuredReadinessSeen ||
    containsOne(ctx.combinedText, [
      '"ready":true',
      '\\"ready\\":true',
      "ready=true",
      '"healthUrl":"http://127.0.0.1:',
      '\\"healthUrl\\":\\"http://127.0.0.1:',
      "healthUrl=http://127.0.0.1:",
    ]);
  const observedTargetSeen =
    Array.isArray(ctx.runDetail?.observedTargets) &&
    ctx.runDetail.observedTargets.length > 0;
  const activeState =
    ctx.runDetail?.state === "working" ||
    ctx.runDetail?.state === "running" ||
    ctx.runDetail?.state === "paused" ||
    ctx.runDetail?.state === "completed";
  return stagePass(
    Boolean(ctx.sessionId) &&
      Boolean(ctx.currentRunId) &&
      serverToolSeen &&
      readinessSeen &&
      observedTargetSeen &&
      activeState &&
      ctx.traceCompleted &&
      !ctx.paneBusy,
    [
      ctx.sessionId ? undefined : "no durable session id was observed",
      ctx.currentRunId ? undefined : "run.inspect did not return a run id",
      serverToolSeen
        ? undefined
        : "evidence did not show system.serverStart/system.serverStatus",
      readinessSeen ? undefined : "server readiness evidence was missing",
      observedTargetSeen ? undefined : "run.inspect did not show any observed targets",
      activeState ? undefined : `run state was not active: ${ctx.runDetail?.state ?? "missing"}`,
      ctx.traceCompleted ? undefined : "trace did not reach completed status",
      ctx.paneBusy ? "pane still showed an active typing state" : undefined,
    ].filter(Boolean),
    { runId: ctx.currentRunId },
  );
}

function evaluatePauseStage(ctx) {
  const sameRun = !ctx.priorRunId || ctx.priorRunId === ctx.currentRunId;
  return stagePass(
    ctx.runDetail?.state === "paused" && sameRun,
    [
      ctx.runDetail?.state === "paused"
        ? undefined
        : `run did not enter paused state: ${ctx.runDetail?.state ?? "missing"}`,
      sameRun ? undefined : "pause changed the durable run id",
    ].filter(Boolean),
  );
}

function evaluateResumeStage(ctx) {
  const sameRun = !ctx.priorRunId || ctx.priorRunId === ctx.currentRunId;
  const resumed =
    ctx.runDetail?.state === "working" ||
    ctx.runDetail?.state === "running" ||
    ctx.runDetail?.currentPhase === "active";
  return stagePass(
    resumed && sameRun,
    [
      resumed
        ? undefined
        : `run did not return to an active state: ${ctx.runDetail?.state ?? "missing"}`,
      sameRun ? undefined : "resume changed the durable run id",
    ].filter(Boolean),
  );
}

function evaluateInspectStage(ctx) {
  return stagePass(
    Boolean(ctx.runDetail?.lastToolEvidence) &&
      Array.isArray(ctx.runDetail?.recentEvents),
    [
      ctx.runDetail?.lastToolEvidence
        ? undefined
        : "inspect did not return verified tool evidence",
      Array.isArray(ctx.runDetail?.recentEvents)
        ? undefined
        : "inspect did not return recent events",
    ].filter(Boolean),
  );
}

function evaluateTraceStage(ctx) {
  return stagePass(
    Boolean(ctx.traceDetail?.summary?.traceId) &&
      Number(ctx.traceDetail?.summary?.eventCount ?? 0) > 0 &&
      ctx.traceDetail?.summary?.sessionId === ctx.sessionId &&
      ctx.traceDetail?.completeness?.complete === true,
    [
      ctx.traceDetail?.summary?.traceId ? undefined : "no trace detail was returned",
      Number(ctx.traceDetail?.summary?.eventCount ?? 0) > 0
        ? undefined
        : "trace detail had no events",
      ctx.traceDetail?.summary?.sessionId === ctx.sessionId
        ? undefined
        : "trace detail session id did not match the active session",
      ctx.traceDetail?.completeness?.complete === true
        ? undefined
        : `trace completeness issues: ${(ctx.traceDetail?.completeness?.issues ?? []).join(", ")}`,
    ].filter(Boolean),
  );
}

function evaluateRestartStage(ctx) {
  const sameRun = !ctx.priorRunId || ctx.priorRunId === ctx.currentRunId;
  const recovered =
    ctx.runDetail?.state === "working" ||
    ctx.runDetail?.state === "running" ||
    ctx.runDetail?.state === "paused" ||
    ctx.runDetail?.state === "completed" ||
    ctx.runDetail?.state === "suspended";
  const sessionShort = typeof ctx.sessionId === "string" ? ctx.sessionId.slice(-8) : "";
  const paneRecovered =
    !ctx.paneText.includes("[LINK] reconnecting") &&
    !ctx.paneText.includes("Unknown message type: chat.new") &&
    !ctx.paneText.includes("[ERROR] Runtime Error") &&
    !ctx.paneText.includes("webchat handler still starting") &&
    !ctx.paneText.includes("retrying in ");
  const paneSessionMatches =
    sessionShort.length === 0 || ctx.paneText.includes(sessionShort);
  return stagePass(
    Boolean(ctx.sessionId) &&
      sameRun &&
      recovered &&
      paneRecovered &&
      paneSessionMatches,
    [
      ctx.sessionId ? undefined : "session was not recoverable after restart",
      sameRun ? undefined : "restart lost or replaced the durable run id",
      recovered
        ? undefined
        : `run state after restart was not recoverable: ${ctx.runDetail?.state ?? "missing"}`,
      paneRecovered
        ? undefined
        : "operator console did not finish reconnecting cleanly after restart",
      paneSessionMatches
        ? undefined
        : "operator console resumed a different session after restart",
    ].filter(Boolean),
  );
}

function evaluateStopStage(ctx) {
  return stagePass(
    ctx.runDetail?.state === "cancelled" || ctx.runDetail?.state === "completed",
    [
      ctx.runDetail?.state === "cancelled" || ctx.runDetail?.state === "completed"
        ? undefined
        : `stop did not reach a terminal state: ${ctx.runDetail?.state ?? "missing"}`,
    ].filter(Boolean),
  );
}

function createTypedArtifactEvaluator(config) {
  return (ctx) => {
    const toolsSeen =
      ctx.toolNames.includes(config.infoToolName) &&
      ctx.toolNames.includes(config.detailToolName);
    const groundedAnswerSeen =
      containsAll(ctx.paneText, config.requiredPaneTerms) &&
      (config.extraPaneCheck ? config.extraPaneCheck(ctx.paneText) : true);
    return stagePass(
      toolsSeen && groundedAnswerSeen && ctx.traceCompleted && !ctx.paneBusy,
      [
        toolsSeen
          ? undefined
          : `trace did not show both ${config.infoToolName} and ${config.detailToolName}`,
        groundedAnswerSeen
          ? undefined
          : config.paneFailureMessage,
        ctx.traceCompleted ? undefined : "trace did not reach completed status",
        ctx.paneBusy ? "pane still showed an active typing state" : undefined,
      ].filter(Boolean),
    );
  };
}

const STAGE_EVALUATORS = {
  stage0: evaluateStage0,
  stage1: evaluateStage1,
  stage2: evaluateStage2,
  stage3: evaluateStage3,
  stage4: evaluateStage4,
  server_stage_start: evaluateServerStageStart,
  stage5_pause: evaluatePauseStage,
  stage5_resume: evaluateResumeStage,
  stage5_inspect: evaluateInspectStage,
  stage6: evaluateTraceStage,
  stage7: evaluateRestartStage,
  stage8: evaluateStopStage,
  spreadsheet_stage_read: createTypedArtifactEvaluator({
    infoToolName: "system.spreadsheetInfo",
    detailToolName: "system.spreadsheetRead",
    requiredPaneTerms: ["Ada", "Linus", "admin", "user"],
    extraPaneCheck: (paneText) =>
      containsOne(paneText, ["2 rows", "row count: **2**", "Exact row count: **2**"]),
    paneFailureMessage: "pane did not show the grounded workbook rows/count",
  }),
  office_document_stage_read: createTypedArtifactEvaluator({
    infoToolName: "system.officeDocumentInfo",
    detailToolName: "system.officeDocumentExtractText",
    requiredPaneTerms: [
      "Launch Brief",
      "AgenC Smoke",
      "Hello DOCX Brief",
      "Status update line two.",
    ],
    extraPaneCheck: (paneText) => containsOne(paneText, ["DOCX", "Format: DOCX"]),
    paneFailureMessage: "pane did not show the grounded office document metadata/text",
  }),
  email_message_stage_read: createTypedArtifactEvaluator({
    infoToolName: "system.emailMessageInfo",
    detailToolName: "system.emailMessageExtractText",
    requiredPaneTerms: [
      "Sprint update",
      "alice@example.com",
      "bob@example.com",
      "Hello team,",
      "Sprint review is at 10:00 AM.",
    ],
    paneFailureMessage: "pane did not show the grounded email metadata/text",
  }),
  calendar_stage_read: createTypedArtifactEvaluator({
    infoToolName: "system.calendarInfo",
    detailToolName: "system.calendarRead",
    requiredPaneTerms: [
      "Team Calendar",
      "Product Review",
      "Planning Day",
      "bob@example.com",
      "carol@example.com",
    ],
    extraPaneCheck: (paneText) =>
      /\bexact event count\b[^0-9]*2\b/i.test(paneText) ||
      /\bevent count\b[^0-9]*2\b/i.test(paneText) ||
      /\b2 events\b/i.test(paneText),
    paneFailureMessage: "pane did not show the grounded calendar metadata/events",
  }),
};

export function isTypedHandleTool(toolName) {
  return TYPED_PROCESS_TOOL_NAMES.has(toolName);
}

export function evaluateAutonomyStage(evaluationId, evidence, context = {}) {
  const evaluator = STAGE_EVALUATORS[evaluationId];
  if (!evaluator) {
    throw new Error(`Unknown evaluation id: ${evaluationId}`);
  }
  return evaluator(buildStageEvaluationContext(evidence, context));
}
