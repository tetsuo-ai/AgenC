import { describe, it, expect, vi } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { PROGRAM_ID } from '@agenc/sdk';
import { DAGOrchestrator } from './orchestrator.js';
import { GoalCompiler, type GoalPlanner } from './compiler.js';

function makeMockProgram() {
  const authority = Keypair.generate();
  const mockRpc = vi.fn().mockResolvedValue('mock-tx-sig');

  const methodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: mockRpc,
  };

  const program = {
    programId: PROGRAM_ID,
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

  return { program };
}

function makePlanner(): GoalPlanner {
  return {
    async plan() {
      return {
        tasks: [
          {
            name: 'root',
            description: 'Root planner task',
          },
        ],
      };
    },
  };
}

describe('DAGOrchestrator goal compiler integration', () => {
  it('compileGoal returns compiled definition without submitting', async () => {
    const { program } = makeMockProgram();
    const orchestrator = new DAGOrchestrator({
      program,
      agentId: new Uint8Array(32).fill(7),
    });
    const compiler = new GoalCompiler({
      planner: makePlanner(),
      now: () => 1_700_000_000_000,
    });

    const compiled = await orchestrator.compileGoal(
      { objective: 'Plan a single root task', workflowId: 'goal-compile-only' },
      compiler
    );

    expect(compiled.definition.id).toBe('goal-compile-only');
    expect(compiled.definition.tasks).toHaveLength(1);
    expect(program.methods.createTask).not.toHaveBeenCalled();
  });

  it('compileAndSubmitGoal compiles and submits through workflow pipeline', async () => {
    const { program } = makeMockProgram();
    const orchestrator = new DAGOrchestrator({
      program,
      agentId: new Uint8Array(32).fill(3),
    });
    const compiler = new GoalCompiler({
      planner: makePlanner(),
      now: () => 1_700_000_000_000,
    });

    const { compiled, state } = await orchestrator.compileAndSubmitGoal(
      { objective: 'Compile and submit', workflowId: 'goal-compile-submit' },
      compiler
    );

    expect(compiled.definition.id).toBe('goal-compile-submit');
    expect(state.id).toBe('goal-compile-submit');
    expect(program.methods.createTask).toHaveBeenCalledTimes(1);

    await orchestrator.shutdown();
  });
});
