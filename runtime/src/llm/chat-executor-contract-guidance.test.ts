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

  it("prefers get_situation_report for Doom async verification when multiple probes are allowed", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText:
        "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
      toolCalls: [
        makeToolCall({
          name: "mcp.doom.start_game",
          args: {
            scenario: "defend_the_center",
            async_player: true,
            god_mode: true,
          },
          result: JSON.stringify({ status: "running", god_mode_enabled: true }),
        }),
        makeToolCall({
          name: "mcp.doom.set_objective",
          args: { objective_type: "hold_position" },
          result: JSON.stringify({ status: "objective_set" }),
        }),
      ],
      allowedToolNames: [
        "mcp.doom.get_state",
        "mcp.doom.get_situation_report",
      ],
    });

    expect(guidance).toEqual({
      source: "doom",
      runtimeInstruction:
        "Continuous autonomous play is still unverified. Call `mcp.doom.get_situation_report` or `mcp.doom.get_state` " +
        "and confirm the live executor state before answering.",
      routedToolNames: ["mcp.doom.get_situation_report"],
      toolChoice: "required",
    });
  });

  it("routes generic Doom autoplay turns to set_objective before verification", () => {
    const guidance = resolveToolContractGuidance({
      phase: "tool_followup",
      messageText: "Play Doom until I tell you to stop.",
      toolCalls: [
        makeToolCall({
          name: "mcp.doom.start_game",
          args: { async_player: true },
          result: JSON.stringify({ status: "running", scenario: "basic" }),
        }),
      ],
      allowedToolNames: [
        "mcp.doom.set_objective",
        "mcp.doom.get_situation_report",
      ],
    });

    expect(guidance).toEqual({
      source: "doom",
      runtimeInstruction:
        "Autonomous Doom play is active, but no gameplay objective is steering the executor yet. " +
        "Call `mcp.doom.set_objective` with `objective_type: \"explore\"` unless the user explicitly requested a different goal.",
      routedToolNames: ["mcp.doom.set_objective"],
      toolChoice: "required",
    });
  });

  it("forces explicitly requested social tools on the initial turn", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents, requiredCapabilities 3, maxMembers 3, then reply exactly R3_DONE_A2.",
      toolCalls: [],
      allowedToolNames: ["social.requestCollaboration", "social.sendMessage"],
    });

    expect(guidance).toEqual({
      source: "explicit-tool-invocation",
      runtimeInstruction:
        "The user explicitly instructed this turn to call `social.requestCollaboration`. " +
        "Execute that tool before answering.",
      routedToolNames: ["social.requestCollaboration"],
      toolChoice: "required",
    });
  });

  it("does not force tools for non-imperative tool mentions", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Explain what social.requestCollaboration does and when to use it.",
      toolCalls: [],
      allowedToolNames: ["social.requestCollaboration"],
    });

    expect(guidance).toBeUndefined();
  });

  it("prefers explicit social inbox tools over typed email guidance", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Use social.getRecentMessages with direction incoming and limit 3. Read the newest message from agent 1, then use social.sendMessage to reply.",
      toolCalls: [],
      allowedToolNames: [
        "system.emailMessageInfo",
        "system.emailMessageExtractText",
        "social.getRecentMessages",
        "social.sendMessage",
      ],
    });

    expect(guidance).toEqual({
      source: "explicit-tool-invocation",
      runtimeInstruction:
        "The user explicitly instructed this turn to call `social.getRecentMessages`, `social.sendMessage`. " +
        "Execute those tools before answering.",
      routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
      toolChoice: "required",
    });
  });

  it("keeps explicit social inbox turns on social tools even when inbox wording appears", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Use social.getRecentMessages with direction incoming and limit 3. Read the newest inbox message from agent 1, then use social.sendMessage to reply.",
      toolCalls: [],
      allowedToolNames: [
        "system.emailMessageInfo",
        "system.emailMessageExtractText",
        "social.getRecentMessages",
        "social.sendMessage",
      ],
    });

    expect(guidance).toEqual({
      source: "explicit-tool-invocation",
      runtimeInstruction:
        "The user explicitly instructed this turn to call `social.getRecentMessages`, `social.sendMessage`. " +
        "Execute those tools before answering.",
      routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
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
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("keeps inspection, mutation, and verification tools available for local implementation phases", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText: "Implement the requested files.",
      toolCalls: [],
      allowedToolNames: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      requiredToolEvidence: {
        delegationSpec: {
          task: "implement_core",
          objective: "Implement packages/core/src/index.ts and keep the workspace buildable",
          inputContract: "Existing TypeScript workspace already scaffolded",
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      runtimeInstruction:
        "Start with the smallest grounded step that reduces uncertainty in the delegated contract. " +
        "Inspect the existing workspace state before mutating files when that will prevent avoidable rework, " +
        "and use shell verification when build/test/install evidence is part of acceptance.",
      routedToolNames: ["system.readFile", "system.writeFile", "system.bash"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("tells delegated bootstrap phases to create a missing workspace root before inspecting it", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText: "Scaffold the workspace root from scratch.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "setup_structure",
          objective:
            "Create /tmp/maze-forge-ts-boot with root package.json and package stubs",
          inputContract: "Empty host dir",
          contextRequirements: ["cwd=/tmp/maze-forge-ts-boot"],
          acceptanceCriteria: [
            "Root package.json with workspaces",
            "Package stubs exist",
          ],
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      runtimeInstruction:
        "Bootstrap the delegated workspace before inspecting it. " +
        "If the delegated cwd does not exist yet, create it first or inspect its parent instead of issuing a cwd-relative inspection that is expected to fail. " +
        "After the workspace root exists, create or update the required files directly and use shell verification only after meaningful mutations.",
      routedToolNames: ["system.writeFile", "system.bash"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("tells root-creation planner phases to bootstrap the delegated cwd before cwd-relative inspection", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText: "Create the workspace root from scratch.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile", "system.listDir"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "setup_structure",
          objective:
            "Create root dir /tmp/maze-forge-ts-boot package.json with workspaces using file:../pkg instead of workspace:*, tsconfig.json, and skeleton package.json + tsconfig for packages/core,cli,web. Add root scripts: build,test,dev.",
          inputContract: "none",
          acceptanceCriteria: [
            "Root dir exists",
            "package.json valid with file: deps",
            "package dirs created",
            "npm install runs without error",
          ],
          contextRequirements: ["cwd=/tmp/maze-forge-ts-boot"],
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      runtimeInstruction:
        "Bootstrap the delegated workspace before inspecting it. " +
        "If the delegated cwd does not exist yet, create it first or inspect its parent instead of issuing a cwd-relative inspection that is expected to fail. " +
        "After the workspace root exists, create or update the required files directly and use shell verification only after meaningful mutations.",
      routedToolNames: ["system.listDir", "system.writeFile", "system.bash"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("does not leak bootstrap guidance into downstream implementation phases just because the parent request was from scratch", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText: "Implement the core pathfinding package.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile", "system.readFile"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "implement_core",
          objective:
            "Implement grid parser (S/E/start, #/obstacles, 1-9 weights) and A* pathfinder in packages/core; add types, findPath fn returning path/cost/steps.",
          inputContract: "Monorepo structure and deps ready",
          parentRequest:
            "Create /tmp/maze-forge-ts-boot from scratch. Build a TypeScript npm-workspaces monorepo with packages core, cli, and web.",
          acceptanceCriteria: [
            "Grid parse and A* work with weights/obstacles",
            "Core builds and has basic tests",
          ],
          contextRequirements: ["cwd=/tmp/maze-forge-ts-boot"],
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      runtimeInstruction:
        "Start with the smallest grounded step that reduces uncertainty in the delegated contract. " +
        "Inspect the existing workspace state before mutating files when that will prevent avoidable rework, " +
        "and use shell verification when build/test/install evidence is part of acceptance.",
      routedToolNames: ["system.readFile", "system.writeFile", "system.bash"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("routes read-only delegated local docs review to desktop.text_editor instead of browser navigation", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools.",
      toolCalls: [],
      allowedToolNames: [
        "desktop.text_editor",
        "desktop.bash",
        "mcp.browser.browser_navigate",
      ],
      requiredToolEvidence: {
        delegationSpec: {
          task:
            "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
          objective:
            "Identify and output exactly one short bullet describing one autonomy risk from the sections",
          inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
          acceptanceCriteria: [
            "Exactly one short bullet output",
            "No browser tools used",
            "Risk tied to delegation or compaction",
          ],
          tools: ["desktop.text_editor", "desktop.bash"],
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      routedToolNames: ["desktop.text_editor"],
      persistRoutedToolNames: false,
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
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("keeps mutation and verification tools available for acceptance-evidence corrections on implementation phases", () => {
    const guidance = resolveToolContractGuidance({
      phase: "correction",
      messageText: "Verify the CLI acceptance criteria with tool-grounded evidence.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "implement_cli",
          objective:
            "Build CLI in src/cli.ts that accepts stdin/file, runs chosen algo, prints length/cost/visited/overlay",
          inputContract: "Use process.argv, import core",
          acceptanceCriteria: ["Compiles to dist/cli.js, correct output format"],
        },
      },
      validationCode: "acceptance_evidence_missing",
    });

    expect(guidance).toEqual({
      source: "delegation-correction",
      routedToolNames: ["system.bash", "system.writeFile"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("keeps mutation and verification tools available for contradictory implementation corrections", () => {
    const guidance = resolveToolContractGuidance({
      phase: "correction",
      messageText: "Fix the CLI and verify the acceptance criteria with tool-grounded evidence.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "implement_cli",
          objective:
            "Build CLI in src/cli.ts that accepts stdin/file, runs chosen algo, prints length/cost/visited/overlay",
          inputContract: "Use process.argv, import core",
          acceptanceCriteria: ["Compiles to dist/cli.js, correct output format"],
        },
      },
      validationCode: "contradictory_completion_claim",
    });

    expect(guidance).toEqual({
      source: "delegation-correction",
      routedToolNames: ["system.writeFile", "system.bash"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });

  it("routes retried verification-heavy delegated work to shell first on the initial turn", () => {
    const guidance = resolveToolContractGuidance({
      phase: "initial",
      messageText:
        "Retry the phase and directly verify the missing test/build evidence before answering.",
      toolCalls: [],
      allowedToolNames: ["system.bash", "system.writeFile"],
      requiredToolEvidence: {
        delegationSpec: {
          task: "add_tests_demos",
          objective:
            "Add demo maps and comprehensive Vitest tests covering parser, portals, conveyors, unreachable maps, and CLI behavior.",
          acceptanceCriteria: [
            "Demo maps present",
            "All tests pass with Vitest",
            "Coverage for required cases",
          ],
          lastValidationCode: "acceptance_evidence_missing",
        },
      },
    });

    expect(guidance).toEqual({
      source: "delegation-initial",
      runtimeInstruction:
        "Start with the smallest grounded step that reduces uncertainty in the delegated contract. " +
        "Inspect the existing workspace state before mutating files when that will prevent avoidable rework, " +
        "and use shell verification when build/test/install evidence is part of acceptance.",
      routedToolNames: ["system.bash", "system.writeFile"],
      persistRoutedToolNames: false,
      toolChoice: "required",
    });
  });
});
