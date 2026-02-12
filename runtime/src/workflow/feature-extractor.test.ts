import { describe, expect, it } from 'vitest';
import { UnifiedTelemetryCollector } from '../telemetry/collector.js';
import { TeamContractEngine } from '../team/engine.js';
import { TeamWorkflowAdapter } from '../team/workflow-adapter.js';
import type { TeamTemplate, TeamContractSnapshot } from '../team/types.js';
import {
  WorkflowNodeStatus,
  WorkflowStatus,
  OnChainDependencyType,
  type WorkflowState,
  type WorkflowNode,
  type TaskTemplate,
  type WorkflowDefinition,
} from './types.js';
import {
  WORKFLOW_TELEMETRY_KEYS,
  extractWorkflowFeatureVector,
  extractWorkflowFeatureVectorFromCollector,
} from './feature-extractor.js';

function makeTemplate(name: string, overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    name,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    rewardAmount: 100n,
    maxWorkers: 1,
    deadline: 0,
    taskType: 0,
    ...overrides,
  };
}

function makeState(definition: WorkflowDefinition): WorkflowState {
  const edgeByChild = new Map(definition.edges.map((edge) => [edge.to, edge]));
  const nodes = new Map<string, WorkflowNode>();

  // Intentionally reverse insert order to test deterministic sorting.
  const reverseTasks = [...definition.tasks].reverse();

  for (const task of reverseTasks) {
    const parent = edgeByChild.get(task.name);
    nodes.set(task.name, {
      name: task.name,
      template: task,
      taskId: null,
      taskPda: null,
      parentName: parent?.from ?? null,
      parentPda: null,
      dependencyType: parent?.dependencyType ?? OnChainDependencyType.None,
      status: WorkflowNodeStatus.Created,
      transactionSignature: null,
      error: null,
      createdAt: 10,
      completedAt: null,
    });
  }

  return {
    id: definition.id,
    definition,
    status: WorkflowStatus.Running,
    nodes,
    startedAt: 10,
    completedAt: null,
  };
}

function makeTeamTemplate(): TeamTemplate {
  return {
    id: 'team-template',
    name: 'Team Template',
    roles: [
      { id: 'planner', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
      { id: 'worker', requiredCapabilities: 2n, minMembers: 1, maxMembers: 2 },
    ],
    checkpoints: [
      { id: 'plan', roleId: 'planner', label: 'Plan' },
      { id: 'build', roleId: 'worker', label: 'Build', dependsOn: ['plan'] },
    ],
    payout: {
      mode: 'fixed',
      rolePayoutBps: {
        planner: 5000,
        worker: 5000,
      },
    },
  };
}

function buildActiveTeamSnapshot(): TeamContractSnapshot {
  const engine = new TeamContractEngine();
  engine.createContract({ contractId: 'team-contract', creatorId: 'creator', template: makeTeamTemplate() });
  engine.joinContract({
    contractId: 'team-contract',
    member: { id: 'member-planner', capabilities: 1n, roles: ['planner'] },
  });
  engine.joinContract({
    contractId: 'team-contract',
    member: { id: 'member-worker', capabilities: 2n, roles: ['worker'] },
  });
  return engine.startRun('team-contract');
}

describe('extractWorkflowFeatureVector', () => {
  it('extracts deterministic feature vectors independent of map insertion order', () => {
    const definition: WorkflowDefinition = {
      id: 'wf-deterministic',
      tasks: [
        makeTemplate('root', { rewardAmount: 100n }),
        makeTemplate('child', { rewardAmount: 200n, constraintHash: new Uint8Array(32) }),
      ],
      edges: [{ from: 'root', to: 'child', dependencyType: OnChainDependencyType.Data }],
    };

    const first = makeState(definition);
    const second = makeState({
      ...definition,
      tasks: [...definition.tasks].reverse(),
    });

    const firstVector = extractWorkflowFeatureVector(first, { capturedAtMs: 1000 });
    const secondVector = extractWorkflowFeatureVector(second, { capturedAtMs: 1000 });

    expect(firstVector).toEqual(secondVector);
    expect(firstVector.nodeFeatures.map((node) => node.name)).toEqual(['child', 'root']);
    expect(firstVector.composition.privateTaskCount).toBe(1);
  });

  it('ingests workflow telemetry metrics with workflow_id filtering', () => {
    const definition: WorkflowDefinition = {
      id: 'wf-telemetry',
      tasks: [makeTemplate('a'), makeTemplate('b')],
      edges: [{ from: 'a', to: 'b', dependencyType: OnChainDependencyType.Ordering }],
    };

    const state = makeState(definition);
    state.nodes.get('a')!.status = WorkflowNodeStatus.Completed;
    state.nodes.get('a')!.completedAt = 100;
    state.nodes.get('b')!.status = WorkflowNodeStatus.Completed;
    state.nodes.get('b')!.completedAt = 120;
    state.status = WorkflowStatus.Completed;
    state.completedAt = 120;

    const collector = new UnifiedTelemetryCollector();
    collector.gauge(WORKFLOW_TELEMETRY_KEYS.COST_UNITS, 9, { workflow_id: state.id });
    collector.counter(WORKFLOW_TELEMETRY_KEYS.ROLLBACKS_TOTAL, 2, { workflow_id: state.id });
    collector.counter(WORKFLOW_TELEMETRY_KEYS.VERIFIER_DISAGREEMENTS_TOTAL, 1, { workflow_id: state.id });

    // Noise from another workflow must be ignored.
    collector.counter(WORKFLOW_TELEMETRY_KEYS.ROLLBACKS_TOTAL, 100, { workflow_id: 'other' });

    const vector = extractWorkflowFeatureVectorFromCollector(state, collector, { capturedAtMs: 200 });

    expect(vector.outcomes.costUnits).toBe(9);
    expect(vector.outcomes.rollbackRate).toBeCloseTo(1, 6); // 2 / 2 nodes
    expect(vector.outcomes.verifierDisagreementRate).toBeCloseTo(0.5, 6); // 1 / 2 nodes
    expect(vector.outcomes.elapsedMs).toBe(110);
    expect(vector.outcomes.success).toBe(true);
  });

  it('supports team adapter workflows with role-aware metadata', () => {
    const snapshot = buildActiveTeamSnapshot();
    const adapter = new TeamWorkflowAdapter();
    const built = adapter.build(snapshot, {
      workflowId: 'wf-team-adapter',
      dependencyType: OnChainDependencyType.Ordering,
      totalRewardLamports: 10n,
    });

    const state = makeState(built.definition);
    state.status = WorkflowStatus.PartiallyCompleted;
    state.nodes.get('plan')!.status = WorkflowNodeStatus.Completed;
    state.nodes.get('build')!.status = WorkflowNodeStatus.Failed;

    const vector = extractWorkflowFeatureVector(state, {
      capturedAtMs: 999,
      taskRoleByTaskName: built.taskRole,
      metadata: { env: 'test' },
    });

    expect(vector.metadata?.workflow_source).toBe('team_adapter');
    expect(vector.metadata?.['role_count.planner']).toBe('1');
    expect(vector.metadata?.['role_count.worker']).toBe('1');
    expect(vector.metadata?.env).toBe('test');
    expect(vector.outcomes.outcome).toBe('partially_completed');
    expect(vector.outcomes.success).toBe(false);
  });
});
