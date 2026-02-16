import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';

// ============================================================================
// Mock discord.js
// ============================================================================

const mockLogin = vi.fn();
const mockDestroy = vi.fn();
const mockOn = vi.fn();
const mockChannelsFetch = vi.fn();
const mockRestPut = vi.fn();
const mockRestSetToken = vi.fn();

let mockGuildsCache: Map<string, unknown>;

vi.mock('discord.js', () => {
  mockGuildsCache = new Map([['guild-1', { id: 'guild-1' }]]);

  return {
    Client: class MockClient {
      login = mockLogin;
      destroy = mockDestroy;
      on = mockOn;
      channels = { fetch: mockChannelsFetch };
      guilds = { cache: mockGuildsCache };
      user = { setActivity: vi.fn() };
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      GuildMessageReactions: 4,
      MessageContent: 8,
      DirectMessages: 16,
    },
    ChannelType: {
      DM: 1,
      GuildText: 0,
    },
    REST: class MockREST {
      setToken = mockRestSetToken;
      put = mockRestPut;
      constructor(_opts: unknown) {}
    },
    Routes: {
      applicationGuildCommands: (appId: string, guildId: string) =>
        `/applications/${appId}/guilds/${guildId}/commands`,
      applicationCommands: (appId: string) =>
        `/applications/${appId}/commands`,
    },
    SlashCommandBuilder: class MockSlashCommandBuilder {
      private data: Record<string, unknown> = {};
      setName(name: string) { this.data.name = name; return this; }
      setDescription(desc: string) { this.data.description = desc; return this; }
      addStringOption(fn: (opt: unknown) => unknown) {
        const opt = {
          setName(n: string) { opt._name = n; return opt; },
          setDescription(d: string) { opt._desc = d; return opt; },
          setRequired(r: boolean) { opt._req = r; return opt; },
          _name: '', _desc: '', _req: false,
        };
        fn(opt);
        return this;
      }
      toJSON() { return { ...this.data }; }
    },
  };
});

// Import after mock setup
import { DiscordChannel } from './plugin.js';

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

function getHandler(event: string): ((...args: any[]) => void) | undefined {
  for (const call of mockOn.mock.calls) {
    if (call[0] === event) return call[1] as (...args: any[]) => void;
  }
  return undefined;
}

function makeDMMessage(overrides: Record<string, any> = {}): any {
  return {
    id: 'msg-1',
    content: 'hello',
    author: { id: 'user-1', username: 'alice', bot: false },
    channelId: 'dm-chan-1',
    guildId: null,
    channel: { type: 1, id: 'dm-chan-1', send: vi.fn() },
    attachments: new Map(),
    ...overrides,
  };
}

function makeGuildMessage(overrides: Record<string, any> = {}): any {
  return {
    id: 'msg-2',
    content: 'hi guild',
    author: { id: 'user-2', username: 'bob', bot: false },
    channelId: 'chan-100',
    guildId: 'guild-1',
    channel: { type: 0, id: 'chan-100', send: vi.fn() },
    attachments: new Map(),
    ...overrides,
  };
}

function makeThreadMessage(overrides: Record<string, any> = {}): any {
  return {
    id: 'msg-3',
    content: 'thread msg',
    author: { id: 'user-3', username: 'carol', bot: false },
    channelId: 'thread-200',
    guildId: 'guild-1',
    channel: { type: 11, id: 'thread-200', send: vi.fn() },
    attachments: new Map(),
    ...overrides,
  };
}

async function startedPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new DiscordChannel({
    botToken: 'tok',
    applicationId: 'app-1',
    ...config,
  });
  await plugin.initialize(ctx ?? makeContext());
  await plugin.start();
  return plugin;
}

