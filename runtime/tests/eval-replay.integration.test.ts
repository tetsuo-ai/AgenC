import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { AutonomousAgent } from '../src/autonomous/agent.js';
import { TaskStatus, type Task } from '../src/autonomous/types.js';
import { TrajectoryRecorder } from '../src/eval/recorder.js';
import { TrajectoryReplayEngine } from '../src/eval/replay.js';
import {
  createRuntimeTestContext,
  initializeProtocol,
  type RuntimeTestContext,
} from './litesvm-setup.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    pda: Keypair.generate().publicKey,
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 1n,
    reward: 100n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
    rewardMint: null,
    ...overrides,
  };
}

describe('eval replay integration (LiteSVM)', () => {
  let ctx: RuntimeTestContext;

  beforeAll(async () => {
    ctx = createRuntimeTestContext();
    await initializeProtocol(ctx);
  });

  it('captures lifecycle trajectory and replays deterministically', async () => {
    const recorder = new TrajectoryRecorder({
      traceId: 'integration-trace-1',
      seed: 321,
    });

    const agent = new AutonomousAgent({
      connection: ctx.connection,
      wallet: ctx.payer,
      capabilities: 1n,
      executor: {
        execute: async () => [1n],
      },
      trajectoryRecorder: recorder,
    });

    const task = createTask();
    const agentAny = agent as any;

    // Capture through existing autonomous journaling hooks.
    agentAny.handleDiscoveredTask(task);
    await agentAny.journalEvent(task, 'claimed', { claimTx: 'claim-1' });
    await agentAny.journalEvent(task, 'executed', {
      outputLength: 1,
      verifier: null,
    });
    await agentAny.journalEvent(task, 'completed', {
      completionTx: 'complete-1',
      durationMs: 55,
      reward: '100',
    });

    const trace = recorder.createTrace();
    const engine = new TrajectoryReplayEngine({ strictMode: true, seed: 321 });

    const first = engine.replay(trace);
    const second = engine.replay(trace);

    expect(first.deterministicHash).toBe(second.deterministicHash);
    expect(first.summary.completedTasks).toBe(1);
    expect(first.tasks[task.pda.toBase58()].status).toBe('completed');
    expect(first.errors).toHaveLength(0);
  });

  it('replays failure paths for verifier escalation, policy denial, and speculation abort', async () => {
    const recorder = new TrajectoryRecorder({
      traceId: 'integration-trace-failure',
      seed: 654,
    });

    const agent = new AutonomousAgent({
      connection: ctx.connection,
      wallet: ctx.payer,
      capabilities: 1n,
      executor: {
        execute: async () => [1n],
      },
      trajectoryRecorder: recorder,
    });

    const task = createTask();
    const agentAny = agent as any;

    await agentAny.journalEvent(task, 'claimed', { claimTx: 'claim-fail' });
    await agentAny.journalEvent(task, 'policy_violation', {
      violation: { code: 'risk_threshold_exceeded' },
      mode: 'safe_mode',
    });
    agentAny.recordTrajectoryByPda(task.pda, 'speculation_aborted', { reason: 'parent_failed' });
    await agentAny.journalEvent(task, 'escalated', {
      escalation: { reason: 'verifier_failed', attempts: 1, revisions: 0, durationMs: 100 },
      verifierHistory: [],
    });

    const trace = recorder.createTrace();
    const replay = new TrajectoryReplayEngine({ strictMode: false, seed: 654 }).replay(trace);

    expect(replay.summary.policyViolations).toBe(1);
    expect(replay.summary.speculationAborts).toBe(1);
    expect(replay.summary.escalatedTasks).toBe(1);
    expect(replay.tasks[task.pda.toBase58()].status).toBe('escalated');
  });
});
