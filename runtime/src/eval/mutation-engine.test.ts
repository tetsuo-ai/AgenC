import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUTATION_OPERATOR_IDS,
  MutationEngine,
} from './mutation-engine.js';

function baseTrace(): unknown {
  return {
    schemaVersion: 1,
    traceId: 'fixture-trace',
    seed: 7,
    createdAtMs: 1700000000000,
    events: [
      {
        seq: 1,
        type: 'discovered',
        taskPda: 'task-1',
        timestampMs: 1700000000001,
        payload: {},
      },
      {
        seq: 2,
        type: 'claimed',
        taskPda: 'task-1',
        timestampMs: 1700000000002,
        payload: { claimTx: 'claim-1' },
      },
      {
        seq: 3,
        type: 'verifier_verdict',
        taskPda: 'task-1',
        timestampMs: 1700000000003,
        payload: { attempt: 1, verdict: 'pass', confidence: 0.93 },
      },
      {
        seq: 4,
        type: 'executed',
        taskPda: 'task-1',
        timestampMs: 1700000000004,
        payload: { outputLength: 1 },
      },
      {
        seq: 5,
        type: 'completed',
        taskPda: 'task-1',
        timestampMs: 1700000000030,
        payload: { completionTx: 'complete-1', durationMs: 26 },
      },
    ],
  };
}

describe('MutationEngine', () => {
  it('generates deterministic mutation candidates from default operators', () => {
    const engine = new MutationEngine();
    const context = {
      scenarioId: 'baseline',
      seed: 11,
      mutationSeed: 22,
    };

    const first = engine.createMutations(baseTrace(), context);
    const second = engine.createMutations(baseTrace(), context);

    expect(first.map((candidate) => candidate.operatorId)).toEqual(
      [...DEFAULT_MUTATION_OPERATOR_IDS].sort((left, right) => left.localeCompare(right)),
    );
    expect(first.map((candidate) => candidate.deterministicHash)).toEqual(
      second.map((candidate) => candidate.deterministicHash),
    );
    expect(first.map((candidate) => candidate.trace.traceId)).toEqual(
      second.map((candidate) => candidate.trace.traceId),
    );
  });

  it('supports operator filtering and max mutations per scenario', () => {
    const engine = new MutationEngine();
    const candidates = engine.createMutations(baseTrace(), {
      scenarioId: 'baseline',
      seed: 1,
      mutationSeed: 2,
    }, {
      operatorIds: ['tool.inject_failure'],
      maxMutationsPerScenario: 1,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operatorId).toBe('tool.inject_failure');
  });

  it('returns no mutations when trace does not match operator requirements', () => {
    const engine = new MutationEngine();
    const candidates = engine.createMutations({
      schemaVersion: 1,
      traceId: 'minimal',
      seed: 0,
      createdAtMs: 10,
      events: [
        {
          seq: 1,
          type: 'discovered',
          taskPda: 'task',
          timestampMs: 11,
          payload: {},
        },
      ],
    }, {
      scenarioId: 'minimal',
      seed: 0,
      mutationSeed: 3,
    });

    expect(candidates).toHaveLength(0);
  });

  it('applies workflow/tool/verifier mutations with expected perturbations', () => {
    const engine = new MutationEngine();
    const candidates = engine.createMutations(baseTrace(), {
      scenarioId: 'baseline',
      seed: 5,
      mutationSeed: 99,
    });

    const workflow = candidates.find((candidate) => candidate.operatorId === 'workflow.drop_completion');
    const tool = candidates.find((candidate) => candidate.operatorId === 'tool.inject_failure');
    const verifier = candidates.find((candidate) => candidate.operatorId === 'verifier.flip_verdict');

    expect(workflow).toBeDefined();
    expect(workflow?.trace.events.some((event) => event.type === 'failed')).toBe(true);

    expect(tool).toBeDefined();
    expect(tool?.trace.events.some((event) => event.type === 'policy_violation')).toBe(true);

    expect(verifier).toBeDefined();
    const verdictEvent = verifier?.trace.events.find((event) => event.type === 'verifier_verdict');
    expect(verdictEvent?.payload.verdict).toBe('fail');
  });
});

