import { describe, expect, it, vi } from 'vitest';
import { TeamContractEngine } from './engine.js';
import { TeamContractStateError, TeamWorkflowTopologyError } from './errors.js';
import { TeamWorkflowAdapter } from './workflow-adapter.js';
import { OnChainDependencyType, validateWorkflow } from '../workflow/index.js';
import type { TeamContractSnapshot, TeamTemplate } from './types.js';

function makeTemplate(): TeamTemplate {
  return {
    id: 'workflow-team',
    name: 'Workflow Team',
    roles: [
      { id: 'planner', requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
      { id: 'worker', requiredCapabilities: 2n, minMembers: 1, maxMembers: 1 },
      { id: 'reviewer', requiredCapabilities: 4n, minMembers: 1, maxMembers: 1 },
    ],
    checkpoints: [
      { id: 'plan', roleId: 'planner', label: 'Plan' },
      { id: 'build', roleId: 'worker', label: 'Build', dependsOn: ['plan'] },
      { id: 'review', roleId: 'reviewer', label: 'Review', dependsOn: ['build'] },
    ],
    payout: {
      mode: 'fixed',
      rolePayoutBps: {
        planner: 2_000,
        worker: 5_000,
        reviewer: 3_000,
      },
    },
  };
}

function buildActiveSnapshot(): TeamContractSnapshot {
  const engine = new TeamContractEngine();
  engine.createContract({ contractId: 'team-1', creatorId: 'creator', template: makeTemplate() });
  engine.joinContract({ contractId: 'team-1', member: { id: 'p1', capabilities: 1n, roles: ['planner'] } });
  engine.joinContract({ contractId: 'team-1', member: { id: 'w1', capabilities: 2n, roles: ['worker'] } });
  engine.joinContract({ contractId: 'team-1', member: { id: 'r1', capabilities: 4n, roles: ['reviewer'] } });
  return engine.startRun('team-1');
}

describe('TeamWorkflowAdapter', () => {
  it('builds canonical role-aware workflow definitions', () => {
    const adapter = new TeamWorkflowAdapter();
    const snapshot = buildActiveSnapshot();

    const built = adapter.build(snapshot, {
      workflowId: 'wf-team-1',
      dependencyType: OnChainDependencyType.Ordering,
      totalRewardLamports: 5n,
    });

    expect(built.definition.id).toBe('wf-team-1');
    expect(built.definition.tasks.map((task) => task.name)).toEqual(['build', 'plan', 'review']);
    expect(built.definition.tasks.map((task) => task.rewardAmount)).toEqual([2n, 2n, 1n]);
    expect(built.definition.edges).toEqual([
      { from: 'build', to: 'review', dependencyType: OnChainDependencyType.Ordering },
      { from: 'plan', to: 'build', dependencyType: OnChainDependencyType.Ordering },
    ]);

    expect(() => validateWorkflow(built.definition)).not.toThrow();
  });

  it('launches via injected submit callback', async () => {
    const adapter = new TeamWorkflowAdapter();
    const snapshot = buildActiveSnapshot();
    const submit = vi.fn().mockResolvedValue({ tx: 'sig-123' });

    const launched = await adapter.launch(snapshot, submit, {
      workflowId: 'wf-launch',
      totalRewardLamports: 3n,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(launched.definition);
    expect(launched.launchResult).toEqual({ tx: 'sig-123' });
  });

  it('rejects draft contracts', () => {
    const engine = new TeamContractEngine();
    engine.createContract({ contractId: 'draft-1', creatorId: 'creator', template: makeTemplate() });

    const draft = engine.getContract('draft-1')!;
    const adapter = new TeamWorkflowAdapter();

    expect(() => adapter.build(draft)).toThrow(TeamContractStateError);
  });

  it('rejects multi-parent checkpoint graphs', () => {
    const adapter = new TeamWorkflowAdapter();
    const snapshot = buildActiveSnapshot();

    const bad: TeamContractSnapshot = {
      ...snapshot,
      template: {
        ...snapshot.template,
        checkpoints: [
          { id: 'a', roleId: 'planner', label: 'a' },
          { id: 'b', roleId: 'worker', label: 'b' },
          { id: 'c', roleId: 'reviewer', label: 'c', dependsOn: ['a', 'b'] },
        ],
      },
      checkpoints: {
        a: { ...snapshot.checkpoints.plan, id: 'a', roleId: 'planner', dependsOn: [] },
        b: { ...snapshot.checkpoints.build, id: 'b', roleId: 'worker', dependsOn: [] },
        c: { ...snapshot.checkpoints.review, id: 'c', roleId: 'reviewer', dependsOn: ['a', 'b'] },
      },
    };

    expect(() => adapter.build(bad)).toThrow(TeamWorkflowTopologyError);
  });

  it('rejects cyclic checkpoint graphs', () => {
    const adapter = new TeamWorkflowAdapter();
    const snapshot = buildActiveSnapshot();

    const bad: TeamContractSnapshot = {
      ...snapshot,
      template: {
        ...snapshot.template,
        checkpoints: [
          { id: 'a', roleId: 'planner', label: 'a', dependsOn: ['b'] },
          { id: 'b', roleId: 'worker', label: 'b', dependsOn: ['a'] },
        ],
      },
      checkpoints: {
        a: { ...snapshot.checkpoints.plan, id: 'a', roleId: 'planner', dependsOn: ['b'] },
        b: { ...snapshot.checkpoints.build, id: 'b', roleId: 'worker', dependsOn: ['a'] },
      },
    };

    expect(() => adapter.build(bad)).toThrow(TeamWorkflowTopologyError);
  });

  it('rejects unknown dependencies and duplicate checkpoint ids', () => {
    const adapter = new TeamWorkflowAdapter();
    const snapshot = buildActiveSnapshot();

    const unknownDependency: TeamContractSnapshot = {
      ...snapshot,
      template: {
        ...snapshot.template,
        checkpoints: [
          { id: 'a', roleId: 'planner', label: 'a' },
          { id: 'b', roleId: 'worker', label: 'b', dependsOn: ['missing'] },
        ],
      },
      checkpoints: {
        a: { ...snapshot.checkpoints.plan, id: 'a', roleId: 'planner', dependsOn: [] },
        b: { ...snapshot.checkpoints.build, id: 'b', roleId: 'worker', dependsOn: ['missing'] },
      },
    };

    expect(() => adapter.build(unknownDependency)).toThrow(TeamWorkflowTopologyError);

    const duplicateIds: TeamContractSnapshot = {
      ...snapshot,
      template: {
        ...snapshot.template,
        checkpoints: [
          { id: 'dup', roleId: 'planner', label: 'dup-a' },
          { id: 'dup', roleId: 'worker', label: 'dup-b' },
        ],
      },
      checkpoints: {
        dup: { ...snapshot.checkpoints.plan, id: 'dup', roleId: 'planner', dependsOn: [] },
      },
    };

    expect(() => adapter.build(duplicateIds)).toThrow(TeamWorkflowTopologyError);
  });

  it('keeps existing non-team workflow validation path unchanged', () => {
    const definition = {
      id: 'legacy-workflow',
      tasks: [
        {
          name: 'root',
          requiredCapabilities: 1n,
          description: new Uint8Array(64),
          rewardAmount: 100n,
          maxWorkers: 1,
          deadline: 0,
          taskType: 0,
        },
        {
          name: 'child',
          requiredCapabilities: 1n,
          description: new Uint8Array(64),
          rewardAmount: 0n,
          maxWorkers: 1,
          deadline: 0,
          taskType: 0,
        },
      ],
      edges: [
        { from: 'root', to: 'child', dependencyType: OnChainDependencyType.Ordering },
      ],
    };

    expect(() => validateWorkflow(definition)).not.toThrow();
  });
});
