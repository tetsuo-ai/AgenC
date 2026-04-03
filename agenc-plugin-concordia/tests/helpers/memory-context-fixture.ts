import type { MemoryWiringContext } from "../../src/memory-wiring.js";
import { buildConcordiaMemoryNamespaces } from "../../src/memory-namespaces.js";

export function buildTestMemoryContextSeed(
  overrides?: Partial<MemoryWiringContext>,
) {
  const worldId = overrides?.worldId ?? "test-world";
  const workspaceId = overrides?.workspaceId ?? "test-ws";
  const simulationId = overrides?.simulationId ?? "sim-test";
  const lineageId = overrides?.lineageId ?? "lineage-test";
  const parentSimulationId = overrides?.parentSimulationId ?? null;
  const namespaceResolution = buildConcordiaMemoryNamespaces({
    worldId,
    workspaceId,
    simulationId,
    lineageId,
    parentSimulationId,
    continuityMode: overrides?.continuityMode,
    effectiveStorageKey: overrides?.effectiveStorageKey,
    checkpointMetadata: overrides?.checkpointMetadata ?? null,
  });

  return {
    worldId,
    workspaceId,
    simulationId,
    lineageId,
    parentSimulationId,
    namespaceResolution,
  };
}


export function buildBaseMemoryContextProps(
  overrides?: Partial<MemoryWiringContext>,
) {
  const {
    worldId,
    workspaceId,
    simulationId,
    lineageId,
    parentSimulationId,
    namespaceResolution,
  } = buildTestMemoryContextSeed(overrides);

  return {
    worldId,
    workspaceId,
    simulationId,
    lineageId,
    parentSimulationId,
    effectiveStorageKey:
      overrides?.effectiveStorageKey ??
      namespaceResolution.namespaces.effectiveStorageKey,
    continuityMode: overrides?.continuityMode ?? namespaceResolution.continuityMode,
    carryOverPolicy: overrides?.carryOverPolicy ?? namespaceResolution.carryOverPolicy,
    namespaces: overrides?.namespaces ?? namespaceResolution.namespaces,
    checkpointMetadata: overrides?.checkpointMetadata ?? null,
  };
}
