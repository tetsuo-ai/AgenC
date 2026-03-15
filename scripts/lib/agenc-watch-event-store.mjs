function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchEventStore requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchEventStore requires a ${name} object`);
  }
}

function assertArray(name, value) {
  if (!Array.isArray(value)) {
    throw new TypeError(`createWatchEventStore requires a ${name} array`);
  }
}

function defaultHistoryTimestampFormatter(value, nowStamp) {
  if (!value) {
    return nowStamp();
  }
  return new Date(value).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function createWatchEventStore(dependencies = {}) {
  const {
    watchState,
    events,
    maxEvents,
    introDismissKinds,
    nextId,
    nowStamp,
    nowMs = Date.now,
    normalizeEventBody,
    sanitizeLargeText,
    sanitizeInlineText,
    stripTerminalControlSequences,
    dismissIntro,
    scheduleRender,
    withPreservedManualTranscriptViewport,
    findLatestPendingAgentEvent,
    nextAgentStreamState,
    setTransientStatus,
    resetDelegationState,
    applyDescriptorRenderingMetadata,
    formatHistoryTimestamp = defaultHistoryTimestampFormatter,
  } = dependencies;

  assertObject("watchState", watchState);
  assertArray("events", events);
  if (!Number.isFinite(maxEvents) || maxEvents <= 0) {
    throw new TypeError("createWatchEventStore requires a positive maxEvents number");
  }
  if (!(introDismissKinds instanceof Set)) {
    throw new TypeError("createWatchEventStore requires an introDismissKinds set");
  }

  const requiredFunctions = {
    nextId,
    nowStamp,
    normalizeEventBody,
    sanitizeLargeText,
    sanitizeInlineText,
    stripTerminalControlSequences,
    dismissIntro,
    scheduleRender,
    withPreservedManualTranscriptViewport,
    findLatestPendingAgentEvent,
    nextAgentStreamState,
    setTransientStatus,
    resetDelegationState,
    applyDescriptorRenderingMetadata,
    formatHistoryTimestamp,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    assertFunction(name, value);
  }

  function clampExpandedEventSelection() {
    if (watchState.expandedEventId && !events.some((event) => event.id === watchState.expandedEventId)) {
      watchState.expandedEventId = null;
    }
  }

  function trimBoundedHistory() {
    while (events.length > maxEvents) {
      events.shift();
    }
    clampExpandedEventSelection();
  }

  function followTranscriptIfNeeded(shouldFollow) {
    if (!shouldFollow) {
      return;
    }
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
  }

  function updateActivity(timestamp) {
    watchState.lastActivityAt = timestamp;
  }

  function updateLatestAgentSummary(event) {
    if (!event) {
      return;
    }
    watchState.latestAgentSummary =
      sanitizeInlineText(storedEventBody(event)) || watchState.latestAgentSummary;
  }

  function shouldCoalesceRenderedEvent(previousEvent, nextEvent) {
    if (!previousEvent || !nextEvent) {
      return false;
    }
    if (previousEvent.kind !== nextEvent.kind) {
      return false;
    }
    if (previousEvent.title !== nextEvent.title || previousEvent.body !== nextEvent.body) {
      return false;
    }
    if ((previousEvent.subagentSessionId ?? null) !== (nextEvent.subagentSessionId ?? null)) {
      return false;
    }
    if ((previousEvent.toolName ?? null) !== (nextEvent.toolName ?? null)) {
      return false;
    }
    const previousCreatedAt = Number(previousEvent.createdAtMs);
    const nextCreatedAt = Number(nextEvent.createdAtMs);
    return Number.isFinite(previousCreatedAt) &&
      Number.isFinite(nextCreatedAt) &&
      nextCreatedAt - previousCreatedAt <= 2_500;
  }

  function storedEventBody(event) {
    if (!event || typeof event.body !== "string") {
      return "";
    }
    return event.bodyTruncated && event.body.endsWith("…")
      ? event.body.slice(0, -1)
      : event.body;
  }

  function updateExistingEventBody(event, body) {
    const normalized = normalizeEventBody(body);
    event.body = normalized.body;
    event.bodyTruncated = normalized.bodyTruncated;
  }

  function restoreTranscriptFromHistory(history) {
    if (!Array.isArray(history)) {
      return;
    }
    events.length = 0;
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
    watchState.detailScrollOffset = 0;
    for (const entry of history.slice(-maxEvents)) {
      const sender = String(entry?.sender ?? "").toLowerCase();
      const kind =
        sender === "user"
          ? "you"
          : sender === "agent" || sender === "assistant"
            ? "agent"
            : "history";
      const normalized = normalizeEventBody(entry?.content ?? "(empty)");
      const timestamp = formatHistoryTimestamp(entry?.timestamp, nowStamp);
      events.push({
        id: nextId("evt"),
        kind,
        title:
          sender === "user"
            ? "Prompt"
            : sender === "agent" || sender === "assistant"
              ? "Agent Reply"
              : String(entry?.sender ?? "History"),
        tone: kind === "you" ? "teal" : kind === "agent" ? "cyan" : "slate",
        timestamp,
        createdAtMs: entry?.timestamp ? Number(new Date(entry.timestamp)) || nowMs() : nowMs(),
        body: normalized.body,
        bodyTruncated: normalized.bodyTruncated,
        renderMode: kind === "agent" ? "markdown" : undefined,
      });
      updateActivity(timestamp);
    }
    if (events.length === 0) {
      watchState.lastActivityAt = null;
    }
    clampExpandedEventSelection();
  }

  function pushEvent(kind, title, body, tone, metadata = {}) {
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const timestamp = nowStamp();
      const createdAtMs = nowMs();
      const normalized = normalizeEventBody(body);
      const nextEvent = {
        id: nextId("evt"),
        kind,
        title,
        tone,
        timestamp,
        createdAtMs,
        body: normalized.body,
        bodyTruncated: normalized.bodyTruncated,
        ...metadata,
      };
      const lastEvent = events[events.length - 1];
      if (shouldCoalesceRenderedEvent(lastEvent, nextEvent)) {
        lastEvent.timestamp = timestamp;
        lastEvent.createdAtMs = createdAtMs;
        lastEvent.tone = tone;
        lastEvent.bodyTruncated = normalized.bodyTruncated;
        updateActivity(timestamp);
        followTranscriptIfNeeded(shouldFollow);
        scheduleRender();
        return lastEvent;
      }
      events.push(nextEvent);
      if (introDismissKinds.has(kind)) {
        dismissIntro();
      }
      updateActivity(timestamp);
      trimBoundedHistory();
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return nextEvent;
    });
  }

  function findLatestStreamingAgentEvent() {
    return findLatestPendingAgentEvent(events);
  }

  function appendAgentStreamChunk(chunk, { done = false } = {}) {
    const safeChunk = stripTerminalControlSequences(sanitizeLargeText(chunk ?? ""));
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const timestamp = nowStamp();
      const createdAtMs = nowMs();
      let target = findLatestStreamingAgentEvent();
      if (!target) {
        if (!safeChunk) {
          return null;
        }
        const normalized = normalizeEventBody(safeChunk || "(streaming)");
        target = {
          id: nextId("evt"),
          kind: "agent",
          title: "Agent Reply · live",
          tone: "cyan",
          timestamp,
          createdAtMs,
          body: normalized.body,
          bodyTruncated: normalized.bodyTruncated,
          renderMode: "markdown",
          streamState: nextAgentStreamState({ done }),
        };
        events.push(target);
        if (introDismissKinds.has("agent")) {
          dismissIntro();
        }
        trimBoundedHistory();
      } else if (safeChunk) {
        updateExistingEventBody(target, `${storedEventBody(target)}${safeChunk}`);
        target.timestamp = timestamp;
        target.createdAtMs = createdAtMs;
        target.title = "Agent Reply · live";
        target.streamState = nextAgentStreamState({ done });
      } else {
        target.timestamp = timestamp;
        target.createdAtMs = createdAtMs;
        target.title = done ? "Agent Reply · live" : target.title;
        target.streamState = done ? nextAgentStreamState({ done }) : target.streamState;
      }
      updateLatestAgentSummary(target);
      updateActivity(timestamp);
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return target;
    });
  }

  function commitAgentMessage(body) {
    const content = stripTerminalControlSequences(sanitizeLargeText(body ?? ""));
    const target = findLatestStreamingAgentEvent();
    if (!target) {
      return pushEvent("agent", "Agent Reply", content || "(empty)", "cyan", {
        renderMode: "markdown",
        streamState: "complete",
      });
    }
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const timestamp = nowStamp();
      const createdAtMs = nowMs();
      updateExistingEventBody(target, content || storedEventBody(target) || "(empty)");
      target.timestamp = timestamp;
      target.createdAtMs = createdAtMs;
      target.title = "Agent Reply";
      target.tone = "cyan";
      target.renderMode = "markdown";
      target.streamState = "complete";
      updateLatestAgentSummary(target);
      updateActivity(timestamp);
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return target;
    });
  }

  function cancelAgentStream(reason = "cancelled") {
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const target = findLatestStreamingAgentEvent();
      if (!target) {
        return false;
      }
      target.title = reason === "error" ? "Agent Reply Interrupted" : "Agent Reply Cancelled";
      target.tone = reason === "error" ? "red" : "amber";
      target.streamState = reason;
      target.timestamp = nowStamp();
      target.createdAtMs = nowMs();
      updateLatestAgentSummary(target);
      updateActivity(target.timestamp);
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return true;
    });
  }

  function upsertSubagentHeartbeatEvent(
    subagentSessionId,
    title,
    body,
    tone,
    metadata = {},
  ) {
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const timestamp = nowStamp();
      const normalized = normalizeEventBody(body);
      let heartbeatId = nextId("evt");

      if (typeof subagentSessionId === "string" && subagentSessionId.trim()) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (
            event?.subagentHeartbeat &&
            event.subagentSessionId === subagentSessionId
          ) {
            heartbeatId = event.id;
            events.splice(index, 1);
            break;
          }
        }
      }

      events.push({
        id: heartbeatId,
        kind: "subagent",
        title,
        tone,
        timestamp,
        createdAtMs: nowMs(),
        body: normalized.body,
        bodyTruncated: normalized.bodyTruncated,
        ...metadata,
        subagentHeartbeat: true,
      });
      if (introDismissKinds.has("subagent")) {
        dismissIntro();
      }
      updateActivity(timestamp);
      trimBoundedHistory();
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return heartbeatId;
    });
  }

  function clearSubagentHeartbeatEvents(subagentSessionId) {
    if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
      return false;
    }
    let removed = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.subagentHeartbeat &&
        event.subagentSessionId === subagentSessionId
      ) {
        events.splice(index, 1);
        removed = true;
      }
    }
    clampExpandedEventSelection();
    return removed;
  }

  function replaceLatestToolEvent(toolName, isError, body, descriptor) {
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "tool") {
        return false;
      }
      if (lastEvent.toolName !== toolName) {
        return false;
      }
      const normalized = normalizeEventBody(body);
      lastEvent.kind = isError ? "tool error" : "tool result";
      lastEvent.title = descriptor?.title ?? toolName;
      lastEvent.tone = descriptor?.tone ?? (isError ? "red" : "green");
      lastEvent.timestamp = nowStamp();
      lastEvent.createdAtMs = nowMs();
      lastEvent.body = normalized.body;
      lastEvent.bodyTruncated = normalized.bodyTruncated;
      applyDescriptorRenderingMetadata(lastEvent, descriptor);
      updateActivity(lastEvent.timestamp);
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return true;
    });
  }

  function replaceLatestSubagentToolEvent(
    subagentSessionId,
    toolName,
    isError,
    body,
    descriptor,
  ) {
    return withPreservedManualTranscriptViewport(({ shouldFollow }) => {
      let lastEvent = null;
      for (let index = events.length - 1; index >= Math.max(0, events.length - 6); index -= 1) {
        const candidate = events[index];
        if (
          candidate?.subagentHeartbeat &&
          candidate.subagentSessionId === subagentSessionId
        ) {
          continue;
        }
        lastEvent = candidate ?? null;
        break;
      }
      if (!lastEvent || lastEvent.kind !== "subagent tool") {
        return false;
      }
      if (
        lastEvent.toolName !== toolName ||
        lastEvent.subagentSessionId !== subagentSessionId
      ) {
        return false;
      }
      const normalized = normalizeEventBody(body);
      lastEvent.kind = isError ? "subagent error" : "subagent tool result";
      lastEvent.title = descriptor?.title ?? toolName;
      lastEvent.tone = descriptor?.tone ?? (isError ? "red" : "green");
      lastEvent.timestamp = nowStamp();
      lastEvent.createdAtMs = nowMs();
      lastEvent.body = normalized.body;
      lastEvent.bodyTruncated = normalized.bodyTruncated;
      applyDescriptorRenderingMetadata(lastEvent, descriptor);
      updateActivity(lastEvent.timestamp);
      followTranscriptIfNeeded(shouldFollow);
      scheduleRender();
      return true;
    });
  }

  function clearLiveTranscriptView() {
    events.length = 0;
    resetDelegationState();
    watchState.expandedEventId = null;
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
    watchState.detailScrollOffset = 0;
    setTransientStatus("view cleared");
  }

  return {
    events,
    pushEvent,
    appendAgentStreamChunk,
    commitAgentMessage,
    cancelAgentStream,
    restoreTranscriptFromHistory,
    upsertSubagentHeartbeatEvent,
    clearSubagentHeartbeatEvents,
    replaceLatestToolEvent,
    replaceLatestSubagentToolEvent,
    clearLiveTranscriptView,
  };
}
