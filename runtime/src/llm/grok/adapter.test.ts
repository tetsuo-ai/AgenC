import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMMessage } from '../types.js';
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from '../errors.js';

// Mock the openai module
const mockCreate = vi.fn();
const mockModelsListFn = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      models = { list: mockModelsListFn };
      constructor(_opts: any) {}
    },
  };
});

// Import after mock setup
import { GrokProvider } from './adapter.js';

function makeCompletion(overrides: Record<string, any> = {}) {
  return {
    choices: [
      {
        message: { content: 'Hello!', tool_calls: [] },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: 'grok-4-1-fast-reasoning',
    ...overrides,
  };
}

describe('GrokProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends messages in OpenAI-compatible format', async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];

    const response = await provider.chat(messages);

    expect(mockCreate).toHaveBeenCalledOnce();
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe('grok-4-1-fast-reasoning');
    expect(params.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(response.content).toBe('Hello!');
    expect(response.finishReason).toBe('stop');
  });

  it('parses tool calls from response', async () => {
    const completion = makeCompletion({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    mockCreate.mockResolvedValueOnce(completion);

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const response = await provider.chat([{ role: 'user', content: 'search for test' }]);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe('search');
    expect(response.finishReason).toBe('tool_calls');
  });

  it('injects web_search tool when webSearch is true', async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: 'test-key', webSearch: true });
    await provider.chat([{ role: 'user', content: 'test' }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    const names = params.tools.map((t: any) => t.function.name);
    expect(names).toContain('web_search');
  });

  it('passes usage information', async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const response = await provider.chat([{ role: 'user', content: 'test' }]);

    expect(response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('handles streaming', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], model: 'grok-3' },
    ];
    mockCreate.mockResolvedValueOnce((async function* () {
      for (const c of chunks) yield c;
    })());

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: 'user', content: 'test' }],
      onChunk,
    );

    expect(response.content).toBe('Hello world');
    expect(onChunk).toHaveBeenCalledWith({ content: 'Hello', done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: ' world', done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: '', done: true, toolCalls: [] });
  });

  it('maps 429 error to LLMRateLimitError', async () => {
    mockCreate.mockRejectedValueOnce({ status: 429, message: 'Rate limited', headers: {} });

    const provider = new GrokProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMRateLimitError);
  });

  it('maps 500 errors to LLMServerError', async () => {
    mockCreate.mockRejectedValueOnce({ status: 500, message: 'Internal server error' });

    const provider = new GrokProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMServerError);
  });

  it('maps 401 to LLMAuthenticationError', async () => {
    mockCreate.mockRejectedValueOnce({ status: 401, message: 'Invalid API key' });

    const provider = new GrokProvider({ apiKey: 'test-key' });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMAuthenticationError);
  });

  it('maps AbortError to LLMTimeoutError', async () => {
    mockCreate.mockRejectedValueOnce({ name: 'AbortError', message: 'signal aborted' });

    const provider = new GrokProvider({ apiKey: 'test-key', timeoutMs: 1000 });
    await expect(provider.chat([{ role: 'user', content: 'test' }]))
      .rejects.toThrow(LLMTimeoutError);
  });

  it('returns partial streamed content on mid-stream failure', async () => {
    mockCreate.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: 'partial ' }, finish_reason: null }] };
      yield { choices: [{ delta: { content: 'response' }, finish_reason: null }] };
      throw { name: 'AbortError', message: 'stream interrupted' };
    })());

    const provider = new GrokProvider({ apiKey: 'test-key', timeoutMs: 1000 });
    const onChunk = vi.fn();
    const response = await provider.chatStream([{ role: 'user', content: 'test' }], onChunk);

    expect(response.finishReason).toBe('error');
    expect(response.partial).toBe(true);
    expect(response.content).toBe('partial response');
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it('throws when stream fails before any content is received', async () => {
    mockCreate.mockResolvedValueOnce((async function* () {
      throw new Error('stream failed');
    })());

    const provider = new GrokProvider({ apiKey: 'test-key' });
    await expect(
      provider.chatStream([{ role: 'user', content: 'test' }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it('healthCheck returns true on success', async () => {
    mockModelsListFn.mockResolvedValueOnce({ data: [] });

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const result = await provider.healthCheck();
    expect(result).toBe(true);
  });

  it('healthCheck returns false on failure', async () => {
    mockModelsListFn.mockRejectedValueOnce(new Error('fail'));

    const provider = new GrokProvider({ apiKey: 'test-key' });
    const result = await provider.healthCheck();
    expect(result).toBe(false);
  });

  it('uses custom model', async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: 'test-key', model: 'grok-3-mini' });
    await provider.chat([{ role: 'user', content: 'test' }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe('grok-3-mini');
  });

  it('formats tool result messages correctly', async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: 'test-key' });
    await provider.chat([
      { role: 'user', content: 'search' },
      { role: 'tool', content: 'result data', toolCallId: 'call_1', toolName: 'search' },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.messages[1]).toEqual({
      role: 'tool',
      content: 'result data',
      tool_call_id: 'call_1',
    });
  });
});
