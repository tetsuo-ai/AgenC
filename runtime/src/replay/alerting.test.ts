import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../utils/logger.js";
import {
  computeAnomalySetHash,
  computeAnomalySetHashFromContexts,
  createReplayAlertDispatcher,
  REPLAY_ALERT_SCHEMA_VERSION,
  REPLAY_ALERT_V1_REQUIRED_FIELDS,
  REPLAY_ALERT_V1_VALID_KINDS,
  REPLAY_ALERT_V1_VALID_SEVERITIES,
  validateAlertSchema,
  type ReplayAnomalyAlert,
} from "./alerting.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

interface LoggerCapture {
  callCount: number;
  entries: Array<{ level: string; message: string; args: unknown[] }>;
}

function createCaptureLogger(): { logger: Logger; capture: LoggerCapture } {
  const capture: LoggerCapture = { callCount: 0, entries: [] };

  const logger: Logger = {
    debug(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: "debug", message, args });
    },
    info(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: "info", message, args });
    },
    warn(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: "warn", message, args });
    },
    error(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: "error", message, args });
    },
    setLevel: vi.fn(),
  };

  return { logger, capture };
}

function replayContext() {
  return {
    code: "replay.projection.malformed",
    severity: "warning" as const,
    kind: "transition_validation" as const,
    message: "deterministic test alert",
    taskPda: "task-123",
    disputePda: "dispute-456",
    sourceEventName: "taskCreated",
    signature: "SIG_1",
    slot: 42,
    sourceEventSequence: 3,
    traceId: "trace-931",
  };
}

describe("ReplayAlertDispatcher", () => {
  it("does not emit when disabled", async () => {
    const { logger, capture } = createCaptureLogger();
    const dispatcher = createReplayAlertDispatcher(
      {
        enabled: false,
        logger: { enabled: true },
      },
      logger,
    );

    const alert = await dispatcher.emit(replayContext());

    expect(alert).toBeNull();
    expect(capture.callCount).toBe(0);
  });

  it("emits deterministic alert IDs with fixed timestamp and dedupe policy", async () => {
    let tick = 1_700_000_000_000;
    const nowMs = () => {
      tick += 1_000;
      return tick;
    };
    const { logger, capture } = createCaptureLogger();
    const dispatcher = createReplayAlertDispatcher(
      {
        enabled: true,
        logger: { enabled: true },
        dedupeWindowMs: 0,
        nowMs,
      },
      logger,
    );

    const first = await dispatcher.emit(replayContext());
    const second = await dispatcher.emit(replayContext());
    const replay = await createReplayAlertDispatcher(
      {
        enabled: true,
        logger: { enabled: true },
        dedupeWindowMs: 0,
        nowMs,
      },
      logger,
    ).emit(replayContext());

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(replay).not.toBeNull();
    expect(first?.id).toBe(second?.id);
    expect(first?.id).toBe(replay?.id);
    expect(first?.repeatCount).toBe(1);
    expect(second?.repeatCount).toBe(2);
    expect(replay?.repeatCount).toBe(1);
    expect(capture.callCount).toBe(3);
  });

  it("suppresses alerts inside the dedupe window but preserves history for repeat counts", async () => {
    let call = 0;
    const times = [1_000, 1_100, 1_200, 2_500];
    const nowMs = () => {
      const value = times[call];
      call += 1;
      return value;
    };
    const { logger, capture } = createCaptureLogger();
    const dispatcher = createReplayAlertDispatcher(
      {
        enabled: true,
        logger: { enabled: true },
        dedupeWindowMs: 1000,
        nowMs,
      },
      logger,
    );

    const first = await dispatcher.emit(replayContext());
    const second = await dispatcher.emit(replayContext());
    const third = await dispatcher.emit(replayContext());
    const fourth = await dispatcher.emit(replayContext());

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(fourth).not.toBeNull();
    expect(first?.repeatCount).toBe(1);
    expect(fourth?.repeatCount).toBe(4);
    expect(capture.callCount).toBe(2);
  });

  it("maps severity to logger level in webhook-free mode", async () => {
    const { logger, capture } = createCaptureLogger();
    const dispatcher = createReplayAlertDispatcher(
      {
        enabled: true,
        logger: { enabled: true },
        dedupeWindowMs: 0,
      },
      logger,
    );

    const warning = await dispatcher.emit({
      ...replayContext(),
      severity: "warning",
      code: "replay.compare.hash_mismatch",
    });
    const error = await dispatcher.emit({
      ...replayContext(),
      severity: "error",
      code: "replay.compare.transition_invalid",
    });
    const info = await dispatcher.emit({
      ...replayContext(),
      severity: "info",
      code: "replay.compare.transition_invalid",
      kind: "replay_anomaly_repeat",
    });

    expect(warning?.id).toBeTruthy();
    expect(error?.id).toBeTruthy();
    expect(info?.id).toBeTruthy();
    expect(capture.entries.map((entry) => entry.level)).toEqual([
      "warn",
      "error",
      "info",
    ]);
  });

  it("returns replay payloads as schema-stable objects", async () => {
    const { logger } = createCaptureLogger();
    const dispatcher = createReplayAlertDispatcher(
      {
        enabled: true,
        logger: { enabled: true },
      },
      logger,
    );

    const alert = await dispatcher.emit({
      ...replayContext(),
      code: "replay.compare.hash_mismatch",
      kind: "replay_hash_mismatch",
      severity: "error",
      metadata: {
        localHash: "a",
        projectedHash: "b",
      },
      sourceEventSequence: 11,
    });

    expect(alert).toMatchObject({
      code: "replay.compare.hash_mismatch",
      kind: "replay_hash_mismatch",
      severity: "error",
      message: "deterministic test alert",
    } satisfies Partial<ReplayAnomalyAlert>);
  });
});

