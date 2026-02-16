import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';

// ============================================================================
// Mock @slack/bolt
// ============================================================================

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockMessageHandler = vi.fn();
const mockPostMessage = vi.fn();
const mockUsersInfo = vi.fn();

vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      start = mockStart;
      stop = mockStop;
      client = {
        chat: { postMessage: mockPostMessage },
        users: { info: mockUsersInfo },
      };
      private messageHandlers: Array<(args: any) => Promise<void>> = [];

      message(handler: (args: any) => Promise<void>) {
        this.messageHandlers.push(handler);
        mockMessageHandler(handler);
      }

      // Expose for tests
      get _messageHandlers() { return this.messageHandlers; }
    },
  };
});

// Import after mock setup
import { SlackChannel } from './plugin.js';

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

function getMessageHandler(): ((args: any) => Promise<void>) | undefined {
  return mockMessageHandler.mock.calls[0]?.[0];
}

function makeSlackMessage(overrides: Record<string, any> = {}): any {
  return {
    text: 'hello',
    user: 'U123',
    channel: 'C456',
    ts: '1234567890.123456',
    channel_type: 'channel',
    team: 'T789',
    ...overrides,
  };
}

async function startedPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new SlackChannel({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    ...config,
  } as any);
  await plugin.initialize(ctx ?? makeContext());
  await plugin.start();
  return plugin;
}

