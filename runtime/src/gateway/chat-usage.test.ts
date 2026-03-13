import { describe, expect, it } from "vitest";
import type { PromptBudgetDiagnostics, PromptBudgetSection } from "../llm/prompt-budget.js";
import type { ChatCallUsageRecord } from "../llm/chat-executor.js";
import { buildChatUsagePayload } from "./chat-usage.js";

const ALL_SECTIONS: readonly PromptBudgetSection[] = [
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

function makeSectionStats(afterChars: number) {
  return {
    capChars: 4_000,
    beforeMessages: 2,
    afterMessages: 2,
    beforeChars: afterChars,
    afterChars,
    droppedMessages: 0,
    truncatedMessages: 0,
  };
}

function makeDiagnostics(): PromptBudgetDiagnostics {
  const sections: Record<PromptBudgetSection, ReturnType<typeof makeSectionStats>> = {
    system_anchor: makeSectionStats(2_000),
    system_runtime: makeSectionStats(500),
    memory_working: makeSectionStats(1_500),
    memory_episodic: makeSectionStats(1_000),
    memory_semantic: makeSectionStats(500),
    history: makeSectionStats(2_000),
    tools: makeSectionStats(1_500),
    user: makeSectionStats(700),
    assistant_runtime: makeSectionStats(200),
    other: makeSectionStats(100),
  };
  const totalAfterChars = ALL_SECTIONS.reduce(
    (sum, section) => sum + sections[section].afterChars,
    0,
  );
  return {
    model: {
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      safetyMarginTokens: 2_048,
      promptTokenBudget: 117_760,
      charPerToken: 4,
    },
    caps: {
      totalChars: totalAfterChars,
      systemChars: 2_500,
      systemAnchorChars: 2_000,
      systemRuntimeChars: 500,
      memoryChars: 3_000,
      memoryRoleChars: {
        working: 1_500,
        episodic: 1_000,
        semantic: 500,
      },
      historyChars: 2_000,
      toolChars: 1_500,
      userChars: 700,
      assistantRuntimeChars: 200,
      otherChars: 100,
    },
    totalBeforeChars: totalAfterChars,
    totalAfterChars,
    constrained: false,
    droppedSections: [],
    sections,
  };
}

function makeCallUsage(
  estimatedChars: number,
  diagnostics?: PromptBudgetDiagnostics,
): ChatCallUsageRecord {
  return {
    callIndex: 1,
    phase: "initial",
    provider: "grok",
    model: "grok-4-1-fast-reasoning",
    finishReason: "stop",
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    beforeBudget: {
      messageCount: 8,
      systemMessages: 2,
      userMessages: 2,
      assistantMessages: 3,
      toolMessages: 1,
      estimatedChars: estimatedChars + 100,
      systemPromptChars: 2_500,
    },
    afterBudget: {
      messageCount: 8,
      systemMessages: 2,
      userMessages: 2,
      assistantMessages: 3,
      toolMessages: 1,
      estimatedChars,
      systemPromptChars: 2_500,
    },
    budgetDiagnostics: diagnostics,
  };
}

describe("buildChatUsagePayload", () => {
  it("includes model window and section breakdown when diagnostics exist", () => {
    const payload = buildChatUsagePayload({
      totalTokens: 12_345,
      sessionTokenBudget: 90_000,
      compacted: true,
      provider: "grok",
      model: "grok-4-1-fast-reasoning",
      usedFallback: true,
      callUsage: [makeCallUsage(9_600, makeDiagnostics())],
    });

    expect(payload).toMatchObject({
      totalTokens: 12_345,
      budget: 90_000,
      compacted: true,
      provider: "grok",
      model: "grok-4-1-fast-reasoning",
      usedFallback: true,
      contextWindowTokens: 128_000,
      promptTokens: 2_400,
      promptTokenBudget: 117_760,
      maxOutputTokens: 8_192,
      safetyMarginTokens: 2_048,
    });

    const memory = payload.sections?.find((section) => section.id === "memory");
    expect(memory).toMatchObject({
      label: "Memory",
      tokens: 750,
      percent: 30,
    });
  });

  it("falls back to provided context window without diagnostics", () => {
    const payload = buildChatUsagePayload({
      totalTokens: 500,
      sessionTokenBudget: 0,
      compacted: false,
      contextWindowTokens: 64_000,
      callUsage: [makeCallUsage(800)],
    });

    expect(payload).toMatchObject({
      totalTokens: 500,
      budget: 0,
      compacted: false,
      contextWindowTokens: 64_000,
      promptTokens: 200,
    });
    expect(payload.sections).toBeUndefined();
  });

  it("reuses earlier diagnostics when later calls omit them", () => {
    const payload = buildChatUsagePayload({
      totalTokens: 4_000,
      sessionTokenBudget: 50_000,
      compacted: false,
      contextWindowTokens: 16_000,
      callUsage: [
        makeCallUsage(6_400, makeDiagnostics()),
        makeCallUsage(1_200),
      ],
    });

    expect(payload.contextWindowTokens).toBe(128_000);
    expect(payload.promptTokenBudget).toBe(117_760);
    expect(payload.sections?.length).toBeGreaterThan(0);
  });
});
