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
  const resolvedActionSpec: ConcordiaActionSpec = {
    ...actionSpec,
    call_to_action: substituteAgentName(actionSpec.call_to_action, agentName),
  };
  switch (actionSpec.output_type) {
    case "free":
      return buildFreePrompt(resolvedActionSpec, agentName);
    case "choice":
      return buildChoicePrompt(resolvedActionSpec, agentName);
    case "float":
      return buildFloatPrompt(resolvedActionSpec);
    default:
      return resolvedActionSpec.call_to_action;
  }
}

function buildFreePrompt(
  actionSpec: ConcordiaActionSpec,
  agentName: string,
): string {
  const isSpeech = actionSpec.tag === "speech";

  if (isSpeech) {
    return [
      "[Concordia Speech Request]",
      `Agent: ${agentName}`,
      `Speak in character as ${agentName}.`,
      "Reply with only the words you would say next.",
      "Do not include your name prefix, stage directions, or quotation marks.",
      "",
      actionSpec.call_to_action,
    ].join("\n");
  }

  return [
    "[Concordia Action Request]",
    `Agent: ${agentName}`,
    "Reply with one short plain-text description of your immediate next action.",
    "Be specific and concrete.",
    "Do not include your name, quotation marks, or any explanation.",
    "",
    actionSpec.call_to_action,
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
    "[Concordia Choice Request]",
    `Agent: ${_agentName}`,
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
    "[Concordia Numeric Request]",
    actionSpec.call_to_action,
    "",
    "Respond exactly with ONLY a single number (decimal allowed). Nothing else.",
  ].join("\n");
}

function substituteAgentName(callToAction: string, agentName: string): string {
  return callToAction.replaceAll("{name}", agentName);
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
    "Stay entirely inside the simulated world.",
    "Do not mention tools, files, commands, prompts, APIs, the daemon, or runtime internals.",
  );
  return lines.join("\n");
}
