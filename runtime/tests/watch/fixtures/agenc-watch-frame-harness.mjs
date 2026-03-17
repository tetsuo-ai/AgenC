import { createWatchFrameController } from "../../../src/watch/agenc-watch-frame.mjs";

export function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text,
    plainText: text,
    mode,
    ...metadata,
  };
}

function truncate(value, maxChars = 220) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function createWatchFrameHarness(overrides = {}) {
  const layoutCalls = [];
  const statusCalls = [];
  const pushedEvents = [];
  const fileWrites = [];
  const stdoutWrites = [];
  const watchState = {
    bootstrapReady: true,
    introDismissed: true,
    currentObjective: "",
    transientStatus: "idle",
    sessionId: "session:test-12345678",
    expandedEventId: null,
    transcriptScrollOffset: 0,
    transcriptFollowMode: true,
    detailScrollOffset: 0,
    latestToolState: "idle",
    latestAgentSummary: null,
    plannerDagNote: null,
    plannerDagStatus: "idle",
    plannerDagUpdatedAt: 0,
    latestTool: "idle",
    lastUsageSummary: null,
    activeRunStartedAtMs: null,
    bootstrapAttempts: 0,
    ...overrides.watchState,
  };
  const transportState = {
    connectionState: "live",
    isOpen: true,
    ...overrides.transportState,
  };
  const events = overrides.events ?? [];
  const workspaceFileIndex = {
    ready: true,
    error: null,
    ...overrides.workspaceFileIndex,
  };

  const dependencies = {
    fs: {
      writeFileSync(filePath, text) {
        fileWrites.push({ filePath, text });
      },
    },
    watchState,
    transportState,
    events,
    queuedOperatorInputs: [],
    subagentPlanSteps: new Map(),
    subagentLiveActivity: new Map(),
    plannerDagNodes: new Map(),
    plannerDagEdges: [],
    workspaceFileIndex,
    color: {
      reset: "",
      bold: "",
      border: "",
      borderStrong: "",
      softInk: "",
      fog: "",
      magenta: "",
      teal: "",
      cyan: "",
      red: "",
      green: "",
      yellow: "",
      panelBg: "",
      panelAltBg: "",
      panelHiBg: "",
      ink: "",
    },
    enableMouseTracking: false,
    launchedAtMs: 0,
    startupSplashMinMs: 0,
    introDismissKinds: new Set(["agent"]),
    maxInlineChars: 220,
    maxPreviewSourceLines: 160,
    currentSurfaceSummary() {
      return {
        overview: {
          connectionState: "live",
          sessionToken: "12345678",
          phaseLabel: "idle",
          queuedInputCount: 0,
          latestTool: "idle",
          latestToolState: "idle",
          usage: "n/a",
          lastActivityAt: "00:00:00",
          activeAgentCount: 0,
          planCount: 0,
          transcriptMode: "follow",
          fallbackState: "standby",
          runtimeState: "healthy",
          runtimeLabel: "live · durable ready",
          activeLine: "Awaiting operator prompt",
          durableActiveTotal: 0,
          durableQueuedSignalsTotal: 0,
          durableRunsState: "ready",
        },
        chips: overrides.chips ?? [],
        routeLabel: "grok-4 via grok",
        providerLabel: "grok",
        objective: "No active objective",
        routeState: "primary",
        routeTone: "teal",
        recentTools: [],
        attention: {
          approvalAlertCount: 0,
          errorAlertCount: 0,
          queuedInputCount: 0,
          items: [],
        },
        detail: {
          diffNavigation: {
            enabled: false,
            currentHunkIndex: 0,
            totalHunks: 0,
            currentFilePath: "",
          },
        },
        ...overrides.surfaceSummary,
      };
    },
    currentInputValue() {
      return overrides.inputValue ?? "";
    },
    currentSlashSuggestions() {
      return overrides.suggestions ?? [];
    },
    currentFileTagPalette() {
      return overrides.fileTagPalette ?? {
        activeTag: null,
        suggestions: [],
        summary: null,
      };
    },
    currentSessionElapsedLabel() {
      return "0m 01s";
    },
    currentRunElapsedLabel() {
      return "0m 01s";
    },
    currentDisplayObjective(fallback = "No active objective") {
      return overrides.objective ?? fallback;
    },
    currentPhaseLabel() {
      return "idle";
    },
    currentSurfaceToolLabel(fallback = "idle") {
      return overrides.latestTool ?? fallback;
    },
    hasActiveSurfaceRun() {
      return overrides.activeRun === true;
    },
    bootstrapPending() {
      return false;
    },
    shouldShowWatchSplash() {
      return false;
    },
    buildWatchLayout(args) {
      layoutCalls.push(args);
      return {
        ...args,
        bodyHeight: Math.max(0, args.height - args.headerRows - args.popupRows - 3),
        useSidebar: args.width >= 120 && !args.slashMode && !args.detailOpen,
        sidebarWidth: 42,
        transcriptWidth: args.width >= 120 && !args.slashMode && !args.detailOpen
          ? args.width - 44
          : args.width,
      };
    },
    buildWatchFooterSummary() {
      return {
        hintLeft: "ctrl+o detail",
        hintRight: "live",
        statusLabel: "Awaiting operator prompt",
        statusTone: "teal",
        leftDetails: ["follow"],
        rightStatus: "idle",
      };
    },
    buildWatchSidebarPolicy() {
      return {
        compactAgentLimit: 1,
        minDagRows: 8,
        showTools: true,
        toolLimit: 2,
        showGuard: true,
        showAgents: true,
        showSessionTokens: true,
      };
    },
    buildTranscriptEventSummary(event, previewLines = []) {
      return {
        badge: { label: "CORE", tone: "cyan" },
        timestamp: event.timestamp ?? "00:00:00",
        meta: event.title,
        toolState: "ok",
        previewLines,
      };
    },
    buildDetailPaneSummary(event, details = {}) {
      return {
        badge: { label: "CORE", tone: "cyan" },
        timestamp: event.timestamp ?? "00:00:00",
        title: event.title,
        meta: event.title,
        hint: "detail",
        statusLine: `${details.visibleLineCount ?? 0} visible`,
      };
    },
    buildCommandPaletteSummary() {
      return {
        empty: !(overrides.suggestions?.length > 0),
        title: "Commands",
      };
    },
    buildFileTagPaletteSummary() {
      return {
        title: "Files",
        suggestionHint: "indexing",
        mode: "idle",
        empty: true,
      };
    },
    computeTranscriptPreviewMaxLines() {
      return overrides.previewLines ?? 2;
    },
    splitTranscriptPreviewForHeadline(event, previewLines) {
      const headline = previewLines[0]?.plainText ?? previewLines[0]?.text ?? event.title;
      return {
        headline,
        bodyLines: previewLines.slice(1),
      };
    },
    buildEventDisplayLines(event) {
      return [createDisplayLine(event.body ?? "(empty)")];
    },
    wrapEventDisplayLines(event) {
      return overrides.wrapEventDisplayLines
        ? overrides.wrapEventDisplayLines(event)
        : [createDisplayLine(event.body ?? "(empty)")];
    },
    wrapDisplayLines(lines) {
      return lines;
    },
    compactBodyLines(value, maxLines = 4) {
      return String(value ?? "").split("\n").slice(0, maxLines);
    },
    createDisplayLine,
    displayLineText(line) {
      return line?.text ?? "";
    },
    displayLinePlainText(line) {
      return line?.plainText ?? line?.text ?? "";
    },
    renderEventBodyLine(_event, line) {
      return line?.text ?? "";
    },
    isSourcePreviewEvent() {
      return false;
    },
    isDiffRenderableEvent() {
      return false;
    },
    isMarkdownRenderableEvent(event) {
      return overrides.isMarkdownRenderableEvent
        ? overrides.isMarkdownRenderableEvent(event)
        : false;
    },
    isMutationPreviewEvent() {
      return false;
    },
    isSlashComposerInput(value) {
      return String(value ?? "").startsWith("/");
    },
    composerRenderLine() {
      return { line: "> ", cursorColumn: 3 };
    },
    fitAnsi(text) {
      return text;
    },
    truncate,
    sanitizeInlineText(value) {
      return String(value ?? "");
    },
    sanitizeDisplayText(value) {
      return String(value ?? "");
    },
    toneColor() {
      return "";
    },
    stateTone() {
      return "teal";
    },
    badge(label) {
      return label;
    },
    chip(label, value) {
      return `${label}:${value}`;
    },
    row(text = "") {
      return text;
    },
    renderPanel({ title, lines = [] }) {
      return [title, ...lines];
    },
    joinColumns(leftLines = [], rightLines = [], leftWidth = 0, _rightWidth = 0, gap = 2) {
      const rows = Math.max(leftLines.length, rightLines.length);
      return Array.from({ length: rows }, (_, index) =>
        `${String(leftLines[index] ?? "").padEnd(leftWidth)}${" ".repeat(gap)}${rightLines[index] ?? ""}`);
    },
    blankRow(width) {
      return "".padEnd(width, " ");
    },
    paintSurface(text, width) {
      return String(text ?? "").padEnd(width);
    },
    flexBetween(left, right, width = 0) {
      const leftText = String(left ?? "");
      const rightText = String(right ?? "");
      const remaining = Math.max(1, width - leftText.length - rightText.length);
      return `${leftText}${" ".repeat(remaining)}${rightText}`;
    },
    termWidth() {
      return overrides.width ?? 140;
    },
    termHeight() {
      return overrides.height ?? 40;
    },
    formatClockLabel() {
      return "00:00:00";
    },
    animatedWorkingGlyph() {
      return "*";
    },
    compactSessionToken(value) {
      return String(value ?? "").slice(-8);
    },
    sanitizePlanLabel(value, fallback = "unnamed task") {
      return value || fallback;
    },
    plannerDagStatusTone() {
      return "teal";
    },
    plannerDagStatusGlyph() {
      return "*";
    },
    plannerDagTypeGlyph() {
      return ">";
    },
    planStatusTone() {
      return "teal";
    },
    planStatusGlyph() {
      return ">";
    },
    planStepDisplayName(step) {
      return step.stepName ?? step.objective ?? "step";
    },
    applyViewportScrollDelta(offset, delta) {
      return Math.max(0, Number(offset ?? 0) + Number(delta ?? 0));
    },
    preserveManualTranscriptViewport(input) {
      return {
        transcriptScrollOffset: input.transcriptScrollOffset ?? 0,
        transcriptFollowMode: false,
      };
    },
    sliceViewportRowsAroundRange(rows, _targetHeight) {
      return {
        rows,
        normalizedOffset: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
      };
    },
    sliceViewportRowsFromBottom(rows, targetHeight, offset = 0) {
      return {
        rows: rows.slice(-targetHeight),
        normalizedOffset: offset,
        hiddenAbove: Math.max(0, rows.length - targetHeight),
        hiddenBelow: 0,
      };
    },
    bottomAlignViewportRows(rows, targetHeight) {
      return rows.slice(-targetHeight);
    },
    isViewportTranscriptFollowing({ transcriptFollowMode, transcriptScrollOffset }) {
      return Boolean(transcriptFollowMode) && Number(transcriptScrollOffset ?? 0) === 0;
    },
    setTransientStatus(status) {
      statusCalls.push(status);
      watchState.transientStatus = status;
    },
    pushEvent(kind, title, body, tone) {
      pushedEvents.push({ kind, title, body, tone });
    },
    buildAltScreenEnterSequence() {
      return "";
    },
    buildAltScreenLeaveSequence() {
      return "";
    },
    stdout: {
      isTTY: true,
      write(value) {
        stdoutWrites.push(String(value ?? ""));
        return true;
      },
    },
    nowMs() {
      return 1000;
    },
  };

  if (overrides.dependencies) {
    Object.assign(dependencies, overrides.dependencies);
  }

  const controller = createWatchFrameController(dependencies);

  return {
    controller,
    watchState,
    transportState,
    events,
    layoutCalls,
    statusCalls,
    pushedEvents,
    fileWrites,
    stdoutWrites,
  };
}
