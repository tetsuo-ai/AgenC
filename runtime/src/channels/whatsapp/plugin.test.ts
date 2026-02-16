import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';

// ============================================================================
// Mock @whiskeysockets/baileys
// ============================================================================

const mockSendMessage = vi.fn();
const mockEnd = vi.fn();
const mockEvOn = vi.fn();

vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: (_opts: unknown) => ({
      ev: { on: mockEvOn },
      sendMessage: mockSendMessage,
      end: mockEnd,
    }),
    useMultiFileAuthState: async (_path: string) => ({
      state: {},
      saveCreds: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

// Import after mock setup
import { WhatsAppChannel } from './plugin.js';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    config: {},
    ...overrides,
  };
}

function getEvHandler(event: string): ((...args: any[]) => void) | undefined {
  for (const call of mockEvOn.mock.calls) {
    if (call[0] === event) return call[1] as (...args: any[]) => void;
  }
  return undefined;
}

function makeBaileysMessage(overrides: Record<string, any> = {}): any {
  return {
    key: {
      remoteJid: '5511999999999@s.whatsapp.net',
      fromMe: false,
      id: 'msg-001',
      ...overrides.key,
    },
    message: {
      conversation: 'hello',
      ...overrides.message,
    },
    pushName: 'Alice',
    ...overrides,
  };
}

async function startedBaileysPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new WhatsAppChannel({
    mode: 'baileys',
    sessionPath: '/tmp/test-session',
    ...config,
  } as any);
  await plugin.initialize(ctx ?? makeContext());
  await plugin.start();
  return plugin;
}

function startedBusinessPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new WhatsAppChannel({
    mode: 'business-api',
    phoneNumberId: 'phone-123',
    accessToken: 'test-token',
    webhookVerifyToken: 'verify-token',
    ...config,
  } as any);
  const context = ctx ?? makeContext();
  // initialize + start synchronously for business-api
  return plugin.initialize(context).then(() => plugin.start()).then(() => ({ plugin, context }));
}

