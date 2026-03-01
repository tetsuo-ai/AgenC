import type { LLMContentPart, LLMMessage } from "./types.js";

export type PromptBudgetMemoryRole = "working" | "episodic" | "semantic";

export type PromptBudgetSection =
  | "system_anchor"
  | "system_runtime"
  | "memory_working"
  | "memory_episodic"
  | "memory_semantic"
  | "history"
  | "tools"
  | "user"
  | "assistant_runtime"
  | "other";

export interface PromptBudgetMemoryRoleContract {
  /** Relative share of the memory section budget. */
  readonly weight?: number;
  /** Minimum chars reserved for this memory role (before global normalization). */
  readonly minChars?: number;
  /** Maximum chars allowed for this memory role (before global normalization). */
  readonly maxChars?: number;
}

export type PromptBudgetMemoryRoleContracts = Partial<
  Record<PromptBudgetMemoryRole, PromptBudgetMemoryRoleContract>
>;

export interface PromptBudgetConfig {
  /** Provider/model context window in tokens. */
  readonly contextWindowTokens?: number;
  /** Requested max output tokens (provider max output setting). */
  readonly maxOutputTokens?: number;
  /** Approximate chars-per-token used for prompt sizing. */
  readonly charPerToken?: number;
  /** Safety margin reserved for protocol overhead and provider variance. */
  readonly safetyMarginTokens?: number;
  /** Optional hard upper bound on prompt chars after allocation. */
  readonly hardMaxPromptChars?: number;
  /** Memory role contracts (working/episodic/semantic) for Phase 5 compatibility. */
  readonly memoryRoleContracts?: PromptBudgetMemoryRoleContracts;
  /** Upper bound for additive runtime hint system messages per execution. */
  readonly maxRuntimeHints?: number;
}

export interface PromptBudgetModelProfile {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly promptTokenBudget: number;
  readonly charPerToken: number;
}

export interface PromptBudgetCaps {
  readonly totalChars: number;
  readonly systemChars: number;
  readonly systemAnchorChars: number;
  readonly systemRuntimeChars: number;
  readonly memoryChars: number;
  readonly memoryRoleChars: Record<PromptBudgetMemoryRole, number>;
  readonly historyChars: number;
  readonly toolChars: number;
  readonly userChars: number;
  readonly assistantRuntimeChars: number;
  readonly otherChars: number;
}

export interface PromptBudgetSectionStats {
  readonly capChars: number;
  readonly beforeMessages: number;
  readonly afterMessages: number;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly droppedMessages: number;
  readonly truncatedMessages: number;
}

export interface PromptBudgetDiagnostics {
  readonly model: PromptBudgetModelProfile;
  readonly caps: PromptBudgetCaps;
  readonly totalBeforeChars: number;
  readonly totalAfterChars: number;
  readonly constrained: boolean;
  readonly droppedSections: readonly PromptBudgetSection[];
  readonly sections: Record<PromptBudgetSection, PromptBudgetSectionStats>;
}

export interface PromptBudgetMessage {
  readonly message: LLMMessage;
  readonly section?: PromptBudgetSection;
}

export interface PromptBudgetPlan {
  readonly model: PromptBudgetModelProfile;
  readonly caps: PromptBudgetCaps;
}

