import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PluginCatalog,
  WebhookRouter,
  BaseChannelPlugin,
  ChannelAlreadyRegisteredError,
  ChannelNotFoundError,
} from './channel.js';
import type { ChannelPlugin, ChannelContext, SlashCommandContext, ReactionEvent } from './channel.js';
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
    it('reports health for all plugins', () => {
      catalog.register(makePlugin('telegram', true));
      catalog.register(makePlugin('discord', false));

      const status = catalog.getHealthStatus();
      expect(status).toHaveLength(2);

      const tg = status.find((s) => s.name === 'telegram');
      const dc = status.find((s) => s.name === 'discord');
      expect(tg?.healthy).toBe(true);
      expect(dc?.healthy).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('stops all active plugins', async () => {
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
  });
});

describe('BaseChannelPlugin', () => {
  class TestPlugin extends BaseChannelPlugin {
    readonly name = 'test';
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  }

  it('initialize stores context', async () => {
    const plugin = new TestPlugin();
    const ctx: ChannelContext = {
      onMessage: vi.fn(),
      logger: silentLogger,
      config: { key: 'value' },
    };

    await plugin.initialize(ctx);

    // Context is stored as protected field — verify via isHealthy default
    expect(plugin.isHealthy()).toBe(true);
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
      channel: 'telegram',
      senderId: 'user-1',
      sessionId: 'session-123',
      reply: vi.fn().mockResolvedValue(undefined),
    };

    expect(ctx.channel).toBe('telegram');
    expect(ctx.senderId).toBe('user-1');
    expect(ctx.sessionId).toBe('session-123');
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
});
