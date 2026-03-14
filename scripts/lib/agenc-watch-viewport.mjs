export function applyScrollDelta(offset, delta) {
  return Math.max(0, Number(offset ?? 0) + Number(delta ?? 0));
}

export function isTranscriptFollowing({
  transcriptFollowMode,
  transcriptScrollOffset,
}) {
  return Boolean(transcriptFollowMode) || Number(transcriptScrollOffset ?? 0) === 0;
}

export function preserveManualTranscriptViewport({
  shouldFollow,
  beforeRows,
  afterRows,
  transcriptScrollOffset,
}) {
  if (shouldFollow) {
    return {
      transcriptScrollOffset: 0,
      transcriptFollowMode: true,
    };
  }
  const nextOffset = Math.max(
    0,
    Number(transcriptScrollOffset ?? 0) + (Number(afterRows ?? 0) - Number(beforeRows ?? 0)),
  );
  return {
    transcriptScrollOffset: nextOffset,
    transcriptFollowMode: nextOffset === 0,
  };
}

export function sliceRowsAroundRange(allRows, targetHeight, range, trailingPad = 6) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const viewHeight = Math.max(8, Number(targetHeight) || 0);
  const maxStart = Math.max(0, rows.length - viewHeight);
  const preferredStart = Math.max(0, Number(range?.start ?? 0) - 1);
  let start = Math.min(preferredStart, maxStart);
  let end = Math.min(
    rows.length,
    Math.max(start + viewHeight, Number(range?.end ?? 0) + Number(trailingPad ?? 0)),
  );
  if (end - start > viewHeight) {
    end = start + viewHeight;
  }
  if (end > rows.length) {
    end = rows.length;
    start = Math.max(0, end - viewHeight);
  }
  return {
    rows: rows.slice(start, end),
    maxOffset: maxStart,
    normalizedOffset: 0,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, rows.length - end),
  };
}

export function sliceRowsFromBottom(allRows, targetHeight, offset) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const viewHeight = Math.max(8, Number(targetHeight) || 0);
  const maxOffset = Math.max(0, rows.length - viewHeight);
  const normalizedOffset = Math.max(0, Math.min(Number(offset ?? 0), maxOffset));
  const end = Math.max(0, rows.length - normalizedOffset);
  const start = Math.max(0, end - viewHeight);
  return {
    rows: rows.slice(start, end),
    maxOffset,
    normalizedOffset,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, rows.length - end),
  };
}

export function bottomAlignRows(rows, targetHeight) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const padding = Math.max(0, Number(targetHeight ?? 0) - normalizedRows.length);
  return padding > 0
    ? Array.from({ length: padding }, () => "").concat(normalizedRows)
    : normalizedRows;
}