export interface PromptBudgetAllocationResult {
  readonly messages: LLMMessage[];
  readonly diagnostics: PromptBudgetDiagnostics;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_CHAR_PER_TOKEN = 4;
const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;
const DEFAULT_HARD_MAX_PROMPT_CHARS = 100_000;
const MIN_PROMPT_CHAR_BUDGET = 8_000;
const MAX_PROMPT_CHAR_BUDGET = 1_500_000;

const ROLE_DEFAULT_WEIGHTS: Record<PromptBudgetMemoryRole, number> = {
  working: 0.45,
  episodic: 0.3,
  semantic: 0.25,
};

const SECTION_KEYS = [
  "system",
  "memory",
  "history",
  "tools",
  "user",
  "assistantRuntime",
] as const;

type BaseSectionKey = (typeof SECTION_KEYS)[number];

interface SectionSpec {
  readonly key: BaseSectionKey;
  readonly weight: number;
  readonly minChars: number;
  readonly maxChars: number;
}

const BASE_SECTION_SPECS: readonly SectionSpec[] = [
  { key: "system", weight: 0.2, minChars: 2_048, maxChars: 32_000 },
  { key: "memory", weight: 0.18, minChars: 1_536, maxChars: 28_000 },
  { key: "history", weight: 0.28, minChars: 2_048, maxChars: 36_000 },
  { key: "tools", weight: 0.22, minChars: 2_048, maxChars: 36_000 },
  { key: "user", weight: 0.1, minChars: 1_536, maxChars: 12_000 },
  { key: "assistantRuntime", weight: 0.02, minChars: 1_024, maxChars: 12_000 },
];

const SECTION_ORDER: readonly PromptBudgetSection[] = [
  "system_anchor",
  "system_runtime",
  "memory_working",
  "memory_episodic",
  "memory_semantic",
  "history",
  "tools",
  "user",
  "assistant_runtime",
  "other",
];

interface SectionBehavior {
  readonly dropAllowed: boolean;
  readonly newestFirst: boolean;
}

const SECTION_BEHAVIOR: Record<PromptBudgetSection, SectionBehavior> = {
  system_anchor: { dropAllowed: false, newestFirst: false },
  system_runtime: { dropAllowed: true, newestFirst: true },
  memory_working: { dropAllowed: true, newestFirst: true },
  memory_episodic: { dropAllowed: true, newestFirst: true },
  memory_semantic: { dropAllowed: true, newestFirst: true },
  history: { dropAllowed: true, newestFirst: true },
  tools: { dropAllowed: false, newestFirst: false },
  user: { dropAllowed: false, newestFirst: false },
  assistant_runtime: { dropAllowed: false, newestFirst: false },
  other: { dropAllowed: true, newestFirst: true },
};

interface WorkingEntry {
  readonly index: number;
  readonly beforeChars: number;
  readonly section: PromptBudgetSection;
  message: LLMMessage;
  dropped: boolean;
  truncated: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

function truncateContent(
  content: string | LLMContentPart[],
  maxChars: number,
): string | LLMContentPart[] {
  if (maxChars <= 0) return "";
  if (typeof content === "string") {
    return truncateText(content, maxChars);
  }

  const out: LLMContentPart[] = [];
  let used = 0;
  for (const part of content) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;

    if (part.type === "text") {
      const text = truncateText(part.text, remaining);
      if (text.length > 0) {
        out.push({ type: "text", text });
        used += text.length;
      }
      continue;
    }

    const placeholder = "[image omitted]";
    const text = truncateText(placeholder, remaining);
    if (text.length > 0) {
      out.push({ type: "text", text });
      used += text.length;
    }
  }

  return out.length > 0 ? out : [{ type: "text", text: "" }];
}

function estimateContentChars(content: string | LLMContentPart[]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => {
    if (part.type === "text") return sum + part.text.length;
    return sum + part.image_url.url.length;
  }, 0);
}

function estimateMessageChars(message: LLMMessage): number {
  return estimateContentChars(message.content) + 64;
}

