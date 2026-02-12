import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LLMTaskExecutor } from './executor.js';
import type { LLMProvider, LLMResponse, LLMMessage, StreamProgressCallback } from './types.js';
import type { Task } from '../autonomous/types.js';
import { TaskStatus } from '../autonomous/types.js';
import type { MemoryBackend, MemoryEntry, AddEntryOptions, MemoryQuery } from '../memory/types.js';
import type { MemoryGraphResult } from '../memory/graph.js';

function createMockProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn<[LLMMessage[]], Promise<LLMResponse>>().mockResolvedValue({
      content: 'mock response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      finishReason: 'stop',
    }),
    chatStream: vi.fn<[LLMMessage[], StreamProgressCallback], Promise<LLMResponse>>().mockResolvedValue({
      content: 'mock stream response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      finishReason: 'stop',
    }),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockTask(descriptionStr = 'test task'): Task {
  const desc = Buffer.alloc(64, 0);
  Buffer.from(descriptionStr, 'utf-8').copy(desc);

  return {
    pda: PublicKey.default,
    taskId: new Uint8Array(32),
    creator: PublicKey.default,
    requiredCapabilities: 1n, // COMPUTE
    reward: 1_000_000n,
    description: desc,
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
  };
}

describe('LLMTaskExecutor', () => {
  it('calls provider.chat and returns 4 bigints', async () => {
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({ provider });

    const output = await executor.execute(createMockTask());

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(output).toHaveLength(4);
    for (const v of output) {
      expect(typeof v).toBe('bigint');
    }
  });

  it('uses streaming when configured', async () => {
    const onStreamChunk = vi.fn();
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({
      provider,
      streaming: true,
      onStreamChunk,
    });

    await executor.execute(createMockTask());

    expect(provider.chatStream).toHaveBeenCalledOnce();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('includes system prompt in messages', async () => {
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({
      provider,
      systemPrompt: 'You are a helpful agent.',
    });

    await executor.execute(createMockTask());

    const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMMessage[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful agent.',
    });
    expect(messages[1].role).toBe('user');
  });

  it('strips null bytes from task description', async () => {
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({ provider });

    // Task description with null padding
    const task = createMockTask('hello');
    await executor.execute(task);

    const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMMessage[];
    expect(messages[0].content).toContain('Description: hello');
    expect(messages[0].content).not.toContain('\0');
  });

  it('handles tool call loop', async () => {
    const toolCallResponse: LLMResponse = {
      content: '',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"key":"val"}' }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      finishReason: 'tool_calls',
    };
    const finalResponse: LLMResponse = {
      content: 'final answer',
      toolCalls: [],
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      model: 'mock-model',
      finishReason: 'stop',
    };

    const chatFn = vi.fn<[LLMMessage[]], Promise<LLMResponse>>()
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(finalResponse);

    const provider = createMockProvider({ chat: chatFn });
    const toolHandler = vi.fn().mockResolvedValue('tool result');

    const executor = new LLMTaskExecutor({ provider, toolHandler });
    const output = await executor.execute(createMockTask());

    expect(chatFn).toHaveBeenCalledTimes(2);
    expect(toolHandler).toHaveBeenCalledWith('lookup', { key: 'val' });
    expect(output).toHaveLength(4);
  });

  it('terminates tool call loop at maxToolRounds', async () => {
    const toolCallResponse: LLMResponse = {
      content: 'thinking...',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      finishReason: 'tool_calls',
    };

    const chatFn = vi.fn<[LLMMessage[]], Promise<LLMResponse>>()
      .mockResolvedValue(toolCallResponse);

    const provider = createMockProvider({ chat: chatFn });
    const toolHandler = vi.fn().mockResolvedValue('result');

    const executor = new LLMTaskExecutor({
      provider,
      toolHandler,
      maxToolRounds: 3,
    });

    const output = await executor.execute(createMockTask());

    // 1 initial + 3 rounds = 4 calls total
    expect(chatFn).toHaveBeenCalledTimes(4);
    expect(output).toHaveLength(4);
  });

  it('uses custom responseToOutput', async () => {
    const provider = createMockProvider();
    const custom = vi.fn().mockReturnValue([1n, 2n, 3n, 4n]);

    const executor = new LLMTaskExecutor({
      provider,
      responseToOutput: custom,
    });

    const output = await executor.execute(createMockTask());

    expect(custom).toHaveBeenCalledWith('mock response');
    expect(output).toEqual([1n, 2n, 3n, 4n]);
  });

  it('canExecute returns true when no capabilities filter set', () => {
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({ provider });
    expect(executor.canExecute(createMockTask())).toBe(true);
  });

  it('canExecute filters by requiredCapabilities', () => {
    const provider = createMockProvider();
    const executor = new LLMTaskExecutor({
      provider,
      requiredCapabilities: 0b11n, // COMPUTE | INFERENCE
    });

    const taskCompute = createMockTask();
    taskCompute.requiredCapabilities = 1n; // COMPUTE only — subset of 0b11
    expect(executor.canExecute(taskCompute)).toBe(true);

    const taskStorage = createMockTask();
    taskStorage.requiredCapabilities = 4n; // STORAGE — not in 0b11
    expect(executor.canExecute(taskStorage)).toBe(false);
  });

  // ==========================================================================
  // Memory integration
  // ==========================================================================

  describe('memory integration', () => {
    function createMockMemory(overrides: Partial<MemoryBackend> = {}): MemoryBackend {
      return {
        name: 'mock-memory',
        addEntry: vi.fn<[AddEntryOptions], Promise<MemoryEntry>>().mockImplementation(async (opts) => ({
          id: `entry-${Date.now()}`,
          sessionId: opts.sessionId,
          role: opts.role,
          content: opts.content,
          toolCallId: opts.toolCallId,
          toolName: opts.toolName,
          timestamp: Date.now(),
          taskPda: opts.taskPda,
          metadata: opts.metadata,
        })),
        getThread: vi.fn<[string, number?], Promise<MemoryEntry[]>>().mockResolvedValue([]),
        query: vi.fn<[MemoryQuery], Promise<MemoryEntry[]>>().mockResolvedValue([]),
        deleteThread: vi.fn<[string], Promise<number>>().mockResolvedValue(0),
        listSessions: vi.fn<[string?], Promise<string[]>>().mockResolvedValue([]),
        set: vi.fn<[string, unknown, number?], Promise<void>>().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn<[string], Promise<boolean>>().mockResolvedValue(false),
        has: vi.fn<[string], Promise<boolean>>().mockResolvedValue(false),
        listKeys: vi.fn<[string?], Promise<string[]>>().mockResolvedValue([]),
        clear: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        close: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
        ...overrides,
      };
    }

    function createTaskWithUniquePda(descriptionStr = 'test task'): Task {
      const task = createMockTask(descriptionStr);
      // Use a real keypair-derived pubkey so toBase58 is deterministic and unique
      task.pda = Keypair.generate().publicKey;
      return task;
    }

    it('persists messages when memory provided', async () => {
      const memory = createMockMemory();
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider, memory });

      await executor.execute(createTaskWithUniquePda());

      // Should persist: user message (initial) + assistant response
      expect(memory.addEntry).toHaveBeenCalledTimes(2);

      // First call = user message
      const firstCall = (memory.addEntry as ReturnType<typeof vi.fn>).mock.calls[0][0] as AddEntryOptions;
      expect(firstCall.role).toBe('user');
      expect(firstCall.sessionId).toMatch(/^conv:/);
      expect(firstCall.taskPda).toBeDefined();

      // Second call = assistant message
      const secondCall = (memory.addEntry as ReturnType<typeof vi.fn>).mock.calls[1][0] as AddEntryOptions;
      expect(secondCall.role).toBe('assistant');
    });

    it('loads prior messages on retry (memory has entries)', async () => {
      const task = createTaskWithUniquePda();
      const sessionId = `conv:${task.pda.toBase58()}`;

      const priorEntries: MemoryEntry[] = [
        { id: '1', sessionId, role: 'system', content: 'You are helpful.', timestamp: 1000 },
        { id: '2', sessionId, role: 'user', content: 'Task info', timestamp: 1001 },
        { id: '3', sessionId, role: 'assistant', content: 'Prior response', timestamp: 1002 },
      ];

      const memory = createMockMemory({
        getThread: vi.fn<[string, number?], Promise<MemoryEntry[]>>().mockResolvedValue(priorEntries),
      });
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider, memory });

      await executor.execute(task);

      // getThread called to load prior messages
      expect(memory.getThread).toHaveBeenCalledWith(sessionId);

      // provider.chat should receive messages built from prior entries (3 prior + 1 assistant response pushed)
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMMessage[];
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('You are helpful.');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');

      // No initial persistMessages since isNew=false, only assistant response persisted
      expect(memory.addEntry).toHaveBeenCalledTimes(1);
    });

    it('builds fresh messages when memory is empty', async () => {
      const memory = createMockMemory({
        getThread: vi.fn<[string, number?], Promise<MemoryEntry[]>>().mockResolvedValue([]),
      });
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider, memory, systemPrompt: 'You are an agent.' });

      await executor.execute(createTaskWithUniquePda());

      // getThread returned empty → fresh build
      // persist: system + user (initial) + assistant = 3
      expect(memory.addEntry).toHaveBeenCalledTimes(3);
    });

    it('persists tool call loop messages', async () => {
      const toolCallResponse: LLMResponse = {
        content: 'thinking...',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"key":"val"}' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'mock-model',
        finishReason: 'tool_calls',
      };
      const finalResponse: LLMResponse = {
        content: 'final answer',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        model: 'mock-model',
        finishReason: 'stop',
      };

      const chatFn = vi.fn<[LLMMessage[]], Promise<LLMResponse>>()
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(finalResponse);

      const memory = createMockMemory();
      const provider = createMockProvider({ chat: chatFn });
      const toolHandler = vi.fn().mockResolvedValue('tool result');

      const executor = new LLMTaskExecutor({ provider, toolHandler, memory });
      await executor.execute(createTaskWithUniquePda());

      // Expected addEntry calls:
      // 1. user (initial persist)
      // 2. first assistant response (thinking...)
      // 3. tool result
      // 4. second assistant response (final answer)
      expect(memory.addEntry).toHaveBeenCalledTimes(4);

      const calls = (memory.addEntry as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: [AddEntryOptions]) => c[0].role
      );
      expect(calls).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('injects high-confidence graph facts into prompt context', async () => {
      const task = createTaskWithUniquePda();
      const provider = createMockProvider();
      const memoryGraph = {
        query: vi.fn().mockResolvedValue([
          {
            node: {
              id: 'fact-1',
              content: 'Critical treasury migration completed',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              baseConfidence: 0.92,
              provenance: [{ type: 'onchain_event', sourceId: 'tx-abc' }],
            },
            effectiveConfidence: 0.88,
            contradicted: false,
            superseded: false,
            sources: [{ type: 'onchain_event', sourceId: 'tx-abc' }],
          } satisfies MemoryGraphResult,
        ]),
        ingestToolOutput: vi.fn().mockResolvedValue(undefined),
      };

      const executor = new LLMTaskExecutor({
        provider,
        memoryGraph,
      });

      await executor.execute(task);

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMMessage[];
      expect(messages.some(
        (message) =>
          message.role === 'system'
          && message.content.includes('Relevant high-confidence memory'),
      )).toBe(true);
      expect(memoryGraph.query).toHaveBeenCalled();
    });

    it('ingests tool outputs into memory graph during tool loops', async () => {
      const toolCallResponse: LLMResponse = {
        content: 'thinking...',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"key":"val"}' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'mock-model',
        finishReason: 'tool_calls',
      };
      const finalResponse: LLMResponse = {
        content: 'final answer',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        model: 'mock-model',
        finishReason: 'stop',
      };
      const task = createTaskWithUniquePda();
      const chatFn = vi.fn<[LLMMessage[]], Promise<LLMResponse>>()
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(finalResponse);
      const provider = createMockProvider({ chat: chatFn });
      const toolHandler = vi.fn().mockResolvedValue('tool result');
      const memoryGraph = {
        query: vi.fn().mockResolvedValue([]),
        ingestToolOutput: vi.fn().mockResolvedValue(undefined),
      };

      const executor = new LLMTaskExecutor({
        provider,
        toolHandler,
        memoryGraph,
      });

      await executor.execute(task);

      expect(memoryGraph.ingestToolOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `conv:${task.pda.toBase58()}`,
          taskPda: task.pda.toBase58(),
          toolName: 'lookup',
          output: 'tool result',
        }),
      );
    });

    it('memory failure does not block execution', async () => {
      const memory = createMockMemory({
        addEntry: vi.fn().mockRejectedValue(new Error('storage offline')),
        getThread: vi.fn<[string, number?], Promise<MemoryEntry[]>>().mockResolvedValue([]),
      });
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider, memory });

      const output = await executor.execute(createTaskWithUniquePda());
      expect(output).toHaveLength(4);
      for (const v of output) {
        expect(typeof v).toBe('bigint');
      }
    });

    it('getThread failure does not block execution', async () => {
      const memory = createMockMemory({
        getThread: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider, memory });

      const output = await executor.execute(createTaskWithUniquePda());
      expect(output).toHaveLength(4);
      // Should still persist (addEntry not broken)
      expect(memory.addEntry).toHaveBeenCalled();
    });

    it('no persistence when memory not configured', async () => {
      const provider = createMockProvider();
      const executor = new LLMTaskExecutor({ provider }); // no memory

      const output = await executor.execute(createMockTask());
      expect(output).toHaveLength(4);
      // Nothing to assert on memory — just verify it works without memory
    });

    it('uses configured memoryTtlMs', async () => {
      const memory = createMockMemory();
      const provider = createMockProvider();
      const customTtl = 3600_000; // 1h
      const executor = new LLMTaskExecutor({ provider, memory, memoryTtlMs: customTtl });

      await executor.execute(createTaskWithUniquePda());

      const firstCall = (memory.addEntry as ReturnType<typeof vi.fn>).mock.calls[0][0] as AddEntryOptions;
      expect(firstCall.ttlMs).toBe(customTtl);
    });
  });
});
