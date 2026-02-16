import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';

// ============================================================================
// Mock matrix-js-sdk
// ============================================================================

const mockStartClient = vi.fn();
const mockStopClient = vi.fn();
const mockSendTextMessage = vi.fn();
const mockJoinRoom = vi.fn();
const mockOn = vi.fn();
const mockGetSyncState = vi.fn();

vi.mock('matrix-js-sdk', () => {
  return {
    createClient: (_opts: unknown) => ({
      on: mockOn,
      startClient: mockStartClient,
      stopClient: mockStopClient,
      sendTextMessage: mockSendTextMessage,
      joinRoom: mockJoinRoom,
      getUserId: () => '@bot:matrix.org',
      getSyncState: mockGetSyncState,
    }),
  };
});

// Import after mock setup
import { MatrixChannel } from './plugin.js';

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

function makeMatrixEvent(overrides: Record<string, any> = {}): any {
  const content = {
    msgtype: 'm.text',
    body: 'hello',
    ...overrides.content,
  };
  return {
    getType: () => overrides.type ?? 'm.room.message',
    getSender: () => overrides.sender ?? '@alice:matrix.org',
    getContent: () => content,
    event: { origin_server_ts: Date.now() },
    ...overrides,
  };
}

function makeRoom(overrides: Record<string, any> = {}): any {
  return {
    roomId: '!room1:matrix.org',
    getJoinedMemberCount: () => 5,
    ...overrides,
  };
}

async function startedPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new MatrixChannel({
    homeserverUrl: 'https://matrix.org',
    accessToken: 'test-token',
    userId: '@bot:matrix.org',
    ...config,
  } as any);
  await plugin.initialize(ctx ?? makeContext());
  await plugin.start();
  return plugin;
}