// ============================================================================
// Tests
// ============================================================================

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockResolvedValue('token');
    mockRestPut.mockResolvedValue(undefined);
  });

  // 1. Constructor stores config, name === 'discord'
  it('stores config and has name "discord"', () => {
    const plugin = new DiscordChannel({
      botToken: 'tok',
      applicationId: 'app-1',
    });

    expect(plugin.name).toBe('discord');
  });

  // 2. start() calls client.login(botToken)
  it('start() logs in with bot token', async () => {
    const plugin = new DiscordChannel({
      botToken: 'my-token',
      applicationId: 'app-1',
    });
    await plugin.initialize(makeContext());
    await plugin.start();

    expect(mockLogin).toHaveBeenCalledWith('my-token');
  });

  // 3. stop() calls client.destroy(), isHealthy() → false
  it('stop() destroys client and sets healthy to false', async () => {
    const plugin = await startedPlugin();

    // Simulate ready event
    const readyHandler = getHandler('ready');
    readyHandler!();
    expect(plugin.isHealthy()).toBe(true);

    await plugin.stop();

    expect(mockDestroy).toHaveBeenCalledOnce();
    expect(plugin.isHealthy()).toBe(false);
  });

  // 4. DM message → session ID discord:dm:<userId>
  it('DM message produces session ID discord:dm:<userId>', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeDMMessage());

    expect(ctx.onMessage).toHaveBeenCalledOnce();
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('discord:dm:user-1');
    expect(gateway.scope).toBe('dm');
  });

  // 5. Server message → session ID discord:<guildId>:<channelId>:<userId>
  it('server message produces correct session ID', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeGuildMessage());

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('discord:guild-1:chan-100:user-2');
    expect(gateway.scope).toBe('group');
  });

  // 6. Thread message → scope 'thread' and correct session ID
  it('thread message produces scope "thread" and correct session ID', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeThreadMessage());

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('discord:guild-1:thread-200:user-3');
    expect(gateway.scope).toBe('thread');
  });

  // 7. allowedGuilds filter rejects unauthorized guild
  it('rejects messages from non-allowed guilds', async () => {
    const ctx = makeContext();
    await startedPlugin({ allowedGuilds: ['guild-99'] }, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeGuildMessage({ guildId: 'guild-1' }));

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 8. allowedChannels filter rejects unauthorized channel
  it('rejects messages from non-allowed channels', async () => {
    const ctx = makeContext();
    await startedPlugin({ allowedChannels: ['chan-999'] }, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeGuildMessage({ channelId: 'chan-100' }));

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 9. send() calls channel.send() with content
  it('send() resolves channel and sends content', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    mockChannelsFetch.mockResolvedValue({ id: 'chan-100', send: mockSend });

    const plugin = await startedPlugin();

    await plugin.send({
      sessionId: 'discord:guild-1:chan-100:user-2',
      content: 'Hello back!',
    });

    expect(mockChannelsFetch).toHaveBeenCalledWith('chan-100');
    expect(mockSend).toHaveBeenCalledWith({ content: 'Hello back!' });
  });

  // 10. send() splits long messages into chunks under 2000 chars
  it('send() splits long messages at line boundaries', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    mockChannelsFetch.mockResolvedValue({ id: 'chan-100', send: mockSend });

    const plugin = await startedPlugin();

    // Build a message with two 1500-char "paragraphs" separated by newline (3001 total)
    const paragraph = 'x'.repeat(1500);
    const longContent = `${paragraph}\n${paragraph}`;

    await plugin.send({
      sessionId: 'discord:guild-1:chan-100:user-2',
      content: longContent,
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].content).toBe(paragraph);
    expect(mockSend.mock.calls[1][0].content).toBe(paragraph);
  });

  // 11. Reaction events forwarded with metadata, senderName from user object
  it('forwards reaction events with metadata', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('messageReactionAdd');
    await handler!(
      {
        emoji: { name: '\u{1F44D}', id: null },
        message: { id: 'target-msg-1', channelId: 'chan-100', guildId: 'guild-1' },
      },
      { id: 'user-5', username: 'frank' },
    );

    expect(ctx.onMessage).toHaveBeenCalledOnce();
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.metadata.isReaction).toBe(true);
    expect(gateway.metadata.emoji).toBe('\u{1F44D}');
    expect(gateway.metadata.reactionAdded).toBe(true);
    expect(gateway.metadata.targetMessageId).toBe('target-msg-1');
    expect(gateway.senderName).toBe('frank');
  });

  // 12. Reaction senderName falls back to 'unknown' when username absent
  it('reaction senderName falls back to "unknown"', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('messageReactionAdd');
    await handler!(
      {
        emoji: { name: 'fire', id: null },
        message: { id: 'msg-99', channelId: 'chan-100', guildId: 'guild-1' },
      },
      { id: 'user-6' }, // no username field
    );

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.senderName).toBe('unknown');
  });

  // 13. Image attachment normalized with type: 'image', correct mimeType
  it('normalizes image attachments correctly', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const attachments = new Map([
      ['att-1', {
        url: 'https://cdn.discord.com/image.png',
        contentType: 'image/png',
        name: 'image.png',
        size: 1024,
      }],
    ]);

    const handler = getHandler('messageCreate');
    await handler!(makeDMMessage({ attachments }));

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].type).toBe('image');
    expect(gateway.attachments[0].mimeType).toBe('image/png');
    expect(gateway.attachments[0].filename).toBe('image.png');
    expect(gateway.attachments[0].sizeBytes).toBe(1024);
  });

  // 14. isHealthy() returns false before start, true when healthy flag set
  it('isHealthy() reflects connection state', async () => {
    const plugin = new DiscordChannel({
      botToken: 'tok',
      applicationId: 'app-1',
    });

    expect(plugin.isHealthy()).toBe(false);

    await plugin.initialize(makeContext());
    await plugin.start();

    // Not yet ready
    expect(plugin.isHealthy()).toBe(false);

    // Simulate ready
    const readyHandler = getHandler('ready');
    readyHandler!();
    expect(plugin.isHealthy()).toBe(true);
  });

  // 15. allowDMs: false blocks DM messages
  it('blocks DM messages when allowDMs is false', async () => {
    const ctx = makeContext();
    await startedPlugin({ allowDMs: false }, ctx);

    const handler = getHandler('messageCreate');
    await handler!(makeDMMessage());

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 16. Slash commands registered via ready handler
  it('registers slash commands on ready event', async () => {
    await startedPlugin();

    // Trigger ready event — this is where registerSlashCommands is called
    const readyHandler = getHandler('ready');
    readyHandler!();

    // Allow async registration to complete
    await vi.waitFor(() => {
      expect(mockRestSetToken).toHaveBeenCalledWith('tok');
    });

    expect(mockRestPut).toHaveBeenCalledWith(
      '/applications/app-1/guilds/guild-1/commands',
      expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({ name: 'ask' }),
          expect.objectContaining({ name: 'status' }),
          expect.objectContaining({ name: 'task' }),
        ]),
      }),
    );
  });

  // 17. Oversized attachments are filtered during normalization
  it('filters oversized attachments', async () => {
    const ctx = makeContext();
    await startedPlugin({ maxAttachmentBytes: 1000 }, ctx);

    const attachments = new Map([
      ['small', {
        url: 'https://cdn.discord.com/small.txt',
        contentType: 'text/plain',
        name: 'small.txt',
        size: 500,
      }],
      ['large', {
        url: 'https://cdn.discord.com/large.bin',
        contentType: 'application/octet-stream',
        name: 'large.bin',
        size: 5000,
      }],
    ]);

    const handler = getHandler('messageCreate');
    await handler!(makeDMMessage({ attachments }));

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].filename).toBe('small.txt');
  });

  // 18. /ask interaction forwards user input as regular message
  it('handles /ask interaction by forwarding input as message', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const mockReply = vi.fn().mockResolvedValue(undefined);
    const handler = getHandler('interactionCreate');
    await handler!({
      isCommand: () => true,
      commandName: 'ask',
      options: { getString: (name: string) => name === 'input' ? 'What is AgenC?' : null },
      user: { id: 'user-10', username: 'dave' },
      guildId: 'guild-1',
      channelId: 'chan-100',
      reply: mockReply,
    });

    expect(mockReply).toHaveBeenCalledWith({ content: 'Processing...' });
    expect(ctx.onMessage).toHaveBeenCalledOnce();
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.content).toBe('What is AgenC?');
    expect(gateway.sessionId).toBe('discord:guild-1:chan-100:user-10');
  });

  // 19. /status interaction forwards as slash command message
  it('handles /status interaction by forwarding as /status command', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const mockReply = vi.fn().mockResolvedValue(undefined);
    const handler = getHandler('interactionCreate');
    await handler!({
      isCommand: () => true,
      commandName: 'status',
      options: { getString: () => null },
      user: { id: 'user-11', username: 'eve' },
      guildId: null,
      channelId: 'dm-chan-5',
      reply: mockReply,
    });

    expect(mockReply).toHaveBeenCalledWith({ content: 'Running /status...' });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.content).toBe('/status');
    expect(gateway.sessionId).toBe('discord:dm:user-11');
    expect(gateway.scope).toBe('dm');
  });

  // 20. stop() clears sessionChannels map
  it('stop() clears session channel mappings', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    // Trigger a DM to populate sessionChannels
    const handler = getHandler('messageCreate');
    await handler!(makeDMMessage());

    // Now send() should work for DM (channel stored)
    const mockSend = vi.fn().mockResolvedValue(undefined);
    mockChannelsFetch.mockResolvedValue({ id: 'dm-chan-1', send: mockSend });
    await plugin.send({ sessionId: 'discord:dm:user-1', content: 'hi' });
    expect(mockChannelsFetch).toHaveBeenCalledWith('dm-chan-1');

    mockChannelsFetch.mockClear();

    // After stop(), session mapping should be cleared
    await plugin.stop();

    // Restart and try to send to same DM — should fail to resolve (no stored mapping)
    await plugin.start();
    await plugin.send({ sessionId: 'discord:dm:user-1', content: 'hi again' });

    // channels.fetch should NOT have been called (no stored channelId)
    expect(mockChannelsFetch).not.toHaveBeenCalled();
  });

  // 21. start() cleans up client on login failure
  it('cleans up client if login fails', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid token'));

    const plugin = new DiscordChannel({
      botToken: 'bad-token',
      applicationId: 'app-1',
    });
    await plugin.initialize(makeContext());

    await expect(plugin.start()).rejects.toThrow('Invalid token');
    expect(mockDestroy).toHaveBeenCalledOnce();
    expect(plugin.isHealthy()).toBe(false);
  });

  // 22. error event handler logs errors without crashing
  it('handles client error events', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('error');
    expect(handler).toBeDefined();
    handler!(new Error('WebSocket error'));

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Discord client error: WebSocket error'),
    );
  });

  // 23. shardDisconnect sets healthy to false
  it('shardDisconnect sets healthy to false', async () => {
    const plugin = await startedPlugin();

    // Set healthy via ready
    const readyHandler = getHandler('ready');
    readyHandler!();
    expect(plugin.isHealthy()).toBe(true);

    // Disconnect
    const disconnectHandler = getHandler('shardDisconnect');
    disconnectHandler!();
    expect(plugin.isHealthy()).toBe(false);

    // Reconnect via shardReady
    const shardReadyHandler = getHandler('shardReady');
    shardReadyHandler!();
    expect(plugin.isHealthy()).toBe(true);
  });

  // 24. send() warns when client is null
  it('send() warns when client is not connected', async () => {
    const ctx = makeContext();
    const plugin = new DiscordChannel({
      botToken: 'tok',
      applicationId: 'app-1',
    });
    await plugin.initialize(ctx);

    // Don't start — client is null
    await plugin.send({ sessionId: 'discord:dm:user-1', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Discord client is not connected'),
    );
  });

  // 25. send() logs error and stops on channel.send() failure
  it('send() catches channel.send() failure and logs error', async () => {
    const mockSend = vi.fn()
      .mockRejectedValueOnce(new Error('Rate limited'));
    mockChannelsFetch.mockResolvedValue({ id: 'chan-100', send: mockSend });

    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    await plugin.send({
      sessionId: 'discord:guild-1:chan-100:user-2',
      content: 'hello',
    });

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Rate limited'),
    );
  });

  // 27. Handler errors are caught and logged, not silently swallowed
  it('logs errors from event handlers instead of swallowing', async () => {
    const ctx = makeContext();
    (ctx.onMessage as any).mockRejectedValueOnce(new Error('downstream failure'));
    await startedPlugin({}, ctx);

    const handler = getHandler('messageCreate');
    // This should not throw — error is caught and logged
    await handler!(makeDMMessage());

    // Wait for the .catch to fire
    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error handling messageCreate: downstream failure'),
      );
    });
  });

  // 28. Global command registration fallback when no guilds in cache
  it('falls back to global command registration when guild cache empty', async () => {
    // Clear guild cache
    mockGuildsCache.clear();

    await startedPlugin();

    // Trigger ready to fire registerSlashCommands
    const readyHandler = getHandler('ready');
    readyHandler!();

    await vi.waitFor(() => {
      expect(mockRestPut).toHaveBeenCalledWith(
        '/applications/app-1/commands',
        expect.objectContaining({
          body: expect.arrayContaining([
            expect.objectContaining({ name: 'ask' }),
          ]),
        }),
      );
    });

    // Restore for other tests
    mockGuildsCache.set('guild-1', { id: 'guild-1' });
  });
});
