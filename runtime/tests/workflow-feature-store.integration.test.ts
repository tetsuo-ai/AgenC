import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  DAGOrchestrator,
  GoalCompiler,
  OnChainDependencyType,
  WorkflowNodeStatus,
  WorkflowStatus,
  extractWorkflowFeatureVector,
  parseWorkflowFeatureVector,
  WORKFLOW_FEATURE_SCHEMA_VERSION,
} from '../src/workflow/index.js';

function mockBN(value: number | bigint): { toNumber: () => number; toString: () => string } {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  return {
    toNumber: () => numeric,
    toString: () => String(value),
  };
}

function makeMockProgram() {
  const listeners: Record<string, (event: unknown, slot: number, signature: string) => void> = {};
  const authority = Keypair.generate();
  const methodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn().mockResolvedValue('sig-test'),
  };

  const program = {
    programId: Keypair.generate().publicKey,
    provider: {
      publicKey: authority.publicKey,
    },
    methods: {
      createTask: vi.fn().mockReturnValue(methodChain),
      createDependentTask: vi.fn().mockReturnValue(methodChain),
    },
    account: {
      task: {
        fetch: vi.fn().mockResolvedValue({ status: { open: {} } }),
      },
    },
    addEventListener: vi.fn().mockImplementation(
      (
        eventName: string,
        callback: (event: unknown, slot: number, signature: string) => void,
      ) => {
        listeners[eventName] = callback;
        return Object.keys(listeners).length;
      },
    ),
    removeEventListener: vi.fn().mockResolvedValue(undefined),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  return {
    program,
    listeners,
  };
}

function emitTaskCompleted(
  listeners: Record<string, (event: unknown, slot: number, signature: string) => void>,
  taskId: Uint8Array,
): void {
  const callback = listeners.taskCompleted;
  if (!callback) throw new Error('taskCompleted listener not registered');

  callback(
    {
      taskId: Array.from(taskId),
      worker: Keypair.generate().publicKey,
      proofHash: new Uint8Array(32),
      rewardPaid: mockBN(1),
      timestamp: mockBN(1),
    },
    1,
    'sig-completed',
  );
}

describe('workflow feature store integration', () => {
  it('captures compile->submit->monitor output into optimizer feature vectors', async () => {
    const { program, listeners } = makeMockProgram();

    const planner = {
      plan: vi.fn().mockResolvedValue({
        workflowId: 'compiled-workflow',
        tasks: [
          {
            name: 'root',
            description: 'root step',
            requiredCapabilities: 1n,
            rewardAmount: 100,
          },
          {
            name: 'child',
            description: 'child step',
            dependsOn: 'root',
            dependencyType: OnChainDependencyType.Ordering,
            requiredCapabilities: 1n,
            rewardAmount: 50,
          },
        ],
      }),
    };

    const compiler = new GoalCompiler({ planner });
    const orchestrator = new DAGOrchestrator({
      program,
      agentId: new Uint8Array(32).fill(7),
      pollIntervalMs: 5,
    });

    try {
      const compiled = await orchestrator.compileGoal(
        {
          objective: 'Compile and launch test workflow',
          workflowId: 'integration-compiled',
        },
        compiler,
      );

      const state = await orchestrator.submit(compiled.definition);
      const rootId = state.nodes.get('root')?.taskId;
      const childId = state.nodes.get('child')?.taskId;

      expect(rootId).toBeTruthy();
      expect(childId).toBeTruthy();
      expect(state.status).toBe(WorkflowStatus.Running);
      expect(state.nodes.get('root')?.status).toBe(WorkflowNodeStatus.Created);
      expect(state.nodes.get('child')?.status).toBe(WorkflowNodeStatus.Created);

      emitTaskCompleted(listeners, rootId!);
      emitTaskCompleted(listeners, childId!);

      const final = await orchestrator.waitForCompletion(state.id, 1_000);
      expect(final.status).toBe(WorkflowStatus.Completed);

      const feature = extractWorkflowFeatureVector(final, {
        capturedAtMs: final.completedAt ?? Date.now(),
        costUnits: 4,
        rollbackCount: 1,
        verifierDisagreementCount: 1,
      });

      expect(feature.schemaVersion).toBe(WORKFLOW_FEATURE_SCHEMA_VERSION);
      expect(feature.workflowId).toBe('integration-compiled');
      expect(feature.topology.nodeCount).toBe(2);
      expect(feature.outcomes.success).toBe(true);
      expect(feature.outcomes.rollbackRate).toBeCloseTo(0.5, 6);
      expect(feature.outcomes.verifierDisagreementRate).toBeCloseTo(0.5, 6);
      expect(feature.outcomes.costUnits).toBe(4);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('loads legacy fixture vectors and migrates them to current schema version', () => {
    const fixtureRaw = readFileSync(
      new URL('./fixtures/workflow-feature-v0.json', import.meta.url),
      'utf8',
    );

    const fixture = JSON.parse(fixtureRaw) as unknown;
    const parsed = parseWorkflowFeatureVector(fixture);

    expect(parsed.schemaVersion).toBe(WORKFLOW_FEATURE_SCHEMA_VERSION);
    expect(parsed.workflowId).toBe('fixture-legacy-workflow');
    expect(parsed.nodeFeatures).toHaveLength(2);
    expect(parsed.topology.maxDepth).toBe(1);
  });
});
