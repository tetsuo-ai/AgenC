import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PluginCatalog,
  WebhookRouter,
  BaseChannelPlugin,
  ChannelAlreadyRegisteredError,
  ChannelNotFoundError,
} from './channel.js';
import type { ChannelPlugin, ChannelContext, ReactionEvent } from './channel.js';
import type { SlashCommandContext } from './commands.js';
import type { GatewayMessage, OutboundMessage } from './message.js';
import { silentLogger } from '../utils/logger.js';

function makePlugin(name: string, healthy = true): ChannelPlugin {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(healthy),
  };
}

function makePluginWithWebhooks(name: string): ChannelPlugin {
  return {
    ...makePlugin(name),
    registerWebhooks: vi.fn((router: WebhookRouter) => {
      router.post('/update', async () => ({ status: 200 }));
      router.get('/verify', async () => ({ status: 200, body: 'ok' }));
    }),
  };
}

describe('WebhookRouter', () => {
  it('prefixes paths with /webhooks/{channelName}', () => {
    const router = new WebhookRouter('telegram');
    router.post('/update', async () => ({ status: 200 }));

    expect(router.routes).toHaveLength(1);
    expect(router.routes[0].method).toBe('POST');
    expect(router.routes[0].path).toBe('/webhooks/telegram/update');
  });

  it('supports multiple routes', () => {
    const router = new WebhookRouter('discord');
    router.post('/interactions', async () => ({ status: 200 }));
    router.get('/verify', async () => ({ status: 200 }));
    router.route('PUT', '/config', async () => ({ status: 200 }));

    expect(router.routes).toHaveLength(3);
    expect(router.routes[0].method).toBe('POST');
    expect(router.routes[1].method).toBe('GET');
    expect(router.routes[2].method).toBe('PUT');
  });

  it('routes getter returns a shallow copy (does not leak internal array)', () => {
    const router = new WebhookRouter('test');
    router.post('/hook', async () => ({ status: 200 }));

    const first = router.routes;
    const second = router.routes;

    expect(first).toEqual(second);
    expect(first).not.toBe(second); // different array references
  });

  it('handlers are callable', async () => {
    const router = new WebhookRouter('test');
    router.post('/hook', async (req) => ({
      status: 200,
      body: { received: req.body },
    }));

    const response = await router.routes[0].handler({
      method: 'POST',
      path: '/webhooks/test/hook',
      headers: {},
      body: { data: 'test' },
      query: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: { data: 'test' } });
  });
});

