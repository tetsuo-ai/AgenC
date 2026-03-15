const TOOL_EVENT_KINDS = new Set([
  "tool",
  "tool result",
  "tool error",
  "subagent tool",
  "subagent tool result",
  "subagent error",
]);

const ALERT_EVENT_KINDS = new Set([
  "approval",
  "error",
  "tool error",
  "subagent error",
  "ws-error",
]);

const BADGE_MAP = Object.freeze({
  "tool result": { label: "RETURN", tone: "green" },
  "tool error": { label: "FAULT", tone: "red" },
  tool: { label: "EXEC", tone: "yellow" },
  "subagent tool": { label: "EXEC", tone: "amber" },
  "subagent tool result": { label: "RETURN", tone: "green" },
  "subagent error": { label: "FAULT", tone: "red" },
  agent: { label: "CORE", tone: "cyan" },
  you: { label: "YOU", tone: "teal" },
  operator: { label: "CTRL", tone: "teal" },
  run: { label: "STATE", tone: "magenta" },
  inspect: { label: "STATE", tone: "magenta" },
  trace: { label: "TRACE", tone: "slate" },
  logs: { label: "LOGS", tone: "slate" },
  history: { label: "HISTORY", tone: "slate" },
  help: { label: "HELP", tone: "slate" },
  status: { label: "STATUS", tone: "blue" },
  session: { label: "SESS", tone: "teal" },
  approval: { label: "AUTH", tone: "red" },
  queued: { label: "QUEUE", tone: "amber" },
  subagent: { label: "AGENT", tone: "magenta" },
});

function sanitizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function compactSessionToken(value) {
  const text = sanitizeText(value);
  return text ? text.slice(-8) : "--------";
}

function stateTone(value) {
  const normalized = sanitizeText(value).toLowerCase();
  switch (normalized) {
    case "live":
    case "connected":
    case "running":
    case "ok":
    case "completed":
    case "ready":
    case "clear":
    case "primary":
    case "standby":
    case "healthy":
      return "green";
    case "working":
    case "thinking":
    case "execute":
    case "executing":
    case "resolving":
    case "active":
    case "detail":
      return "cyan";
    case "fallback":
    case "queued":
    case "pending":
    case "disabled":
    case "reconnecting":
    case "paused":
    case "blocked":
    case "limited":
    case "warming":
      return "amber";
    case "approval":
    case "alert":
    case "offline":
    case "unavailable":
    case "error":
    case "failed":
    case "denied":
    case "degraded":
      return "red";
    default:
      return "slate";
  }
}

