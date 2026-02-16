import { describe, it, expect, vi } from 'vitest';
import {
  NoopEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
  normalizeVector,
} from './embeddings.js';

// ============================================================================
// NoopEmbeddingProvider
// ============================================================================

describe('NoopEmbeddingProvider', () => {
  it('embed returns zero vector of correct dimension', async () => {
    const provider = new NoopEmbeddingProvider(64);
    const vec = await provider.embed('hello');

    expect(vec).toHaveLength(64);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it('embedBatch returns correct number of vectors', async () => {
    const provider = new NoopEmbeddingProvider(32);
    const vecs = await provider.embedBatch(['a', 'b', 'c']);

    expect(vecs).toHaveLength(3);
    for (const vec of vecs) {
      expect(vec).toHaveLength(32);
      expect(vec.every((v) => v === 0)).toBe(true);
    }
  });

  it('isAvailable returns true', async () => {
    const provider = new NoopEmbeddingProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('uses default dimension of 128', () => {
    const provider = new NoopEmbeddingProvider();
    expect(provider.dimension).toBe(128);
  });

  it('embed returns vector of correct dimension', async () => {
    const provider = new NoopEmbeddingProvider(256);
    const vec = await provider.embed('test text');
    expect(vec).toHaveLength(256);
  });

  it('embedBatch handles empty input', async () => {
    const provider = new NoopEmbeddingProvider();
    const vecs = await provider.embedBatch([]);
    expect(vecs).toHaveLength(0);
  });

  it('handles empty text input gracefully', async () => {
    const provider = new NoopEmbeddingProvider(16);
    const vec = await provider.embed('');
    expect(vec).toHaveLength(16);
  });
});

// ============================================================================
// cosineSimilarity
// ============================================================================

describe('cosineSimilarity', () => {
  it('identical vectors return 1.0', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('orthogonal vectors return 0.0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('opposite vectors return -1.0', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('Vector length mismatch');
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ============================================================================
// normalizeVector
// ============================================================================

describe('normalizeVector', () => {
  it('produces unit-length vector', () => {
    const v = [3, 4];
    const normalized = normalizeVector(v);

    const magnitude = Math.sqrt(normalized.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0);
  });

  it('handles zero vector gracefully', () => {
    const v = [0, 0, 0];
    const normalized = normalizeVector(v);

    expect(normalized).toHaveLength(3);
    expect(normalized.every((x) => x === 0)).toBe(true);
  });

  it('preserves direction', () => {
    const v = [3, 4];
    const normalized = normalizeVector(v);
    // ratio between components should be preserved
    expect(normalized[0] / normalized[1]).toBeCloseTo(3 / 4);
  });

  it('handles single-element vector', () => {
    const normalized = normalizeVector([5]);
    expect(normalized).toEqual([1]);
  });
});

// ============================================================================
// OpenAIEmbeddingProvider
// ============================================================================

describe('OpenAIEmbeddingProvider', () => {
  it('constructor stores config', () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('openai');
    expect(provider.dimension).toBe(1536);
  });

  it('embed calls embedBatch and returns first result', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);

    // Mock the internal client
    (provider as any).client = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: mockEmbedding }],
        }),
      },
    };

    const result = await provider.embed('hello');
    expect(result).toEqual(mockEmbedding);
  });

  it('embedBatch returns correct number of vectors', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const mockVec1 = Array.from({ length: 1536 }, () => 0.1);
    const mockVec2 = Array.from({ length: 1536 }, () => 0.2);

    (provider as any).client = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: mockVec1 }, { embedding: mockVec2 }],
        }),
      },
    };

    const results = await provider.embedBatch(['a', 'b']);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(mockVec1);
    expect(results[1]).toEqual(mockVec2);
  });

  it('embedBatch returns empty array for empty input', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    const results = await provider.embedBatch([]);
    expect(results).toHaveLength(0);
  });

  it('wraps API errors as MemoryBackendError', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });

    (provider as any).client = {
      embeddings: {
        create: vi.fn().mockRejectedValue(new Error('API rate limited')),
      },
    };

    await expect(provider.embed('test')).rejects.toThrow('Embedding generation failed');
  });
});

// ============================================================================
// OllamaEmbeddingProvider
// ============================================================================

describe('OllamaEmbeddingProvider', () => {
  it('constructor stores config', () => {
    const provider = new OllamaEmbeddingProvider({ host: 'http://custom:11434' });
    expect(provider.name).toBe('ollama');
    expect(provider.dimension).toBe(768);
  });

  it('uses defaults with no config', () => {
    const provider = new OllamaEmbeddingProvider();
    expect(provider.name).toBe('ollama');
    expect(provider.dimension).toBe(768);
  });

  it('embed returns vector from Ollama API', async () => {
    const provider = new OllamaEmbeddingProvider();
    const mockEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);

    (provider as any).client = {
      embed: vi.fn().mockResolvedValue({
        embeddings: [mockEmbedding],
      }),
    };

    const result = await provider.embed('hello');
    expect(result).toEqual(mockEmbedding);
  });

  it('embedBatch calls embed sequentially', async () => {
    const provider = new OllamaEmbeddingProvider();
    const mockVec1 = Array.from({ length: 768 }, () => 0.1);
    const mockVec2 = Array.from({ length: 768 }, () => 0.2);
    let callCount = 0;

    (provider as any).client = {
      embed: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          embeddings: [callCount === 1 ? mockVec1 : mockVec2],
        });
      }),
    };

    const results = await provider.embedBatch(['a', 'b']);
    expect(results).toHaveLength(2);
    expect((provider as any).client.embed).toHaveBeenCalledTimes(2);
  });

  it('wraps API errors as MemoryBackendError', async () => {
    const provider = new OllamaEmbeddingProvider();

    (provider as any).client = {
      embed: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    await expect(provider.embed('test')).rejects.toThrow('Embedding generation failed');
  });
});

// ============================================================================
// createEmbeddingProvider
// ============================================================================

describe('createEmbeddingProvider', () => {
  it('with noop returns NoopProvider', async () => {
    const provider = await createEmbeddingProvider({ preferred: 'noop' });
    expect(provider).toBeInstanceOf(NoopEmbeddingProvider);
    expect(provider.name).toBe('noop');
  });

  it('with openai returns OpenAIProvider', async () => {
    const provider = await createEmbeddingProvider({
      preferred: 'openai',
      apiKey: 'test-key',
    });
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it('with openai without apiKey throws', async () => {
    await expect(
      createEmbeddingProvider({ preferred: 'openai' }),
    ).rejects.toThrow('API key is required');
  });

  it('with ollama returns OllamaProvider', async () => {
    const provider = await createEmbeddingProvider({ preferred: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
  });

  it('auto-selection falls back to Noop when no providers available', async () => {
    // Mock Ollama isAvailable to return false so fallback chain reaches Noop
    const spy = vi.spyOn(OllamaEmbeddingProvider.prototype, 'isAvailable').mockResolvedValue(false);
    try {
      // No apiKey, Ollama "not running" → should fall back to Noop
      const provider = await createEmbeddingProvider();
      expect(provider).toBeInstanceOf(NoopEmbeddingProvider);
    } finally {
      spy.mockRestore();
    }
  });

  it('auto-selection with no config returns a provider', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBeDefined();
    expect(typeof provider.dimension).toBe('number');
  });
});
