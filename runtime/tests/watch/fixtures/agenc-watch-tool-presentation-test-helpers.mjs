import { createWatchToolPresentation } from "../../../src/watch/agenc-watch-tool-presentation.mjs";
import { createWatchToolPresentationNormalizer } from "../../../src/watch/agenc-watch-tool-presentation-normalizer.mjs";

function createPresentationDependencies() {
  const sanitizeLargeText = (value) =>
    String(value)
      .replace(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
        "(image omitted)",
      )
      .replace(/"data":"[A-Za-z0-9+/=\r\n]{120,}"/g, '"data":"(image omitted)"')
      .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(blob omitted)");
  const sanitizeInlineText = (value) => sanitizeLargeText(value).replace(/\s+/g, " ").trim();
  const sanitizeDisplayText = (value) =>
    sanitizeLargeText(value)
      .replace(/```/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "");
  const stable = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const tryParseJson = (value) => {
    if (typeof value !== "string") {
      return value && typeof value === "object" ? value : null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  const tryPrettyJson = (value) => {
    const raw = typeof value === "string" ? sanitizeLargeText(value) : stable(value);
    if (typeof raw !== "string") {
      return stable(raw);
    }
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };
  const parseStructuredJson = (value) => {
    if (typeof value !== "string") {
      return value && typeof value === "object" ? [value] : [];
    }
    const single = tryParseJson(value);
    if (single && typeof single === "object" && !Array.isArray(single)) {
      return [single];
    }
    return value
      .split("\n")
      .map((line) => tryParseJson(line.trim()))
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  };

  return {
    sanitizeInlineText,
    sanitizeLargeText,
    sanitizeDisplayText,
    truncate: (value, maxChars = 220) =>
      value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    buildToolSummary: (parsed) => {
      const entries = Array.isArray(parsed) ? parsed : [];
      return entries
        .map((entry) => (entry && typeof entry === "object" ? entry.status : null))
        .filter(Boolean)
        .map((status) => `status: ${status}`);
    },
  };
}

export function createToolPresentation() {
  return createWatchToolPresentation(createPresentationDependencies());
}

export function createToolPresentationNormalizer() {
  const {
    sanitizeInlineText,
    sanitizeLargeText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
  } = createPresentationDependencies();

  return createWatchToolPresentationNormalizer({
    sanitizeInlineText,
    sanitizeLargeText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
  });
}
