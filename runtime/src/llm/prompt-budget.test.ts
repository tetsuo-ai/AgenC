import { describe, it, expect } from "vitest";
import {
  applyPromptBudget,
  derivePromptBudgetPlan,
  type PromptBudgetMessage,
} from "./prompt-budget.js";
import type { LLMMessage } from "./types.js";

function textMessage(role: LLMMessage["role"], size: number): LLMMessage {
  return {
    role,
    content: `${role}:` + "x".repeat(size),
  };
}

describe("prompt-budget", () => {
  it("adapts prompt chars when max output tokens increase", () => {
    const base = derivePromptBudgetPlan({
      contextWindowTokens: 32_768,
      maxOutputTokens: 2_048,
      hardMaxPromptChars: 200_000,
    });
    const tighter = derivePromptBudgetPlan({
      contextWindowTokens: 32_768,
      maxOutputTokens: 8_192,
      hardMaxPromptChars: 200_000,
    });

    expect(tighter.caps.totalChars).toBeLessThan(base.caps.totalChars);
  });

  it("adapts prompt chars when context window shrinks", () => {
    const large = derivePromptBudgetPlan({
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
      hardMaxPromptChars: 300_000,
    });
    const small = derivePromptBudgetPlan({
      contextWindowTokens: 8_192,
      maxOutputTokens: 2_048,
      hardMaxPromptChars: 300_000,
    });

    expect(small.caps.totalChars).toBeLessThan(large.caps.totalChars);
  });

  it("keeps exactly one system anchor under pressure", () => {
    const input: PromptBudgetMessage[] = [
      { message: textMessage("system", 8_000), section: "system_anchor" },
      { message: textMessage("system", 8_000), section: "system_anchor" },
      { message: textMessage("system", 8_000), section: "system_runtime" },
      { message: textMessage("assistant", 8_000), section: "history" },
      { message: textMessage("user", 8_000), section: "user" },
    ];

    const result = applyPromptBudget(input, {
      contextWindowTokens: 4_096,
      maxOutputTokens: 2_048,
      hardMaxPromptChars: 8_000,
    });

    expect(result.diagnostics.sections.system_anchor.afterMessages).toBe(1);
    expect(result.diagnostics.sections.system_runtime.droppedMessages).toBeGreaterThan(0);
  });

  it("respects memory role contracts in caps", () => {
    const result = applyPromptBudget(
      [
        { message: textMessage("system", 2_000), section: "system_anchor" },
        { message: textMessage("system", 2_000), section: "memory_working" },
        { message: textMessage("system", 2_000), section: "memory_episodic" },
        { message: textMessage("system", 2_000), section: "memory_semantic" },
        { message: textMessage("user", 2_000), section: "user" },
      ],
      {
        contextWindowTokens: 8_192,
        maxOutputTokens: 2_048,
        hardMaxPromptChars: 16_000,
        memoryRoleContracts: {
          working: { weight: 0.7, minChars: 1_000 },
          episodic: { weight: 0.2, minChars: 512 },
          semantic: { weight: 0.1, minChars: 256 },
        },
      },
    );

    const roleCaps = result.diagnostics.caps.memoryRoleChars;
    expect(roleCaps.working).toBeGreaterThan(roleCaps.episodic);
    expect(roleCaps.episodic).toBeGreaterThanOrEqual(roleCaps.semantic);
  });

  it("records dropped/truncated diagnostics by section", () => {
    const history = Array.from({ length: 20 }, () => ({
      message: textMessage("assistant", 3_000),
      section: "history" as const,
    }));
    const tools = Array.from({ length: 6 }, () => ({
      message: textMessage("tool", 3_000),
      section: "tools" as const,
    }));
    const input: PromptBudgetMessage[] = [
      { message: textMessage("system", 6_000), section: "system_anchor" },
      ...history,
      ...tools,
      { message: textMessage("user", 2_000), section: "user" },
    ];

    const result = applyPromptBudget(input, {
      contextWindowTokens: 4_096,
      maxOutputTokens: 2_048,
      hardMaxPromptChars: 8_000,
    });

    expect(result.diagnostics.constrained).toBe(true);
    expect(result.diagnostics.sections.history.droppedMessages).toBeGreaterThan(0);
    expect(result.diagnostics.sections.tools.truncatedMessages).toBeGreaterThan(0);
  });
});