// ============================================================================
// Tests
// ============================================================================

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartClient.mockResolvedValue(undefined);
    mockSendTextMessage.mockResolvedValue({});
    mockJoinRoom.mockResolvedValue({});
    mockGetSyncState.mockReturnValue('SYNCING');
  });

  // 1. Constructor and name
  it('stores config and has name "matrix"', () => {
    const plugin = new MatrixChannel({
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-token',
      userId: '@bot:matrix.org',
    });
    expect(plugin.name).toBe('matrix');
  });

  // 2. start() calls client.startClient()
  it('start() creates client and starts sync', async () => {
    await startedPlugin();
    expect(mockStartClient).toHaveBeenCalledWith({ initialSyncLimit: 0 });
  });

  // 3. Sync state → healthy
  it('sets healthy when sync state is PREPARED', async () => {
    const plugin = await startedPlugin();
    expect(plugin.isHealthy()).toBe(false);

    const syncHandler = getHandler('sync');
    syncHandler!('PREPARED');
    expect(plugin.isHealthy()).toBe(true);
  });

  // 4. Sync state SYNCING → healthy
  it('sets healthy when sync state is SYNCING', async () => {
    const plugin = await startedPlugin();
    const syncHandler = getHandler('sync');
    syncHandler!('SYNCING');
    expect(plugin.isHealthy()).toBe(true);
  });

  // 5. Sync state ERROR → unhealthy
  it('sets unhealthy when sync state is ERROR', async () => {
    const plugin = await startedPlugin();
    const syncHandler = getHandler('sync');
    syncHandler!('SYNCING');
    expect(plugin.isHealthy()).toBe(true);

    syncHandler!('ERROR');
    expect(plugin.isHealthy()).toBe(false);
  });

  // 6. stop() stops client
  it('stop() stops client and sets healthy to false', async () => {
    const plugin = await startedPlugin();
    const syncHandler = getHandler('sync');
    syncHandler!('SYNCING');

    await plugin.stop();

    expect(mockStopClient).toHaveBeenCalledOnce();
    expect(plugin.isHealthy()).toBe(false);
  });

  // 7. Room message → correct session ID (group)
  it('room message produces correct session ID', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom());

    expect(ctx.onMessage).toHaveBeenCalledOnce();
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('matrix:!room1:matrix.org:@alice:matrix.org');
    expect(gateway.scope).toBe('group');
  });

  // 8. DM detection via member count
  it('detects DM rooms via member count <= 2', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom({ getJoinedMemberCount: () => 2 }));

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('matrix:dm:@alice:matrix.org');
    expect(gateway.scope).toBe('dm');
  });

  // 9. Skips own messages
  it('skips messages from the bot itself', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent({ sender: '@bot:matrix.org' }), makeRoom());

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 10. Skips non-message events
  it('skips non-message events', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent({ type: 'm.room.member' }), makeRoom());

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 11. Room ID filtering
  it('rejects messages from non-allowed rooms', async () => {
    const ctx = makeContext();
    await startedPlugin({ roomIds: ['!other:matrix.org'] }, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom());

    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 12. Room ID filtering allows matching room
  it('allows messages from allowed rooms', async () => {
    const ctx = makeContext();
    await startedPlugin({ roomIds: ['!room1:matrix.org'] }, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom());

    expect(ctx.onMessage).toHaveBeenCalledOnce();
  });

  // 13. send() calls sendTextMessage
  it('send() sends text to the correct room', async () => {
    const plugin = await startedPlugin();

    await plugin.send({
      sessionId: 'matrix:!room1:matrix.org:@alice:matrix.org',
      content: 'Hello back!',
    });

    expect(mockSendTextMessage).toHaveBeenCalledWith('!room1:matrix.org', 'Hello back!');
  });

  // 14. send() warns when client is null
  it('send() warns when client is not connected', async () => {
    const ctx = makeContext();
    const plugin = new MatrixChannel({
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-token',
      userId: '@bot:matrix.org',
    });
    await plugin.initialize(ctx);

    await plugin.send({ sessionId: 'matrix:!room1:matrix.org:@alice:matrix.org', content: 'hi' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Matrix client is not connected'),
    );
  });

  // 15. send() warns on unresolvable session
  it('send() warns when room cannot be resolved from session', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    await plugin.send({ sessionId: 'matrix:dm:@alice:matrix.org', content: 'hi' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot resolve room'),
    );
  });

  // 16. Auto-join on invite
  it('auto-joins room on invite when autoJoin is enabled', async () => {
    await startedPlugin({ autoJoin: true });

    const handler = getHandler('RoomMember.membership');
    expect(handler).toBeDefined();

    await handler!(
      {},
      { userId: '@bot:matrix.org', membership: 'invite', roomId: '!new:matrix.org' },
    );

    expect(mockJoinRoom).toHaveBeenCalledWith('!new:matrix.org');
  });

  // 17. Auto-join ignores non-invite memberships
  it('ignores non-invite membership events', async () => {
    await startedPlugin({ autoJoin: true });

    const handler = getHandler('RoomMember.membership');
    await handler!(
      {},
      { userId: '@bot:matrix.org', membership: 'join', roomId: '!room:matrix.org' },
    );

    expect(mockJoinRoom).not.toHaveBeenCalled();
  });

  // 18. Auto-join ignores other users
  it('ignores membership events for other users', async () => {
    await startedPlugin({ autoJoin: true });

    const handler = getHandler('RoomMember.membership');
    await handler!(
      {},
      { userId: '@other:matrix.org', membership: 'invite', roomId: '!room:matrix.org' },
    );

    expect(mockJoinRoom).not.toHaveBeenCalled();
  });

  // 19. No membership handler when autoJoin disabled
  it('does not register membership handler when autoJoin is disabled', async () => {
    await startedPlugin({ autoJoin: false });

    const handler = getHandler('RoomMember.membership');
    expect(handler).toBeUndefined();
  });

  // 20. E2EE warning logged
  it('logs E2EE warning when enableE2ee is set', async () => {
    const ctx = makeContext();
    await startedPlugin({ enableE2ee: true }, ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('E2EE flag is set but actual crypto support requires @matrix-org/olm'),
    );
  });

  // 21. Image attachment normalized
  it('normalizes image attachments from m.image events', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(
      makeMatrixEvent({
        content: {
          msgtype: 'm.image',
          body: 'photo.jpg',
          url: 'mxc://matrix.org/abc123',
          info: { mimetype: 'image/jpeg', size: 2048 },
        },
      }),
      makeRoom(),
    );

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.attachments).toHaveLength(1);
    expect(gateway.attachments[0].type).toBe('image');
    expect(gateway.attachments[0].mimeType).toBe('image/jpeg');
    expect(gateway.attachments[0].url).toBe('mxc://matrix.org/abc123');
  });

  // 22. start() failure cleans up
  it('cleans up if startClient() fails', async () => {
    mockStartClient.mockRejectedValueOnce(new Error('connection failed'));

    const plugin = new MatrixChannel({
      homeserverUrl: 'https://matrix.org',
      accessToken: 'bad-token',
      userId: '@bot:matrix.org',
    });
    await plugin.initialize(makeContext());

    await expect(plugin.start()).rejects.toThrow('connection failed');
    expect(plugin.isHealthy()).toBe(false);
  });

  // 23. send() logs error on failure
  it('send() catches sendTextMessage failure and logs error', async () => {
    mockSendTextMessage.mockRejectedValueOnce(new Error('M_FORBIDDEN'));

    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    await plugin.send({
      sessionId: 'matrix:!room1:matrix.org:@alice:matrix.org',
      content: 'hello',
    });

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('M_FORBIDDEN'),
    );
  });

  // 24. Metadata includes Matrix-specific fields
  it('includes Matrix-specific metadata in gateway message', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom());

    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.metadata.roomId).toBe('!room1:matrix.org');
    expect(gateway.metadata.msgtype).toBe('m.text');
  });

  // 25. isHealthy() false before start
  it('isHealthy() returns false before start', () => {
    const plugin = new MatrixChannel({
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-token',
      userId: '@bot:matrix.org',
    });
    expect(plugin.isHealthy()).toBe(false);
  });

  // 26. Handler errors are caught and logged
  it('logs errors from timeline handler instead of crashing', async () => {
    const ctx = makeContext();
    (ctx.onMessage as any).mockRejectedValueOnce(new Error('downstream failure'));
    await startedPlugin({}, ctx);

    const handler = getHandler('Room.timeline');
    await handler!(makeMatrixEvent(), makeRoom());

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error handling Matrix timeline event: downstream failure'),
      );
    });
  });
});
