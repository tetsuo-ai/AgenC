import { describe, it, expect } from "vitest";
import { buildActPrompt, buildSimulationSystemContext } from "../src/prompt-builder.js";

describe("buildActPrompt", () => {
  it("builds free prompt with action tag", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "What would Alice do next?",
        output_type: "free",
        options: [],
        tag: "action",
      },
      "Alice",
    );
    expect(prompt).toContain("[Simulation Context]");
    expect(prompt).toContain("What would Alice do next?");
    expect(prompt).toContain("ONLY your action");
    expect(prompt).not.toContain("dialogue");
  });

  it("builds free prompt with speech tag", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "What would Alice say?",
        output_type: "free",
        options: [],
        tag: "speech",
      },
      "Alice",
    );
    expect(prompt).toContain("in character as Alice");
    expect(prompt).toContain("natural dialogue");
  });

  it("builds choice prompt with numbered options", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "Does Bob accept?",
        output_type: "choice",
        options: ["Accept", "Reject", "Counter-offer"],
        tag: "action",
      },
      "Bob",
    );
    expect(prompt).toContain("1. Accept");
    expect(prompt).toContain("2. Reject");
    expect(prompt).toContain("3. Counter-offer");
    expect(prompt).toContain("EXACTLY one of these options");
  });

  it("builds float prompt", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "How confident?",
        output_type: "float",
        options: [],
        tag: null,
      },
      "Sam",
    );
    expect(prompt).toContain("single number");
  });

  it("falls through to raw call_to_action for unknown type", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "Unknown type",
        output_type: "unknown" as any,
        options: [],
        tag: null,
      },
      "X",
    );
    expect(prompt).toBe("Unknown type");
  });
});

describe("buildSimulationSystemContext", () => {
  it("includes world ID and agent name", () => {
    const ctx = buildSimulationSystemContext({
      worldId: "medieval-town-001",
      agentName: "Elena",
      turnCount: 5,
    });
    expect(ctx).toContain("medieval-town-001");
    expect(ctx).toContain("Elena");
    expect(ctx).toContain("turn: 5");
  });

  it("includes premise when provided", () => {
    const ctx = buildSimulationSystemContext({
      worldId: "w1",
      agentName: "A",
      turnCount: 1,
      premise: "It is morning in Thornfield.",
    });
    expect(ctx).toContain("Premise: It is morning in Thornfield.");
  });

  it("omits premise when not provided", () => {
    const ctx = buildSimulationSystemContext({
      worldId: "w1",
      agentName: "A",
      turnCount: 1,
    });
    expect(ctx).not.toContain("Premise:");
  });
});
