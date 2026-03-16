/**
 * LLM provider lifecycle management — creation, catalog, budget resolution.
 *
 * Extracted from Daemon to keep provider chain construction and execution
 * budget resolution isolated from the rest of the daemon lifecycle.
 *
 * @module
 */

import type {
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMTool,
} from "../llm/types.js";
import type { GatewayLLMConfig } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import {
  inferContextWindowTokens,
  normalizeGrokModel,
  resolveContextWindowProfile,
} from "./context-window.js";
import { supportsProviderNativeWebSearch } from "../llm/provider-native-search.js";
import { resolveGatewayStatefulResponses } from "./llm-stateful-defaults.js";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_GROK_MODEL = "grok-4-1-fast-reasoning";
export const DEFAULT_GROK_FALLBACK_MODEL = "grok-4-1-fast-non-reasoning";

// ============================================================================
// Types
// ============================================================================

export interface LLMProviderConfigCatalogEntry {
  readonly provider: GatewayLLMConfig["provider"];
  readonly model?: string;
  readonly config: GatewayLLMConfig;
}

/**
 * Result of {@link createLLMProviders}. Contains the ordered provider chain
 * along with the config-to-instance mapping and catalog metadata needed
 * for downstream budget resolution and hot-swap.
 */
export interface CreateLLMProvidersResult {
  readonly providers: LLMProvider[];
  readonly primaryLlmConfig: GatewayLLMConfig | undefined;
  readonly providerConfigByInstance: WeakMap<LLMProvider, GatewayLLMConfig>;
  readonly providerConfigCatalog: LLMProviderConfigCatalogEntry[];
}

/**
 * Resolved execution budget for a single provider, used by
 * SubAgentManager and ChatExecutor factory wiring.
 */
