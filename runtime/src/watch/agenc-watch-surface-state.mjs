export function createWatchSurfaceStateController(dependencies = {}) {
  const {
    watchState,
    transportState,
    events,
    queuedOperatorInputs,
    subagentPlanSteps,
    nowMs,
    activityPulseIntervalMs,
    formatElapsedMs,
    sanitizeInlineText,
    planStepDisplayName,
    buildSurfaceSummaryCacheKey,
    buildWatchSurfaceSummary,
    isTranscriptFollowing,
    normalizeModelRouteImpl,
    modelRouteToneImpl,
  } = dependencies;

  let cachedSurfaceSummaryKey = null;
  let cachedSurfaceSummary = null;

  function currentSessionElapsedLabel() {
    return formatElapsedMs(nowMs() - watchState.sessionAttachedAtMs);
  }

  function currentRunElapsedLabel() {
    const startedAt = Number(watchState.activeRunStartedAtMs);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return currentSessionElapsedLabel();
    }
    return formatElapsedMs(nowMs() - startedAt);
  }

  function animatedWorkingGlyph() {
    const frames = ["\u25d0", "\u25d3", "\u25d1", "\u25d2"];
    const frameIndex = Math.floor(nowMs() / activityPulseIntervalMs) % frames.length;
    return frames[frameIndex] ?? frames[0];
  }

  function normalizeModelRoute(input = {}) {
    return normalizeModelRouteImpl(input, nowMs);
  }

  function effectiveModelRoute() {
    return watchState.liveSessionModelRoute ?? watchState.configuredModelRoute;
  }

  function activePlanEntries(limit = 10) {
    return [...subagentPlanSteps.values()]
      .sort((left, right) => left.order - right.order)
      .slice(-limit);
  }

  function activeAgentEntries(limit = 24) {
    return activePlanEntries(limit).filter((step) =>
      step.status === "running" || step.status === "planned"
    );
  }

  function currentPlanFocusStep() {
    return [...subagentPlanSteps.values()]
      .filter((step) => step.status === "running" || step.status === "planned")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)[0] ?? null;
  }

  function currentActiveAgentFocus() {
    const step = currentPlanFocusStep();
    if (!step) {
      return {
        label: null,
        activity: null,
      };
    }
    const label = planStepDisplayName(step, 48);
    const activity = sanitizeInlineText(
      step.subagentSessionId
        ? watchState.subagentLiveActivity.get(step.subagentSessionId) ?? step.note ?? ""
        : step.note ?? "",
    );
    return {
      label,
      activity: activity || null,
    };
  }

  function currentPhaseLabel() {
    return watchState.runPhase && watchState.runPhase !== "idle"
      ? watchState.runState && watchState.runState !== "idle" && watchState.runPhase !== watchState.runState
        ? `${watchState.runState} / ${watchState.runPhase}`
        : watchState.runPhase
      : watchState.runState;
  }

  function effectiveSurfacePhaseLabel() {
    const phaseLabel = currentPhaseLabel();
    if (phaseLabel && phaseLabel !== "idle") {
      return phaseLabel;
    }
    if (watchState.runState === "idle" || phaseLabel === "idle") {
      return "idle";
    }
    return currentPlanFocusStep() ? "delegating" : phaseLabel || "idle";
  }

  function hasActiveSurfaceRun() {
    return effectiveSurfacePhaseLabel() !== "idle";
  }

  function currentDisplayObjective(fallback = "No active objective") {
    const liveStep = currentPlanFocusStep();
    const candidate = sanitizeInlineText(
      watchState.currentObjective ??
        watchState.runDetail?.objective ??
        liveStep?.objective ??
        liveStep?.note ??
        "",
    );
    return candidate || fallback;
  }

  function currentSurfaceToolLabel(fallback = "idle") {
    const liveStep = currentPlanFocusStep();
    const note = sanitizeInlineText(liveStep?.note ?? "");
    const objective = sanitizeInlineText(liveStep?.objective ?? "");
    if (liveStep?.status === "running" && note && note !== objective) {
      return note;
    }
    return sanitizeInlineText(watchState.latestTool ?? "") || fallback;
  }

  function currentSurfaceSummary() {
    const route = effectiveModelRoute();
    const planEntries = activePlanEntries(24);
    const activeAgents = activeAgentEntries(24);
    const lastEvent = events[events.length - 1] ?? null;
    const activeAgentFocus = currentActiveAgentFocus();
    const summaryKey = buildSurfaceSummaryCacheKey({
      connectionState: transportState.connectionState,
      phaseLabel: effectiveSurfacePhaseLabel(),
      route,
      backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
      runtimeStatus: watchState.lastStatus ?? null,
      objective: currentDisplayObjective("No active objective"),
      lastUsageSummary: watchState.lastUsageSummary,
      latestTool: watchState.latestTool,
      latestToolState: watchState.latestToolState,
      queuedInputCount: queuedOperatorInputs.length,
      eventsLength: events.length,
      lastEventId: lastEvent?.id ?? null,
      planCount: planEntries.length,
      activeAgentCount: activeAgents.length,
      activeAgentLabel: activeAgentFocus.label,
      activeAgentActivity: activeAgentFocus.activity,
      plannerStatus: watchState.plannerDagStatus,
      plannerNote: watchState.plannerDagNote,
      sessionId: watchState.sessionId,
      following: isTranscriptFollowing(),
      detailOpen: Boolean(watchState.expandedEventId),
      transcriptScrollOffset: watchState.transcriptScrollOffset,
      lastActivityAt: watchState.lastActivityAt,
    });
    if (summaryKey === cachedSurfaceSummaryKey && cachedSurfaceSummary) {
      return cachedSurfaceSummary;
    }
    cachedSurfaceSummary = buildWatchSurfaceSummary({
      connectionState: transportState.connectionState,
      phaseLabel: effectiveSurfacePhaseLabel(),
      route,
      fallbackRoute: route?.usedFallback === true ? route : null,
      backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
      objective: currentDisplayObjective("No active objective"),
      lastUsageSummary: watchState.lastUsageSummary,
      latestTool: watchState.latestTool,
      latestToolState: watchState.latestToolState,
      queuedInputCount: queuedOperatorInputs.length,
      events,
      planCount: planEntries.length,
      activeAgentCount: activeAgents.length,
      sessionId: watchState.sessionId,
      following: isTranscriptFollowing(),
      detailOpen: Boolean(watchState.expandedEventId),
      transcriptScrollOffset: watchState.transcriptScrollOffset,
      lastActivityAt: watchState.lastActivityAt,
      runtimeStatus: watchState.lastStatus ?? null,
      activeAgentLabel: activeAgentFocus.label,
      activeAgentActivity: activeAgentFocus.activity,
      plannerStatus: watchState.plannerDagStatus,
      plannerNote: watchState.plannerDagNote,
    });
    cachedSurfaceSummaryKey = summaryKey;
    return cachedSurfaceSummary;
  }

  function modelRouteTone(route) {
    return modelRouteToneImpl(route, Boolean(watchState.liveSessionModelRoute));
  }

  return {
    activeAgentEntries,
    activePlanEntries,
    animatedWorkingGlyph,
    currentActiveAgentFocus,
    currentDisplayObjective,
    currentPhaseLabel,
    currentPlanFocusStep,
    currentRunElapsedLabel,
    currentSessionElapsedLabel,
    currentSurfaceSummary,
    currentSurfaceToolLabel,
    effectiveModelRoute,
    effectiveSurfacePhaseLabel,
    hasActiveSurfaceRun,
    modelRouteTone,
    normalizeModelRoute,
  };
}
