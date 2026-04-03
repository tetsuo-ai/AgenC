/**
 * Concordia simulation memory namespace resolution.
 *
 * Phase 4 requires explicit run isolation and opt-in lineage continuity.
 * This module is the source of truth for how a simulation maps onto storage,
 * world, workspace, and carry-over scopes.
 */

import type {
  ConcordiaCheckpointManifest,
  ConcordiaCheckpointStatus,
  ConcordiaReplayCursorState,
  ConcordiaRuntimeCursorState,
  ConcordiaSceneCursorState,
  ConcordiaWorldStateRefs,
  ConcordiaCheckpointSubsystemRestore,
} from "./checkpoint-manifest.js";

export type ConcordiaMemoryContinuityMode = "isolated" | "lineage_resume";
export type ConcordiaCarryOverScope = "simulation" | "lineage" | "shared";

export interface ConcordiaCheckpointMetadata {
  readonly checkpointId?: string | null;
  readonly checkpointPath?: string | null;
  readonly checkpointSchemaVersion?: number | null;
  readonly checkpointSimulationId?: string | null;
  readonly checkpointLineageId?: string | null;
  readonly checkpointParentSimulationId?: string | null;
  readonly checkpointWorldId?: string | null;
  readonly checkpointWorkspaceId?: string | null;
  readonly resumedFromStep?: number | null;
  readonly sceneCursor?: ConcordiaSceneCursorState | null;
  readonly runtimeCursor?: ConcordiaRuntimeCursorState | null;
  readonly replayCursor?: ConcordiaReplayCursorState | null;
  readonly worldStateRefs?: ConcordiaWorldStateRefs | null;
  readonly subsystemRestore?: ConcordiaCheckpointSubsystemRestore | null;
  readonly checkpointManifest?: ConcordiaCheckpointManifest | null;
  readonly checkpointStatus?: ConcordiaCheckpointStatus | null;
  readonly [key: string]: unknown;
}

export interface ConcordiaCarryOverPolicy {
  readonly mode: ConcordiaMemoryContinuityMode;
  readonly identity: ConcordiaCarryOverScope;
  readonly beliefs: ConcordiaCarryOverScope;
  readonly procedures: ConcordiaCarryOverScope;
  readonly socialMemory: ConcordiaCarryOverScope;
  readonly graphFacts: ConcordiaCarryOverScope;
  readonly sharedMemory: "shared";
  readonly worldFacts: ConcordiaCarryOverScope;
  readonly collectiveEmergence: ConcordiaCarryOverScope;
  readonly dailyLogs: "simulation";
  readonly traceLogs: "simulation";
  readonly vectorStore: ConcordiaCarryOverScope;
  readonly activation: ConcordiaCarryOverScope;
  readonly lifecycle: ConcordiaCarryOverScope;
}

export interface ConcordiaMemoryNamespaceRefs {
  readonly simulationScopeId: string;
  readonly lineageScopeId: string;
  readonly continuityScopeId: string;
  readonly worldScopeId: string;
  readonly effectiveStorageKey: string;
  readonly logStorageKey: string;
  readonly memoryWorkspaceId: string;
  readonly identityWorkspaceId: string;
  readonly proceduralWorkspaceId: string;
  readonly graphWorkspaceId: string;
  readonly activationKeyPrefix: string;
  readonly lifecycleKeyPrefix: string;
  readonly observationFactIndexKey: string;
  readonly collectiveEmergenceKey: string;
  readonly sharedAuthor: string;
  readonly sharedSourceScope: string;
}

export interface ConcordiaMemoryNamespaceInput {
  readonly worldId: string;
  readonly workspaceId: string;
  readonly simulationId?: string | null;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
  readonly continuityMode?: ConcordiaMemoryContinuityMode;
  readonly effectiveStorageKey?: string;
  readonly checkpointMetadata?: ConcordiaCheckpointMetadata | null;
}

