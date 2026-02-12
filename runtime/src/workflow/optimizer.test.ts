import { describe, expect, it } from 'vitest';
import { WorkflowOptimizer } from './optimizer.js';
import {
  WORKFLOW_FEATURE_SCHEMA_VERSION,
  type WorkflowFeatureVector,
} from './optimizer-types.js';
import { OnChainDependencyType, type TaskTemplate, type WorkflowDefinition } from './types.js';
import { validateWorkflow } from './validation.js';

function makeTask(name: string, overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    name,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    rewardAmount: 100n,
    maxWorkers: 1,
    deadline: 12_000,
    taskType: 0,
    ...overrides,
  };
}

function makeBaseline(): WorkflowDefinition {
  return {
    id: 'wf-optimize',
    tasks: [
      makeTask('root', { rewardAmount: 100n }),
      makeTask('execute', { rewardAmount: 150n, taskType: 1 }),
      makeTask('review', { rewardAmount: 125n, taskType: 2 }),
    ],
    edges: [
      { from: 'root', to: 'execute', dependencyType: OnChainDependencyType.Data },
      { from: 'execute', to: 'review', dependencyType: OnChainDependencyType.Ordering },
    ],
  };
}

function makeHistoryPoint(id: string, success: boolean, latencyMs: number, costUnits: number): WorkflowFeatureVector {
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
      totalRewardLamports: '375',
      averageRewardLamports: 125,
    },
    outcomes: {
      outcome: success ? 'completed' : 'failed',
      success,
      elapsedMs: latencyMs,
      completionRate: success ? 1 : 0.34,
      failureRate: success ? 0 : 0.66,
      cancelledRate: 0,
      costUnits,
      rollbackRate: success ? 0.01 : 0.1,
      verifierDisagreementRate: success ? 0.02 : 0.2,
      conformanceScore: success ? 0.95 : 0.45,
    },
    nodeFeatures: [
      {
        name: 'root',
        taskType: 0,
        dependencyType: 0,
        rewardLamports: '100',
        maxWorkers: 1,
        minReputation: 0,
        hasConstraintHash: false,
        status: success ? 'completed' : 'failed',
      },
    ],
    metadata: { workflow_source: 'single_agent' },
  };
}

describe('WorkflowOptimizer', () => {
  it('generates, scores, and selects deterministic workflow variants with audit metadata', () => {
    const baseline = makeBaseline();
    const history = [
      makeHistoryPoint('h1', true, 1_200, 1.1),
      makeHistoryPoint('h2', true, 1_000, 1.0),
      makeHistoryPoint('h3', false, 2_200, 1.8),
    ];

    const optimizer = new WorkflowOptimizer({ seed: 19, maxCandidates: 6 });
    const result = optimizer.optimize({ baseline, history, seed: 19 });

    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.selected.id).toBe(result.scored[0].candidateId);
    expect(result.audit.selectedCandidateId).toBe(result.selected.id);
    expect(result.audit.rationaleMetadata.candidateCount).toBe(result.candidates.length);
    expect(result.audit.rationaleMetadata.mutationOperators).toBeDefined();

    // Deterministic selection with same seed + history.
    const second = optimizer.optimize({ baseline, history, seed: 19 });
    expect(second.selected.id).toBe(result.selected.id);
  });

  it('ensures every candidate is validation-safe before selection', () => {
    const baseline = makeBaseline();
    const optimizer = new WorkflowOptimizer({ seed: 7, maxCandidates: 8 });
    const result = optimizer.optimize({ baseline, history: [makeHistoryPoint('h', true, 900, 1)] });

    for (const candidate of result.candidates) {
      expect(() => validateWorkflow(candidate.definition)).not.toThrow();
    }
  });

  it('returns baseline-only plan when optimizer feature flag is disabled', () => {
    const baseline = makeBaseline();
    const optimizer = new WorkflowOptimizer({ enabled: false, seed: 10, maxCandidates: 10 });

    const result = optimizer.optimize({ baseline, history: [makeHistoryPoint('h', true, 800, 1)] });

    expect(result.candidates).toHaveLength(1);
    expect(result.selected.id).toBe('baseline');
    expect(result.audit.selectedCandidateId).toBe('baseline');
  });
});
