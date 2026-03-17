import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommandPaletteSummary,
  buildDetailPaneSummary,
  buildFileTagPaletteSummary,
  buildWatchFooterSummary,
  buildTranscriptEventSummary,
  buildWatchLayout,
  buildWatchSidebarPolicy,
  buildWatchSurfaceSummary,
  shouldShowWatchSplash,
} from "../../src/watch/agenc-watch-surface-summary.mjs";

test("buildWatchLayout disables sidebar for narrow, slash, and detail modes", () => {
  assert.deepEqual(
    buildWatchLayout({
      width: 140,
      height: 40,
      headerRows: 4,
      popupRows: 0,
      slashMode: false,
      detailOpen: false,
    }),
    {
      width: 140,
      height: 40,
      bodyHeight: 32,
      useSidebar: true,
      sidebarWidth: 42,
      transcriptWidth: 96,
    },
  );

  assert.equal(
    buildWatchLayout({
      width: 100,
      height: 40,
      headerRows: 4,
      popupRows: 0,
      slashMode: false,
      detailOpen: false,
    }).useSidebar,
    false,
  );

  assert.equal(
    buildWatchLayout({
      width: 140,
      height: 40,
      headerRows: 4,
      popupRows: 6,
      slashMode: true,
      detailOpen: false,
    }).useSidebar,
    false,
  );

  assert.equal(
    buildWatchLayout({
      width: 140,
      height: 40,
      headerRows: 4,
      popupRows: 0,
      slashMode: false,
      detailOpen: true,
    }).useSidebar,
    false,
  );
});

test("buildWatchSidebarPolicy keeps tool activity visible at common heights", () => {
  assert.deepEqual(
    buildWatchSidebarPolicy(33),
    {
      compactAgentLimit: 1,
      minDagRows: 10,
      showTools: true,
      toolLimit: 2,
      showGuard: false,
      showAgents: false,
      showSessionTokens: true,
    },
  );

  assert.equal(buildWatchSidebarPolicy(38).showGuard, true);
  assert.equal(buildWatchSidebarPolicy(48).showAgents, true);
});

test("shouldShowWatchSplash tracks bootstrap and intro dismissal", () => {
  assert.equal(
    shouldShowWatchSplash({
      introDismissed: false,
      currentObjective: "",
      inputValue: "",
      bootstrapReady: false,
      launchedAtMs: 1_000,
      startupSplashMinMs: 1_500,
      eventKinds: [],
      nowMs: 1_500,
    }),
    true,
  );

  assert.equal(
    shouldShowWatchSplash({
      introDismissed: false,
      currentObjective: "",
      inputValue: "",
      bootstrapReady: true,
      launchedAtMs: 1_000,
      startupSplashMinMs: 1_500,
      eventKinds: ["status"],
      nowMs: 2_000,
    }),
    true,
  );

  assert.equal(
    shouldShowWatchSplash({
      introDismissed: false,
      currentObjective: "",
      inputValue: "",
      bootstrapReady: true,
      launchedAtMs: 1_000,
      startupSplashMinMs: 1_500,
      eventKinds: ["tool result"],
      nowMs: 2_000,
    }),
    false,
  );

  assert.equal(
    shouldShowWatchSplash({
      introDismissed: false,
      currentObjective: "Ship it",
      inputValue: "",
      bootstrapReady: false,
      launchedAtMs: 1_000,
      startupSplashMinMs: 1_500,
      eventKinds: [],
      nowMs: 1_100,
    }),
    false,
  );
});

