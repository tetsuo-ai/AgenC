import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { LLMTaskExecutor } from './executor.js';
import type { LLMProvider, LLMResponse, LLMMessage, StreamProgressCallback } from './types.js';
import type { Task } from '../autonomous/types.js';
import { TaskStatus } from '../autonomous/types.js';

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
});
