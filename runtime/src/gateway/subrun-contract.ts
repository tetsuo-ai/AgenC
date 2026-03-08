/**
 * Typed contracts for durable multi-agent orchestration.
 *
 * Phase 10 needs real runtime-owned subrun contracts instead of prompt-only
 * role hints. These types define the persistent lineage, scoped budgets, and
 * artifact/join semantics shared by the supervisor and orchestration layer.
 *
 * @module
 */

import type { BackgroundRunArtifactRef } from "./background-run-store.js";

export const SUBRUN_ROLES = [
  "planner",
  "worker",
  "critic",
  "verifier",
  "aggregator",
] as const;

export type SubrunRole = (typeof SUBRUN_ROLES)[number];

export const SUBRUN_JOIN_STRATEGIES = [
  "all_success",
  "first_success",
  "majority_vote",
  "reduce",
] as const;

export type SubrunJoinStrategy = (typeof SUBRUN_JOIN_STRATEGIES)[number];

export const SUBRUN_REDUNDANCY_PATTERNS = [
  "none",
  "critic",
  "verifier",
  "majority_vote",
  "independent_research",
] as const;

export type SubrunRedundancyPattern = (typeof SUBRUN_REDUNDANCY_PATTERNS)[number];

export interface SubrunBudget {
  readonly maxRuntimeMs: number;
  readonly maxTokens?: number;
  readonly maxToolCalls?: number;
  readonly maxChildren?: number;
}

export interface SubrunScope {
  readonly allowedTools: readonly string[];
  readonly allowedWriteRoots?: readonly string[];
  readonly allowedHosts?: readonly string[];
}

export interface SubrunArtifactContract {
  readonly requiredKinds: readonly BackgroundRunArtifactRef["kind"][];
  readonly minArtifactCount?: number;
  readonly summaryRequired?: boolean;
}

export interface BackgroundRunLineage {
  readonly rootRunId: string;
  readonly parentRunId?: string;
  readonly role: SubrunRole;
  readonly depth: number;
  readonly joinStrategy?: SubrunJoinStrategy;
  readonly redundancyPattern?: SubrunRedundancyPattern;
  readonly scope: SubrunScope;
  readonly artifactContract: SubrunArtifactContract;
  readonly budget: SubrunBudget;
  readonly childRunIds: readonly string[];
}

export interface DurableSubrunSpec {
  readonly sessionId?: string;
  readonly objective: string;
  readonly role: SubrunRole;
  readonly scope: SubrunScope;
  readonly artifactContract: SubrunArtifactContract;
  readonly budget: SubrunBudget;
}

export interface DurableSubrunPlan {
  readonly rootRunId: string;
  readonly parentRunId?: string;
  readonly joinStrategy: SubrunJoinStrategy;
  readonly redundancyPattern: SubrunRedundancyPattern;
  readonly children: readonly DurableSubrunSpec[];
}

export interface SubrunJoinOutcome {
  readonly status: "completed" | "blocked" | "failed";
  readonly summary: string;
  readonly completedChildRunIds: readonly string[];
  readonly failedChildRunIds: readonly string[];
  readonly blockedChildRunIds: readonly string[];
}

export function isSubrunRole(value: unknown): value is SubrunRole {
  return typeof value === "string" && (SUBRUN_ROLES as readonly string[]).includes(value);
}

export function isSubrunJoinStrategy(
  value: unknown,
): value is SubrunJoinStrategy {
  return (
    typeof value === "string" &&
    (SUBRUN_JOIN_STRATEGIES as readonly string[]).includes(value)
  );
}

export function isSubrunRedundancyPattern(
  value: unknown,
): value is SubrunRedundancyPattern {
  return (
    typeof value === "string" &&
    (SUBRUN_REDUNDANCY_PATTERNS as readonly string[]).includes(value)
  );
}

export function assertValidSubrunScope(
  scope: SubrunScope,
  context = "subrun scope",
): void {
  if (!Array.isArray(scope.allowedTools) || scope.allowedTools.length === 0) {
    throw new Error(`${context}: allowedTools must be a non-empty array`);
  }
  if (scope.allowedTools.some((tool) => typeof tool !== "string" || tool.trim().length === 0)) {
    throw new Error(`${context}: allowedTools must only contain non-empty strings`);
  }
  if (
    scope.allowedWriteRoots !== undefined &&
    scope.allowedWriteRoots.some((path) => typeof path !== "string" || path.trim().length === 0)
  ) {
    throw new Error(`${context}: allowedWriteRoots must only contain non-empty strings`);
  }
  if (
    scope.allowedHosts !== undefined &&
    scope.allowedHosts.some((host) => typeof host !== "string" || host.trim().length === 0)
  ) {
    throw new Error(`${context}: allowedHosts must only contain non-empty strings`);
  }
}

