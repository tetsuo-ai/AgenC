import { describe, expect, it, vi } from 'vitest';
import {
  LLMAuthenticationError,
  LLMServerError,
  LLMTimeoutError,
} from './errors.js';
import { FallbackLLMProvider } from './fallback.js';
import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'mock-model',
    finishReason: 'stop',
  };
}

function createMockProvider(
  name: string,
  chatImpl?: (messages: LLMMessage[]) => Promise<LLMResponse>,
): LLMProvider {
  return {
    name,
    chat: vi.fn(chatImpl ?? (async () => makeResponse(`response from ${name}`))),
    chatStream: vi.fn(async () => makeResponse(`stream response from ${name}`)),
    healthCheck: vi.fn(async () => true),
  };
}

describe('FallbackLLMProvider', () => {
  it('uses primary provider when it succeeds', async () => {
    const primary = createMockProvider('primary');
    const secondary = createMockProvider('secondary');
    const provider = new FallbackLLMProvider({ providers: [primary, secondary] });

    const result = await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('response from primary');
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it('falls back to secondary on timeout errors', async () => {
    const primary = createMockProvider('primary', async () => {
      throw new LLMTimeoutError('primary', 5000);
    });
    const secondary = createMockProvider('secondary');
    const provider = new FallbackLLMProvider({ providers: [primary, secondary] });

    const result = await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('response from secondary');
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(secondary.chat).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on authentication errors by default', async () => {
    const primary = createMockProvider('primary', async () => {
      throw new LLMAuthenticationError('primary', 401);
    });
    const secondary = createMockProvider('secondary');
    const provider = new FallbackLLMProvider({ providers: [primary, secondary] });

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow(LLMAuthenticationError);
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it('throws when all providers fail', async () => {
    const primary = createMockProvider('primary', async () => {
      throw new LLMServerError('primary', 500, 'down');
    });
    const secondary = createMockProvider('secondary', async () => {
      throw new LLMServerError('secondary', 500, 'also down');
    });
    const provider = new FallbackLLMProvider({ providers: [primary, secondary] });

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow(LLMServerError);
  });

  it('healthCheck returns true if any provider is healthy', async () => {
    const primary = createMockProvider('primary');
    const secondary = createMockProvider('secondary');

    (primary.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (secondary.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const provider = new FallbackLLMProvider({ providers: [primary, secondary] });
    await expect(provider.healthCheck()).resolves.toBe(true);
  });
});
