/**
 * Benchmark manifest schema and canonicalization helpers.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RiskTier } from "../autonomous/risk-scoring.js";
import {
  stableStringifyJson,
  type JsonObject,
  type JsonValue,
} from "./types.js";

export const BENCHMARK_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface BenchmarkScenarioManifest {
  id: string;
  title: string;
  taskClass: string;
  riskTier: RiskTier;
  expectedConstraints: string[];
  seeds: number[];
  fixtureTrace?: string;
  rewardLamports?: string;
  verifierGated?: boolean;
  costUnits?: number;
  metadata?: JsonObject;
}

export interface BenchmarkManifest {
  schemaVersion: typeof BENCHMARK_MANIFEST_SCHEMA_VERSION;
  corpusVersion: string;
  baselineScenarioId?: string;
  k?: number;
  scenarios: BenchmarkScenarioManifest[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScenario(
  value: unknown,
  index: number,
): BenchmarkScenarioManifest {
  const path = `scenarios[${index}]`;
  assert(isPlainObject(value), `${path} must be an object`);

  const id = value.id;
  const title = value.title;
  const taskClass = value.taskClass;
  const riskTier = value.riskTier;
  const expectedConstraints = value.expectedConstraints;
  const seeds = value.seeds;
  const fixtureTrace = value.fixtureTrace;
  const rewardLamports = value.rewardLamports;
  const verifierGated = value.verifierGated;
  const costUnits = value.costUnits;
  const metadata = value.metadata;

  assert(
    typeof id === "string" && id.length > 0,
    `${path}.id must be a non-empty string`,
  );
  assert(
    typeof title === "string" && title.length > 0,
    `${path}.title must be a non-empty string`,
  );
  assert(
    typeof taskClass === "string" && taskClass.length > 0,
    `${path}.taskClass must be a non-empty string`,
  );
  assert(
    riskTier === "low" || riskTier === "medium" || riskTier === "high",
    `${path}.riskTier must be low|medium|high`,
  );
  assert(
    Array.isArray(expectedConstraints),
    `${path}.expectedConstraints must be an array`,
  );
  assert(
    expectedConstraints.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ),
    `${path}.expectedConstraints entries must be non-empty strings`,
  );
  assert(
    Array.isArray(seeds) && seeds.length > 0,
    `${path}.seeds must be a non-empty array`,
  );
  assert(
    seeds.every((entry) => Number.isInteger(entry)),
    `${path}.seeds entries must be integers`,
  );

  if (fixtureTrace !== undefined) {
    assert(
      typeof fixtureTrace === "string" && fixtureTrace.length > 0,
      `${path}.fixtureTrace must be a non-empty string`,
    );
  }
  if (rewardLamports !== undefined) {
    assert(
      typeof rewardLamports === "string" && /^[0-9]+$/.test(rewardLamports),
      `${path}.rewardLamports must be a numeric string`,
    );
  }
  if (verifierGated !== undefined) {
    assert(
      typeof verifierGated === "boolean",
      `${path}.verifierGated must be boolean`,
    );
  }
  if (costUnits !== undefined) {
    assert(
      typeof costUnits === "number" &&
        Number.isFinite(costUnits) &&
        costUnits >= 0,
      `${path}.costUnits must be a non-negative number`,
    );
  }
  if (metadata !== undefined) {
    assert(isPlainObject(metadata), `${path}.metadata must be an object`);
  }

  const dedupedConstraints = [...new Set(expectedConstraints)];
  const dedupedSeeds = [...new Set(seeds as number[])];
  dedupedSeeds.sort((left, right) => left - right);

  return {
    id,
    title,
    taskClass,
    riskTier,
    expectedConstraints: dedupedConstraints.sort((left, right) =>
      left.localeCompare(right),
    ),
    seeds: dedupedSeeds,
    fixtureTrace: fixtureTrace as string | undefined,
    rewardLamports: rewardLamports as string | undefined,
    verifierGated: verifierGated as boolean | undefined,
    costUnits: costUnits as number | undefined,
    metadata: metadata as JsonObject | undefined,
  };
}

/**
 * Parse and validate benchmark manifest input.
 */
export function parseBenchmarkManifest(value: unknown): BenchmarkManifest {
  assert(isPlainObject(value), "manifest must be an object");

  const schemaVersion = value.schemaVersion;
  const corpusVersion = value.corpusVersion;
  const baselineScenarioId = value.baselineScenarioId;
  const scenarios = value.scenarios;
  const k = value.k;

  assert(
    schemaVersion === BENCHMARK_MANIFEST_SCHEMA_VERSION,
    `unsupported manifest schemaVersion: ${String(schemaVersion)}`,
  );
  assert(
    typeof corpusVersion === "string" && corpusVersion.length > 0,
    "corpusVersion must be a non-empty string",
  );
  assert(
    Array.isArray(scenarios) && scenarios.length > 0,
    "scenarios must be a non-empty array",
  );
  if (baselineScenarioId !== undefined) {
    assert(
      typeof baselineScenarioId === "string" && baselineScenarioId.length > 0,
      "baselineScenarioId must be a non-empty string",
    );
  }
  if (k !== undefined) {
    assert(
      Number.isInteger(k) && (k as number) > 0,
      "k must be a positive integer",
    );
  }

  const parsedScenarios = scenarios.map((scenario, index) =>
    parseScenario(scenario, index),
  );
  parsedScenarios.sort((left, right) => left.id.localeCompare(right.id));

  const ids = new Set<string>();
  for (const scenario of parsedScenarios) {
    assert(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }

  if (baselineScenarioId !== undefined) {
    assert(
      ids.has(baselineScenarioId as string),
      `baselineScenarioId not found in scenarios: ${baselineScenarioId as string}`,
    );
  }

  return {
    schemaVersion: BENCHMARK_MANIFEST_SCHEMA_VERSION,
    corpusVersion,
    baselineScenarioId: baselineScenarioId as string | undefined,
    k: k as number | undefined,
    scenarios: parsedScenarios,
  };
}

/**
 * Load and parse manifest from JSON file path.
 */
export async function loadBenchmarkManifest(
  manifestPath: string,
): Promise<BenchmarkManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseBenchmarkManifest(parsed);
}

/**
 * Stable hash for manifest version tracking.
 */
export function hashBenchmarkManifest(manifest: BenchmarkManifest): string {
  return createHash("sha256")
    .update(stableStringifyJson(manifest as unknown as JsonValue))
    .digest("hex");
}
