export function compactBodyLines(
  value,
  {
    sanitizeDisplayText,
    sanitizeInlineText,
    truncate,
    maxLines = 5,
  },
) {
  const lines = sanitizeDisplayText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[\[\]{}(),]+$/.test(line));
  if (lines.length === 0) {
    const fallback = sanitizeInlineText(String(value ?? ""));
    return fallback ? [fallback] : [];
  }
  return lines.slice(0, maxLines).map((line) => truncate(line, 220));
}

export function joinDescriptorBody(lines, fallback = "") {
  return lines.filter(Boolean).join("\n") || fallback;
}
