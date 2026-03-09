import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  resolveToolContractExecutionBlock,
  resolveToolContractGuidance,
} from "./chat-executor-contract-guidance.js";

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
      enforcement: {
        mode: "block_other_tools",
        message:
          "This Doom turn must begin with `mcp.doom.start_game`. " +
          "Do not launch or inspect Doom with `desktop.bash`, `desktop.process_start`, `system.bash`, or direct binary commands before the MCP launch succeeds.",
      },
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

  it("blocks desktop/bash detours before the Doom launch contract is satisfied", () => {
    const block = resolveToolContractExecutionBlock({
      phase: "initial",
      messageText:
        "I want you to play doom on defend the center with godmode on so i can watch in a desktop container.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "mcp.doom.start_game"],
      candidateToolName: "desktop.bash",
    });

    expect(block).toBe(
      "This Doom turn must begin with `mcp.doom.start_game`. " +
      "Do not launch or inspect Doom with `desktop.bash`, `desktop.process_start`, `system.bash`, or direct binary commands before the MCP launch succeeds. " +
      "Allowed now: `mcp.doom.start_game`. " +
      "Do not use `desktop.bash` yet.",
    );
  });

  it("stops blocking once Doom launch evidence exists", () => {
    const block = resolveToolContractExecutionBlock({
      phase: "tool_followup",
      messageText:
        "I want you to play doom on defend the center with godmode on so i can watch in a desktop container.",
      toolCalls: [
        makeToolCall({
          name: "mcp.doom.start_game",
          args: { async_player: true },
          result: JSON.stringify({ status: "running" }),
        }),
      ],
      allowedToolNames: ["desktop.bash", "mcp.doom.start_game"],
      candidateToolName: "desktop.bash",
    });

    expect(block).toBeUndefined();
  });

  it("routes durable server turns to system.serverStart first", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Start a durable HTTP server on port 8781, verify it is ready, and keep it running until I tell you to stop.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "system.serverStart", "system.serverStatus"],
    });

    expect(guidance).toEqual({
      source: "server-handle",
      runtimeInstruction:
        "This durable server request must begin with `system.serverStart`. " +
        "Use the typed server handle path first, then verify readiness before answering.",
      routedToolNames: ["system.serverStart"],
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          "This server turn must begin with `system.serverStart`. " +
          "Do not launch or probe the server with `desktop.bash`, `desktop.process_start`, `system.processStart`, or ad hoc shell commands before the typed server handle exists.",
      },
    });
  });

  it("blocks desktop shell detours before the server handle exists", () => {
    const block = resolveToolContractExecutionBlock({
      phase: "initial",
      messageText:
        "Start a durable HTTP server on port 8781, verify it is ready, and keep it running until I tell you to stop.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "system.serverStart"],
      candidateToolName: "desktop.bash",
    });

    expect(block).toBe(
      "This server turn must begin with `system.serverStart`. " +
      "Do not launch or probe the server with `desktop.bash`, `desktop.process_start`, `system.processStart`, or ad hoc shell commands before the typed server handle exists. " +
      "Allowed now: `system.serverStart`. " +
      "Do not use `desktop.bash` yet.",
    );
  });

  it("routes durable server turns to system.serverStatus after launch", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText:
        "Start a durable HTTP server on port 8781, verify it is ready, and keep it running until I tell you to stop.",
      toolCalls: [
        makeToolCall({
          name: "system.serverStart",
          result: JSON.stringify({ serverId: "server_123", state: "starting" }),
        }),
      ],
      allowedToolNames: ["system.serverStart", "system.serverStatus", "system.serverResume"],
    });

    expect(guidance).toEqual({
      source: "server-handle",
      runtimeInstruction:
        "The server handle is started but not yet verified. " +
        "Call `system.serverStatus` (or `system.serverResume`) and confirm readiness before claiming the server is running.",
      routedToolNames: ["system.serverStatus", "system.serverResume"],
      toolChoice: "required",
    });
  });

  it("routes typed calendar inspection turns to calendarInfo first", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Use the typed calendar tools to inspect this ics calendar invite, list the attendees, and read the scheduled meeting events.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "system.calendarInfo", "system.calendarRead"],
    });

    expect(guidance).toEqual({
      source: "typed-calendar",
      runtimeInstruction:
        "This typed calendar inspection is not complete yet. " +
        "Start with `system.calendarInfo` so the answer is grounded in real metadata before you summarize or quote details.",
      routedToolNames: ["system.calendarInfo"],
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          "This typed calendar inspection must begin with `system.calendarInfo`. " +
          "Do not use `desktop.bash`, `desktop.text_editor`, `system.bash`, or ad hoc file parsing before the typed inspection path starts.",
      },
    });
  });

  it("routes typed calendar inspection turns to calendarRead after metadata", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText:
        "Use the typed calendar tools to inspect this ics calendar invite, list the attendees, and read the scheduled meeting events.",
      toolCalls: [
        makeToolCall({
          name: "system.calendarInfo",
          result: JSON.stringify({ calendarName: "Team Calendar", eventCount: 2 }),
        }),
      ],
      allowedToolNames: ["system.calendarInfo", "system.calendarRead"],
    });

    expect(guidance).toEqual({
      source: "typed-calendar",
      runtimeInstruction:
        "Metadata alone is not enough for this typed calendar inspection. " +
        "Call `system.calendarRead` before answering so the response includes grounded structured content, not just a metadata summary.",
      routedToolNames: ["system.calendarRead"],
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          "This typed calendar inspection still requires `system.calendarRead`. " +
          "Do not stop early or switch to shell/editor fallbacks while the typed read/extract step is still missing.",
      },
    });
  });

  it("blocks shell detours before typed calendar inspection metadata is loaded", () => {
    const block = resolveToolContractExecutionBlock({
      phase: "initial",
      messageText:
        "Use the typed calendar tools to inspect this ics calendar invite, list the attendees, and read the scheduled meeting events.",
      toolCalls: [],
      allowedToolNames: ["desktop.bash", "system.calendarInfo", "system.calendarRead"],
      candidateToolName: "desktop.bash",
    });

    expect(block).toBe(
      "This typed calendar inspection must begin with `system.calendarInfo`. " +
      "Do not use `desktop.bash`, `desktop.text_editor`, `system.bash`, or ad hoc file parsing before the typed inspection path starts. " +
      "Allowed now: `system.calendarInfo`. " +
      "Do not use `desktop.bash` yet.",
    );
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
