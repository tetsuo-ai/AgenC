import { describe, it, expect } from "vitest";
import { Capability } from "../agent/capabilities.js";
import { WorkflowValidationError } from "./errors.js";
import {
  GoalCompiler,
  computeWorkflowPlanHash,
  type GoalPlanner,
  type PlannerWorkflowDraft,
} from "./compiler.js";
import {
  OnChainDependencyType,
  type WorkflowDefinition,
  type TaskTemplate,
} from "./types.js";

function staticPlanner(draft: PlannerWorkflowDraft): GoalPlanner {
  return {
    async plan() {
      return draft;
    },
  };
}

describe("GoalCompiler", () => {
  it("compiles planner output into a valid workflow definition and dry-run estimate", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        workflowId: "ignored-by-request",
        tasks: [
          {
            name: "fetch data",
            description: "Fetch docs and source data",
          },
          {
            name: "summarize",
            description: "Summarize the fetched results",
            dependsOn: "fetch data",
            dependencyType: "ordering",
          },
        ],
      }),
      now: () => 1_700_000_000_000,
    });

    const result = await compiler.compile({
      objective: "Fetch and summarize docs",
      workflowId: "workflow-abc",
    });

    expect(result.definition.id).toBe("workflow-abc");
    expect(result.definition.tasks).toHaveLength(2);
    expect(result.definition.edges).toEqual([
      {
        from: "fetch_data",
        to: "summarize",
        dependencyType: OnChainDependencyType.Ordering,
      },
    ]);
    expect(result.definition.tasks[0].description).toHaveLength(64);
    expect(result.definition.tasks[0].requiredCapabilities).toBe(
      Capability.COMPUTE,
    );
    expect(result.dryRun.taskCount).toBe(2);
    expect(result.dryRun.edgeCount).toBe(1);
    expect(result.dryRun.maxDependencyDepth).toBe(1);
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses required capabilities from symbolic names", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          {
            name: "model_inference",
            description: "Run inference",
            requiredCapabilities: ["compute", "inference"],
          },
        ],
      }),
    });

    const result = await compiler.compile({ objective: "Run inference task" });
    expect(result.definition.tasks[0].requiredCapabilities).toBe(
      Capability.COMPUTE | Capability.INFERENCE,
    );
  });

  it("rejects unknown capability names", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          {
            name: "bad_caps",
            description: "Task with invalid caps",
            requiredCapabilities: ["COMPUTE", "NON_EXISTENT_CAP"],
          },
        ],
      }),
    });

    await expect(
      compiler.compile({ objective: "Bad capability test" }),
    ).rejects.toThrow(WorkflowValidationError);
    await expect(
      compiler.compile({ objective: "Bad capability test" }),
    ).rejects.toThrow("unknown capability");
  });

  it("enforces budget limits from compile request", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          { name: "a", description: "Task A", rewardAmount: 100n },
          { name: "b", description: "Task B", rewardAmount: 75n },
        ],
      }),
    });

    await expect(
      compiler.compile({
        objective: "Over budget workflow",
        budgetLamports: 150,
      }),
    ).rejects.toThrow("exceeds budget");
  });

  it("treats budgetLamports=0 as an explicit budget constraint", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [{ name: "a", description: "Task A", rewardAmount: 1n }],
      }),
    });

    await expect(
      compiler.compile({
        objective: "Zero budget workflow",
        budgetLamports: 0,
      }),
    ).rejects.toThrow("exceeds budget");
  });

  it("rejects proof dependencies when explicitly disabled", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          { name: "root", description: "Root task" },
          {
            name: "child",
            description: "Proof-gated child",
            dependsOn: "root",
            dependencyType: "proof",
          },
        ],
      }),
    });

    await expect(
      compiler.compile({
        objective: "Disallow proof dependencies",
        allowProofDependencies: false,
      }),
    ).rejects.toThrow("Proof dependency is disabled");
  });

  it("parses constraint hash hex and counts private tasks in dry-run stats", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          {
            name: "private_task",
            description: "Private result task",
            constraintHashHex: "ab".repeat(32),
          },
        ],
      }),
    });

    const result = await compiler.compile({ objective: "Private task goal" });
    expect(result.definition.tasks[0].constraintHash).toBeDefined();
    expect(result.definition.tasks[0].constraintHash).toHaveLength(32);
    expect(result.dryRun.privateTaskCount).toBe(1);
  });

  it("normalizes confidence and emits warnings", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        confidence: 80,
        tasks: [{ name: "task", description: "Simple task" }],
      }),
    });

    const result = await compiler.compile({
      objective: "Confidence normalization",
    });
    expect(result.plannerConfidence).toBe(0.8);
    expect(
      result.warnings.some(
        (warning) => warning.code === "confidence_normalized",
      ),
    ).toBe(true);
  });

  it("generates and deduplicates task names when planner output is missing/duplicated", async () => {
    const compiler = new GoalCompiler({
      planner: staticPlanner({
        tasks: [
          { description: "Unnamed task" },
          {
            name: "task 1",
            description: "Duplicate of generated normalized name",
          },
        ],
      }),
    });

    const result = await compiler.compile({ objective: "Name normalization" });
    const names = result.definition.tasks.map((task) => task.name);
    expect(names).toEqual(["task_1", "task_1_2"]);
    expect(
      result.warnings.some((warning) => warning.code === "task_name_generated"),
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.code === "task_name_deduped"),
    ).toBe(true);
  });

  it("computes stable workflow plan hashes for equivalent definitions", () => {
    const template = (name: string): TaskTemplate => ({
      name,
      description: new Uint8Array(64),
      requiredCapabilities: Capability.COMPUTE,
      rewardAmount: 100n,
      maxWorkers: 1,
      deadline: 1000,
      taskType: 0,
      minReputation: 0,
    });

    const definitionA: WorkflowDefinition = {
      id: "plan-hash",
      tasks: [template("z_root"), template("m_child"), template("a_child")],
      edges: [
        {
          from: "z_root",
          to: "m_child",
          dependencyType: OnChainDependencyType.Ordering,
        },
        {
          from: "z_root",
          to: "a_child",
          dependencyType: OnChainDependencyType.Data,
        },
      ],
    };

    const definitionB: WorkflowDefinition = {
      id: "plan-hash",
      tasks: [template("a_child"), template("z_root"), template("m_child")],
      edges: [
        {
          from: "z_root",
          to: "a_child",
          dependencyType: OnChainDependencyType.Data,
        },
        {
          from: "z_root",
          to: "m_child",
          dependencyType: OnChainDependencyType.Ordering,
        },
      ],
    };

    const hashA = computeWorkflowPlanHash(definitionA);
    const hashB = computeWorkflowPlanHash(definitionB);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
  });
});
