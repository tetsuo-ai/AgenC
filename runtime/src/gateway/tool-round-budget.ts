import type { ToolRoutingDecision } from "./tool-routing.js";

export const COMPLEX_TURN_MAX_TOOL_ROUNDS = 20;

const HIGH_ITERATION_TOOL_NAMES = new Set<string>([
  "desktop.text_editor",
  "execute_with_agent",
  "system.appendFile",
  "system.writeFile",
]);

const HIGH_ITERATION_TOOL_PREFIXES = [
  "desktop.process_",
  "system.process",
  "system.sandbox",
  "system.server",
] as const;

function shouldRaiseToolRoundBudget(toolNames: readonly string[]): boolean {
  return toolNames.some(
    (name) =>
      HIGH_ITERATION_TOOL_NAMES.has(name) ||
      HIGH_ITERATION_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
}

export function resolveMaxToolRoundsForToolNames(
  defaultMaxToolRounds: number,
  toolNames: readonly string[] | undefined,
): number {
  if (!toolNames || toolNames.length === 0) {
    return defaultMaxToolRounds;
  }
  if (!shouldRaiseToolRoundBudget(toolNames)) {
    return defaultMaxToolRounds;
  }
  return Math.max(defaultMaxToolRounds, COMPLEX_TURN_MAX_TOOL_ROUNDS);
}

export function resolveTurnMaxToolRounds(
  defaultMaxToolRounds: number,
  toolRoutingDecision?: ToolRoutingDecision,
): number {
  if (!toolRoutingDecision) {
    return defaultMaxToolRounds;
  }

  const toolNames = [...new Set<string>([
    ...toolRoutingDecision.routedToolNames,
    ...toolRoutingDecision.expandedToolNames,
  ])];
  return resolveMaxToolRoundsForToolNames(defaultMaxToolRounds, toolNames);
}
