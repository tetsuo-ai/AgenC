function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchCommandController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchCommandController requires a ${name} object`);
  }
}

export function createWatchCommandController(dependencies = {}) {
  const {
    watchState,
    queuedOperatorInputs,
    WATCH_COMMANDS,
    parseWatchSlashCommand,
    authPayload,
    send,
    shutdownWatch,
    dismissIntro,
    clearLiveTranscriptView,
    exportCurrentView,
    resetLiveRunSurface,
    resetDelegationState,
    persistSessionId,
    clearBootstrapTimer,
    pushEvent,
    setTransientStatus,
    readWatchDaemonLogTail,
    formatLogPayload,
    currentClientKey,
    isOpen,
    bootstrapPending,
    voiceController,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  if (!Array.isArray(queuedOperatorInputs)) {
    throw new TypeError("createWatchCommandController requires a queuedOperatorInputs array");
  }
  if (!Array.isArray(WATCH_COMMANDS)) {
    throw new TypeError("createWatchCommandController requires WATCH_COMMANDS");
  }
  assertFunction("parseWatchSlashCommand", parseWatchSlashCommand);
  assertFunction("authPayload", authPayload);
  assertFunction("send", send);
  assertFunction("shutdownWatch", shutdownWatch);
  assertFunction("dismissIntro", dismissIntro);
  assertFunction("clearLiveTranscriptView", clearLiveTranscriptView);
  assertFunction("exportCurrentView", exportCurrentView);
  assertFunction("resetLiveRunSurface", resetLiveRunSurface);
  assertFunction("resetDelegationState", resetDelegationState);
  assertFunction("persistSessionId", persistSessionId);
  assertFunction("clearBootstrapTimer", clearBootstrapTimer);
  assertFunction("pushEvent", pushEvent);
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("readWatchDaemonLogTail", readWatchDaemonLogTail);
  assertFunction("formatLogPayload", formatLogPayload);
  assertFunction("currentClientKey", currentClientKey);
  assertFunction("isOpen", isOpen);
  assertFunction("bootstrapPending", bootstrapPending);
  assertFunction("nowMs", nowMs);

  function printHelp() {
    pushEvent(
      "help",
      "Command Help",
      [
        "Keyboard",
        "Ctrl+O opens the newest event in a full detail view.",
        "Ctrl+Y copies the current detail view or transcript to tmux/system clipboard.",
        "Ctrl+L clears the visible transcript without leaving the session.",
        "",
        ...WATCH_COMMANDS.map((command) => {
          const aliasText =
            Array.isArray(command.aliases) && command.aliases.length > 0
              ? ` (${command.aliases.join(", ")})`
              : "";
          return `${command.usage}${aliasText}\n${command.description}`;
        }),
      ].join("\n\n"),
      "slate",
    );
  }

  function queueOperatorInput(value, reason = "bootstrap pending") {
    queuedOperatorInputs.push(value);
    pushEvent(
      "queued",
      "Queued Input",
      `${value}\n\n${reason}`,
      "amber",
    );
    setTransientStatus(`queued ${value} until session restore completes`);
  }

  function requireSession(command) {
    if (!watchState.sessionId) {
      pushEvent("error", "Session Error", `${command} requires an active session`, "red");
      return false;
    }
    return true;
  }

  function shouldQueueOperatorInput() {
    return !isOpen() || bootstrapPending();
  }

  function dispatchOperatorInput(value, { replayed = false } = {}) {
    dismissIntro();
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
    const maybeQueue = (reason) => {
      if (replayed) {
        pushEvent("error", "Queued Input Failed", `${value}\n\n${reason}`, "red");
        return true;
      }
      queueOperatorInput(value, reason);
      return true;
    };

    if (value.trim() === "/") {
      printHelp();
      return true;
    }

    const parsedSlash = parseWatchSlashCommand(value);
    if (parsedSlash) {
      const canonicalName = parsedSlash.command?.name ?? null;
      const firstArg = parsedSlash.args[0];

      if (canonicalName === "/quit") {
        shutdownWatch(0);
        return true;
      }

      if (canonicalName === "/help") {
        printHelp();
        return true;
      }

      if (canonicalName === "/clear") {
        clearLiveTranscriptView();
        return true;
      }

      if (canonicalName === "/export") {
        exportCurrentView({ announce: true });
        return true;
      }

      if (!canonicalName) {
        pushEvent(
          "error",
          "Unknown Command",
          `${parsedSlash.commandToken} is not a supported command.\n\nUse /help for the full command list.`,
          "red",
        );
        return true;
      }

      if (shouldQueueOperatorInput()) {
        return maybeQueue("session bootstrap not complete");
      }

      if (canonicalName === "/model") {
        const modelArg = (firstArg ?? "").trim();
        pushEvent(
          "operator",
          modelArg ? "Model Switch" : "Model Query",
          modelArg
            ? `Requested model switch to: ${modelArg}`
            : "Requested current model routing info.",
          "teal",
        );
        send("chat.message", authPayload({ content: value }));
        return true;
      }

      if (canonicalName === "/init") {
        pushEvent(
          "operator",
          "Project Guide Init",
          "Requested AGENC.md generation for the active workspace.",
          "teal",
        );
        send("chat.message", authPayload({ content: value }));
        return true;
      }

      if (canonicalName === "/voice") {
        if (voiceController) {
          const voiceArg = (firstArg ?? "").trim().toLowerCase();
          if (voiceArg === "stop" || voiceArg === "off") {
            voiceController.stopVoice();
          } else if (!voiceArg || voiceArg === "start" || voiceArg === "on") {
            voiceController.startVoice();
          } else {
            // Voice persona change or config query — forward to daemon
            send("chat.message", authPayload({ content: value }));
          }
        } else {
          // No voice controller — just forward to daemon for config display
          send("chat.message", authPayload({ content: value }));
        }
        return true;
      }

      if (canonicalName === "/context") {
        pushEvent("operator", "Context", "Requested context window usage.", "teal");
        send("chat.message", authPayload({ content: "/context" }));
        return true;
      }

      if (canonicalName === "/memory") {
        if (shouldQueueOperatorInput()) {
          return maybeQueue("session bootstrap not complete");
        }
        const query = (firstArg ?? "").trim();
        if (query) {
          pushEvent("operator", "Memory Search", `Searching memory for: ${query}`, "teal");
          send("memory.search", authPayload({ query }));
        } else {
          pushEvent("operator", "Memory Sessions", "Fetching memory sessions.", "teal");
          send("memory.sessions", authPayload({ limit: 20 }));
        }
        return true;
      }

      if (canonicalName === "/new") {
        resetLiveRunSurface();
        resetDelegationState();
        watchState.currentObjective = null;
        watchState.runDetail = null;
        watchState.runState = "idle";
        watchState.runPhase = null;
        watchState.bootstrapAttempts = 0;
        clearBootstrapTimer();
        pushEvent("operator", "New Session", "Requested a fresh chat session.", "teal");
        send("chat.new", authPayload());
        return true;
      }

      if (canonicalName === "/sessions") {
        watchState.manualSessionsRequestPending = true;
        pushEvent("operator", "Session List", "Requested resumable sessions.", "teal");
        send("chat.sessions", authPayload());
        return true;
      }

      if (canonicalName === "/session") {
        if (!firstArg) {
          pushEvent(
            "error",
            "Missing Session Id",
            "Usage: /session <sessionId>",
            "red",
          );
          return true;
        }
        watchState.sessionId = firstArg;
        persistSessionId(watchState.sessionId);
        pushEvent("operator", "Session Resume", `Resuming ${firstArg}.`, "teal");
        send("chat.resume", authPayload({ sessionId: firstArg }));
        return true;
      }

      if (canonicalName === "/history") {
        watchState.manualHistoryRequestPending = true;
        const limit = Number(firstArg);
        const payload = Number.isFinite(limit) && limit > 0
          ? authPayload({ limit: Math.floor(limit) })
          : authPayload();
        pushEvent("operator", "History Query", "Requested recent chat history.", "teal");
        send("chat.history", payload);
        return true;
      }

      if (canonicalName === "/runs") {
        pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
        send("runs.list", watchState.sessionId ? { sessionId: watchState.sessionId } : {});
        return true;
      }

      if (canonicalName === "/inspect") {
        if (!requireSession("/inspect")) return true;
        watchState.runInspectPending = true;
        pushEvent("operator", "Run Inspect", `Inspecting run for ${watchState.sessionId}.`, "teal");
        send("run.inspect", { sessionId: watchState.sessionId });
        return true;
      }

      if (canonicalName === "/trace") {
        if (firstArg) {
          pushEvent("operator", "Trace Detail", `Inspecting trace ${firstArg}.`, "teal");
          send("observability.trace", { traceId: firstArg });
        } else {
          pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
          send(
            "observability.traces",
            watchState.sessionId ? { sessionId: watchState.sessionId, limit: 5 } : { limit: 5 },
          );
        }
        return true;
      }

      if (canonicalName === "/logs") {
        const lines = Number(firstArg);
        const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 80;
        pushEvent("operator", "Log Query", `Requested recent daemon logs (${lineCount} lines).`, "teal");
        try {
          const logs = readWatchDaemonLogTail({ lines: lineCount });
          setTransientStatus("log bundle loaded");
          pushEvent("logs", "Daemon Logs", formatLogPayload(logs), "slate");
        } catch (error) {
          setTransientStatus("runtime error");
          pushEvent(
            "error",
            "Runtime Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/status") {
        watchState.manualStatusRequestPending = true;
        pushEvent("operator", "Gateway Status", "Requested daemon status.", "teal");
        send("status.get", {});
        return true;
      }

      if (canonicalName === "/cancel") {
        pushEvent("operator", "Cancel Chat", `Cancelling chat for ${currentClientKey()}.`, "teal");
        send("chat.cancel", authPayload());
        return true;
      }

      if (canonicalName === "/pause" || canonicalName === "/resume" || canonicalName === "/stop") {
        if (!requireSession(canonicalName)) return true;
        watchState.runInspectPending = true;
        const action = canonicalName.slice(1);
        const title = action[0].toUpperCase() + action.slice(1);
        const progressiveVerb =
          action === "pause"
            ? "Pausing"
            : action === "resume"
              ? "Resuming"
              : "Stopping";
        pushEvent("operator", `${title} Run`, `${progressiveVerb} run for ${watchState.sessionId}.`, "teal");
        send("run.control", {
          action,
          sessionId: watchState.sessionId,
          reason: `operator ${action}`,
        });
        return true;
      }
    }

    if (shouldQueueOperatorInput()) {
      return maybeQueue("session bootstrap not complete");
    }
    watchState.currentObjective = value;
    persistSessionId(watchState.sessionId);
    watchState.runState = "starting";
    watchState.runPhase = "queued";
    watchState.activeRunStartedAtMs = nowMs();
    resetDelegationState();
    pushEvent("you", "Prompt", value, "teal");
    send("chat.message", authPayload({ content: value }));
    return true;
  }

  function flushQueuedOperatorInputs() {
    if (!isOpen() || bootstrapPending() || queuedOperatorInputs.length === 0) {
      return;
    }
    while (queuedOperatorInputs.length > 0) {
      const value = queuedOperatorInputs.shift();
      if (!value) {
        continue;
      }
      dispatchOperatorInput(value, { replayed: true });
    }
  }

  return {
    printHelp,
    queueOperatorInput,
    flushQueuedOperatorInputs,
    shouldQueueOperatorInput,
    dispatchOperatorInput,
  };
}
