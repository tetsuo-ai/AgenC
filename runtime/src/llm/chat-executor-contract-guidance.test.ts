import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "./chat-executor-types.js";
import { resolveToolContractGuidance } from "./chat-executor-contract-guidance.js";

function makeToolCall(
  overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, "name">,
): ToolCallRecord {
  return {
    name: overrides.name,
    args: overrides.args ?? {},
    result: overrides.result ?? JSON.stringify({ status: "ok" }),
    isError: overrides.isError ?? false,
    durationMs: overrides.durationMs ?? 1,
  };
}

describe("chat-executor-contract-guidance", () => {
  it("routes a Doom god-mode request to start_game first", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText: "Enable god mode in Doom.",
      toolCalls: [],
      allowedToolNames: ["mcp.doom.start_game", "mcp.doom.set_god_mode"],
    });

    expect(guidance).toEqual({
      source: "doom",
      runtimeInstruction:
        "This Doom request is not complete yet. Launch Doom with `mcp.doom.start_game` before answering. " +
        "For play-until-stop requests, set `async_player: true` and preserve the requested scenario/window settings.",
      routedToolNames: ["mcp.doom.start_game"],
      toolChoice: "required",
    });
  });

  it("routes follow-up Doom turns to the next missing evidence step", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText: "Enable god mode in Doom.",
      toolCalls: [
        makeToolCall({
          name: "mcp.doom.start_game",
          result: JSON.stringify({ status: "running" }),
        }),
      ],
      allowedToolNames: ["mcp.doom.start_game", "mcp.doom.set_god_mode"],
    });

    expect(guidance).toEqual({
      source: "doom",
      runtimeInstruction:
        "God mode is still unverified. Call `mcp.doom.set_god_mode` with `enabled: true`, then verify with " +
        "`mcp.doom.get_state` or `mcp.doom.get_situation_report` before claiming invulnerability. " +
        "A `start_game` launch arg alone does not count as confirmation.",
      routedToolNames: ["mcp.doom.set_god_mode"],
      toolChoice: "required",
    });
  });

  it("routes delegated implementation turns to an editor-first tool on initial guidance", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText: "Implement the requested files.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "desktop.text_editor"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "core_implementation",
          objective: "Implement the game files in the desktop workspace",
          inputContract: "JSON output with created files",
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      routedToolNames: ["desktop.text_editor"],
      toolChoice: "required",
    });
  });

  it("routes delegated correction turns to file-mutation tools after missing file evidence", () => {
    const guidance = resolveToolContractGuidance({
      phase: "correction",
      messageText: "Implement the requested files.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "desktop.text_editor"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "core_implementation",
          objective: "Implement the game files in the desktop workspace",
          inputContract: "JSON output with created files",
        },
      },
      validationCode: "missing_file_mutation_evidence",
    });

    expect(guidance).toEqual({
      source: "delegation-correction",
      routedToolNames: ["desktop.text_editor"],
      toolChoice: "required",
    });
  });
});
