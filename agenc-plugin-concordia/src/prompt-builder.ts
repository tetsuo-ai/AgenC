/**
 * Prompt builder for Concordia bridge.
 *
 * Transforms Concordia ActionSpec into user messages for the AgenC
 * ChatExecutor, with appropriate constraint instructions per output type.
 *
 * @module
 */

import type { ConcordiaActionSpec } from "./types.js";

/**
 * Build the user message from a Concordia ActionSpec.
 *
 * The ChatExecutor receives this as the user's message. The system prompt
 * (including agent identity, memory context, knowledge graph) is handled
 * by the daemon's existing injection pipeline.
 */
export function buildActPrompt(
  actionSpec: ConcordiaActionSpec,
  agentName: string,
): string {
  switch (actionSpec.output_type) {
    case "free":
      return buildFreePrompt(actionSpec, agentName);
    case "choice":
      return buildChoicePrompt(actionSpec, agentName);
    case "float":
      return buildFloatPrompt(actionSpec);
    default:
      return actionSpec.call_to_action;
  }
}

function buildFreePrompt(
  actionSpec: ConcordiaActionSpec,
  agentName: string,
): string {
  const isSpeech = actionSpec.tag === "speech";

  if (isSpeech) {
    return [
      "[Simulation Context]",
      actionSpec.call_to_action,
      "",
      `Respond in character as ${agentName}. Use natural dialogue.`,
      "Do not include your name prefix or quotation marks.",
      "Respond with ONLY what you would say. Nothing else.",
    ].join("\n");
  }

  return [
    "[Simulation Context]",
    actionSpec.call_to_action,
    "",
    "Respond with ONLY your action. Do not include your name prefix.",
    "Do not include quotation marks around your response.",
    "Be specific and concrete about what you do.",
  ].join("\n");
}

function buildChoicePrompt(
  actionSpec: ConcordiaActionSpec,
  _agentName: string,
): string {
  const optionsList = actionSpec.options
    .map((o, i) => `${i + 1}. ${o}`)
    .join("\n");

  return [
    "[Simulation Context]",
    actionSpec.call_to_action,
    "",
    "You MUST respond with EXACTLY one of these options (copy it verbatim):",
    optionsList,
    "",
    "Respond with ONLY the chosen option text. Nothing else.",
  ].join("\n");
}

function buildFloatPrompt(actionSpec: ConcordiaActionSpec): string {
  return [
    "[Simulation Context]",
    actionSpec.call_to_action,
    "",
    "Respond with ONLY a single number (decimal allowed). Nothing else.",
  ].join("\n");
}

/**
 * Build a system-level context prefix for simulation awareness.
 * This is prepended to the agent's system prompt by the bridge.
 */
export function buildSimulationSystemContext(params: {
  worldId: string;
  agentName: string;
  turnCount: number;
  premise?: string;
}): string {
  const lines = [
    `[Concordia Simulation: ${params.worldId}]`,
    `You are ${params.agentName} in a social simulation.`,
    `Current turn: ${params.turnCount}`,
  ];
  if (params.premise) {
    lines.push(`Premise: ${params.premise}`);
  }
  lines.push(
    "",
    "Respond in character. Your actions and speech should be consistent with your personality and goals.",
    "React to observations you have received. Make decisions based on what you know.",
  );
  return lines.join("\n");
}
