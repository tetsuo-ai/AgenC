export function dispatchOperatorSurfaceEvent(surfaceEvent, rawMessage, api) {
  const state = api.state;
  switch (surfaceEvent.family) {
    case "subscription":
      return handleSubscriptionSurfaceEvent(surfaceEvent, api);
    case "session":
      return handleSessionSurfaceEvent(surfaceEvent, state, api);
    case "chat":
      return handleChatSurfaceEvent(surfaceEvent, state, api);
    case "planner":
      return api.handlePlannerTraceEvent(surfaceEvent.type, surfaceEvent.payloadRecord);
    case "subagent":
      return api.handleSubagentLifecycleMessage(surfaceEvent.type, surfaceEvent.payloadRecord);
    case "tool":
      return handleToolSurfaceEvent(surfaceEvent, state, api);
    case "social":
      return handleSocialSurfaceEvent(surfaceEvent, api);
    case "run":
      return handleRunSurfaceEvent(surfaceEvent, state, api);
    case "observability":
      return handleObservabilitySurfaceEvent(surfaceEvent, api);
    case "status":
      return handleStatusSurfaceEvent(surfaceEvent, state, api);
    case "agent":
      return handleAgentSurfaceEvent(surfaceEvent, state, api);
    case "approval":
      return handleApprovalSurfaceEvent(surfaceEvent, api);
    case "error":
      return handleErrorSurfaceEvent(surfaceEvent, rawMessage, state, api);
    default:
      return handleUnknownSurfaceEvent(surfaceEvent, rawMessage, api);
  }
}

function handleSubscriptionSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "events.subscribed":
      api.setTransientStatus(
        `event stream ready: ${Array.isArray(payload.filters) && payload.filters.length > 0
          ? payload.filters.join(", ")
          : "all events"}`,
      );
      return true;
    case "events.unsubscribed":
      api.setTransientStatus("event stream detached");
      return true;
    default:
      return false;
  }
}

function handleSessionSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "chat.session":
      state.sessionId = payload.sessionId ?? state.sessionId;
      api.persistSessionId(state.sessionId);
      state.sessionAttachedAtMs = api.now();
      api.resetLiveRunSurface();
      state.runDetail = null;
      state.runState = "idle";
      state.runPhase = null;
      api.markBootstrapReady(`session ready: ${state.sessionId}`);
      return true;
    case "chat.owner":
      if (typeof payload.ownerToken === "string" && payload.ownerToken.trim()) {
        state.ownerToken = payload.ownerToken.trim();
        api.persistOwnerToken(state.ownerToken);
      }
      return true;
    case "chat.resumed":
      state.sessionId = payload.sessionId ?? state.sessionId;
      api.persistSessionId(state.sessionId);
      state.sessionAttachedAtMs = api.now();
      state.runState = "idle";
      state.runPhase = null;
      state.bootstrapReady = false;
      api.clearBootstrapTimer();
      api.resetLiveRunSurface();
      api.setTransientStatus(`session resumed: ${state.sessionId}; restoring history`);
      api.send("chat.history", api.authPayload({ limit: 50 }));
      api.requestRunInspect("resume", { force: true });
      return true;
    case "chat.sessions": {
      const sessions = surfaceEvent.payloadList ?? [];
      if (state.manualSessionsRequestPending) {
        state.manualSessionsRequestPending = false;
        api.eventStore.pushEvent("session", "Sessions", api.formatSessionSummaries(sessions), "teal");
        api.setTransientStatus("session list loaded");
        return true;
      }
      const target = api.latestSessionSummary(sessions, state.sessionId);
      if (target?.sessionId) {
        state.sessionId = target.sessionId;
        api.persistSessionId(state.sessionId);
        api.setTransientStatus(`resuming session ${state.sessionId}`);
        api.send("chat.resume", api.authPayload({ sessionId: target.sessionId }));
      } else {
        api.setTransientStatus("no existing session; creating a new one");
        api.send("chat.new", api.authPayload());
      }
      return true;
    }
    case "chat.history": {
      const history = surfaceEvent.payloadList ?? [];
      if (state.manualHistoryRequestPending) {
        state.manualHistoryRequestPending = false;
        api.eventStore.pushEvent("history", "Chat History", api.formatHistoryPayload(history), "slate");
        api.setTransientStatus(`history loaded: ${history.length} item(s)`);
      } else if (!state.bootstrapReady && state.sessionId) {
        api.eventStore.restoreTranscriptFromHistory(history);
        api.markBootstrapReady(`history restored: ${history.length} item(s)`);
        api.requestRunInspect("history restore", { force: true });
      } else {
        api.setTransientStatus(`history restored: ${history.length} item(s)`);
      }
      return true;
    }
    default:
      return false;
  }
}

function handleChatSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "chat.message":
      state.latestAgentSummary = api.sanitizeInlineText(payload.content ?? "") || null;
      api.setTransientStatus("agent reply received");
      api.eventStore.commitAgentMessage(payload.content ?? "");
      if (state.currentObjective && api.shouldAutoInspectRun(state.runDetail, state.runState)) {
        api.requestRunInspect("agent reply");
      }
      return true;
    case "chat.stream":
      {
        const chunk =
          typeof payload.content === "string"
            ? payload.content
            : typeof payload.delta === "string"
              ? payload.delta
              : "";
        if (chunk || payload.done) {
          api.eventStore.appendAgentStreamChunk(chunk, { done: payload.done === true });
        }
        const statusPreview = api.sanitizeInlineText(chunk);
        if (statusPreview) {
          api.setTransientStatus(`streaming: ${api.truncate(statusPreview, 72)}`);
        } else if (payload.done === true) {
          api.setTransientStatus("agent stream complete");
        } else {
          api.setTransientStatus("agent streaming…");
        }
      }
      return true;
    case "chat.typing":
      api.setTransientStatus("agent is typing…");
      return true;
    case "chat.cancelled":
      api.eventStore.cancelAgentStream("cancelled");
      api.setTransientStatus("chat cancelled");
      api.eventStore.pushEvent("cancelled", "Chat Cancelled", api.tryPrettyJson(payload), "amber");
      return true;
    case "chat.usage":
      state.lastUsageSummary = api.summarizeUsage(payload);
      state.liveSessionModelRoute =
        api.normalizeModelRoute(payload) ?? state.liveSessionModelRoute;
      return true;
    default:
      return false;
  }
}

function handleToolSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "tools.executing": {
      const toolName = payload.toolName ?? "unknown";
      const descriptor = api.describeToolStart(toolName, payload.args);
      const suppressTranscript = api.shouldSuppressToolTranscript(toolName, payload.args);
      const suppressActivity = api.shouldSuppressToolActivity(toolName, payload.args);
      if (!suppressActivity) {
        state.latestTool = toolName;
        state.latestToolState = "running";
        api.setTransientStatus(descriptor.title);
      }
      if (!suppressTranscript) {
        api.eventStore.pushEvent(
          "tool",
          descriptor.title,
          descriptor.body,
          descriptor.tone,
          api.descriptorEventMetadata
            ? api.descriptorEventMetadata(descriptor, {
              toolName,
              toolArgs: payload.args,
            })
            : {
            toolName,
            toolArgs: payload.args,
            previewMode: descriptor.previewMode,
          },
        );
      }
      api.requestRunInspect("tool start");
      return true;
    }
    case "tools.result":
      api.handleToolResult(
        payload.toolName ?? "unknown",
        Boolean(payload.isError),
        payload.result ?? "",
        payload.args,
      );
      api.requestRunInspect("tool result");
      return true;
    default:
      return false;
  }
}

function handleSocialSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "social.message") {
    return false;
  }
  api.setTransientStatus(
    `social message from ${api.truncate(payload.sender ?? "unknown", 32)}`,
  );
  api.eventStore.pushEvent(
    "social",
    "Social Message",
    [
      `from: ${payload.sender ?? "unknown"}`,
      `to: ${payload.recipient ?? "unknown"}`,
      `mode: ${payload.mode ?? "unknown"}`,
      `messageId: ${payload.messageId ?? "unknown"}`,
      `threadId: ${payload.threadId ?? "none"}`,
      "",
      payload.content ?? "",
    ].join("\n"),
    "blue",
  );
  return true;
}

function handleRunSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "runs.list":
      api.eventStore.pushEvent("runs", "Run List", api.tryPrettyJson(surfaceEvent.payloadList ?? []), "blue");
      return true;
    case "run.inspect":
      state.runInspectPending = false;
      state.runDetail = payload;
      state.currentObjective = payload.objective ?? state.currentObjective;
      state.runState = payload.state ?? state.runState;
      state.runPhase = payload.currentPhase ?? state.runPhase;
      state.activeRunStartedAtMs = Number.isFinite(Number(payload.createdAt))
        ? Number(payload.createdAt)
        : state.activeRunStartedAtMs ?? api.now();
      api.hydratePlannerDagFromTraceArtifacts(payload.sessionId ?? state.sessionId);
      api.setTransientStatus(`run inspect loaded: ${state.runState ?? "unknown"}`);
      return true;
    case "run.updated":
      state.runState = payload.state ?? state.runState;
      state.runPhase = payload.currentPhase ?? state.runPhase;
      if (!Number.isFinite(Number(state.activeRunStartedAtMs))) {
        state.activeRunStartedAtMs = api.now();
      }
      api.setTransientStatus(`run updated: ${state.runState ?? "unknown"}`);
      api.eventStore.pushEvent(
        "run",
        "Run Update",
        [
          `state: ${state.runState ?? "unknown"}`,
          `phase: ${state.runPhase ?? "unknown"}`,
          `session: ${payload.sessionId ?? state.sessionId ?? "unknown"}`,
          payload.explanation ? `explanation: ${payload.explanation}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "magenta",
      );
      api.requestRunInspect("run update");
      return true;
    default:
      return false;
  }
}

function handleObservabilitySurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "observability.traces":
      api.setTransientStatus("trace list loaded");
      api.eventStore.pushEvent("trace", "Trace List", api.tryPrettyJson(surfaceEvent.payloadList ?? []), "slate");
      return true;
    case "observability.trace":
      api.setTransientStatus("trace detail loaded");
      api.eventStore.pushEvent(
        "trace",
        "Trace Detail",
        api.tryPrettyJson(payload.summary ?? payload),
        "slate",
      );
      return true;
    case "observability.logs":
      api.setTransientStatus("log bundle loaded");
      api.eventStore.pushEvent("logs", "Daemon Logs", api.formatLogPayload(payload), "slate");
      return true;
    default:
      return false;
  }
}

function handleStatusSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "status.update") {
    return false;
  }
  state.lastStatus = payload ?? state.lastStatus;
  state.configuredModelRoute =
    api.normalizeModelRoute(payload) ?? state.configuredModelRoute;
  const backgroundRuns = payload?.backgroundRuns;
  if (backgroundRuns?.enabled === false) {
    api.setTransientStatus("durable runs disabled");
  } else if (
    backgroundRuns &&
    backgroundRuns.enabled === true &&
    backgroundRuns.operatorAvailable === false
  ) {
    api.setTransientStatus("durable run operator unavailable");
  } else {
    api.setTransientStatus("gateway status loaded");
  }
  const fingerprint = api.statusFeedFingerprint(payload);
  const shouldEmit =
    state.manualStatusRequestPending ||
    state.lastStatusFeedFingerprint === null ||
    fingerprint !== state.lastStatusFeedFingerprint;
  state.manualStatusRequestPending = false;
  state.lastStatusFeedFingerprint = fingerprint;
  if (shouldEmit) {
    api.eventStore.pushEvent("status", "Gateway Status", api.formatStatusPayload(payload), "blue");
  }
  return true;
}

function handleAgentSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "agent.status") {
    return false;
  }
  state.runPhase = payload.phase ?? state.runPhase;
  if (payload.phase === "idle") {
    state.runState = "idle";
    state.activeRunStartedAtMs = null;
  }
  api.setTransientStatus(
    payload.phase
      ? `phase ${payload.phase}`
      : "agent status updated",
  );
  if (payload.phase !== "idle") {
    api.requestRunInspect("agent status");
  }
  return true;
}

function handleApprovalSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "approval.request":
      api.eventStore.pushEvent("approval", "Approval Request", api.tryPrettyJson(payload), "red");
      return true;
    case "approval.escalated":
      api.eventStore.pushEvent("approval", "Approval Escalated", api.tryPrettyJson(payload), "amber");
      return true;
    default:
      return false;
  }
}

function handleErrorSurfaceEvent(surfaceEvent, rawMessage, state, api) {
  const errorMessage = surfaceEvent.message.error;
  const errorPayload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "error") {
    return false;
  }
  state.runInspectPending = false;
  state.manualStatusRequestPending = false;
  state.manualSessionsRequestPending = false;
  state.manualHistoryRequestPending = false;
  if (api.isExpectedMissingRunInspect(errorMessage, errorPayload)) {
    state.runDetail = null;
    state.runState = "idle";
    state.runPhase = null;
    api.setTransientStatus("no active background run for this session");
    return true;
  }
  if (api.isUnavailableBackgroundRunInspect(errorPayload)) {
    state.runDetail = null;
    state.runState = "idle";
    state.runPhase = null;
    api.setTransientStatus(
      errorPayload?.backgroundRunAvailability?.disabledReason ??
        "durable run operator unavailable",
    );
    api.eventStore.pushEvent(
      "run",
      "Durable Run Unavailable",
      errorMessage ?? api.tryPrettyJson(errorPayload),
      "amber",
    );
    return true;
  }
  if (api.isRetryableBootstrapError(errorMessage)) {
    api.scheduleBootstrap("webchat handler still starting");
    return true;
  }
  api.eventStore.cancelAgentStream("error");
  api.setTransientStatus("runtime error");
  api.eventStore.pushEvent(
    "error",
    "Runtime Error",
    errorMessage ?? api.tryPrettyJson(surfaceEvent.payload ?? rawMessage),
    "red",
  );
  return true;
}

function handleUnknownSurfaceEvent(surfaceEvent, rawMessage, api) {
  api.eventStore.pushEvent(
    surfaceEvent.type,
    surfaceEvent.type,
    api.tryPrettyJson(surfaceEvent.payload ?? rawMessage),
    "slate",
  );
  return true;
}
