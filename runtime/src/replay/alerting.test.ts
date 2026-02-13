import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../utils/logger.js';
import { createReplayAlertDispatcher, type ReplayAnomalyAlert } from './alerting.js';

interface LoggerCapture {
  callCount: number;
  entries: Array<{ level: string; message: string; args: unknown[] }>;
}

function createCaptureLogger(): { logger: Logger; capture: LoggerCapture } {
  const capture: LoggerCapture = { callCount: 0, entries: [] };

  const logger: Logger = {
    debug(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: 'debug', message, args });
    },
    info(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: 'info', message, args });
    },
    warn(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: 'warn', message, args });
    },
    error(message, ...args) {
      capture.callCount += 1;
      capture.entries.push({ level: 'error', message, args });
    },
    setLevel: vi.fn(),
  };

  return { logger, capture };
}

function replayContext() {
  return {
    code: 'replay.projection.malformed',
    severity: 'warning' as const,
    kind: 'transition_validation' as const,
    message: 'deterministic test alert',
    taskPda: 'task-123',
    disputePda: 'dispute-456',
    sourceEventName: 'taskCreated',
    signature: 'SIG_1',
    slot: 42,
    sourceEventSequence: 3,
    traceId: 'trace-931',
  };
}

describe('ReplayAlertDispatcher', () => {
  it('does not emit when disabled', async () => {
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

  it('emits deterministic alert IDs with fixed timestamp and dedupe policy', async () => {
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
    const replay = await createReplayAlertDispatcher({
      enabled: true,
      logger: { enabled: true },
      dedupeWindowMs: 0,
      nowMs,
    }, logger).emit(replayContext());

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

  it('suppresses alerts inside the dedupe window but preserves history for repeat counts', async () => {
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

  it('maps severity to logger level in webhook-free mode', async () => {
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
      severity: 'warning',
      code: 'replay.compare.hash_mismatch',
    });
    const error = await dispatcher.emit({
      ...replayContext(),
      severity: 'error',
      code: 'replay.compare.transition_invalid',
    });
    const info = await dispatcher.emit({
      ...replayContext(),
      severity: 'info',
      code: 'replay.compare.transition_invalid',
      kind: 'replay_anomaly_repeat',
    });

    expect(warning?.id).toBeTruthy();
    expect(error?.id).toBeTruthy();
    expect(info?.id).toBeTruthy();
    expect(capture.entries.map((entry) => entry.level)).toEqual([
      'warn',
      'error',
      'info',
    ]);
  });

  it('returns replay payloads as schema-stable objects', async () => {
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
      code: 'replay.compare.hash_mismatch',
      kind: 'replay_hash_mismatch',
      severity: 'error',
      metadata: {
        localHash: 'a',
        projectedHash: 'b',
      },
      sourceEventSequence: 11,
    });

    expect(alert).toMatchObject({
      code: 'replay.compare.hash_mismatch',
      kind: 'replay_hash_mismatch',
      severity: 'error',
      message: 'deterministic test alert',
    } satisfies Partial<ReplayAnomalyAlert>);
  });
});
