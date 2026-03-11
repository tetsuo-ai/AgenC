import { describe, expect, it } from "vitest";
import {
  buildRequiredToolEvidenceRetryInstruction,
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
});
