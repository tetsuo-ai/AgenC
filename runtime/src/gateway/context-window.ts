import { createHash } from "node:crypto";
import type { GatewayLLMConfig } from "./types.js";
import type {
  LLMContextWindowSource,
  LLMProviderExecutionProfile,
} from "../llm/types.js";

const DEFAULT_GROK_API_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_GROK_CONTEXT_WINDOW_TOKENS = 256_000;
const DEFAULT_OLLAMA_CONTEXT_WINDOW_TOKENS = 4_096;
const DEFAULT_OLLAMA_MODEL = "llama3";
const MIN_CONTEXT_WINDOW_TOKENS = 2_048;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
const DYNAMIC_FETCH_TIMEOUT_MS = 8_000;
const DYNAMIC_MODELS_CACHE_TTL_MS = 15 * 60_000;
const DYNAMIC_OLLAMA_RUNTIME_CACHE_TTL_MS = 30_000;
const DYNAMIC_OLLAMA_MODEL_INFO_CACHE_TTL_MS = 15 * 60_000;

const LEGACY_GROK_MODEL_ALIASES: Record<string, string> = {
  "grok-4": "grok-4-1-fast-reasoning",
  "grok-4-fast-reasoning": "grok-4-1-fast-reasoning",
  "grok-4-fast-non-reasoning": "grok-4-1-fast-non-reasoning",
};

const GROK_CONTEXT_WINDOW_BY_PREFIX: ReadonlyArray<{
  readonly prefix: string;
  readonly contextWindowTokens: number;
}> = [
  // Source: xAI Docs MCP page developers/models (retrieved March 2, 2026)
  { prefix: "grok-4-1-fast", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-fast", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-1-fast-reasoning", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-1-fast-non-reasoning", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-fast-reasoning", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-fast-non-reasoning", contextWindowTokens: 2_000_000 },
  {
    prefix: "grok-4.20-experimental-beta-0304-reasoning",
    contextWindowTokens: 2_000_000,
  },
  {
    prefix: "grok-4.20-experimental-beta-0304-non-reasoning",
    contextWindowTokens: 2_000_000,
  },
  {
    prefix: "grok-4.20-multi-agent-experimental-beta-0304",
    contextWindowTokens: 2_000_000,
  },
  { prefix: "grok-code-fast-1", contextWindowTokens: 256_000 },
  { prefix: "grok-4-0709", contextWindowTokens: 256_000 },
  { prefix: "grok-3-mini", contextWindowTokens: 131_072 },
  { prefix: "grok-3", contextWindowTokens: 131_072 },
  { prefix: "grok-2-vision-1212", contextWindowTokens: 32_768 },
];

interface LoggerLike {
  debug?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

interface DynamicContextWindowOptions {
  readonly fetchImpl?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly ollamaRuntimeCacheTtlMs?: number;
  readonly ollamaModelInfoCacheTtlMs?: number;
  readonly logger?: LoggerLike;
}

interface CachedModelCatalog {
  readonly expiresAtMs: number;
  readonly byModelId: Map<string, number>;
}

interface CachedResolvedContextWindow {
  readonly expiresAtMs: number;
  readonly resolved?: ResolvedContextWindow;
}

interface ResolvedContextWindow {
  readonly contextWindowTokens: number;
  readonly source: LLMContextWindowSource;
}

const grokCatalogCache = new Map<string, CachedModelCatalog>();
const ollamaRuntimeCatalogCache = new Map<string, CachedModelCatalog>();
const ollamaModelInfoCache = new Map<string, CachedResolvedContextWindow>();

function normalizeBaseUrl(
  baseUrl: string | undefined,
  defaultBaseUrl: string,
): string {
  const raw = baseUrl?.trim() || defaultBaseUrl;
  return raw.replace(/\/+$/, "");
}

function buildDynamicCacheKey(baseUrl: string, credentialSeed: string): string {
  const digest = createHash("sha256")
    .update(credentialSeed)
    .digest("hex")
    .slice(0, 16);
  return `${baseUrl}#${digest}`;
}

function normalizeNumericContextWindow(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (
    normalized < MIN_CONTEXT_WINDOW_TOKENS ||
    normalized > MAX_CONTEXT_WINDOW_TOKENS
  ) {
    return undefined;
  }
  return normalized;
}

function parseContextTokenValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizeNumericContextWindow(value);
  }
  if (typeof value === "string") {
    const compact = value.trim();
    if (!/^\d[\d,_\s]*$/.test(compact)) return undefined;
    const parsed = Number(compact.replace(/[,_\s]/g, ""));
    if (!Number.isFinite(parsed)) return undefined;
    return normalizeNumericContextWindow(parsed);
  }
  return undefined;
}

