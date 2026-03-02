import type { ChatCallUsageRecord } from "../llm/chat-executor.js";

export type ChatUsageSectionId =
  | "system"
  | "memory"
  | "history"
  | "tools"
  | "user"
  | "assistant_runtime"
  | "other";

export interface ChatUsageSection {
  readonly id: ChatUsageSectionId;
  readonly label: string;
  readonly tokens: number;
  readonly percent: number;
}

export interface ChatUsagePayload {
  readonly totalTokens: number;
  readonly budget: number;
  readonly compacted: boolean;
  readonly contextWindowTokens?: number;
  readonly promptTokens?: number;
  readonly promptTokenBudget?: number;
  readonly maxOutputTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly sections?: readonly ChatUsageSection[];
}

interface BuildChatUsagePayloadInput {
  readonly totalTokens: number;
  readonly sessionTokenBudget: number;
  readonly compacted: boolean;
  readonly contextWindowTokens?: number;
  readonly callUsage?: readonly ChatCallUsageRecord[];
}

const DEFAULT_CHAR_PER_TOKEN = 4;

const SECTION_GROUPS: ReadonlyArray<{
  readonly id: ChatUsageSectionId;
  readonly label: string;
  readonly keys: readonly string[];
}> = [
  { id: "system", label: "System prompt", keys: ["system_anchor", "system_runtime"] },
  { id: "memory", label: "Memory", keys: ["memory_working", "memory_episodic", "memory_semantic"] },
  { id: "history", label: "Chat history", keys: ["history"] },
  { id: "tools", label: "Tool schema/results", keys: ["tools"] },
  { id: "user", label: "Current user turn", keys: ["user"] },
  { id: "assistant_runtime", label: "Runtime assistant hints", keys: ["assistant_runtime"] },
  { id: "other", label: "Other", keys: ["other"] },
];

function normalizeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function charsToTokens(chars: number, charPerToken: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const normalized = Number.isFinite(charPerToken) && charPerToken > 0
    ? charPerToken
    : DEFAULT_CHAR_PER_TOKEN;
  return Math.max(0, Math.round(chars / normalized));
}

function roundPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.round(percent * 10) / 10;
}

function selectUsageRecord(
  callUsage: readonly ChatCallUsageRecord[] | undefined,
): ChatCallUsageRecord | undefined {
  if (!callUsage || callUsage.length === 0) return undefined;
  for (let idx = callUsage.length - 1; idx >= 0; idx -= 1) {
    if (callUsage[idx]?.budgetDiagnostics) return callUsage[idx];
  }
  return callUsage[callUsage.length - 1];
}

export function buildChatUsagePayload(
  input: BuildChatUsagePayloadInput,
): ChatUsagePayload {
  const payload: ChatUsagePayload = {
    totalTokens: normalizeNonNegativeInt(input.totalTokens),
    budget: normalizeNonNegativeInt(input.sessionTokenBudget),
    compacted: input.compacted === true,
  };

  const usageRecord = selectUsageRecord(input.callUsage);
  if (!usageRecord) {
    if ((input.contextWindowTokens ?? 0) > 0) {
      return {
        ...payload,
        contextWindowTokens: normalizeNonNegativeInt(input.contextWindowTokens ?? 0),
      };
    }
    return payload;
  }

  const diagnostics = usageRecord.budgetDiagnostics;
  const charPerToken = diagnostics?.model.charPerToken ?? DEFAULT_CHAR_PER_TOKEN;
  const promptTokens = charsToTokens(usageRecord.afterBudget.estimatedChars, charPerToken);
  const contextWindowTokens = diagnostics?.model.contextWindowTokens ?? input.contextWindowTokens;

  const withPromptShape: ChatUsagePayload = {
    ...payload,
    promptTokens,
    ...(contextWindowTokens && contextWindowTokens > 0
      ? { contextWindowTokens: normalizeNonNegativeInt(contextWindowTokens) }
      : {}),
    ...(diagnostics
      ? {
        promptTokenBudget: normalizeNonNegativeInt(diagnostics.model.promptTokenBudget),
        maxOutputTokens: normalizeNonNegativeInt(diagnostics.model.maxOutputTokens),
        safetyMarginTokens: normalizeNonNegativeInt(diagnostics.model.safetyMarginTokens),
      }
      : {}),
  };

  if (!diagnostics) return withPromptShape;

  const totalAfterChars = diagnostics.totalAfterChars;
  if (!Number.isFinite(totalAfterChars) || totalAfterChars <= 0) {
    return withPromptShape;
  }

  const sections = SECTION_GROUPS.map((group) => {
    const chars = group.keys.reduce((sum, key) => {
      const stats = diagnostics.sections[key as keyof typeof diagnostics.sections];
      if (!stats) return sum;
      return sum + stats.afterChars;
    }, 0);
    if (chars <= 0) return null;
    return {
      id: group.id,
      label: group.label,
      tokens: charsToTokens(chars, charPerToken),
      percent: roundPercent((chars / totalAfterChars) * 100),
    } satisfies ChatUsageSection;
  }).filter((section): section is ChatUsageSection => section !== null);

  if (sections.length === 0) return withPromptShape;
  return { ...withPromptShape, sections };
}