function normalizeCaps(
  rawCaps: Record<BaseSectionKey, number>,
  specs: readonly SectionSpec[],
  totalChars: number,
): Record<BaseSectionKey, number> {
  let normalized = { ...rawCaps };
  const rawTotal = SECTION_KEYS.reduce((sum, key) => sum + normalized[key], 0);

  if (rawTotal > totalChars) {
    const scaled: Record<BaseSectionKey, number> = {
      system: 0,
      memory: 0,
      history: 0,
      tools: 0,
      user: 0,
      assistantRuntime: 0,
    };
    for (const spec of specs) {
      const scaledValue = Math.floor((normalized[spec.key] * totalChars) / rawTotal);
      scaled[spec.key] = clamp(scaledValue, spec.minChars, spec.maxChars);
    }
    normalized = scaled;
  }

  let adjustedTotal = SECTION_KEYS.reduce((sum, key) => sum + normalized[key], 0);
  if (adjustedTotal > totalChars) {
    for (const spec of [...specs].sort((a, b) => b.weight - a.weight)) {
      if (adjustedTotal <= totalChars) break;
      const reducible = normalized[spec.key] - spec.minChars;
      if (reducible <= 0) continue;
      const delta = Math.min(reducible, adjustedTotal - totalChars);
      normalized[spec.key] -= delta;
      adjustedTotal -= delta;
    }
  } else if (adjustedTotal < totalChars) {
    for (const spec of [...specs].sort((a, b) => b.weight - a.weight)) {
      if (adjustedTotal >= totalChars) break;
      const expandable = spec.maxChars - normalized[spec.key];
      if (expandable <= 0) continue;
      const delta = Math.min(expandable, totalChars - adjustedTotal);
      normalized[spec.key] += delta;
      adjustedTotal += delta;
    }
  }

  return normalized;
}

function normalizeRoleCaps(
  totalMemoryChars: number,
  contracts: PromptBudgetMemoryRoleContracts | undefined,
): Record<PromptBudgetMemoryRole, number> {
  const roles: PromptBudgetMemoryRole[] = ["working", "episodic", "semantic"];
  const weighted = roles.map((role) => {
    const contract = contracts?.[role];
    return {
      role,
      weight: normalizeWeight(contract?.weight, ROLE_DEFAULT_WEIGHTS[role]),
      minChars: clamp(
        Math.floor(contract?.minChars ?? 256),
        64,
        Math.max(64, totalMemoryChars),
      ),
      maxChars: clamp(
        Math.floor(contract?.maxChars ?? totalMemoryChars),
        64,
        Math.max(64, totalMemoryChars),
      ),
    };
  });

  const weightTotal = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const raw: Record<PromptBudgetMemoryRole, number> = {
    working: 0,
    episodic: 0,
    semantic: 0,
  };
  for (const entry of weighted) {
    const proportional = Math.floor((totalMemoryChars * entry.weight) / weightTotal);
    raw[entry.role] = clamp(proportional, entry.minChars, entry.maxChars);
  }

  let currentTotal = roles.reduce((sum, role) => sum + raw[role], 0);
  if (currentTotal > totalMemoryChars) {
    for (const entry of weighted.sort((a, b) => b.weight - a.weight)) {
      if (currentTotal <= totalMemoryChars) break;
      const reducible = raw[entry.role] - entry.minChars;
      if (reducible <= 0) continue;
      const delta = Math.min(reducible, currentTotal - totalMemoryChars);
      raw[entry.role] -= delta;
      currentTotal -= delta;
    }
  } else if (currentTotal < totalMemoryChars) {
    for (const entry of weighted.sort((a, b) => b.weight - a.weight)) {
      if (currentTotal >= totalMemoryChars) break;
      const expandable = entry.maxChars - raw[entry.role];
      if (expandable <= 0) continue;
      const delta = Math.min(expandable, totalMemoryChars - currentTotal);
      raw[entry.role] += delta;
      currentTotal += delta;
    }
  }

  return raw;
}

