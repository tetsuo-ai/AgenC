import { describe, expect, it } from "vitest";
import {
  generateWorkflowMutationCandidates,
  type WorkflowMutationCandidate,
} from "./mutations.js";
import {
  OnChainDependencyType,
  type TaskTemplate,
  type WorkflowDefinition,
} from "./types.js";
import { validateWorkflow } from "./validation.js";

function makeTask(
  name: string,
  overrides: Partial<TaskTemplate> = {},
): TaskTemplate {
  return {
    name,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    rewardAmount: 100n,
    maxWorkers: 1,
    deadline: 10_000,
    taskType: 0,
    ...overrides,
  };
}

function makeWorkflow(): WorkflowDefinition {
  return {
    id: "wf-mutations",
    tasks: [
      makeTask("root", { rewardAmount: 100n }),
      makeTask("child-a", { rewardAmount: 150n, taskType: 1 }),
      makeTask("child-b", { rewardAmount: 200n, taskType: 2 }),
    ],
    edges: [
      {
        from: "root",
        to: "child-a",
        dependencyType: OnChainDependencyType.Data,
      },
      {
        from: "root",
        to: "child-b",
        dependencyType: OnChainDependencyType.Ordering,
      },
    ],
  };
}

function candidateSignature(candidate: WorkflowMutationCandidate): string {
  const tasks = [...candidate.definition.tasks]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (task) =>
        `${task.name}:${task.taskType}:${task.rewardAmount}:${task.deadline}`,
    )
    .join("|");

  const edges = [...candidate.definition.edges]
    .sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`))
    .map((edge) => `${edge.from}->${edge.to}:${edge.dependencyType}`)
    .join("|");

  return `${tasks}#${edges}`;
}

describe("generateWorkflowMutationCandidates", () => {
  it("produces deterministic candidates for a fixed seed", () => {
    const baseline = makeWorkflow();

    const first = generateWorkflowMutationCandidates(baseline, {
      seed: 42,
      maxCandidates: 6,
    });
    const second = generateWorkflowMutationCandidates(baseline, {
      seed: 42,
      maxCandidates: 6,
    });

    expect(first.map((candidate) => candidate.id)).toEqual(
      second.map((candidate) => candidate.id),
    );
    expect(first.map(candidateSignature)).toEqual(
      second.map(candidateSignature),
    );
  });

  it("ensures all generated variants pass workflow validation", () => {
    const baseline = makeWorkflow();
    const candidates = generateWorkflowMutationCandidates(baseline, {
      seed: 9,
      maxCandidates: 10,
    });

    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      expect(() => validateWorkflow(candidate.definition)).not.toThrow();
    }
  });

  it("covers the expected mutation operator families and enforces max candidate limit", () => {
    const baseline = makeWorkflow();
    const candidates = generateWorkflowMutationCandidates(baseline, {
      seed: 7,
      maxCandidates: 5,
    });

    expect(candidates.length).toBeLessThanOrEqual(5);

    const operators = new Set(
      candidates.flatMap((candidate) =>
        candidate.mutations.map((mutation) => mutation.operator),
      ),
    );

    expect(operators.has("edge_rewire")).toBe(true);
    expect(operators.has("task_type")).toBe(true);
    expect(operators.has("reward_policy")).toBe(true);
    expect(operators.has("deadline_policy")).toBe(true);
  });
});