// ============================================================================
// Tests
// ============================================================================

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStart.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
    mockPostMessage.mockResolvedValue({ ok: true });
    mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice', name: 'alice' } });
  });

  // 1. Constructor and name
  it('stores config and has name "slack"', () => {
    const plugin = new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    });
    expect(plugin.name).toBe('slack');
  });

  // 2. start() calls app.start()
  it('start() initializes and starts the Slack app', async () => {
    await startedPlugin();
    expect(mockStart).toHaveBeenCalledOnce();
  });

  // 3. start() sets healthy = true
  it('start() sets healthy to true', async () => {
    const plugin = await startedPlugin();
    expect(plugin.isHealthy()).toBe(true);
  });

  // 4. stop() calls app.stop() and resets state
  it('stop() stops the app and sets healthy to false', async () => {
    const plugin = await startedPlugin();
    expect(plugin.isHealthy()).toBe(true);

    await plugin.stop();

    expect(mockStop).toHaveBeenCalledOnce();
    expect(plugin.isHealthy()).toBe(false);
  });

  // 5. isHealthy() false before start
  it('isHealthy() returns false before start', () => {
    const plugin = new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    });
    expect(plugin.isHealthy()).toBe(false);
  });

  // 6. Channel message → correct session ID
  it('channel message produces correct session ID', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    expect(ctx.onMessage).toHaveBeenCalledOnce();
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('slack:T789:C456:U123');
    expect(gateway.scope).toBe('group');
  });

  // 7. DM message → session ID slack:dm:<userId>
  it('DM message produces session ID slack:dm:<userId>', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ channel_type: 'im' }) });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('slack:dm:U123');
    expect(gateway.scope).toBe('dm');
  });

  // 8. Thread message → scope 'thread'
  it('thread message produces scope "thread"', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({
      message: makeSlackMessage({ thread_ts: '1234567890.000000' }),
    });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.scope).toBe('thread');
  });

  // 9. Bot messages are skipped
  it('skips bot messages', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ bot_id: 'B123' }) });

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 10. Subtype messages are skipped
  it('skips subtype messages', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ subtype: 'channel_join' }) });

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 11. Channel ID filtering
  it('rejects messages from non-allowed channels', async () => {
    const ctx = makeContext();
    await startedPlugin({ channelIds: ['C999'] }, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ channel: 'C456' }) });

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 12. Channel ID filtering allows matching channel
  it('allows messages from allowed channels', async () => {
    const ctx = makeContext();
    await startedPlugin({ channelIds: ['C456'] }, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    expect(ctx.onMessage).toHaveBeenCalledOnce();
  });

  // 13. send() posts message via Web API
  it('send() posts message to correct channel', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    // Trigger inbound to populate session map
    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    await plugin.send({
      sessionId: 'slack:T789:C456:U123',
      content: 'Hello back!',
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C456',
      text: 'Hello back!',
    });
  });

  // 14. send() with useThreads replies in thread
  it('send() replies in thread when useThreads is enabled', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({ useThreads: true }, ctx);

    // Trigger inbound thread message to populate session map
    const handler = getMessageHandler();
    await handler!({
      message: makeSlackMessage({ thread_ts: '111.222' }),
    });

    await plugin.send({
      sessionId: 'slack:T789:C456:U123',
      content: 'Thread reply',
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C456',
      text: 'Thread reply',
      thread_ts: '111.222',
    });
  });

  // 15. send() warns when client is null
  it('send() warns when client is not connected', async () => {
    const ctx = makeContext();
    const plugin = new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    });
    await plugin.initialize(ctx);

    await plugin.send({ sessionId: 'slack:dm:U123', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Slack client is not connected'),
    );
  });

  // 16. send() warns when session not found
  it('send() warns when session cannot be resolved', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    await plugin.send({ sessionId: 'slack:dm:UNKNOWN', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot resolve channel'),
    );
  });

  // 17. User name resolution via users.info
  it('resolves user display name via Slack API', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.senderName).toBe('Alice');
  });

  // 18. User name resolution fallback
  it('falls back to userId when users.info fails', async () => {
    mockUsersInfo.mockRejectedValueOnce(new Error('user_not_found'));

    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.senderName).toBe('U123');
  });

  // 19. File attachments normalized correctly
  it('normalizes file attachments correctly', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({
      message: makeSlackMessage({
        files: [
          {
            url_private: 'https://files.slack.com/image.png',
            mimetype: 'image/png',
            name: 'image.png',
            size: 1024,
          },
        ],
      }),
    });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].type).toBe('image');
    expect(gateway.attachments[0].mimeType).toBe('image/png');
    expect(gateway.attachments[0].filename).toBe('image.png');
  });

  // 20. Oversized attachments filtered
  it('filters oversized attachments', async () => {
    const ctx = makeContext();
    await startedPlugin({ maxAttachmentBytes: 1000 }, ctx);

    const handler = getMessageHandler();
    await handler!({
      message: makeSlackMessage({
        files: [
          { url_private: 'https://files.slack.com/small.txt', mimetype: 'text/plain', name: 'small.txt', size: 500 },
          { url_private: 'https://files.slack.com/large.bin', mimetype: 'application/octet-stream', name: 'large.bin', size: 5000 },
        ],
      }),
    });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].filename).toBe('small.txt');
  });

  // 21. Messages without user field are skipped
  it('skips messages with no user field', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ user: undefined }) });

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 22. start() failure cleans up
  it('cleans up if start() fails', async () => {
    mockStart.mockRejectedValueOnce(new Error('connection failed'));

    const plugin = new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    });
    await plugin.initialize(makeContext());

    await expect(plugin.start()).rejects.toThrow('connection failed');
    expect(plugin.isHealthy()).toBe(false);
  });

  // 23. stop() clears session map
  it('stop() clears session mappings', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    // Populate session map
    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    await plugin.stop();

    // After stop, send should fail to resolve
    await plugin.start();
    await plugin.send({ sessionId: 'slack:T789:C456:U123', content: 'hi' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot resolve channel'),
    );
  });

  // 24. send() error is caught and logged
  it('send() catches postMessage failure and logs error', async () => {
    mockPostMessage.mockRejectedValueOnce(new Error('rate_limited'));

    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    // Populate session map
    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage() });

    await plugin.send({
      sessionId: 'slack:T789:C456:U123',
      content: 'hello',
    });

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rate_limited'),
    );
  });

  // 25. Metadata includes Slack-specific fields
  it('includes Slack-specific metadata in gateway message', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    await handler!({ message: makeSlackMessage({ thread_ts: '111.222' }) });

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.metadata.slackTs).toBe('1234567890.123456');
    expect(gateway.metadata.threadTs).toBe('111.222');
    expect(gateway.metadata.teamId).toBe('T789');
    expect(gateway.metadata.channelId).toBe('C456');
  });

  // 26. Message handler errors are caught and logged
  it('logs errors from message handler instead of crashing', async () => {
    const ctx = makeContext();
    (ctx.onMessage as any).mockRejectedValueOnce(new Error('downstream failure'));
    await startedPlugin({}, ctx);

    const handler = getMessageHandler();
    // Should not throw
    await handler!({ message: makeSlackMessage() });

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error handling Slack message: downstream failure'),
    );
  });
});
