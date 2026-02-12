/**
 * Safe workflow mutation operators used by the optimizer.
 *
 * @module
 */

import type { TaskTemplate, WorkflowDefinition, WorkflowEdge } from './types.js';
import { OnChainDependencyType } from './types.js';
import { validateWorkflow } from './validation.js';

export type WorkflowMutationOperator =
  | 'edge_rewire'
  | 'task_type'
  | 'reward_policy'
  | 'deadline_policy';

export interface WorkflowMutationRecord {
  operator: WorkflowMutationOperator;
  description: string;
  metadata: Record<string, string | number | boolean>;
}

export interface WorkflowMutationCandidate {
  id: string;
  definition: WorkflowDefinition;
  mutations: WorkflowMutationRecord[];
}

export interface WorkflowMutationConfig {
  seed?: number;
  maxCandidates?: number;
  includeEdgeRewire?: boolean;
  includeTaskTypeMutations?: boolean;
  includeRewardMutations?: boolean;
  includeDeadlineMutations?: boolean;
  allowedTaskTypes?: number[];
  rewardScaleBps?: number[];
  deadlineOffsetSeconds?: number[];
}

interface ResolvedMutationConfig {
  seed: number;
  maxCandidates: number;
  includeEdgeRewire: boolean;
  includeTaskTypeMutations: boolean;
  includeRewardMutations: boolean;
  includeDeadlineMutations: boolean;
  allowedTaskTypes: number[];
  rewardScaleBps: number[];
  deadlineOffsetSeconds: number[];
}

const DEFAULT_MUTATION_CONFIG: ResolvedMutationConfig = {
  seed: 17,
  maxCandidates: 8,
  includeEdgeRewire: true,
  includeTaskTypeMutations: true,
  includeRewardMutations: true,
  includeDeadlineMutations: true,
  allowedTaskTypes: [0, 1, 2],
  rewardScaleBps: [80, 90, 110, 125],
  deadlineOffsetSeconds: [-3_600, -900, 900, 3_600],
};

interface MutationAttemptResult {
  definition: WorkflowDefinition;
  mutation: WorkflowMutationRecord;
}

function resolveConfig(config: WorkflowMutationConfig): ResolvedMutationConfig {
  const resolved: ResolvedMutationConfig = {
    ...DEFAULT_MUTATION_CONFIG,
    ...config,
    allowedTaskTypes:
      config.allowedTaskTypes && config.allowedTaskTypes.length > 0
        ? [...new Set(config.allowedTaskTypes)]
        : DEFAULT_MUTATION_CONFIG.allowedTaskTypes,
    rewardScaleBps:
      config.rewardScaleBps && config.rewardScaleBps.length > 0
        ? [...new Set(config.rewardScaleBps)]
        : DEFAULT_MUTATION_CONFIG.rewardScaleBps,
    deadlineOffsetSeconds:
      config.deadlineOffsetSeconds && config.deadlineOffsetSeconds.length > 0
        ? [...new Set(config.deadlineOffsetSeconds)]
        : DEFAULT_MUTATION_CONFIG.deadlineOffsetSeconds,
  };

  resolved.allowedTaskTypes.sort((a, b) => a - b);
  resolved.rewardScaleBps.sort((a, b) => a - b);
  resolved.deadlineOffsetSeconds.sort((a, b) => a - b);

  return resolved;
}

function createSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function chooseIndex(rng: () => number, size: number): number {
  if (size <= 1) return 0;
  return Math.floor(rng() * size);
}

function cloneTask(task: TaskTemplate): TaskTemplate {
  return {
    ...task,
    description: new Uint8Array(task.description),
    constraintHash: task.constraintHash ? new Uint8Array(task.constraintHash) : undefined,
  };
}

function cloneEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    from: edge.from,
    to: edge.to,
    dependencyType: edge.dependencyType,
  };
}

function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    tasks: definition.tasks.map(cloneTask),
    edges: definition.edges.map(cloneEdge),
  };
}

function stableSortEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  return [...edges].sort((a, b) => {
    const fromCmp = a.from.localeCompare(b.from);
    if (fromCmp !== 0) return fromCmp;
    const toCmp = a.to.localeCompare(b.to);
    if (toCmp !== 0) return toCmp;
    return a.dependencyType - b.dependencyType;
  });
}

function signature(definition: WorkflowDefinition): string {
  const taskPart = [...definition.tasks]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((task) => [
      task.name,
      task.taskType,
      task.rewardAmount.toString(),
      task.deadline,
      task.maxWorkers,
      task.minReputation ?? 0,
      task.constraintHash ? 1 : 0,
    ]);

  const edgePart = stableSortEdges([...definition.edges]).map((edge) => [
    edge.from,
    edge.to,
    edge.dependencyType,
  ]);

  return JSON.stringify({ taskPart, edgePart });
}

function collectDescendants(edges: ReadonlyArray<WorkflowEdge>, root: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const current = children.get(edge.from) ?? [];
    current.push(edge.to);
    children.set(edge.from, current);
  }

  const visited = new Set<string>();
  const queue = [...(children.get(root) ?? [])];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    queue.push(...(children.get(next) ?? []));
  }

  return visited;
}

function mutateEdgeRewire(
  baseline: WorkflowDefinition,
  rng: () => number,
): MutationAttemptResult | null {
  const names = baseline.tasks.map((task) => task.name).sort();
  if (names.length < 2) return null;

  const edgeByChild = new Map(baseline.edges.map((edge) => [edge.to, edge]));
  const dependencyTypes = [
    OnChainDependencyType.Data,
    OnChainDependencyType.Ordering,
    OnChainDependencyType.Proof,
  ];

  const start = chooseIndex(rng, names.length);

  for (let i = 0; i < names.length; i++) {
    const child = names[(start + i) % names.length];
    const descendants = collectDescendants(baseline.edges, child);

    const validParents = names.filter((candidate) => candidate !== child && !descendants.has(candidate));
    if (validParents.length === 0) continue;

    const parent = validParents[chooseIndex(rng, validParents.length)];
    const existing = edgeByChild.get(child);

    const nextEdges = baseline.edges
      .filter((edge) => edge.to !== child)
      .map(cloneEdge);

    const dependencyChoices = dependencyTypes.filter(
      (value) => !(existing && existing.from === parent && existing.dependencyType === value),
    );
    const dependencyType = dependencyChoices[chooseIndex(rng, dependencyChoices.length)];

    nextEdges.push({
      from: parent,
      to: child,
      dependencyType,
    });

    const definition: WorkflowDefinition = {
      ...cloneDefinition(baseline),
      edges: stableSortEdges(nextEdges),
    };

    validateWorkflow(definition);

    return {
      definition,
      mutation: {
        operator: 'edge_rewire',
        description: `Rewired parent of "${child}" to "${parent}"`,
        metadata: {
          child,
          parent,
          dependencyType,
        },
      },
    };
  }

  return null;
}

function mutateTaskType(
  baseline: WorkflowDefinition,
  config: ResolvedMutationConfig,
  rng: () => number,
): MutationAttemptResult | null {
  const tasks = [...baseline.tasks].sort((a, b) => a.name.localeCompare(b.name));
  if (tasks.length === 0) return null;

  const start = chooseIndex(rng, tasks.length);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[(start + i) % tasks.length];
    const alternatives = config.allowedTaskTypes.filter((candidate) => candidate !== task.taskType);
    if (alternatives.length === 0) continue;

    const nextType = alternatives[chooseIndex(rng, alternatives.length)];
    const nextTasks = baseline.tasks.map((current) =>
      current.name === task.name
        ? {
            ...cloneTask(current),
            taskType: nextType,
          }
        : cloneTask(current),
    );

    const definition: WorkflowDefinition = {
      ...cloneDefinition(baseline),
      tasks: nextTasks,
    };

    validateWorkflow(definition);

    return {
      definition,
      mutation: {
        operator: 'task_type',
        description: `Changed task type for "${task.name}" to ${nextType}`,
        metadata: {
          task: task.name,
          taskType: nextType,
        },
      },
    };
  }

  return null;
}