function isContextCandidatePath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (
    /(^|[._])(rpm|tpm|rate|pricing|price|cost|throughput)($|[._])/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    normalized.includes("context") ||
    normalized.includes("window") ||
    normalized.includes("length")
  ) {
    return true;
  }
  if (
    normalized.includes("input") &&
    normalized.includes("token") &&
    (normalized.includes("max") || normalized.includes("limit"))
  ) {
    return true;
  }
  return false;
}

function collectContextCandidates(
  node: unknown,
  path: string[],
  out: number[],
): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((entry, idx) => {
      collectContextCandidates(entry, [...path, String(idx)], out);
    });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const nextPath = [...path, key];
    const pathLabel = nextPath.join(".");
    const parsed = parseContextTokenValue(value);
    if (parsed !== undefined && isContextCandidatePath(pathLabel)) {
      out.push(parsed);
    }
    collectContextCandidates(value, nextPath, out);
  }
}

function toModelEntryArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  }
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record.data, record.models, record.items, record.results];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  }
  return [];
}

function extractModelId(entry: Record<string, unknown>): string | undefined {
  const raw =
    (typeof entry.id === "string" && entry.id) ||
    (typeof entry.model_id === "string" && entry.model_id) ||
    (typeof entry.model === "string" && entry.model) ||
    (typeof entry.name === "string" && entry.name) ||
    (typeof entry.slug === "string" && entry.slug) ||
    undefined;
  const normalized = raw?.trim();
  return normalized ? normalized.toLowerCase() : undefined;
}

function extractContextWindowFromModel(
  entry: Record<string, unknown>,
): number | undefined {
  const directFields = [
    entry.context_window,
    entry.contextWindow,
    entry.context_length,
    entry.contextLength,
    entry.max_context_tokens,
    entry.maxContextTokens,
    entry.input_token_limit,
    entry.inputTokenLimit,
    entry.max_input_tokens,
    entry.maxInputTokens,
  ];
  for (const value of directFields) {
    const parsed = parseContextTokenValue(value);
    if (parsed !== undefined) return parsed;
  }

  const candidates: number[] = [];
  collectContextCandidates(entry, [], candidates);
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

function buildCatalogFromPayload(payload: unknown): Map<string, number> {
  const catalog = new Map<string, number>();
  for (const entry of toModelEntryArray(payload)) {
    const modelId = extractModelId(entry);
    if (!modelId) continue;
    const contextWindow = extractContextWindowFromModel(entry);
    if (contextWindow === undefined) continue;
    catalog.set(modelId, contextWindow);
  }
  return catalog;
}

function lookupContextWindow(
  catalog: Map<string, number>,
  candidates: ReadonlySet<string>,
): number | undefined {
  for (const candidate of candidates) {
    const exact = catalog.get(candidate);
    if (exact !== undefined) return exact;
  }

  let bestMatch: { id: string; tokens: number } | undefined;
  for (const [id, tokens] of catalog) {
    for (const candidate of candidates) {
      if (!id.startsWith(candidate) && !candidate.startsWith(id)) continue;
      if (!bestMatch || id.length > bestMatch.id.length) {
        bestMatch = { id, tokens };
      }
    }
  }
  return bestMatch?.tokens;
}

function buildGrokModelLookupCandidates(
  model: string | undefined,
): ReadonlySet<string> {
  const normalized = normalizeGrokModel(model)?.toLowerCase();
  if (!normalized) return new Set();
  const candidates = new Set<string>([normalized]);
  if (normalized.endsWith("-latest")) {
    candidates.add(normalized.slice(0, -"-latest".length));
  }
  return candidates;
}

function buildOllamaModelLookupCandidates(
  model: string | undefined,
): ReadonlySet<string> {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return new Set();
  const candidates = new Set<string>([normalized]);
  if (normalized.endsWith(":latest")) {
    candidates.add(normalized.slice(0, -":latest".length));
  } else if (!normalized.includes(":")) {
    candidates.add(`${normalized}:latest`);
  }
  return candidates;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DYNAMIC_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGrokModelCatalog(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  logger: LoggerLike | undefined,
): Promise<Map<string, number>> {
  const endpoints = ["/models", "/language-models"];
  let lastError: unknown;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;
    try {
      const payload = await fetchJsonWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        },
        fetchImpl,
      );
      const catalog = buildCatalogFromPayload(payload);
      if (catalog.size > 0) return catalog;
      lastError = new Error(`No context window fields found in ${url} response`);
    } catch (error) {
      lastError = error;
    }
  }

  logger?.debug?.("Dynamic Grok model metadata fetch failed", {
    baseUrl,
    error:
      lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "unknown error"),
  });
  return new Map();
}

