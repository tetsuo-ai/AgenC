import type { GatewayLLMConfig } from "./types.js";

const DEFAULT_GROK_COMPACTION_THRESHOLD = 16_000;

export interface GatewayStatefulResponsesResolution {
  readonly config: GatewayLLMConfig["statefulResponses"];
  readonly usedDefaults: boolean;
}

export function resolveGatewayStatefulResponses(
  provider: GatewayLLMConfig["provider"],
  statefulResponses: GatewayLLMConfig["statefulResponses"],
): GatewayStatefulResponsesResolution {
  if (provider !== "grok") {
    return {
      config: statefulResponses,
      usedDefaults: false,
    };
  }

  if (statefulResponses?.enabled === false) {
    return {
      config: statefulResponses,
      usedDefaults: false,
    };
  }

  let usedDefaults = false;
  const enabled = statefulResponses?.enabled ?? true;
  if (statefulResponses?.enabled === undefined) usedDefaults = true;

  const store = statefulResponses?.store ?? false;
  if (statefulResponses?.store === undefined) usedDefaults = true;

  const fallbackToStateless = statefulResponses?.fallbackToStateless ?? true;
  if (statefulResponses?.fallbackToStateless === undefined) usedDefaults = true;

  const compactionEnabled = statefulResponses?.compaction?.enabled ?? true;
  if (statefulResponses?.compaction?.enabled === undefined) usedDefaults = true;

  const compactThreshold =
    statefulResponses?.compaction?.compactThreshold ??
    DEFAULT_GROK_COMPACTION_THRESHOLD;
  if (statefulResponses?.compaction?.compactThreshold === undefined) {
    usedDefaults = true;
  }

  const fallbackOnUnsupported =
    statefulResponses?.compaction?.fallbackOnUnsupported ?? true;
  if (statefulResponses?.compaction?.fallbackOnUnsupported === undefined) {
    usedDefaults = true;
  }

  return {
    config: {
      enabled,
      store,
      fallbackToStateless,
      compaction: {
        enabled: compactionEnabled,
        compactThreshold,
        fallbackOnUnsupported,
      },
    },
    usedDefaults,
  };
}
