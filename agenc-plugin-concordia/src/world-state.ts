import type {
  AgentIntent,
  AgentOutcome,
  AgentSetupConfig,
  AgentStateResponse,
  EmbodiedAgentState,
  EventNotification,
  RelationshipSummary,
  SimulationLifecycleStatus,
  WorldCoordinate,
  WorldEvent,
  WorldFactSummary,
  WorldObjectState,
  WorldProjection,
  WorldStateSnapshot,
  WorldTask,
} from "./types.js";

const RECENT_WORLD_EVENT_LIMIT = 100;
const DEFAULT_SCENE_ID = "scene:start";
const DEFAULT_ZONE_ID = "zone:start";
const DEFAULT_LOCATION_ID = "location:start";

type MutableWorldStateSnapshot = {
  -readonly [K in keyof WorldStateSnapshot]: WorldStateSnapshot[K];
};

export interface WorldStateSeed {
  readonly simulation_id: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly premise: string;
  readonly agents: readonly AgentSetupConfig[];
  readonly status?: SimulationLifecycleStatus;
  readonly initial_scene_id?: string | null;
  readonly initial_scene_name?: string | null;
  readonly initial_zone_id?: string | null;
  readonly initial_location_id?: string | null;
  readonly initial_time_of_day?: string | null;
  readonly initial_day_index?: number | null;
}

export interface StructuredActResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly action: string;
  readonly narration?: string | null;
  readonly intent?: AgentIntent | null;
  readonly turnCount?: number;
  readonly step?: number;
}

