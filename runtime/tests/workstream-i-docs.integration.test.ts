import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function readRepoFile(relativePath: string): Promise<string> {
  const absolutePath = path.join(repoRoot(), relativePath);
  return await readFile(absolutePath, "utf8");
}

describe("workstream I docs integration", () => {
  it("runtime chat pipeline doc reflects delegation orchestration and policy-learning flow", async () => {
    const content = await readRepoFile(
      "docs/architecture/flows/runtime-chat-pipeline.md",
    );

    expect(content).toContain("SubAgentOrchestrator");
    expect(content).toContain("delegation-learning.ts");
    expect(content).toContain("plannerSummary.delegationPolicyTuning");
    expect(content).toContain("benchmark:delegation:ci");
    expect(content).toContain("benchmark:decomposition-search");
    expect(content).toContain("subagents.planned");
  });

  it("incident replay runbook includes delegation and decomposition incident templates", async () => {
    const content = await readRepoFile("docs/INCIDENT_REPLAY_RUNBOOK.md");

    expect(content).toContain("Delegation orchestration regression template");
    expect(content).toContain("benchmark:delegation:gates");
    expect(content).toContain("benchmark:decomposition-search");
    expect(content).toContain("plannerSummary.delegationPolicyTuning");
  });

  it("runtime api includes subagent policy learning profile and benchmark scripts", async () => {
    const content = await readRepoFile("docs/RUNTIME_API.md");

    expect(content).toContain("Profile 4: Delegation SOTA");
    expect(content).toContain("llm.subagents.policyLearning");
    expect(content).toContain("delegationPolicyTuning");
    expect(content).toContain("benchmark:delegation");
    expect(content).toContain("benchmark:decomposition-search");
  });

  it("subagent orchestration flow doc exists with required sections", async () => {
    const content = await readRepoFile(
      "docs/architecture/flows/subagent-orchestration.md",
    );

    expect(content).toContain("# Subagent Orchestration Flow");
    expect(content).toContain("## Message Flow");
    expect(content).toContain("## Policy Gates");
    expect(content).toContain("## Failure Matrix");
    expect(content).toContain("## Kill-Switch Behavior");
    expect(content).toContain("## Observability Map");
  });

  it("architecture index references the new subagent orchestration flow", async () => {
    const content = await readRepoFile("docs/architecture/README.md");

    expect(content).toContain("flows/subagent-orchestration.md");
  });
});
