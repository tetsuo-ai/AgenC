/**
 * Tests for the Workflow DAG Orchestrator module.
 *
 * Covers:
 * - Validation (cycles, multi-parent, duplicates, self-loops, empty, edge refs, dep types)
 * - Topological sort
 * - DAGSubmitter (mocked program calls)
 * - DAGMonitor (event and poll handling)
 * - DAGOrchestrator (full compose flow)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { validateWorkflow, topologicalSort } from './validation.js';
import { WorkflowValidationError, WorkflowSubmissionError, WorkflowStateError } from './errors.js';
import { DAGSubmitter } from './submitter.js';
import { DAGMonitor } from './monitor.js';
import { DAGOrchestrator } from './orchestrator.js';
import {
  OnChainDependencyType,
  WorkflowNodeStatus,
  WorkflowStatus,
} from './types.js';
import type {
  WorkflowDefinition,
  TaskTemplate,
  WorkflowEdge,
  WorkflowState,
} from './types.js';
import { RuntimeErrorCodes } from '../types/errors.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTemplate(name: string, overrides?: Partial<TaskTemplate>): TaskTemplate {
  return {
    name,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    rewardAmount: 100_000_000n,
    maxWorkers: 1,
    deadline: 0,
    taskType: 0,
    ...overrides,
  };
}

function makeDefinition(
  tasks: TaskTemplate[],
  edges: WorkflowEdge[] = [],
  id = 'test-workflow',
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { id, tasks, edges, ...overrides };
}

function makeMockProgram() {
  const authority = Keypair.generate();
  const mockRpc = vi.fn().mockResolvedValue('mock-tx-sig');

  const methodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: mockRpc,
  };

  const program = {
    programId: new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7'),
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
    addEventListener: vi.fn().mockReturnValue(0),
    removeEventListener: vi.fn().mockResolvedValue(undefined),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  return { program, authority, mockRpc, methodChain };
}

// ============================================================================
// Validation Tests
// ============================================================================

describe('validateWorkflow', () => {
  it('rejects empty task array', () => {
    expect(() => validateWorkflow(makeDefinition([]))).toThrow(WorkflowValidationError);
    expect(() => validateWorkflow(makeDefinition([]))).toThrow('at least one task');
  });

  it('rejects duplicate task names', () => {
    const def = makeDefinition([makeTemplate('a'), makeTemplate('a')]);
    expect(() => validateWorkflow(def)).toThrow('Duplicate task name: "a"');
  });

  it('rejects empty task name', () => {
    const def = makeDefinition([makeTemplate('')]);
    expect(() => validateWorkflow(def)).toThrow('non-empty string');
  });

  it('rejects whitespace-only task name', () => {
    const def = makeDefinition([makeTemplate('   ')]);
    expect(() => validateWorkflow(def)).toThrow('non-empty string');
  });

  it('rejects edge with unknown "from" reference', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [{ from: 'x', to: 'b', dependencyType: OnChainDependencyType.Data }],
    );
    expect(() => validateWorkflow(def)).toThrow('unknown task "x" in "from"');
  });

  it('rejects edge with unknown "to" reference', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [{ from: 'a', to: 'y', dependencyType: OnChainDependencyType.Data }],
    );
    expect(() => validateWorkflow(def)).toThrow('unknown task "y" in "to"');
  });

  it('rejects self-loop', () => {
    const def = makeDefinition(
      [makeTemplate('a')],
      [{ from: 'a', to: 'a', dependencyType: OnChainDependencyType.Data }],
    );
    expect(() => validateWorkflow(def)).toThrow('Self-loop');
  });

  it('rejects multi-parent node', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [
        { from: 'a', to: 'c', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'c', dependencyType: OnChainDependencyType.Ordering },
      ],
    );
    expect(() => validateWorkflow(def)).toThrow('Multi-parent');
  });

  it('rejects cycle (A -> B -> A)', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'a', dependencyType: OnChainDependencyType.Ordering },
      ],
    );
    // Multi-parent will fire first since 'a' has both no-parent root + incoming from 'b'
    expect(() => validateWorkflow(def)).toThrow();
  });

  it('rejects dependency type None (0)', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [{ from: 'a', to: 'b', dependencyType: OnChainDependencyType.None }],
    );
    expect(() => validateWorkflow(def)).toThrow('Invalid dependency type');
  });

  it('rejects invalid dependency type (99)', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [{ from: 'a', to: 'b', dependencyType: 99 as any }],
    );
    expect(() => validateWorkflow(def)).toThrow('Invalid dependency type');
  });

  it('accepts valid linear chain', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'c', dependencyType: OnChainDependencyType.Ordering },
      ],
    );
    expect(() => validateWorkflow(def)).not.toThrow();
  });

  it('accepts valid tree (one parent branches to two children)', () => {
    const def = makeDefinition(
      [makeTemplate('root'), makeTemplate('left'), makeTemplate('right')],
      [
        { from: 'root', to: 'left', dependencyType: OnChainDependencyType.Data },
        { from: 'root', to: 'right', dependencyType: OnChainDependencyType.Proof },
      ],
    );
    expect(() => validateWorkflow(def)).not.toThrow();
  });

  it('accepts single task with no edges', () => {
    const def = makeDefinition([makeTemplate('solo')]);
    expect(() => validateWorkflow(def)).not.toThrow();
  });

  it('accepts forest (multiple disconnected roots)', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [],
    );
    expect(() => validateWorkflow(def)).not.toThrow();
  });
});

// ============================================================================
// Topological Sort Tests
// ============================================================================

describe('topologicalSort', () => {
  it('returns single task', () => {
    const def = makeDefinition([makeTemplate('a')]);
    expect(topologicalSort(def)).toEqual(['a']);
  });

  it('returns linear chain in order', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'c', dependencyType: OnChainDependencyType.Data },
      ],
    );
    expect(topologicalSort(def)).toEqual(['a', 'b', 'c']);
  });

  it('places parent before children in tree', () => {
    const def = makeDefinition(
      [makeTemplate('root'), makeTemplate('left'), makeTemplate('right')],
      [
        { from: 'root', to: 'left', dependencyType: OnChainDependencyType.Data },
        { from: 'root', to: 'right', dependencyType: OnChainDependencyType.Data },
      ],
    );
    const sorted = topologicalSort(def);
    expect(sorted[0]).toBe('root');
    expect(sorted).toContain('left');
    expect(sorted).toContain('right');
  });

  it('handles forest with all roots', () => {
    const def = makeDefinition(
      [makeTemplate('x'), makeTemplate('y'), makeTemplate('z')],
      [],
    );
    const sorted = topologicalSort(def);
    expect(sorted).toHaveLength(3);
    expect(sorted).toContain('x');
    expect(sorted).toContain('y');
    expect(sorted).toContain('z');
  });

  it('handles diamond-ish tree (deep chain)', () => {
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c'), makeTemplate('d')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'a', to: 'c', dependencyType: OnChainDependencyType.Ordering },
        { from: 'b', to: 'd', dependencyType: OnChainDependencyType.Proof },
      ],
    );
    const sorted = topologicalSort(def);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
  });
});

// ============================================================================
// Error Classes Tests
// ============================================================================

describe('Workflow error classes', () => {
  it('WorkflowValidationError has correct code', () => {
    const err = new WorkflowValidationError('test');
    expect(err.code).toBe(RuntimeErrorCodes.WORKFLOW_VALIDATION_ERROR);
    expect(err.name).toBe('WorkflowValidationError');
  });

  it('WorkflowSubmissionError includes node name', () => {
    const err = new WorkflowSubmissionError('myNode', 'tx failed');
    expect(err.code).toBe(RuntimeErrorCodes.WORKFLOW_SUBMISSION_ERROR);
    expect(err.nodeName).toBe('myNode');
    expect(err.message).toContain('myNode');
    expect(err.message).toContain('tx failed');
  });

  it('WorkflowStateError has correct code', () => {
    const err = new WorkflowStateError('not found');
    expect(err.code).toBe(RuntimeErrorCodes.WORKFLOW_STATE_ERROR);
    expect(err.name).toBe('WorkflowStateError');
  });
});

// ============================================================================
// DAGSubmitter Tests
// ============================================================================

describe('DAGSubmitter', () => {
  let program: any;
  let methodChain: any;
  let mockRpc: any;
  let agentId: Uint8Array;

  beforeEach(() => {
    ({ program, methodChain, mockRpc } = makeMockProgram());
    agentId = new Uint8Array(32).fill(1);
  });

  it('submits root tasks via createTask', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const def = makeDefinition([makeTemplate('root')]);
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(program.methods.createTask).toHaveBeenCalledOnce();
    expect(program.methods.createDependentTask).not.toHaveBeenCalled();
    expect(state.nodes.get('root')!.status).toBe(WorkflowNodeStatus.Created);
    expect(state.nodes.get('root')!.transactionSignature).toBe('mock-tx-sig');
  });

  it('submits dependent tasks via createDependentTask', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const def = makeDefinition(
      [makeTemplate('parent'), makeTemplate('child')],
      [{ from: 'parent', to: 'child', dependencyType: OnChainDependencyType.Data }],
    );
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(program.methods.createTask).toHaveBeenCalledOnce();
    expect(program.methods.createDependentTask).toHaveBeenCalledOnce();
    expect(state.nodes.get('child')!.parentName).toBe('parent');
    expect(state.nodes.get('child')!.parentPda).toBeTruthy();
  });

  it('sets taskId and taskPda on created nodes', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const def = makeDefinition([makeTemplate('a')]);
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    const node = state.nodes.get('a')!;
    expect(node.taskId).toBeInstanceOf(Uint8Array);
    expect(node.taskId!.length).toBe(32);
    expect(node.taskPda).toBeInstanceOf(PublicKey);
  });

  it('cascade-cancels descendants on failure when cancelOnFailure is true', async () => {
    mockRpc.mockResolvedValueOnce('tx-1').mockRejectedValueOnce(new Error('boom'));
    const submitter = new DAGSubmitter({ program, agentId, maxRetries: 0 });
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'c', dependencyType: OnChainDependencyType.Ordering },
      ],
    );
    const state = buildTestState(def);

    await expect(submitter.submitAll(state, true)).rejects.toThrow(WorkflowSubmissionError);

    expect(state.nodes.get('a')!.status).toBe(WorkflowNodeStatus.Created);
    expect(state.nodes.get('b')!.status).toBe(WorkflowNodeStatus.Failed);
    expect(state.nodes.get('c')!.status).toBe(WorkflowNodeStatus.Cancelled);
  });

  it('does not cascade-cancel when cancelOnFailure is false', async () => {
    mockRpc.mockResolvedValueOnce('tx-1').mockRejectedValueOnce(new Error('boom'));
    const submitter = new DAGSubmitter({ program, agentId, maxRetries: 0 });
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b'), makeTemplate('c')],
      [
        { from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data },
        { from: 'b', to: 'c', dependencyType: OnChainDependencyType.Ordering },
      ],
    );
    const state = buildTestState(def);

    await expect(submitter.submitAll(state, false)).rejects.toThrow(WorkflowSubmissionError);

    expect(state.nodes.get('a')!.status).toBe(WorkflowNodeStatus.Created);
    expect(state.nodes.get('b')!.status).toBe(WorkflowNodeStatus.Failed);
    // c should remain Pending, not Cancelled
    expect(state.nodes.get('c')!.status).toBe(WorkflowNodeStatus.Pending);
  });

  it('retries on transient errors', async () => {
    mockRpc.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('tx-ok');
    const submitter = new DAGSubmitter({ program, agentId, maxRetries: 2, retryDelayMs: 1 });
    const def = makeDefinition([makeTemplate('a')]);
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(state.nodes.get('a')!.status).toBe(WorkflowNodeStatus.Created);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('passes correct accounts to createTask', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const template = makeTemplate('root', { constraintHash: new Uint8Array(32).fill(0xab) });
    const def = makeDefinition([template]);
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(methodChain.accountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: program.provider.publicKey,
        creator: program.provider.publicKey,
      }),
    );
  });

  it('submits tree with multiple children', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const def = makeDefinition(
      [makeTemplate('root'), makeTemplate('left'), makeTemplate('right')],
      [
        { from: 'root', to: 'left', dependencyType: OnChainDependencyType.Data },
        { from: 'root', to: 'right', dependencyType: OnChainDependencyType.Proof },
      ],
    );
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(program.methods.createTask).toHaveBeenCalledOnce(); // root
    expect(program.methods.createDependentTask).toHaveBeenCalledTimes(2); // left + right
    for (const node of state.nodes.values()) {
      expect(node.status).toBe(WorkflowNodeStatus.Created);
    }
  });

  it('applies workflow defaultRewardMint when node rewardMint is omitted', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const defaultMint = PublicKey.unique();
    const def = makeDefinition(
      [makeTemplate('root')],
      [],
      'test-workflow',
      { defaultRewardMint: defaultMint },
    );
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    expect(program.methods.createTask).toHaveBeenCalledOnce();
    const args = program.methods.createTask.mock.calls[0];
    expect(args[9].equals(defaultMint)).toBe(true);
  });

  it('prefers node rewardMint over workflow defaultRewardMint', async () => {
    const submitter = new DAGSubmitter({ program, agentId });
    const defaultMint = PublicKey.unique();
    const nodeMint = PublicKey.unique();
    const def = makeDefinition(
      [makeTemplate('root', { rewardMint: nodeMint })],
      [],
      'test-workflow',
      { defaultRewardMint: defaultMint },
    );
    const state = buildTestState(def);

    await submitter.submitAll(state, true);

    const args = program.methods.createTask.mock.calls[0];
    expect(args[9].equals(nodeMint)).toBe(true);
  });
});

// ============================================================================
// DAGMonitor Tests
// ============================================================================

describe('DAGMonitor', () => {
  let program: any;

  beforeEach(() => {
    ({ program } = makeMockProgram());
  });

  it('detects terminal state when all nodes completed', () => {
    const monitor = new DAGMonitor({ program });
    const state: WorkflowState = {
      id: 'wf-1',
      definition: makeDefinition([makeTemplate('a')]),
      status: WorkflowStatus.Running,
      nodes: new Map([
        ['a', {
          name: 'a', template: makeTemplate('a'),
          taskId: null, taskPda: null, parentName: null, parentPda: null,
          dependencyType: OnChainDependencyType.None,
          status: WorkflowNodeStatus.Completed,
          transactionSignature: null, error: null,
          createdAt: Date.now(), completedAt: Date.now(),
        }],
      ]),
      startedAt: Date.now(),
      completedAt: null,
    };
    expect(monitor.isTerminal({ ...state, status: WorkflowStatus.Completed })).toBe(true);
  });

  it('registers event listeners on startMonitoring', () => {
    const monitor = new DAGMonitor({ program });
    const def = makeDefinition([makeTemplate('a')]);
    const state = buildTestState(def);
    state.nodes.get('a')!.taskId = new Uint8Array(32);
    state.nodes.get('a')!.taskPda = Keypair.generate().publicKey;
    state.nodes.get('a')!.status = WorkflowNodeStatus.Created;

    monitor.startMonitoring(state, {}, true);

    // Should have registered taskCompleted and taskCancelled listeners
    expect(program.addEventListener).toHaveBeenCalledTimes(2);
    expect(program.addEventListener).toHaveBeenCalledWith('taskCompleted', expect.any(Function));
    expect(program.addEventListener).toHaveBeenCalledWith('taskCancelled', expect.any(Function));
  });

  it('throws when waitForTerminal on unknown workflow', () => {
    const monitor = new DAGMonitor({ program });
    expect(() => monitor.waitForTerminal('unknown')).toThrow(WorkflowStateError);
  });

  it('resolves immediately if already terminal', async () => {
    const monitor = new DAGMonitor({ program });
    const def = makeDefinition([makeTemplate('a')]);
    const state = buildTestState(def);
    state.nodes.get('a')!.taskId = new Uint8Array(32);
    state.nodes.get('a')!.taskPda = Keypair.generate().publicKey;
    state.nodes.get('a')!.status = WorkflowNodeStatus.Completed;
    state.status = WorkflowStatus.Completed;

    monitor.startMonitoring(state, {}, true);
    const result = await monitor.waitForTerminal(state.id);
    expect(result.status).toBe(WorkflowStatus.Completed);
  });
});

// ============================================================================
// DAGOrchestrator Tests
// ============================================================================

describe('DAGOrchestrator', () => {
  let program: any;
  let agentId: Uint8Array;

  beforeEach(() => {
    ({ program } = makeMockProgram());
    agentId = new Uint8Array(32).fill(1);
  });

  it('validate() delegates to validateWorkflow', () => {
    const orch = new DAGOrchestrator({ program, agentId });
    expect(() => orch.validate(makeDefinition([]))).toThrow(WorkflowValidationError);
    expect(() => orch.validate(makeDefinition([makeTemplate('ok')]))).not.toThrow();
  });

  it('submit() creates tasks and returns Running state', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition(
      [makeTemplate('a'), makeTemplate('b')],
      [{ from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data }],
    );

    const state = await orch.submit(def);

    expect(state.status).toBe(WorkflowStatus.Running);
    expect(state.nodes.get('a')!.status).toBe(WorkflowNodeStatus.Created);
    expect(state.nodes.get('b')!.status).toBe(WorkflowNodeStatus.Created);
    expect(state.startedAt).toBeGreaterThan(0);
  });

  it('submit() fires onNodeCreated callbacks', async () => {
    const onNodeCreated = vi.fn();
    const orch = new DAGOrchestrator({ program, agentId, callbacks: { onNodeCreated } });
    const def = makeDefinition([makeTemplate('a')]);

    await orch.submit(def);

    expect(onNodeCreated).toHaveBeenCalledOnce();
    expect(onNodeCreated).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a', status: WorkflowNodeStatus.Created }),
    );
  });

  it('submit() rejects duplicate workflow ID', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition([makeTemplate('a')]);

    await orch.submit(def);
    await expect(orch.submit(def)).rejects.toThrow(WorkflowStateError);
    await expect(orch.submit(def)).rejects.toThrow('already exists');
  });

  it('getState() returns null for unknown workflow', () => {
    const orch = new DAGOrchestrator({ program, agentId });
    expect(orch.getState('nope')).toBeNull();
  });

  it('getState() returns submitted workflow', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition([makeTemplate('a')]);

    await orch.submit(def);
    const state = orch.getState('test-workflow');

    expect(state).not.toBeNull();
    expect(state!.id).toBe('test-workflow');
  });

  it('getStats() returns null for unknown workflow', () => {
    const orch = new DAGOrchestrator({ program, agentId });
    expect(orch.getStats('nope')).toBeNull();
  });

  it('getStats() returns correct counts', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition(
      [
        makeTemplate('a', { rewardAmount: 100n }),
        makeTemplate('b', { rewardAmount: 200n }),
      ],
      [{ from: 'a', to: 'b', dependencyType: OnChainDependencyType.Data }],
    );

    await orch.submit(def);
    const stats = orch.getStats('test-workflow')!;

    expect(stats.totalNodes).toBe(2);
    // Both are "created" (waiting for completion monitoring)
    expect(stats.created).toBe(2);
    expect(stats.completed).toBe(0);
    expect(stats.totalReward).toBe(300n);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('waitForCompletion() rejects for unknown workflow', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    await expect(orch.waitForCompletion('nope')).rejects.toThrow(WorkflowStateError);
  });

  it('shutdown() does not throw', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    await expect(orch.shutdown()).resolves.not.toThrow();
  });

  it('submit() marks workflow Failed on submission error', async () => {
    const { mockRpc } = makeMockProgram();
    mockRpc.mockRejectedValue(new Error('rpc boom'));
    // Use the program from makeMockProgram which has the failing rpc
    const failProgram = makeMockProgram();
    failProgram.mockRpc.mockRejectedValue(new Error('rpc boom'));

    const orch = new DAGOrchestrator({
      program: failProgram.program,
      agentId,
      maxRetries: 0,
    });
    const def = makeDefinition([makeTemplate('a')]);

    await expect(orch.submit(def)).rejects.toThrow(WorkflowSubmissionError);

    const state = orch.getState('test-workflow')!;
    expect(state.status).toBe(WorkflowStatus.Failed);
  });

  it('handles Proof dependency type correctly', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition(
      [makeTemplate('prover'), makeTemplate('verifier')],
      [{ from: 'prover', to: 'verifier', dependencyType: OnChainDependencyType.Proof }],
    );

    const state = await orch.submit(def);

    const verifier = state.nodes.get('verifier')!;
    expect(verifier.dependencyType).toBe(OnChainDependencyType.Proof);
    expect(verifier.parentName).toBe('prover');
  });

  it('handles all three dependency types in one workflow', async () => {
    const orch = new DAGOrchestrator({ program, agentId });
    const def = makeDefinition(
      [makeTemplate('root'), makeTemplate('data'), makeTemplate('order'), makeTemplate('proof')],
      [
        { from: 'root', to: 'data', dependencyType: OnChainDependencyType.Data },
        { from: 'root', to: 'order', dependencyType: OnChainDependencyType.Ordering },
        { from: 'root', to: 'proof', dependencyType: OnChainDependencyType.Proof },
      ],
    );

    const state = await orch.submit(def);

    expect(state.nodes.get('data')!.dependencyType).toBe(OnChainDependencyType.Data);
    expect(state.nodes.get('order')!.dependencyType).toBe(OnChainDependencyType.Ordering);
    expect(state.nodes.get('proof')!.dependencyType).toBe(OnChainDependencyType.Proof);
    expect(state.nodes.get('root')!.dependencyType).toBe(OnChainDependencyType.None);
  });
});

// ============================================================================
// Helper: Build test state from definition
// ============================================================================

function buildTestState(def: WorkflowDefinition): WorkflowState {
  const edgeByChild = new Map<string, { from: string; depType: OnChainDependencyType }>();
  for (const edge of def.edges) {
    edgeByChild.set(edge.to, { from: edge.from, depType: edge.dependencyType });
  }

  const nodes = new Map<string, import('./types.js').WorkflowNode>();
  for (const template of def.tasks) {
    const pe = edgeByChild.get(template.name);
    nodes.set(template.name, {
      name: template.name,
      template,
      taskId: null,
      taskPda: null,
      parentName: pe?.from ?? null,
      parentPda: null,
      dependencyType: pe?.depType ?? OnChainDependencyType.None,
      status: WorkflowNodeStatus.Pending,
      transactionSignature: null,
      error: null,
      createdAt: null,
      completedAt: null,
    });
  }

  return {
    id: def.id,
    definition: def,
    status: WorkflowStatus.Pending,
    nodes,
    startedAt: null,
    completedAt: null,
  };
}
