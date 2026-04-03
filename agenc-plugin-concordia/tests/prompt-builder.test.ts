import { describe, it, expect } from "vitest";
import { buildActPrompt, buildSimulationSystemContext } from "../src/prompt-builder.js";
import { createSampleWorldProjection } from "./helpers/world-projection-fixture.js";

describe("buildActPrompt", () => {
  it("builds free prompt with action tag and world projection", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "What would {name} do next?",
        output_type: "free",
        options: [],
        tag: "action",
      },
      "Alice",
      createSampleWorldProjection(),
    );
    expect(prompt).toContain("[Concordia Action Request]");
    expect(prompt).toContain("What would Alice do next?");
    expect(prompt).toContain("[World Projection]");
    expect(prompt).toContain('"simulation_id": "sim-running"');
    expect(prompt).toContain("Return valid JSON");
    expect(prompt).toContain('"intent"');
  });

  it("builds free prompt with speech tag", () => {
    const prompt = buildActPrompt(
      {
        call_to_action: "What would {name} say?",
        output_type: "free",
        options: [],
        tag: "speech",
      },
      "Alice",
    );
    expect(prompt).toContain("[Concordia Speech Request]");
    expect(prompt).toContain("spoken words in `action`");
    expect(prompt).toContain("speech act");
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
    expect(prompt).toContain("Respond with ONLY the chosen option text");
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
    expect(prompt).toContain("Respond exactly with ONLY a single number");
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
