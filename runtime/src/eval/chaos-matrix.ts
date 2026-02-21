/**
 * Chaos scenario matrix used for deterministic replay and storage regression checks.
 *
 * @module
 */

import type { ReplayAnomalyCode } from "./replay-comparison.js";
import type {
  ReplayAlertKind,
  ReplayAlertSeverity,
} from "../replay/alerting.js";

export type ChaosScenarioCategory =
  | "replay"
  | "store"
  | "transition"
  | "network"
  | "partial_write";

export interface ChaosScenarioExpectedAnomaly {
  /**
   * Replay comparator anomaly code (when applicable).
   */
  code?: ReplayAnomalyCode;
  /**
   * Replay alert code (used when the scenario is validated via alerting rather than comparator anomalies).
   */
  alertCode?: string;
  severity: ReplayAlertSeverity;
  kind: ReplayAlertKind;
}

export interface ChaosScenario {
  id: string; // e.g. "chaos.store_write_failure"
  category: ChaosScenarioCategory;
  trigger: string;
  expectedAnomaly: ChaosScenarioExpectedAnomaly;
  classification: "deterministic" | "probabilistic";
  fixture: string; // path to fixture data file
}

export const CHAOS_SCENARIOS: readonly ChaosScenario[] = [
  {
    id: "chaos.comparator.hash_mismatch",
    category: "replay",
    trigger: "Projected hash differs from local replay hash",
    expectedAnomaly: {
      code: "hash_mismatch",
      severity: "error",
      kind: "replay_hash_mismatch",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-comparator-fixture.ts",
  },
  {
    id: "chaos.comparator.missing_event",
    category: "replay",
    trigger: "On-chain event exists but not in local trace",
    expectedAnomaly: {
      code: "missing_event",
      severity: "error",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-comparator-fixture.ts",
  },
  {
    id: "chaos.comparator.unexpected_event",
    category: "replay",
    trigger: "Local trace has event not in on-chain projection",
    expectedAnomaly: {
      code: "unexpected_event",
      severity: "warning",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-comparator-fixture.ts",
  },
  {
    id: "chaos.comparator.type_mismatch",
    category: "replay",
    trigger: "Event type changed between projection and local",
    expectedAnomaly: {
      code: "type_mismatch",
      severity: "error",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-comparator-fixture.ts",
  },
  {
    id: "chaos.store.write_failure",
    category: "store",
    trigger: "Store rejects write mid-batch (simulated I/O error)",
    expectedAnomaly: {
      alertCode: "replay.backfill.store_write_failed",
      severity: "error",
      kind: "replay_ingestion_lag",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-store-fixture.ts",
  },
  {
    id: "chaos.store.read_corruption",
    category: "store",
    trigger: "Store returns malformed data on read",
    expectedAnomaly: {
      code: "type_mismatch",
      severity: "error",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-store-fixture.ts",
  },
  {
    id: "chaos.store.empty_result",
    category: "store",
    trigger: "Store returns zero records for valid query",
    expectedAnomaly: {
      code: "unexpected_event",
      severity: "warning",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-store-fixture.ts",
  },
  {
    id: "chaos.transition.invalid_open_to_completed",
    category: "transition",
    trigger: "Task jumps from Open directly to Completed (skipping InProgress)",
    expectedAnomaly: {
      code: "transition_invalid",
      severity: "error",
      kind: "transition_validation",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-transition-fixture.ts",
  },
  {
    id: "chaos.transition.double_completion",
    category: "transition",
    trigger: "Two completion events for same competitive task",
    expectedAnomaly: {
      code: "duplicate_sequence",
      severity: "error",
      kind: "replay_anomaly_repeat",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-transition-fixture.ts",
  },
  {
    id: "chaos.transition.dispute_on_cancelled",
    category: "transition",
    trigger: "Dispute initiated on already cancelled task",
    expectedAnomaly: {
      code: "transition_invalid",
      severity: "error",
      kind: "transition_validation",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-transition-fixture.ts",
  },
  {
    id: "chaos.partial_write.cursor_stall",
    category: "partial_write",
    trigger: "Backfill cursor stuck at same position after retry",
    expectedAnomaly: {
      alertCode: "replay.backfill.stalled",
      severity: "warning",
      kind: "replay_ingestion_lag",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-partial-write-fixture.ts",
  },
  {
    id: "chaos.partial_write.resume_after_crash",
    category: "partial_write",
    trigger: "Backfill resumes from persisted cursor after simulated crash",
    expectedAnomaly: {
      alertCode: "replay.backfill.resume_after_crash",
      severity: "info",
      kind: "replay_ingestion_lag",
    },
    classification: "deterministic",
    fixture: "runtime/tests/fixtures/replay-chaos-partial-write-fixture.ts",
  },
] as const;
