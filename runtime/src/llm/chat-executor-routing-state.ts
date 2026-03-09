/**
 * Routed-tool state helpers for ChatExecutor.
 *
 * This keeps the active/permitted tool subset logic in one place so contract
 * guidance and tool-dispatch permission checks cannot drift apart.
 *
 * @module
 */

import type { ExecutionContext } from "./chat-executor-types.js";

type ToolNameCollection = Iterable<string> | readonly string[];

function toToolNameArray(toolNames: ToolNameCollection | undefined): readonly string[] {
  if (!toolNames) return [];
  return Array.isArray(toolNames) ? toolNames : [...toolNames];
}

function normalizeToolNames(toolNames: ToolNameCollection | undefined): readonly string[] {
  const toolNameArray = toToolNameArray(toolNames);
  if (toolNameArray.length === 0) return [];
  return Array.from(
    new Set(
      toolNameArray
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  );
}

export function getAllowedToolNamesForEvidence(
  activeRoutedToolNames: readonly string[],
  allowedTools?: ToolNameCollection,
): readonly string[] {
  if (activeRoutedToolNames.length > 0) {
    return activeRoutedToolNames;
  }
  return allowedTools ? [...allowedTools] : [];
}

export function getAllowedToolNamesForContractGuidance(input: {
  readonly override?: readonly string[];
  readonly activeRoutedToolNames: readonly string[];
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
  readonly allowedTools?: ToolNameCollection;
}): readonly string[] {
  if (input.override !== undefined) return normalizeToolNames(input.override);
  if (input.allowedTools) return normalizeToolNames(input.allowedTools);

  return normalizeToolNames([
    ...input.initialRoutedToolNames,
    ...input.activeRoutedToolNames,
    ...input.expandedRoutedToolNames,
  ]);
}

export function resolveEffectiveRoutedToolNames(input: {
  readonly requestedRoutedToolNames?: readonly string[];
  readonly hasToolRouting: boolean;
  readonly activeRoutedToolNames: readonly string[];
  readonly allowedTools?: ToolNameCollection;
}): readonly string[] | undefined {
  if (input.requestedRoutedToolNames !== undefined) {
    return normalizeToolNames(input.requestedRoutedToolNames);
  }
  const activeRoutedToolNames = normalizeToolNames(input.activeRoutedToolNames);
  if (activeRoutedToolNames.length > 0) {
    return activeRoutedToolNames;
  }
  if (input.hasToolRouting) {
    return [];
  }
  return input.allowedTools ? normalizeToolNames(input.allowedTools) : undefined;
}

export function applyActiveRoutedToolNames(
  ctx: Pick<ExecutionContext, "activeRoutedToolNames">,
  routedToolNames?: readonly string[],
): readonly string[] {
  const next = normalizeToolNames(routedToolNames);
  ctx.activeRoutedToolNames = next;
  return next;
}

export function buildActiveRoutedToolSet(
  activeRoutedToolNames: readonly string[],
): Set<string> | null {
  return activeRoutedToolNames.length > 0
    ? new Set(activeRoutedToolNames)
    : null;
}
