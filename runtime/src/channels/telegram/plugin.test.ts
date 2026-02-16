import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';
import { WebhookRouter } from '../../gateway/channel.js';
import { silentLogger } from '../../utils/logger.js';
import { deriveSessionId } from '../../gateway/session.js';
import { DEFAULT_WORKSPACE_ID } from '../../gateway/workspace.js';
import { RuntimeError } from '../../types/errors.js';
import type { TelegramChannelConfig } from './types.js';

// ============================================================================
// Grammy mock
// ============================================================================

const mockApi = {
  getUpdates: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn().mockResolvedValue({}),
  sendPhoto: vi.fn().mockResolvedValue({}),
  sendVoice: vi.fn().mockResolvedValue({}),
  sendDocument: vi.fn().mockResolvedValue({}),
  getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
  setWebhook: vi.fn().mockResolvedValue(true),
  deleteWebhook: vi.fn().mockResolvedValue(true),
};

vi.mock('grammy', () => ({
  Bot: class MockBot {
    api = mockApi;
    constructor(_token: string) {}
  },
}));

// Import after mocking
import { TelegramChannel } from './plugin.js';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(configOverrides: Partial<TelegramChannelConfig> = {}): ChannelContext {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    logger: silentLogger,
    config: {
      botToken: 'test-bot-token',
      ...configOverrides,
    } as unknown as Readonly<Record<string, unknown>>,
  };
}

function makeUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1001,
    message: {
      message_id: 42,
      from: { id: 123456, first_name: 'Alice', last_name: 'Smith', username: 'alice' },
      chat: { id: 789, type: 'private' },
      text: 'hello bot',
      date: 1700000000,
      ...overrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('TelegramChannel', () => {
  let plugin: TelegramChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    plugin = new TelegramChannel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // 1. initialize() extracts and merges config from context.config
  // --------------------------------------------------------------------------
  it('initialize() extracts and merges config from context.config', async () => {
    const ctx = makeContext({ pollingIntervalMs: 500 });
    await plugin.initialize(ctx);

    // Verify the plugin can start (config was extracted properly)
    mockApi.getUpdates.mockResolvedValueOnce([]);
    await plugin.start();
    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 2. start() in polling mode begins update polling
  // --------------------------------------------------------------------------
  it('start() in polling mode begins update polling', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    mockApi.getUpdates.mockResolvedValueOnce([]);
    await plugin.start();

    // Give the async polling loop a tick to run
    await vi.advanceTimersByTimeAsync(50);

    expect(mockApi.getUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, timeout: 25 }),
    );

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 3. start() in webhook mode calls setWebhook with correct URL
  // --------------------------------------------------------------------------
  it('start() in webhook mode calls setWebhook with correct URL', async () => {
    const ctx = makeContext({
      webhook: { url: 'https://example.com', port: 8443, secretToken: 'secret123' },
    });
    await plugin.initialize(ctx);
    await plugin.start();

    expect(mockApi.setWebhook).toHaveBeenCalledWith(
      'https://example.com/update',
      { secret_token: 'secret123' },
    );

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 4. stop() stops polling, clears timer, clears maps
  // --------------------------------------------------------------------------
  it('stop() stops polling, clears timer, clears maps', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    // Start polling — first call returns an update to populate maps
    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    // Verify onMessage was called (maps were populated)
    expect(ctx.onMessage).toHaveBeenCalled();

    await plugin.stop();

    // After stop, send should fail because maps were cleared
    await expect(plugin.send({ sessionId: 'any', content: 'test' })).rejects.toThrow(
      /No chat mapping/,
    );
  });

  // --------------------------------------------------------------------------
  // 5. Inbound text → correct GatewayMessage
  // --------------------------------------------------------------------------
  it('inbound text creates correct GatewayMessage with senderName, sessionId, scope', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);

    const msg = onMessage.mock.calls[0][0];
    expect(msg.channel).toBe('telegram');
    expect(msg.senderId).toBe('123456');
    expect(msg.senderName).toBe('Alice Smith');
    expect(msg.content).toBe('hello bot');
    expect(msg.scope).toBe('dm');
    expect(msg.sessionId).toMatch(/^session:/);
    expect(msg.metadata).toMatchObject({ chatId: 789, messageId: 42, chatType: 'private' });

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 6. Inbound voice → attachment {type: 'audio', mimeType: 'audio/ogg'}
  // --------------------------------------------------------------------------
  it('inbound voice → audio attachment', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    mockApi.getFile.mockResolvedValueOnce({ file_path: 'voice/file_42.oga' });
    const update = makeUpdate({ text: undefined, voice: { file_id: 'voice_123', duration: 5 } });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const msg = onMessage.mock.calls[0][0];
    expect(msg.content).toBe('');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({
      type: 'audio',
      mimeType: 'audio/ogg',
      url: expect.stringContaining('file/bottest-bot-token/voice/file_42.oga'),
    });

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 7. Inbound photo → attachment {type: 'image', mimeType: 'image/jpeg'} (largest size)
  // --------------------------------------------------------------------------
  it('inbound photo → image attachment (uses largest size)', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    const update = makeUpdate({
      text: undefined,
      caption: 'nice pic',
      photo: [
        { file_id: 'small', width: 90, height: 90 },
        { file_id: 'medium', width: 320, height: 320 },
        { file_id: 'large', width: 800, height: 800 },
      ],
    });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const msg = onMessage.mock.calls[0][0];
    expect(msg.content).toBe('nice pic');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].type).toBe('image');
    expect(msg.attachments[0].mimeType).toBe('image/jpeg');

    // Should have requested the largest photo
    expect(mockApi.getFile).toHaveBeenCalledWith('large');

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 8. Inbound document → attachment {type: 'file', mimeType, filename}
  // --------------------------------------------------------------------------
  it('inbound document → file attachment with mimeType and filename', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    const update = makeUpdate({
      text: undefined,
      caption: 'my doc',
      document: { file_id: 'doc_1', file_name: 'report.pdf', mime_type: 'application/pdf' },
    });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const msg = onMessage.mock.calls[0][0];
    expect(msg.content).toBe('my doc');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({
      type: 'file',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 9. Allowed users filter rejects unauthorized user
  // --------------------------------------------------------------------------
  it('allowed users filter rejects unauthorized user', async () => {
    const ctx = makeContext({ allowedUsers: [999] });
    await plugin.initialize(ctx);

    const update = makeUpdate(); // from.id = 123456, not in [999]
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(ctx.onMessage).not.toHaveBeenCalled();

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 10. Empty/undefined allowedUsers allows all
  // --------------------------------------------------------------------------
  it('empty/undefined allowedUsers allows all', async () => {
    const ctx = makeContext({ allowedUsers: [] });
    await plugin.initialize(ctx);

    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(ctx.onMessage).toHaveBeenCalledTimes(1);

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 11. send() delivers text to correct chatId
  // --------------------------------------------------------------------------
  it('send() delivers text to correct chatId', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    // Receive a message first to populate sessionToChatId
    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const sessionId = onMessage.mock.calls[0][0].sessionId;

    await plugin.send({ sessionId, content: 'reply text' });

    expect(mockApi.sendMessage).toHaveBeenCalledWith(789, 'reply text');

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 12. send() with image attachment calls sendPhoto
  // --------------------------------------------------------------------------
  it('send() with image attachment calls sendPhoto', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    // Receive a message to populate mapping
    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const sessionId = onMessage.mock.calls[0][0].sessionId;

    await plugin.send({
      sessionId,
      content: '',
      attachments: [{ type: 'image', mimeType: 'image/png', url: 'https://example.com/img.png' }],
    });

    expect(mockApi.sendPhoto).toHaveBeenCalledWith(789, 'https://example.com/img.png');

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 13. Rate limiting: second rapid send() waits then succeeds (or throws after retry)
  // --------------------------------------------------------------------------
  it('rate limiting: rapid sends are rate-limited', async () => {
    const ctx = makeContext({ rateLimitPerChat: 1 });
    await plugin.initialize(ctx);

    const update = makeUpdate();
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const sessionId = onMessage.mock.calls[0][0].sessionId;

    // First send should succeed
    await plugin.send({ sessionId, content: 'first' });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);

    // Second rapid send — should wait (1000ms for 1 msg/sec) then succeed
    const sendPromise = plugin.send({ sessionId, content: 'second' });
    await vi.advanceTimersByTimeAsync(1100);
    await sendPromise;

    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 14. isHealthy() returns false after getUpdates error
  // --------------------------------------------------------------------------
  it('isHealthy() returns false after getUpdates error', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    expect(plugin.isHealthy()).toBe(true);

    mockApi.getUpdates.mockRejectedValueOnce(new Error('network error'));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(plugin.isHealthy()).toBe(false);

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 15. Message starting with / forwarded via onMessage as-is (slash commands)
  // --------------------------------------------------------------------------
  it('message starting with / forwarded via onMessage as-is', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    const update = makeUpdate({ text: '/start some args' });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe('/start some args');

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 16. Session ID deterministic via deriveSessionId with per-channel-peer
  // --------------------------------------------------------------------------
  it('session ID is deterministic via deriveSessionId with per-channel-peer scope', async () => {
    const ctx = makeContext();
    await plugin.initialize(ctx);

    // Send the same user twice
    const update1 = makeUpdate();
    const update2 = { ...makeUpdate(), update_id: 1002 };
    mockApi.getUpdates.mockResolvedValueOnce([update1, update2]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(2);

    const sessionId1 = onMessage.mock.calls[0][0].sessionId;
    const sessionId2 = onMessage.mock.calls[1][0].sessionId;
    expect(sessionId1).toBe(sessionId2);

    // Verify it matches direct deriveSessionId call
    const expected = deriveSessionId(
      {
        channel: 'telegram',
        senderId: '123456',
        scope: 'dm',
        workspaceId: DEFAULT_WORKSPACE_ID,
        guildId: '789',
      },
      'per-channel-peer',
    );
    expect(sessionId1).toBe(expected);

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 17. maxAttachmentBytes enforcement — oversized file skipped
  // --------------------------------------------------------------------------
  it('maxAttachmentBytes enforcement: oversized file is skipped', async () => {
    const ctx = makeContext({ maxAttachmentBytes: 1024 }); // 1 KB limit
    await plugin.initialize(ctx);

    // getFile returns a file exceeding the limit
    mockApi.getFile.mockResolvedValueOnce({ file_path: 'docs/big.pdf', file_size: 2048 });
    const update = makeUpdate({
      text: undefined,
      document: { file_id: 'doc_big', file_name: 'big.pdf', mime_type: 'application/pdf' },
    });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);

    const msg = onMessage.mock.calls[0][0];
    // Attachment should be skipped due to size limit
    expect(msg.attachments).toBeUndefined();
    // Error should be recorded in metadata
    expect(msg.metadata.attachmentError).toMatch(/exceeds.*limit/);

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // 18. maxAttachmentBytes enforcement — file within limit passes
  // --------------------------------------------------------------------------
  it('maxAttachmentBytes enforcement: file within limit passes through', async () => {
    const ctx = makeContext({ maxAttachmentBytes: 4096 }); // 4 KB limit
    await plugin.initialize(ctx);

    mockApi.getFile.mockResolvedValueOnce({ file_path: 'docs/small.pdf', file_size: 1024 });
    const update = makeUpdate({
      text: undefined,
      document: { file_id: 'doc_small', file_name: 'small.pdf', mime_type: 'application/pdf' },
    });
    mockApi.getUpdates.mockResolvedValueOnce([update]);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(50);

    const onMessage = ctx.onMessage as ReturnType<typeof vi.fn>;
    const msg = onMessage.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].url).toContain('docs/small.pdf');

    await plugin.stop();
  });

  // --------------------------------------------------------------------------
  // Webhook handler tests
  // --------------------------------------------------------------------------
  describe('registerWebhooks', () => {
    it('registers POST /update and GET /verify routes', () => {
      const router = new WebhookRouter('telegram');
      plugin.registerWebhooks(router);

      expect(router.routes).toHaveLength(2);
      expect(router.routes[0].method).toBe('POST');
      expect(router.routes[0].path).toBe('/webhooks/telegram/update');
      expect(router.routes[1].method).toBe('GET');
      expect(router.routes[1].path).toBe('/webhooks/telegram/verify');
    });
  });
});