function mutateRewardPolicy(
  baseline: WorkflowDefinition,
  config: ResolvedMutationConfig,
  rng: () => number,
): MutationAttemptResult | null {
  const scales = config.rewardScaleBps.filter((value) => value > 0 && value !== 100);
  if (scales.length === 0) return null;

  const scaleBps = scales[chooseIndex(rng, scales.length)];
  const scale = BigInt(scaleBps);

  let changed = false;
  const nextTasks = baseline.tasks.map((task) => {
    const nextReward = (task.rewardAmount * scale) / 100n;
    if (nextReward !== task.rewardAmount) {
      changed = true;
    }

    return {
      ...cloneTask(task),
      rewardAmount: nextReward,
    };
  });

  if (!changed) return null;

  const definition: WorkflowDefinition = {
    ...cloneDefinition(baseline),
    tasks: nextTasks,
  };

  validateWorkflow(definition);

  return {
    definition,
    mutation: {
      operator: 'reward_policy',
      description: `Scaled task rewards by ${scaleBps}%`,
      metadata: {
        scaleBps,
      },
    },
  };
}

function mutateDeadlinePolicy(
  baseline: WorkflowDefinition,
  config: ResolvedMutationConfig,
  rng: () => number,
): MutationAttemptResult | null {
  const offsets = config.deadlineOffsetSeconds.filter((value) => value !== 0);
  if (offsets.length === 0) return null;

  const offsetSeconds = offsets[chooseIndex(rng, offsets.length)];
  let changed = false;

  const nextTasks = baseline.tasks.map((task) => {
    if (task.deadline <= 0) {
      return cloneTask(task);
    }

    const shifted = Math.max(0, task.deadline + offsetSeconds);
    if (shifted !== task.deadline) {
      changed = true;
    }

    return {
      ...cloneTask(task),
      deadline: shifted,
    };
  });

  if (!changed) return null;

  const definition: WorkflowDefinition = {
    ...cloneDefinition(baseline),
    tasks: nextTasks,
  };

  validateWorkflow(definition);

  return {
    definition,
    mutation: {
      operator: 'deadline_policy',
      description: `Shifted task deadlines by ${offsetSeconds}s`,
      metadata: {
        offsetSeconds,
      },
    },
  };
}

/**
 * Generate deterministic, validation-safe workflow mutation candidates.
 */
export function generateWorkflowMutationCandidates(
  baseline: WorkflowDefinition,
  config: WorkflowMutationConfig = {},
): WorkflowMutationCandidate[] {
  validateWorkflow(baseline);

  const resolved = resolveConfig(config);
  const rng = createSeededRandom(resolved.seed);

  const operators: WorkflowMutationOperator[] = [];
  if (resolved.includeEdgeRewire) operators.push('edge_rewire');
  if (resolved.includeTaskTypeMutations) operators.push('task_type');
  if (resolved.includeRewardMutations) operators.push('reward_policy');
  if (resolved.includeDeadlineMutations) operators.push('deadline_policy');

  if (operators.length === 0 || resolved.maxCandidates <= 0) {
    return [];
  }

  const candidates: WorkflowMutationCandidate[] = [];
  const seen = new Set<string>([signature(baseline)]);

  const maxAttempts = Math.max(operators.length * resolved.maxCandidates * 3, 8);
  let attempt = 0;

  while (candidates.length < resolved.maxCandidates && attempt < maxAttempts) {
    const operator = operators[attempt % operators.length];

    let result: MutationAttemptResult | null = null;
    if (operator === 'edge_rewire') {
      result = mutateEdgeRewire(baseline, rng);
    } else if (operator === 'task_type') {
      result = mutateTaskType(baseline, resolved, rng);
    } else if (operator === 'reward_policy') {
      result = mutateRewardPolicy(baseline, resolved, rng);
    } else if (operator === 'deadline_policy') {
      result = mutateDeadlinePolicy(baseline, resolved, rng);
    }

    attempt += 1;
    if (!result) {
      continue;
    }

    const key = signature(result.definition);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    candidates.push({
      id: `candidate-${candidates.length + 1}-${operator}`,
      definition: result.definition,
      mutations: [result.mutation],
    });
  }

  return candidates;
}