// ---------------------------------------------------------------------------
// Schema validation (#967)
// ---------------------------------------------------------------------------

describe("validateAlertSchema (#967)", () => {
  it("validates a complete alert payload", () => {
    const alert = {
      id: "test-id",
      code: "replay.test",
      severity: "warning",
      kind: "transition_validation",
      message: "test",
      emittedAtMs: Date.now(),
    };
    const result = validateAlertSchema(alert);
    expect(result.compatible).toBe(true);
    expect(result.missingFields).toHaveLength(0);
    expect(result.invalidFields).toHaveLength(0);
  });

  it("detects missing required fields", () => {
    const result = validateAlertSchema({ id: "test", code: "test" });
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain("severity");
    expect(result.missingFields).toContain("kind");
    expect(result.missingFields).toContain("message");
    expect(result.missingFields).toContain("emittedAtMs");
  });

  it("detects invalid field types", () => {
    const result = validateAlertSchema({
      id: "",
      code: "",
      severity: "critical",
      kind: "unknown_kind",
      message: 123,
      emittedAtMs: NaN,
    });
    expect(result.compatible).toBe(false);
    expect(result.invalidFields.length).toBeGreaterThan(0);
  });

  it("rejects non-object input", () => {
    expect(validateAlertSchema(null).compatible).toBe(false);
    expect(validateAlertSchema(undefined).compatible).toBe(false);
    expect(validateAlertSchema("string").compatible).toBe(false);
    expect(validateAlertSchema(42).compatible).toBe(false);
    expect(validateAlertSchema([]).compatible).toBe(false);
  });

  it("accepts optional fields without complaint", () => {
    const alert = {
      id: "test-id",
      code: "replay.test",
      severity: "info",
      kind: "replay_hash_mismatch",
      message: "test",
      emittedAtMs: 1700000000000,
      taskPda: "TASK_1",
      slot: 42,
      traceId: "trace-1",
    };
    const result = validateAlertSchema(alert);
    expect(result.compatible).toBe(true);
  });

  it("reports schema version in result", () => {
    const result = validateAlertSchema({});
    expect(result.schemaVersion).toBe(REPLAY_ALERT_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Anomaly set hash (#967)
// ---------------------------------------------------------------------------

describe("computeAnomalySetHash (#967)", () => {
  it("produces same hash for same anomaly set", () => {
    const alerts: ReplayAnomalyAlert[] = [
      {
        id: "a",
        code: "c1",
        severity: "warning",
        kind: "transition_validation",
        message: "m1",
        emittedAtMs: 1,
      },
      {
        id: "b",
        code: "c2",
        severity: "error",
        kind: "replay_hash_mismatch",
        message: "m2",
        emittedAtMs: 2,
      },
    ];
    const hash1 = computeAnomalySetHash(alerts);
    const hash2 = computeAnomalySetHash([alerts[1]!, alerts[0]!]);
    expect(hash1).toBe(hash2);
  });

  it("empty anomaly set produces consistent hash", () => {
    const hash1 = computeAnomalySetHash([]);
    const hash2 = computeAnomalySetHash([]);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it("different sets produce different hashes", () => {
    const alert1: ReplayAnomalyAlert = {
      id: "a",
      code: "c1",
      severity: "warning",
      kind: "transition_validation",
      message: "m1",
      emittedAtMs: 1,
    };
    const alert2: ReplayAnomalyAlert = {
      id: "b",
      code: "c2",
      severity: "error",
      kind: "replay_hash_mismatch",
      message: "m2",
      emittedAtMs: 2,
    };
    const hash1 = computeAnomalySetHash([alert1]);
    const hash2 = computeAnomalySetHash([alert2]);
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeAnomalySetHashFromContexts (#967)", () => {
  it("produces same hash for same contexts regardless of order", () => {
    const ctx1 = {
      code: "replay.test.1",
      severity: "warning" as const,
      kind: "transition_validation" as const,
      message: "msg1",
    };
    const ctx2 = {
      code: "replay.test.2",
      severity: "error" as const,
      kind: "replay_hash_mismatch" as const,
      message: "msg2",
    };
    const hash1 = computeAnomalySetHashFromContexts([ctx1, ctx2]);
    const hash2 = computeAnomalySetHashFromContexts([ctx2, ctx1]);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Golden schema and lockfile (#967)
// ---------------------------------------------------------------------------

describe("replay.alert.v1 golden schema (#967)", () => {
  it("schema version is replay.alert.v1", () => {
    expect(REPLAY_ALERT_SCHEMA_VERSION).toBe("replay.alert.v1");
  });

  it("required fields list matches expected set", () => {
    const fields = [...REPLAY_ALERT_V1_REQUIRED_FIELDS].sort();
    expect(fields).toEqual([
      "code",
      "emittedAtMs",
      "id",
      "kind",
      "message",
      "severity",
    ]);
  });

  it("valid severities match expected set", () => {
    expect([...REPLAY_ALERT_V1_VALID_SEVERITIES].sort()).toEqual([
      "error",
      "info",
      "warning",
    ]);
  });

  it("valid kinds match expected set", () => {
    expect([...REPLAY_ALERT_V1_VALID_KINDS].sort()).toEqual([
      "replay_anomaly_repeat",
      "replay_hash_mismatch",
      "replay_ingestion_lag",
      "transition_validation",
    ]);
  });

  it("sample alert passes schema validation", () => {
    const sampleAlert = {
      id: "abc123",
      code: "replay.projection.transition_invalid",
      severity: "warning",
      kind: "transition_validation",
      message: "test alert message",
      emittedAtMs: 1700000000000,
      taskPda: "TASK_1",
      slot: 42,
      signature: "SIG_1",
      sourceEventName: "taskCompleted",
      sourceEventSequence: 3,
      traceId: "trace-123",
    };

    const result = validateAlertSchema(sampleAlert);
    expect(result.compatible).toBe(true);
    expect(result.missingFields).toEqual([]);
    expect(result.invalidFields).toEqual([]);
  });

  it("alert schema matches lockfile", () => {
    const lockfile = JSON.parse(
      readFileSync(resolve(__dirname, "./alert-schema-lockfile.json"), "utf8"),
    );

    expect(lockfile.schemaVersion).toBe(REPLAY_ALERT_SCHEMA_VERSION);
    expect(lockfile.requiredFields).toEqual(
      [...REPLAY_ALERT_V1_REQUIRED_FIELDS].sort(),
    );
    expect(lockfile.validSeverities).toEqual(
      [...REPLAY_ALERT_V1_VALID_SEVERITIES].sort(),
    );
    expect(lockfile.validKinds).toEqual(
      [...REPLAY_ALERT_V1_VALID_KINDS].sort(),
    );
  });
});
