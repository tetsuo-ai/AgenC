import { describe, expect, it, vi } from 'vitest';
import { generateExecutionCandidates } from './candidate-generator.js';
import { createTask as makeTask } from './test-utils.js';

describe('generateExecutionCandidates', () => {
  it('enforces candidate/cost/token policy ceilings', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([1n])
      .mockResolvedValueOnce([2n])
      .mockResolvedValueOnce([3n])
      .mockResolvedValueOnce([4n]);

    const result = await generateExecutionCandidates({
      task: makeTask(),
      config: {
        enabled: true,
        maxCandidates: 4,
        maxGenerationAttempts: 6,
        policyBudget: {
          maxCandidates: 3,
          maxExecutionCostLamports: 300n,
          maxTokenBudget: 48,
        },
      },
      executeCandidate: execute,
      estimateTokenUnits: () => 16,
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.budget.maxCandidates).toBe(3);
    expect(result.budget.maxExecutionCostLamports).toBe(300n);
    expect(result.budget.maxTokenBudget).toBe(48);
    expect(result.budget.consumedCostLamports).toBe(300n);
    expect(result.budget.consumedTokenUnits).toBe(48);
    expect(result.budget.stoppedReason).toBe('target_reached');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('applies diversity threshold and continues attempts until a novel candidate appears', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([11n])
      .mockResolvedValueOnce([11n])
      .mockResolvedValueOnce([22n]);

    const result = await generateExecutionCandidates({
      task: makeTask(),
      config: {
        enabled: true,
        maxCandidates: 2,
        maxGenerationAttempts: 3,
        minDiversityScore: 0.5,
      },
      executeCandidate: execute,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.output).toEqual([11n]);
    expect(result.candidates[1]!.output).toEqual([22n]);
    expect(result.budget.attempts).toBe(3);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('provides attempt context to policy hooks', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([1n])
      .mockResolvedValueOnce([2n]);
    const onBeforeAttempt = vi.fn();

    await generateExecutionCandidates({
      task: makeTask(),
      config: {
        enabled: true,
        maxCandidates: 2,
      },
      executeCandidate: execute,
      onBeforeAttempt,
    });

    expect(onBeforeAttempt).toHaveBeenCalledTimes(2);
    expect(onBeforeAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attempt: 1,
        projectedCostLamports: 100n,
      }),
    );
    expect(onBeforeAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        projectedCostLamports: 200n,
      }),
    );
  });
});
