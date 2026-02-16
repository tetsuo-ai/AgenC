import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteGatewayClient } from './remote.js';
import type { RemoteGatewayState } from './remote-types.js';

// ============================================================================
// Mock ws module
// ============================================================================

let mockWsInstance: MockWs;

class MockWs {
  readonly url: string;
  readyState = 0; // CONNECTING
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3; // CLOSED
    this.trigger('close');
  });

  constructor(url: string) {
    this.url = url;
    mockWsInstance = this;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  trigger(event: string, ...args: unknown[]) {
    const list = this.handlers.get(event);
    if (list) {
      for (const h of list) h(...args);
    }
  }

  /** Simulate the WebSocket connection opening. */
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.trigger('open');
  }
}

vi.mock('ws', () => ({
  default: MockWs,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wait for async operations to complete.
 * Uses the real setTimeout saved before any test file can mock timers.
 */
const nativeSetTimeout = globalThis.setTimeout;
async function tick(): Promise<void> {
  await new Promise<void>((r) => nativeSetTimeout(r, 50));
}

/**
 * Start a connection and wait until MockWs is created + fires 'open'.
 */
async function connectAndOpen(client: RemoteGatewayClient): Promise<void> {
  void client.connect();
  await tick();
  mockWsInstance.simulateOpen();
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    url: 'ws://localhost:9100',
    token: 'test-token',
    reconnect: false, // Disable reconnect by default for cleaner tests
    ...overrides,
  };
}

function simulateAuthSuccess(sub = 'agent_001') {
  // The client sends auth on open; we respond with success
  const authMsg = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
  expect(authMsg.type).toBe('auth');
  mockWsInstance.trigger(
    'message',
    JSON.stringify({ type: 'auth', payload: { authenticated: true, sub } }),
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('RemoteGatewayClient', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockWsInstance = undefined as unknown as MockWs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in disconnected state', () => {
    const client = new RemoteGatewayClient(makeConfig());
    expect(client.state).toBe('disconnected');
  });

  it('transitions through connecting → authenticating → connected', async () => {
    const states: RemoteGatewayState[] = [];
    const client = new RemoteGatewayClient(makeConfig());
    client.on('stateChanged', (s) => states.push(s));

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(states).toContain('connecting');
    expect(states).toContain('authenticating');
    expect(states).toContain('connected');
    expect(client.state).toBe('connected');

    client.disconnect();
  });

  it('emits connected event on successful auth', async () => {
    const connected = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    client.on('connected', connected);

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(connected).toHaveBeenCalledTimes(1);

    client.disconnect();
  });

  it('emits authFailed when auth response has error', async () => {
    const authFailed = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    client.on('authFailed', authFailed);

    await connectAndOpen(client);

    // Simulate auth failure
    mockWsInstance.trigger(
      'message',
      JSON.stringify({ type: 'auth', error: 'Invalid or expired token' }),
    );

    expect(authFailed).toHaveBeenCalledWith('Invalid or expired token');
    expect(client.state).toBe('disconnected');
  });

  it('sends auth message with token on connect', async () => {
    const client = new RemoteGatewayClient(makeConfig({ token: 'my-jwt' }));

    await connectAndOpen(client);

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
    expect(msg.type).toBe('auth');
    expect(msg.payload.token).toBe('my-jwt');

    client.disconnect();
  });

  it('send() delivers when connected', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    await connectAndOpen(client);
    simulateAuthSuccess();

    client.send({ type: 'status' });

    // First call is auth, second is status
    expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
    const msg = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
    expect(msg.type).toBe('status');

    client.disconnect();
  });

  it('send() queues when disconnected', () => {
    const client = new RemoteGatewayClient(makeConfig());

    client.send({ type: 'status' });

    expect(client.queueSize).toBe(1);
  });

  it('flushes offline queue on connect', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    // Queue messages before connecting
    client.send({ type: 'msg1' });
    client.send({ type: 'msg2' });
    expect(client.queueSize).toBe(2);

    await connectAndOpen(client);
    simulateAuthSuccess();

    // Auth + 2 flushed messages
    expect(mockWsInstance.send).toHaveBeenCalledTimes(3);
    expect(client.queueSize).toBe(0);

    client.disconnect();
  });

  it('drops oldest when offline queue exceeds max size', () => {
    const client = new RemoteGatewayClient(makeConfig({ maxOfflineQueueSize: 3 }));

    client.send({ type: 'a' });
    client.send({ type: 'b' });
    client.send({ type: 'c' });
    client.send({ type: 'd' }); // Should drop 'a'

    expect(client.queueSize).toBe(3);
  });

  it('sendMessage() is a convenience wrapper', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    await connectAndOpen(client);
    simulateAuthSuccess();

    client.sendMessage('hello agent');

    const msg = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
    expect(msg.type).toBe('chat.message');
    expect(msg.payload.content).toBe('hello agent');

    client.disconnect();
  });

  it('disconnect stops connection and goes to disconnected', async () => {
    const disconnected = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    client.on('disconnected', disconnected);

    await connectAndOpen(client);
    simulateAuthSuccess();

    client.disconnect();

    expect(client.state).toBe('disconnected');
  });

  it('emits message events for non-auth messages', async () => {
    const onMessage = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    client.on('message', onMessage);

    await connectAndOpen(client);
    simulateAuthSuccess();

    mockWsInstance.trigger(
      'message',
      JSON.stringify({ type: 'status', payload: { state: 'running' } }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toEqual({ type: 'status', payload: { state: 'running' } });

    client.disconnect();
  });

  it('emits error events on ws errors', async () => {
    const onError = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    client.on('error', onError);

    await connectAndOpen(client);

    mockWsInstance.trigger('error', new Error('connection refused'));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('connection refused');

    client.disconnect();
  });

  it('switchGateway disconnects and reconnects to new URL', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(client.state).toBe('connected');

    // Switch to new gateway — reset instance tracker
    mockWsInstance = undefined as unknown as MockWs;
    const switchPromise = client.switchGateway('ws://other:9200', 'new-token');
    await tick();
    mockWsInstance.simulateOpen();

    // New WS instance created with new URL
    expect(mockWsInstance.url).toBe('ws://other:9200');

    // Simulate auth on new connection
    const authMsg = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
    expect(authMsg.payload.token).toBe('new-token');
    mockWsInstance.trigger(
      'message',
      JSON.stringify({ type: 'auth', payload: { authenticated: true } }),
    );

    await switchPromise;
    expect(client.state).toBe('connected');

    client.disconnect();
  });

  it('on() returns a dispose function', async () => {
    const handler = vi.fn();
    const client = new RemoteGatewayClient(makeConfig());
    const dispose = client.on('connected', handler);

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(handler).toHaveBeenCalledTimes(1);

    dispose();

    // Reconnecting should not trigger handler again
    client.disconnect();
    mockWsInstance = undefined as unknown as MockWs;
    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(handler).toHaveBeenCalledTimes(1);

    client.disconnect();
  });

  it('transitions to reconnecting on unexpected close when reconnect=true', async () => {
    const stateChanges: RemoteGatewayState[] = [];
    const client = new RemoteGatewayClient(makeConfig({ reconnect: true }));
    client.on('stateChanged', (s) => stateChanges.push(s));

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(client.state).toBe('connected');

    // Simulate unexpected close by triggering the close handler directly.
    // Override close() to prevent the MockWs close from calling trigger recursively.
    mockWsInstance.close = vi.fn();
    mockWsInstance.trigger('close');

    expect(client.state).toBe('reconnecting');
    expect(stateChanges).toContain('reconnecting');

    client.disconnect(); // Stop reconnect loop
  });

  it('does not reconnect when reconnect=false', async () => {
    const client = new RemoteGatewayClient(makeConfig({ reconnect: false }));

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(client.state).toBe('connected');

    // Simulate unexpected close
    mockWsInstance.close = vi.fn();
    mockWsInstance.trigger('close');

    expect(client.state).toBe('disconnected');
  });

  it('clearQueue empties the offline queue', () => {
    const client = new RemoteGatewayClient(makeConfig());

    client.send({ type: 'a' });
    client.send({ type: 'b' });
    expect(client.queueSize).toBe(2);

    client.clearQueue();
    expect(client.queueSize).toBe(0);
  });

  it('clears offline queue on auth failure', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    // Queue messages before connecting
    client.send({ type: 'queued' });
    expect(client.queueSize).toBe(1);

    await connectAndOpen(client);

    // Simulate auth failure
    mockWsInstance.trigger(
      'message',
      JSON.stringify({ type: 'auth', error: 'bad token' }),
    );

    expect(client.queueSize).toBe(0);
  });

  it('connect is idempotent when already connected', async () => {
    const client = new RemoteGatewayClient(makeConfig());

    await connectAndOpen(client);
    simulateAuthSuccess();

    expect(client.state).toBe('connected');

    // Second connect should be a no-op — no additional state changes
    await client.connect();
    expect(client.state).toBe('connected');

    client.disconnect();
  });
});
