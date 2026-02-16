import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HeartbeatScheduler,
  HeartbeatStateError,
  HeartbeatActionError,
  HeartbeatTimeoutError,
  defaultHeartbeatConfig,
  type HeartbeatAction,
  type HeartbeatConfig,
  type HeartbeatContext,
  type HeartbeatResult,
} from './heartbeat.js';
import { RuntimeErrorCodes } from '../types/errors.js';

// ============================================================================
// Helpers
// ============================================================================

function makeAction(overrides?: Partial<HeartbeatAction>): HeartbeatAction {
  return {
    name: overrides?.name ?? 'test-action',
    enabled: overrides?.enabled ?? true,
    execute: overrides?.execute ?? (async () => ({ hasOutput: false, quiet: true })),
  };
}

function makeConfig(overrides?: Partial<HeartbeatConfig>): HeartbeatConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeSendToChannels() {
  return vi.fn<(content: string) => Promise<void>>().mockResolvedValue(undefined);
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ============================================================================
// Tests
// ============================================================================

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Error classes
  // --------------------------------------------------------------------------

  describe('error classes', () => {
    it('HeartbeatStateError has correct code and name', () => {
      const err = new HeartbeatStateError('bad state');
      expect(err.name).toBe('HeartbeatStateError');
      expect(err.code).toBe(RuntimeErrorCodes.HEARTBEAT_STATE_ERROR);
      expect(err.message).toBe('bad state');
    });

    it('HeartbeatActionError has correct code, name, and actionName', () => {
      const cause = new Error('boom');
      const err = new HeartbeatActionError('scan', cause);
      expect(err.name).toBe('HeartbeatActionError');
      expect(err.code).toBe(RuntimeErrorCodes.HEARTBEAT_ACTION_FAILED);
      expect(err.actionName).toBe('scan');
      expect(err.cause).toBe(cause);
      expect(err.message).toContain('boom');
    });

    it('HeartbeatTimeoutError has correct code, name, and timeoutMs', () => {
      const err = new HeartbeatTimeoutError('slow-action', 5000);
      expect(err.name).toBe('HeartbeatTimeoutError');
      expect(err.code).toBe(RuntimeErrorCodes.HEARTBEAT_TIMEOUT);
      expect(err.actionName).toBe('slow-action');
      expect(err.timeoutMs).toBe(5000);
      expect(err.message).toContain('5000ms');
    });
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates scheduler with default options', () => {
      const scheduler = new HeartbeatScheduler(makeConfig());
      expect(scheduler.running).toBe(false);
      expect(scheduler.lastRunAt).toBeNull();
      expect(scheduler.nextRunAt).toBeNull();
    });

    it('creates scheduler with custom logger and sendToChannels', () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });
      expect(scheduler.running).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Action registration
  // --------------------------------------------------------------------------

  describe('registerAction', () => {
    it('registers an action when stopped', () => {
      const scheduler = new HeartbeatScheduler(makeConfig());
      scheduler.registerAction(makeAction({ name: 'a1' }));
      // No throw = success
    });

    it('throws HeartbeatStateError when registering while running', () => {
      const scheduler = new HeartbeatScheduler(makeConfig());
      scheduler.start();
      expect(() => scheduler.registerAction(makeAction())).toThrow(HeartbeatStateError);
      scheduler.stop();
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('start/stop', () => {
    it('start sets running to true', () => {
      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.start();
      expect(scheduler.running).toBe(true);
      scheduler.stop();
    });

    it('start is idempotent', () => {
      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.start();
      scheduler.start(); // should not throw
      expect(scheduler.running).toBe(true);
      scheduler.stop();
    });

    it('stop sets running to false', () => {
      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.start();
      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('stop is idempotent', () => {
      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.stop(); // already stopped, should not throw
      expect(scheduler.running).toBe(false);
    });

    it('does not start when config.enabled is false', () => {
      const scheduler = new HeartbeatScheduler(makeConfig({ enabled: false }), { logger: silentLogger });
      scheduler.start();
      expect(scheduler.running).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // runOnce
  // --------------------------------------------------------------------------

  describe('runOnce', () => {
    it('executes all enabled actions', async () => {
      const execute1 = vi.fn<HeartbeatAction['execute']>().mockResolvedValue({ hasOutput: false, quiet: true });
      const execute2 = vi.fn<HeartbeatAction['execute']>().mockResolvedValue({ hasOutput: false, quiet: true });

      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.registerAction(makeAction({ name: 'a1', execute: execute1 }));
      scheduler.registerAction(makeAction({ name: 'a2', execute: execute2 }));

      const summary = await scheduler.runOnce();

      expect(execute1).toHaveBeenCalledOnce();
      expect(execute2).toHaveBeenCalledOnce();
      expect(summary.actionsRun).toBe(2);
      expect(summary.actionsFailed).toBe(0);
    });

    it('skips disabled actions', async () => {
      const execute = vi.fn<HeartbeatAction['execute']>().mockResolvedValue({ hasOutput: false, quiet: true });

      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      scheduler.registerAction(makeAction({ name: 'disabled', enabled: false, execute }));

      const summary = await scheduler.runOnce();

      expect(execute).not.toHaveBeenCalled();
      expect(summary.actionsRun).toBe(0);
    });

    it('updates lastRunAt after execution', async () => {
      const scheduler = new HeartbeatScheduler(makeConfig(), { logger: silentLogger });
      expect(scheduler.lastRunAt).toBeNull();

      await scheduler.runOnce();

      expect(scheduler.lastRunAt).toBe(1700000000000);
    });
  });

  // --------------------------------------------------------------------------
  // Quiet heartbeat contract
  // --------------------------------------------------------------------------

  describe('quiet heartbeat', () => {
    it('does not call sendToChannels when all actions are quiet', async () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });
      scheduler.registerAction(makeAction({
        execute: async () => ({ hasOutput: false, quiet: true }),
      }));

      const summary = await scheduler.runOnce();

      expect(send).not.toHaveBeenCalled();
      expect(summary.messagesPosted).toBe(0);
    });

    it('calls sendToChannels when action has output', async () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });
      scheduler.registerAction(makeAction({
        execute: async () => ({ hasOutput: true, output: 'Task #42 completed', quiet: false }),
      }));

      const summary = await scheduler.runOnce();

      expect(send).toHaveBeenCalledWith('Task #42 completed');
      expect(summary.messagesPosted).toBe(1);
    });

    it('does not post when hasOutput is true but quiet is also true', async () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });
      scheduler.registerAction(makeAction({
        execute: async () => ({ hasOutput: true, output: 'ignored', quiet: true }),
      }));

      const summary = await scheduler.runOnce();

      expect(send).not.toHaveBeenCalled();
      expect(summary.messagesPosted).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Timeout enforcement
  // --------------------------------------------------------------------------

  describe('timeout', () => {
    it('times out slow actions without crashing the scheduler', async () => {
      const send = makeSendToChannels();
      const fastExecute = vi.fn<HeartbeatAction['execute']>().mockResolvedValue({
        hasOutput: true,
        output: 'fast result',
        quiet: false,
      });

      const scheduler = new HeartbeatScheduler(makeConfig({ timeoutMs: 100 }), {
        logger: silentLogger,
        sendToChannels: send,
      });

      scheduler.registerAction(makeAction({
        name: 'slow',
        execute: async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return { hasOutput: true, output: 'never', quiet: false };
        },
      }));
      scheduler.registerAction(makeAction({ name: 'fast', execute: fastExecute }));

      const runPromise = scheduler.runOnce();
      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(200);
      const summary = await runPromise;

      expect(summary.actionsFailed).toBe(1);
      expect(fastExecute).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith('fast result');
    });
  });

  // --------------------------------------------------------------------------
  // Error isolation
  // --------------------------------------------------------------------------

  describe('error isolation', () => {
    it('continues running after an action throws', async () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });

      scheduler.registerAction(makeAction({
        name: 'failing',
        execute: async () => { throw new Error('kaboom'); },
      }));
      scheduler.registerAction(makeAction({
        name: 'succeeding',
        execute: async () => ({ hasOutput: true, output: 'ok', quiet: false }),
      }));

      const summary = await scheduler.runOnce();

      expect(summary.actionsRun).toBe(2);
      expect(summary.actionsFailed).toBe(1);
      expect(summary.messagesPosted).toBe(1);
      expect(send).toHaveBeenCalledWith('ok');
    });
  });

  // --------------------------------------------------------------------------
  // Active hours
  // --------------------------------------------------------------------------

  describe('active hours', () => {
    it('returns true when within normal range (8-22)', () => {
      const scheduler = new HeartbeatScheduler(makeConfig({
        activeHours: { start: 8, end: 22 },
      }));

      // 14:00
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 14, 0))).toBe(true);
    });

    it('returns false when outside normal range (8-22)', () => {
      const scheduler = new HeartbeatScheduler(makeConfig({
        activeHours: { start: 8, end: 22 },
      }));

      // 03:00
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 3, 0))).toBe(false);
      // 22:00 (end is exclusive)
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 22, 0))).toBe(false);
    });

    it('handles wrap-around range (22-6)', () => {
      const scheduler = new HeartbeatScheduler(makeConfig({
        activeHours: { start: 22, end: 6 },
      }));

      // 23:00 — within
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 23, 0))).toBe(true);
      // 02:00 — within
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 2, 0))).toBe(true);
      // 10:00 — outside
      expect(scheduler.isWithinActiveHours(new Date(2024, 0, 1, 10, 0))).toBe(false);
    });

    it('returns true when no activeHours configured', () => {
      const scheduler = new HeartbeatScheduler(makeConfig());
      expect(scheduler.isWithinActiveHours()).toBe(true);
    });

    it('skips actions when outside active hours', async () => {
      const execute = vi.fn<HeartbeatAction['execute']>();
      const scheduler = new HeartbeatScheduler(makeConfig({
        activeHours: { start: 8, end: 22 },
      }), { logger: silentLogger });
      scheduler.registerAction(makeAction({ execute }));

      // Set time to 03:00
      vi.setSystemTime(new Date(2024, 0, 1, 3, 0));

      const summary = await scheduler.runOnce();

      expect(execute).not.toHaveBeenCalled();
      expect(summary.actionsRun).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Interval scheduling
  // --------------------------------------------------------------------------

  describe('interval scheduling', () => {
    it('runs actions after intervalMs elapses', async () => {
      const execute = vi.fn<HeartbeatAction['execute']>().mockResolvedValue({
        hasOutput: false,
        quiet: true,
      });

      const scheduler = new HeartbeatScheduler(makeConfig({ intervalMs: 10_000 }), {
        logger: silentLogger,
      });
      scheduler.registerAction(makeAction({ execute }));
      scheduler.start();

      expect(execute).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(execute).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(execute).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('sets nextRunAt on start and updates after runOnce', async () => {
      const scheduler = new HeartbeatScheduler(makeConfig({ intervalMs: 60_000 }), {
        logger: silentLogger,
      });

      expect(scheduler.nextRunAt).toBeNull();

      scheduler.start();
      expect(scheduler.nextRunAt).toBe(1700000000000 + 60_000);

      await scheduler.runOnce();
      // After runOnce while running, nextRunAt recalculated
      expect(scheduler.nextRunAt).toBe(1700000000000 + 60_000);

      scheduler.stop();
      expect(scheduler.nextRunAt).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------

  describe('summary', () => {
    it('returns correct counts in summary', async () => {
      const send = makeSendToChannels();
      const scheduler = new HeartbeatScheduler(makeConfig(), {
        logger: silentLogger,
        sendToChannels: send,
      });

      scheduler.registerAction(makeAction({
        name: 'quiet',
        execute: async () => ({ hasOutput: false, quiet: true }),
      }));
      scheduler.registerAction(makeAction({
        name: 'loud',
        execute: async () => ({ hasOutput: true, output: 'hello', quiet: false }),
      }));
      scheduler.registerAction(makeAction({
        name: 'broken',
        execute: async () => { throw new Error('fail'); },
      }));
      scheduler.registerAction(makeAction({
        name: 'disabled',
        enabled: false,
        execute: async () => ({ hasOutput: true, output: 'skip', quiet: false }),
      }));

      const summary = await scheduler.runOnce();

      expect(summary.ranAt).toBe(1700000000000);
      expect(summary.actionsRun).toBe(3);      // quiet + loud + broken (not disabled)
      expect(summary.actionsFailed).toBe(1);   // broken
      expect(summary.messagesPosted).toBe(1);  // loud
    });
  });

  // --------------------------------------------------------------------------
  // Default config
  // --------------------------------------------------------------------------

  describe('defaultHeartbeatConfig', () => {
    it('has expected defaults', () => {
      expect(defaultHeartbeatConfig.enabled).toBe(true);
      expect(defaultHeartbeatConfig.intervalMs).toBe(1_800_000);
      expect(defaultHeartbeatConfig.timeoutMs).toBe(60_000);
    });
  });
});
