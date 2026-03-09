import { describe, expect, it } from "vitest";

import { extractExplicitSubagentOrchestrationRequirements } from "./chat-executor-planner.js";

describe("chat-executor-planner explicit orchestration requirements", () => {
  it("extracts required subagent steps from the compact 'plan required' prompt shape", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Subagent context audit SG3. Sub-agent orchestration plan required: " +
        "1. recover_marker: recover the earlier continuity marker from parent conversation context only; do not invent missing facts. " +
        "2. echo_marker: using desktop.bash, run /usr/bin/printf so it prints the recovered marker exactly once. " +
        "Final deliverables: recovered marker, printed output, known limitations.",
    );

    expect(requirements).toBeDefined();
    expect(requirements?.stepNames).toEqual([
      "recover_marker",
      "echo_marker",
    ]);
    expect(requirements?.requiresSynthesis).toBe(true);
    expect(requirements?.steps[0]?.description).toContain(
      "recover the earlier continuity marker",
    );
  });
});
