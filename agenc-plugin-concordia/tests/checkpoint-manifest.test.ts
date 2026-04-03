import { describe, expect, it } from "vitest";
import {
  buildCheckpointMetadataFromManifest,
  CONCORDIA_CHECKPOINT_SCHEMA_VERSION,
  CONCORDIA_SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS,
  normalizeCheckpointManifest,
} from "../src/checkpoint-manifest.js";

describe("normalizeCheckpointManifest", () => {
  it("normalizes legacy world-scoped manifests into simulation-scoped config", () => {
    const manifest = normalizeCheckpointManifest({
      version: 1,
      world_id: "legacy-world",
      step: 2,
      config: {
        world_id: "legacy-world",
        workspace_id: "legacy-ws",
        premise: "Legacy premise",
        agents: [],
      },
    });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.simulation_id).toBe("legacy-world");
    expect(manifest.config.simulation_id).toBe("legacy-world");
    expect(manifest.config.workspace_id).toBe("legacy-ws");
    expect(manifest.config.world_id).toBe("legacy-world");
  });

  it("builds checkpoint metadata from normalized manifests without losing compatibility", () => {
    const manifest = normalizeCheckpointManifest({
      schema_version: CONCORDIA_CHECKPOINT_SCHEMA_VERSION,
      world_id: "sim-world",
      workspace_id: "sim-ws",
      simulation_id: "sim-123",
      step: 4,
      config: {
        world_id: "sim-world",
        workspace_id: "sim-ws",
        simulation_id: "sim-123",
        agents: [],
      },
    });

    const metadata = buildCheckpointMetadataFromManifest(manifest);
    expect(CONCORDIA_SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS).toContain(
      metadata.checkpointSchemaVersion,
    );
    expect(metadata.checkpointSimulationId).toBe("sim-123");
    expect(metadata.checkpointWorldId).toBe("sim-world");
  });
});
