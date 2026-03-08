import type {
  LLMCompactionDiagnostics,
  LLMProviderCapabilities,
  LLMStatefulDiagnostics,
  LLMStatefulResponsesConfig,
} from "./types.js";

const DEFAULT_STATEFUL_RECONCILIATION_WINDOW = 48;
const MAX_STATEFUL_RECONCILIATION_WINDOW = 256;
const DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED = true;

export interface ResolvedLLMCompactionConfig {
  readonly enabled: boolean;
  readonly compactThreshold?: number;
  readonly fallbackOnUnsupported: boolean;
}

export interface ResolvedLLMStatefulResponsesConfig {
  readonly enabled: boolean;
  readonly store: boolean;
  readonly fallbackToStateless: boolean;
  readonly reconciliationWindow: number;
  readonly compaction: ResolvedLLMCompactionConfig;
}

export const UNSUPPORTED_STATEFUL_CAPABILITIES: LLMProviderCapabilities["stateful"] = {
  assistantPhase: false,
  previousResponseId: false,
  opaqueCompaction: false,
  deterministicFallback: true,
};

export function resolveLLMStatefulResponsesConfig(
  config: LLMStatefulResponsesConfig | undefined,
): ResolvedLLMStatefulResponsesConfig {
  const enabled = config?.enabled === true;
  return {
    enabled,
    store: config?.store ?? enabled,
    fallbackToStateless: config?.fallbackToStateless ?? true,
    reconciliationWindow: Math.min(
      MAX_STATEFUL_RECONCILIATION_WINDOW,
      Math.max(1, Math.floor(config?.reconciliationWindow ?? DEFAULT_STATEFUL_RECONCILIATION_WINDOW)),
    ),
    compaction: {
      enabled: config?.compaction?.enabled === true,
      compactThreshold:
        typeof config?.compaction?.compactThreshold === "number" &&
          Number.isFinite(config.compaction.compactThreshold) &&
          config.compaction.compactThreshold > 0
          ? Math.floor(config.compaction.compactThreshold)
          : undefined,
      fallbackOnUnsupported:
        config?.compaction?.fallbackOnUnsupported ??
        DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED,
    },
  };
}

export function buildUnsupportedStatefulDiagnostics(input: {
  readonly provider: string;
  readonly config: ResolvedLLMStatefulResponsesConfig;
  readonly hasSessionId: boolean;
}): LLMStatefulDiagnostics | undefined {
  if (!input.config.enabled || !input.hasSessionId) {
    return undefined;
  }
  return {
    enabled: true,
    attempted: false,
    continued: false,
    store: input.config.store,
    fallbackToStateless: input.config.fallbackToStateless,
    fallbackReason: "unsupported",
    events: [
      {
        type: "stateful_fallback",
        reason: "unsupported",
        detail:
          `${input.provider} does not support provider-managed previous_response_id continuation`,
      },
    ],
  };
}

export function buildUnsupportedCompactionDiagnostics(input: {
  readonly provider: string;
  readonly config: ResolvedLLMStatefulResponsesConfig;
}): LLMCompactionDiagnostics | undefined {
  const compaction = input.config.compaction;
  if (!compaction.enabled || compaction.compactThreshold === undefined) {
    return undefined;
  }
  return {
    enabled: true,
    requested: true,
    active: false,
    mode: "server_side_context_management",
    threshold: compaction.compactThreshold,
    observedItemCount: 0,
    fallbackReason: "unsupported",
  };
}
