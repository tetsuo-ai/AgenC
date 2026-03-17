function sameSignature(left, right) {
  return Boolean(
    left &&
    right &&
    left.body === right.body &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.renderMode === right.renderMode &&
    left.previewMode === right.previewMode &&
    left.renderSignature === right.renderSignature,
  );
}

function normalizeMaxLines(maxLines) {
  return Number.isFinite(Number(maxLines)) ? Number(maxLines) : Infinity;
}

function cacheWidthKey(width, maxLines) {
  const normalizedWidth = Number.isFinite(Number(width)) ? Number(width) : 0;
  const normalizedMaxLines = normalizeMaxLines(maxLines);
  return `${normalizedWidth}:${Number.isFinite(normalizedMaxLines) ? normalizedMaxLines : "all"}`;
}

export function createWatchRenderCache() {
  return {
    baseLines: new WeakMap(),
    wrappedLines: new WeakMap(),
  };
}

export function buildWatchRenderCacheSignature(event) {
  return {
    body: String(event?.body ?? ""),
    kind: String(event?.kind ?? ""),
    title: String(event?.title ?? ""),
    renderMode: String(event?.renderMode ?? ""),
    previewMode: String(event?.previewMode ?? ""),
    renderSignature: String(event?.renderSignature ?? ""),
  };
}

export function getCachedEventDisplayLines(
  cache,
  event,
  signature,
  buildLines,
  { maxLines = Infinity } = {},
) {
  if (!cache?.baseLines || typeof buildLines !== "function") {
    throw new TypeError("getCachedEventDisplayLines requires a cache and builder");
  }
  const normalizedMaxLines = normalizeMaxLines(maxLines);
  let entry = cache.baseLines.get(event);
  if (!sameSignature(entry?.signature, signature)) {
    entry = {
      signature,
      lines: buildLines(),
    };
    cache.baseLines.set(event, entry);
    cache.wrappedLines.delete(event);
  }
  if (!Number.isFinite(normalizedMaxLines)) {
    return entry.lines;
  }
  return entry.lines.slice(0, normalizedMaxLines);
}

export function getCachedWrappedDisplayLines(
  cache,
  event,
  signature,
  width,
  maxLines,
  buildWrappedLines,
) {
  if (!cache?.wrappedLines || typeof buildWrappedLines !== "function") {
    throw new TypeError("getCachedWrappedDisplayLines requires a cache and builder");
  }
  const key = cacheWidthKey(width, maxLines);
  let entry = cache.wrappedLines.get(event);
  if (!sameSignature(entry?.signature, signature)) {
    entry = {
      signature,
      entries: new Map(),
    };
    cache.wrappedLines.set(event, entry);
  }
  if (entry.entries.has(key)) {
    return entry.entries.get(key);
  }
  const lines = buildWrappedLines();
  entry.entries.set(key, lines);
  return lines;
}