export interface AgentStateWorldExtras {
  readonly identity: AgentStateResponse["identity"];
  readonly memoryCount: number;
  readonly recentMemories: AgentStateResponse["recentMemories"];
  readonly simulationId?: string;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function cloneRelationshipSummary(
  relationship: RelationshipSummary,
): RelationshipSummary {
  return { ...relationship };
}

function cloneTask(task: WorldTask): WorldTask {
  return { ...task };
}

function cloneAgentState(agentState: EmbodiedAgentState): EmbodiedAgentState {
  return {
    ...agentState,
    nearby_agent_ids: [...agentState.nearby_agent_ids],
    inventory: [...agentState.inventory],
    world_object_ids: [...agentState.world_object_ids],
    relationships: agentState.relationships.map(cloneRelationshipSummary),
    schedule: agentState.schedule.map(cloneTask),
    current_task: agentState.current_task ? cloneTask(agentState.current_task) : null,
    last_intent: agentState.last_intent ? { ...agentState.last_intent } : null,
    last_outcome: agentState.last_outcome ? { ...agentState.last_outcome } : null,
    metadata: agentState.metadata ? { ...agentState.metadata } : null,
  };
}

function cloneWorldObject(worldObject: WorldObjectState): WorldObjectState {
  return {
    ...worldObject,
    tags: [...worldObject.tags],
    metadata: worldObject.metadata ? { ...worldObject.metadata } : null,
  };
}

function cloneWorldFact(worldFact: WorldFactSummary): WorldFactSummary {
  return { ...worldFact };
}

function cloneWorldEvent(event: WorldEvent): WorldEvent {
  return {
    ...event,
    intent: event.intent ? { ...event.intent } : null,
    outcome: event.outcome ? { ...event.outcome } : null,
    metadata: event.metadata ? { ...event.metadata } : null,
  };
}

function cloneSnapshot(snapshot: WorldStateSnapshot): WorldStateSnapshot {
  return {
    ...snapshot,
    clock: { ...snapshot.clock },
    agent_states: Object.fromEntries(
      Object.entries(snapshot.agent_states).map(([agentId, state]) => [agentId, cloneAgentState(state)]),
    ),
    world_objects: Object.fromEntries(
      Object.entries(snapshot.world_objects).map(([objectId, worldObject]) => [objectId, cloneWorldObject(worldObject)]),
    ),
    world_facts: snapshot.world_facts.map(cloneWorldFact),
    recent_events: snapshot.recent_events.map(cloneWorldEvent),
  };
}

function buildGoalTask(
  agent: AgentSetupConfig,
  coordinate: {
    readonly scene_id: string;
    readonly zone_id: string;
    readonly location_id: string;
  },
): WorldTask | null {
  if (!agent.goal?.trim()) {
    return null;
  }
  return {
    task_id: `${agent.agent_id}:goal`,
    title: agent.goal.trim(),
    status: "active",
    assigned_agent_id: agent.agent_id,
    description: agent.goal.trim(),
    scene_id: coordinate.scene_id,
    zone_id: coordinate.zone_id,
    location_id: coordinate.location_id,
  };
}

function buildInitialCoordinate(seed: WorldStateSeed): {
  scene_id: string;
  zone_id: string;
  location_id: string;
} {
  return {
    scene_id: seed.initial_scene_id ?? DEFAULT_SCENE_ID,
    zone_id: seed.initial_zone_id ?? DEFAULT_ZONE_ID,
    location_id: seed.initial_location_id ?? DEFAULT_LOCATION_ID,
  };
}

function buildInitialAgentState(
  agent: AgentSetupConfig,
  coordinate: {
    readonly scene_id: string;
    readonly zone_id: string;
    readonly location_id: string;
  },
): EmbodiedAgentState {
  const task = buildGoalTask(agent, coordinate);
  return {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    location_id: coordinate.location_id,
    scene_id: coordinate.scene_id,
    zone_id: coordinate.zone_id,
    nearby_agent_ids: [],
    inventory: [],
    world_object_ids: [],
    relationships: [],
    schedule: task ? [task] : [],
    current_task: task,
    last_observation: null,
    last_action: null,
    last_intent: null,
    last_outcome: null,
    turn_count: 0,
    metadata: {
      personality: agent.personality,
      goal: agent.goal ?? "",
    },
  };
}

function buildInitialWorldFacts(seed: WorldStateSeed): readonly WorldFactSummary[] {
  if (!seed.premise.trim()) {
    return [];
  }
  return [{
    content: seed.premise.trim(),
    observedBy: "system",
    confirmations: 1,
  }];
}

function defaultStatus(seed: WorldStateSeed): SimulationLifecycleStatus {
  return seed.status ?? "launching";
}

function buildSnapshotRef(snapshot: {
  readonly simulation_id: string;
  readonly updated_at: number;
  readonly clock: { readonly step: number };
}): string {
  return `${snapshot.simulation_id}:world:${snapshot.clock.step}:${snapshot.updated_at}`;
}

function recalculateNearbyAgents(
  agentStates: Record<string, EmbodiedAgentState>,
): Record<string, EmbodiedAgentState> {
  const nextStates: Record<string, EmbodiedAgentState> = {};
  for (const [agentId, agentState] of Object.entries(agentStates)) {
    const nearby = Object.values(agentStates)
      .filter((other) => (
        other.agent_id !== agentId &&
        other.location_id === agentState.location_id &&
        other.scene_id === agentState.scene_id &&
        other.zone_id === agentState.zone_id
      ))
      .map((other) => other.agent_id)
      .sort();
    nextStates[agentId] = {
      ...agentState,
      nearby_agent_ids: nearby,
    };
  }
  return nextStates;
}

function normalizeCoordinate(
  destination: AgentIntent["destination"],
  fallback: EmbodiedAgentState,
): WorldCoordinate {
  return {
    location_id: destination?.location_id ?? fallback.location_id,
    scene_id: destination?.scene_id ?? fallback.scene_id,
    zone_id: destination?.zone_id ?? fallback.zone_id,
    label: destination?.label ?? null,
  };
}

function mergeRelationships(
  current: readonly RelationshipSummary[],
  intent: AgentIntent,
): readonly RelationshipSummary[] {
  const relationships = new Map<string, RelationshipSummary>(
    current.map((relationship) => [relationship.otherAgentId, { ...relationship }]),
  );

  for (const targetAgentId of intent.target_agent_ids) {
    const existing = relationships.get(targetAgentId);
    relationships.set(targetAgentId, {
      otherAgentId: targetAgentId,
      relationship: existing?.relationship ?? "engaged",
      sentiment: existing?.sentiment ?? 0,
      interactionCount: (existing?.interactionCount ?? 0) + 1,
    });
  }

  for (const update of intent.relationship_updates) {
    const existing = relationships.get(update.other_agent_id);
    relationships.set(update.other_agent_id, {
      otherAgentId: update.other_agent_id,
      relationship: update.relationship ?? existing?.relationship ?? "observing",
      sentiment: (existing?.sentiment ?? 0) + (update.sentiment_delta ?? 0),
      interactionCount: existing?.interactionCount ?? (intent.target_agent_ids.includes(update.other_agent_id) ? 1 : 0),
    });
  }

  return [...relationships.values()].sort((left, right) => left.otherAgentId.localeCompare(right.otherAgentId));
}

function updateWorldObjects(
  worldObjects: Record<string, WorldObjectState>,
  agentIntent: AgentIntent,
  coordinate: WorldCoordinate,
): Record<string, WorldObjectState> {
  const nextObjects = { ...worldObjects };
  for (const update of agentIntent.world_object_updates) {
    const existing = nextObjects[update.object_id];
    nextObjects[update.object_id] = {
      object_id: update.object_id,
      label: update.label ?? existing?.label ?? update.object_id,
      kind: update.kind ?? existing?.kind ?? "world-object",
      location_id: update.location_id ?? existing?.location_id ?? coordinate.location_id,
      scene_id: update.scene_id ?? existing?.scene_id ?? coordinate.scene_id,
      zone_id: update.zone_id ?? existing?.zone_id ?? coordinate.zone_id,
      status: update.status ?? existing?.status ?? null,
      tags: update.tags ? [...update.tags] : existing?.tags ?? [],
      metadata: existing?.metadata ? { ...existing.metadata } : null,
    };
  }
  return nextObjects;
}

function updateSchedule(
  agentState: EmbodiedAgentState,
  intent: AgentIntent,
  coordinate: WorldCoordinate,
): { schedule: readonly WorldTask[]; currentTask: WorldTask | null } {
  if (!intent.task?.title?.trim()) {
    return {
      schedule: agentState.schedule.map(cloneTask),
      currentTask: agentState.current_task ? cloneTask(agentState.current_task) : null,
    };
  }

  const taskId = `${agentState.agent_id}:${slugify(intent.task.title)}`;
  const task: WorldTask = {
    task_id: taskId,
    title: intent.task.title.trim(),
    status: intent.task.status ?? "active",
    assigned_agent_id: agentState.agent_id,
    description: intent.task.note ?? null,
    scene_id: coordinate.scene_id,
    zone_id: coordinate.zone_id,
    location_id: coordinate.location_id,
  };

  const nextSchedule = [
    ...agentState.schedule.filter((entry) => entry.task_id !== taskId).map(cloneTask),
    task,
  ];

  return {
    schedule: nextSchedule,
    currentTask: task,
  };
}

function buildWorldEventFromIntent(params: {
  readonly simulationId: string;
  readonly step: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly action: string;
  readonly narration?: string | null;
  readonly intent?: AgentIntent | null;
  readonly coordinate: WorldCoordinate;
}): WorldEvent {
  return {
    type: "action",
    step: params.step,
    timestamp: Date.now(),
    summary: params.narration?.trim() || params.action.trim(),
    agent_id: params.agentId,
    agent_name: params.agentName,
    scene_id: params.coordinate.scene_id,
    zone_id: params.coordinate.zone_id,
    location_id: params.coordinate.location_id,
    intent: params.intent ?? null,
    metadata: {
      source: "structured_act_response",
      simulation_id: params.simulationId,
    },
  };
}

function normalizeStep(event: EventNotification, snapshot: WorldStateSnapshot): number {
  return Number.isFinite(event.step) ? event.step : snapshot.clock.step;
}

function normalizedEventMetadata(event: EventNotification): Record<string, unknown> {
  return event.metadata ? { ...event.metadata } : {};
}

function applySceneMetadata(
  snapshot: MutableWorldStateSnapshot,
  metadata: Record<string, unknown>,
  fallbackScene?: string | null,
): void {
  const sceneName = typeof metadata.scene_name === "string"
    ? metadata.scene_name
    : fallbackScene ?? snapshot.clock.scene_name ?? null;
  const sceneId = typeof metadata.scene_id === "string"
    ? metadata.scene_id
    : fallbackScene
      ? slugify(fallbackScene)
      : snapshot.active_scene_id;
  const zoneId = typeof metadata.zone_id === "string"
    ? metadata.zone_id
    : sceneId ?? snapshot.active_zone_id;
  const locationId = typeof metadata.location_id === "string"
    ? metadata.location_id
    : zoneId
      ? `${zoneId}:center`
      : snapshot.active_location_id;
  const timeOfDay = typeof metadata.time_of_day === "string"
    ? metadata.time_of_day
    : snapshot.clock.time_of_day ?? null;
  const dayIndex = typeof metadata.day_index === "number" && Number.isFinite(metadata.day_index)
    ? metadata.day_index
    : snapshot.clock.day_index ?? null;

  snapshot.active_scene_id = sceneId ?? snapshot.active_scene_id;
  snapshot.active_zone_id = zoneId ?? snapshot.active_zone_id;
  snapshot.active_location_id = locationId ?? snapshot.active_location_id;
  snapshot.clock = {
    ...snapshot.clock,
    scene_name: sceneName,
    time_of_day: timeOfDay,
    day_index: dayIndex,
  };
}

function mergeWorldFactsFromEvent(
  current: readonly WorldFactSummary[],
  summary: string,
): readonly WorldFactSummary[] {
  const trimmed = summary.trim();
  if (!trimmed) {
    return current.map(cloneWorldFact);
  }
  const existing = current.find((fact) => fact.content === trimmed);
  const nextFact: WorldFactSummary = existing
    ? {
        ...existing,
        confirmations: existing.confirmations + 1,
      }
    : {
        content: trimmed,
        observedBy: "system",
        confirmations: 1,
      };

  const remainder = current.filter((fact) => fact.content !== trimmed).map(cloneWorldFact);
  return [nextFact, ...remainder];
}

function pushRecentEvent(snapshot: WorldStateSnapshot, event: WorldEvent): readonly WorldEvent[] {
  return [...snapshot.recent_events, event].slice(-RECENT_WORLD_EVENT_LIMIT);
}

export function createInitialWorldState(seed: WorldStateSeed): WorldStateSnapshot {
  const now = Date.now();
  const coordinate = buildInitialCoordinate(seed);
  const agentStates = Object.fromEntries(
    seed.agents.map((agent) => [agent.agent_id, buildInitialAgentState(agent, coordinate)]),
  ) as Record<string, EmbodiedAgentState>;
  const snapshot: WorldStateSnapshot = {
    simulation_id: seed.simulation_id,
    world_id: seed.world_id,
    workspace_id: seed.workspace_id,
    lineage_id: seed.lineage_id ?? null,
    parent_simulation_id: seed.parent_simulation_id ?? null,
    premise: seed.premise,
    clock: {
      tick: 0,
      step: 0,
      phase: defaultStatus(seed),
      updated_at: now,
      scene_name: seed.initial_scene_name ?? null,
      time_of_day: seed.initial_time_of_day ?? null,
      day_index: seed.initial_day_index ?? null,
    },
    active_scene_id: coordinate.scene_id,
    active_zone_id: coordinate.zone_id,
    active_location_id: coordinate.location_id,
    agent_states: recalculateNearbyAgents(agentStates),
    world_objects: {},
    world_facts: buildInitialWorldFacts(seed),
    recent_events: [],
    updated_at: now,
    snapshot_ref: "",
  };

  return {
    ...snapshot,
    snapshot_ref: buildSnapshotRef(snapshot),
  };
}

export function reconcileWorldStateSnapshot(
  current: WorldStateSnapshot | null | undefined,
  seed: WorldStateSeed,
): WorldStateSnapshot {
  if (!current) {
    return createInitialWorldState(seed);
  }

  const next = cloneSnapshot(current) as MutableWorldStateSnapshot;
  next.world_id = seed.world_id;
  next.workspace_id = seed.workspace_id;
  next.lineage_id = seed.lineage_id ?? null;
  next.parent_simulation_id = seed.parent_simulation_id ?? null;
  next.premise = seed.premise;
  next.clock = {
    ...next.clock,
    phase: defaultStatus(seed),
    updated_at: Date.now(),
    scene_name: seed.initial_scene_name ?? next.clock.scene_name ?? null,
    time_of_day: seed.initial_time_of_day ?? next.clock.time_of_day ?? null,
    day_index: seed.initial_day_index ?? next.clock.day_index ?? null,
  };
  next.active_scene_id = seed.initial_scene_id ?? next.active_scene_id;
  next.active_zone_id = seed.initial_zone_id ?? next.active_zone_id;
  next.active_location_id = seed.initial_location_id ?? next.active_location_id;

  const existingAgentStates = next.agent_states;
  const coordinate = buildInitialCoordinate(seed);
  const mergedAgentStates: Record<string, EmbodiedAgentState> = {};
  for (const agent of seed.agents) {
    const existing = existingAgentStates[agent.agent_id];
    mergedAgentStates[agent.agent_id] = existing
      ? {
          ...existing,
          agent_name: agent.agent_name,
          metadata: {
            ...(existing.metadata ?? {}),
            personality: agent.personality,
            goal: agent.goal ?? "",
          },
        }
      : buildInitialAgentState(agent, coordinate);
  }

  next.agent_states = recalculateNearbyAgents(mergedAgentStates);
  next.world_facts = seed.premise.trim()
    ? [
        { content: seed.premise.trim(), observedBy: "system", confirmations: 1 },
        ...next.world_facts.filter((fact) => fact.content !== seed.premise.trim()),
      ]
    : next.world_facts.map(cloneWorldFact);
  next.updated_at = Date.now();
  next.snapshot_ref = buildSnapshotRef(next);
  return next;
}

export function buildWorldProjection(
  snapshot: WorldStateSnapshot,
  agentId: string,
): WorldProjection | null {
  const self = snapshot.agent_states[agentId] ?? null;
  if (!self) {
    return null;
  }

  const visibleAgents = Object.values(snapshot.agent_states)
    .filter((candidate) => (
      candidate.agent_id !== agentId &&
      candidate.location_id === self.location_id &&
      candidate.scene_id === self.scene_id &&
      candidate.zone_id === self.zone_id
    ))
    .map(cloneAgentState);

  const visibleObjects = Object.values(snapshot.world_objects)
    .filter((worldObject) => (
      worldObject.location_id === self.location_id &&
      worldObject.scene_id === self.scene_id &&
      worldObject.zone_id === self.zone_id
    ))
    .map(cloneWorldObject);

  return {
    simulation_id: snapshot.simulation_id,
    world_id: snapshot.world_id,
    workspace_id: snapshot.workspace_id,
    agent_id: agentId,
    clock: { ...snapshot.clock },
    premise: snapshot.premise,
    self: cloneAgentState(self),
    active_scene_id: snapshot.active_scene_id,
    active_zone_id: snapshot.active_zone_id,
    active_location_id: snapshot.active_location_id,
    visible_agents: visibleAgents,
    visible_objects: visibleObjects,
    world_facts: snapshot.world_facts.map(cloneWorldFact),
    recent_events: snapshot.recent_events.map(cloneWorldEvent),
  };
}

export function buildAgentStateFromWorldState(
  snapshot: WorldStateSnapshot,
  agentId: string,
  extras: AgentStateWorldExtras,
): AgentStateResponse | null {
  const embodiedState = snapshot.agent_states[agentId] ?? null;
  if (!embodiedState) {
    return null;
  }

  return {
    simulationId: extras.simulationId ?? snapshot.simulation_id,
    lineageId: extras.lineageId ?? snapshot.lineage_id ?? null,
    parentSimulationId: extras.parentSimulationId ?? snapshot.parent_simulation_id ?? null,
    identity: extras.identity,
    memoryCount: extras.memoryCount,
    recentMemories: extras.recentMemories,
    relationships: embodiedState.relationships.map(cloneRelationshipSummary),
    worldFacts: snapshot.world_facts.map(cloneWorldFact),
    turnCount: embodiedState.turn_count,
    lastAction: embodiedState.last_action,
    embodiedState: cloneAgentState(embodiedState),
    worldProjection: buildWorldProjection(snapshot, agentId),
  };
}

export function applyStructuredActResult(
  snapshot: WorldStateSnapshot,
  result: StructuredActResult,
): {
  snapshot: WorldStateSnapshot;
  worldEvent: WorldEvent;
} {
  const next = cloneSnapshot(snapshot) as MutableWorldStateSnapshot;
  const existing = next.agent_states[result.agentId] ?? {
    agent_id: result.agentId,
    agent_name: result.agentName,
    location_id: next.active_location_id,
    scene_id: next.active_scene_id,
    zone_id: next.active_zone_id,
    nearby_agent_ids: [],
    inventory: [],
    world_object_ids: [],
    relationships: [],
    schedule: [],
    current_task: null,
    last_observation: null,
    last_action: null,
    last_intent: null,
    last_outcome: null,
    turn_count: 0,
    metadata: null,
  };

  const normalizedIntent = result.intent ?? {
    summary: result.narration?.trim() || result.action.trim(),
    mode: "action",
    destination: null,
    target_agent_ids: [],
    target_object_ids: [],
    task: null,
    inventory_add: [],
    inventory_remove: [],
    world_object_updates: [],
    relationship_updates: [],
    notes: [],
  } satisfies AgentIntent;

  const coordinate = normalizeCoordinate(normalizedIntent.destination, existing);
  const inventory = existing.inventory
    .filter((item) => !normalizedIntent.inventory_remove.includes(item));
  for (const item of normalizedIntent.inventory_add) {
    if (!inventory.includes(item)) {
      inventory.push(item);
    }
  }

  const { schedule, currentTask } = updateSchedule(existing, normalizedIntent, coordinate);
  const updatedRelationships = mergeRelationships(
    existing.relationships,
    normalizedIntent,
  );

  const updatedAgentState: EmbodiedAgentState = {
    ...existing,
    agent_name: result.agentName,
    location_id: coordinate.location_id,
    scene_id: coordinate.scene_id,
    zone_id: coordinate.zone_id,
    inventory,
    relationships: updatedRelationships,
    schedule,
    current_task: currentTask,
    last_action: result.action,
    last_intent: normalizedIntent,
    last_outcome: null,
    turn_count: result.turnCount ?? existing.turn_count,
  };

  next.agent_states = recalculateNearbyAgents({
    ...next.agent_states,
    [result.agentId]: updatedAgentState,
  });
  next.world_objects = updateWorldObjects(next.world_objects, normalizedIntent, coordinate);
  next.active_scene_id = coordinate.scene_id;
  next.active_zone_id = coordinate.zone_id;
  next.active_location_id = coordinate.location_id;
  next.updated_at = Date.now();
  next.snapshot_ref = buildSnapshotRef(next);

  const worldEvent = buildWorldEventFromIntent({
    simulationId: next.simulation_id,
    step: result.step ?? next.clock.step,
    agentId: result.agentId,
    agentName: result.agentName,
    action: result.action,
    narration: result.narration,
    intent: normalizedIntent,
    coordinate,
  });

  return { snapshot: next, worldEvent };
}

function applyOutcomeToAgentState(
  agentState: EmbodiedAgentState,
  outcome: AgentOutcome,
): EmbodiedAgentState {
  const currentTask = agentState.current_task && outcome.task_status
    ? { ...agentState.current_task, status: outcome.task_status }
    : agentState.current_task;

  return {
    ...agentState,
    current_task: currentTask,
    schedule: currentTask
      ? agentState.schedule.map((task) => task.task_id === currentTask.task_id ? currentTask : task)
      : agentState.schedule.map(cloneTask),
    last_outcome: outcome,
  };
}

export function applyEventToWorldState(
  snapshot: WorldStateSnapshot,
  event: EventNotification,
): {
  snapshot: WorldStateSnapshot;
  worldEvent: WorldEvent;
} {
  const next = cloneSnapshot(snapshot) as MutableWorldStateSnapshot;
  const step = normalizeStep(event, snapshot);
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  const actingAgentId = event.acting_agent ?? event.agent_name ?? null;
  const summary = (event.resolved_event ?? event.content ?? event.type).trim() || event.type;
  const metadata = normalizedEventMetadata(event);

  next.clock = {
    tick: next.clock.tick + 1,
    step: Math.max(next.clock.step, step),
    phase: next.clock.phase,
    updated_at: Date.now(),
    scene_name: next.clock.scene_name ?? null,
    time_of_day: next.clock.time_of_day ?? null,
    day_index: next.clock.day_index ?? null,
  };

  if (event.scene || metadata.scene_id || metadata.scene_name) {
    applySceneMetadata(next, metadata, event.scene ?? null);
  }

  if (event.type === "step") {
    next.clock = {
      ...next.clock,
      step: Math.max(next.clock.step, step),
    };
  }

  if (event.type === "observation" && actingAgentId && next.agent_states[actingAgentId]) {
    next.agent_states = {
      ...next.agent_states,
      [actingAgentId]: {
        ...next.agent_states[actingAgentId],
        last_observation: event.content ?? next.agent_states[actingAgentId].last_observation,
      },
    };
  }

  if (event.type === "terminate") {
    next.clock = {
      ...next.clock,
      phase: "finished",
    };
  }

  const resolutionOutcome = event.type === "resolution" && actingAgentId && next.agent_states[actingAgentId]
    ? event.outcome ?? {
        summary,
        narration: event.resolved_event ?? event.content ?? null,
        succeeded: true,
        scene_id: next.active_scene_id,
        zone_id: next.active_zone_id,
        location_id: next.active_location_id,
        metadata,
      }
    : event.outcome ?? null;

  if (resolutionOutcome && actingAgentId && next.agent_states[actingAgentId]) {
    next.agent_states = {
      ...next.agent_states,
      [actingAgentId]: applyOutcomeToAgentState(next.agent_states[actingAgentId], resolutionOutcome),
    };
  }

  const worldEvent: WorldEvent = {
    event_id: undefined,
    type: event.type,
    step,
    timestamp,
    summary,
    agent_id: actingAgentId,
    agent_name: event.agent_name ?? actingAgentId ?? null,
    scene_id: next.active_scene_id,
    zone_id: next.active_zone_id,
    location_id: next.active_location_id,
    intent: event.intent ?? null,
    outcome: resolutionOutcome,
    metadata,
  };

  if (event.type === "scene_change" || event.type === "world_event") {
    next.world_facts = mergeWorldFactsFromEvent(next.world_facts, summary);
  }

  next.agent_states = recalculateNearbyAgents(next.agent_states);
  next.updated_at = Date.now();
  next.snapshot_ref = buildSnapshotRef(next);
  next.recent_events = pushRecentEvent(next, worldEvent);
  return { snapshot: next, worldEvent };
}
