export type ConcordiaBenchmarkDimension =
  | "correctness"
  | "continuity_governance"
  | "replay_correctness"
  | "selective_carry_over"
  | "cross_run_isolation";

export interface ConcordiaBenchmarkScenario {
  readonly scenario_id: string;
  readonly title: string;
  readonly source: "memoryarena-inspired";
  readonly description: string;
  readonly dimensions: readonly ConcordiaBenchmarkDimension[];
  readonly sessions: readonly string[];
  readonly expected_assertions: readonly string[];
}

export interface ConcordiaBenchmarkScenarioResult {
  readonly scenario_id: string;
  readonly correctness: number;
  readonly continuity_governance: number;
  readonly replay_correctness: number;
  readonly selective_carry_over: number;
  readonly cross_run_isolation: number;
  readonly notes?: string | null;
}

export interface ConcordiaBenchmarkSummary {
  readonly scenario_count: number;
  readonly averages: Record<ConcordiaBenchmarkDimension, number>;
  readonly below_threshold: readonly {
    readonly scenario_id: string;
    readonly dimension: ConcordiaBenchmarkDimension;
    readonly score: number;
  }[];
}

export const MEMORY_ARENA_INSPIRED_SCENARIOS: readonly ConcordiaBenchmarkScenario[] = [
  {
    scenario_id: "multi-run-market-town",
    title: "Concurrent Market Town Runs",
    source: "memoryarena-inspired",
    description:
      "Launch two runs from the same world premise with overlapping agent names and verify replay, state, and memory isolation under concurrent control actions.",
    dimensions: [
      "correctness",
      "replay_correctness",
      "cross_run_isolation",
    ],
    sessions: ["sim-a", "sim-b"],
    expected_assertions: [
      "sim-a and sim-b keep independent session mappings",
      "stopping sim-b never mutates sim-a replay state",
      "same-name agents do not share world facts or identity state",
    ],
  },
  {
    scenario_id: "checkpoint-lineage-resume",
    title: "Checkpoint Resume With Lineage Governance",
    source: "memoryarena-inspired",
    description:
      "Resume a stopped run into a child simulation and score whether lineage carry-over happens only through the explicit resume policy.",
    dimensions: [
      "correctness",
      "continuity_governance",
      "selective_carry_over",
      "cross_run_isolation",
    ],
    sessions: ["sim-a", "sim-c"],
    expected_assertions: [
      "sim-c receives lineage metadata from sim-a",
      "simulation-scoped state stays reset in sim-c unless resume policy allows it",
      "shared memory remains provenance-tagged and trust-filtered",
    ],
  },
  {
    scenario_id: "hydrate-then-stream-reconnect",
    title: "Replay Hydration and Reconnect",
    source: "memoryarena-inspired",
    description:
      "Hydrate historical replay, reconnect to the live stream, and verify cursor-driven deduplication without duplicating old events.",
    dimensions: [
      "correctness",
      "replay_correctness",
      "continuity_governance",
    ],
    sessions: ["sim-live"],
    expected_assertions: [
      "replay hydration occurs before live append",
      "late duplicate events are ignored",
      "transport reconnect restores the latest cursor instead of replaying stale history",
    ],
  },
];

export function summarizeConcordiaBenchmarkResults(
  results: readonly ConcordiaBenchmarkScenarioResult[],
  threshold = 0.8,
): ConcordiaBenchmarkSummary {
  const dimensions: readonly ConcordiaBenchmarkDimension[] = [
    "correctness",
    "continuity_governance",
    "replay_correctness",
    "selective_carry_over",
    "cross_run_isolation",
  ];

  if (results.length === 0) {
    return {
      scenario_count: 0,
      averages: Object.fromEntries(
        dimensions.map((dimension) => [dimension, 0]),
      ) as Record<ConcordiaBenchmarkDimension, number>,
      below_threshold: [],
    };
  }

  const averages = Object.fromEntries(
    dimensions.map((dimension) => {
      const total = results.reduce((sum, result) => sum + result[dimension], 0);
      return [dimension, Number((total / results.length).toFixed(4))];
    }),
  ) as Record<ConcordiaBenchmarkDimension, number>;

  const belowThreshold = results.flatMap((result) => (
    dimensions.flatMap((dimension) => (
      result[dimension] < threshold
        ? [{ scenario_id: result.scenario_id, dimension, score: result[dimension] }]
        : []
    ))
  ));

  return {
    scenario_count: results.length,
    averages,
    below_threshold: belowThreshold,
  };
}