function resolveSimulationScopeId(input: ConcordiaMemoryNamespaceInput): string {
  return input.simulationId ? `sim:${input.simulationId}` : `world:${input.worldId}`;
}

function resolveLineageScopeId(
  input: ConcordiaMemoryNamespaceInput,
  simulationScopeId: string,
): string {
  return input.lineageId ? `lineage:${input.lineageId}` : simulationScopeId;
}

export function resolveConcordiaMemoryContinuityMode(
  input: ConcordiaMemoryNamespaceInput,
): ConcordiaMemoryContinuityMode {
  if (input.continuityMode) {
    return input.continuityMode;
  }
  if (
    input.parentSimulationId ||
    input.checkpointMetadata?.checkpointSimulationId ||
    input.checkpointMetadata?.checkpointLineageId
  ) {
    return "lineage_resume";
  }
  return "isolated";
}

export function buildConcordiaCarryOverPolicy(
  mode: ConcordiaMemoryContinuityMode,
): ConcordiaCarryOverPolicy {
  const continuityScope: ConcordiaCarryOverScope =
    mode === "lineage_resume" ? "lineage" : "simulation";
  return {
    mode,
    identity: continuityScope,
    beliefs: continuityScope,
    procedures: continuityScope,
    socialMemory: continuityScope,
    graphFacts: continuityScope,
    sharedMemory: "shared",
    worldFacts: continuityScope,
    collectiveEmergence: continuityScope,
    dailyLogs: "simulation",
    traceLogs: "simulation",
    vectorStore: continuityScope,
    activation: continuityScope,
    lifecycle: continuityScope,
  };
}

export function buildConcordiaMemoryNamespaces(
  input: ConcordiaMemoryNamespaceInput,
): {
  readonly continuityMode: ConcordiaMemoryContinuityMode;
  readonly carryOverPolicy: ConcordiaCarryOverPolicy;
  readonly namespaces: ConcordiaMemoryNamespaceRefs;
} {
  const continuityMode = resolveConcordiaMemoryContinuityMode(input);
  const carryOverPolicy = buildConcordiaCarryOverPolicy(continuityMode);
  const simulationScopeId = resolveSimulationScopeId(input);
  const lineageScopeId = resolveLineageScopeId(input, simulationScopeId);
  const continuityScopeId =
    carryOverPolicy.identity === "lineage" ? lineageScopeId : simulationScopeId;
  const worldScopeId = `world:${input.worldId}::${continuityScopeId}`;
  const effectiveStorageKey = input.effectiveStorageKey ?? worldScopeId;
  const logStorageKey = `log:${input.worldId}::${simulationScopeId}`;
  const memoryWorkspaceId = `${input.workspaceId}::${continuityScopeId}`;
  const sharedAuthorSegments = [
    `concordia:${input.worldId}`,
    simulationScopeId,
    input.lineageId ? `lineage:${input.lineageId}` : null,
  ].filter((segment): segment is string => Boolean(segment));

  return {
    continuityMode,
    carryOverPolicy,
    namespaces: {
      simulationScopeId,
      lineageScopeId,
      continuityScopeId,
      worldScopeId,
      effectiveStorageKey,
      logStorageKey,
      memoryWorkspaceId,
      identityWorkspaceId: memoryWorkspaceId,
      proceduralWorkspaceId: memoryWorkspaceId,
      graphWorkspaceId: memoryWorkspaceId,
      activationKeyPrefix: `${input.workspaceId}:concordia:activation:${continuityScopeId}`,
      lifecycleKeyPrefix: `${input.workspaceId}:concordia:lifecycle:${continuityScopeId}`,
      observationFactIndexKey: `${input.workspaceId}:concordia:observation-facts:${continuityScopeId}`,
      collectiveEmergenceKey: `${input.workspaceId}:concordia:collective-emergence:${continuityScopeId}`,
      sharedAuthor: sharedAuthorSegments.join(':'),
      sharedSourceScope: effectiveStorageKey,
    },
  };
}