describe('PluginCatalog', () => {
  let catalog: PluginCatalog;

  beforeEach(() => {
    catalog = new PluginCatalog({ logger: silentLogger });
  });

  describe('register', () => {
    it('registers a plugin', () => {
      const plugin = makePlugin('telegram');
      catalog.register(plugin);

      expect(catalog.size).toBe(1);
      expect(catalog.get('telegram')).toBe(plugin);
    });

    it('throws on duplicate registration', () => {
      catalog.register(makePlugin('telegram'));

      expect(() => catalog.register(makePlugin('telegram'))).toThrow(
        ChannelAlreadyRegisteredError,
      );
    });
  });

  describe('get / getOrThrow', () => {
    it('get returns undefined for missing plugin', () => {
      expect(catalog.get('nonexistent')).toBeUndefined();
    });

    it('getOrThrow throws for missing plugin', () => {
      expect(() => catalog.getOrThrow('nonexistent')).toThrow(ChannelNotFoundError);
    });

    it('getOrThrow returns plugin when found', () => {
      const plugin = makePlugin('discord');
      catalog.register(plugin);
      expect(catalog.getOrThrow('discord')).toBe(plugin);
    });
  });

  describe('listing', () => {
    it('listNames returns all registered names', () => {
      catalog.register(makePlugin('telegram'));
      catalog.register(makePlugin('discord'));

      const names = catalog.listNames();
      expect(names).toContain('telegram');
      expect(names).toContain('discord');
      expect(names).toHaveLength(2);
    });

    it('listAll returns all plugins', () => {
      catalog.register(makePlugin('telegram'));
      catalog.register(makePlugin('discord'));

      expect(catalog.listAll()).toHaveLength(2);
    });
  });

  describe('activate', () => {
    it('initializes and starts a plugin', async () => {
      const plugin = makePlugin('telegram');
      const onMessage = vi.fn();
      catalog.register(plugin);

      await catalog.activate('telegram', onMessage, { token: 'abc' });

      expect(plugin.initialize).toHaveBeenCalledTimes(1);
      const ctx = (plugin.initialize as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelContext;
      expect(ctx.config).toEqual({ token: 'abc' });
      expect(ctx.onMessage).toBe(onMessage);
      expect(plugin.start).toHaveBeenCalledTimes(1);
    });

    it('throws when activating unregistered plugin', async () => {
      await expect(
        catalog.activate('nonexistent', vi.fn()),
      ).rejects.toThrow(ChannelNotFoundError);
    });

    it('registers webhooks when plugin supports them', async () => {
      const plugin = makePluginWithWebhooks('telegram');
      catalog.register(plugin);

      await catalog.activate('telegram', vi.fn());

      expect(plugin.registerWebhooks).toHaveBeenCalledTimes(1);
      const routes = catalog.getWebhookRoutes('telegram');
      expect(routes).toHaveLength(2);
      expect(routes[0].path).toBe('/webhooks/telegram/update');
      expect(routes[1].path).toBe('/webhooks/telegram/verify');
    });

    it('deactivates before re-activating an already active plugin', async () => {
      const plugin = makePlugin('telegram');
      catalog.register(plugin);
      await catalog.activate('telegram', vi.fn());

      // Activate again — should stop then re-init
      await catalog.activate('telegram', vi.fn());

      expect(plugin.stop).toHaveBeenCalledTimes(1);
      expect(plugin.initialize).toHaveBeenCalledTimes(2);
      expect(plugin.start).toHaveBeenCalledTimes(2);
    });

    it('cleans up if initialize() throws', async () => {
      const plugin = makePlugin('telegram');
      (plugin.initialize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('init failed'));
      catalog.register(plugin);

      await expect(
        catalog.activate('telegram', vi.fn()),
      ).rejects.toThrow('init failed');

      // Plugin should NOT be considered active — deactivate should be a no-op
      expect(plugin.start).not.toHaveBeenCalled();
      // Subsequent deactivate should not call stop()
      await catalog.deactivate('telegram');
      expect(plugin.stop).not.toHaveBeenCalled();
    });

    it('context.onMessage forwards messages', async () => {
      const plugin = makePlugin('telegram');
      const onMessage = vi.fn().mockResolvedValue(undefined);
      catalog.register(plugin);

      await catalog.activate('telegram', onMessage);

      const ctx = (plugin.initialize as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelContext;
      const msg = { id: '1', channel: 'telegram' } as unknown as GatewayMessage;
      await ctx.onMessage(msg);

      expect(onMessage).toHaveBeenCalledWith(msg);
    });
  });

  describe('deactivate', () => {
    it('stops an active plugin', async () => {
      const plugin = makePlugin('telegram');
      catalog.register(plugin);
      await catalog.activate('telegram', vi.fn());

      await catalog.deactivate('telegram');

      expect(plugin.stop).toHaveBeenCalledTimes(1);
    });

    it('cleans up webhook routes on deactivation', async () => {
      const plugin = makePluginWithWebhooks('telegram');
      catalog.register(plugin);
      await catalog.activate('telegram', vi.fn());

      expect(catalog.getWebhookRoutes('telegram')).toHaveLength(2);

      await catalog.deactivate('telegram');

      expect(catalog.getWebhookRoutes('telegram')).toHaveLength(0);
    });

    it('is a no-op for unregistered plugins', async () => {
      await catalog.deactivate('nonexistent'); // should not throw
    });

    it('is a no-op for registered but never-activated plugins', async () => {
      const plugin = makePlugin('telegram');
      catalog.register(plugin);

      await catalog.deactivate('telegram');

      expect(plugin.stop).not.toHaveBeenCalled();
    });

    it('handles stop() errors gracefully', async () => {
      const plugin = makePlugin('telegram');
      (plugin.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stop failed'));
      catalog.register(plugin);
      await catalog.activate('telegram', vi.fn());

      // Should not throw
      await catalog.deactivate('telegram');
    });
  });

  describe('unregister', () => {
    it('deactivates and removes a plugin', async () => {
      const plugin = makePlugin('telegram');
      catalog.register(plugin);
      await catalog.activate('telegram', vi.fn());

      await catalog.unregister('telegram');

      expect(plugin.stop).toHaveBeenCalledTimes(1);
      expect(catalog.get('telegram')).toBeUndefined();
      expect(catalog.size).toBe(0);
    });
  });

  describe('getWebhookRoutes', () => {
    it('returns all routes when no channel specified', async () => {
      const tg = makePluginWithWebhooks('telegram');
      const dc = makePluginWithWebhooks('discord');
      catalog.register(tg);
      catalog.register(dc);
      await catalog.activate('telegram', vi.fn());
      await catalog.activate('discord', vi.fn());

      const allRoutes = catalog.getWebhookRoutes();
      expect(allRoutes).toHaveLength(4); // 2 per plugin
    });

    it('returns empty array for channel with no webhooks', () => {
      catalog.register(makePlugin('plain'));
      expect(catalog.getWebhookRoutes('plain')).toHaveLength(0);
    });
  });

  describe('getHealthStatus', () => {
    it('reports health with active flag for all plugins', () => {
      catalog.register(makePlugin('telegram', true));
      catalog.register(makePlugin('discord', false));

      const status = catalog.getHealthStatus();
      expect(status).toHaveLength(2);

      const tg = status.find((s) => s.name === 'telegram');
      const dc = status.find((s) => s.name === 'discord');
      expect(tg?.healthy).toBe(true);
      expect(tg?.active).toBe(false);
      expect(dc?.healthy).toBe(false);
      expect(dc?.active).toBe(false);
    });

    it('reports active: true for activated plugins', async () => {
      catalog.register(makePlugin('telegram', true));
      await catalog.activate('telegram', vi.fn());

      const status = catalog.getHealthStatus();
      const tg = status.find((s) => s.name === 'telegram');
      expect(tg?.active).toBe(true);
    });
  });

  describe('stopAll', () => {
    it('stops all active plugins concurrently', async () => {
      const tg = makePlugin('telegram');
      const dc = makePlugin('discord');
      catalog.register(tg);
      catalog.register(dc);
      await catalog.activate('telegram', vi.fn());
      await catalog.activate('discord', vi.fn());

      await catalog.stopAll();

      expect(tg.stop).toHaveBeenCalledTimes(1);
      expect(dc.stop).toHaveBeenCalledTimes(1);
    });

    it('does not block on one plugin failure', async () => {
      const tg = makePlugin('telegram');
      const dc = makePlugin('discord');
      (tg.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tg stop failed'));
      catalog.register(tg);
      catalog.register(dc);
      await catalog.activate('telegram', vi.fn());
      await catalog.activate('discord', vi.fn());

      await catalog.stopAll(); // should not throw

      expect(tg.stop).toHaveBeenCalledTimes(1);
      expect(dc.stop).toHaveBeenCalledTimes(1);
    });
  });
});

describe('BaseChannelPlugin', () => {
  class TestPlugin extends BaseChannelPlugin {
    readonly name = 'test';
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);

    // Expose protected getter for testing
    getContext(): ChannelContext {
      return this.context;
    }
  }

  it('initialize stores context', async () => {
    const plugin = new TestPlugin();
    const ctx: ChannelContext = {
      onMessage: vi.fn(),
      logger: silentLogger,
      config: { key: 'value' },
    };

    await plugin.initialize(ctx);

    expect(plugin.getContext()).toBe(ctx);
  });

  it('throws when context accessed before initialize()', () => {
    const plugin = new TestPlugin();

    expect(() => plugin.getContext()).toThrow('context accessed before initialize()');
  });

  it('isHealthy defaults to true', () => {
    const plugin = new TestPlugin();
    expect(plugin.isHealthy()).toBe(true);
  });

  it('implements ChannelPlugin interface', async () => {
    const plugin = new TestPlugin();
    const ctx: ChannelContext = {
      onMessage: vi.fn(),
      logger: silentLogger,
      config: {},
    };

    await plugin.initialize(ctx);
    await plugin.start();
    await plugin.stop();
    await plugin.send({} as OutboundMessage);

    expect(plugin.start).toHaveBeenCalledTimes(1);
    expect(plugin.stop).toHaveBeenCalledTimes(1);
    expect(plugin.send).toHaveBeenCalledTimes(1);
  });
});

describe('SlashCommandContext', () => {
  it('has required fields', () => {
    const ctx: SlashCommandContext = {
      args: 'model gpt-4',
      argv: ['model', 'gpt-4'],
      channel: 'telegram',
      senderId: 'user-1',
      sessionId: 'session-123',
      reply: vi.fn().mockResolvedValue(undefined),
    };

    expect(ctx.channel).toBe('telegram');
    expect(ctx.senderId).toBe('user-1');
    expect(ctx.sessionId).toBe('session-123');
    expect(ctx.args).toBe('model gpt-4');
    expect(typeof ctx.reply).toBe('function');
  });
});

describe('ReactionEvent', () => {
  it('uses boolean added field', () => {
    const addEvent: ReactionEvent = {
      channel: 'discord',
      senderId: 'user-1',
      messageId: 'msg-1',
      emoji: '👍',
      added: true,
    };

    const removeEvent: ReactionEvent = {
      channel: 'discord',
      senderId: 'user-1',
      messageId: 'msg-1',
      emoji: '👍',
      added: false,
    };

    expect(addEvent.added).toBe(true);
    expect(removeEvent.added).toBe(false);
  });

  it('supports optional timestamp', () => {
    const event: ReactionEvent = {
      channel: 'discord',
      senderId: 'user-1',
      messageId: 'msg-1',
      emoji: '👍',
      added: true,
      timestamp: 1700000000000,
    };

    expect(event.timestamp).toBe(1700000000000);
  });
});
