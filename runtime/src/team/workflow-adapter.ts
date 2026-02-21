/**
 * Adapter for deriving role-aware workflow DAGs from team contracts.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import { OnChainDependencyType, validateWorkflow } from "../workflow/index.js";
import type {
  WorkflowDefinition,
  TaskTemplate,
  WorkflowEdge,
} from "../workflow/index.js";
import { TeamContractStateError, TeamWorkflowTopologyError } from "./errors.js";
import type { TeamContractSnapshot, TeamCheckpointState } from "./types.js";
import { validateTeamTemplate } from "./validation.js";

export interface TeamWorkflowBuildOptions {
  workflowId?: string;
  defaultRewardMint?: PublicKey | null;
  dependencyType?: OnChainDependencyType;
  maxWorkersPerTask?: number;
  deadline?: number;
  taskType?: number;
  totalRewardLamports?: bigint;
}

export interface TeamWorkflowBuildResult {
  definition: WorkflowDefinition;
  checkpointTaskName: Record<string, string>;
  taskRole: Record<string, string>;
}

export interface TeamWorkflowLaunchResult<T> extends TeamWorkflowBuildResult {
  launchResult: T;
}

export class TeamWorkflowAdapter {
  build(
    contract: TeamContractSnapshot,
    options: TeamWorkflowBuildOptions = {},
  ): TeamWorkflowBuildResult {
    if (contract.status === "draft") {
      throw new TeamContractStateError(
        "cannot build workflow from a draft contract; start the run first",
      );
    }

    try {
      validateTeamTemplate(contract.template, { requireSingleParent: true });
    } catch (error) {
      throw new TeamWorkflowTopologyError(toError(error).message);
    }

    const checkpoints = Object.values(contract.checkpoints).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const roleById = new Map(
      contract.template.roles.map((role) => [role.id, role]),
    );
    const rewards = distributeCheckpointRewards(
      checkpoints,
      options.totalRewardLamports ?? 0n,
    );

    const maxWorkersPerTask = options.maxWorkersPerTask ?? 1;
    const deadline = options.deadline ?? 0;
    const taskType = options.taskType ?? 0;

    const tasks: TaskTemplate[] = checkpoints.map((checkpoint) => {
      const role = roleById.get(checkpoint.roleId);
      if (!role) {
        throw new TeamWorkflowTopologyError(
          `checkpoint "${checkpoint.id}" references unknown role "${checkpoint.roleId}"`,
        );
      }

      return {
        name: checkpoint.id,
        requiredCapabilities: role.requiredCapabilities,
        description: encodeDescription(checkpoint.label),
        rewardAmount: rewards.get(checkpoint.id) ?? 0n,
        maxWorkers: maxWorkersPerTask,
        deadline,
        taskType,
      };
    });

    const dependencyType =
      options.dependencyType ?? OnChainDependencyType.Ordering;
    const edges: WorkflowEdge[] = [];

    for (const checkpoint of checkpoints) {
      const dependency = checkpoint.dependsOn[0];
      if (!dependency) continue;

      edges.push({
        from: dependency,
        to: checkpoint.id,
        dependencyType,
      });
    }

    edges.sort((a, b) => {
      const fromCmp = a.from.localeCompare(b.from);
      if (fromCmp !== 0) return fromCmp;
      return a.to.localeCompare(b.to);
    });

    const definition: WorkflowDefinition = {
      id: options.workflowId ?? `team-${contract.id}-workflow`,
      defaultRewardMint: options.defaultRewardMint,
      tasks,
      edges,
    };

    try {
      validateWorkflow(definition);
    } catch (error) {
      throw new TeamWorkflowTopologyError(toError(error).message);
    }

    const checkpointTaskName: Record<string, string> = {};
    const taskRole: Record<string, string> = {};

    for (const checkpoint of checkpoints) {
      checkpointTaskName[checkpoint.id] = checkpoint.id;
      taskRole[checkpoint.id] = checkpoint.roleId;
    }

    return {
      definition,
      checkpointTaskName,
      taskRole,
    };
  }

  async launch<T>(
    contract: TeamContractSnapshot,
    submit: (definition: WorkflowDefinition) => Promise<T>,
    options: TeamWorkflowBuildOptions = {},
  ): Promise<TeamWorkflowLaunchResult<T>> {
    const buildResult = this.build(contract, options);
    const launchResult = await submit(buildResult.definition);

    return {
      ...buildResult,
      launchResult,
    };
  }
}

function distributeCheckpointRewards(
  checkpoints: TeamCheckpointState[],
  totalRewardLamports: bigint,
): Map<string, bigint> {
  const rewards = new Map<string, bigint>();

  if (totalRewardLamports <= 0n || checkpoints.length === 0) {
    for (const checkpoint of checkpoints) {
      rewards.set(checkpoint.id, 0n);
    }
    return rewards;
  }

  const count = BigInt(checkpoints.length);
  const base = totalRewardLamports / count;
  let remainder = totalRewardLamports % count;

  for (const checkpoint of checkpoints) {
    const plus = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    rewards.set(checkpoint.id, base + plus);
  }

  return rewards;
}

function encodeDescription(label: string): Uint8Array {
  const text = label.trim();
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(64);
  out.set(encoded.slice(0, 64));
  return out;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
