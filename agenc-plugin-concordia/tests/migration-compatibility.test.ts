import { describe, expect, it } from "vitest";
import {
  buildConcordiaMigrationStatus,
  COMPAT_SHIM_LEGACY_AGENT_STATE,
  COMPAT_SHIM_LEGACY_LAUNCH,
  COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
  COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
  CONCORDIA_MEMORY_RESOLVER_CONTRACT_VERSION,
  CONCORDIA_REPLAY_SCHEMA_VERSION,
  CONCORDIA_REQUEST_RESPONSE_SCHEMA_VERSION,
} from "../src/migration-compatibility.js";

describe("buildConcordiaMigrationStatus", () => {
  it("reports the current schema contracts, shims, and rollback points", () => {
    const status = buildConcordiaMigrationStatus(1234);

    expect(status.generated_at).toBe(1234);
    expect(status.request_response_schema.current_version).toBe(
      CONCORDIA_REQUEST_RESPONSE_SCHEMA_VERSION,
    );
    expect(status.replay_schema.current_version).toBe(
      CONCORDIA_REPLAY_SCHEMA_VERSION,
    );
    expect(status.memory_resolver_contract.current_version).toBe(
      CONCORDIA_MEMORY_RESOLVER_CONTRACT_VERSION,
    );
    expect(status.compatibility_shims.map((shim) => shim.shim_id)).toEqual([
      COMPAT_SHIM_LEGACY_LAUNCH,
      COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
      COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
      COMPAT_SHIM_LEGACY_AGENT_STATE,
    ]);
    expect(status.rollback_points.map((point) => point.rollback_id)).toContain(
      "checkpoint-manifest-v3",
    );
    expect(status.aligned_documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "TODO.MD", status: "authoritative" }),
        expect.objectContaining({ path: "CONCORDIA_TODO.MD", status: "historical-with-banner" }),
      ]),
    );
  });
});
