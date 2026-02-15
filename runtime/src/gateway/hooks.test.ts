import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookDispatcher } from './hooks.js';
import type { HookHandler, HookContext, HookResult } from './hooks.js';
import { silentLogger } from '../utils/logger.js';

function makeHandler(
  event: HookHandler['event'],
  name: string,
  result: HookResult = { continue: true },
  priority?: number,
): HookHandler {
  return {
    event,
    name,
    priority,
    handler: vi.fn().mockResolvedValue(result),
  };
}

describe('HookDispatcher', () => {
  let dispatcher: HookDispatcher;

  beforeEach(() => {
    dispatcher = new HookDispatcher({ logger: silentLogger });
  });

  describe('on / off', () => {
    it('registers a handler', () => {
      dispatcher.on(makeHandler('gateway:startup', 'boot'));

      expect(dispatcher.hasHandlers('gateway:startup')).toBe(true);
      expect(dispatcher.getHandlerCount('gateway:startup')).toBe(1);
    });

    it('registers multiple handlers for same event', () => {
      dispatcher.on(makeHandler('message:inbound', 'filter'));
      dispatcher.on(makeHandler('message:inbound', 'log'));

      expect(dispatcher.getHandlerCount('message:inbound')).toBe(2);
    });

    it('removes a handler by event and name', () => {
      dispatcher.on(makeHandler('gateway:startup', 'boot'));
      dispatcher.on(makeHandler('gateway:startup', 'metrics'));

      const removed = dispatcher.off('gateway:startup', 'boot');

      expect(removed).toBe(true);
      expect(dispatcher.getHandlerCount('gateway:startup')).toBe(1);
    });

    it('returns false when removing nonexistent handler', () => {
      expect(dispatcher.off('gateway:startup', 'nonexistent')).toBe(false);
    });

    it('returns false when removing from event with no handlers', () => {
      expect(dispatcher.off('gateway:shutdown', 'anything')).toBe(false);
    });

    it('cleans up empty handler list on last removal', () => {
      dispatcher.on(makeHandler('gateway:startup', 'only'));

      dispatcher.off('gateway:startup', 'only');

      expect(dispatcher.hasHandlers('gateway:startup')).toBe(false);
    });
  });

  describe('clear', () => {
    it('clears handlers for a specific event', () => {
      dispatcher.on(makeHandler('gateway:startup', 'a'));
      dispatcher.on(makeHandler('gateway:startup', 'b'));
      dispatcher.on(makeHandler('gateway:shutdown', 'c'));

      dispatcher.clear('gateway:startup');

      expect(dispatcher.hasHandlers('gateway:startup')).toBe(false);
      expect(dispatcher.hasHandlers('gateway:shutdown')).toBe(true);
    });

    it('clears all handlers when no event given', () => {
      dispatcher.on(makeHandler('gateway:startup', 'a'));
      dispatcher.on(makeHandler('gateway:shutdown', 'b'));

      dispatcher.clear();

      expect(dispatcher.getHandlerCount()).toBe(0);
    });
  });

  describe('dispatch', () => {
    it('calls handlers in registration order when same priority', async () => {
      const order: string[] = [];

      dispatcher.on({
        event: 'message:inbound',
        name: 'first',
        handler: async () => {
          order.push('first');
          return { continue: true };
        },
      });
      dispatcher.on({
        event: 'message:inbound',
        name: 'second',
        handler: async () => {
          order.push('second');
          return { continue: true };
        },
      });

      await dispatcher.dispatch('message:inbound', {});

      expect(order).toEqual(['first', 'second']);
    });

    it('calls handlers in priority order (lower first)', async () => {
      const order: string[] = [];

      dispatcher.on({
        event: 'message:inbound',
        name: 'low-priority',
        priority: 200,
        handler: async () => {
          order.push('low');
          return { continue: true };
        },
      });
      dispatcher.on({
        event: 'message:inbound',
        name: 'high-priority',
        priority: 10,
        handler: async () => {
          order.push('high');
          return { continue: true };
        },
      });
      dispatcher.on({
        event: 'message:inbound',
        name: 'default-priority',
        handler: async () => {
          order.push('default');
          return { continue: true };
        },
      });

      await dispatcher.dispatch('message:inbound', {});

      expect(order).toEqual(['high', 'default', 'low']);
    });

    it('passes payload to handlers', async () => {
      const handler = makeHandler('tool:before', 'audit');
      dispatcher.on(handler);

      await dispatcher.dispatch('tool:before', { toolName: 'bash', args: {} });

      const ctx = (handler.handler as ReturnType<typeof vi.fn>).mock.calls[0][0] as HookContext;
      expect(ctx.event).toBe('tool:before');
      expect(ctx.payload).toEqual({ toolName: 'bash', args: {} });
      expect(ctx.timestamp).toBeGreaterThan(0);
    });

    it('returns completed: true when all handlers continue', async () => {
      dispatcher.on(makeHandler('gateway:startup', 'a'));
      dispatcher.on(makeHandler('gateway:startup', 'b'));

      const result = await dispatcher.dispatch('gateway:startup', { ready: true });

      expect(result.completed).toBe(true);
      expect(result.handlersRun).toBe(2);
      expect(result.abortedBy).toBeUndefined();
    });

    it('returns completed: true with 0 handlers when none registered', async () => {
      const result = await dispatcher.dispatch('gateway:startup', {});

      expect(result.completed).toBe(true);
      expect(result.handlersRun).toBe(0);
    });

    it('aborts chain when handler returns continue: false', async () => {
      const order: string[] = [];

      dispatcher.on({
        event: 'tool:before',
        name: 'gate',
        priority: 10,
        handler: async () => {
          order.push('gate');
          return { continue: false };
        },
      });
      dispatcher.on({
        event: 'tool:before',
        name: 'after-gate',
        priority: 20,
        handler: async () => {
          order.push('after-gate');
          return { continue: true };
        },
      });

      const result = await dispatcher.dispatch('tool:before', { dangerous: true });

      expect(result.completed).toBe(false);
      expect(result.abortedBy).toBe('gate');
      expect(result.handlersRun).toBe(1);
      expect(order).toEqual(['gate']);
    });
  });

  describe('payload transformation', () => {
    it('transforms payload between handlers', async () => {
      dispatcher.on({
        event: 'message:inbound',
        name: 'add-metadata',
        priority: 10,
        handler: async (ctx) => ({
          continue: true,
          payload: { ...ctx.payload, enriched: true },
        }),
      });
      dispatcher.on({
        event: 'message:inbound',
        name: 'check-metadata',
        priority: 20,
        handler: async (ctx) => {
          expect(ctx.payload.enriched).toBe(true);
          return { continue: true };
        },
      });

      const result = await dispatcher.dispatch('message:inbound', { text: 'hello' });

      expect(result.payload).toEqual({ text: 'hello', enriched: true });
    });

    it('chains multiple payload transformations', async () => {
      dispatcher.on({
        event: 'message:outbound',
        name: 'step1',
        priority: 1,
        handler: async (ctx) => ({
          continue: true,
          payload: { ...ctx.payload, step1: true },
        }),
      });
      dispatcher.on({
        event: 'message:outbound',
        name: 'step2',
        priority: 2,
        handler: async (ctx) => ({
          continue: true,
          payload: { ...ctx.payload, step2: true },
        }),
      });
      dispatcher.on({
        event: 'message:outbound',
        name: 'step3',
        priority: 3,
        handler: async (ctx) => ({
          continue: true,
          payload: { ...ctx.payload, step3: true },
        }),
      });

      const result = await dispatcher.dispatch('message:outbound', { original: true });

      expect(result.payload).toEqual({
        original: true,
        step1: true,
        step2: true,
        step3: true,
      });
    });

    it('aborted handler payload is preserved in result', async () => {
      dispatcher.on({
        event: 'tool:before',
        name: 'blocker',
        handler: async (ctx) => ({
          continue: false,
          payload: { ...ctx.payload, blocked: true, reason: 'denied' },
        }),
      });

      const result = await dispatcher.dispatch('tool:before', { tool: 'bash' });

      expect(result.completed).toBe(false);
      expect(result.payload).toEqual({ tool: 'bash', blocked: true, reason: 'denied' });
    });
  });

  describe('error isolation', () => {
    it('continues chain when a handler throws', async () => {
      const order: string[] = [];

      dispatcher.on({
        event: 'message:inbound',
        name: 'broken',
        priority: 10,
        handler: async () => {
          order.push('broken');
          throw new Error('handler crashed');
        },
      });
      dispatcher.on({
        event: 'message:inbound',
        name: 'healthy',
        priority: 20,
        handler: async () => {
          order.push('healthy');
          return { continue: true };
        },
      });

      const result = await dispatcher.dispatch('message:inbound', {});

      expect(order).toEqual(['broken', 'healthy']);
      expect(result.completed).toBe(true);
      expect(result.handlersRun).toBe(2);
    });
  });

  describe('getHandlerCount', () => {
    it('returns 0 for events with no handlers', () => {
      expect(dispatcher.getHandlerCount('gateway:startup')).toBe(0);
    });

    it('returns total count when no event specified', () => {
      dispatcher.on(makeHandler('gateway:startup', 'a'));
      dispatcher.on(makeHandler('gateway:shutdown', 'b'));
      dispatcher.on(makeHandler('message:inbound', 'c'));

      expect(dispatcher.getHandlerCount()).toBe(3);
    });
  });

  describe('listHandlers', () => {
    it('lists handlers grouped by event with priorities', () => {
      dispatcher.on(makeHandler('gateway:startup', 'boot', { continue: true }, 10));
      dispatcher.on(makeHandler('gateway:startup', 'metrics', { continue: true }, 50));
      dispatcher.on(makeHandler('tool:before', 'audit', { continue: true }));

      const listing = dispatcher.listHandlers();

      const startup = listing.get('gateway:startup');
      expect(startup).toHaveLength(2);
      expect(startup![0]).toEqual({ name: 'boot', priority: 10 });
      expect(startup![1]).toEqual({ name: 'metrics', priority: 50 });

      const toolBefore = listing.get('tool:before');
      expect(toolBefore).toHaveLength(1);
      expect(toolBefore![0]).toEqual({ name: 'audit', priority: 100 });
    });
  });

  describe('timestamp injection', () => {
    it('uses custom clock function', async () => {
      const customDispatcher = new HookDispatcher({
        logger: silentLogger,
        now: () => 42,
      });

      let capturedTimestamp = 0;
      customDispatcher.on({
        event: 'gateway:startup',
        name: 'clock-check',
        handler: async (ctx) => {
          capturedTimestamp = ctx.timestamp;
          return { continue: true };
        },
      });

      await customDispatcher.dispatch('gateway:startup', {});

      expect(capturedTimestamp).toBe(42);
    });
  });
});
