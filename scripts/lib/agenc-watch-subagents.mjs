function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchSubagentController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchSubagentController requires a ${name} object`);
  }
}

export function createWatchSubagentController(dependencies = {}) {
  const {
    watchState,
    recentSubagentLifecycleFingerprints,
    subagentLiveActivity,
    resetDelegatedWatchState,
    plannerDagNodeCount,
    hydratePlannerDagForLiveSession,
    updateSubagentPlanStep,
    ensureSubagentPlanStep,
    planStepDisplayName,
    compactSessionToken,
    sanitizeInlineText,
    truncate,
    pushEvent,
    setTransientStatus,
    requestRunInspect,
    describeToolStart,
    describeToolResult,
    descriptorEventMetadata,
    shouldSuppressToolTranscript,
    shouldSuppressToolActivity,
    rememberSubagentToolArgs,
    readSubagentToolArgs,
    clearSubagentToolArgs,
    replaceLatestSubagentToolEvent,
    clearSubagentHeartbeatEvents,
    compactPathForDisplay,
    formatShellCommand,
    currentDisplayObjective,
    backgroundToolSurfaceLabel,
    retirePlannerDagOpenNodes,
    firstMeaningfulLine,
    tryPrettyJson,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  if (!(recentSubagentLifecycleFingerprints instanceof Map)) {
    throw new TypeError("createWatchSubagentController requires a recentSubagentLifecycleFingerprints map");
  }
  if (!(subagentLiveActivity instanceof Map)) {
    throw new TypeError("createWatchSubagentController requires a subagentLiveActivity map");
  }

  const requiredFunctions = {
    resetDelegatedWatchState,
    plannerDagNodeCount,
    hydratePlannerDagForLiveSession,
    updateSubagentPlanStep,
    ensureSubagentPlanStep,
    planStepDisplayName,
    compactSessionToken,
    sanitizeInlineText,
    truncate,
    pushEvent,
    setTransientStatus,
    requestRunInspect,
    describeToolStart,
    describeToolResult,
    descriptorEventMetadata,
    shouldSuppressToolTranscript,
    shouldSuppressToolActivity,
    rememberSubagentToolArgs,
    readSubagentToolArgs,
    clearSubagentToolArgs,
    replaceLatestSubagentToolEvent,
    clearSubagentHeartbeatEvents,
    compactPathForDisplay,
    formatShellCommand,
    currentDisplayObjective,
    backgroundToolSurfaceLabel,
    retirePlannerDagOpenNodes,
    firstMeaningfulLine,
    tryPrettyJson,
    nowMs,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    assertFunction(name, value);
  }

  function subagentPayloadData(payload) {
    if (
      payload &&
      typeof payload.data === "object" &&
      payload.data &&
      !Array.isArray(payload.data)
    ) {
      return payload.data;
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        subagentSessionId: _subagentSessionId,
        toolName: _toolName,
        timestamp: _timestamp,
        traceId: _traceId,
        parentTraceId: _parentTraceId,
        ...rest
      } = payload;
      return rest;
    }
    return {};
  }

  function subagentLabel(payload) {
    const token = compactSessionToken(payload?.subagentSessionId);
    const data = subagentPayloadData(payload);
    const step = ensureSubagentPlanStep({
      stepName: data.stepName,
      objective: data.objective,
      subagentSessionId: payload?.subagentSessionId,
    });
    const base = step
      ? planStepDisplayName(step, token ? 22 : 30)
      : "Delegated child";
    return token ? `${base} · ${token}` : base;
  }

  function formatValidationCode(value) {
    const text = sanitizeInlineText(String(value ?? ""));
    if (!text) {
      return null;
    }
    return text.replace(/_/g, " ");
  }

  function describeSubagentStatus(type, payload) {
    const data = subagentPayloadData(payload);
    const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
    switch (type) {
      case "subagents.progress":
        return null;
      case "subagents.tool.executing":
      case "subagents.tool.result": {
        const toolName = payload?.toolName ?? data.toolName ?? "tool";
        const args =
          data.args ??
          readSubagentToolArgs(watchState, payload?.subagentSessionId ?? null, toolName);
        const surfaceLabel = backgroundToolSurfaceLabel(toolName, args);
        if (surfaceLabel) {
          return surfaceLabel;
        }
        return currentDisplayObjective("child working");
      }
      case "subagents.acceptance_probe.started":
        return `child probe: ${truncate(probeName || "acceptance", 40)}`;
      case "subagents.acceptance_probe.completed":
        return `child probe ok: ${truncate(probeName || "acceptance", 40)}`;
      case "subagents.acceptance_probe.failed":
        return `child probe failed: ${truncate(probeName || "acceptance", 40)}`;
      case "subagents.synthesized": {
        const stopReason = sanitizeInlineText(data.stopReason ?? "");
        return stopReason
          ? `child synthesis: ${truncate(stopReason.replace(/_/g, " "), 40)}`
          : "child synthesis emitted";
      }
      default:
        return `${type.replace(/^subagents\./, "child ")}`;
    }
  }

  function setSubagentLiveActivity(subagentSessionId, value) {
    if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
      return;
    }
    const text = sanitizeInlineText(String(value ?? ""));
    if (!text) {
      subagentLiveActivity.delete(subagentSessionId);
      return;
    }
    subagentLiveActivity.set(subagentSessionId, text);
  }

  function getSubagentLiveActivity(subagentSessionId) {
    if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
      return null;
    }
    return subagentLiveActivity.get(subagentSessionId) ?? null;
  }

  function clearSubagentLiveActivity(subagentSessionId) {
    if (typeof subagentSessionId !== "string" || !subagentSessionId.trim()) {
      return;
    }
    subagentLiveActivity.delete(subagentSessionId);
  }

  function resetDelegationState() {
    resetDelegatedWatchState(watchState);
  }

  function subagentLifecycleFingerprint(type, payload) {
    const data = subagentPayloadData(payload);
    const subagentSessionId = sanitizeInlineText(
      payload?.subagentSessionId ?? data.subagentSessionId ?? "",
    );
    if (!subagentSessionId) {
      return null;
    }
    const traceId = sanitizeInlineText(payload?.traceId ?? data.traceId ?? "");
    const toolCallId = sanitizeInlineText(payload?.toolCallId ?? data.toolCallId ?? "");
    const eventStamp = Number(payload?.timestamp ?? data.timestamp);
    const discriminator = traceId ||
      toolCallId ||
      (Number.isFinite(eventStamp) ? String(eventStamp) : "") ||
      sanitizeInlineText(payload?.toolName ?? data.toolName ?? "") ||
      sanitizeInlineText(payload?.probeName ?? data.probeName ?? data.category ?? "");
    if (!discriminator) {
      return null;
    }
    return `${type}|${subagentSessionId}|${discriminator}`;
  }

  function shouldSkipDuplicateSubagentLifecycleEvent(type, payload) {
    const fingerprint = subagentLifecycleFingerprint(type, payload);
    if (!fingerprint) {
      return false;
    }
    const now = nowMs();
    for (const [key, seenAt] of recentSubagentLifecycleFingerprints.entries()) {
      if (now - seenAt > 60_000) {
        recentSubagentLifecycleFingerprints.delete(key);
      }
    }
    if (recentSubagentLifecycleFingerprints.has(fingerprint)) {
      return true;
    }
    recentSubagentLifecycleFingerprints.set(fingerprint, now);
    return false;
  }

  function handleSubagentLifecycleEvent(type, payload) {
    const data = subagentPayloadData(payload);
    const label = subagentLabel(payload);
    const objective = sanitizeInlineText(data.objective ?? "");
    const stepName = sanitizeInlineText(data.stepName ?? "");
    const baseMetadata = {
      subagentSessionId: payload?.subagentSessionId ?? null,
      toolName: payload?.toolName ?? null,
    };

    switch (type) {
      case "subagents.planned":
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "planned",
          note: objective || stepName,
        });
        return;
      case "subagents.policy_bypassed":
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          note: "unsafe benchmark mode active",
        });
        pushEvent(
          "subagent",
          "Unsafe delegation policy bypassed",
          [
            objective ? `objective: ${objective}` : null,
            "unsafe benchmark mode is active for this delegated child",
          ].filter(Boolean).join("\n"),
          "amber",
          baseMetadata,
        );
        return;
      case "subagents.spawned":
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: objective || stepName,
        });
        return;
      case "subagents.started":
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: objective || stepName,
        });
        pushEvent(
          "subagent",
          `${label} started`,
          objective || stepName || label,
          "magenta",
          baseMetadata,
        );
        return;
      case "subagents.progress": {
        const liveActivity = getSubagentLiveActivity(payload?.subagentSessionId);
        const elapsedSeconds = Number.isFinite(Number(data.elapsedMs))
          ? Math.round(Number(data.elapsedMs) / 1000)
          : null;
        const note = [
          liveActivity,
          elapsedSeconds !== null ? `elapsed ${elapsedSeconds}s` : null,
        ].filter(Boolean).join(" · ");
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: note || objective || stepName,
        });
        setTransientStatus(
          [
            label,
            liveActivity || "working",
            elapsedSeconds !== null ? `${elapsedSeconds}s` : null,
          ].filter(Boolean).join(" · "),
        );
        return;
      }
      case "subagents.tool.executing": {
        const toolName = payload?.toolName ?? "tool";
        rememberSubagentToolArgs(
          watchState,
          payload?.subagentSessionId,
          toolName,
          data.args,
        );
        const descriptor = describeToolStart(toolName, data.args);
        const suppressTranscript = shouldSuppressToolTranscript(toolName, data.args);
        const suppressActivity = shouldSuppressToolActivity(toolName, data.args);
        if (!suppressActivity) {
          setSubagentLiveActivity(payload?.subagentSessionId, descriptor.title);
        }
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          ...(suppressActivity ? {} : { note: descriptor.title }),
        });
        if (!suppressTranscript) {
          pushEvent(
            "subagent tool",
            `${label} ${descriptor.title}`,
            [
              objective ? `objective: ${objective}` : null,
              descriptor.body,
            ].filter(Boolean).join("\n"),
            descriptor.tone,
            descriptorEventMetadata(descriptor, {
              ...baseMetadata,
              toolArgs: data.args,
            }),
          );
        }
        return;
      }
      case "subagents.tool.result": {
        const toolName = payload?.toolName ?? "tool";
        const args =
          data.args ??
          readSubagentToolArgs(watchState, payload?.subagentSessionId, toolName);
        const descriptor = describeToolResult(
          toolName,
          args,
          false,
          data.result ?? "",
        );
        const suppressTranscript = shouldSuppressToolTranscript(toolName, args);
        const suppressActivity = shouldSuppressToolActivity(toolName, args);
        if (!suppressActivity) {
          setSubagentLiveActivity(payload?.subagentSessionId, descriptor.title);
        }
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          ...(suppressActivity ? {} : { note: descriptor.title }),
        });
        clearSubagentToolArgs(watchState, payload?.subagentSessionId, toolName);
        if (suppressTranscript) {
          return;
        }
        if (
          replaceLatestSubagentToolEvent(
            payload?.subagentSessionId ?? null,
            toolName,
            false,
            descriptor.body,
            {
              ...descriptor,
              title: `${label} ${descriptor.title}`,
            },
          )
        ) {
          return;
        }
        pushEvent(
          "subagent tool result",
          `${label} ${descriptor.title}`,
          descriptor.body,
          descriptor.tone,
          descriptorEventMetadata(descriptor, {
            ...baseMetadata,
            toolArgs: args,
          }),
        );
        return;
      }
      case "subagents.completed": {
        clearSubagentHeartbeatEvents(payload?.subagentSessionId);
        clearSubagentLiveActivity(payload?.subagentSessionId);
        clearSubagentToolArgs(watchState, payload?.subagentSessionId);
        const toolCallCount = Number.isFinite(Number(data.toolCalls)) ? Number(data.toolCalls) : 0;
        const durationSec = Number.isFinite(Number(data.durationMs))
          ? Math.round(Number(data.durationMs) / 1000)
          : null;
        const outputLine = firstMeaningfulLine(typeof data.output === "string" ? data.output : "");
        const completedParts = [
          `${toolCallCount} calls`,
          durationSec !== null ? `${durationSec}s` : null,
          outputLine ? truncate(outputLine, 80) : null,
        ].filter(Boolean);
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "completed",
          note: outputLine || `tool calls ${toolCallCount}`,
        });
        pushEvent(
          "subagent",
          `${label} completed`,
          completedParts.join(" · ") || "delegated child completed",
          "green",
          baseMetadata,
        );
        return;
      }
      case "subagents.acceptance_probe.started": {
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: sanitizeInlineText(data.probeName ?? data.category ?? "acceptance probe"),
        });
        const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
        const command = formatShellCommand(data.command, data.args);
        pushEvent(
          "subagent",
          `${label} probe ${truncate(probeName || "acceptance", 64)} started`,
          [
            stepName ? `step: ${stepName}` : null,
            probeName ? `probe: ${probeName}` : null,
            typeof data.category === "string"
              ? `category: ${sanitizeInlineText(data.category)}`
              : null,
            command ? `command: ${command}` : null,
            typeof data.cwd === "string"
              ? `cwd: ${compactPathForDisplay(data.cwd)}`
              : null,
          ].filter(Boolean).join("\n") || "delegated acceptance probe started",
          "slate",
          {
            ...baseMetadata,
            probeName: data.probeName ?? null,
            category: data.category ?? null,
          },
        );
        return;
      }
      case "subagents.acceptance_probe.completed": {
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "running",
          note: `${sanitizeInlineText(data.probeName ?? data.category ?? "acceptance")} passed`,
        });
        const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
        pushEvent(
          "subagent",
          `${label} probe ${truncate(probeName || "acceptance", 64)} passed`,
          [
            stepName ? `step: ${stepName}` : null,
            probeName ? `probe: ${probeName}` : null,
            typeof data.category === "string"
              ? `category: ${sanitizeInlineText(data.category)}`
              : null,
            Number.isFinite(Number(data.durationMs))
              ? `duration: ${Math.round(Number(data.durationMs) / 1000)}s`
              : null,
            firstMeaningfulLine(typeof data.result === "string" ? data.result : ""),
          ].filter(Boolean).join("\n") || "delegated acceptance probe passed",
          "green",
          {
            ...baseMetadata,
            probeName: data.probeName ?? null,
            category: data.category ?? null,
          },
        );
        return;
      }
      case "subagents.acceptance_probe.failed": {
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "failed",
          note:
            firstMeaningfulLine(typeof data.error === "string" ? data.error : "") ||
            `${sanitizeInlineText(data.probeName ?? data.category ?? "acceptance")} failed`,
        });
        const probeName = sanitizeInlineText(data.probeName ?? data.category ?? "");
        const command = formatShellCommand(data.command, data.args);
        pushEvent(
          "subagent error",
          `${label} probe ${truncate(probeName || "acceptance", 64)} failed`,
          [
            stepName ? `step: ${stepName}` : null,
            probeName ? `probe: ${probeName}` : null,
            typeof data.category === "string"
              ? `category: ${sanitizeInlineText(data.category)}`
              : null,
            command ? `command: ${command}` : null,
            typeof data.cwd === "string"
              ? `cwd: ${compactPathForDisplay(data.cwd)}`
              : null,
            firstMeaningfulLine(typeof data.error === "string" ? data.error : ""),
          ].filter(Boolean).join("\n") || "delegated acceptance probe failed",
          "red",
          {
            ...baseMetadata,
            probeName: data.probeName ?? null,
            category: data.category ?? null,
          },
        );
        return;
      }
      case "subagents.failed":
        clearSubagentHeartbeatEvents(payload?.subagentSessionId);
        clearSubagentLiveActivity(payload?.subagentSessionId);
        clearSubagentToolArgs(watchState, payload?.subagentSessionId);
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "failed",
          note:
            firstMeaningfulLine(typeof data.reason === "string" ? data.reason : "") ??
            firstMeaningfulLine(typeof data.error === "string" ? data.error : "") ??
            formatValidationCode(data.validationCode) ??
            objective,
        });
        pushEvent(
          "subagent error",
          `${label} failed${data.retrying ? ` · retry ${data.retryAttempt}/${data.maxRetries}` : ""}`,
          [
            stepName ? `step: ${stepName}` : null,
            formatValidationCode(data.validationCode)
              ? `validation: ${formatValidationCode(data.validationCode)}`
              : null,
            typeof data.failureClass === "string"
              ? `class: ${sanitizeInlineText(data.failureClass)}`
              : null,
            data.retrying && Number.isFinite(Number(data.nextRetryDelayMs))
              ? `next retry: ${Math.round(Number(data.nextRetryDelayMs))}ms`
              : null,
            firstMeaningfulLine(typeof data.reason === "string" ? data.reason : "") ??
              firstMeaningfulLine(typeof data.error === "string" ? data.error : ""),
            firstMeaningfulLine(typeof data.output === "string" ? data.output : ""),
          ].filter(Boolean).join("\n") || "delegated child failed",
          "red",
          {
            ...baseMetadata,
            validationCode: data.validationCode ?? null,
            failureClass: data.failureClass ?? null,
            retrying: data.retrying === true,
          },
        );
        return;
      case "subagents.cancelled":
        clearSubagentHeartbeatEvents(payload?.subagentSessionId);
        clearSubagentLiveActivity(payload?.subagentSessionId);
        clearSubagentToolArgs(watchState, payload?.subagentSessionId);
        updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: "cancelled",
          note: objective || stepName || "cancelled",
        });
        pushEvent(
          "subagent error",
          `${label} cancelled`,
          objective || "delegated child cancelled",
          "amber",
          baseMetadata,
        );
        return;
      case "subagents.synthesized": {
        clearSubagentHeartbeatEvents(payload?.subagentSessionId);
        clearSubagentLiveActivity(payload?.subagentSessionId);
        clearSubagentToolArgs(watchState, payload?.subagentSessionId);
        const stopReason = sanitizeInlineText(data.stopReason ?? "");
        const stopReasonDetail = firstMeaningfulLine(
          typeof data.stopReasonDetail === "string" ? data.stopReasonDetail : "",
        );
        const outputPreview = firstMeaningfulLine(
          typeof data.outputPreview === "string"
            ? data.outputPreview
            : typeof data.output === "string"
              ? data.output
              : "",
        );
        const nextStatus =
          stopReason === "completed"
            ? "completed"
            : stopReason === "cancelled"
              ? "cancelled"
              : "failed";
        const synthesizedStep = updateSubagentPlanStep({
          stepName,
          objective,
          subagentSessionId: payload?.subagentSessionId,
          status: nextStatus,
        });
        const currentNote = sanitizeInlineText(synthesizedStep?.note ?? "");
        const synthesisNote =
          outputPreview ||
          stopReasonDetail ||
          (Number.isFinite(Number(data.toolCalls))
            ? `parent synthesis after ${data.toolCalls} tool calls`
            : "parent synthesis emitted");
        if (
          synthesizedStep &&
          (
            !currentNote ||
            currentNote === sanitizeInlineText(synthesizedStep.objective ?? "") ||
            currentNote === sanitizeInlineText(synthesizedStep.stepName ?? "") ||
            currentNote === "parent synthesis emitted"
          )
        ) {
          synthesizedStep.note = synthesisNote;
        }
        const titleSuffix =
          stopReason && stopReason !== "completed"
            ? ` · ${stopReason.replace(/_/g, " ")}`
            : "";
        const tone =
          nextStatus === "completed"
            ? "cyan"
            : nextStatus === "cancelled"
              ? "amber"
              : "red";
        // Skip synthesized card if a completed card for the same subagent already exists
        const recentEvents = Array.isArray(watchState.events) ? watchState.events : [];
        const subSessId = payload?.subagentSessionId ?? null;
        const hasRecentCompleted = subSessId && recentEvents.slice(-6).some(
          (ev) => ev.kind === "subagent" &&
            ev.title?.includes("completed") &&
            ev.subagentSessionId === subSessId,
        );
        if (!hasRecentCompleted) {
          pushEvent(
            "subagent",
            stepName || objective
              ? `${label} synthesis ready${titleSuffix}`
              : `Delegated synthesis ready${titleSuffix}`,
            [
              objective ? `objective: ${objective}` : null,
              stepName ? `step: ${stepName}` : null,
              stopReason ? `stop: ${stopReason.replace(/_/g, " ")}` : null,
              Number.isFinite(Number(data.toolCalls))
                ? `tool calls: ${data.toolCalls}`
                : null,
              stopReasonDetail,
              outputPreview && outputPreview !== stopReasonDetail ? outputPreview : null,
            ].filter(Boolean).join("\n") || synthesisNote,
            tone,
            baseMetadata,
          );
        }
        // If this was the last active subagent and the stop reason is terminal,
        // retire any remaining open DAG nodes so the TUI doesn't stay on "working".
        if (stopReason === "completed" || stopReason === "failed" || stopReason === "cancelled" || stopReason === "validation_error" || stopReason === "timeout") {
          retirePlannerDagOpenNodes(
            stopReason === "completed" ? "completed" : "cancelled",
            stopReasonDetail || stopReason.replace(/_/g, " "),
          );
        }
        return;
      }
      default:
        pushEvent("subagent", type, tryPrettyJson(payload ?? {}), "slate", baseMetadata);
    }
  }

  function handleSubagentLifecycleMessage(type, payload) {
    if (plannerDagNodeCount() <= 1) {
      hydratePlannerDagForLiveSession({ force: plannerDagNodeCount() === 1 });
    }
    if (shouldSkipDuplicateSubagentLifecycleEvent(type, payload ?? {})) {
      return true;
    }
    handleSubagentLifecycleEvent(type, payload ?? {});
    const statusText = describeSubagentStatus(type, payload ?? {});
    if (statusText) {
      setTransientStatus(statusText);
    }
    requestRunInspect(type);
    return true;
  }

  return {
    resetDelegationState,
    handleSubagentLifecycleMessage,
  };
}
