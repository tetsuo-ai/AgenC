import { describe, expect, it } from "vitest";

import {
  COMPLEX_TURN_MAX_TOOL_ROUNDS,
  resolveMaxToolRoundsForToolNames,
  resolveTurnMaxToolRounds,
} from "./tool-round-budget.js";

describe("resolveTurnMaxToolRounds", () => {
  it("keeps the default cap when there is no routing decision", () => {
    expect(resolveTurnMaxToolRounds(3, undefined)).toBe(3);
  });

  it("keeps the default cap for read-only routed tool subsets", () => {
    expect(
      resolveTurnMaxToolRounds(3, {
        routedToolNames: ["system.readFile", "system.listDir"],
        expandedToolNames: [],
        diagnostics: {
          cacheHit: false,
          clusterKey: "read-only",
          confidence: 1,
          totalToolCount: 2,
          routedToolCount: 2,
          expandedToolCount: 0,
          schemaCharsFull: 100,
          schemaCharsRouted: 50,
          schemaCharsExpanded: 50,
          schemaCharsSaved: 50,
        },
      }),
    ).toBe(3);
  });

  it("raises the cap for coding and durable-execution routes", () => {
    expect(
      resolveTurnMaxToolRounds(3, {
        routedToolNames: ["system.bash", "system.writeFile", "system.listDir"],
        expandedToolNames: ["execute_with_agent"],
        diagnostics: {
          cacheHit: false,
          clusterKey: "coding",
          confidence: 1,
          totalToolCount: 5,
          routedToolCount: 3,
          expandedToolCount: 1,
          schemaCharsFull: 100,
          schemaCharsRouted: 50,
          schemaCharsExpanded: 75,
          schemaCharsSaved: 25,
        },
      }),
    ).toBe(COMPLEX_TURN_MAX_TOOL_ROUNDS);
  });

  it("never lowers an explicit higher default cap", () => {
    expect(
      resolveTurnMaxToolRounds(50, {
        routedToolNames: ["system.writeFile"],
        expandedToolNames: [],
        diagnostics: {
          cacheHit: false,
          clusterKey: "desktop-like",
          confidence: 1,
          totalToolCount: 1,
          routedToolCount: 1,
          expandedToolCount: 0,
          schemaCharsFull: 100,
          schemaCharsRouted: 100,
          schemaCharsExpanded: 100,
          schemaCharsSaved: 0,
        },
      }),
    ).toBe(50);
  });
});

describe("resolveMaxToolRoundsForToolNames", () => {
  it("raises the cap for iterative child tool subsets", () => {
    expect(
      resolveMaxToolRoundsForToolNames(3, [
        "system.readFile",
        "system.writeFile",
      ]),
    ).toBe(COMPLEX_TURN_MAX_TOOL_ROUNDS);
  });

  it("keeps the base cap when child tools are read-only", () => {
    expect(
      resolveMaxToolRoundsForToolNames(3, [
        "system.readFile",
        "system.listDir",
      ]),
    ).toBe(3);
  });
});