test("buildWatchSurfaceSummary derives route, alerts, and recent tool timeline", () => {
  const summary = buildWatchSurfaceSummary({
    connectionState: "live",
    phaseLabel: "working",
    route: { provider: "grok", model: "grok-4", usedFallback: true },
    backgroundRunStatus: {
      enabled: false,
      operatorAvailable: false,
      disabledReason: "Durable background runs are disabled in autonomy feature flags.",
    },
    objective: "Trace the fallback path",
    lastUsageSummary: "2.1K total",
    latestTool: "system.bash",
    latestToolState: "ok",
    queuedInputCount: 2,
    events: [
      { kind: "approval", title: "Resolver needed", timestamp: "15:30:01" },
      { kind: "tool", title: "Run pwd", toolName: "system.bash", timestamp: "15:30:02" },
      { kind: "tool result", title: "Ran pwd", toolName: "system.bash", timestamp: "15:30:03" },
      { kind: "tool error", title: "Command failed", toolName: "system.readFile", timestamp: "15:30:04" },
    ],
    planCount: 3,
    activeAgentCount: 1,
    sessionId: "session:abcdef12345678",
    following: false,
    detailOpen: false,
    transcriptScrollOffset: 12,
    lastActivityAt: "15:30:04",
  });

  assert.equal(summary.routeState, "fallback");
  assert.equal(summary.routeLabel, "grok-4 via grok");
  assert.equal(summary.attention.approvalAlertCount, 1);
  assert.equal(summary.attention.errorAlertCount, 1);
  assert.equal(summary.attention.items[0].title, "Command failed");
  assert.equal(summary.recentTools[0].title, "Command failed");
  assert.equal(summary.recentTools[0].state, "error");
  assert.equal(summary.overview.sessionToken, "12345678");
  assert.equal(summary.overview.transcriptMode, "scroll 12");
  assert.equal(summary.overview.durableRunsState, "disabled");
  assert.equal(summary.providerLabel, "grok");
  assert.equal(summary.overview.fallbackState, "active");
  assert.equal(summary.overview.runtimeState, "degraded");
  assert.match(summary.runtimeLabel, /live/);
  assert.equal(summary.chips.find((chip) => chip.label === "ROUTE")?.value, "fallback");
  assert.equal(summary.chips.find((chip) => chip.label === "GUARD")?.label, "GUARD");
  assert.equal(summary.chips.find((chip) => chip.label === "PROVIDER")?.value, "grok");
  assert.equal(summary.chips.find((chip) => chip.label === "FAILOVER")?.value, "active");
  assert.equal(summary.chips.find((chip) => chip.label === "RUNTIME")?.value, "degraded");
  assert.equal(summary.chips.find((chip) => chip.label === "DURABLE")?.value, "disabled");
});

test("buildWatchSurfaceSummary marks detail mode explicitly", () => {
  const summary = buildWatchSurfaceSummary({
    connectionState: "live",
    phaseLabel: "idle",
    route: null,
    objective: "",
    lastUsageSummary: null,
    latestTool: null,
    latestToolState: null,
    queuedInputCount: 0,
    events: [],
    planCount: 0,
    activeAgentCount: 0,
    sessionId: null,
    following: false,
    detailOpen: true,
    transcriptScrollOffset: 9,
    lastActivityAt: null,
  });

  assert.equal(summary.overview.transcriptMode, "detail");
  assert.equal(summary.chips.find((chip) => chip.label === "MODE")?.value, "detail");
});

test("buildTranscriptEventSummary assigns visible badge and tool state", () => {
  const summary = buildTranscriptEventSummary(
    {
      kind: "subagent tool result",
      title: "Edited file",
      toolName: "system.writeFile",
      subagentSessionId: "session:12345678",
      timestamp: "15:31:00",
      body: "ok",
    },
    ["line 1", "line 2"],
  );

  assert.deepEqual(summary.badge, { label: "RETURN", tone: "green" });
  assert.equal(summary.meta, "system.writeFile 12345678");
  assert.equal(summary.toolState, "ok");
  assert.deepEqual(summary.previewLines, ["line 1", "line 2"]);
});

test("buildTranscriptEventSummary omits generic meta labels for agent and prompt cards", () => {
  const agentSummary = buildTranscriptEventSummary({
    kind: "agent",
    title: "Agent Reply",
    timestamp: "15:31:00",
    body: "hello",
  });
  const promptSummary = buildTranscriptEventSummary({
    kind: "you",
    title: "Prompt",
    timestamp: "15:31:01",
    body: "show me a linked list",
  });

  assert.equal(agentSummary.meta, "");
  assert.equal(promptSummary.meta, "");
});