export interface ResolvedProviderExecutionBudget {
  readonly promptBudget?: ReturnType<typeof buildPromptBudgetConfig>;
  readonly sessionTokenBudget?: number;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

// ============================================================================
// Prompt budget config builder (module-level, re-exported for daemon use)
// ============================================================================

export function buildPromptBudgetConfig(
  llmConfig: GatewayLLMConfig | undefined,
  contextWindowTokens?: number,
  maxOutputTokens?: number,
):
  | {
      contextWindowTokens?: number;
      maxOutputTokens?: number;
      hardMaxPromptChars?: number;
      safetyMarginTokens?: number;
      charPerToken?: number;
      maxRuntimeHints?: number;
    }
  | undefined {
  if (
    !llmConfig &&
    contextWindowTokens === undefined &&
    maxOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    contextWindowTokens:
      contextWindowTokens ?? inferContextWindowTokens(llmConfig),
    maxOutputTokens: maxOutputTokens ?? llmConfig?.maxTokens,
    hardMaxPromptChars: llmConfig?.promptHardMaxChars,
    safetyMarginTokens: llmConfig?.promptSafetyMarginTokens,
    charPerToken: llmConfig?.promptCharPerToken,
    maxRuntimeHints: llmConfig?.maxRuntimeHints,
  };
}

// ============================================================================
// Session token budget (module-level, re-exported for daemon use)
// ============================================================================

const DEFAULT_SESSION_TOKEN_BUDGET = 120_000;

export function resolveSessionTokenBudget(
  llmConfig: GatewayLLMConfig | undefined,
  contextWindowTokens?: number,
): number {
  if (
    typeof llmConfig?.sessionTokenBudget === "number" &&
    Number.isFinite(llmConfig.sessionTokenBudget)
  ) {
    return Math.max(0, Math.floor(llmConfig.sessionTokenBudget));
  }
  const inferredContextWindow =
    contextWindowTokens ?? inferContextWindowTokens(llmConfig);
  if (inferredContextWindow !== undefined) {
    // Use 60% of the model's context window as the session budget,
    // leaving room for system prompt, tools, and output tokens.
    // Floor at 120K for small models, no cap for large ones.
    const proportionalBudget = Math.floor(inferredContextWindow * 0.6);
    return Math.max(proportionalBudget, DEFAULT_SESSION_TOKEN_BUDGET);
  }
  return DEFAULT_SESSION_TOKEN_BUDGET;
}

// ============================================================================
// Context window resolution helper
// ============================================================================

export async function resolveLlmContextWindowTokens(
  llmConfig: GatewayLLMConfig | undefined,
  logger: Logger,
): Promise<number | undefined> {
  return (
    await resolveContextWindowProfile(llmConfig, {
      logger,
    })
  )?.contextWindowTokens;
}

// ============================================================================
// Provider catalog helpers
// ============================================================================

export function normalizeProviderCatalogModel(
  provider: string,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (provider === "grok") {
    return normalizeGrokModel(trimmed)?.toLowerCase();
  }
  return trimmed.toLowerCase();
}

export function buildProviderConfigCatalogEntry(
  config: GatewayLLMConfig,
): LLMProviderConfigCatalogEntry {
  return {
    provider: config.provider,
    model: normalizeProviderCatalogModel(config.provider, config.model),
    config,
  };
}

export function findConfiguredLlmConfigForProvider(
  provider: LLMProvider,
  profile: LLMProviderExecutionProfile | undefined,
  providerConfigByInstance: WeakMap<LLMProvider, GatewayLLMConfig>,
  providerConfigCatalog: readonly LLMProviderConfigCatalogEntry[],
  primaryLlmConfig: GatewayLLMConfig | undefined,
): GatewayLLMConfig | undefined {
  const direct = providerConfigByInstance.get(provider);
  if (direct) return direct;

  const providerName = profile?.provider ?? provider.name;
  const normalizedProvider = providerName.toLowerCase();
  if (normalizedProvider !== "grok" && normalizedProvider !== "ollama") {
    return primaryLlmConfig;
  }

  const normalizedModel = normalizeProviderCatalogModel(
    normalizedProvider,
    profile?.model,
  );
  if (!normalizedModel) {
    return providerConfigCatalog.find(
      (entry) => entry.provider === normalizedProvider,
    )?.config;
  }

  return providerConfigCatalog.find(
    (entry) =>
      entry.provider === normalizedProvider &&
      entry.model === normalizedModel,
  )?.config ??
    providerConfigCatalog.find(
      (entry) => entry.provider === normalizedProvider,
    )?.config;
}

// ============================================================================
// Execution budget resolution
// ============================================================================

export async function resolveProviderExecutionBudget(
  provider: LLMProvider,
  providerConfigByInstance: WeakMap<LLMProvider, GatewayLLMConfig>,
  providerConfigCatalog: readonly LLMProviderConfigCatalogEntry[],
  primaryLlmConfig: GatewayLLMConfig | undefined,
  logger: Logger,
): Promise<ResolvedProviderExecutionBudget> {
  let providerProfile: LLMProviderExecutionProfile | undefined;
  try {
    providerProfile = await provider.getExecutionProfile?.();
  } catch (error) {
    logger.warn?.("Failed to resolve LLM provider execution profile", {
      provider: provider.name,
      error: toErrorMessage(error),
    });
  }

  const matchedConfig = findConfiguredLlmConfigForProvider(
    provider,
    providerProfile,
    providerConfigByInstance,
    providerConfigCatalog,
    primaryLlmConfig,
  );
  const needsConfigFallback =
    matchedConfig &&
    (
      providerProfile === undefined ||
      providerProfile.contextWindowTokens === undefined ||
      providerProfile.model === undefined ||
      providerProfile.maxOutputTokens === undefined
    );
  if (needsConfigFallback) {
    const configProfile = await resolveContextWindowProfile(matchedConfig, {
      logger,
    });
    providerProfile = {
      provider:
        providerProfile?.provider ??
        configProfile?.provider ??
        matchedConfig.provider,
      model:
        providerProfile?.model ??
        configProfile?.model ??
        matchedConfig.model,
      contextWindowTokens:
        providerProfile?.contextWindowTokens ??
        configProfile?.contextWindowTokens,
      contextWindowSource:
        providerProfile?.contextWindowSource ??
        configProfile?.contextWindowSource,
      maxOutputTokens:
        providerProfile?.maxOutputTokens ??
        configProfile?.maxOutputTokens ??
        matchedConfig.maxTokens,
    };
  }

  const budgetConfig = matchedConfig ?? primaryLlmConfig;
  return {
    promptBudget: buildPromptBudgetConfig(
      budgetConfig,
      providerProfile?.contextWindowTokens,
      providerProfile?.maxOutputTokens,
    ),
    sessionTokenBudget: resolveSessionTokenBudget(
      budgetConfig,
      providerProfile?.contextWindowTokens,
    ),
    providerProfile,
  };
}

// ============================================================================
// Provider chain creation
// ============================================================================

/**
 * Create a single LLM provider from a provider config.
 */
export async function createSingleLLMProvider(
  llmConfig: GatewayLLMConfig,
  tools: LLMTool[],
  logger: Logger,
): Promise<LLMProvider | null> {
  const {
    provider,
    apiKey,
    model,
    baseUrl,
    webSearch,
    searchMode,
    timeoutMs,
    parallelToolCalls,
    maxTokens,
    statefulResponses,
  } = llmConfig;

  switch (provider) {
    case "grok": {
      const { GrokProvider } = await import("../llm/grok/adapter.js");
      const normalizedModel = normalizeGrokModel(model) ?? DEFAULT_GROK_MODEL;
      const resolvedStatefulResponses = resolveGatewayStatefulResponses(
        provider,
        statefulResponses,
      );
      const nativeWebSearchEnabled = supportsProviderNativeWebSearch({
        provider,
        model: normalizedModel,
        webSearch,
        searchMode,
      });
      if (resolvedStatefulResponses.usedDefaults) {
        logger.info(
          "Enabled Grok stateful response defaults for provider continuity",
          {
            model: normalizedModel,
            statefulResponses: resolvedStatefulResponses.config,
          },
        );
      }
      return new GrokProvider({
        apiKey: apiKey ?? "",
        model: normalizedModel,
        baseURL: baseUrl,
        contextWindowTokens: llmConfig.contextWindowTokens,
        webSearch: nativeWebSearchEnabled,
        searchMode,
        timeoutMs,
        maxTokens,
        parallelToolCalls,
        statefulResponses: resolvedStatefulResponses.config,
        tools,
      });
    }
    case "ollama": {
      const { OllamaProvider } = await import("../llm/ollama/adapter.js");
      return new OllamaProvider({
        model: model ?? "llama3",
        host: baseUrl,
        timeoutMs,
        maxTokens,
        numCtx: llmConfig.contextWindowTokens,
        statefulResponses,
        tools,
      });
    }
    default:
      logger.warn?.(`Unknown LLM provider: ${provider}`);
      return null;
  }
}

/**
 * Create the ordered provider chain: primary + optional fallbacks.
 * ChatExecutor handles cooldown-based failover across the chain.
 *
 * Returns the provider array along with config-to-instance mapping
 * metadata that the daemon assigns to its own fields.
 */
export async function createLLMProviders(
  config: { llm?: GatewayLLMConfig },
  tools: LLMTool[],
  logger: Logger,
): Promise<CreateLLMProvidersResult> {
  if (!config.llm) {
    return {
      providers: [],
      primaryLlmConfig: undefined,
      providerConfigByInstance: new WeakMap(),
      providerConfigCatalog: [],
    };
  }

  const primaryLlmConfig = config.llm;
  const providers: LLMProvider[] = [];
  const providerConfigByInstance = new WeakMap<LLMProvider, GatewayLLMConfig>();
  const providerConfigCatalog: LLMProviderConfigCatalogEntry[] = [];
  const primary = await createSingleLLMProvider(config.llm, tools, logger);
  if (primary) {
    providers.push(primary);
    providerConfigByInstance.set(primary, config.llm);
    providerConfigCatalog.push(
      buildProviderConfigCatalogEntry(config.llm),
    );
  }

  const fallbackConfigs: GatewayLLMConfig[] = [
    ...(config.llm.fallback ?? []),
  ];
  if (config.llm.provider === "grok") {
    const normalizedPrimary =
      normalizeGrokModel(config.llm.model) ?? DEFAULT_GROK_MODEL;
    const hasNonReasoningFallback = fallbackConfigs.some(
      (fb) =>
        fb.provider === "grok" &&
        (normalizeGrokModel(fb.model) ?? DEFAULT_GROK_MODEL) ===
          DEFAULT_GROK_FALLBACK_MODEL,
    );
    if (
      !hasNonReasoningFallback &&
      normalizedPrimary !== DEFAULT_GROK_FALLBACK_MODEL
    ) {
      fallbackConfigs.unshift({
        provider: "grok",
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        model: DEFAULT_GROK_FALLBACK_MODEL,
        webSearch: config.llm.webSearch,
        searchMode: config.llm.searchMode,
        maxTokens: config.llm.maxTokens,
        contextWindowTokens: config.llm.contextWindowTokens,
        promptHardMaxChars: config.llm.promptHardMaxChars,
        promptSafetyMarginTokens: config.llm.promptSafetyMarginTokens,
        promptCharPerToken: config.llm.promptCharPerToken,
        maxRuntimeHints: config.llm.maxRuntimeHints,
        statefulResponses: config.llm.statefulResponses,
      });
    }
  }

  for (const fb of fallbackConfigs) {
    const fallback = await createSingleLLMProvider(fb, tools, logger);
    if (!fallback) continue;
    providers.push(fallback);
    providerConfigByInstance.set(fallback, fb);
    providerConfigCatalog.push(buildProviderConfigCatalogEntry(fb));
  }

  return {
    providers,
    primaryLlmConfig,
    providerConfigByInstance,
    providerConfigCatalog,
  };
}