export function assertValidSubrunBudget(
  budget: SubrunBudget,
  context = "subrun budget",
): void {
  if (
    typeof budget.maxRuntimeMs !== "number" ||
    !Number.isFinite(budget.maxRuntimeMs) ||
    budget.maxRuntimeMs <= 0
  ) {
    throw new Error(`${context}: maxRuntimeMs must be a positive finite number`);
  }
  const positiveOptionalIntegers = [
    ["maxTokens", budget.maxTokens],
    ["maxToolCalls", budget.maxToolCalls],
    ["maxChildren", budget.maxChildren],
  ] as const;
  for (const [name, value] of positiveOptionalIntegers) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${context}: ${name} must be a positive integer`);
    }
  }
}

export function assertValidSubrunArtifactContract(
  contract: SubrunArtifactContract,
  context = "subrun artifact contract",
): void {
  if (!Array.isArray(contract.requiredKinds)) {
    throw new Error(`${context}: requiredKinds must be an array`);
  }
  if (
    contract.requiredKinds.some(
      (kind) =>
        kind !== "file" &&
        kind !== "url" &&
        kind !== "log" &&
        kind !== "process" &&
        kind !== "download" &&
        kind !== "opaque_provider_state",
    )
  ) {
    throw new Error(`${context}: requiredKinds contains an unknown artifact kind`);
  }
  if (
    contract.minArtifactCount !== undefined &&
    (!Number.isInteger(contract.minArtifactCount) || contract.minArtifactCount <= 0)
  ) {
    throw new Error(`${context}: minArtifactCount must be a positive integer`);
  }
  if (
    contract.summaryRequired !== undefined &&
    typeof contract.summaryRequired !== "boolean"
  ) {
    throw new Error(`${context}: summaryRequired must be a boolean`);
  }
}

export function assertValidDurableSubrunSpec(
  spec: DurableSubrunSpec,
  context = "durable subrun spec",
): void {
  if (typeof spec.objective !== "string" || spec.objective.trim().length === 0) {
    throw new Error(`${context}: objective must be a non-empty string`);
  }
  if (!isSubrunRole(spec.role)) {
    throw new Error(`${context}: role is invalid`);
  }
  assertValidSubrunScope(spec.scope, `${context}.scope`);
  assertValidSubrunArtifactContract(
    spec.artifactContract,
    `${context}.artifactContract`,
  );
  assertValidSubrunBudget(spec.budget, `${context}.budget`);
}

export function assertValidBackgroundRunLineage(
  lineage: BackgroundRunLineage,
  context = "background run lineage",
): void {
  if (typeof lineage.rootRunId !== "string" || lineage.rootRunId.trim().length === 0) {
    throw new Error(`${context}: rootRunId must be a non-empty string`);
  }
  if (
    lineage.parentRunId !== undefined &&
    (typeof lineage.parentRunId !== "string" || lineage.parentRunId.trim().length === 0)
  ) {
    throw new Error(`${context}: parentRunId must be a non-empty string when provided`);
  }
  if (!isSubrunRole(lineage.role)) {
    throw new Error(`${context}: role is invalid`);
  }
  if (!Number.isInteger(lineage.depth) || lineage.depth < 0) {
    throw new Error(`${context}: depth must be a non-negative integer`);
  }
  if (
    lineage.joinStrategy !== undefined &&
    !isSubrunJoinStrategy(lineage.joinStrategy)
  ) {
    throw new Error(`${context}: joinStrategy is invalid`);
  }
  if (
    lineage.redundancyPattern !== undefined &&
    !isSubrunRedundancyPattern(lineage.redundancyPattern)
  ) {
    throw new Error(`${context}: redundancyPattern is invalid`);
  }
  assertValidSubrunScope(lineage.scope, `${context}.scope`);
  assertValidSubrunArtifactContract(
    lineage.artifactContract,
    `${context}.artifactContract`,
  );
  assertValidSubrunBudget(lineage.budget, `${context}.budget`);
  if (!Array.isArray(lineage.childRunIds)) {
    throw new Error(`${context}: childRunIds must be an array`);
  }
}

export function artifactContractSatisfied(params: {
  readonly artifacts: readonly BackgroundRunArtifactRef[];
  readonly artifactContract: SubrunArtifactContract;
  readonly carryForwardSummary?: string;
}): boolean {
  const { artifacts, artifactContract, carryForwardSummary } = params;
  const requiredKinds = new Set(artifactContract.requiredKinds);
  if (requiredKinds.size > 0) {
    for (const kind of requiredKinds) {
      if (!artifacts.some((artifact) => artifact.kind === kind)) {
        return false;
      }
    }
  }
  if (
    artifactContract.minArtifactCount !== undefined &&
    artifacts.length < artifactContract.minArtifactCount
  ) {
    return false;
  }
  if (
    artifactContract.summaryRequired === true &&
    (!carryForwardSummary || carryForwardSummary.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

export function summarizeNestedBudget(
  lineages: readonly BackgroundRunLineage[],
): {
  maxRuntimeMs: number;
  maxTokens: number;
  maxToolCalls: number;
  maxChildren: number;
} {
  return lineages.reduce(
    (acc, lineage) => ({
      maxRuntimeMs: acc.maxRuntimeMs + lineage.budget.maxRuntimeMs,
      maxTokens: acc.maxTokens + (lineage.budget.maxTokens ?? 0),
      maxToolCalls: acc.maxToolCalls + (lineage.budget.maxToolCalls ?? 0),
      maxChildren: acc.maxChildren + (lineage.budget.maxChildren ?? 0),
    }),
    {
      maxRuntimeMs: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxChildren: 0,
    },
  );
}

export function buildSubrunSessionId(params: {
  readonly parentSessionId: string;
  readonly role: SubrunRole;
  readonly index: number;
}): string {
  return `subrun:${params.parentSessionId}:${params.role}:${params.index}`;
}