test("buildWatchSurfaceSummary tracks active agents and follow mode", () => {
  const summary = buildWatchSurfaceSummary({
    connectionState: "live",
    phaseLabel: "delegating",
    route: { provider: "grok", model: "grok-4", usedFallback: false },
    backgroundRunStatus: {
      enabled: true,
      operatorAvailable: true,
    },
    objective: "Fan out the implementation",
    lastUsageSummary: "3.4K total",
    latestTool: "execute_with_agent",
    latestToolState: "running",
    queuedInputCount: 1,
    events: [],
    planCount: 4,
    activeAgentCount: 2,
    sessionId: "session:11223344556677",
    following: true,
    detailOpen: false,
    transcriptScrollOffset: 0,
    lastActivityAt: "15:45:00",
  });

  assert.equal(summary.overview.planCount, 4);
  assert.equal(summary.overview.activeAgentCount, 2);
  assert.equal(summary.overview.transcriptMode, "follow");
  assert.equal(summary.chips[0].value, "delegating");
  assert.equal(summary.chips.find((chip) => chip.label === "DURABLE")?.value, "ready");
});

test("buildDetailPaneSummary exposes consistent detail framing", () => {
  const summary = buildDetailPaneSummary(
    {
      kind: "tool result",
      title: "Ran pwd",
      toolName: "system.bash",
      timestamp: "15:46:00",
      body: "/home/tetsuo/git/AgenC",
      bodyTruncated: true,
    },
    {
      bodyLineCount: 24,
      visibleLineCount: 10,
      hiddenAbove: 6,
      hiddenBelow: 8,
    },
  );

  assert.equal(summary.badge.label, "RETURN");
  assert.equal(summary.hint, "return  ctrl+o close");
  assert.equal(
    summary.statusLine,
    "10 of 24 lines  6 above  8 below  stored body truncated",
  );
});

test("buildCommandPaletteSummary tracks slash palette title and empty state", () => {
  assert.deepEqual(
    buildCommandPaletteSummary({
      inputValue: "/sta",
      suggestions: [{ name: "status" }, { name: "start" }],
    }),
    {
      title: "/sta",
      empty: false,
      suggestionNames: ["status", "start"],
      suggestionHint: "status  start",
    },
  );

  assert.equal(
    buildCommandPaletteSummary({
      inputValue: "/zzz",
      suggestions: [],
    }).suggestionHint,
    "no matching command",
  );
});

test("buildFileTagPaletteSummary tracks file-tag palette title and empty state", () => {
  assert.deepEqual(
    buildFileTagPaletteSummary({
      inputValue: "@oper",
      query: "oper",
      suggestions: [{ label: "@runtime/src/channels/webchat/operator-events.ts" }],
      indexReady: true,
    }),
    {
      title: "@ oper",
      empty: false,
      suggestionNames: ["@runtime/src/channels/webchat/operator-events.ts"],
      suggestionHint: "@runtime/src/channels/webchat/operator-events.ts",
      mode: "active",
    },
  );

  assert.equal(
    buildFileTagPaletteSummary({
      inputValue: "@zzz",
      query: "zzz",
      suggestions: [],
      indexReady: true,
    }).suggestionHint,
    "no matching file tag",
  );
});