async function resolveDynamicGrokContextWindowTokens(
  llmConfig: GatewayLLMConfig,
  options?: DynamicContextWindowOptions,
): Promise<number | undefined> {
  if (llmConfig.provider !== "grok" || !llmConfig.apiKey) return undefined;

  const fetchImpl = options?.fetchImpl ?? fetch;
  const logger = options?.logger;
  const cacheTtlMs = options?.cacheTtlMs ?? DYNAMIC_MODELS_CACHE_TTL_MS;
  const baseUrl = normalizeBaseUrl(llmConfig.baseUrl, DEFAULT_GROK_API_BASE_URL);
  const cacheKey = buildDynamicCacheKey(baseUrl, llmConfig.apiKey);
  const now = Date.now();
  const cached = grokCatalogCache.get(cacheKey);

  if (cached && cached.expiresAtMs > now) {
    return lookupContextWindow(
      cached.byModelId,
      buildGrokModelLookupCandidates(llmConfig.model),
    );
  }

  const catalog = await fetchGrokModelCatalog(
    baseUrl,
    llmConfig.apiKey,
    fetchImpl,
    logger,
  );
  if (catalog.size > 0) {
    grokCatalogCache.set(cacheKey, {
      byModelId: catalog,
      expiresAtMs: now + Math.max(1_000, Math.floor(cacheTtlMs)),
    });
    return lookupContextWindow(catalog, buildGrokModelLookupCandidates(llmConfig.model));
  }

  if (cached) {
    logger?.warn?.("Using stale Grok model metadata cache after refresh failure");
    return lookupContextWindow(
      cached.byModelId,
      buildGrokModelLookupCandidates(llmConfig.model),
    );
  }

  return undefined;
}

