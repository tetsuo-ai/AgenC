import { describe, expect, it } from 'vitest';
import { computeTeamPayout } from './payout.js';
import type { TeamCheckpointState, TeamTemplate } from './types.js';

function checkpoint(
  id: string,
  roleId: string,
  status: TeamCheckpointState['status'],
  completedBy: string | null,
): TeamCheckpointState {
  return {
    id,
    roleId,
    label: id,
    dependsOn: [],
    required: true,
    status,
    completedBy,
    completedAt: completedBy ? 1 : null,
    outputDigest: null,
    failedBy: status === 'failed' ? completedBy : null,
    failedAt: status === 'failed' ? 1 : null,
    failureReason: status === 'failed' ? 'failed' : null,
  };
}

describe('computeTeamPayout', () => {
  it('computes fixed splits with partial-failure penalties and redistribution', () => {
    const template: TeamTemplate = {
      id: 'team-fixed',
      name: 'Fixed',
      roles: [
        { id: 'planner', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
        { id: 'worker', requiredCapabilities: 2n, minMembers: 1, maxMembers: 1 },
        { id: 'reviewer', requiredCapabilities: 4n, minMembers: 1, maxMembers: 1 },
      ],
      checkpoints: [
        { id: 'plan', roleId: 'planner', label: 'plan' },
        { id: 'build', roleId: 'worker', label: 'build' },
        { id: 'review', roleId: 'reviewer', label: 'review' },
      ],
      payout: {
        mode: 'fixed',
        rolePayoutBps: {
          planner: 2_000,
          worker: 5_000,
          reviewer: 3_000,
        },
        roleFailurePenaltyBps: {
          worker: 5_000,
        },
      },
    };

    const result = computeTeamPayout({
      totalRewardLamports: 1_000n,
      template,
      checkpoints: {
        plan: checkpoint('plan', 'planner', 'completed', 'planner-1'),
        build: checkpoint('build', 'worker', 'failed', 'worker-1'),
        review: checkpoint('review', 'reviewer', 'completed', 'reviewer-1'),
      },
      roleAssignments: {
        planner: ['planner-1'],
        worker: ['worker-1'],
        reviewer: ['reviewer-1'],
      },
    });

    expect(result.rolePayouts.planner).toBe(300n);
    expect(result.rolePayouts.worker).toBe(250n);
    expect(result.rolePayouts.reviewer).toBe(450n);
    expect(result.rolePenalties.worker).toBe(250n);
    expect(result.redistributedLamports).toBe(250n);
    expect(result.unallocatedLamports).toBe(0n);
    expect(result.memberPayouts['planner-1']).toBe(300n);
    expect(result.memberPayouts['worker-1']).toBe(250n);
    expect(result.memberPayouts['reviewer-1']).toBe(450n);
  });

  it('uses deterministic tie-break ordering for weighted remainders', () => {
    const template: TeamTemplate = {
      id: 'team-weighted',
      name: 'Weighted',
      roles: [
        { id: 'alpha', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
        { id: 'beta', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
        { id: 'gamma', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
      ],
      checkpoints: [
        { id: 'a', roleId: 'alpha', label: 'a' },
      ],
      payout: {
        mode: 'weighted',
        roleWeights: {
          alpha: 1,
          beta: 1,
          gamma: 1,
        },
      },
    };

    const result = computeTeamPayout({
      totalRewardLamports: 10n,
      template,
      checkpoints: {
        a: checkpoint('a', 'alpha', 'completed', 'alpha-1'),
      },
      roleAssignments: {
        alpha: ['alpha-1'],
        beta: ['beta-1'],
        gamma: ['gamma-1'],
      },
    });

    expect(result.rolePayouts.alpha).toBe(4n);
    expect(result.rolePayouts.beta).toBe(3n);
    expect(result.rolePayouts.gamma).toBe(3n);
  });

  it('supports milestone payouts with explicit unallocated remainder', () => {
    const template: TeamTemplate = {
      id: 'team-milestone',
      name: 'Milestone',
      roles: [
        { id: 'planner', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
        { id: 'worker', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
      ],
      checkpoints: [
        { id: 'm1', roleId: 'planner', label: 'm1' },
        { id: 'm2', roleId: 'worker', label: 'm2' },
        { id: 'm3', roleId: 'worker', label: 'm3' },
      ],
      payout: {
        mode: 'milestone',
        milestonePayoutBps: {
          m1: 3_000,
          m2: 2_000,
        },
      },
    };

    const result = computeTeamPayout({
      totalRewardLamports: 1_000n,
      template,
      checkpoints: {
        m1: checkpoint('m1', 'planner', 'completed', 'planner-1'),
        m2: checkpoint('m2', 'worker', 'completed', 'worker-1'),
        m3: checkpoint('m3', 'worker', 'pending', null),
      },
      roleAssignments: {
        planner: ['planner-1'],
        worker: ['worker-1'],
      },
    });

    expect(result.rolePayouts.planner).toBe(300n);
    expect(result.rolePayouts.worker).toBe(200n);
    expect(result.unallocatedLamports).toBe(500n);
  });

  it('uses checkpoint contribution weights within a role', () => {
    const template: TeamTemplate = {
      id: 'team-contrib',
      name: 'Contrib',
      roles: [
        { id: 'worker', requiredCapabilities: 1n, minMembers: 1, maxMembers: 2 },
      ],
      checkpoints: [
        { id: 'c1', roleId: 'worker', label: 'c1' },
        { id: 'c2', roleId: 'worker', label: 'c2' },
        { id: 'c3', roleId: 'worker', label: 'c3' },
      ],
      payout: {
        mode: 'fixed',
        rolePayoutBps: { worker: 10_000 },
      },
    };

    const result = computeTeamPayout({
      totalRewardLamports: 100n,
      template,
      checkpoints: {
        c1: checkpoint('c1', 'worker', 'completed', 'w1'),
        c2: checkpoint('c2', 'worker', 'completed', 'w1'),
        c3: checkpoint('c3', 'worker', 'completed', 'w2'),
      },
      roleAssignments: {
        worker: ['w1', 'w2'],
      },
    });

    expect(result.memberPayouts.w1).toBe(67n);
    expect(result.memberPayouts.w2).toBe(33n);
  });

  it('rejects invalid payout configurations', () => {
    const badFixed: TeamTemplate = {
      id: 'bad-fixed',
      name: 'Bad Fixed',
      roles: [{ id: 'r', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 }],
      checkpoints: [{ id: 'c', roleId: 'r', label: 'c' }],
      payout: {
        mode: 'fixed',
        rolePayoutBps: { r: 9_999 },
      },
    };

    expect(() =>
      computeTeamPayout({
        totalRewardLamports: 1n,
        template: badFixed,
        checkpoints: { c: checkpoint('c', 'r', 'completed', 'm') },
        roleAssignments: { r: ['m'] },
      }),
    ).toThrow('sum to 10000');

    const badWeighted: TeamTemplate = {
      id: 'bad-weighted',
      name: 'Bad Weighted',
      roles: [{ id: 'r', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 }],
      checkpoints: [{ id: 'c', roleId: 'r', label: 'c' }],
      payout: {
        mode: 'weighted',
        roleWeights: { r: 0 },
      },
    };

    expect(() =>
      computeTeamPayout({
        totalRewardLamports: 1n,
        template: badWeighted,
        checkpoints: { c: checkpoint('c', 'r', 'completed', 'm') },
        roleAssignments: { r: ['m'] },
      }),
    ).toThrow('requires at least one positive role weight');
  });
});
