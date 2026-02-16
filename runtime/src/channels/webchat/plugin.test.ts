/**
 * Unit tests for WebChatChannel plugin.
 *
 * Tests session mapping, message normalization, send routing,
 * handler dispatch, error handling, and chat history/resume.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebChatChannel } from './plugin.js';
import type { WebChatDeps } from './types.js';
import type { ChannelContext } from '../../gateway/channel.js';
import type { ControlMessage, ControlResponse } from '../../gateway/types.js';
import { silentLogger } from '../../utils/logger.js';

// ============================================================================
// Test helpers
// ============================================================================

function createDeps(overrides?: Partial<WebChatDeps>): WebChatDeps {
  return {
    gateway: {
      getStatus: () => ({
        state: 'running',
        uptimeMs: 60_000,
        channels: ['webchat', 'telegram'],
        activeSessions: 2,
        controlPlanePort: 9100,
      }),
      config: { agent: { name: 'test-agent' } },
    },
    ...overrides,
  };
}

function createContext(overrides?: Partial<ChannelContext>): ChannelContext {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    logger: silentLogger,
    config: {},
    ...overrides,
  };
}

function msg(type: string, payload?: unknown, id?: string): ControlMessage {
  return { type: type as ControlMessage['type'], payload, id };
}

// ============================================================================
// Tests
// ============================================================================

describe('WebChatChannel', () => {
  let channel: WebChatChannel;
  let deps: WebChatDeps;
  let context: ChannelContext;

  beforeEach(async () => {
    deps = createDeps();
    context = createContext();
    channel = new WebChatChannel(deps);
    await channel.initialize(context);
    await channel.start();
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should report name as "webchat"', () => {
      expect(channel.name).toBe('webchat');
    });

    it('should be healthy after start', () => {
      expect(channel.isHealthy()).toBe(true);
    });

    it('should not be healthy after stop', async () => {
      await channel.stop();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Chat message handling
  // --------------------------------------------------------------------------

  describe('chat.message', () => {
    it('should deliver chat message to gateway pipeline', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'Hello agent!' }),
        send,
      );

      expect(context.onMessage).toHaveBeenCalledTimes(1);
      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      expect(gatewayMsg.channel).toBe('webchat');
      expect(gatewayMsg.content).toBe('Hello agent!');
      expect(gatewayMsg.senderId).toBe('client_1');
      expect(gatewayMsg.scope).toBe('dm');
    });

    it('should reject empty content', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: '' }),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
      expect(context.onMessage).not.toHaveBeenCalled();
    });

    it('should reject missing content', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    it('should create consistent session for same client', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'msg1' }),
        send,
      );
      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'msg2' }),
        send,
      );

      const calls = vi.mocked(context.onMessage).mock.calls;
      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it('should create different sessions for different clients', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'msg1' }),
        send,
      );
      channel.handleMessage(
        'client_2',
        'chat.message',
        msg('chat.message', { content: 'msg2' }),
        send,
      );

      const calls = vi.mocked(context.onMessage).mock.calls;
      expect(calls[0][0].sessionId).not.toBe(calls[1][0].sessionId);
    });
  });

  // --------------------------------------------------------------------------
  // Outbound (send)
  // --------------------------------------------------------------------------

  describe('send()', () => {
    it('should route outbound message to the correct client', async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // First send an inbound message to establish the session mapping
      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'Hello' }),
        send,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Now send outbound
      await channel.send({ sessionId, content: 'Hi back!' });

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chat.message',
          payload: expect.objectContaining({
            content: 'Hi back!',
            sender: 'agent',
          }),
        }),
      );
    });

    it('should not throw for unmapped session', async () => {
      // No prior messages — no session mapping
      await expect(
        channel.send({ sessionId: 'nonexistent', content: 'test' }),
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Chat history
  // --------------------------------------------------------------------------

  describe('chat.history', () => {
    it('should return empty history for new client', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.history',
        msg('chat.history', {}, 'req-1'),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chat.history',
          payload: [],
          id: 'req-1',
        }),
      );
    });

    it('should return chat history after messages', async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // Send a message to establish session and history
      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'Hello' }),
        send,
      );

      // Now request history
      channel.handleMessage(
        'client_1',
        'chat.history',
        msg('chat.history', { limit: 10 }, 'req-2'),
        send,
      );

      // Find the history response
      const historyCall = send.mock.calls.find(
        (call) => (call[0] as ControlResponse).type === 'chat.history',
      );
      expect(historyCall).toBeDefined();
      const response = historyCall![0] as ControlResponse;
      expect((response.payload as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // Chat resume
  // --------------------------------------------------------------------------

  describe('chat.resume', () => {
    it('should reject missing sessionId', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.resume',
        msg('chat.resume', {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    it('should reject unknown session', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.resume',
        msg('chat.resume', { sessionId: 'nonexistent' }),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    it('should resume an existing session', () => {
      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();

      // Client 1 creates a session with a message
      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'Hello' }),
        send1,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Client 2 resumes the session
      channel.handleMessage(
        'client_2',
        'chat.resume',
        msg('chat.resume', { sessionId }, 'req-3'),
        send2,
      );

      const resumeCall = send2.mock.calls.find(
        (call) => (call[0] as ControlResponse).type === ('chat.resumed' as string),
      );
      expect(resumeCall).toBeDefined();
      const response = resumeCall![0] as ControlResponse;
      expect((response.payload as Record<string, unknown>).sessionId).toBe(sessionId);
    });
  });

  // --------------------------------------------------------------------------
  // Status handler
  // --------------------------------------------------------------------------

  describe('status.get', () => {
    it('should return gateway status', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'status.get',
        msg('status.get', undefined, 'req-4'),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status.update',
          id: 'req-4',
          payload: expect.objectContaining({
            state: 'running',
            agentName: 'test-agent',
          }),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Subsystem handlers
  // --------------------------------------------------------------------------

  describe('subsystem handlers', () => {
    it('should handle skills.list', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'skills.list',
        msg('skills.list', undefined, 'req-5'),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'skills.list', payload: [] }),
      );
    });

    it('should handle tasks.list', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'tasks.list',
        msg('tasks.list', undefined, 'req-6'),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tasks.list', payload: [] }),
      );
    });

    it('should handle memory.sessions', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'memory.sessions',
        msg('memory.sessions', undefined, 'req-7'),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory.sessions', payload: [] }),
      );
    });

    it('should handle memory.search with missing query', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'memory.search',
        msg('memory.search', {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    it('should handle events.subscribe', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'events.subscribe',
        msg('events.subscribe'),
        send,
      );

      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('should return error for unknown dotted-namespace type', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'foo.bar',
        msg('foo.bar' as ControlMessage['type']),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.stringContaining('Unknown webchat message type'),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Client cleanup
  // --------------------------------------------------------------------------

  describe('removeClient', () => {
    it('should clean up client mappings', async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // Establish session
      channel.handleMessage(
        'client_1',
        'chat.message',
        msg('chat.message', { content: 'Hello' }),
        send,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Remove client
      channel.removeClient('client_1');

      // Outbound should silently fail (no client mapping)
      await expect(
        channel.send({ sessionId, content: 'test' }),
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Typing indicator
  // --------------------------------------------------------------------------

  describe('chat.typing', () => {
    it('should silently accept typing indicators', () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'chat.typing',
        msg('chat.typing', { active: true }),
        send,
      );

      // Should not send any response
      expect(send).not.toHaveBeenCalled();
    });
  });
});