test("buildWatchFooterSummary handles detail and slash modes", () => {
  const baseSummary = buildWatchSurfaceSummary({
    connectionState: "live",
    phaseLabel: "running",
    route: { provider: "grok", model: "grok-4", usedFallback: false },
    objective: "Ship the operator surface",
    lastUsageSummary: "1.8K total",
    latestTool: "system.bash",
    latestToolState: "ok",
    queuedInputCount: 0,
    events: [],
    planCount: 2,
    activeAgentCount: 1,
    sessionId: "session:99887766",
    following: true,
    detailOpen: true,
    transcriptScrollOffset: 0,
    lastActivityAt: "15:47:00",
  });

  const detailFooter = buildWatchFooterSummary({
    summary: baseSummary,
    inputValue: "",
    suggestions: [],
    connectionState: "live",
    activeRun: true,
    elapsedLabel: "00:42",
    latestTool: "system.bash",
    latestToolState: "ok",
    transientStatus: "",
    latestAgentSummary: "",
    objective: "Ship the operator surface",
    isOpen: true,
    bootstrapPending: false,
    latestExpandable: true,
    enableMouseTracking: true,
  });

  assert.equal(detailFooter.statusLabel, "Working running 00:42");
  assert.ok(detailFooter.leftDetails.includes("detail"));
  assert.match(detailFooter.hintLeft, /ctrl\+o close detail/);
  assert.equal(detailFooter.hintRight, "live");

  const diffDetailFooter = buildWatchFooterSummary({
    summary: baseSummary,
    inputValue: "",
    suggestions: [],
    connectionState: "live",
    activeRun: true,
    elapsedLabel: "00:42",
    latestTool: "system.bash",
    latestToolState: "ok",
    transientStatus: "",
    latestAgentSummary: "",
    objective: "Ship the operator surface",
    isOpen: true,
    bootstrapPending: false,
    latestExpandable: true,
    enableMouseTracking: true,
    detailDiffNavigation: {
      enabled: true,
      currentHunkIndex: 1,
      totalHunks: 3,
      currentFilePath: "runtime/src/index.ts",
    },
  });

  assert.match(diffDetailFooter.hintLeft, /ctrl\+p prev hunk/);
  assert.match(diffDetailFooter.hintLeft, /ctrl\+n next hunk/);

  const slashSummary = buildWatchSurfaceSummary({
    connectionState: "live",
    phaseLabel: "idle",
    route: { provider: "grok", model: "grok-4", usedFallback: false },
    objective: "",
    lastUsageSummary: null,
    latestTool: null,
    latestToolState: null,
    queuedInputCount: 0,
    events: [],
    planCount: 0,
    activeAgentCount: 0,
    sessionId: "session:99887766",
    following: true,
    detailOpen: false,
    transcriptScrollOffset: 0,
    lastActivityAt: "15:47:00",
  });

  const slashFooter = buildWatchFooterSummary({
    summary: slashSummary,
    inputValue: "/sta",
    suggestions: [{ name: "status" }, { name: "start" }],
    connectionState: "live",
    activeRun: false,
    elapsedLabel: "03:10",
    latestTool: null,
    latestToolState: null,
    transientStatus: "",
    latestAgentSummary: "",
    objective: "",
    isOpen: true,
    bootstrapPending: false,
    latestExpandable: false,
    enableMouseTracking: false,
  });

  assert.equal(slashFooter.hintLeft, "status  start");
  assert.equal(slashFooter.hintRight, "enter run");
  assert.equal(slashFooter.palette.title, "/sta");

  const fileTagFooter = buildWatchFooterSummary({
    summary: slashSummary,
    inputValue: "@oper",
    suggestions: [],
    fileTagQuery: "oper",
    fileTagSuggestions: [{ label: "@runtime/src/channels/webchat/operator-events.ts" }],
    fileTagIndexReady: true,
    fileTagIndexError: null,
    connectionState: "live",
    activeRun: false,
    elapsedLabel: "03:10",
    latestTool: null,
    latestToolState: null,
    transientStatus: "",
    latestAgentSummary: "",
    objective: "",
    isOpen: true,
    bootstrapPending: false,
    latestExpandable: false,
    enableMouseTracking: false,
  });

  assert.equal(
    fileTagFooter.hintLeft,
    "@runtime/src/channels/webchat/operator-events.ts",
  );
  assert.equal(fileTagFooter.hintRight, "tab insert tag");
  assert.equal(fileTagFooter.fileTagPalette.title, "@ oper");
});