function formatCount(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function fallbackStateFromRoute(route) {
  if (!route) {
    return "pending";
  }
  return route.usedFallback === true ? "active" : "standby";
}

function runtimeStateFromInputs(connectionState, backgroundRunStatus, errorAlertCount) {
  const linkState = sanitizeText(connectionState, "unknown").toLowerCase();
  if (linkState !== "live" && linkState !== "connected") {
    return linkState || "unknown";
  }
  if (!backgroundRunStatus) {
    return errorAlertCount > 0 ? "degraded" : "warming";
  }
  if (!backgroundRunStatus.enabled) {
    return errorAlertCount > 0 ? "degraded" : "limited";
  }
  if (backgroundRunStatus.operatorAvailable) {
    return errorAlertCount > 0 ? "degraded" : "healthy";
  }
  return "degraded";
}

function runtimeLabelFromInputs(connectionState, backgroundRunStatus) {
  const linkState = sanitizeText(connectionState, "unknown");
  if (!backgroundRunStatus) {
    return `${linkState} · durable pending`;
  }
  if (!backgroundRunStatus.enabled) {
    return `${linkState} · ${sanitizeText(backgroundRunStatus.disabledReason, "durable disabled")}`;
  }
  if (backgroundRunStatus.operatorAvailable) {
    return `${linkState} · durable ready`;
  }
  return `${linkState} · ${sanitizeText(backgroundRunStatus.disabledReason, "durable operator unavailable")}`;
}

function toolStateFromKind(kind) {
  switch (kind) {
    case "tool":
    case "subagent tool":
      return "running";
    case "tool result":
    case "subagent tool result":
      return "ok";
    case "tool error":
    case "subagent error":
      return "error";
    default:
      return "idle";
  }
}

function eventMetaLabel(event) {
  if (event.kind === "agent") {
    const title = sanitizeText(event.title ?? "", event.kind);
    if (title === "Agent Reply" || title === "Agent Reply · live") {
      return "";
    }
    return title;
  }
  if (event.kind === "you" || event.kind === "queued") {
    const title = sanitizeText(event.title ?? "", event.kind);
    if (title === "Prompt" || title === "Queued Input") {
      return "";
    }
    return title;
  }
  if (event.kind === "tool" || event.kind === "tool result" || event.kind === "tool error") {
    return sanitizeText(event.toolName ?? event.title ?? "", event.kind);
  }
  if (
    event.kind === "subagent tool" ||
    event.kind === "subagent tool result" ||
    event.kind === "subagent error"
  ) {
    const tool = sanitizeText(event.toolName ?? event.title ?? "", event.kind);
    const session = compactSessionToken(event.subagentSessionId);
    return `${tool} ${session}`;
  }
  return sanitizeText(event.title ?? "", event.kind);
}

export function buildWatchLayout({
  width,
  height,
  headerRows,
  popupRows,
  slashMode,
  detailOpen,
}) {
  const footerRows = 4; // separator + status + hint + composer (min 1 line)
  const bodyHeight = Math.max(4, height - headerRows - footerRows - popupRows);
  const useSidebar = !detailOpen && !slashMode && width >= 118;
  const sidebarWidth = useSidebar
    ? Math.min(48, Math.max(36, Math.floor(width * 0.3)))
    : 0;
  const transcriptWidth = useSidebar
    ? Math.max(60, width - sidebarWidth - 2)
    : width;
  return {
    width,
    height,
    bodyHeight,
    useSidebar,
    sidebarWidth,
    transcriptWidth,
  };
}

export function buildWatchSidebarPolicy(targetHeight) {
  const height = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : 0;
  return {
    compactAgentLimit: height >= 48 ? 3 : height >= 38 ? 2 : 1,
    minDagRows: height >= 44 ? 18 : height >= 34 ? 14 : 10,
    showTools: height >= 30,
    toolLimit: height >= 54 ? 5 : height >= 42 ? 3 : 2,
    showGuard: height >= 38,
    showAgents: height >= 48,
    showSessionTokens: height >= 30,
  };
}

export function shouldShowWatchSplash({
  introDismissed,
  currentObjective,
  inputValue,
  bootstrapReady,
  launchedAtMs,
  startupSplashMinMs,
  eventKinds = [],
  nowMs,
}) {
  if (
    introDismissed ||
    sanitizeText(currentObjective).length > 0 ||
    sanitizeText(inputValue).length > 0
  ) {
    return false;
  }
  if (!bootstrapReady) {
    return true;
  }
  return nowMs - launchedAtMs < startupSplashMinMs &&
    !eventKinds.some((kind) => kind !== "status");
}

export function buildTranscriptEventSummary(event, previewLines = []) {
  const badge = BADGE_MAP[event?.kind] ?? {
    label: sanitizeText(event?.kind ?? "event", "event").toUpperCase().slice(0, 10),
    tone: "slate",
  };
  const title = sanitizeText(event?.title ?? "", badge.label);
  const meta = eventMetaLabel(event ?? {});
  return {
    badge,
    timestamp: sanitizeText(event?.timestamp ?? "", "--:--:--"),
    title,
    meta,
    previewLines: Array.isArray(previewLines) ? previewLines : [],
    hasBody: sanitizeText(event?.body ?? "").length > 0,
    toolState: toolStateFromKind(event?.kind),
  };
}

export function buildDetailPaneSummary(
  event,
  {
    bodyLineCount = 0,
    visibleLineCount = 0,
    hiddenAbove = 0,
    hiddenBelow = 0,
  } = {},
) {
  const summary = buildTranscriptEventSummary(event);
  const statusParts = [`${visibleLineCount} of ${bodyLineCount} lines`];
  if (hiddenAbove > 0) {
    statusParts.push(`${hiddenAbove} above`);
  }
  if (hiddenBelow > 0) {
    statusParts.push(`${hiddenBelow} below`);
  }
  if (event?.bodyTruncated) {
    statusParts.push("stored body truncated");
  }
  return {
    ...summary,
    hint: `${summary.badge.label.toLowerCase()}  ctrl+o close`,
    statusLine: statusParts.join("  "),
  };
}

export function buildCommandPaletteSummary({ inputValue, suggestions = [], modelSuggestions = [] }) {
  const input = String(inputValue ?? "").trimStart();

  // If user is typing `/model <partial>`, show model name suggestions instead
  const modelMode =
    Array.isArray(modelSuggestions) &&
    modelSuggestions.length > 0 &&
    /^\/models?\s/i.test(input);
  if (modelMode) {
    return {
      title: input.slice(0, 22),
      empty: false,
      suggestionNames: modelSuggestions,
      suggestionHint: modelSuggestions.join("  "),
    };
  }

  const suggestionNames = (Array.isArray(suggestions) ? suggestions : [])
    .map((command) => sanitizeText(command?.name ?? command?.usage ?? ""))
    .filter(Boolean);
  return {
    title: input.length > 0 ? input.slice(0, 22) : "/ commands",
    empty: suggestionNames.length === 0,
    suggestionNames,
    suggestionHint:
      suggestionNames.length > 0 ? suggestionNames.join("  ") : "no matching command",
  };
}

export function buildFileTagPaletteSummary({
  inputValue,
  query = null,
  suggestions = [],
  indexReady = true,
  indexError = null,
}) {
  const input = String(inputValue ?? "");
  const suggestionNames = (Array.isArray(suggestions) ? suggestions : [])
    .map((entry) => sanitizeText(entry?.label ?? entry?.path ?? ""))
    .filter(Boolean);
  const trimmedQuery = query == null ? null : sanitizeText(query, "");
  const title = trimmedQuery && trimmedQuery.length > 0
    ? `@ ${trimmedQuery.slice(0, 18)}`
    : "@ file";
  if (!indexReady) {
    return {
      title,
      empty: true,
      suggestionNames: [],
      suggestionHint: sanitizeText(indexError, "workspace file index unavailable"),
      mode: "unavailable",
    };
  }
  if (!trimmedQuery || trimmedQuery.length === 0) {
    return {
      title,
      empty: suggestionNames.length === 0,
      suggestionNames,
      suggestionHint:
        suggestionNames.length > 0
          ? suggestionNames.join("  ")
          : "type a path or filename after @",
      mode: "idle",
    };
  }
  return {
    title,
    empty: suggestionNames.length === 0,
    suggestionNames,
    suggestionHint:
      suggestionNames.length > 0 ? suggestionNames.join("  ") : "no matching file tag",
    mode: "active",
  };
}

export function buildWatchFooterSummary({
  summary,
  inputValue,
  suggestions = [],
  modelSuggestions = [],
  fileTagQuery = null,
  fileTagSuggestions = [],
  fileTagIndexReady = true,
  fileTagIndexError = null,
  connectionState,
  activeRun,
  elapsedLabel,
  latestTool,
  latestToolState,
  transientStatus,
  latestAgentSummary,
  objective,
  isOpen,
  bootstrapPending,
  latestExpandable,
  enableMouseTracking,
  detailDiffNavigation = null,
}) {
  const surfaceSummary = summary ?? buildWatchSurfaceSummary({});
  const input = String(inputValue ?? "");
  const slashMode = input.trimStart().startsWith("/");
  const palette = buildCommandPaletteSummary({ inputValue: input, suggestions, modelSuggestions });
  const fileTagPalette = buildFileTagPaletteSummary({
    inputValue: input,
    query: fileTagQuery,
    suggestions: fileTagSuggestions,
    indexReady: fileTagIndexReady,
    indexError: fileTagIndexError,
  });
  const fileTagMode = fileTagQuery != null;
  const transcriptMode = sanitizeText(
    surfaceSummary?.overview?.transcriptMode,
    "follow",
  );
  const diffNavigation = detailDiffNavigation ?? surfaceSummary?.detail?.diffNavigation ?? null;
  const linkState = sanitizeText(
    connectionState ?? surfaceSummary?.overview?.connectionState,
    "unknown",
  );
  const phaseLabel = sanitizeText(surfaceSummary?.overview?.phaseLabel, "idle");
  const workingLabel =
    linkState !== "live"
      ? `Link ${linkState}`
      : activeRun
        ? `Working ${phaseLabel} ${sanitizeText(elapsedLabel, "00:00")}`
        : "Awaiting operator prompt";
  const surfaceTool = sanitizeText(
    latestTool ?? surfaceSummary?.overview?.latestTool,
    "",
  );
  const toolState = sanitizeText(
    latestToolState ?? surfaceSummary?.overview?.latestToolState,
    surfaceTool ? "running" : "idle",
  );
  const detailOpen = transcriptMode === "detail";
  const leftDetails = [];
  if (surfaceTool) {
    leftDetails.push(toolState !== "ok" ? `${surfaceTool} ${toolState}` : surfaceTool);
  }
  if (surfaceSummary?.overview?.fallbackState === "active") {
    leftDetails.push("fallback active");
  }
  if (
    surfaceSummary?.overview?.runtimeState &&
    !["healthy", "live", "connected"].includes(surfaceSummary.overview.runtimeState)
  ) {
    leftDetails.push(`runtime ${surfaceSummary.overview.runtimeState}`);
  }
  if (detailOpen) {
    leftDetails.push("detail");
  } else if (transcriptMode === "follow") {
    leftDetails.push("live follow");
  } else {
    leftDetails.push(transcriptMode);
  }
  if (surfaceSummary?.overview?.usage && surfaceSummary.overview.usage !== "n/a") {
    leftDetails.push(`usage ${surfaceSummary.overview.usage}`);
  }

  const nextRightStatus = sanitizeText(
    transientStatus ||
      latestAgentSummary ||
      (activeRun
        ? objective
        : surfaceSummary?.overview?.sessionToken
          ? `session ${surfaceSummary.overview.sessionToken}`
          : linkState),
    "idle",
  );
  const hintRight = !isOpen
    ? "reconnecting"
    : bootstrapPending
      ? "restoring session"
      : surfaceSummary?.overview?.sessionToken
        ? surfaceSummary.overview.sessionToken
        : "no session";

  let hintLeft;
  let hintStatus = hintRight;
  if (detailOpen) {
    hintLeft = `${enableMouseTracking ? "mouse wheel / " : ""}pgup pgdn scroll  ctrl+o close detail  ctrl+y copy`;
    if (diffNavigation?.enabled) {
      hintLeft = `${enableMouseTracking ? "mouse wheel / " : ""}pgup pgdn scroll  ctrl+p prev hunk  ctrl+n next hunk  ctrl+o close detail  ctrl+y copy`;
    }
    hintStatus = linkState;
  } else if (fileTagMode) {
    hintLeft = fileTagPalette.suggestionHint;
    hintStatus = fileTagPalette.mode === "unavailable" ? "index unavailable" : "tab insert tag";
  } else if (slashMode) {
    hintLeft = palette.suggestionHint;
    hintStatus = modelSuggestions.length > 0 ? "tab complete  enter switch" : "enter run";
  } else {
    hintLeft = input.trim().length > 0
      ? `enter send  ctrl+k kill  ctrl+←/→ word${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  pgup/pgdn scroll`
      : `/ commands${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  /export save  pgup/pgdn scroll  ctrl+l clear`;
  }

  return {
    statusLabel: workingLabel,
    statusTone: linkState !== "live" ? stateTone(linkState) : stateTone(phaseLabel),
    leftDetails,
    rightStatus: nextRightStatus,
    hintLeft,
    hintRight: hintStatus,
    palette,
    fileTagPalette,
  };
}

export function buildWatchSurfaceSummary({
  connectionState,
  phaseLabel,
  route,
  fallbackRoute = null,
  backgroundRunStatus,
  objective,
  lastUsageSummary,
  latestTool,
  latestToolState,
  queuedInputCount,
  events = [],
  planCount,
  activeAgentCount,
  sessionId,
  following,
  detailOpen,
  transcriptScrollOffset,
  lastActivityAt,
  runtimeStatus = null,
  activeAgentLabel = null,
  activeAgentActivity = null,
  plannerStatus = null,
  plannerNote = null,
  detail = null,
}) {
  const recentEvents = events.slice(-24);
  const recentTools = recentEvents
    .filter((event) => TOOL_EVENT_KINDS.has(event.kind))
    .slice(-5)
    .reverse()
    .map((event) => ({
      title: sanitizeText(event.title, event.kind),
      meta: eventMetaLabel(event),
      timestamp: sanitizeText(event.timestamp, "--:--:--"),
      state: toolStateFromKind(event.kind),
      tone: stateTone(toolStateFromKind(event.kind)),
    }));
  const recentAlerts = recentEvents
    .filter((event) => ALERT_EVENT_KINDS.has(event.kind))
    .slice(-3)
    .reverse()
    .map((event) => ({
      title: sanitizeText(event.title, event.kind),
      kind: event.kind,
      timestamp: sanitizeText(event.timestamp, "--:--:--"),
      tone: stateTone(event.kind === "approval" ? "approval" : "error"),
    }));
  const approvalAlertCount = recentEvents.filter((event) => event.kind === "approval").length;
  const errorAlertCount = recentEvents.filter((event) =>
    event.kind === "error" ||
    event.kind === "tool error" ||
    event.kind === "subagent error" ||
    event.kind === "ws-error"
  ).length;
  const routeState =
    route?.usedFallback === true ? "fallback" : route ? "primary" : "pending";
  const routeLabel = route
    ? `${sanitizeText(route.model, "unknown")} via ${sanitizeText(route.provider, "unknown")}`
    : "routing pending";
  const providerLabel = sanitizeText(route?.provider, "pending");
  const modelLabel = sanitizeText(route?.model, "pending");
  const fallbackState = fallbackRoute
    ? fallbackRoute.usedFallback === true
      ? "active"
      : fallbackStateFromRoute(route)
    : fallbackStateFromRoute(route);
  const fallbackLabel = fallbackRoute
    ? `${sanitizeText(fallbackRoute.model, "fallback")} via ${sanitizeText(fallbackRoute.provider, "unknown")}`
    : route
      ? route.usedFallback === true
        ? "fallback route active"
        : "fallback standby"
      : "fallback pending";
  const guardValue =
    approvalAlertCount > 0
      ? `${approvalAlertCount} approval alert${approvalAlertCount === 1 ? "" : "s"}`
      : errorAlertCount > 0
        ? `${errorAlertCount} error${errorAlertCount === 1 ? "" : "s"}`
        : "clear";
  const transcriptMode = detailOpen
    ? "detail"
    : following
      ? "follow"
      : `scroll ${transcriptScrollOffset}`;
  const durableRunsState = !backgroundRunStatus
    ? "pending"
    : !backgroundRunStatus.enabled
      ? "disabled"
      : backgroundRunStatus.operatorAvailable
        ? "ready"
        : "offline";
  const durableRunsLabel = !backgroundRunStatus
    ? "durable status pending"
    : backgroundRunStatus.enabled
      ? backgroundRunStatus.operatorAvailable
        ? "durable operator ready"
        : sanitizeText(
          backgroundRunStatus.disabledReason,
          "durable run operator unavailable",
        )
      : sanitizeText(
        backgroundRunStatus.disabledReason,
        "durable background runs disabled",
      );
  const runtimeState = runtimeStateFromInputs(connectionState, backgroundRunStatus, errorAlertCount);
  const runtimeLabel = runtimeLabelFromInputs(connectionState, backgroundRunStatus);
  const plannerLabel = sanitizeText(plannerNote, "");
  const activeAgentFocus = sanitizeText(activeAgentLabel, "");
  const activeAgentLive = sanitizeText(activeAgentActivity, "");
  const activeLine = sanitizeText(
    activeAgentLive || activeAgentFocus || latestTool || objective,
    "Awaiting operator prompt",
  );
  const durableActiveTotal = formatCount(backgroundRunStatus?.activeTotal, 0);
  const durableQueuedSignalsTotal = formatCount(backgroundRunStatus?.queuedSignalsTotal, 0);

  return {
    routeLabel,
    routeState,
    routeTone: stateTone(routeState),
    providerLabel,
    modelLabel,
    fallbackState,
    fallbackLabel,
    runtimeState,
    runtimeLabel,
    objective: sanitizeText(objective, "No active objective"),
    overview: {
      connectionState: sanitizeText(connectionState, "unknown"),
      phaseLabel: sanitizeText(phaseLabel, "idle"),
      sessionToken: compactSessionToken(sessionId),
      lastActivityAt: sanitizeText(lastActivityAt, "idle"),
      latestTool: sanitizeText(latestTool, "idle"),
      latestToolState: sanitizeText(latestToolState, latestTool ? "running" : "idle"),
      usage: sanitizeText(lastUsageSummary, "n/a"),
      durableRunsState,
      durableRunsLabel,
      queuedInputCount: formatCount(queuedInputCount, 0),
      planCount: formatCount(planCount, 0),
      activeAgentCount: formatCount(activeAgentCount, 0),
      transcriptMode,
      runtimeState,
      runtimeLabel,
      fallbackState,
      fallbackLabel,
      providerLabel,
      modelLabel,
      activeLine,
      activeAgentLabel: activeAgentFocus,
      activeAgentActivity: activeAgentLive,
      plannerStatus: sanitizeText(plannerStatus, "idle"),
      plannerNote: plannerLabel,
      durableActiveTotal,
      durableQueuedSignalsTotal,
      runtimeDaemonState: sanitizeText(runtimeStatus?.state, "unknown"),
    },
    chips: [
      { label: "RUN", value: sanitizeText(phaseLabel, "idle"), tone: stateTone(phaseLabel) },
      { label: "ROUTE", value: routeState, tone: stateTone(routeState) },
      { label: "PROVIDER", value: providerLabel, tone: route ? "teal" : "slate" },
      { label: "MODEL", value: modelLabel, tone: route ? "teal" : "slate" },
      { label: "FAILOVER", value: fallbackState, tone: stateTone(fallbackState) },
      { label: "QUEUE", value: String(formatCount(queuedInputCount, 0)), tone: Number(queuedInputCount) > 0 ? "amber" : "green" },
      { label: "GUARD", value: guardValue, tone: approvalAlertCount > 0 ? "red" : errorAlertCount > 0 ? "amber" : "green" },
      { label: "RUNTIME", value: runtimeState, tone: stateTone(runtimeState) },
      { label: "DURABLE", value: durableRunsState, tone: stateTone(durableRunsState) },
      { label: "MODE", value: transcriptMode, tone: detailOpen ? "cyan" : following ? "green" : "amber" },
    ],
    attention: {
      approvalAlertCount,
      errorAlertCount,
      queuedInputCount: formatCount(queuedInputCount, 0),
      items: recentAlerts,
    },
    recentTools,
    detail: detail && typeof detail === "object"
      ? {
        diffNavigation: {
          enabled: detail.diffNavigation?.enabled === true,
          currentHunkIndex: formatCount(detail.diffNavigation?.currentHunkIndex, 0),
          totalHunks: formatCount(detail.diffNavigation?.totalHunks, 0),
          currentFilePath: sanitizeText(detail.diffNavigation?.currentFilePath, ""),
        },
      }
      : { diffNavigation: { enabled: false, currentHunkIndex: 0, totalHunks: 0, currentFilePath: "" } },
  };
}

export { ALERT_EVENT_KINDS, TOOL_EVENT_KINDS };
