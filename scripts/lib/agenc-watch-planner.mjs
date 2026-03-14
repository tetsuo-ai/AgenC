function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchPlannerController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchPlannerController requires a ${name} object`);
  }
}

export function createWatchPlannerController(dependencies = {}) {
  const {
    watchState,
    plannerDagNodeCount,
    sessionValuesMatch,
    hydratePlannerDagForLiveSession,
    ingestPlannerDag,
    updatePlannerDagNode,
    retirePlannerDagOpenNodes,
    sanitizeInlineText,
    describeToolStart,
    describeToolResult,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  const requiredFunctions = {
    plannerDagNodeCount,
    sessionValuesMatch,
    hydratePlannerDagForLiveSession,
    ingestPlannerDag,
    updatePlannerDagNode,
    retirePlannerDagOpenNodes,
    sanitizeInlineText,
    describeToolStart,
    describeToolResult,
    nowMs,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    assertFunction(name, value);
  }

  function handlePlannerTraceEvent(type, payload) {
    const stepName = sanitizeInlineText(payload?.stepName ?? "");
    const eventSessionId = sanitizeInlineText(
      payload?.sessionId ?? payload?.parentSessionId ?? "",
    );
    if (
      watchState.sessionId &&
      eventSessionId &&
      !sessionValuesMatch(eventSessionId, watchState.sessionId)
    ) {
      return false;
    }
    if (type !== "planner_plan_parsed" && plannerDagNodeCount() <= 1) {
      hydratePlannerDagForLiveSession({ force: plannerDagNodeCount() === 1 });
    }
    switch (type) {
      case "planner_plan_parsed":
        ingestPlannerDag(payload ?? {});
        return true;
      case "planner_pipeline_started":
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        watchState.plannerDagNote =
          sanitizeInlineText(payload?.routeReason ?? "") || watchState.plannerDagNote;
        watchState.plannerDagStatus =
          plannerDagNodeCount() > 0 ? "planned" : watchState.plannerDagStatus;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "planner_step_started":
        updatePlannerDagNode({
          stepName,
          status: "running",
          tool: payload?.tool,
          note: describeToolStart(payload?.tool ?? "tool", payload?.args).title,
        });
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        return true;
      case "planner_step_finished": {
        const isError = payload?.isError === true || typeof payload?.error === "string";
        const toolName = sanitizeInlineText(payload?.tool ?? "tool");
        const descriptor = describeToolResult(
          toolName || "tool",
          payload?.args,
          isError,
          typeof payload?.error === "string" ? payload.error : payload?.result ?? "",
        );
        updatePlannerDagNode({
          stepName,
          status: isError ? "failed" : "completed",
          tool: toolName,
          note: descriptor.title,
        });
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        return true;
      }
      case "planner_refinement_requested":
        retirePlannerDagOpenNodes(
          "blocked",
          sanitizeInlineText(
            payload?.reason ??
              payload?.routeReason ??
              payload?.verificationRequirementDiagnostics?.[0]?.message ??
              "",
          ) || "planner refinement requested",
        );
        watchState.plannerDagStatus = "blocked";
        watchState.plannerDagNote = sanitizeInlineText(
          payload?.reason ??
            payload?.routeReason ??
            payload?.verificationRequirementDiagnostics?.[0]?.message ??
            "",
        ) || "planner refinement requested";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "planner_pipeline_finished":
      case "planner_path_finished": {
        const stopReason = sanitizeInlineText(
          payload?.stopReason ?? payload?.stopReasonHint ?? "",
        );
        const stopReasonDetail = sanitizeInlineText(
          payload?.stopReasonDetail ??
            payload?.error ??
            payload?.diagnostics?.[0]?.message ??
            payload?.reason ??
            "",
        );
        retirePlannerDagOpenNodes(
          stopReason === "completed" || stopReason === "cancelled"
            ? "cancelled"
            : "failed",
          stopReasonDetail ||
            (stopReason ? stopReason.replace(/_/g, " ") : "planner path finished"),
        );
        if (stopReason) {
          watchState.plannerDagStatus =
            stopReason === "completed"
              ? "completed"
              : stopReason === "cancelled"
                ? "cancelled"
                : "failed";
        }
        const terminalStopReason = new Set([
          "",
          "completed",
          "cancelled",
          "failed",
          "validation_error",
          "timeout",
        ]);
        watchState.runPhase = null;
        watchState.runState = terminalStopReason.has(stopReason) ? "idle" : stopReason;
        if (terminalStopReason.has(stopReason)) {
          watchState.activeRunStartedAtMs = null;
        }
        watchState.plannerDagNote = stopReasonDetail || watchState.plannerDagNote;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      default:
        return false;
    }
  }

  return {
    handlePlannerTraceEvent,
  };
}
