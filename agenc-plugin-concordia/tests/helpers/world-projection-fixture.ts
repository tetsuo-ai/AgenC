import type { SimulationWorldStateResponse, WorldProjection } from "../../src/types.js";

export function createSampleWorldProjection(): WorldProjection {
  return {
    simulation_id: "sim-running",
    world_id: "world-alpha",
    workspace_id: "ws-alpha",
    agent_id: "alice",
    premise: "The forge is busy at sunrise.",
    clock: { tick: 3, step: 2, phase: "running", updated_at: 10 },
    self: {
      agent_id: "alice",
      agent_name: "Alice",
      location_id: "forge",
      scene_id: "scene-forge",
      zone_id: "zone-market",
      nearby_agent_ids: ["bob"],
      inventory: ["hammer"],
      world_object_ids: ["anvil"],
      relationships: [],
      schedule: [],
      current_task: null,
      last_observation: "Sparks fly from the forge.",
      last_action: "inspects the anvil",
      last_intent: null,
      last_outcome: null,
      turn_count: 2,
      metadata: null,
    },
    active_scene_id: "scene-forge",
    active_zone_id: "zone-market",
    active_location_id: "forge",
    visible_agents: [
      {
        agent_id: "bob",
        agent_name: "Bob",
        location_id: "forge",
        scene_id: "scene-forge",
        zone_id: "zone-market",
        nearby_agent_ids: ["alice"],
        inventory: [],
        world_object_ids: [],
        relationships: [],
        schedule: [],
        current_task: null,
        last_observation: null,
        last_action: null,
        last_intent: null,
        last_outcome: null,
        turn_count: 1,
        metadata: null,
      },
    ],
    visible_objects: [
      {
        object_id: "anvil",
        label: "Forge Anvil",
        kind: "tool",
        location_id: "forge",
        scene_id: "scene-forge",
        zone_id: "zone-market",
        status: "ready",
        tags: ["metalwork"],
        metadata: null,
      },
    ],
    world_facts: [
      { content: "The forge opens at dawn.", observedBy: "system", confirmations: 1 },
    ],
    recent_events: [],
  };
}

export function createSampleSimulationWorldState(): SimulationWorldStateResponse {
  const projection = createSampleWorldProjection();

  return {
    simulation_id: "sim-running",
    world_id: "world-alpha",
    workspace_id: "ws-alpha",
    lineage_id: null,
    parent_simulation_id: null,
    premise: projection.premise,
    clock: projection.clock,
    active_scene_id: projection.active_scene_id,
    active_zone_id: projection.active_zone_id,
    active_location_id: projection.active_location_id,
    agent_states: {
      alice: projection.self!,
    },
    world_objects: {
      anvil: projection.visible_objects[0],
    },
    world_facts: projection.world_facts,
    recent_events: [],
    updated_at: 10,
    snapshot_ref: "sim-running:world:2:10",
  };
}
