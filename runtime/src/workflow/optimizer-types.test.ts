import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_FEATURE_SCHEMA_VERSION,
  WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
  createDefaultWorkflowObjectiveSpec,
  parseWorkflowFeatureVector,
  scoreWorkflowObjective,
  validateWorkflowObjectiveSpec,
  workflowObjectiveOutcomeFromFeature,
  type WorkflowFeatureVector,
} from './optimizer-types.js';

function makeFeature(overrides: Partial<WorkflowFeatureVector> = {}): WorkflowFeatureVector {
  return {
    schemaVersion: WORKFLOW_FEATURE_SCHEMA_VERSION,
    workflowId: 'wf-1',
    capturedAtMs: 123,
    topology: {
      nodeCount: 2,
      edgeCount: 1,
      rootCount: 1,
      maxDepth: 1,
      averageBranchingFactor: 1,
    },
    composition: {
      taskTypeHistogram: { '0': 2 },
      dependencyTypeHistogram: { '0': 1, '1': 1 },
      privateTaskCount: 0,
      totalRewardLamports: '300',
      averageRewardLamports: 150,
    },
    outcomes: {
      outcome: 'completed',
      success: true,
      elapsedMs: 25,
      completionRate: 1,
      failureRate: 0,
      cancelledRate: 0,
      costUnits: 2,
      rollbackRate: 0,
      verifierDisagreementRate: 0.1,
      conformanceScore: 0.95,
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
        status: 'completed',
      },
      {
        name: 'child',
        taskType: 0,
        dependencyType: 1,
        rewardLamports: '200',
        maxWorkers: 1,
        minReputation: 0,
        hasConstraintHash: false,
        status: 'completed',
      },
    ],
    metadata: { workflow_source: 'single_agent' },
    ...overrides,
  };
}

describe('workflow optimizer objective contracts', () => {
  it('builds default objective schema with safe weighted metrics', () => {
    const spec = createDefaultWorkflowObjectiveSpec();

    expect(spec.schemaVersion).toBe(WORKFLOW_OBJECTIVE_SCHEMA_VERSION);
    expect(spec.weights.length).toBeGreaterThan(0);
    const total = spec.weights.reduce((sum, weight) => sum + weight.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('validates objective schema invariants', () => {
    expect(() =>
      validateWorkflowObjectiveSpec({
        id: 'x',
        schemaVersion: WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
        weights: [{ metric: 'success_rate', direction: 'maximize', weight: 0.2 }],
      }),
    ).not.toThrow();

    expect(() =>
      validateWorkflowObjectiveSpec({
        id: 'x',
        schemaVersion: WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
        weights: [{ metric: 'latency_ms', direction: 'minimize', weight: -1 }],
      }),
    ).toThrow('must be non-negative');
  });

  it('scores improved outcomes higher under default objective', () => {
    const baseline = scoreWorkflowObjective({
      successRate: 0.4,
      conformanceScore: 0.5,
      latencyMs: 120_000,
      costUnits: 5,
      rollbackRate: 0.25,
      verifierDisagreementRate: 0.2,
    });

    const improved = scoreWorkflowObjective({
      successRate: 1,
      conformanceScore: 1,
      latencyMs: 15_000,
      costUnits: 1,
      rollbackRate: 0,
      verifierDisagreementRate: 0,
    });

    expect(improved).toBeGreaterThan(baseline);
    expect(improved).toBeLessThanOrEqual(1);
  });
});

describe('workflow feature schema parsing and migration', () => {
  it('parses v1 feature vectors', () => {
    const feature = makeFeature();
    const parsed = parseWorkflowFeatureVector(feature);

    expect(parsed.schemaVersion).toBe(WORKFLOW_FEATURE_SCHEMA_VERSION);
    expect(parsed.workflowId).toBe('wf-1');
    expect(parsed.nodeFeatures).toHaveLength(2);
  });

  it('migrates legacy feature vectors with missing schemaVersion', () => {
    const legacy = {
      workflowId: 'wf-legacy',
      topology: {
        nodeCount: 1,
        edgeCount: 0,
        rootCount: 1,
        maxDepth: 0,
        averageBranchingFactor: 0,
      },
      composition: {
        taskTypeHistogram: { '0': 1 },
        dependencyTypeHistogram: { '0': 1 },
        privateTaskCount: 0,
        totalRewardLamports: '1',
        averageRewardLamports: 1,
      },
      outcomes: {
        outcome: 'completed',
        success: true,
        elapsedMs: 1,
        completionRate: 1,
        failureRate: 0,
        cancelledRate: 0,
        costUnits: 0,
        rollbackRate: 0,
        verifierDisagreementRate: 0,
        conformanceScore: 1,
      },
      nodeFeatures: [
        {
          name: 'only',
          taskType: 0,
          dependencyType: 0,
          rewardLamports: '1',
          maxWorkers: 1,
          minReputation: 0,
          hasConstraintHash: false,
          status: 'completed',
        },
      ],
    };

    const parsed = parseWorkflowFeatureVector(legacy);

    expect(parsed.schemaVersion).toBe(WORKFLOW_FEATURE_SCHEMA_VERSION);
    expect(parsed.workflowId).toBe('wf-legacy');
    expect(parsed.capturedAtMs).toBeGreaterThanOrEqual(0);
  });

  it('projects objective outcome from feature outputs', () => {
    const feature = makeFeature({
      outcomes: {
        outcome: 'partially_completed',
        success: false,
        elapsedMs: 99,
        completionRate: 0.5,
        failureRate: 0.5,
        cancelledRate: 0,
        costUnits: 3,
        rollbackRate: 0.25,
        verifierDisagreementRate: 0.4,
        conformanceScore: 0.6,
      },
    });

    const projected = workflowObjectiveOutcomeFromFeature(feature);
    expect(projected.successRate).toBe(0);
    expect(projected.latencyMs).toBe(99);
    expect(projected.rollbackRate).toBe(0.25);
    expect(projected.verifierDisagreementRate).toBe(0.4);
  });
});
