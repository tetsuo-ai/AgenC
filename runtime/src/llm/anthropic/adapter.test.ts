import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMMessage } from '../types.js';
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from '../errors.js';

// Mock the @anthropic-ai/sdk module
const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockMessagesCreate };
      constructor(_opts: any) {}
    },
  };
});

import { AnthropicProvider } from './adapter.js';

function makeResponse(overrides: Record<string, any> = {}) {
  return {
    content: [{ type: 'text', text: 'Hello!' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'end_turn',
    ...overrides,
  };
}

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts system prompt to top-level parameter', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.chat([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);

    const params = mockMessagesCreate.mock.calls[0][0];
    expect(params.system).toBe('You are helpful.');
    expect(params.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('converts tools to Anthropic format', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse());

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      }],
    });
    await provider.chat([{ role: 'user', content: 'test' }]);

    const params = mockMessagesCreate.mock.calls[0][0];
    expect(params.tools).toEqual([{
      name: 'search',
      description: 'Search the web',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }]);
  });

  it('aggregates text content blocks', async () => {
    const response = makeResponse({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
      ],
    });
    mockMessagesCreate.mockResolvedValueOnce(response);

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const result = await provider.chat([{ role: 'user', content: 'test' }]);

    expect(result.content).toBe('Hello world!');
  });

  it('parses tool_use content blocks', async () => {
    const response = makeResponse({
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
      ],
      stop_reason: 'tool_use',
    });
    mockMessagesCreate.mockResolvedValueOnce(response);

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const result = await provider.chat([{ role: 'user', content: 'test' }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'toolu_1',
      name: 'search',
      arguments: '{"q":"test"}',
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('formats tool result messages as tool_result content blocks', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.chat([
      { role: 'user', content: 'search' },
      { role: 'tool', content: 'result data', toolCallId: 'toolu_1', toolName: 'search' },
    ]);

    const params = mockMessagesCreate.mock.calls[0][0];
    expect(params.messages[1]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'result data',
      }],
    });
  });

  it('enables extended thinking when configured', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse());

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      extendedThinking: true,
      thinkingBudgetTokens: 5000,
    });
    await provider.chat([{ role: 'user', content: 'think hard' }]);

    const params = mockMessagesCreate.mock.calls[0][0];
    expect(params.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    });
  });

  it('handles streaming events', async () => {
    const events = [
      { type: 'message_start', message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ];
    mockMessagesCreate.mockResolvedValueOnce((async function* () {
      for (const e of events) yield e;
    })());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const onChunk = vi.fn();
    const result = await provider.chatStream(
      [{ role: 'user', content: 'test' }],
      onChunk,
    );

    expect(result.content).toBe('Hello world');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(onChunk).toHaveBeenCalledWith({ content: 'Hello', done: false });
  });

  it('streams tool use blocks', async () => {
    const events = [
      { type: 'message_start', message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"test"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    ];
    mockMessagesCreate.mockResolvedValueOnce((async function* () {
      for (const e of events) yield e;
    })());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const onChunk = vi.fn();
    const result = await provider.chatStream(
      [{ role: 'user', content: 'test' }],
      onChunk,
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toBe('{"q":"test"}');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('maps 429 error to LLMRateLimitError', async () => {
    mockMessagesCreate.mockRejectedValueOnce({ status: 429, message: 'Rate limited', headers: {} });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMRateLimitError);
  });

  it('maps 500 errors to LLMServerError', async () => {
    mockMessagesCreate.mockRejectedValueOnce({ status: 500, message: 'Internal server error' });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMServerError);
  });

  it('maps 403 to LLMAuthenticationError', async () => {
    mockMessagesCreate.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMAuthenticationError);
  });

  it('maps AbortError to LLMTimeoutError', async () => {
    mockMessagesCreate.mockRejectedValueOnce({ name: 'AbortError', message: 'signal aborted' });

    const provider = new AnthropicProvider({ apiKey: 'test-key', timeoutMs: 1000 });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMTimeoutError);
  });

  it('returns partial streamed content on mid-stream failure', async () => {
    mockMessagesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'message_start', message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'response' } };
      throw { name: 'AbortError', message: 'stream interrupted' };
    })());

    const provider = new AnthropicProvider({ apiKey: 'test-key', timeoutMs: 1000 });
    const response = await provider.chatStream(
      [{ role: 'user', content: 'test' }],
      () => undefined,
    );

    expect(response.finishReason).toBe('error');
    expect(response.partial).toBe(true);
    expect(response.content).toBe('partial response');
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it('throws when stream fails before any content is received', async () => {
    mockMessagesCreate.mockResolvedValueOnce((async function* () {
      throw new Error('stream failed');
    })());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await expect(
      provider.chatStream([{ role: 'user', content: 'test' }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it('returns usage information', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse());

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const result = await provider.chat([{ role: 'user', content: 'test' }]);

    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('maps stop reasons correctly', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeResponse({ stop_reason: 'max_tokens' }));

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const result = await provider.chat([{ role: 'user', content: 'test' }]);

    expect(result.finishReason).toBe('length');
  });
});
