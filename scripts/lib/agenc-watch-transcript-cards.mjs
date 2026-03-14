function plainText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.plainText ?? line?.text ?? "");
}

function usesPreviewHeadline(kind) {
  return kind === "you" || kind === "queued" || kind === "agent";
}

export function splitTranscriptPreviewForHeadline(event, previewLines = []) {
  const lines = Array.isArray(previewLines) ? [...previewLines] : [];
  if (!usesPreviewHeadline(String(event?.kind ?? ""))) {
    return {
      headline: "",
      bodyLines: lines,
    };
  }

  const firstPreviewLine = plainText(lines.shift() ?? "");
  return {
    headline: firstPreviewLine,
    bodyLines: lines,
  };
}

export function computeTranscriptPreviewMaxLines({
  eventKind = "",
  sourcePreview = false,
  mutationPreview = false,
  latestIsCurrent = false,
  following = false,
  viewportLines = 12,
  maxPreviewSourceLines = 160,
} = {}) {
  const viewport = Math.max(12, Number(viewportLines) || 12);
  if (eventKind === "agent" && latestIsCurrent && following) {
    return Infinity;
  }
  const sourceInlineBudget = mutationPreview
    ? Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 32 : 18,
        Math.floor(viewport * (latestIsCurrent ? 0.84 : 0.56)),
      ),
    )
    : Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 12 : 6,
        Math.floor(viewport * (latestIsCurrent ? 0.32 : 0.2)),
      ),
    );
  if (mutationPreview) {
    return sourceInlineBudget;
  }
  if (sourcePreview) {
    return Math.min(sourceInlineBudget, latestIsCurrent ? 10 : 6);
  }
  if (eventKind === "agent") {
    return Math.max(
      latestIsCurrent ? 10 : 6,
      Math.floor(viewport * (latestIsCurrent ? 0.42 : 0.24)),
    );
  }
  if (eventKind === "subagent") {
    return 4;
  }
  if (
    eventKind === "subagent tool" ||
    eventKind === "subagent tool result" ||
    eventKind === "subagent error"
  ) {
    return 4;
  }
  if (eventKind === "you" || eventKind === "operator" || eventKind === "queued") {
    return 3;
  }
  if (eventKind === "tool" || eventKind === "tool result" || eventKind === "tool error") {
    return 3;
  }
  if (eventKind === "error" || eventKind === "approval") {
    return 3;
  }
  return 2;
}
