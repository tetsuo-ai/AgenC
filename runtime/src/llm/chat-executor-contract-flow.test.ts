import { describe, expect, it } from "vitest";
import {
  buildRequiredToolEvidenceRetryInstruction,
  canRetryDelegatedOutputWithoutAdditionalToolCalls,
  resolveCorrectionAllowedToolNames,
  resolveExecutionToolContractGuidance,
} from "./chat-executor-contract-flow.js";

describe("chat-executor-contract-flow", () => {
  it("resolves contract guidance against the broader allowed tool universe", () => {
    const guidance = resolveExecutionToolContractGuidance({
      ctx: {
        messageText:
          "Start a durable HTTP server on port 3000 and keep it running until I tell you to stop.",
        allToolCalls: [],
        activeRoutedToolNames: ["system.serverStatus"],
        initialRoutedToolNames: ["desktop.bash"],
        expandedRoutedToolNames: [
          "system.serverStatus",
        ],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
      },
      allowedTools: [
        "desktop.bash",
        "system.serverStart",
        "system.serverStatus",
      ],
    });

    expect(guidance?.routedToolNames).toEqual(["system.serverStart"]);
    expect(guidance?.toolChoice).toBe("required");
  });

  it("prefers the full allowed tool collection for correction retries", () => {
    expect(
      resolveCorrectionAllowedToolNames(
        ["mcp.doom.get_situation_report"],
        ["mcp.doom.start_game", "mcp.doom.set_objective"],
      ),
    ).toEqual([
      "mcp.doom.start_game",
      "mcp.doom.set_objective",
    ]);
  });

  it("adds validation-specific retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage: "Expected browser-grounded evidence",
        validationCode: "low_signal_browser_evidence",
        allowedToolNames: ["browser.navigate", "browser.snapshot"],
      }),
    ).toContain("about:blank state checks do not count");
  });

  it("adapts browser retry guidance for localhost checks on host-only tools", () => {
    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage: "Expected browser-grounded evidence",
      validationCode: "low_signal_browser_evidence",
      allowedToolNames: ["system.bash", "system.browserSessionStart"],
    });

    expect(instruction).toContain("do not use `system.browse` or `system.browserSession*`");
    expect(instruction).toContain("host-side browser verification command");
    expect(instruction).toContain("system.bash");
  });

  it("adds contradictory-completion retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage:
          "Delegated task output claimed completion while still reporting unresolved work",
        validationCode: "contradictory_completion_claim",
        allowedToolNames: ["system.bash", "system.writeFile"],
      }),
    ).toContain("Do not claim the phase is complete");
  });

  it("tells contradictory-completion retries to re-emit a completion-only answer after a fix", () => {
    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage:
        "Delegated task output claimed completion while still reporting unresolved work",
      validationCode: "contradictory_completion_claim",
      allowedToolNames: ["system.readFile", "system.writeFile"],
    });

    expect(instruction).toContain(
      "If the latest allowed-tool evidence fixes the issue, re-emit a completion-only answer grounded in that evidence.",
    );
    expect(instruction).toContain(
      "Report the phase as blocked only when the blocking issue still remains",
    );
  });

  it("adds forbidden-phase retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage:
          "Delegated phase contract forbids dependency-install commands in this phase",
        validationCode: "forbidden_phase_action",
        allowedToolNames: ["system.listDir", "system.writeFile"],
      }),
    ).toContain("leave verification for the later step");
  });

  it("allows toolless structured-output retries when evidence already exists", () => {
    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "expected_json_object",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "README.md" },
            result: JSON.stringify({ path: "/tmp/README.md", bytesWritten: 42 }),
            isError: false,
            durationMs: 3,
          },
        ],
        delegationSpec: {
          task: "write_docs",
          objective: "Write the README in workspace files",
          acceptanceCriteria: ["README.md written"],
        },
      }),
    ).toBe(true);

    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage: "Malformed result contract: expected JSON object output",
      validationCode: "expected_json_object",
      allowedToolNames: [],
      requiresAdditionalToolCalls: false,
    });

    expect(instruction).toContain(
      "The required tool-grounded evidence is already present in this turn.",
    );
    expect(instruction).toContain("Do not call additional tools for this retry.");
    expect(instruction).not.toContain("Before answering, call one or more allowed tools");
  });

  it("allows toolless delegated retries when only the final blocked/completion prose is wrong", () => {
    const toolCalls = [
      {
        name: "system.writeFile",
        args: { path: "/workspace/space-colony/src/simulation.ts" },
        result: JSON.stringify({
          path: "/workspace/space-colony/src/simulation.ts",
          bytesWritten: 4082,
        }),
        isError: false,
        durationMs: 3,
      },
      {
        name: "system.readFile",
        args: { path: "/workspace/space-colony/src/simulation.ts" },
        result: JSON.stringify({
          content: "export function generateAsteroidSurface() { return []; }\n",
        }),
        isError: false,
        durationMs: 2,
      },
    ] as const;

    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "blocked_phase_output",
        toolCalls,
        delegationSpec: {
          task: "implement_core_drones",
          objective: "Implement the colony simulation and drone core",
          acceptanceCriteria: [
            "Core modules are written in src/",
            "Deterministic serialization implemented",
          ],
        },
      }),
    ).toBe(true);

    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "contradictory_completion_claim",
        toolCalls,
        delegationSpec: {
          task: "implement_core_drones",
          objective: "Implement the colony simulation and drone core",
          acceptanceCriteria: [
            "Core modules are written in src/",
            "Deterministic serialization implemented",
          ],
        },
      }),
    ).toBe(false);
  });
});
