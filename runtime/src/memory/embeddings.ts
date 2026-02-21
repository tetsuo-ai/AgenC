/**
 * Multi-provider embedding generation for semantic memory.
 *
 * Supports OpenAI/Grok (via compatible API), Ollama (local), and a Noop
 * provider for testing. Provider auto-selection tries local-first for
 * privacy, then falls back to cloud providers.
 *
 * @module
 */

import { ensureLazyModule } from "../utils/lazy-import.js";
import { MemoryBackendError, MemoryConnectionError } from "./errors.js";

// ============================================================================
// Interface
// ============================================================================

/** Embedding provider interface. */
export interface EmbeddingProvider {
  /** Provider name for logging. */
  readonly name: string;
  /** Embedding dimension. */
  readonly dimension: number;
  /** Generate embedding for a single text. */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for a batch of texts. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Check if provider is available. */
  isAvailable(): Promise<boolean>;
}

// ============================================================================
// OpenAI-compatible provider (works with Grok)
// ============================================================================

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_DEFAULT_DIMENSION = 1536;

/** OpenAI-compatible embedding provider (works with Grok). */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimension = OPENAI_DEFAULT_DIMENSION;

  private client: unknown | null = null;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: { apiKey: string; baseUrl?: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
    this.model = config.model ?? OPENAI_DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const client = await this.ensureClient();
    try {
      const response = await (client as any).embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.map((item: any) => item.embedding as number[]);
    } catch (err: unknown) {
      throw new MemoryBackendError(
        this.name,
        `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await (client as any).models.list();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyModule(
      "openai",
      (msg) => new MemoryConnectionError(this.name, msg),
      (mod) => {
        const OpenAI = (mod.default ?? mod.OpenAI ?? mod) as any;
        return new OpenAI({
          apiKey: this.apiKey,
          baseURL: this.baseUrl,
        });
      },
    );
    return this.client;
  }
}

// ============================================================================
// Ollama local provider
// ============================================================================

const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
const OLLAMA_DEFAULT_MODEL = "nomic-embed-text";
const OLLAMA_DEFAULT_DIMENSION = 768;

/** Ollama local embedding provider. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimension = OLLAMA_DEFAULT_DIMENSION;

  private client: unknown | null = null;
  private readonly host: string;
  private readonly model: string;

  constructor(config?: { host?: string; model?: string }) {
    this.host = config?.host ?? OLLAMA_DEFAULT_HOST;
    this.model = config?.model ?? OLLAMA_DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.ensureClient();
    try {
      const response = await (client as any).embed({
        model: this.model,
        input: text,
      });
      return response.embeddings[0] as number[];
    } catch (err: unknown) {
      throw new MemoryBackendError(
        this.name,
        `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Ollama: map to sequential calls
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await (client as any).list();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyModule(
      "ollama",
      (msg) => new MemoryConnectionError(this.name, msg),
      (mod) => {
        const OllamaClass = (mod.Ollama ?? mod.default) as any;
        return new OllamaClass({ host: this.host });
      },
    );
    return this.client;
  }
}

// ============================================================================
// Noop provider (testing)
// ============================================================================

/** Noop provider for testing (returns zero vectors). */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = "noop";
  readonly dimension: number;

  constructor(dimension?: number) {
    this.dimension = dimension ?? 128;
  }

  async embed(_text: string): Promise<number[]> {
    return new Array(this.dimension).fill(0);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(this.dimension).fill(0));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ============================================================================
// Factory with auto-selection
// ============================================================================

/** Create embedding provider with auto-selection fallback chain. */
export async function createEmbeddingProvider(config?: {
  preferred?: "openai" | "ollama" | "noop";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<EmbeddingProvider> {
  if (config?.preferred === "noop") {
    return new NoopEmbeddingProvider();
  }

  if (config?.preferred === "openai") {
    if (!config.apiKey) {
      throw new MemoryBackendError(
        "openai",
        "API key is required for OpenAI embedding provider",
      );
    }
    return new OpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  }

  if (config?.preferred === "ollama") {
    return new OllamaEmbeddingProvider({
      host: config.baseUrl,
      model: config.model,
    });
  }

  // Auto-selection: Ollama (local, private) → OpenAI/Grok → Noop fallback
  const ollama = new OllamaEmbeddingProvider({
    host: config?.baseUrl,
    model: config?.model,
  });
  if (await ollama.isAvailable()) {
    return ollama;
  }

  if (config?.apiKey) {
    const openai = new OpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    if (await openai.isAvailable()) {
      return openai;
    }
  }

  return new NoopEmbeddingProvider();
}

// ============================================================================
// Vector utilities
// ============================================================================

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/** Normalize a vector to unit length. */
export function normalizeVector(v: number[]): number[] {
  let squaredSum = 0;
  for (let i = 0; i < v.length; i++) {
    squaredSum += v[i] * v[i];
  }

  const norm = Math.sqrt(squaredSum);
  if (norm === 0) return new Array(v.length).fill(0);

  return v.map((x) => x / norm);
}
