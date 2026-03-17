import {
  createWatchToolPresentationNormalizer,
  DEFAULT_LOW_SIGNAL_SHELL_COMMANDS,
} from "./agenc-watch-tool-presentation-normalizer.mjs";
import { createWatchToolPresentationCopyBuilder } from "./agenc-watch-tool-presentation-copy.mjs";

const REQUIRED_DEPENDENCIES = Object.freeze([
  "sanitizeInlineText",
  "sanitizeLargeText",
  "sanitizeDisplayText",
  "truncate",
  "stable",
  "tryParseJson",
  "tryPrettyJson",
  "parseStructuredJson",
  "buildToolSummary",
]);

function assertDependency(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(
      `createWatchToolPresentation requires a ${name} function dependency`,
    );
  }
}

export function createWatchToolPresentation(dependencies = {}) {
  for (const key of REQUIRED_DEPENDENCIES) {
    assertDependency(key, dependencies[key]);
  }

  const {
    sanitizeInlineText,
    sanitizeLargeText,
    sanitizeDisplayText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    buildToolSummary,
    maxEventBodyLines = 5,
    lowSignalShellCommands = DEFAULT_LOW_SIGNAL_SHELL_COMMANDS,
  } = dependencies;

  const normalizer = createWatchToolPresentationNormalizer({
    sanitizeInlineText,
    sanitizeLargeText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    lowSignalShellCommands,
  });

  const copyBuilder = createWatchToolPresentationCopyBuilder({
    sanitizeInlineText,
    sanitizeDisplayText,
    truncate,
    buildToolSummary,
    maxEventBodyLines,
  });

  function describeToolStart(toolName, args) {
    return copyBuilder.describeToolStart(
      normalizer.normalizeToolStart(toolName, args),
    );
  }

  function describeToolResult(toolName, args, isError, result) {
    return copyBuilder.describeToolResult(
      normalizer.normalizeToolResult(toolName, args, isError, result),
    );
  }

  function backgroundToolSurfaceLabel(toolName, args) {
    if (normalizer.shouldSuppressToolActivity(toolName, args)) {
      return null;
    }
    const descriptor = describeToolStart(toolName, args);
    const title = sanitizeInlineText(descriptor?.title ?? "");
    return title || null;
  }

  return {
    backgroundToolSurfaceLabel,
    compactPathForDisplay: normalizer.compactPathForDisplay,
    describeToolResult,
    describeToolStart,
    formatShellCommand: normalizer.formatShellCommand,
    shouldSuppressToolActivity: normalizer.shouldSuppressToolActivity,
    shouldSuppressToolTranscript: normalizer.shouldSuppressToolTranscript,
  };
}
