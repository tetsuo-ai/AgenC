/**
 * Prompt builder for Concordia bridge.
 *
 * Transforms Concordia ActionSpec into user messages for the AgenC
 * ChatExecutor, with appropriate constraint instructions per output type.
 *
 * @module
 */

import type { ConcordiaActionSpec, WorldProjection } from './types.js';

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
  worldProjection?: WorldProjection | null,
): string {
  const resolvedActionSpec: ConcordiaActionSpec = {
    ...actionSpec,
    call_to_action: substituteAgentName(actionSpec.call_to_action, agentName),
  };
  switch (actionSpec.output_type) {
    case 'free':
      return buildFreePrompt(resolvedActionSpec, agentName, worldProjection);
    case 'choice':
      return buildChoicePrompt(resolvedActionSpec, agentName, worldProjection);
    case 'float':
      return buildFloatPrompt(resolvedActionSpec, worldProjection);
    default:
      return resolvedActionSpec.call_to_action;
  }
}

function buildFreePrompt(
  actionSpec: ConcordiaActionSpec,
  agentName: string,
  worldProjection?: WorldProjection | null,
): string {
  const isSpeech = actionSpec.tag === 'speech';
  const lines = [
    isSpeech ? '[Concordia Speech Request]' : '[Concordia Action Request]',
    `Agent: ${agentName}`,
    'Use the structured world projection below as authoritative state for what you can perceive right now.',
  ];

  const projectionBlock = formatProjection(worldProjection);
  if (projectionBlock) {
    lines.push('', '[World Projection]', projectionBlock);
  }

  lines.push(
    '',
    isSpeech
      ? 'Return valid JSON with the spoken words in `action` and a structured `intent` describing the speech act.'
      : 'Return valid JSON with a short visible `action`, optional `narration`, and a structured `intent` for the next move.',
    'Use this exact JSON shape:',
    '{"action":"...","narration":"...","intent":{"summary":"...","mode":"action|speech|move|interact|observe|wait","destination":{"location_id":null,"scene_id":null,"zone_id":null,"label":null},"target_agent_ids":[],"target_object_ids":[],"task":{"title":"","status":"active","note":null},"inventory_add":[],"inventory_remove":[],"world_object_updates":[],"relationship_updates":[],"notes":[]}}',
    isSpeech
      ? '`action` must contain only the words you would say next. No name prefix, no quotation marks, no stage directions.'
      : '`action` must be one immediate concrete thing you do next. No name prefix, no quotation marks, no explanation.',
    'If a field is unknown, use null or an empty array instead of inventing structure.',
    '',
    actionSpec.call_to_action,
  );

  return lines.join('\n');
}

function buildChoicePrompt(
  actionSpec: ConcordiaActionSpec,
  agentName: string,
  worldProjection?: WorldProjection | null,
): string {
  const optionsList = actionSpec.options
    .map((option, index) => `${index + 1}. ${option}`)
    .join('\n');

  const projectionBlock = formatProjection(worldProjection);
  return [
    '[Concordia Choice Request]',
    `Agent: ${agentName}`,
    projectionBlock ? 'Use the world projection below as authoritative state.' : null,
    projectionBlock ? '[World Projection]' : null,
    projectionBlock || null,
    actionSpec.call_to_action,
    '',
    'You MUST respond with EXACTLY one of these options (copy it verbatim):',
    optionsList,
    '',
    'Respond with ONLY the chosen option text. Nothing else.',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function buildFloatPrompt(
  actionSpec: ConcordiaActionSpec,
  worldProjection?: WorldProjection | null,
): string {
  const projectionBlock = formatProjection(worldProjection);
  return [
    '[Concordia Numeric Request]',
    projectionBlock ? 'Use the world projection below as authoritative state.' : null,
    projectionBlock ? '[World Projection]' : null,
    projectionBlock || null,
    actionSpec.call_to_action,
    '',
    'Respond exactly with ONLY a single number (decimal allowed). Nothing else.',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function substituteAgentName(callToAction: string, agentName: string): string {
  return callToAction.replaceAll('{name}', agentName);
}

function formatProjection(worldProjection?: WorldProjection | null): string | null {
  if (!worldProjection) {
    return null;
  }
  return JSON.stringify(worldProjection, null, 2);
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
    '',
    'Respond in character. Your actions and speech should be consistent with your personality and goals.',
    'React to observations you have received. Make decisions based on what you know.',
    'Stay entirely inside the simulated world.',
    'Do not mention tools, files, commands, prompts, APIs, the daemon, or runtime internals.',
  );
  return lines.join('\n');
}