async function fetchOllamaRuntimeCatalog(
  host: string,
  fetchImpl: typeof fetch,
  logger: LoggerLike | undefined,
): Promise<Map<string, number>> {
  const url = `${host}/api/ps`;
  try {
    const payload = await fetchJsonWithTimeout(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      fetchImpl,
    );
    return buildCatalogFromPayload(payload);
  } catch (error) {
    logger?.debug?.("Dynamic Ollama runtime metadata fetch failed", {
      host,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

function parseOllamaParametersContextWindow(
  value: unknown,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(
    /(?:^|\r?\n)\s*num_ctx(?:\s+|=|:)\s*([0-9][0-9,_\s]*)/im,
  );
  return parseContextTokenValue(match?.[1]);
}

function extractOllamaShowContextWindow(
  payload: unknown,
): ResolvedContextWindow | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const fromModelInfo = extractContextWindowFromModel(record);
  if (fromModelInfo !== undefined) {
    return {
      contextWindowTokens: fromModelInfo,
      source: "ollama_model_info",
    };
  }
  const fromParameters = parseOllamaParametersContextWindow(record.parameters);
  if (fromParameters !== undefined) {
    return {
      contextWindowTokens: fromParameters,
      source: "ollama_model_parameters",
    };
  }
  return undefined;
}

async function resolveDynamicOllamaContextWindow(
  llmConfig: GatewayLLMConfig,
  options?: DynamicContextWindowOptions,
): Promise<ResolvedContextWindow | undefined> {
  if (llmConfig.provider !== "ollama") return undefined;

  const model = llmConfig.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const host = normalizeBaseUrl(llmConfig.baseUrl, DEFAULT_OLLAMA_HOST);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const logger = options?.logger;
  const runtimeCacheTtlMs =
    options?.ollamaRuntimeCacheTtlMs ?? DYNAMIC_OLLAMA_RUNTIME_CACHE_TTL_MS;
  const modelInfoCacheTtlMs =
    options?.ollamaModelInfoCacheTtlMs ?? DYNAMIC_OLLAMA_MODEL_INFO_CACHE_TTL_MS;
  const now = Date.now();

  const runtimeCached = ollamaRuntimeCatalogCache.get(host);
  if (runtimeCached && runtimeCached.expiresAtMs > now) {
    const matched = lookupContextWindow(
      runtimeCached.byModelId,
      buildOllamaModelLookupCandidates(model),
    );
    if (matched !== undefined) {
      return {
        contextWindowTokens: matched,
        source: "ollama_running_context_length",
      };
    }
  }

  const runtimeCatalog = await fetchOllamaRuntimeCatalog(host, fetchImpl, logger);
  if (runtimeCatalog.size > 0) {
    ollamaRuntimeCatalogCache.set(host, {
      byModelId: runtimeCatalog,
      expiresAtMs: now + Math.max(1_000, Math.floor(runtimeCacheTtlMs)),
    });
    const matched = lookupContextWindow(
      runtimeCatalog,
      buildOllamaModelLookupCandidates(model),
    );
    if (matched !== undefined) {
      return {
        contextWindowTokens: matched,
        source: "ollama_running_context_length",
      };
    }
  } else if (runtimeCached) {
    const matched = lookupContextWindow(
      runtimeCached.byModelId,
      buildOllamaModelLookupCandidates(model),
    );
    if (matched !== undefined) {
      logger?.warn?.(
        "Using stale Ollama runtime context metadata cache after refresh failure",
        { host, model },
      );
      return {
        contextWindowTokens: matched,
        source: "ollama_running_context_length",
      };
    }
  }

  const modelInfoCacheKey = `${host}#${model.toLowerCase()}`;
  const cachedModelInfo = ollamaModelInfoCache.get(modelInfoCacheKey);
  if (cachedModelInfo && cachedModelInfo.expiresAtMs > now) {
    return cachedModelInfo.resolved;
  }

  const url = `${host}/api/show`;
  try {
    const payload = await fetchJsonWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ model }),
      },
      fetchImpl,
    );
    const resolved = extractOllamaShowContextWindow(payload);
    ollamaModelInfoCache.set(modelInfoCacheKey, {
      resolved,
      expiresAtMs: now + Math.max(1_000, Math.floor(modelInfoCacheTtlMs)),
    });
    if (resolved) return resolved;
  } catch (error) {
    logger?.debug?.("Dynamic Ollama model metadata fetch failed", {
      host,
      model,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (cachedModelInfo?.resolved) {
    logger?.warn?.("Using stale Ollama model metadata cache after refresh failure", {
      host,
      model,
    });
    return cachedModelInfo.resolved;
  }

  return undefined;
}

export function clearDynamicContextWindowCache(): void {
  grokCatalogCache.clear();
  ollamaRuntimeCatalogCache.clear();
  ollamaModelInfoCache.clear();
}

export function normalizeGrokModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  return LEGACY_GROK_MODEL_ALIASES[trimmed] ?? trimmed;
}

export function inferGrokContextWindowTokens(model: string | undefined): number {
  const normalized = normalizeGrokModel(model);
  if (!normalized) return DEFAULT_GROK_CONTEXT_WINDOW_TOKENS;

  for (const entry of GROK_CONTEXT_WINDOW_BY_PREFIX) {
    if (normalized.startsWith(entry.prefix)) return entry.contextWindowTokens;
  }
  return DEFAULT_GROK_CONTEXT_WINDOW_TOKENS;
}

export function inferContextWindowTokens(
  llmConfig: GatewayLLMConfig | undefined,
): number | undefined {
  if (!llmConfig) return undefined;
  const explicit = parseContextTokenValue(llmConfig.contextWindowTokens);
  if (explicit !== undefined) {
    return explicit;
  }
  if (llmConfig.provider === "grok") {
    return inferGrokContextWindowTokens(llmConfig.model);
  }
  if (llmConfig.provider === "ollama") {
    return DEFAULT_OLLAMA_CONTEXT_WINDOW_TOKENS;
  }
  return undefined;
}

export async function resolveDynamicContextWindowTokens(
  llmConfig: GatewayLLMConfig | undefined,
  options?: DynamicContextWindowOptions,
): Promise<number | undefined> {
  if (!llmConfig) return undefined;
  if (llmConfig.provider === "grok") {
    return resolveDynamicGrokContextWindowTokens(llmConfig, options);
  }
  if (llmConfig.provider === "ollama") {
    return (await resolveDynamicOllamaContextWindow(llmConfig, options))
      ?.contextWindowTokens;
  }
  return undefined;
}

export async function resolveContextWindowProfile(
  llmConfig: GatewayLLMConfig | undefined,
  options?: DynamicContextWindowOptions,
): Promise<LLMProviderExecutionProfile | undefined> {
  if (!llmConfig) return undefined;

  const explicit = parseContextTokenValue(llmConfig.contextWindowTokens);
  if (llmConfig.provider === "grok") {
    const model = normalizeGrokModel(llmConfig.model);
    if (explicit !== undefined) {
      return {
        provider: "grok",
        model,
        contextWindowTokens: explicit,
        contextWindowSource: "explicit_config",
        maxOutputTokens: llmConfig.maxTokens,
      };
    }
    const dynamic = await resolveDynamicGrokContextWindowTokens(llmConfig, options);
    if (dynamic !== undefined) {
      return {
        provider: "grok",
        model,
        contextWindowTokens: dynamic,
        contextWindowSource: "grok_model_catalog",
        maxOutputTokens: llmConfig.maxTokens,
      };
    }
    return {
      provider: "grok",
      model,
      contextWindowTokens: inferGrokContextWindowTokens(model),
      contextWindowSource: "grok_model_heuristic",
      maxOutputTokens: llmConfig.maxTokens,
    };
  }

  if (llmConfig.provider === "ollama") {
    const model = llmConfig.model?.trim() || DEFAULT_OLLAMA_MODEL;
    if (explicit !== undefined) {
      return {
        provider: "ollama",
        model,
        contextWindowTokens: explicit,
        contextWindowSource: "ollama_request_num_ctx",
        maxOutputTokens: llmConfig.maxTokens,
      };
    }
    const dynamic = await resolveDynamicOllamaContextWindow(llmConfig, options);
    if (dynamic) {
      return {
        provider: "ollama",
        model,
        contextWindowTokens: dynamic.contextWindowTokens,
        contextWindowSource: dynamic.source,
        maxOutputTokens: llmConfig.maxTokens,
      };
    }
    return {
      provider: "ollama",
      model,
      contextWindowTokens: DEFAULT_OLLAMA_CONTEXT_WINDOW_TOKENS,
      contextWindowSource: "ollama_default",
      maxOutputTokens: llmConfig.maxTokens,
    };
  }

  return undefined;
}
