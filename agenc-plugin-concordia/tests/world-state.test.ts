import { describe, expect, it } from "vitest";
import {
  applyEventToWorldState,
  applyStructuredActResult,
  buildAgentStateFromWorldState,
  buildWorldProjection,
  createInitialWorldState,
} from "../src/world-state.js";

const seed = {
  simulation_id: "sim-world",
  world_id: "world-harbor",
  workspace_id: "ws-harbor",
  premise: "The harbor is opening for trade.",
  status: "running" as const,
  agents: [
    { agent_id: "alice", agent_name: "Alice", personality: "Practical", goal: "Check the shipment." },
    { agent_id: "bob", agent_name: "Bob", personality: "Observant", goal: "Watch the market." },
  ],
};

describe("world-state", () => {
  it("creates an authoritative snapshot from the seed", () => {
    const snapshot = createInitialWorldState(seed);
    expect(snapshot.simulation_id).toBe("sim-world");
    expect(snapshot.clock.phase).toBe("running");
    expect(snapshot.world_facts[0]?.content).toBe("The harbor is opening for trade.");
    expect(snapshot.agent_states.alice.agent_name).toBe("Alice");
    expect(snapshot.agent_states.bob.agent_name).toBe("Bob");
  });

  it("builds a per-agent world projection from authoritative state", () => {
    const snapshot = createInitialWorldState(seed);
    const projection = buildWorldProjection(snapshot, "alice");
    expect(projection).not.toBeNull();
    expect(projection?.self.agent_id).toBe("alice");
    expect(projection?.visible_agents.map((agent) => agent.agent_id)).toContain("bob");
  });

  it("applies structured act results to world state", () => {
    const snapshot = createInitialWorldState(seed);
    const applied = applyStructuredActResult(snapshot, {
      agentId: "alice",
      agentName: "Alice",
      action: "moves to the harbor office",
      narration: "Alice heads to the harbor office and grabs the manifest.",
      turnCount: 1,
      step: 1,
      intent: {
        summary: "Move to the harbor office and collect the manifest",
        mode: "move",
        destination: {
          location_id: "harbor-office",
          scene_id: "scene-harbor",
          zone_id: "zone-docks",
          label: "Harbor Office",
        },
        target_agent_ids: ["bob"],
        target_object_ids: ["manifest-ledger"],
        task: { title: "Check the shipment", status: "active", note: "Confirm the inventory." },
        inventory_add: ["manifest"],
        inventory_remove: [],
        world_object_updates: [
          {
            object_id: "manifest-ledger",
            label: "Manifest Ledger",
            kind: "document",
            status: "claimed",
            tags: ["paperwork"],
          },
        ],
        relationship_updates: [
          { other_agent_id: "bob", relationship: "ally", sentiment_delta: 1 },
        ],
        notes: ["Return before noon."],
      },
    });

    expect(applied.snapshot.agent_states.alice.location_id).toBe("harbor-office");
    expect(applied.snapshot.agent_states.alice.inventory).toContain("manifest");
    expect(applied.snapshot.agent_states.alice.current_task?.title).toBe("Check the shipment");
    expect(applied.snapshot.agent_states.alice.relationships[0]?.otherAgentId).toBe("bob");
    expect(applied.snapshot.world_objects["manifest-ledger"]?.status).toBe("claimed");
    expect(applied.worldEvent.summary).toBe("Alice heads to the harbor office and grabs the manifest.");
  });

  it("derives agent state from authoritative world state", () => {
    const snapshot = createInitialWorldState(seed);
    const applied = applyStructuredActResult(snapshot, {
      agentId: "alice",
      agentName: "Alice",
      action: "waits by the office",
      narration: "Alice waits by the office door.",
      turnCount: 2,
      step: 2,
      intent: {
        summary: "Wait by the office",
        mode: "wait",
        destination: {
          location_id: "office-door",
          scene_id: "scene-harbor",
          zone_id: "zone-docks",
          label: "Office Door",
        },
        target_agent_ids: [],
        target_object_ids: [],
        task: null,
        inventory_add: ["key"],
        inventory_remove: [],
        world_object_updates: [],
        relationship_updates: [],
        notes: [],
      },
    });

    const state = buildAgentStateFromWorldState(applied.snapshot, "alice", {
      identity: { name: "Alice" },
      memoryCount: 2,
      recentMemories: [],
      simulationId: "sim-world",
      lineageId: null,
      parentSimulationId: null,
    });

    expect(state?.embodiedState?.inventory).toContain("key");
    expect(state?.worldProjection?.self.location_id).toBe("office-door");
    expect(state?.turnCount).toBe(2);
  });

  it("applies replay events back into authoritative state", () => {
    const snapshot = createInitialWorldState(seed);
    const observed = applyEventToWorldState(snapshot, {
      type: "observation",
      step: 1,
      acting_agent: "alice",
      agent_name: "Alice",
      content: "Alice sees smoke near the harbor office.",
      simulation_id: "sim-world",
      world_id: "world-harbor",
      workspace_id: "ws-harbor",
    });
    expect(observed.snapshot.agent_states.alice.last_observation).toBe(
      "Alice sees smoke near the harbor office.",
    );

    const resolved = applyEventToWorldState(observed.snapshot, {
      type: "resolution",
      step: 2,
      acting_agent: "alice",
      agent_name: "Alice",
      content: "Alice checks the shipment.",
      resolved_event: "Alice confirms the shipment is intact.",
      simulation_id: "sim-world",
      world_id: "world-harbor",
      workspace_id: "ws-harbor",
      outcome: {
        summary: "Shipment confirmed",
        narration: "Alice confirms the shipment is intact.",
        succeeded: true,
        task_status: "completed",
        scene_id: "scene-harbor",
        zone_id: "zone-docks",
        location_id: "location:start",
        metadata: null,
      },
    });

    expect(resolved.snapshot.agent_states.alice.last_outcome?.task_status).toBe("completed");
    expect(resolved.snapshot.recent_events).toHaveLength(2);
  });
});
