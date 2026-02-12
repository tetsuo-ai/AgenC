import { describe, expect, it } from 'vitest';
import {
  WorkflowOptimizer,
  WorkflowCanaryRollout,
  WORKFLOW_FEATURE_SCHEMA_VERSION,
  OnChainDependencyType,
  type TaskTemplate,
  type WorkflowDefinition,
  type WorkflowFeatureVector,
} from '../src/workflow/index.js';

function makeTask(name: string, overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    name,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    rewardAmount: 100n,
    maxWorkers: 1,
    deadline: 9_000,
    taskType: 0,
    ...overrides,
  };
}

function makeBaseline(): WorkflowDefinition {
  return {
    id: 'wf-integration-opt',
    tasks: [
      makeTask('plan', { rewardAmount: 100n, taskType: 0 }),
      makeTask('build', { rewardAmount: 180n, taskType: 1 }),
      makeTask('review', { rewardAmount: 150n, taskType: 2 }),
    ],
    edges: [
      { from: 'plan', to: 'build', dependencyType: OnChainDependencyType.Data },
      { from: 'build', to: 'review', dependencyType: OnChainDependencyType.Ordering },
    ],
  };
}

function makeHistory(id: string, success: boolean, elapsedMs: number, costUnits: number): WorkflowFeatureVector {
  return {
    schemaVersion: WORKFLOW_FEATURE_SCHEMA_VERSION,
    workflowId: id,
    capturedAtMs: 100,
    topology: {
      nodeCount: 3,
      edgeCount: 2,
      rootCount: 1,
      maxDepth: 2,
      averageBranchingFactor: 1,
    },
    composition: {
      taskTypeHistogram: { '0': 1, '1': 1, '2': 1 },
      dependencyTypeHistogram: { '0': 1, '1': 1, '2': 1 },
      privateTaskCount: 0,
      totalRewardLamports: '430',
      averageRewardLamports: 143.3,
    },
    outcomes: {
      outcome: success ? 'completed' : 'failed',
      success,
      elapsedMs,
      completionRate: success ? 1 : 0.33,
      failureRate: success ? 0 : 0.67,
      cancelledRate: 0,
      costUnits,
      rollbackRate: success ? 0.02 : 0.14,
      verifierDisagreementRate: success ? 0.03 : 0.2,
      conformanceScore: success ? 0.93 : 0.42,
    },
    nodeFeatures: [
      {
        name: 'plan',
        taskType: 0,
        dependencyType: 0,
        rewardLamports: '100',
        maxWorkers: 1,
        minReputation: 0,
        hasConstraintHash: false,
        status: success ? 'completed' : 'failed',
      },
    ],
    metadata: {
      workflow_source: 'single_agent',
    },
  };
}

describe('workflow optimizer integration', () => {
  it('runs deterministic optimization and rolls back canary variants on regressions', () => {
    const baseline = makeBaseline();
    const history = [
      makeHistory('h1', true, 1_000, 1.0),
      makeHistory('h2', true, 1_100, 1.1),
      makeHistory('h3', false, 2_200, 1.8),
    ];

    const optimizer = new WorkflowOptimizer({
      enabled: true,
      seed: 23,
      maxCandidates: 6,
      explorationWeight: 0,
    });

    const optimized = optimizer.optimize({ baseline, history, seed: 23 });
    expect(optimized.selected.id).not.toBe('baseline');

    const rollout = new WorkflowCanaryRollout('baseline', optimized.selected.id, {
      enabled: true,
      canaryPercent: 1,
      minCanarySamples: 4,
      stopLoss: {
        maxFailureRateDelta: 0.05,
        maxLatencyMsDelta: 200,
        maxCostUnitsDelta: 0.2,
      },
      seed: 23,
    });

    for (let i = 0; i < 8; i++) {
      rollout.recordSample('baseline', { success: true, latencyMs: 700, costUnits: 1.0 });
    }

    for (let i = 0; i < 20; i++) {
      const routed = rollout.route(`request-${i}`);
      if (routed === optimized.selected.id) {
        rollout.recordSample(routed, { success: false, latencyMs: 1_800, costUnits: 2.1 });
      } else {
        rollout.recordSample(routed, { success: true, latencyMs: 700, costUnits: 1.0 });
      }
    }

    const first = rollout.evaluate();
    const second = rollout.evaluate();

    expect(first.action).toBe('rollback');
    expect(first.reason).toBe('stop_loss_exceeded');
    expect(second.action).toBe('rollback');
    expect(rollout.route('after-rollback')).toBe('baseline');
  });

  it('selects the same candidate id for the same seed/history simulation', () => {
    const baseline = makeBaseline();
    const history = [
      makeHistory('s1', true, 950, 1.0),
      makeHistory('s2', true, 1_050, 1.05),
      makeHistory('s3', true, 980, 1.02),
    ];

    const optimizer = new WorkflowOptimizer({ seed: 31, maxCandidates: 5, explorationWeight: 0 });

    const first = optimizer.optimize({ baseline, history, seed: 31 });
    const second = optimizer.optimize({ baseline, history, seed: 31 });

    expect(first.selected.id).toBe(second.selected.id);
    expect(first.selected.id).toBe('candidate-2-task_type');
  });
});
