import type { LLMMessage } from "./types.js";
import type { GatewayLLMConfig } from "../gateway/types.js";
import { normalizeGrokModel } from "../gateway/context-window.js";

export const PROVIDER_NATIVE_WEB_SEARCH_TOOL = "web_search";
const PROVIDER_NATIVE_WEB_SEARCH_SCHEMA_CHARS = JSON.stringify({
  type: PROVIDER_NATIVE_WEB_SEARCH_TOOL,
}).length;

const RESEARCH_LIKE_RE =
  /\b(?:research|compare|comparison|official docs?|primary sources?|reference|references|citation|citations|look up|latest|up[- ]to[- ]date|news|framework|mechanic|mechanics|tuning)\b/i;
const INTERACTIVE_BROWSER_RE =
  /\b(?:localhost|127\.0\.0\.1|about:blank|screenshot|snapshot|console|network|dom|inspect|click|type|hover|scroll|fill|select|tab|tabs|window|windows|playtest|qa|end-to-end|e2e|navigate to|open the page)\b/i;
const GROK_SERVER_SIDE_TOOL_PREFIX = "grok-4";

export type ProviderNativeSearchMode = "auto" | "on" | "off";

export interface ProviderNativeSearchRoutingDecision {
  readonly toolName: string;
  readonly schemaChars: number;
}

export function supportsGrokServerSideTools(model: string | undefined): boolean {
  const normalized = normalizeGrokModel(model)?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.startsWith(GROK_SERVER_SIDE_TOOL_PREFIX);
}

export function resolveProviderNativeSearchMode(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): ProviderNativeSearchMode {
  if (!llmConfig || llmConfig.provider !== "grok") return "off";
  if (llmConfig.webSearch !== true) return "off";
  if (!supportsGrokServerSideTools(llmConfig.model)) return "off";
  return llmConfig.searchMode ?? "auto";
}

export function supportsProviderNativeWebSearch(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): boolean {
  return resolveProviderNativeSearchMode(llmConfig) !== "off";
}

export function getProviderNativeAdvertisedToolNames(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): readonly string[] {
  return supportsProviderNativeWebSearch(llmConfig)
    ? [PROVIDER_NATIVE_WEB_SEARCH_TOOL]
    : [];
}

export function isResearchLikeText(value: string): boolean {
  return RESEARCH_LIKE_RE.test(value);
}

export function isInteractiveBrowserText(value: string): boolean {
  return INTERACTIVE_BROWSER_RE.test(value);
}

export function getProviderNativeWebSearchRoutingDecision(
  params: {
    readonly llmConfig: Pick<
      GatewayLLMConfig,
      "provider" | "model" | "webSearch" | "searchMode"
    > | undefined;
    readonly messageText: string;
    readonly history: readonly LLMMessage[];
  },
): ProviderNativeSearchRoutingDecision | undefined {
  const mode = resolveProviderNativeSearchMode(params.llmConfig);
  if (mode === "off") return undefined;

  const recentHistory = params.history
    .slice(-4)
    .map((entry) =>
      Array.isArray(entry.content)
        ? entry.content
          .filter((part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string"
          )
          .map((part) => part.text)
          .join(" ")
        : entry.content
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const combined = `${recentHistory}\n${params.messageText}`.trim();

  if (isInteractiveBrowserText(combined)) {
    return undefined;
  }
  if (mode === "on" || isResearchLikeText(combined)) {
    return {
      toolName: PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      schemaChars: PROVIDER_NATIVE_WEB_SEARCH_SCHEMA_CHARS,
    };
  }
  return undefined;
}

export function isProviderNativeToolName(toolName: string): boolean {
  return toolName.trim() === PROVIDER_NATIVE_WEB_SEARCH_TOOL;
}