// ============================================================================
// Tests
// ============================================================================

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({});
  });

  // 1. Constructor and name
  it('stores config and has name "whatsapp"', () => {
    const plugin = new WhatsAppChannel({ mode: 'baileys' });
    expect(plugin.name).toBe('whatsapp');
  });

  // 2. isHealthy() false before start
  it('isHealthy() returns false before start', () => {
    const plugin = new WhatsAppChannel({ mode: 'baileys' });
    expect(plugin.isHealthy()).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Baileys mode
  // --------------------------------------------------------------------------

  // 3. Baileys start wires event handlers
  it('baileys start() wires event handlers', async () => {
    await startedBaileysPlugin();

    const events = mockEvOn.mock.calls.map((c) => c[0]);
    expect(events).toContain('connection.update');
    expect(events).toContain('messages.upsert');
    expect(events).toContain('creds.update');
  });

  // 4. Baileys connection.update → healthy
  it('baileys sets healthy when connection opens', async () => {
    const plugin = await startedBaileysPlugin();

    const handler = getEvHandler('connection.update');
    handler!({ connection: 'open' });

    expect(plugin.isHealthy()).toBe(true);
  });

  // 5. Baileys connection close → unhealthy
  it('baileys sets unhealthy when connection closes', async () => {
    const plugin = await startedBaileysPlugin();

    const handler = getEvHandler('connection.update');
    handler!({ connection: 'open' });
    expect(plugin.isHealthy()).toBe(true);

    handler!({ connection: 'close' });
    expect(plugin.isHealthy()).toBe(false);
  });

  // 6. Baileys message → correct session ID
  it('baileys message produces correct session ID', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage()] });

    // Allow async handler to fire
    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('whatsapp:5511999999999@s.whatsapp.net');
    expect(gateway.scope).toBe('dm');
    expect(gateway.senderName).toBe('Alice');
    expect(gateway.content).toBe('hello');
  });

  // 7. Baileys skips own messages
  it('baileys skips own messages', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage({ key: { fromMe: true } })] });

    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 8. Baileys phone number filtering
  it('baileys rejects messages from non-allowed numbers', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({ allowedNumbers: ['1234567890'] }, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage()] });

    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 9. Baileys allows matching numbers
  it('baileys allows messages from allowed numbers', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({ allowedNumbers: ['5511999999999'] }, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage()] });

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
  });

  // 10. Baileys send
  it('baileys send() sends message via socket', async () => {
    const ctx = makeContext();
    const plugin = await startedBaileysPlugin({}, ctx);

    // Trigger inbound to populate session map
    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage()] });
    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });

    await plugin.send({
      sessionId: 'whatsapp:5511999999999@s.whatsapp.net',
      content: 'Hello back!',
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      { text: 'Hello back!' },
    );
  });

  // 11. stop() cleans up socket
  it('stop() ends socket and sets healthy to false', async () => {
    const plugin = await startedBaileysPlugin();

    const handler = getEvHandler('connection.update');
    handler!({ connection: 'open' });
    expect(plugin.isHealthy()).toBe(true);

    await plugin.stop();

    expect(mockEnd).toHaveBeenCalledOnce();
    expect(plugin.isHealthy()).toBe(false);
  });

  // 12. Baileys image attachment
  it('baileys normalizes image attachments', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({
      messages: [makeBaileysMessage({
        message: {
          imageMessage: {
            url: 'https://example.com/image.jpg',
            mimetype: 'image/jpeg',
            fileLength: 2048,
            caption: 'Check this out',
          },
        },
      })],
    });

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.content).toBe('Check this out');
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].type).toBe('image');
    expect(gateway.attachments[0].mimeType).toBe('image/jpeg');
  });

  // 13. Baileys extendedTextMessage
  it('baileys handles extendedTextMessage', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({
      messages: [makeBaileysMessage({
        message: { extendedTextMessage: { text: 'quoted reply' } },
      })],
    });

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.content).toBe('quoted reply');
  });

  // 14. send() warns when session not found
  it('send() warns when session cannot be resolved', async () => {
    const ctx = makeContext();
    const plugin = await startedBaileysPlugin({}, ctx);

    await plugin.send({ sessionId: 'whatsapp:unknown', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot resolve target'),
    );
  });

  // 15. Baileys message handler error logging
  it('baileys logs errors from message handler', async () => {
    const ctx = makeContext();
    (ctx.onMessage as any).mockRejectedValueOnce(new Error('downstream failure'));
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [makeBaileysMessage()] });

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error handling WhatsApp message: downstream failure'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Business API mode
  // --------------------------------------------------------------------------

  // 16. Business API start sets healthy
  it('business-api start() sets healthy immediately', async () => {
    const { plugin } = await startedBusinessPlugin();
    expect(plugin.isHealthy()).toBe(true);
  });

  // 17. Business API missing config throws
  it('business-api throws when phoneNumberId is missing', async () => {
    const plugin = new WhatsAppChannel({
      mode: 'business-api',
    } as any);
    await plugin.initialize(makeContext());

    await expect(plugin.start()).rejects.toThrow('phoneNumberId and accessToken');
  });

  // 18. Business API webhook verification
  it('business-api webhook verification succeeds with correct token', async () => {
    const { plugin } = await startedBusinessPlugin();

    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    const verifyRoute = routes.find((r) => r.path === '/verify');
    expect(verifyRoute).toBeDefined();

    const result = await verifyRoute!.handler({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'challenge-123',
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('challenge-123');
  });

  // 19. Business API webhook verification rejects bad token
  it('business-api webhook rejects incorrect verify token', async () => {
    const { plugin } = await startedBusinessPlugin();

    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    const verifyRoute = routes.find((r) => r.path === '/verify');
    const result = await verifyRoute!.handler({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-123',
      },
    });
    expect(result.status).toBe(403);
  });

  // 20. Business API incoming webhook processes messages
  it('business-api processes incoming webhook messages', async () => {
    const { plugin, context } = await startedBusinessPlugin();

    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    const incomingRoute = routes.find((r) => r.path === '/incoming');
    await incomingRoute!.handler({
      body: {
        entry: [{
          changes: [{
            value: {
              messages: [{
                from: '5511999999999',
                id: 'wamid.123',
                type: 'text',
                text: { body: 'hello from business api' },
                timestamp: '1234567890',
              }],
              contacts: [{
                profile: { name: 'Bob' },
                wa_id: '5511999999999',
              }],
            },
          }],
        }],
      },
    });

    expect(context.onMessage).toHaveBeenCalledOnce();
    const gateway = (context.onMessage as any).mock.calls[0][0];
    expect(gateway.content).toBe('hello from business api');
    expect(gateway.senderName).toBe('Bob');
    expect(gateway.sessionId).toBe('whatsapp:5511999999999@s.whatsapp.net');
  });

  // 21. Business API send uses fetch
  it('business-api send() calls the WhatsApp API', async () => {
    const { plugin, context } = await startedBusinessPlugin();

    // Populate session map via webhook
    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    const incomingRoute = routes.find((r) => r.path === '/incoming');
    await incomingRoute!.handler({
      body: {
        entry: [{
          changes: [{
            value: {
              messages: [{
                from: '5511999999999',
                id: 'wamid.123',
                type: 'text',
                text: { body: 'hi' },
                timestamp: '1234567890',
              }],
              contacts: [],
            },
          }],
        }],
      },
    });

    // Mock fetch for send
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.456' }] }), { status: 200 }),
    );

    await plugin.send({
      sessionId: 'whatsapp:5511999999999@s.whatsapp.net',
      content: 'reply',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('phone-123/messages'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  // 22. Business API phone number filtering
  it('business-api filters messages by allowedNumbers', async () => {
    const { plugin, context } = await startedBusinessPlugin({ allowedNumbers: ['1234567890'] });

    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    const incomingRoute = routes.find((r) => r.path === '/incoming');
    await incomingRoute!.handler({
      body: {
        entry: [{
          changes: [{
            value: {
              messages: [{
                from: '5511999999999',
                id: 'wamid.123',
                type: 'text',
                text: { body: 'filtered' },
                timestamp: '1234567890',
              }],
              contacts: [],
            },
          }],
        }],
      },
    });

    expect(context.onMessage).not.toHaveBeenCalled();
  });

  // 23. No webhooks registered for baileys mode
  it('baileys mode does not register webhooks', async () => {
    const plugin = await startedBaileysPlugin();

    const routes: Array<{ method: string; path: string; handler: Function }> = [];
    const mockRouter = {
      get: (path: string, handler: Function) => routes.push({ method: 'GET', path, handler }),
      post: (path: string, handler: Function) => routes.push({ method: 'POST', path, handler }),
      route: vi.fn(),
    };
    plugin.registerWebhooks!(mockRouter as any);

    expect(routes).toHaveLength(0);
  });

  // 24. Baileys skips messages without message field
  it('baileys skips messages without message content', async () => {
    const ctx = makeContext();
    await startedBaileysPlugin({}, ctx);

    const handler = getEvHandler('messages.upsert');
    await handler!({ messages: [{ key: { remoteJid: '123@s.whatsapp.net', fromMe: false } }] });

    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.onMessage).not.toHaveBeenCalled();
  });
});
