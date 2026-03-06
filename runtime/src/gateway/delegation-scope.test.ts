import { describe, expect, it } from "vitest";

import { assessDelegationScope } from "./delegation-scope.js";

describe("assessDelegationScope", () => {
  it("rejects implementation work that also includes browser validation", () => {
    const result = assessDelegationScope({
      task: "core_implementation",
      objective:
        "Create index.html and src/main.ts, implement the game loop, then open localhost in the browser and validate the flow in Chromium.",
      inputContract: "Return JSON with files and validation notes",
    });

    expect(result.ok).toBe(false);
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation", "validation", "browser"]),
    );
  });

  it("rejects research work that also asks the child to implement code", () => {
    const result = assessDelegationScope({
      task: "research_plus_build",
      objective:
        "Research Phaser vs Pixi from official docs, then scaffold src/main.ts and implement the selected stack.",
      inputContract: "Return JSON with framework choice and created files",
    });

    expect(result.ok).toBe(false);
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.phases).toEqual(
      expect.arrayContaining(["research", "implementation"]),
    );
  });

  it("allows pure browser-grounded research steps", () => {
    const result = assessDelegationScope({
      task: "design_research",
      objective:
        "Research 3 reference games from official pages, navigate to each source, and return mechanics plus tuning targets.",
      inputContract: "Return JSON with references and tuning",
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["research", "browser"]),
    );
  });

  it("allows setup plus implementation without browser validation", () => {
    const result = assessDelegationScope({
      task: "core_implementation",
      objective:
        "Scaffold the project, create src/main.ts and src/Game.ts, and implement the core game loop and collision logic.",
      inputContract: "Return JSON with files_created and verification commands",
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["setup", "implementation"]),
    );
  });

  it("does not classify plain gameplay implementation as research", () => {
    const result = assessDelegationScope({
      task: "implement_gameplay",
      objective: "Implement the gameplay code only.",
      inputContract: "Return JSON with implementation summary and changed files",
      acceptanceCriteria: ["Implement the core gameplay loop"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(["implementation"]);
  });

  it("does not classify research about a failing test as validation work", () => {
    const result = assessDelegationScope({
      task: "research_failure",
      objective: "Research flaky test root cause",
      inputContract: "Provide hypothesis and evidence",
      acceptanceCriteria: ["Pinpoint likely failure source", "Cite relevant logs"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(["research"]);
  });
});
