import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext } from '../../gateway/channel.js';
import { EventEmitter } from 'node:events';
import type { Writable, Readable } from 'node:stream';

// ============================================================================
// Mock node:child_process and node:fs/promises
// ============================================================================

const mockStdinWrite = vi.fn();
const mockKill = vi.fn();

class MockChildProcess extends EventEmitter {
  stdin = { writable: true, write: mockStdinWrite } as unknown as Writable;
  stdout = new EventEmitter() as unknown as Readable;
  stderr = new EventEmitter() as unknown as Readable;
  kill = mockKill;
}

let mockChild: MockChildProcess;

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, _args: string[], _opts: unknown) => {
    mockChild = new MockChildProcess();
    return mockChild;
  },
}));

const mockAccess = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
  constants: { X_OK: 1 },
}));

// Import after mock setup
import { SignalChannel } from './plugin.js';

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

async function startedPlugin(config: Record<string, any> = {}, ctx?: ChannelContext) {
  const plugin = new SignalChannel({
    phoneNumber: '+15551234567',
    ...config,
  } as any);
  await plugin.initialize(ctx ?? makeContext());
  await plugin.start();
  return plugin;
}

function simulateMessage(msg: object): void {
  (mockChild.stdout as EventEmitter).emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
}

function makeIncomingMessage(overrides: Record<string, any> = {}): object {
  return {
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      envelope: {
        source: '+15559876543',
        sourceName: 'Bob',
        dataMessage: {
          message: 'hello from signal',
          timestamp: 1234567890000,
          ...overrides.dataMessage,
        },
        ...overrides.envelope,
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockKill.mockImplementation(() => {
      // Simulate exit after kill
      setTimeout(() => mockChild?.emit('exit', 0, null), 10);
    });
  });

  // 1. Constructor and name
  it('stores config and has name "signal"', () => {
    const plugin = new SignalChannel({ phoneNumber: '+15551234567' });
    expect(plugin.name).toBe('signal');
  });

  // 2. isHealthy() false before start
  it('isHealthy() returns false before start', () => {
    const plugin = new SignalChannel({ phoneNumber: '+15551234567' });
    expect(plugin.isHealthy()).toBe(false);
  });

  // 3. start() validates binary exists
  it('start() validates signal-cli binary exists', async () => {
    mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

    const plugin = new SignalChannel({ phoneNumber: '+15551234567' });
    await plugin.initialize(makeContext());

    await expect(plugin.start()).rejects.toThrow('signal-cli binary not found');
  });

  // 4. start() sets healthy = true
  it('start() sets healthy to true after spawning', async () => {
    const plugin = await startedPlugin();
    expect(plugin.isHealthy()).toBe(true);
  });

  // 5. Incoming message → correct session ID
  it('incoming message produces correct session ID', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    simulateMessage(makeIncomingMessage());

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.sessionId).toBe('signal:+15559876543');
    expect(gateway.scope).toBe('dm');
    expect(gateway.senderName).toBe('Bob');
    expect(gateway.content).toBe('hello from signal');
  });

  // 6. Group message → scope 'group'
  it('group message produces scope "group"', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    simulateMessage(makeIncomingMessage({
      dataMessage: {
        message: 'group msg',
        groupInfo: { groupId: 'abc123' },
      },
    }));

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.scope).toBe('group');
    expect(gateway.metadata.groupId).toBe('abc123');
  });

  // 7. Phone number filtering
  it('rejects messages from non-allowed numbers', async () => {
    const ctx = makeContext();
    await startedPlugin({ allowedNumbers: ['+15551111111'] }, ctx);

    simulateMessage(makeIncomingMessage());

    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 8. Phone number filtering allows matching
  it('allows messages from allowed numbers', async () => {
    const ctx = makeContext();
    await startedPlugin({ allowedNumbers: ['+15559876543'] }, ctx);

    simulateMessage(makeIncomingMessage());

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
  });

  // 9. send() writes JSON-RPC to stdin
  it('send() writes JSON-RPC message to stdin', async () => {
    const plugin = await startedPlugin();

    await plugin.send({
      sessionId: 'signal:+15559876543',
      content: 'Hello back!',
    });

    expect(mockStdinWrite).toHaveBeenCalledOnce();
    const written = JSON.parse(mockStdinWrite.mock.calls[0][0].replace('\n', ''));
    expect(written.method).toBe('send');
    expect(written.params.recipient).toEqual(['+15559876543']);
    expect(written.params.message).toBe('Hello back!');
  });

  // 10. send() warns when process is null
  it('send() warns when process is not running', async () => {
    const ctx = makeContext();
    const plugin = new SignalChannel({ phoneNumber: '+15551234567' });
    await plugin.initialize(ctx);

    await plugin.send({ sessionId: 'signal:+15559876543', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('signal-cli process is not running'),
    );
  });

  // 11. send() warns when session not resolvable
  it('send() warns when phone cannot be extracted from session', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);

    await plugin.send({ sessionId: 'invalid', content: 'hello' });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot resolve phone'),
    );
  });

  // 12. stop() kills process
  it('stop() terminates the process and sets healthy to false', async () => {
    const plugin = await startedPlugin();
    expect(plugin.isHealthy()).toBe(true);

    await plugin.stop();

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    expect(plugin.isHealthy()).toBe(false);
  });

  // 13. Process exit sets unhealthy
  it('process exit sets healthy to false', async () => {
    const ctx = makeContext();
    const plugin = await startedPlugin({}, ctx);
    expect(plugin.isHealthy()).toBe(true);

    mockChild.emit('exit', 1, null);

    expect(plugin.isHealthy()).toBe(false);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('signal-cli process exited'),
    );
  });

  // 14. Non-JSON lines are logged at debug level
  it('handles non-JSON stdout lines gracefully', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    (mockChild.stdout as EventEmitter).emit('data', Buffer.from('not json\n'));

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Non-JSON line'),
    );
  });

  // 15. stderr is logged as warnings
  it('logs stderr output as warnings', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    (mockChild.stderr as EventEmitter).emit('data', Buffer.from('warning message'));

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('signal-cli stderr: warning message'),
    );
  });

  // 16. Messages without dataMessage are ignored
  it('ignores messages without dataMessage', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    simulateMessage({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: { source: '+15559876543' },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.onMessage).not.toHaveBeenCalled();
  });

  // 17. Metadata includes Signal-specific fields
  it('includes Signal-specific metadata in gateway message', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    simulateMessage(makeIncomingMessage());

    await vi.waitFor(() => {
      expect(ctx.onMessage).toHaveBeenCalledOnce();
    });
    const gateway = (ctx.onMessage as any).mock.calls[0][0];
    expect(gateway.metadata.phone).toBe('+15559876543');
    expect(gateway.metadata.timestamp).toBe(1234567890000);
  });

  // 18. Handler errors are caught and logged
  it('logs errors from message handler instead of crashing', async () => {
    const ctx = makeContext();
    (ctx.onMessage as any).mockRejectedValueOnce(new Error('downstream failure'));
    await startedPlugin({}, ctx);

    simulateMessage(makeIncomingMessage());

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error handling Signal message: downstream failure'),
      );
    });
  });

  // 19. Process error event is handled
  it('handles process error events', async () => {
    const ctx = makeContext();
    await startedPlugin({}, ctx);

    mockChild.emit('error', new Error('spawn ENOENT'));

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('signal-cli process error: spawn ENOENT'),
    );
  });
});
