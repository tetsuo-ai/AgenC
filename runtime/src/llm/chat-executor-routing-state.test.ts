import { describe, expect, it } from "vitest";
import {
  applyActiveRoutedToolNames,
  getAllowedToolNamesForContractGuidance,
  getAllowedToolNamesForEvidence,
  resolveEffectiveRoutedToolNames,
} from "./chat-executor-routing-state.js";

describe("chat-executor-routing-state", () => {
  it("prefers the active routed subset for evidence checks", () => {
    expect(
      getAllowedToolNamesForEvidence(
        ["mcp.doom.get_situation_report"],
        ["desktop.bash", "mcp.doom.start_game"],
      ),
    ).toEqual(["mcp.doom.get_situation_report"]);
  });

  it("keeps the broader turn universe available for contract guidance", () => {
    expect(
      getAllowedToolNamesForContractGuidance({
        activeRoutedToolNames: ["mcp.doom.set_objective"],
        initialRoutedToolNames: ["desktop.bash", "mcp.doom.start_game"],
        expandedRoutedToolNames: ["mcp.doom.set_objective", "mcp.doom.get_state"],
      }),
    ).toEqual([
      "desktop.bash",
      "mcp.doom.start_game",
      "mcp.doom.set_objective",
      "mcp.doom.get_state",
    ]);
  });

  it("carries forward the current routed subset when no explicit override is provided", () => {
    expect(
      resolveEffectiveRoutedToolNames({
        hasToolRouting: true,
        activeRoutedToolNames: ["mcp.doom.get_situation_report"],
        allowedTools: ["desktop.bash", "mcp.doom.start_game"],
      }),
    ).toEqual(["mcp.doom.get_situation_report"]);
  });

  it("normalizes and applies the active routed subset in one place", () => {
    const ctx = {
      activeRoutedToolNames: ["desktop.bash"],
    };

    expect(
      applyActiveRoutedToolNames(ctx, [
        " mcp.doom.get_situation_report ",
        "mcp.doom.get_situation_report",
        "",
      ]),
    ).toEqual(["mcp.doom.get_situation_report"]);
    expect(ctx.activeRoutedToolNames).toEqual(["mcp.doom.get_situation_report"]);
  });
});
