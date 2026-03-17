import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWatchSplashRenderer } from "./agenc-watch-splash.mjs";
import { visibleLength } from "./agenc-watch-text-utils.mjs";

export function createWatchFrameController(dependencies = {}) {
  const {
    fs,
    watchState,
    transportState,
    events,
    queuedOperatorInputs,
    subagentPlanSteps,
    subagentLiveActivity,
    plannerDagNodes,
    plannerDagEdges,
    workspaceFileIndex,
    color,
    enableMouseTracking,
    launchedAtMs,
    startupSplashMinMs,
    introDismissKinds,
    maxInlineChars,
    maxPreviewSourceLines,
    currentSurfaceSummary,
    currentInputValue,
    currentSlashSuggestions,
    currentModelSuggestions,
    currentFileTagPalette,
    currentSessionElapsedLabel,
    currentRunElapsedLabel,
    currentDisplayObjective,
    currentPhaseLabel,
    currentSurfaceToolLabel,
    hasActiveSurfaceRun,
    bootstrapPending,
    shouldShowWatchSplash,
    buildWatchLayout,
    buildWatchFooterSummary,
    buildWatchSidebarPolicy,
    buildTranscriptEventSummary,
    buildDetailPaneSummary,
    buildCommandPaletteSummary,
    buildFileTagPaletteSummary,
    computeTranscriptPreviewMaxLines,
    splitTranscriptPreviewForHeadline,
    buildEventDisplayLines,
    wrapEventDisplayLines,
    wrapDisplayLines,
    compactBodyLines,
    createDisplayLine,
    displayLineText,
    displayLinePlainText,
    renderEventBodyLine,
    isDiffRenderableEvent,
    isSourcePreviewEvent,
    isMarkdownRenderableEvent,
    isMutationPreviewEvent,
    isSlashComposerInput,
    composerRenderLine,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    sanitizeDisplayText,
    toneColor,
    stateTone,
    badge,
    chip,
    row,
    renderPanel,
    joinColumns,
    blankRow,
    paintSurface,
    flexBetween,
    termWidth,
    termHeight,
    formatClockLabel,
    animatedWorkingGlyph,
    compactSessionToken,
    sanitizePlanLabel,
    plannerDagStatusTone,
    plannerDagStatusGlyph,
    plannerDagTypeGlyph,
    planStatusTone,
    planStatusGlyph,
    planStepDisplayName,
    applyViewportScrollDelta,
    preserveManualTranscriptViewport,
    sliceViewportRowsAroundRange,
    sliceViewportRowsFromBottom,
    bottomAlignViewportRows,
    isViewportTranscriptFollowing,
    setTransientStatus,
    pushEvent,
    buildAltScreenEnterSequence,
    buildAltScreenLeaveSequence,
    stdout = process.stdout,
    nowMs = () => Date.now(),
    setTimer = setTimeout,
  } = dependencies;

  const frameState = {
    enteredAltScreen: false,
    renderPending: false,
    lastRenderedFrameLines: [],
    lastRenderedFrameWidth: 0,
    lastRenderedFrameHeight: 0,
  };
  const splashRenderer = createWatchSplashRenderer({
    watchState,
    transportState,
    events,
    introDismissKinds,
    currentInputValue,
    launchedAtMs,
    startupSplashMinMs,
    shouldShowWatchSplash,
    nowMs,
    toneColor,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    color,
  });

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

  function headerLines(width, summary = currentSurfaceSummary()) {
    const elapsed = currentSessionElapsedLabel();
    const connectionLabel = `${summary.overview.connectionState} ${summary.overview.sessionToken} ${elapsed}`;
    const chipLines = [[]];
    for (const item of summary.chips) {
      const rendered = chip(item.label, item.value, item.tone);
      const currentLine = chipLines[chipLines.length - 1];
      const nextLine = currentLine.length > 0
        ? `${currentLine.join("  ")}  ${rendered}`
        : rendered;
      if (visibleLength(nextLine) <= width) {
        currentLine.push(rendered);
        continue;
      }
      if (chipLines.length >= 2) {
        break;
      }
      chipLines.push([rendered]);
    }

    const lines = [
      flexBetween(
        `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.fog}https://agenc.tech${color.reset}`,
        `${toneColor(stateTone(summary.overview.connectionState))}${connectionLabel}${color.reset}`,
        width,
      ),
      `${color.softInk}${truncate(summary.routeLabel, Math.max(26, width))}${color.reset}`,
    ];

    for (const chipLine of chipLines) {
      if (chipLine.length > 0) {
        lines.push(fitAnsi(chipLine.join("  "), width));
      }
    }

    if (
      hasActiveSurfaceRun() &&
      summary.objective &&
      summary.objective !== "No active objective" &&
      !/^awaiting operator prompt$/i.test(summary.objective)
    ) {
      lines.push(`${color.ink}${truncate(summary.objective, Math.max(28, width))}${color.reset}`);
    }
    if (summary.overview.activeLine && summary.overview.activeLine !== summary.objective) {
      lines.push(`${color.softInk}${truncate(summary.overview.activeLine, Math.max(24, width))}${color.reset}`);
    }

    lines.push("");
    return lines;
  }

  function commandPaletteLines(width, limit = 7) {
    const inner = width - 2;
    const suggestions = currentSlashSuggestions(limit);
    const palette = buildCommandPaletteSummary({
      inputValue: currentInputValue(),
      suggestions,
      modelSuggestions: typeof currentModelSuggestions === "function" ? currentModelSuggestions(limit) : [],
    });
    const lines = [];
    if (palette.empty) {
      lines.push(row(`${color.red}No matching slash command.${color.reset}`, color.panelBg));
      lines.push(row(`${color.softInk}Use /help for the full command reference.${color.reset}`, color.panelBg));
    } else {
      for (const command of suggestions) {
        const aliasSuffix =
          Array.isArray(command.aliases) && command.aliases.length > 0
            ? `  ${color.fog}${command.aliases.join(", ")}${color.reset}`
            : "";
        const usageLine = fitAnsi(`${color.magenta}${command.usage}${color.reset}${aliasSuffix}`, inner);
        lines.push(row(usageLine, color.panelBg));
        if (command.description) {
          const descriptionLine = fitAnsi(
            `${color.softInk}${command.description}${color.reset}`,
            inner,
          );
          lines.push(row(descriptionLine, color.panelBg));
        }
      }
    }
    return renderPanel({
      title: truncate(palette.title, 22),
      tone: "teal",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function fileTagPaletteLines(width, limit = 7, paletteState = currentFileTagPalette(limit)) {
    const inner = width - 2;
    const { suggestions = [], summary } = paletteState ?? {};
    const palette = summary ?? buildFileTagPaletteSummary({
      inputValue: currentInputValue(),
      query: null,
      suggestions: [],
      indexReady: workspaceFileIndex.ready,
      indexError: workspaceFileIndex.error,
    });
    const lines = [];
    if (!workspaceFileIndex.ready) {
      lines.push(row(`${color.red}${palette.suggestionHint}${color.reset}`, color.panelBg));
    } else if (palette.mode === "idle" && suggestions.length === 0) {
      lines.push(row(`${color.softInk}Type a path or filename after @.${color.reset}`, color.panelBg));
      lines.push(row(`${color.fog}Example: @runtime/src/channels/webchat/types.ts${color.reset}`, color.panelBg));
    } else if (palette.empty) {
      lines.push(row(`${color.red}No matching file tag.${color.reset}`, color.panelBg));
      lines.push(row(`${color.softInk}Keep typing a filename or repo-relative path.${color.reset}`, color.panelBg));
    } else {
      for (const entry of suggestions) {
        const labelLine = fitAnsi(
          `${color.magenta}${color.bold}${entry.label}${color.reset}`,
          inner,
        );
        lines.push(row(labelLine, color.panelBg));
        if (entry.directory) {
          const directory = fitAnsi(`  ${color.fog}${entry.directory}${color.reset}`, inner);
          lines.push(row(directory, color.panelBg));
        }
      }
    }
    return renderPanel({
      title: truncate(palette.title, 22),
      tone: "magenta",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function currentTranscriptLayout() {
    const width = termWidth();
    const height = termHeight();
    const slashMode = !watchState.expandedEventId && isSlashComposerInput(currentInputValue());
    const fileTagPalette = !watchState.expandedEventId
      ? currentFileTagPalette(Math.max(4, Math.min(8, height - 12)))
      : { activeTag: null, suggestions: [], summary: null };
    const popupWidth = Math.min(68, Math.max(38, width - 4));
    const popupLimit = Math.max(4, Math.min(8, height - 12));
    const popup = watchState.expandedEventId
      ? []
      : fileTagPalette.activeTag
        ? fileTagPaletteLines(popupWidth, popupLimit, fileTagPalette)
        : slashMode
          ? commandPaletteLines(popupWidth, popupLimit)
          : [];
    const popupRows = popup.length > 0 ? popup.length + 1 : 0;
    const headerRows = headerLines(width, currentSurfaceSummary()).length;
    return buildWatchLayout({
      width,
      height,
      headerRows,
      popupRows,
      slashMode: slashMode || Boolean(fileTagPalette.activeTag),
      detailOpen: Boolean(watchState.expandedEventId),
    });
  }

  function compactSummaryLines(width) {
    const inner = width - 2;
    const elapsed = hasActiveSurfaceRun()
      ? currentRunElapsedLabel()
      : currentSessionElapsedLabel();
    const summary = currentSurfaceSummary();
    const lines = [
      row(
        flexBetween(
          `${chip("RUN", summary.overview.phaseLabel, stateTone(summary.overview.phaseLabel))}`,
          `${chip("LINK", summary.overview.connectionState, stateTone(summary.overview.connectionState))}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("PROVIDER", summary.providerLabel, summary.providerLabel !== "pending" ? "teal" : "slate")}`,
          `${chip("FAILOVER", summary.overview.fallbackState, stateTone(summary.overview.fallbackState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${color.softInk}${truncate(summary.routeLabel, Math.max(24, inner - 10))}${color.reset}`,
          `${color.fog}${elapsed}${color.reset}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("RUNTIME", summary.overview.runtimeState, stateTone(summary.overview.runtimeState))}`,
          `${chip("DURABLE", summary.overview.durableRunsState, stateTone(summary.overview.durableRunsState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
      row(
        flexBetween(
          `${chip("TOOL", summary.overview.latestTool, stateTone(summary.overview.latestToolState))}`,
          `${chip("QUEUE", summary.overview.queuedInputCount, summary.overview.queuedInputCount > 0 ? "amber" : "green")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("AGENTS", summary.overview.activeAgentCount, summary.overview.activeAgentCount > 0 ? "green" : "slate")}`,
          `${chip("USAGE", summary.overview.usage, summary.overview.usage === "n/a" ? "slate" : "teal")}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    if (summary.objective && summary.objective !== "No active objective") {
      lines.push(
        row(
          flexBetween(
            `${toneColor("teal")}${color.bold}OBJECTIVE${color.reset}`,
            `${color.fog}${summary.overview.sessionToken}${color.reset}`,
            inner,
          ),
          color.panelHiBg,
        ),
      );
      lines.push(
        row(`${color.ink}${truncate(summary.objective, inner)}${color.reset}`, color.panelBg),
      );
    }
    lines.push(
      row(`${color.softInk}${truncate(summary.runtimeLabel, inner)}${color.reset}`, color.panelAltBg),
    );
    if (summary.overview.activeLine && summary.overview.activeLine !== "Awaiting operator prompt") {
      lines.push(
        row(`${color.ink}${truncate(summary.overview.activeLine, inner)}${color.reset}`, color.panelBg),
      );
    }

    return renderPanel({
      title: "CONTROL",
      subtitle: summary.overview.lastActivityAt || elapsed,
      tone: "magenta",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function dagMaskForChar(char) {
    switch (char) {
      case "─":
        return 0b0101;
      case "│":
        return 0b1010;
      case "┌":
        return 0b0110;
      case "┐":
        return 0b0011;
      case "└":
        return 0b1100;
      case "┘":
        return 0b1001;
      case "├":
        return 0b1110;
      case "┤":
        return 0b1011;
      case "┬":
        return 0b0111;
      case "┴":
        return 0b1101;
      case "┼":
        return 0b1111;
      default:
        return 0;
    }
  }

  function dagCharForMask(mask) {
    switch (mask) {
      case 0b0101:
        return "─";
      case 0b1010:
        return "│";
      case 0b0110:
        return "┌";
      case 0b0011:
        return "┐";
      case 0b1100:
        return "└";
      case 0b1001:
        return "┘";
      case 0b1110:
        return "├";
      case 0b1011:
        return "┤";
      case 0b0111:
        return "┬";
      case 0b1101:
        return "┴";
      case 0b1111:
        return "┼";
      default:
        return " ";
    }
  }

  function mergeDagCanvasChar(existing, next) {
    if (!next || next === " ") return existing;
    if (!existing || existing === " ") return next;
    if (existing === next) return existing;
    const mergedMask = dagMaskForChar(existing) | dagMaskForChar(next);
    return dagCharForMask(mergedMask) || next;
  }

  function buildPlannerDagSnapshot() {
    const baseNodes = [...plannerDagNodes.values()].sort((left, right) => left.order - right.order);

    // Inject synthetic child nodes for running subagents showing their live activity
    const syntheticNodes = [];
    const syntheticEdges = [];
    for (const node of baseNodes) {
      if (node.status !== "running" || !node.subagentSessionId) continue;
      const activity = watchState.subagentLiveActivity?.get(node.subagentSessionId);
      if (!activity) continue;
      const childKey = `${node.key}__live`;
      syntheticNodes.push({
        key: childKey,
        stepName: childKey,
        objective: activity,
        stepType: "deterministic_tool",
        status: "running",
        note: activity,
        order: node.order + 0.5,
        tool: null,
        subagentSessionId: node.subagentSessionId,
      });
      syntheticEdges.push({ from: node.key, to: childKey });
    }

    const nodes = [...baseNodes, ...syntheticNodes].sort((left, right) => left.order - right.order);
    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    const childrenByKey = new Map(nodes.map((node) => [node.key, []]));
    const parentsByKey = new Map(nodes.map((node) => [node.key, []]));
    const incomingCounts = new Map(nodes.map((node) => [node.key, 0]));

    const allEdges = [...plannerDagEdges, ...syntheticEdges];
    for (const edge of allEdges) {
      if (!nodeByKey.has(edge.from) || !nodeByKey.has(edge.to)) {
        continue;
      }
      childrenByKey.get(edge.from)?.push(edge.to);
      parentsByKey.get(edge.to)?.push(edge.from);
      incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
    }

    for (const children of childrenByKey.values()) {
      children.sort((left, right) => (nodeByKey.get(left)?.order ?? 0) - (nodeByKey.get(right)?.order ?? 0));
    }

    const depthByKey = new Map(nodes.map((node) => [node.key, 0]));
    const queue = nodes
      .filter((node) => (incomingCounts.get(node.key) ?? 0) === 0)
      .map((node) => node.key);
    const remainingIncoming = new Map(incomingCounts);

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) break;
      const nextDepth = (depthByKey.get(key) ?? 0) + 1;
      for (const child of childrenByKey.get(key) ?? []) {
        depthByKey.set(child, Math.max(depthByKey.get(child) ?? 0, nextDepth));
        remainingIncoming.set(child, Math.max(0, (remainingIncoming.get(child) ?? 0) - 1));
        if ((remainingIncoming.get(child) ?? 0) === 0) {
          queue.push(child);
        }
      }
    }

    const maxDepth = nodes.reduce((max, node) => Math.max(max, depthByKey.get(node.key) ?? 0), 0);
    return {
      nodes,
      nodeByKey,
      childrenByKey,
      parentsByKey,
      depthByKey,
      maxDepth,
    };
  }

  function plannerDagTypeTone(value) {
    switch (value) {
      case "subagent_task":
        return "magenta";
      case "deterministic_tool":
        return "teal";
      case "synthesis":
        return "yellow";
      default:
        return "slate";
    }
  }

  function plannerDagStatusShortLabel(value) {
    switch (value) {
      case "completed":
        return "done";
      case "running":
        return "live";
      case "failed":
        return "fail";
      case "cancelled":
        return "stop";
      case "blocked":
        return "hold";
      default:
        return "wait";
    }
  }

  function selectPlannerDagDisplayNodes(snapshot, maxRows) {
    const { nodes } = snapshot;
    if (nodes.length <= maxRows) {
      return {
        nodes,
        hiddenBefore: 0,
        hiddenAfter: 0,
        hiddenTotal: 0,
      };
    }
    const focusStatuses = new Set(["running", "failed", "blocked"]);
    const focusKeys = new Set();
    const focusNodes = nodes.filter((node) => focusStatuses.has(node.status));
    const seedNodes = focusNodes.length > 0
      ? focusNodes
      : nodes.slice(-Math.min(2, nodes.length));

    for (const node of seedNodes) {
      focusKeys.add(node.key);
      for (const parent of snapshot.parentsByKey.get(node.key) ?? []) {
        focusKeys.add(parent);
      }
      for (const child of snapshot.childrenByKey.get(node.key) ?? []) {
        focusKeys.add(child);
      }
    }

    const sortedNodes = [...nodes];
    const displayKeys = new Set(focusKeys);
    for (const node of [...sortedNodes].reverse()) {
      if (displayKeys.size >= maxRows) {
        break;
      }
      displayKeys.add(node.key);
    }
    const displayNodes = sortedNodes.filter((node) => displayKeys.has(node.key)).slice(-maxRows);
    const hiddenIndices = sortedNodes
      .map((node, index) => (displayKeys.has(node.key) ? -1 : index))
      .filter((index) => index >= 0);
    return {
      nodes: displayNodes,
      hiddenBefore: hiddenIndices.length > 0 ? hiddenIndices[0] : 0,
      hiddenAfter:
        hiddenIndices.length > 0
          ? Math.max(0, sortedNodes.length - (hiddenIndices[hiddenIndices.length - 1] + 1))
          : 0,
      hiddenTotal: Math.max(0, sortedNodes.length - displayNodes.length),
    };
  }

  function plannerDagLabelLine(node, id, width) {
    const isSynthetic = node.key?.endsWith("__live");
    const statusTone = plannerDagStatusTone(node.status);
    const typeTone = plannerDagTypeTone(node.stepType);
    const shortStatus = plannerDagStatusShortLabel(node.status);
    const baseLabel = isSynthetic
      ? sanitizeInlineText(node.note ?? node.objective ?? "working")
      : sanitizePlanLabel(
        node.stepName ?? node.objective,
        node.tool || "unnamed step",
      );
    const idLabel = isSynthetic ? `${color.fog}↳${color.reset}` : `${toneColor(statusTone)}${color.bold}${id}${color.reset}${toneColor(typeTone)}${plannerDagTypeGlyph(node.stepType)}${color.reset}`;
    const left = `${idLabel} ${truncate(baseLabel, Math.max(10, width - 9))}`;
    const right = isSynthetic ? "" : `${toneColor(statusTone)}${shortStatus}${color.reset}`;
    return flexBetween(left, right, width);
  }

  function plannerDagInfoLines(width, displayNodes, { hiddenBefore = 0, hiddenAfter = 0, hiddenTotal = 0 } = {}) {
    const lines = [];
    if (hiddenTotal > 0) {
      const hiddenParts = [];
      if (hiddenBefore > 0) {
        hiddenParts.push(`${hiddenBefore} earlier`);
      }
      if (hiddenAfter > 0) {
        hiddenParts.push(`${hiddenAfter} later`);
      }
      const focusSummary = hiddenParts.length > 0
        ? hiddenParts.join(" · ")
        : `${hiddenTotal} focused offstage`;
      lines.push(`${color.fog}… ${focusSummary} · ${hiddenTotal} node${hiddenTotal === 1 ? "" : "s"} offstage${color.reset}`);
    }

    const focusNodes = displayNodes.filter((node) =>
      node.status === "running" || node.status === "failed" || node.status === "blocked"
    );
    const focusNote = focusNodes
      .map((node) => sanitizeInlineText(node.note || node.objective || ""))
      .find(Boolean);
    if (focusNote) {
      lines.push(`${color.softInk}${truncate(focusNote, width)}${color.reset}`);
    } else if (watchState.plannerDagNote) {
      lines.push(`${color.fog}${truncate(watchState.plannerDagNote, width)}${color.reset}`);
    }

    return lines.slice(0, 2);
  }

  function dagWidgetLines(width, maxCanvasLines = 8) {
    const snapshot = buildPlannerDagSnapshot();
    const { nodes, childrenByKey, depthByKey } = snapshot;
    const runningCount = nodes.filter((node) => node.status === "running").length;
    const failedCount = nodes.filter((node) => node.status === "failed").length;
    const completedCount = nodes.filter((node) => node.status === "completed").length;
    const updatedAt = watchState.plannerDagUpdatedAt > 0 ? formatClockLabel(watchState.plannerDagUpdatedAt) : "--:--:--";
    const header = flexBetween(
      `${toneColor(plannerDagStatusTone(watchState.plannerDagStatus))}${color.bold}LIVE DAG${color.reset}`,
      `${color.fog}${nodes.length} node${nodes.length === 1 ? "" : "s"}  ${updatedAt}${color.reset}`,
      width,
    );
    const metrics = flexBetween(
      `${chip("LIVE", runningCount, runningCount > 0 ? "cyan" : "slate")}  ${chip("DONE", completedCount, completedCount > 0 ? "green" : "slate")}`,
      `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
      width,
    );

    if (nodes.length === 0) {
      if (hasActiveSurfaceRun()) {
        const phaseLabel = sanitizeInlineText(currentPhaseLabel() || "thinking");
        const objective = currentDisplayObjective("");
        const pendingHeader = flexBetween(
          `${toneColor("cyan")}${color.bold}LIVE DAG${color.reset}`,
          `${color.fog}${formatClockLabel(nowMs())}${color.reset}`,
          width,
        );
        const activeLabel = phaseLabel === "planner"
          ? "planning"
          : phaseLabel === "thinking" || phaseLabel === "idle"
            ? "direct response"
            : phaseLabel;
        const lines = [
          pendingHeader,
          `${toneColor("cyan")}${plannerDagStatusGlyph("running")}${color.reset} ${color.softInk}${truncate(activeLabel, Math.max(12, width - 4))}${color.reset}`,
        ];
        if (objective) {
          lines.push(`${color.fog}${truncate(objective, width)}${color.reset}`);
        }
        return lines;
      }
      const lines = [
        header,
        metrics,
      ];
      if (watchState.plannerDagNote) {
        lines.push(`${color.fog}${truncate(watchState.plannerDagNote, width)}${color.reset}`);
      }
      return lines;
    }

    const display = selectPlannerDagDisplayNodes(snapshot, Math.max(3, maxCanvasLines));
    const displayNodes = display.nodes;
    const displayIndexByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
    const maxDisplayDepth = displayNodes.reduce(
      (max, node) => Math.max(max, depthByKey.get(node.key) ?? 0),
      0,
    );
    const graphWidth = Math.max(
      12,
      Math.min(
        24,
        width - 14,
        maxDisplayDepth > 0 ? 4 + maxDisplayDepth * 5 : 12,
      ),
    );
    const labelWidth = Math.max(12, width - graphWidth - 2);
    const depthSpan = Math.max(1, maxDisplayDepth);
    const xByKey = new Map(
      displayNodes.map((node) => [
        node.key,
        maxDisplayDepth > 0
          ? Math.max(
            1,
            Math.min(
              graphWidth - 2,
              1 + Math.round(((depthByKey.get(node.key) ?? 0) * (graphWidth - 3)) / depthSpan),
            ),
          )
          : 1,
      ]),
    );
    const yByKey = new Map(displayNodes.map((node, index) => [node.key, index]));
    const canvas = Array.from(
      { length: displayNodes.length },
      () => Array.from({ length: graphWidth }, () => " "),
    );
    const placeDagChar = (x, y, char) => {
      if (y < 0 || y >= displayNodes.length || x < 0 || x >= graphWidth) return;
      canvas[y][x] = mergeDagCanvasChar(canvas[y][x], char);
    };
    const drawHorizontal = (y, left, right) => {
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      for (let x = start; x <= end; x += 1) {
        placeDagChar(x, y, "─");
      }
    };
    const drawVertical = (x, top, bottom) => {
      const start = Math.min(top, bottom);
      const end = Math.max(top, bottom);
      for (let y = start; y <= end; y += 1) {
        placeDagChar(x, y, "│");
      }
    };

    for (const node of displayNodes) {
      const childKeys = childrenByKey.get(node.key) ?? [];
      const fromX = xByKey.get(node.key) ?? 1;
      const fromY = yByKey.get(node.key) ?? 0;
      for (const childKey of childKeys) {
        if (!displayIndexByKey.has(childKey)) {
          continue;
        }
        const toX = xByKey.get(childKey) ?? fromX + 4;
        const toY = yByKey.get(childKey) ?? fromY;
        const startX = Math.min(graphWidth - 2, fromX + 1);
        const endX = toX > fromX
          ? Math.max(0, toX - 1)
          : Math.min(graphWidth - 2, toX + 1);
        const bendX = toX > fromX
          ? Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)))
          : Math.min(graphWidth - 2, Math.max(startX + 1, fromX + 2));
        drawHorizontal(fromY, startX, bendX);
        drawVertical(bendX, fromY, toY);
        drawHorizontal(toY, Math.min(bendX, endX), Math.max(bendX, endX));
      }
    }

    const idByKey = new Map(
      displayNodes.map((node, index) => [
        node.key,
        "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[index] ?? String((index + 1) % 10),
      ]),
    );
    const nodeKeyByCoordinate = new Map(
      displayNodes.map((node) => [`${yByKey.get(node.key) ?? 0}:${xByKey.get(node.key) ?? 1}`, node.key]),
    );
    const lines = [
      header,
      metrics,
      ...displayNodes.map((node, rowIndex) => {
        let graphText = "";
        for (let columnIndex = 0; columnIndex < graphWidth; columnIndex += 1) {
          const key = nodeKeyByCoordinate.get(`${rowIndex}:${columnIndex}`);
          if (key) {
            const activeNode = snapshot.nodeByKey.get(key) ?? node;
            graphText += `${toneColor(plannerDagStatusTone(activeNode.status))}${plannerDagStatusGlyph(activeNode.status)}${color.reset}`;
            continue;
          }
          const char = canvas[rowIndex][columnIndex] ?? " ";
          graphText += char.trim().length > 0
            ? `${color.fog}${char}${color.reset}`
            : " ";
        }
        return `${fitAnsi(graphText.replace(/\s+$/g, ""), graphWidth)}  ${plannerDagLabelLine(node, idByKey.get(node.key) ?? "?", labelWidth)}`;
      }),
      ...plannerDagInfoLines(width, displayNodes, display),
    ];

    return lines;
  }

  function contextPanelLines(width) {
    const inner = width - 2;
    const elapsed = currentSessionElapsedLabel();
    const summary = currentSurfaceSummary();
    return renderPanel({
      title: "GUARD",
      subtitle: `${elapsed} attached`,
      tone:
        summary.attention.approvalAlertCount > 0
          ? "red"
          : summary.attention.errorAlertCount > 0
            ? "amber"
            : "teal",
      width,
      bg: color.panelBg,
      lines: [
        row(
          flexBetween(
            `${chip("MODE", summary.overview.transcriptMode, summary.overview.transcriptMode === "follow" ? "green" : summary.overview.transcriptMode === "detail" ? "cyan" : "amber")}`,
            `${chip("SESS", summary.overview.sessionToken, "slate")}`,
            inner,
          ),
          color.panelBg,
        ),
        row(
          flexBetween(
            `${chip("AUTH", summary.attention.approvalAlertCount, summary.attention.approvalAlertCount > 0 ? "red" : "green")}`,
            `${chip("ERR", summary.attention.errorAlertCount, summary.attention.errorAlertCount > 0 ? "amber" : "green")}`,
            inner,
          ),
          color.panelAltBg,
        ),
        row(
          flexBetween(
            `${chip("ACTIVE", summary.overview.durableActiveTotal, summary.overview.durableActiveTotal > 0 ? "cyan" : "slate")}`,
            `${chip("WAKE", summary.overview.durableQueuedSignalsTotal, summary.overview.durableQueuedSignalsTotal > 0 ? "amber" : "slate")}`,
            inner,
          ),
          color.panelBg,
        ),
        row(
          `${color.softInk}${truncate(summary.overview.runtimeLabel, inner)}${color.reset}`,
          color.panelAltBg,
        ),
        row("", color.panelBg),
        row(`${color.fog}${color.bold}RECENT ALERTS${color.reset}`, color.panelHiBg),
        ...(summary.attention.items.length > 0
          ? summary.attention.items.flatMap((item, index) => [
            row(
              `${toneColor(item.tone)}${truncate(item.timestamp, 10)}${color.reset} ${color.ink}${truncate(item.title, Math.max(18, inner - 12))}${color.reset}`,
              index % 2 === 0 ? color.panelBg : color.panelAltBg,
            ),
          ])
          : [row(`${color.softInk}No approval alerts or runtime faults.${color.reset}`, color.panelBg)]),
      ],
    });
  }

  function toolTimelinePanelLines(width, limit = 5) {
    const inner = width - 2;
    const summary = currentSurfaceSummary();
    const lines = [
      row(
        flexBetween(
          `${chip("LATEST", summary.overview.latestTool, stateTone(summary.overview.latestToolState))}`,
          `${chip("PLAN", summary.overview.planCount, summary.overview.planCount > 0 ? "magenta" : "slate")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("AGENTS", summary.overview.activeAgentCount, summary.overview.activeAgentCount > 0 ? "green" : "slate")}`,
          `${chip("RUNTIME", summary.overview.runtimeState, stateTone(summary.overview.runtimeState))}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    if (summary.recentTools.length === 0) {
      lines.push(row(`${color.softInk}No recent tool activity.${color.reset}`, color.panelBg));
    } else {
      for (const [index, item] of summary.recentTools.slice(0, limit).entries()) {
        const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
        lines.push(
          row(
            `${toneColor(item.tone)}${truncate(item.timestamp, 10)}${color.reset} ${color.ink}${truncate(item.title, Math.max(18, inner - 12))}${color.reset}`,
            bg,
          ),
        );
        lines.push(
          row(
            `${color.fog}${truncate(item.meta, inner)}${color.reset}`,
            bg,
          ),
        );
      }
    }

    return renderPanel({
      title: "TOOLS",
      subtitle: `${summary.recentTools.length} recent`,
      tone: summary.recentTools.length > 0 ? "teal" : "slate",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function agentsPanelLines(width, limit = 6, showSessionTokens = true) {
    const inner = width - 2;
    const planEntries = activePlanEntries(24);
    const activeAgents = activeAgentEntries(24);
    const terminalAgents = planEntries
      .filter((step) => step.status === "completed" || step.status === "failed" || step.status === "cancelled")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)
      .slice(0, Math.max(1, limit));
    const completedCount = planEntries.filter((step) => step.status === "completed").length;
    const failedCount = planEntries.filter((step) => step.status === "failed").length;
    const lines = [
      row(
        flexBetween(
          `${chip("ACTIVE", activeAgents.length, activeAgents.length > 0 ? "green" : "slate")}`,
          `${chip("DONE", completedCount, completedCount > 0 ? "teal" : "slate")}`,
          inner,
        ),
        color.panelBg,
      ),
      row(
        flexBetween(
          `${chip("FAIL", failedCount, failedCount > 0 ? "red" : "slate")}`,
          `${chip("QUEUE", queuedOperatorInputs.length, queuedOperatorInputs.length > 0 ? "amber" : "slate")}`,
          inner,
        ),
        color.panelAltBg,
      ),
    ];

    const displayAgents = activeAgents.length > 0
      ? activeAgents.slice(0, limit)
      : terminalAgents.slice(0, limit);

    if (displayAgents.length === 0) {
      lines.push(row(`${color.softInk}No delegated agents running.${color.reset}`, color.panelBg));
    } else {
      for (const [index, step] of displayAgents.entries()) {
        const tone = planStatusTone(step.status);
        const bg = index % 2 === 0 ? color.panelBg : color.panelAltBg;
        const label = `${toneColor(tone)}${planStatusGlyph(step.status)} ${planStepDisplayName(step, Math.max(16, inner - 6))}${color.reset}`;
        const token = compactSessionToken(step.subagentSessionId);
        const liveActivity = step.subagentSessionId
          ? sanitizeInlineText(subagentLiveActivity?.get(step.subagentSessionId) ?? "")
          : "";
        const note = sanitizeInlineText(liveActivity || step.note || step.objective || "");
        lines.push(row(label, bg));
        if (note) {
          lines.push(row(`${color.fog}${truncate(note, inner)}${color.reset}`, bg));
        } else if (token && showSessionTokens) {
          lines.push(row(`${color.fog}${truncate(`child ${token}`, inner)}${color.reset}`, bg));
        }
      }
    }

    return renderPanel({
      title: "AGENTS",
      subtitle: `${activeAgents.length} active`,
      tone: activeAgents.length > 0 ? "green" : "slate",
      width,
      bg: color.panelBg,
      lines,
    });
  }

  function sidebarObjectiveHeader(width) {
    const inner = width - 2;
    const summary = currentSurfaceSummary();
    const lines = [];
    if (summary.objective && summary.objective !== "No active objective") {
      lines.push(
        paintSurface(
          `${toneColor("teal")}${color.bold}OBJ${color.reset} ${color.ink}${truncate(summary.objective, inner - 4)}${color.reset}`,
          width,
          color.panelBg,
        ),
      );
    }
    if (summary.overview.activeLine && summary.overview.activeLine !== "Awaiting operator prompt" &&
        summary.overview.activeLine !== summary.objective) {
      lines.push(
        paintSurface(
          `${color.softInk}${truncate(summary.overview.activeLine, inner)}${color.reset}`,
          width,
          color.panelAltBg,
        ),
      );
    }
    return lines;
  }

  function sidebarLines(width, targetHeight) {
    const policy = buildWatchSidebarPolicy(targetHeight);
    const summarySection = sidebarObjectiveHeader(width);
    const dagSnapshot = buildPlannerDagSnapshot();
    const hasDagNodes = dagSnapshot.nodes.length > 0;
    const optionalSections = [];

    // Always show tools panel — it's the primary sidebar content for direct tool paths
    const toolsSection = toolTimelinePanelLines(width, hasDagNodes ? policy.toolLimit : policy.toolLimit + 3);
    const guardSection = policy.showGuard ? contextPanelLines(width) : null;
    const agentsSection = policy.showAgents
      ? agentsPanelLines(width, policy.compactAgentLimit, policy.showSessionTokens)
      : null;

    // Only show DAG when there are actual planner nodes
    if (hasDagNodes) {
      const dagDesiredRows = Math.max(
        policy.minDagRows,
        Math.min(
          Math.max(0, targetHeight - summarySection.length - 1),
          dagSnapshot.nodes.length + 4,
        ),
      );
      optionalSections.push(dagWidgetLines(width, dagDesiredRows));
    }

    for (const candidate of [toolsSection, guardSection, agentsSection]) {
      if (!candidate) {
        continue;
      }
      optionalSections.push(candidate);
    }

    const sections = [summarySection, ...optionalSections];
    const rows = [];
    for (const section of sections) {
      if (rows.length > 0) {
        rows.push("");
      }
      rows.push(...section);
    }
    while (rows.length < targetHeight) {
      rows.push(blankRow(width));
    }
    return rows;
  }

  function eventPreviewLines(event, width) {
    const sourcePreview = isSourcePreviewEvent(event);
    const mutationPreview = isMutationPreviewEvent(event);
    const markdownPreview = isMarkdownRenderableEvent(event);
    const latestEvent = events[events.length - 1] ?? null;
    const latestIsCurrent = latestEvent?.id === event?.id;
    const viewportLines = Math.max(12, termHeight() - 9);
    const maxLines = computeTranscriptPreviewMaxLines({
      eventKind: event.kind,
      sourcePreview,
      mutationPreview,
      latestIsCurrent,
      following: isTranscriptFollowing(),
      viewportLines,
      maxPreviewSourceLines,
    });
    const sourceLines =
      sourcePreview || markdownPreview || event.kind === "you" || event.kind === "subagent"
        ? buildEventDisplayLines(event, maxPreviewSourceLines)
        : compactBodyLines(event.body, Math.max(maxLines + 2, 4))
          .map((line) => createDisplayLine(line, "plain"));
    const wrapped =
      sourcePreview || markdownPreview
        ? wrapEventDisplayLines(event, width, sourcePreview ? maxPreviewSourceLines : maxPreviewSourceLines)
        : wrapDisplayLines(sourceLines, width);
    if (wrapped.length <= maxLines) {
      return wrapped;
    }
    const preview = wrapped.slice(0, maxLines);
    const lastIndex = preview.length - 1;
    const truncatedText = `${truncate(displayLineText(preview[lastIndex]).trimEnd(), Math.max(8, width - 1))}…`;
    preview[lastIndex] = {
      ...preview[lastIndex],
      text: truncatedText,
      plainText: truncatedText,
    };
    return preview;
  }

  function eventHasHiddenPreview(event, width) {
    const sourcePreview = isSourcePreviewEvent(event);
    const wrapped =
      sourcePreview || isMarkdownRenderableEvent(event)
        ? wrapEventDisplayLines(event, width, maxPreviewSourceLines * 8)
        : wrapDisplayLines(
          compactBodyLines(event.body, maxPreviewSourceLines * 2).map((line) => createDisplayLine(line)),
          width,
        );
    return event.bodyTruncated || wrapped.length > eventPreviewLines(event, width).length;
  }

  function latestExpandableEvent() {
    const { transcriptWidth } = currentTranscriptLayout();
    const previewWidth = Math.max(12, transcriptWidth - 4);
    for (let index = events.length - 1; index >= Math.max(0, events.length - 10); index -= 1) {
      const candidate = events[index];
      if (!candidate || !isMutationPreviewEvent(candidate)) {
        continue;
      }
      if (eventHasHiddenPreview(candidate, previewWidth)) {
        return candidate;
      }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && (isSourcePreviewEvent(event) || isMarkdownRenderableEvent(event))) {
        return event;
      }
    }
    return events[events.length - 1] ?? null;
  }

  function currentExpandedEvent() {
    if (!watchState.expandedEventId) {
      return null;
    }
    return events.find((event) => event.id === watchState.expandedEventId) ?? null;
  }

  function toggleExpandedEvent() {
    if (watchState.expandedEventId) {
      watchState.expandedEventId = null;
      watchState.detailScrollOffset = 0;
      setTransientStatus("detail closed");
      return;
    }
    const target = latestExpandableEvent();
    if (!target) {
      setTransientStatus("no detail available");
      return;
    }
    watchState.expandedEventId = target.id;
    watchState.detailScrollOffset = 0;
    setTransientStatus(`detail open: ${target.title}`);
  }

  function eventHeadline(event, previewLines) {
    const { headline } = splitTranscriptPreviewForHeadline(event, previewLines);
    switch (event.kind) {
      case "you":
        return headline || sanitizeDisplayText(event.title);
      case "tool":
      case "tool result":
      case "tool error":
      case "subagent":
      case "subagent tool":
      case "subagent tool result":
      case "subagent error":
        return sanitizeDisplayText(event.title);
      case "queued":
        return headline || "Queued input";
      case "operator":
        return sanitizeDisplayText(event.title);
      case "agent":
        return headline || sanitizeDisplayText(event.title);
      default:
        return sanitizeDisplayText(event.title);
    }
  }

  function shouldShowEventBody(event, { showBody = true } = {}) {
    return showBody && event.kind !== "queued";
  }

  function renderEventBlock(event, width, { showBody = true } = {}) {
    const rows = [];
    const previewLines = eventPreviewLines(event, Math.max(12, width - 4));
    const previewSplit = splitTranscriptPreviewForHeadline(event, previewLines);
    const summary = buildTranscriptEventSummary(
      event,
      previewLines.map((line) => displayLinePlainText(line)),
    );
    const badgeTone = toneColor(summary.badge.tone);
    const badgeText = `${badgeTone}${color.bold}${summary.badge.label}${color.reset}`;
    const headline = previewSplit.headline || eventHeadline(event, previewLines);
    rows.push(
      flexBetween(
        `${badgeText} ${color.ink}${truncate(sanitizeDisplayText(headline), Math.max(12, width - 18))}${color.reset}`,
        `${color.fog}${summary.timestamp}${color.reset}`,
        width,
      ),
    );
    if (summary.meta && summary.meta !== sanitizeDisplayText(headline)) {
      rows.push(
        `${color.border}│${color.reset} ${color.softInk}${truncate(summary.meta, Math.max(10, width - 3))}${color.reset}`,
      );
    }

    if (shouldShowEventBody(event, { showBody })) {
      previewSplit.bodyLines.forEach((line) => {
        rows.push(renderEventBodyLine(event, line, { inline: true }));
      });
    }
    return rows;
  }

  function flattenTranscriptView(width) {
    if (events.length === 0) {
      return {
        rows: [
          `${color.softInk}No activity yet.${color.reset}`,
          `${color.fog}Prompts, tool runs, and agent replies will appear here.${color.reset}`,
        ],
        ranges: new Map(),
      };
    }

    const rows = [];
    const ranges = new Map();
    const latestEvent = events[events.length - 1] ?? null;
    const richBodyWindow =
      isSourcePreviewEvent(latestEvent) || isMarkdownRenderableEvent(latestEvent) ? 8 : 6;
    const recentSourcePreviewIds = new Set(
      events
        .filter((event) => isSourcePreviewEvent(event))
        .slice(-8)
        .map((event) => event.id),
    );
    events.forEach((event, index) => {
      const showBody =
        recentSourcePreviewIds.has(event.id) ||
        index >= Math.max(0, events.length - richBodyWindow) ||
        event.id === latestEvent?.id;
      const start = rows.length + (index > 0 ? 1 : 0);
      const block = renderEventBlock(event, width, { showBody });
      if (index > 0) {
        rows.push(`${color.border}${"─".repeat(Math.max(12, width))}${color.reset}`);
      }
      rows.push(...block);
      ranges.set(event.id, { start, end: rows.length });
    });
    return { rows, ranges };
  }

  function currentTranscriptRowCount() {
    const { transcriptWidth } = currentTranscriptLayout();
    return flattenTranscriptView(transcriptWidth).rows.length;
  }

  function withPreservedManualTranscriptViewport(mutator) {
    const shouldFollow = isTranscriptFollowing();
    const beforeRows = shouldFollow ? null : currentTranscriptRowCount();
    const result = mutator({ shouldFollow });
    if (beforeRows !== null) {
      const afterRows = currentTranscriptRowCount();
      const nextViewport = preserveManualTranscriptViewport({
        shouldFollow,
        beforeRows,
        afterRows,
        transcriptScrollOffset: watchState.transcriptScrollOffset,
      });
      watchState.transcriptScrollOffset = nextViewport.transcriptScrollOffset;
      watchState.transcriptFollowMode = nextViewport.transcriptFollowMode;
    }
    return result;
  }

  function recentSourceFocusRange(ranges) {
    for (let index = events.length - 1; index >= Math.max(0, events.length - 10); index -= 1) {
      const candidate = events[index];
      if (!candidate || !isMutationPreviewEvent(candidate)) {
        continue;
      }
      return ranges.get(candidate.id) ?? null;
    }
    return null;
  }

  function activityPanelLines(width, targetHeight) {
    const transcriptView = flattenTranscriptView(width);
    const sliced = sliceViewportRowsFromBottom(
      transcriptView.rows,
      targetHeight,
      watchState.transcriptScrollOffset,
    );
    watchState.transcriptScrollOffset = sliced.normalizedOffset;
    const lines = bottomAlignViewportRows([...sliced.rows], targetHeight);
    return {
      lines,
      hiddenAbove: sliced.hiddenAbove,
      hiddenBelow: sliced.hiddenBelow,
    };
  }

  function isTranscriptFollowing() {
    return isViewportTranscriptFollowing({
      transcriptFollowMode: watchState.transcriptFollowMode,
      transcriptScrollOffset: watchState.transcriptScrollOffset,
    });
  }

  function detailViewportState(event, width, targetHeight) {
    const body = wrapEventDisplayLines(event, width);
    const metaRows = event?.title && buildTranscriptEventSummary(event).meta !== sanitizeDisplayText(event.title)
      ? 1
      : 0;
    const availableRows = Math.max(4, targetHeight - (4 + metaRows) - 1);
    const sliced = sliceViewportRowsFromBottom(body, availableRows, watchState.detailScrollOffset);
    return {
      body,
      metaRows,
      availableRows,
      sliced,
    };
  }

  function buildDiffNavigationState(event, body, availableRows, visibleStartIndex = 0) {
    if (typeof isDiffRenderableEvent === "function" && !isDiffRenderableEvent(event)) {
      return {
        enabled: false,
        hunkAnchors: [],
        currentHunkIndex: 0,
        totalHunks: 0,
        currentFilePath: "",
        fileCount: 0,
      };
    }
    let currentFilePath = sanitizeInlineText(event?.filePath ?? "");
    const filePaths = [];
    const hunkAnchors = [];
    for (const [index, line] of body.entries()) {
      if (typeof line?.filePath === "string" && line.filePath.trim()) {
        currentFilePath = sanitizeInlineText(line.filePath);
        if (currentFilePath && !filePaths.includes(currentFilePath)) {
          filePaths.push(currentFilePath);
        }
      }
      if (line?.mode === "diff-hunk") {
        hunkAnchors.push({
          index,
          label: sanitizeInlineText(displayLinePlainText(line), "@@"),
          filePath: currentFilePath,
        });
      }
    }
    const currentHunkIndex = hunkAnchors.reduce((selected, anchor, index) =>
      anchor.index <= visibleStartIndex ? index : selected, 0);
    const currentHunk = hunkAnchors[currentHunkIndex] ?? null;
    return {
      enabled: hunkAnchors.length > 0,
      hunkAnchors,
      currentHunkIndex,
      totalHunks: hunkAnchors.length,
      currentFilePath: sanitizeInlineText(currentHunk?.filePath ?? filePaths[0] ?? event?.filePath ?? ""),
      fileCount: filePaths.length || (currentFilePath ? 1 : 0),
      availableRows,
      bodyLength: body.length,
    };
  }

  function buildExpandedDetailView(width, targetHeight) {
    const event = currentExpandedEvent();
    if (!event) {
      watchState.expandedEventId = null;
      watchState.detailScrollOffset = 0;
      return null;
    }
    const viewport = detailViewportState(event, width, targetHeight);
    watchState.detailScrollOffset = viewport.sliced.normalizedOffset;
    const diffNavigation = buildDiffNavigationState(
      event,
      viewport.body,
      viewport.availableRows,
      viewport.sliced.hiddenAbove,
    );
    const detailSummary = buildDetailPaneSummary(event, {
      bodyLineCount: viewport.body.length,
      visibleLineCount: viewport.sliced.rows.length,
      hiddenAbove: viewport.sliced.hiddenAbove,
      hiddenBelow: viewport.sliced.hiddenBelow,
    });
    if (diffNavigation.enabled) {
      detailSummary.hint = `${detailSummary.hint}  ctrl+p prev hunk  ctrl+n next hunk`;
      const detailParts = [
        detailSummary.statusLine,
        `hunk ${diffNavigation.currentHunkIndex + 1}/${diffNavigation.totalHunks}`,
      ];
      if (diffNavigation.currentFilePath) {
        detailParts.push(truncate(diffNavigation.currentFilePath, Math.max(18, width - 24)));
      }
      detailSummary.statusLine = detailParts.join("  ");
    }
    return {
      event,
      detailSummary,
      diffNavigation,
      ...viewport,
    };
  }

  function expandedDetailLines(width, targetHeight) {
    const detail = buildExpandedDetailView(width, targetHeight);
    if (!detail) {
      return activityPanelLines(width, targetHeight);
    }
    const {
      event,
      sliced,
      detailSummary,
      diffNavigation,
    } = detail;
    const rows = [
      flexBetween(
        `${toneColor(detailSummary.badge.tone)}${color.bold}${detailSummary.badge.label}${color.reset} ${color.ink}${truncate(sanitizeDisplayText(detailSummary.title), Math.max(20, width - 18))}${color.reset}`,
        `${color.fog}${detailSummary.timestamp}${color.reset}`,
        width,
      ),
      `${color.fog}${detailSummary.hint}${color.reset}`,
      ...(detailSummary.meta && detailSummary.meta !== sanitizeDisplayText(detailSummary.title)
        ? [`${color.border}│${color.reset} ${color.softInk}${truncate(detailSummary.meta, Math.max(10, width - 3))}${color.reset}`]
        : []),
      ...(diffNavigation.enabled && diffNavigation.currentFilePath
        ? [`${color.border}│${color.reset} ${color.softInk}${truncate(diffNavigation.currentFilePath, Math.max(10, width - 3))}${color.reset}`]
        : []),
      "",
      ...sliced.rows.map((line) => renderEventBodyLine(event, line)),
    ];
    while (rows.length < targetHeight - 1) {
      rows.push("");
    }
    rows.push(`${color.fog}${detailSummary.statusLine}${color.reset}`);
    return {
      lines: rows.slice(0, targetHeight),
      hiddenAbove: sliced.hiddenAbove,
      hiddenBelow: sliced.hiddenBelow,
      diffNavigation,
    };
  }

  function currentDiffNavigationState() {
    if (!watchState.expandedEventId) {
      return {
        enabled: false,
        currentHunkIndex: 0,
        totalHunks: 0,
        currentFilePath: "",
      };
    }
    const { transcriptWidth, bodyHeight } = currentTranscriptLayout();
    const detail = buildExpandedDetailView(transcriptWidth, bodyHeight);
    return detail?.diffNavigation ?? {
      enabled: false,
      currentHunkIndex: 0,
      totalHunks: 0,
      currentFilePath: "",
    };
  }

  function jumpCurrentDiffHunk(direction = 1) {
    const { transcriptWidth, bodyHeight } = currentTranscriptLayout();
    const detail = buildExpandedDetailView(transcriptWidth, bodyHeight);
    if (!detail?.diffNavigation?.enabled) {
      return false;
    }
    const step = Number(direction) >= 0 ? 1 : -1;
    const currentIndex = detail.diffNavigation.currentHunkIndex;
    const nextIndex = step > 0
      ? Math.min(detail.diffNavigation.totalHunks - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    if (nextIndex === currentIndex) {
      setTransientStatus(
        step > 0
          ? `last hunk ${currentIndex + 1}/${detail.diffNavigation.totalHunks}`
          : `first hunk ${currentIndex + 1}/${detail.diffNavigation.totalHunks}`,
      );
      return false;
    }
    const targetAnchor = detail.diffNavigation.hunkAnchors[nextIndex];
    const desiredStart = Math.max(0, targetAnchor.index - 1);
    watchState.detailScrollOffset = Math.max(
      0,
      detail.diffNavigation.bodyLength - Math.min(detail.diffNavigation.bodyLength, desiredStart + detail.diffNavigation.availableRows),
    );
    setTransientStatus(`hunk ${nextIndex + 1}/${detail.diffNavigation.totalHunks}`);
    return true;
  }

  function copyableTranscriptText() {
    if (watchState.expandedEventId) {
      const event = currentExpandedEvent();
      if (!event) {
        return "";
      }
      return [
        `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
        event.body,
      ].join("\n\n").trim();
    }

    return events
      .map((event) => [
        `[${event.timestamp}] ${sanitizeDisplayText(event.title)}`,
        event.body,
      ].join("\n"))
      .join("\n\n")
      .trim();
  }

  function exportViewText(text, mode = watchState.expandedEventId ? "detail" : "transcript") {
    const safeMode = String(mode ?? "view")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "view";
    const exportPath = path.join(
      os.tmpdir(),
      `agenc-watch-${safeMode}-${nowMs()}.txt`,
    );
    fs.writeFileSync(exportPath, `${text}\n`);
    return exportPath;
  }

  function exportCurrentView({ announce = false } = {}) {
    const text = copyableTranscriptText();
    if (!text) {
      setTransientStatus("nothing to export");
      scheduleRender();
      return null;
    }

    const mode = watchState.expandedEventId ? "detail" : "transcript";
    const exportPath = exportViewText(text, mode);
    if (announce) {
      pushEvent(
        "operator",
        mode === "detail" ? "Detail Export" : "Transcript Export",
        `${mode[0].toUpperCase()}${mode.slice(1)} exported to ${exportPath}.`,
        "teal",
      );
    } else {
      setTransientStatus(`${mode} exported to ${exportPath}`);
      scheduleRender();
    }
    return exportPath;
  }

  function copyCurrentView() {
    const text = copyableTranscriptText();
    if (!text) {
      setTransientStatus("nothing to copy");
      scheduleRender();
      return;
    }

    const destinations = [];
    let clipboardCommand = null;
    const clipboardCommands = [
      ["pbcopy", []],
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ];
    for (const [command, args] of clipboardCommands) {
      try {
        execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
        clipboardCommand = command;
        destinations.push(`clipboard via ${command}`);
        break;
      } catch {}
    }

    try {
      if (process.env.TMUX) {
        execFileSync("tmux", ["load-buffer", "-"], { input: text });
        destinations.push("tmux buffer");
      }
    } catch {}

    if (!clipboardCommand) {
      destinations.push(exportViewText(text));
    }

    const viewLabel = watchState.expandedEventId ? "detail" : "transcript";
    setTransientStatus(`${viewLabel} copied: ${destinations.join(" / ")}`);
    scheduleRender();
  }

  function scrollTranscriptBy(delta) {
    watchState.transcriptScrollOffset = applyViewportScrollDelta(
      watchState.transcriptScrollOffset,
      delta,
    );
    watchState.transcriptFollowMode = watchState.transcriptScrollOffset === 0;
    scheduleRender();
  }

  function scrollDetailBy(delta) {
    watchState.detailScrollOffset = applyViewportScrollDelta(
      watchState.detailScrollOffset,
      delta,
    );
    scheduleRender();
  }

  function scrollCurrentViewBy(delta) {
    if (watchState.expandedEventId) {
      scrollDetailBy(delta);
      return;
    }
    scrollTranscriptBy(delta);
  }

  function enterAltScreen() {
    if (!stdout.isTTY || frameState.enteredAltScreen) {
      return;
    }
    stdout.write(buildAltScreenEnterSequence({ enableMouseTracking }));
    frameState.enteredAltScreen = true;
  }

  function leaveAltScreen() {
    if (!frameState.enteredAltScreen) {
      return;
    }
    stdout.write(buildAltScreenLeaveSequence({ enableMouseTracking }));
    frameState.enteredAltScreen = false;
    frameState.lastRenderedFrameLines = [];
    frameState.lastRenderedFrameWidth = 0;
    frameState.lastRenderedFrameHeight = 0;
  }

  function footerHintLine(width, diffNavigation = null) {
    const fileTagPalette = currentFileTagPalette(6);
    const footer = buildWatchFooterSummary({
      summary: currentSurfaceSummary(),
      inputValue: currentInputValue(),
      suggestions: currentSlashSuggestions(6),
      modelSuggestions: typeof currentModelSuggestions === "function" ? currentModelSuggestions(6) : [],
      fileTagQuery: fileTagPalette.activeTag?.query ?? null,
      fileTagSuggestions: fileTagPalette.suggestions,
      fileTagIndexReady: workspaceFileIndex.ready,
      fileTagIndexError: workspaceFileIndex.error,
      connectionState: transportState.connectionState,
      activeRun: hasActiveSurfaceRun(),
      elapsedLabel: hasActiveSurfaceRun()
        ? currentRunElapsedLabel()
        : currentSessionElapsedLabel(),
      latestTool: currentSurfaceToolLabel(""),
      latestToolState: watchState.latestToolState,
      transientStatus: watchState.transientStatus,
      latestAgentSummary: watchState.latestAgentSummary,
      objective: hasActiveSurfaceRun() ? currentDisplayObjective("") : "",
      isOpen: transportState.isOpen,
      bootstrapPending: bootstrapPending(),
      latestExpandable: Boolean(latestExpandableEvent()),
      enableMouseTracking,
      detailDiffNavigation: diffNavigation,
    });
    return flexBetween(
      `${color.fog}${truncate(footer.hintLeft, Math.max(16, width - 22))}${color.reset}`,
      `${color.fog}${footer.hintRight}${color.reset}`,
      width,
    );
  }

  function footerStatusLine(width, diffNavigation = null) {
    const summary = currentSurfaceSummary();
    const activeRun = hasActiveSurfaceRun();
    const elapsedLabel = activeRun ? currentRunElapsedLabel() : currentSessionElapsedLabel();
    const fileTagPalette = currentFileTagPalette(6);
    const footer = buildWatchFooterSummary({
      summary,
      inputValue: currentInputValue(),
      suggestions: currentSlashSuggestions(6),
      modelSuggestions: typeof currentModelSuggestions === "function" ? currentModelSuggestions(6) : [],
      fileTagQuery: fileTagPalette.activeTag?.query ?? null,
      fileTagSuggestions: fileTagPalette.suggestions,
      fileTagIndexReady: workspaceFileIndex.ready,
      fileTagIndexError: workspaceFileIndex.error,
      connectionState: transportState.connectionState,
      activeRun,
      elapsedLabel,
      latestTool: currentSurfaceToolLabel(""),
      latestToolState: watchState.latestToolState,
      transientStatus: watchState.transientStatus,
      latestAgentSummary: watchState.latestAgentSummary,
      objective: activeRun ? currentDisplayObjective("") : "",
      isOpen: transportState.isOpen,
      bootstrapPending: bootstrapPending(),
      latestExpandable: Boolean(latestExpandableEvent()),
      enableMouseTracking,
      detailDiffNavigation: diffNavigation,
    });
    const workingPrefix =
      activeRun && transportState.connectionState === "live"
        ? `${animatedWorkingGlyph()} `
        : "";
    const left = footer.leftDetails.length > 0
      ? `${toneColor(footer.statusTone)}${color.bold}${workingPrefix}${footer.statusLabel}${color.reset}${color.softInk}  ${footer.leftDetails.join("  ")}${color.reset}`
      : `${toneColor(footer.statusTone)}${color.bold}${workingPrefix}${footer.statusLabel}${color.reset}`;

    return flexBetween(
      left,
      `${color.fog}${truncate(footer.rightStatus || "idle", Math.max(18, Math.floor(width * 0.38)))}${color.reset}`,
      width,
    );
  }

  function buildVisibleFrameSnapshot({ width = termWidth(), height = termHeight() } = {}) {
    const footerRows = 4;
    let frame;
    let diffNavigation = null;
    const slashMode = isSlashComposerInput(currentInputValue());
    const fileTagPalette = currentFileTagPalette(Math.max(4, Math.min(8, height - 12)));

    if (splashRenderer.shouldShowSplash()) {
      const splashHeight = Math.max(8, height - footerRows);
      frame = splashHeight >= 16
        ? splashRenderer.renderSplash(width, splashHeight)
        : splashRenderer.renderCompactSplash(width, splashHeight);
    } else {
      const header = headerLines(width);
      const popup = watchState.expandedEventId
        ? []
        : fileTagPalette.activeTag
          ? fileTagPaletteLines(
            Math.min(68, Math.max(38, width - 4)),
            Math.max(4, Math.min(8, height - 12)),
            fileTagPalette,
          )
          : slashMode
            ? commandPaletteLines(Math.min(68, Math.max(38, width - 4)), Math.max(4, Math.min(8, height - 12)))
            : [];
      const { bodyHeight, useSidebar, sidebarWidth, transcriptWidth } = currentTranscriptLayout();
      const transcriptView = watchState.expandedEventId
        ? expandedDetailLines(transcriptWidth, bodyHeight)
        : activityPanelLines(transcriptWidth, bodyHeight);
      diffNavigation = transcriptView.diffNavigation ?? null;
      const transcriptLines = [...transcriptView.lines];
      if (!watchState.expandedEventId && transcriptLines.length > 0) {
        if (transcriptView.hiddenAbove > 0) {
          const aboveText = `${color.fog}▲ ${transcriptView.hiddenAbove} more line${transcriptView.hiddenAbove === 1 ? "" : "s"} above${color.reset}`;
          transcriptLines[0] = paintSurface(aboveText, transcriptWidth, color.panelBg);
        }
        if (transcriptView.hiddenBelow > 0) {
          const belowText = `${color.fog}▼ ${transcriptView.hiddenBelow} more line${transcriptView.hiddenBelow === 1 ? "" : "s"} below${color.reset}`;
          transcriptLines[transcriptLines.length - 1] = paintSurface(belowText, transcriptWidth, color.panelBg);
        }
      }
      const transcript = useSidebar
        ? joinColumns(
          transcriptLines,
          sidebarLines(sidebarWidth, bodyHeight),
          transcriptWidth,
          sidebarWidth,
          2,
        )
        : transcriptLines;
      frame = [
        ...header,
        ...transcript,
        ...(popup.length > 0 ? ["", ...popup.map((line) => `  ${line}`)] : []),
      ];
    }
    const composer = composerRenderLine(width);
    const composerLines = composer.lines ?? [composer.line];
    const composerExtraRows = composerLines.length - 1;
    const bodyRows = Math.max(0, height - footerRows - composerExtraRows);
    const nextFrameLines = [];
    for (let rowIndex = 0; rowIndex < bodyRows; rowIndex += 1) {
      nextFrameLines.push(paintSurface(frame[rowIndex] ?? "", width, color.panelBg));
    }
    nextFrameLines.push(paintSurface(`${color.border}${"─".repeat(width)}${color.reset}`, width, color.panelBg));
    nextFrameLines.push(paintSurface(footerStatusLine(width, diffNavigation), width, color.panelBg));
    nextFrameLines.push(paintSurface(footerHintLine(width, diffNavigation), width, color.panelBg));
    for (const cLine of composerLines) {
      nextFrameLines.push(paintSurface(cLine, width, color.panelBg));
    }
    // Cursor row accounts for wrapped composer lines (1-indexed for ANSI positioning)
    const cursorAbsoluteRow = height - composerLines.length + (composer.cursorRow ?? 0) + 1;
    return {
      lines: nextFrameLines,
      width,
      height,
      composer: {
        ...composer,
        cursorColumn: composer.cursorColumn,
        absoluteRow: cursorAbsoluteRow,
      },
      diffNavigation,
    };
  }

  function render() {
    frameState.renderPending = false;
    enterAltScreen();
    const snapshot = buildVisibleFrameSnapshot();
    const { lines: nextFrameLines, width, height, composer } = snapshot;

    const requiresFullClear =
      frameState.lastRenderedFrameWidth !== width ||
      frameState.lastRenderedFrameHeight !== height ||
      frameState.lastRenderedFrameLines.length !== nextFrameLines.length;

    stdout.write("\x1b[?25l");
    if (requiresFullClear) {
      stdout.write(`${color.panelBg}\x1b[H\x1b[2J`);
      for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
        stdout.write(`\x1b[${rowIndex + 1};1H${nextFrameLines[rowIndex]}`);
      }
    } else {
      for (let rowIndex = 0; rowIndex < nextFrameLines.length; rowIndex += 1) {
        if (nextFrameLines[rowIndex] === frameState.lastRenderedFrameLines[rowIndex]) {
          continue;
        }
        stdout.write(`\x1b[${rowIndex + 1};1H\x1b[2K${nextFrameLines[rowIndex]}`);
      }
    }
    frameState.lastRenderedFrameLines = nextFrameLines;
    frameState.lastRenderedFrameWidth = width;
    frameState.lastRenderedFrameHeight = height;
    const cursorRow = composer.absoluteRow ?? height;
    stdout.write(`\x1b[${cursorRow};${composer.cursorColumn}H\x1b[?25h`);
    stdout.write(color.reset);
  }

  function scheduleRender() {
    if (frameState.renderPending) {
      return;
    }
    frameState.renderPending = true;
    setTimer(render, 0);
  }

  return {
    currentTranscriptLayout,
    shouldShowSplash: splashRenderer.shouldShowSplash,
    latestExpandableEvent,
    currentExpandedEvent,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    toggleExpandedEvent,
    currentTranscriptRowCount,
    withPreservedManualTranscriptViewport,
    exportCurrentView,
    copyCurrentView,
    scrollCurrentViewBy,
    buildVisibleFrameSnapshot,
    leaveAltScreen,
    render,
    scheduleRender,
  };
}
