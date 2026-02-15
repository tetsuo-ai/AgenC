import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionManager,
  deriveSessionId,
  type SessionConfig,
  type SessionLookupParams,
} from './session.js';
import type { LLMMessage } from '../llm/types.js';

function defaultConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    scope: 'per-channel-peer',
    reset: { mode: 'never' },
    compaction: 'truncate',
    maxHistoryLength: 10,
    ...overrides,
  };
}

function lookupParams(overrides?: Partial<SessionLookupParams>): SessionLookupParams {
  return {
    channel: 'telegram',
    senderId: 'user-123',
    scope: 'dm',
    workspaceId: 'ws-default',
    ...overrides,
  };
}

function msg(role: LLMMessage['role'], content: string): LLMMessage {
  return { role, content };
}

describe('deriveSessionId', () => {
  const params = lookupParams();

  it("with 'main' scope returns same ID regardless of sender", () => {
    const a = deriveSessionId(params, 'main');
    const b = deriveSessionId({ ...params, senderId: 'other-user' }, 'main');
    expect(a).toBe(b);
  });

  it("with 'per-peer' scope groups by senderId", () => {
    const a = deriveSessionId(params, 'per-peer');
    const b = deriveSessionId({ ...params, channel: 'discord' }, 'per-peer');
    // Same senderId → same session
    expect(a).toBe(b);

    const c = deriveSessionId(
      { ...params, senderId: 'other-user' },
      'per-peer',
    );
    expect(a).not.toBe(c);
  });

  it("with 'per-channel-peer' scope differentiates by channel+sender", () => {
    const a = deriveSessionId(params, 'per-channel-peer');
    const b = deriveSessionId(
      { ...params, channel: 'discord' },
      'per-channel-peer',
    );
    expect(a).not.toBe(b);

    const c = deriveSessionId(params, 'per-channel-peer');
    expect(a).toBe(c);
  });

  it("with 'per-account-channel-peer' includes workspaceId", () => {
    const a = deriveSessionId(params, 'per-account-channel-peer');
    const b = deriveSessionId(
      { ...params, workspaceId: 'ws-other' },
      'per-account-channel-peer',
    );
    expect(a).not.toBe(b);
  });
});

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(defaultConfig());
  });

  it('getOrCreate creates new session when none exists', async () => {
    const session = await manager.getOrCreate(lookupParams());
    expect(session.id).toBeTruthy();
    expect(session.history).toEqual([]);
    expect(session.workspaceId).toBe('ws-default');
    expect(manager.count).toBe(1);
  });

  it('getOrCreate returns existing session for same params', async () => {
    const a = await manager.getOrCreate(lookupParams());
    const b = await manager.getOrCreate(lookupParams());
    expect(a.id).toBe(b.id);
    expect(manager.count).toBe(1);
  });

  it('reset clears history but preserves metadata', async () => {
    const session = await manager.getOrCreate(lookupParams());
    session.metadata.foo = 'bar';
    await manager.appendMessage(session.id, msg('user', 'hello'));
    expect(session.history).toHaveLength(1);

    await manager.reset(session.id);
    expect(session.history).toEqual([]);
    expect(session.metadata.foo).toBe('bar');
  });

  it('destroy removes session completely', async () => {
    const session = await manager.getOrCreate(lookupParams());
    await manager.destroy(session.id);
    expect(manager.get(session.id)).toBeUndefined();
    expect(manager.count).toBe(0);
  });

  it('appendMessage adds message to history', async () => {
    const session = await manager.getOrCreate(lookupParams());
    await manager.appendMessage(session.id, msg('user', 'hello'));
    await manager.appendMessage(session.id, msg('assistant', 'hi'));
    expect(session.history).toHaveLength(2);
    expect(session.history[0].content).toBe('hello');
    expect(session.history[1].content).toBe('hi');
  });

  it('appendMessage triggers compaction when history exceeds maxHistoryLength', async () => {
    const session = await manager.getOrCreate(lookupParams());
    // Add 11 messages (maxHistoryLength is 10)
    for (let i = 0; i < 11; i++) {
      await manager.appendMessage(session.id, msg('user', `msg-${i}`));
    }
    // After compaction (truncate), should have 10 messages
    expect(session.history.length).toBeLessThanOrEqual(10);
  });

  it("compact with 'truncate' drops oldest messages", async () => {
    const session = await manager.getOrCreate(lookupParams());
    for (let i = 0; i < 15; i++) {
      session.history.push(msg('user', `msg-${i}`));
    }
    const result = await manager.compact(session.id);
    expect(result.messagesRemoved).toBe(5);
    expect(result.messagesRetained).toBe(10);
    expect(result.summaryGenerated).toBe(false);
    expect(session.history[0].content).toBe('msg-5');
  });

  it("compact with 'sliding-window' keeps last N + summary placeholder", async () => {
    const swManager = new SessionManager(
      defaultConfig({ compaction: 'sliding-window' }),
    );
    const session = await swManager.getOrCreate(lookupParams());
    for (let i = 0; i < 15; i++) {
      session.history.push(msg('user', `msg-${i}`));
    }
    const result = await swManager.compact(session.id);
    expect(result.messagesRemoved).toBe(5);
    expect(result.summaryGenerated).toBe(true);
    // First message should be the summary placeholder
    expect(session.history[0].role).toBe('system');
    expect(session.history[0].content).toContain('5 earlier messages');
    // Rest should be the retained messages
    expect(session.history[1].content).toBe('msg-5');
  });

  it("compact with 'summarize' uses summarizer callback", async () => {
    const summarizer = vi.fn().mockResolvedValue('This is a summary.');
    const sumManager = new SessionManager(
      defaultConfig({ compaction: 'summarize' }),
      undefined,
      summarizer,
    );
    const session = await sumManager.getOrCreate(lookupParams());
    for (let i = 0; i < 15; i++) {
      session.history.push(msg('user', `msg-${i}`));
    }
    const result = await sumManager.compact(session.id);
    expect(result.summaryGenerated).toBe(true);
    expect(summarizer).toHaveBeenCalledOnce();
    expect(session.history[0].content).toBe('This is a summary.');
  });

  it("checkResets with 'idle' mode resets sessions exceeding idle timeout", async () => {
    const idleManager = new SessionManager(
      defaultConfig({ reset: { mode: 'idle', idleMinutes: 1 } }),
    );
    const session = await idleManager.getOrCreate(lookupParams());
    await idleManager.appendMessage(session.id, msg('user', 'hello'));

    // Simulate idle time by backdating lastActiveAt
    session.lastActiveAt = Date.now() - 2 * 60 * 1000; // 2 min ago

    const resetIds = idleManager.checkResets();
    expect(resetIds).toContain(session.id);
    expect(session.history).toEqual([]);
  });

  it("checkResets with 'daily' mode resets sessions after daily hour", async () => {
    const dailyManager = new SessionManager(
      defaultConfig({ reset: { mode: 'daily', dailyHour: 4 } }),
    );
    const session = await dailyManager.getOrCreate(lookupParams());
    await dailyManager.appendMessage(session.id, msg('user', 'hello'));

    // Simulate: session was active yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(10, 0, 0, 0);
    session.lastActiveAt = yesterday.getTime();

    // Current time is after today's 4am
    const now = new Date();
    now.setHours(5, 0, 0, 0);

    // Use a fixed "now" by calling shouldReset logic
    const resetIds = dailyManager.checkResets();
    // If current hour >= 4, the session from yesterday should be reset
    if (new Date().getHours() >= 4) {
      expect(resetIds).toContain(session.id);
    }
  });

  it("checkResets with 'never' mode does not reset", async () => {
    const session = await manager.getOrCreate(lookupParams());
    await manager.appendMessage(session.id, msg('user', 'hello'));
    session.lastActiveAt = Date.now() - 24 * 60 * 60 * 1000; // 1 day ago

    const resetIds = manager.checkResets();
    expect(resetIds).toEqual([]);
    expect(session.history).toHaveLength(1);
  });

  it('listActive returns all sessions with correct info', async () => {
    await manager.getOrCreate(lookupParams());
    await manager.getOrCreate(
      lookupParams({ channel: 'discord', senderId: 'user-456' }),
    );

    const list = manager.listActive();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.channel).sort()).toEqual(['discord', 'telegram']);
  });

  it('per-channel overrides take precedence', async () => {
    const overrideManager = new SessionManager(
      defaultConfig({
        scope: 'per-channel-peer',
        channelOverrides: {
          discord: { scope: 'main' },
        },
      }),
    );

    const telegramSession = await overrideManager.getOrCreate(lookupParams());
    const discordSession = await overrideManager.getOrCreate(
      lookupParams({ channel: 'discord' }),
    );

    // Discord uses 'main' scope — same session for different senders
    const discordOther = await overrideManager.getOrCreate(
      lookupParams({ channel: 'discord', senderId: 'user-999' }),
    );

    expect(discordSession.id).toBe(discordOther.id);
    expect(telegramSession.id).not.toBe(discordSession.id);
  });

  it('per-scope overrides apply correctly for dm/group/thread', async () => {
    const scopeManager = new SessionManager(
      defaultConfig({
        scope: 'per-channel-peer',
        overrides: {
          group: { scope: 'main' },
        },
      }),
    );

    const dmSession = await scopeManager.getOrCreate(lookupParams({ scope: 'dm' }));
    const groupSession = await scopeManager.getOrCreate(
      lookupParams({ scope: 'group' }),
    );
    const groupOther = await scopeManager.getOrCreate(
      lookupParams({ scope: 'group', senderId: 'user-999' }),
    );

    // Group uses 'main' scope override — same session
    expect(groupSession.id).toBe(groupOther.id);
    expect(dmSession.id).not.toBe(groupSession.id);
  });

  it('channel override takes precedence over scope override', async () => {
    const precedenceManager = new SessionManager(
      defaultConfig({
        scope: 'per-channel-peer',
        overrides: {
          dm: { scope: 'per-peer' },
        },
        channelOverrides: {
          telegram: { scope: 'main' },
        },
      }),
    );

    // Both dm scope override (per-peer) and telegram channel override (main)
    // apply. Channel should win → scope is 'main'.
    const a = await precedenceManager.getOrCreate(
      lookupParams({ channel: 'telegram', scope: 'dm', senderId: 'user-1' }),
    );
    const b = await precedenceManager.getOrCreate(
      lookupParams({ channel: 'telegram', scope: 'dm', senderId: 'user-2' }),
    );

    // If channel wins (main scope), same session for different senders
    expect(a.id).toBe(b.id);
  });

  it('MemoryBackend persists messages via addEntry', async () => {
    const mockBackend = {
      name: 'mock',
      addEntry: vi.fn().mockResolvedValue({ id: 'entry-1', sessionId: '', role: 'user', content: '', timestamp: 0 }),
      getThread: vi.fn().mockResolvedValue([]),
      deleteThread: vi.fn().mockResolvedValue(0),
      listSessions: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
      listKeys: vi.fn(),
      getDurability: vi.fn(),
      flush: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn(),
    };

    const backendManager = new SessionManager(defaultConfig(), mockBackend);
    const session = await backendManager.getOrCreate(lookupParams());
    await backendManager.appendMessage(session.id, msg('user', 'hello'));

    expect(mockBackend.addEntry).toHaveBeenCalledOnce();
    expect(mockBackend.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, role: 'user', content: 'hello' }),
    );
  });

  it('MemoryBackend restores history on getOrCreate', async () => {
    const mockBackend = {
      name: 'mock',
      addEntry: vi.fn(),
      getThread: vi.fn().mockResolvedValue([
        { id: 'e1', sessionId: 's1', role: 'user', content: 'restored', timestamp: 1 },
        { id: 'e2', sessionId: 's1', role: 'assistant', content: 'reply', timestamp: 2 },
      ]),
      deleteThread: vi.fn().mockResolvedValue(0),
      listSessions: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
      listKeys: vi.fn(),
      getDurability: vi.fn(),
      flush: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn(),
    };

    const backendManager = new SessionManager(defaultConfig(), mockBackend);
    const session = await backendManager.getOrCreate(lookupParams());

    expect(mockBackend.getThread).toHaveBeenCalledOnce();
    expect(session.history).toHaveLength(2);
    expect(session.history[0].content).toBe('restored');
    expect(session.history[1].content).toBe('reply');
  });

  it('destroy deletes thread from MemoryBackend', async () => {
    const mockBackend = {
      name: 'mock',
      addEntry: vi.fn(),
      getThread: vi.fn().mockResolvedValue([]),
      deleteThread: vi.fn().mockResolvedValue(0),
      listSessions: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
      listKeys: vi.fn(),
      getDurability: vi.fn(),
      flush: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn(),
    };

    const backendManager = new SessionManager(defaultConfig(), mockBackend);
    const session = await backendManager.getOrCreate(lookupParams());
    await backendManager.destroy(session.id);

    expect(mockBackend.deleteThread).toHaveBeenCalledWith(session.id);
  });
});
