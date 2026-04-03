import type { AgentIntent, ConcordiaActionSpec } from './types.js';

export interface ParsedStructuredResponse {
  readonly action: string;
  readonly narration: string | null;
  readonly intent: AgentIntent | null;
}

export function buildFallbackIntent(
  action: string,
  actionSpec: ConcordiaActionSpec,
): AgentIntent {
  return {
    summary: action,
    mode:
      actionSpec.tag === 'speech'
        ? 'speech'
        : actionSpec.output_type === 'choice'
          ? 'choice'
          : actionSpec.output_type === 'float'
            ? 'measurement'
            : 'action',
    destination: null,
    target_agent_ids: [],
    target_object_ids: [],
    task: null,
    inventory_add: [],
    inventory_remove: [],
    world_object_updates: [],
    relationship_updates: [],
    notes: [],
  };
}

export function parseStructuredSimulationResponse(
  response: string,
  actionSpec: ConcordiaActionSpec,
  fallbackText: string,
): ParsedStructuredResponse | null {
  const parsedJson = parseStructuredJson(response);
  if (!parsedJson) {
    return null;
  }
  return normalizeStructuredResponse(parsedJson, actionSpec, fallbackText);
}

function parseStructuredJson(response: string): unknown | null {
  const trimmed = response.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  if (!candidate.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeStructuredResponse(
  value: unknown,
  actionSpec: ConcordiaActionSpec,
  fallbackText: string,
): ParsedStructuredResponse | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const narration = asNullableString(record.narration);
  const action = sanitizeAction(asString(record.action) ?? narration ?? fallbackText);
  const intent = normalizeIntent(record.intent, actionSpec, narration ?? action);
  return { action, narration, intent };
}

function normalizeIntent(
  value: unknown,
  actionSpec: ConcordiaActionSpec,
  fallbackSummary: string,
): AgentIntent {
  const record = asRecord(value);
  if (!record) {
    return buildFallbackIntent(fallbackSummary, actionSpec);
  }

  return {
    summary: asString(record.summary) ?? fallbackSummary,
    mode: normalizeIntentMode(record.mode, actionSpec),
    destination: normalizeDestination(record.destination),
    target_agent_ids: asStringArray(record.target_agent_ids),
    target_object_ids: asStringArray(record.target_object_ids),
    task: normalizeTask(record.task),
    inventory_add: asStringArray(record.inventory_add),
    inventory_remove: asStringArray(record.inventory_remove),
    world_object_updates: normalizeWorldObjectUpdates(record.world_object_updates),
    relationship_updates: normalizeRelationshipUpdates(record.relationship_updates),
    notes: asStringArray(record.notes),
  };
}

function normalizeIntentMode(
  value: unknown,
  actionSpec: ConcordiaActionSpec,
): AgentIntent['mode'] {
  switch (value) {
    case 'action':
    case 'speech':
    case 'move':
    case 'interact':
    case 'observe':
    case 'wait':
    case 'choice':
    case 'measurement':
      return value;
    default:
      return buildFallbackIntent('', actionSpec).mode;
  }
}

function normalizeDestination(value: unknown): AgentIntent['destination'] {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    location_id: asNullableString(record.location_id),
    scene_id: asNullableString(record.scene_id),
    zone_id: asNullableString(record.zone_id),
    label: asNullableString(record.label),
  };
}

function normalizeTask(value: unknown): AgentIntent['task'] {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const title = asString(record.title);
  if (!title) {
    return null;
  }
  return {
    title,
    status: normalizeTaskStatus(record.status),
    note: asNullableString(record.note),
  };
}

function normalizeTaskStatus(
  value: unknown,
): 'pending' | 'active' | 'completed' | 'blocked' | null | undefined {
  switch (value) {
    case 'pending':
    case 'active':
    case 'completed':
    case 'blocked':
      return value;
    default:
      return null;
  }
}

function normalizeWorldObjectUpdates(
  value: unknown,
): AgentIntent['world_object_updates'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(normalizeWorldObjectUpdate);
}

function normalizeWorldObjectUpdate(entry: unknown): AgentIntent['world_object_updates'] {
  const record = asRecord(entry);
  if (!record) {
    return [];
  }
  const objectId = asString(record.object_id);
  if (!objectId) {
    return [];
  }
  return [{
    object_id: objectId,
    label: asNullableString(record.label),
    kind: asNullableString(record.kind),
    location_id: asNullableString(record.location_id),
    scene_id: asNullableString(record.scene_id),
    zone_id: asNullableString(record.zone_id),
    status: asNullableString(record.status),
    tags: asStringArray(record.tags),
  }];
}

function normalizeRelationshipUpdates(
  value: unknown,
): AgentIntent['relationship_updates'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(normalizeRelationshipUpdate);
}

function normalizeRelationshipUpdate(entry: unknown): AgentIntent['relationship_updates'] {
  const record = asRecord(entry);
  if (!record) {
    return [];
  }
  const otherAgentId = asString(record.other_agent_id);
  if (!otherAgentId) {
    return [];
  }
  return [{
    other_agent_id: otherAgentId,
    relationship: asNullableString(record.relationship),
    sentiment_delta: asFiniteNumber(record.sentiment_delta),
    note: asNullableString(record.note),
  }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

function sanitizeAction(value: string): string {
  return value.trim();
}
