import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  inferDoomTurnContract,
  summarizeDoomToolEvidence,
  getMissingDoomEvidenceGap,
} from "./chat-executor-doom.js";

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

describe("chat-executor-doom", () => {
  it("infers autoplay, hold-position, and god-mode requirements from Doom prompts", () => {
    const contract = inferDoomTurnContract(
      "Play Doom defend_the_center with god mode on, keep it running until I tell you to stop, and don't run around like a crazy person.",
    );

    expect(contract).toEqual({
      requiresLaunch: true,
      requiresAutonomousPlay: true,
      requiresHoldPosition: true,
      requiresGodMode: true,
    });
  });

  it("summarizes successful Doom tool evidence without trusting launch args alone for god mode", () => {
    const evidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: {
          scenario: "defend_the_center",
          async_player: true,
          god_mode: true,
        },
        result: JSON.stringify({ status: "running" }),
      }),
      makeToolCall({
        name: "mcp.doom.set_objective",
        args: { objective_type: "hold_position" },
      }),
      makeToolCall({
        name: "mcp.doom.get_situation_report",
        result: JSON.stringify({ executor_state: "fighting" }),
      }),
    ]);

    expect(evidence.confirmedLaunch).toBe(true);
    expect(evidence.confirmedAsyncStart).toBe(true);
    expect(evidence.verifiedAsyncState).toBe(true);
    expect(evidence.confirmedHoldPosition).toBe(true);
    expect(evidence.confirmedActiveObjective).toBe(false);
    expect(evidence.confirmedGodMode).toBe(false);
  });

  it("requires an active gameplay objective for generic autoplay turns", () => {
    const contract = inferDoomTurnContract(
      "Play Doom until I tell you to stop and keep it going on its own.",
    );
    expect(contract).toBeDefined();
    expect(contract?.requiresAutonomousPlay).toBe(true);
    expect(contract?.requiresHoldPosition).toBe(false);

    const launchOnlyEvidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: { async_player: true },
        result: JSON.stringify({ status: "running" }),
      }),
    ]);
    expect(getMissingDoomEvidenceGap(contract!, launchOnlyEvidence)?.code).toBe(
      "missing_active_objective",
    );

    const objectiveEvidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: { async_player: true },
        result: JSON.stringify({ status: "running" }),
      }),
      makeToolCall({
        name: "mcp.doom.set_objective",
        args: { objective_type: "explore" },
        result: JSON.stringify({
          status: "objective_set",
          objective: { type: "explore" },
        }),
      }),
    ]);
    expect(objectiveEvidence.confirmedActiveObjective).toBe(true);
    expect(getMissingDoomEvidenceGap(contract!, objectiveEvidence)?.code).toBe(
      "missing_async_verification",
    );
  });

  it("reads Doom intent from the background objective section only", () => {
    const contract = inferDoomTurnContract(
      "Background objective:\n" +
        "Supervise the existing ViZDoom session. Verify state and restore forward momentum if it goes idle.\n\n" +
        "Cycle: 2\n" +
        "Latest tool evidence:\n" +
        '- mcp.doom.set_objective [ok] {"status":"objective_set","objective":{"type":"hold_position"}}\n',
    );

    expect(contract).toBeUndefined();
  });

  it("ignores negated Doom tool exclusions in non-Doom coding prompts", () => {
    const contract = inferDoomTurnContract(
      "Build a complete self-contained TypeScript SAT solver toolkit in /tmp/codegen-bench-satsolver. " +
        "Use only system.listDir, system.readFile, system.writeFile, system.bash, and execute_with_agent. " +
        "Do not use any desktop.*, browser, sandbox, Docker, or Doom tools.",
    );

    expect(contract).toBeUndefined();
  });

  it("ignores negated Doom clauses when punctuation and later artifact text contain generic start wording", () => {
    const contract = inferDoomTurnContract(
      "Parent request summary: Build a complete self-contained TypeScript SAT solver toolkit. " +
        "Use only system.listDir, system.readFile, system.writeFile, system.bash, and execute_with_agent. " +
        "Do not use any desktop.*, browser, sandbox, Docker, or Doom tools.\n\n" +
        "Dependency-derived workspace context:\n" +
        "- Use these file snapshots as the starting point for this phase.\n" +
        "- [artifact:http_api:src/server.ts] Start server if this module is executed directly.",
    );

    expect(contract).toBeUndefined();
  });

  it("requires set_god_mode before hold-position and verification when god mode is requested", () => {
    const contract = inferDoomTurnContract(
      "Play Doom defend_the_center with god mode on until I say stop.",
    );
    expect(contract).toBeDefined();

    const launchOnlyEvidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: { async_player: true, god_mode: true },
        result: JSON.stringify({ status: "running" }),
      }),
    ]);
    const launchGap = getMissingDoomEvidenceGap(contract!, launchOnlyEvidence);
    expect(launchGap?.code).toBe("missing_god_mode");
    expect(launchGap?.preferredToolNames[0]).toBe("mcp.doom.set_god_mode");

    const godModeEvidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: { async_player: true, god_mode: true },
        result: JSON.stringify({ status: "running" }),
      }),
      makeToolCall({
        name: "mcp.doom.set_god_mode",
        args: { enabled: true },
        result: JSON.stringify({
          status: "god_mode_updated",
          god_mode_enabled: true,
        }),
      }),
    ]);
    const godModeGap = getMissingDoomEvidenceGap(contract!, godModeEvidence);
    expect(godModeGap?.code).toBe("missing_hold_position");

    const holdPositionEvidence = summarizeDoomToolEvidence([
      makeToolCall({
        name: "mcp.doom.start_game",
        args: { async_player: true, god_mode: true },
        result: JSON.stringify({ status: "running" }),
      }),
      makeToolCall({
        name: "mcp.doom.set_god_mode",
        args: { enabled: true },
        result: JSON.stringify({
          status: "god_mode_updated",
          god_mode_enabled: true,
        }),
      }),
      makeToolCall({
        name: "mcp.doom.set_objective",
        args: { objective_type: "hold_position" },
      }),
    ]);
    const holdPositionGap = getMissingDoomEvidenceGap(
      contract!,
      holdPositionEvidence,
    );
    expect(holdPositionGap?.code).toBe("missing_async_verification");
  });
});