export function derivePromptBudgetPlan(
  config: PromptBudgetConfig | undefined,
): PromptBudgetPlan {
  const contextWindowTokens = clamp(
    Math.floor(config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
    2_048,
    2_000_000,
  );
  const maxOutputTokens = clamp(
    Math.floor(config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    128,
    Math.max(256, contextWindowTokens - 1_024),
  );
  const safetyMarginTokens = clamp(
    Math.floor(
      config?.safetyMarginTokens ??
        Math.max(
          DEFAULT_SAFETY_MARGIN_TOKENS,
          Math.floor(contextWindowTokens * 0.05),
        ),
    ),
    256,
    Math.max(512, Math.floor(contextWindowTokens * 0.5)),
  );
  const promptTokenBudget = Math.max(
    1_024,
    contextWindowTokens - maxOutputTokens - safetyMarginTokens,
  );
  const charPerToken = clamp(
    Math.floor(config?.charPerToken ?? DEFAULT_CHAR_PER_TOKEN),
    2,
    8,
  );
  const hardMaxPromptChars = clamp(
    Math.floor(config?.hardMaxPromptChars ?? DEFAULT_HARD_MAX_PROMPT_CHARS),
    MIN_PROMPT_CHAR_BUDGET,
    MAX_PROMPT_CHAR_BUDGET,
  );
  const totalChars = clamp(
    Math.floor(promptTokenBudget * charPerToken),
    MIN_PROMPT_CHAR_BUDGET,
    hardMaxPromptChars,
  );

  const rawCaps: Record<BaseSectionKey, number> = {
    system: 0,
    memory: 0,
    history: 0,
    tools: 0,
    user: 0,
    assistantRuntime: 0,
  };
  for (const spec of BASE_SECTION_SPECS) {
    const proportional = Math.floor(totalChars * spec.weight);
    rawCaps[spec.key] = clamp(proportional, spec.minChars, spec.maxChars);
  }
  const normalizedBase = normalizeCaps(rawCaps, BASE_SECTION_SPECS, totalChars);
  const memoryRoleChars = normalizeRoleCaps(
    normalizedBase.memory,
    config?.memoryRoleContracts,
  );
  const systemAnchorChars = clamp(
    Math.floor(normalizedBase.system * 0.75),
    512,
    normalizedBase.system,
  );
  const systemRuntimeChars = Math.max(0, normalizedBase.system - systemAnchorChars);
  const usedByTopSections =
    normalizedBase.system +
    normalizedBase.memory +
    normalizedBase.history +
    normalizedBase.tools +
    normalizedBase.user +
    normalizedBase.assistantRuntime;
  const otherChars = Math.max(0, totalChars - usedByTopSections);

  return {
    model: {
      contextWindowTokens,
      maxOutputTokens,
      safetyMarginTokens,
      promptTokenBudget,
      charPerToken,
    },
    caps: {
      totalChars,
      systemChars: normalizedBase.system,
      systemAnchorChars,
      systemRuntimeChars,
      memoryChars: normalizedBase.memory,
      memoryRoleChars,
      historyChars: normalizedBase.history,
      toolChars: normalizedBase.tools,
      userChars: normalizedBase.user,
      assistantRuntimeChars: normalizedBase.assistantRuntime,
      otherChars,
    },
  };
}

function getSectionCap(caps: PromptBudgetCaps, section: PromptBudgetSection): number {
  switch (section) {
    case "system_anchor":
      return caps.systemAnchorChars;
    case "system_runtime":
      return caps.systemRuntimeChars;
    case "memory_working":
      return caps.memoryRoleChars.working;
    case "memory_episodic":
      return caps.memoryRoleChars.episodic;
    case "memory_semantic":
      return caps.memoryRoleChars.semantic;
    case "history":
      return caps.historyChars;
    case "tools":
      return caps.toolChars;
    case "user":
      return caps.userChars;
    case "assistant_runtime":
      return caps.assistantRuntimeChars;
    case "other":
      return caps.otherChars;
    default:
      return 0;
  }
}

function createSectionCapMap(caps: PromptBudgetCaps): Record<PromptBudgetSection, number> {
  return {
    system_anchor: getSectionCap(caps, "system_anchor"),
    system_runtime: getSectionCap(caps, "system_runtime"),
    memory_working: getSectionCap(caps, "memory_working"),
    memory_episodic: getSectionCap(caps, "memory_episodic"),
    memory_semantic: getSectionCap(caps, "memory_semantic"),
    history: getSectionCap(caps, "history"),
    tools: getSectionCap(caps, "tools"),
    user: getSectionCap(caps, "user"),
    assistant_runtime: getSectionCap(caps, "assistant_runtime"),
    other: getSectionCap(caps, "other"),
  };
}

function rebalanceSectionCaps(
  baseCaps: Record<PromptBudgetSection, number>,
  beforeChars: Record<PromptBudgetSection, number>,
): Record<PromptBudgetSection, number> {
  const effective = { ...baseCaps };
  let slack = 0;
  for (const section of SECTION_ORDER) {
    const unused = effective[section] - beforeChars[section];
    if (unused > 0) slack += unused;
  }
  if (slack <= 0) return effective;

  const deficitOrder: PromptBudgetSection[] = [
    "tools",
    "history",
    "system_runtime",
    "memory_working",
    "memory_episodic",
    "memory_semantic",
    "assistant_runtime",
    "user",
    "system_anchor",
    "other",
  ];
  for (const section of deficitOrder) {
    if (slack <= 0) break;
    const deficit = beforeChars[section] - effective[section];
    if (deficit <= 0) continue;
    const delta = Math.min(deficit, slack);
    effective[section] += delta;
    slack -= delta;
  }
  return effective;
}

function resolveSections(
  input: readonly PromptBudgetMessage[],
): PromptBudgetSection[] {
  const lastUserIndex = (() => {
    for (let i = input.length - 1; i >= 0; i--) {
      if (input[i].message.role === "user") return i;
    }
    return -1;
  })();

  let anchorAssigned = false;
  return input.map((entry, index) => {
    if (entry.section) {
      if (entry.section === "system_anchor") {
        if (!anchorAssigned) {
          anchorAssigned = true;
          return "system_anchor";
        }
        return "system_runtime";
      }
      return entry.section;
    }

    const msg = entry.message;
    if (msg.role === "system") {
      if (!anchorAssigned) {
        anchorAssigned = true;
        return "system_anchor";
      }
      return "system_runtime";
    }
    if (msg.role === "tool") return "tools";
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return "assistant_runtime";
    }
    if (msg.role === "user") {
      return index === lastUserIndex ? "user" : "history";
    }
    if (msg.role === "assistant") return "history";
    return "other";
  });
}

function truncateMessage(entry: WorkingEntry, maxChars: number): void {
  const nextContent = truncateContent(entry.message.content, Math.max(0, maxChars));
  const nextMessage: LLMMessage = { ...entry.message, content: nextContent };
  const nextChars = estimateMessageChars(nextMessage);
  if (nextChars < entry.beforeChars) {
    entry.truncated = true;
  }
  entry.message = nextMessage;
}

export function applyPromptBudget(
  input: readonly PromptBudgetMessage[],
  config?: PromptBudgetConfig,
): PromptBudgetAllocationResult {
  const plan = derivePromptBudgetPlan(config);
  const sections = resolveSections(input);

  const working: WorkingEntry[] = input.map((entry, index) => ({
    index,
    beforeChars: estimateMessageChars(entry.message),
    section: sections[index],
    message: entry.message,
    dropped: false,
    truncated: false,
  }));

  const bySection = new Map<PromptBudgetSection, WorkingEntry[]>();
  for (const section of SECTION_ORDER) {
    bySection.set(section, []);
  }
  for (const entry of working) {
    bySection.get(entry.section)?.push(entry);
  }

  const baseSectionCaps = createSectionCapMap(plan.caps);
  const sectionBeforeChars: Record<PromptBudgetSection, number> = {
    system_anchor: 0,
    system_runtime: 0,
    memory_working: 0,
    memory_episodic: 0,
    memory_semantic: 0,
    history: 0,
    tools: 0,
    user: 0,
    assistant_runtime: 0,
    other: 0,
  };
  for (const section of SECTION_ORDER) {
    const entries = bySection.get(section) ?? [];
    sectionBeforeChars[section] = entries.reduce(
      (sum, entry) => sum + entry.beforeChars,
      0,
    );
  }
  const totalBeforeChars = working.reduce(
    (sum, entry) => sum + entry.beforeChars,
    0,
  );
  const constrainedByTotal = totalBeforeChars > plan.caps.totalChars;
  const sectionCaps = constrainedByTotal
    ? rebalanceSectionCaps(baseSectionCaps, sectionBeforeChars)
    : baseSectionCaps;

  if (constrainedByTotal) {
    for (const section of SECTION_ORDER) {
      const entries = bySection.get(section) ?? [];
      if (entries.length === 0) continue;

      const behavior = SECTION_BEHAVIOR[section];
      const cap = sectionCaps[section];

      if (behavior.dropAllowed) {
        const ordered = behavior.newestFirst
          ? [...entries].sort((a, b) => b.index - a.index)
          : [...entries].sort((a, b) => a.index - b.index);
        let used = 0;
        let kept = 0;

        for (const entry of ordered) {
          const remaining = cap - used;
          if (remaining <= 0) {
            entry.dropped = true;
            continue;
          }

          if (entry.beforeChars <= remaining) {
            used += entry.beforeChars;
            kept++;
            continue;
          }

          if (kept === 0) {
            truncateMessage(entry, remaining);
            used += estimateMessageChars(entry.message);
            kept++;
            continue;
          }

          entry.dropped = true;
        }
        continue;
      }

      const ordered = behavior.newestFirst
        ? [...entries].sort((a, b) => b.index - a.index)
        : [...entries].sort((a, b) => a.index - b.index);
      let used = 0;
      for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        const remainingEntries = ordered.length - i;
        const remainingBudget = Math.max(0, cap - used);
        const perMessageBudget =
          remainingEntries > 0
            ? Math.max(16, Math.floor(remainingBudget / remainingEntries))
            : 16;
        truncateMessage(entry, perMessageBudget);
        used += estimateMessageChars(entry.message);
      }
    }
  }

  const finalEntries = working
    .filter((entry) => !entry.dropped)
    .sort((a, b) => a.index - b.index);
  const finalMessages = finalEntries.map((entry) => entry.message);

  const totalAfterChars = finalEntries.reduce(
    (sum, entry) => sum + estimateMessageChars(entry.message),
    0,
  );

  const sectionStats: Record<PromptBudgetSection, PromptBudgetSectionStats> = {
    system_anchor: {
      capChars: sectionCaps.system_anchor,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    system_runtime: {
      capChars: sectionCaps.system_runtime,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    memory_working: {
      capChars: sectionCaps.memory_working,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    memory_episodic: {
      capChars: sectionCaps.memory_episodic,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    memory_semantic: {
      capChars: sectionCaps.memory_semantic,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    history: {
      capChars: sectionCaps.history,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    tools: {
      capChars: sectionCaps.tools,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    user: {
      capChars: sectionCaps.user,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    assistant_runtime: {
      capChars: sectionCaps.assistant_runtime,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
    other: {
      capChars: sectionCaps.other,
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0,
    },
  };

  for (const entry of working) {
    const current = sectionStats[entry.section];
    sectionStats[entry.section] = {
      ...current,
      beforeMessages: current.beforeMessages + 1,
      beforeChars: current.beforeChars + entry.beforeChars,
      droppedMessages: current.droppedMessages + (entry.dropped ? 1 : 0),
      truncatedMessages: current.truncatedMessages + (entry.truncated ? 1 : 0),
    };
  }
  for (const entry of finalEntries) {
    const current = sectionStats[entry.section];
    sectionStats[entry.section] = {
      ...current,
      afterMessages: current.afterMessages + 1,
      afterChars: current.afterChars + estimateMessageChars(entry.message),
    };
  }

  const droppedSections = SECTION_ORDER.filter((section) => {
    const stats = sectionStats[section];
    return stats.beforeChars > 0 && stats.afterChars === 0;
  });
  const constrained =
    totalAfterChars < totalBeforeChars ||
    droppedSections.length > 0 ||
    SECTION_ORDER.some((section) => sectionStats[section].truncatedMessages > 0);

  return {
    messages: finalMessages,
    diagnostics: {
      model: plan.model,
      caps: plan.caps,
      totalBeforeChars,
      totalAfterChars,
      constrained,
      droppedSections,
      sections: sectionStats,
    },
  };
}
