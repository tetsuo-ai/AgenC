function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchTransportController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchTransportController requires a ${name} object`);
  }
}

export function createWatchTransportController(dependencies = {}) {
  const {
    transportState,
    watchState,
    pendingFrames,
    liveEventFilters,
    connectedStatusText = "connected",
    reconnectMinDelayMs,
    reconnectMaxDelayMs,
    statusPollIntervalMs,
    activityPulseIntervalMs,
    createSocket,
    nextFrameId,
    normalizeOperatorMessage,
    projectOperatorSurfaceEvent,
    shouldIgnoreOperatorMessage,
    dispatchOperatorSurfaceEvent,
    scheduleRender,
    setTransientStatus,
    pushEvent,
    authPayload,
    hasActiveSurfaceRun,
    shuttingDown,
    flushQueuedOperatorInputs,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
  } = dependencies;

  assertObject("transportState", transportState);
  assertObject("watchState", watchState);
  if (!Array.isArray(pendingFrames)) {
    throw new TypeError("createWatchTransportController requires a pendingFrames array");
  }
  if (!Array.isArray(liveEventFilters)) {
    throw new TypeError("createWatchTransportController requires a liveEventFilters array");
  }
  assertFunction("createSocket", createSocket);
  assertFunction("nextFrameId", nextFrameId);
  assertFunction("normalizeOperatorMessage", normalizeOperatorMessage);
  assertFunction("projectOperatorSurfaceEvent", projectOperatorSurfaceEvent);
  assertFunction("shouldIgnoreOperatorMessage", shouldIgnoreOperatorMessage);
  assertFunction("dispatchOperatorSurfaceEvent", dispatchOperatorSurfaceEvent);
  assertFunction("scheduleRender", scheduleRender);
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("pushEvent", pushEvent);
  assertFunction("authPayload", authPayload);
  assertFunction("hasActiveSurfaceRun", hasActiveSurfaceRun);
  assertFunction("shuttingDown", shuttingDown);
  assertFunction("flushQueuedOperatorInputs", flushQueuedOperatorInputs);

  function clearBootstrapTimer() {
    if (!transportState.bootstrapTimer) {
      return;
    }
    clearTimeoutFn(transportState.bootstrapTimer);
    transportState.bootstrapTimer = null;
  }

  function clearStatusPollTimer() {
    if (!transportState.statusPollTimer) {
      return;
    }
    clearIntervalFn(transportState.statusPollTimer);
    transportState.statusPollTimer = null;
  }

  function clearActivityPulseTimer() {
    if (!transportState.activityPulseTimer) {
      return;
    }
    clearIntervalFn(transportState.activityPulseTimer);
    transportState.activityPulseTimer = null;
  }

  function send(type, payload) {
    const frame = JSON.stringify({ type, payload, id: nextFrameId(type) });
    if (!transportState.isOpen) {
      pendingFrames.push(frame);
      return;
    }
    transportState.ws?.send(frame);
  }

  function ensureStatusPollTimer() {
    clearStatusPollTimer();
    transportState.statusPollTimer = setIntervalFn(() => {
      if (!transportState.isOpen || shuttingDown()) {
        return;
      }
      send("status.get", {});
    }, statusPollIntervalMs);
  }

  function ensureActivityPulseTimer() {
    if (transportState.activityPulseTimer) {
      return;
    }
    transportState.activityPulseTimer = setIntervalFn(() => {
      if (shuttingDown()) {
        return;
      }
      if (hasActiveSurfaceRun() || transportState.connectionState !== "live") {
        scheduleRender();
      }
    }, activityPulseIntervalMs);
  }

  function bootstrapPending() {
    return !watchState.bootstrapReady;
  }

  function markBootstrapReady(statusText) {
    watchState.bootstrapReady = true;
    watchState.bootstrapAttempts = 0;
    clearBootstrapTimer();
    setTransientStatus(statusText);
    flushQueuedOperatorInputs();
  }

  function sendBootstrapProbe() {
    if (!transportState.isOpen || shuttingDown()) {
      return;
    }
    send("chat.sessions", authPayload());
  }

  function scheduleBootstrap(reason = "restoring session") {
    if (shuttingDown() || !transportState.isOpen) {
      return;
    }
    watchState.bootstrapReady = false;
    clearBootstrapTimer();
    const delayMs = Math.min(2_000, Math.max(250, watchState.bootstrapAttempts * 250));
    transportState.bootstrapTimer = setTimeoutFn(() => {
      transportState.bootstrapTimer = null;
      watchState.bootstrapAttempts += 1;
      sendBootstrapProbe();
    }, delayMs);
    setTransientStatus(`${reason}; retrying in ${delayMs}ms`);
  }

  function scheduleReconnect() {
    if (shuttingDown() || transportState.reconnectTimer) {
      return;
    }
    const delayMs = Math.min(
      reconnectMaxDelayMs,
      reconnectMinDelayMs * Math.max(1, transportState.reconnectAttempts),
    );
    transportState.reconnectTimer = setTimeoutFn(() => {
      transportState.reconnectTimer = null;
      connect();
    }, delayMs);
    setTransientStatus(`websocket disconnected, retrying in ${delayMs}ms`);
  }

  function handleSocketOpen(socket) {
    transportState.ws = socket;
    transportState.isOpen = true;
    transportState.reconnectAttempts = 0;
    watchState.bootstrapAttempts = 0;
    watchState.bootstrapReady = false;
    transportState.connectionState = "live";
    setTransientStatus(connectedStatusText);
    while (pendingFrames.length > 0) {
      socket.send(pendingFrames.shift());
    }
    send("events.subscribe", { filters: [...liveEventFilters] });
    send("status.get", {});
    ensureStatusPollTimer();
    sendBootstrapProbe();
  }

  function handleSocketMessage(event) {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      pushEvent("raw", "Unparsed Event", raw, "slate");
      return;
    }
    const normalizedMessage = normalizeOperatorMessage(msg);
    if (shouldIgnoreOperatorMessage(normalizedMessage, watchState.sessionId)) {
      return;
    }
    const surfaceEvent = projectOperatorSurfaceEvent(normalizedMessage);
    dispatchOperatorSurfaceEvent(surfaceEvent, msg);
    scheduleRender();
  }

  function handleSocketClose() {
    transportState.isOpen = false;
    transportState.ws = null;
    watchState.bootstrapReady = false;
    watchState.manualSessionsRequestPending = false;
    watchState.manualHistoryRequestPending = false;
    transportState.connectionState = "reconnecting";
    clearBootstrapTimer();
    clearStatusPollTimer();
    if (shuttingDown()) {
      return;
    }
    transportState.reconnectAttempts += 1;
    scheduleReconnect();
  }

  function handleSocketError(error) {
    const message =
      typeof error?.message === "string" && error.message.trim().length > 0
        ? error.message.trim()
        : "";
    if (message) {
      pushEvent("ws-error", "WebSocket Error", message, "red");
    } else {
      setTransientStatus("websocket reconnecting");
    }
    if (!transportState.isOpen) {
      scheduleReconnect();
    }
  }

  function attachSocket(socket) {
    socket.addEventListener("open", () => {
      handleSocketOpen(socket);
    });
    socket.addEventListener("message", (event) => {
      handleSocketMessage(event);
    });
    socket.addEventListener("close", () => {
      handleSocketClose();
    });
    socket.addEventListener("error", (error) => {
      handleSocketError(error);
    });
  }

  function connect() {
    if (shuttingDown()) {
      return;
    }
    transportState.connectionState =
      transportState.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    setTransientStatus(`${transportState.connectionState}…`);
    const socket = createSocket();
    attachSocket(socket);
  }

  function dispose() {
    if (transportState.reconnectTimer) {
      clearTimeoutFn(transportState.reconnectTimer);
      transportState.reconnectTimer = null;
    }
    clearBootstrapTimer();
    clearStatusPollTimer();
    clearActivityPulseTimer();
    try {
      transportState.ws?.close();
    } catch {}
    transportState.isOpen = false;
    transportState.ws = null;
  }

  return {
    send,
    connect,
    attachSocket,
    dispose,
    clearBootstrapTimer,
    clearStatusPollTimer,
    clearActivityPulseTimer,
    ensureStatusPollTimer,
    ensureActivityPulseTimer,
    bootstrapPending,
    markBootstrapReady,
    sendBootstrapProbe,
    scheduleBootstrap,
    scheduleReconnect,
  };
}
