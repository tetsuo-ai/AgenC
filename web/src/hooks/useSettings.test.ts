import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSettings } from './useSettings';

describe('useSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-requests config when connected', () => {
    const send = vi.fn();

    renderHook(() => useSettings({ send, connected: true }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: 'config.get' });
  });

  it('supports config.get and parse fallback values', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSettings({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: 'config.get',
        payload: {
          llm: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' },
          voice: { enabled: false, mode: 'push-to-talk', voice: 'Eve' },
          memory: { backend: 'redis' },
          connection: { rpcUrl: 'https://api.mainnet-beta.solana.com' },
          logging: { level: 'warn' },
          extra: 'ignore',
        },
      } as never);
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.settings.llm.provider).toBe('ollama');
    expect(result.current.settings.voice.enabled).toBe(false);
    expect(result.current.settings.memory.backend).toBe('redis');
    expect(result.current.settings.connection.rpcUrl).toBe('https://api.mainnet-beta.solana.com');
  });

  it('sends config.set payload with saving state and clears saving on success', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSettings({ send, connected: true }));

    act(() => {
      result.current.save({
        llm: {
          provider: 'grok',
          model: 'grok-4',
          apiKey: 'x',
          baseUrl: 'https://api.x.ai/v1',
        },
      });
    });

    expect(result.current.saving).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      type: 'config.set',
      payload: {
        llm: {
          provider: 'grok',
          model: 'grok-4',
          apiKey: 'x',
          baseUrl: 'https://api.x.ai/v1',
        },
      },
    });

    act(() => {
      result.current.handleMessage({
        type: 'config.set',
        payload: {
          config: {
            llm: {
              provider: 'ollama',
              model: 'llama3',
              apiKey: '***',
              baseUrl: 'http://localhost:11434',
            },
            voice: { enabled: true, mode: 'vad', voice: 'Ara', apiKey: '' },
            memory: { backend: 'memory' },
            connection: { rpcUrl: 'https://api.devnet.solana.com' },
            logging: { level: 'info' },
          },
        },
      });
    });

    expect(result.current.saving).toBe(false);
    expect(result.current.settings.llm.provider).toBe('ollama');
    expect(result.current.lastError).toBeNull();
  });

  it('handles ollama model errors and empty model list', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSettings({ send, connected: true }));

    act(() => {
      result.current.fetchOllamaModels();
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'ollama.models' });

    act(() => {
      result.current.handleMessage({
        type: 'ollama.models',
        payload: {},
      });
    });

    expect(result.current.ollamaModels).toEqual([]);
    expect(result.current.ollamaError).toBe('No models installed in Ollama');
  });

  it('records save errors and keeps saving false', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSettings({ send, connected: true }));

    act(() => {
      result.current.save({});
    });

    act(() => {
      result.current.handleMessage({
        type: 'config.set',
        error: 'invalid config',
      });
    });

    expect(result.current.saving).toBe(false);
    expect(result.current.lastError).toBe('invalid config');
  });

  it('clears saving and reports error when disconnected mid-save', () => {
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ connected }) => useSettings({ send, connected }),
      { initialProps: { connected: true } },
    );

    act(() => {
      result.current.save({});
    });
    expect(result.current.saving).toBe(true);

    rerender({ connected: false });
    expect(result.current.saving).toBe(false);
    expect(result.current.lastError).toBe('Disconnected while saving settings.');
  });

  it('times out a save request that never receives config.set response', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const { result } = renderHook(() => useSettings({ send, connected: true }));

    act(() => {
      result.current.save({});
    });
    expect(result.current.saving).toBe(true);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.saving).toBe(false);
    expect(result.current.lastError).toContain('Saving settings timed out');
  });
});
