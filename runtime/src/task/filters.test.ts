import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TaskType } from '../events/types.js';
import {
  OnChainTaskStatus,
  isPrivateTask,
  type OnChainTask,
  type DiscoveredTask,
  type TaskFilterConfig,
} from './types.js';
import {
  matchesFilter,
  hasRequiredCapabilities,
  defaultTaskScorer,
  rankTasks,
  filterAndRank,
} from './filters.js';
import { createTask } from './test-utils.js';

/** Capability constants for tests */
const COMPUTE = 1n << 0n;
const INFERENCE = 1n << 1n;
const STORAGE = 1n << 2n;

function toDiscoveredTask(task: OnChainTask): DiscoveredTask {
  return { task, relevanceScore: 0, canClaim: true };
}

describe('hasRequiredCapabilities', () => {
  it('returns true when agent has all required capabilities', () => {
    const agentCaps = COMPUTE | INFERENCE;
    expect(hasRequiredCapabilities(agentCaps, COMPUTE)).toBe(true);
    expect(hasRequiredCapabilities(agentCaps, INFERENCE)).toBe(true);
    expect(hasRequiredCapabilities(agentCaps, COMPUTE | INFERENCE)).toBe(true);
  });

  it('returns false when agent lacks required capability', () => {
    const agentCaps = COMPUTE;
    expect(hasRequiredCapabilities(agentCaps, INFERENCE)).toBe(false);
    expect(hasRequiredCapabilities(agentCaps, COMPUTE | INFERENCE)).toBe(false);
  });

  it('returns true when no capabilities required', () => {
    expect(hasRequiredCapabilities(COMPUTE, 0n)).toBe(true);
    expect(hasRequiredCapabilities(0n, 0n)).toBe(true);
  });

  it('returns true when agent has superset of required capabilities', () => {
    const agentCaps = COMPUTE | INFERENCE | STORAGE;
    expect(hasRequiredCapabilities(agentCaps, COMPUTE)).toBe(true);
    expect(hasRequiredCapabilities(agentCaps, COMPUTE | INFERENCE)).toBe(true);
  });

  it('handles full bitmask (all capabilities set)', () => {
    const allCaps = (1n << 10n) - 1n; // All 10 capabilities
    expect(hasRequiredCapabilities(allCaps, COMPUTE)).toBe(true);
    expect(hasRequiredCapabilities(allCaps, allCaps)).toBe(true);
    expect(hasRequiredCapabilities(COMPUTE, allCaps)).toBe(false);
  });
});

describe('matchesFilter', () => {
  const agentCaps = COMPUTE | INFERENCE;
  const emptyFilter: TaskFilterConfig = {};

  it('happy path: task passes all filters', () => {
    const task = createTask();
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(true);
  });

  it('rejects Completed tasks', () => {
    const task = createTask({ status: OnChainTaskStatus.Completed });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(false);
  });

  it('rejects Cancelled tasks', () => {
    const task = createTask({ status: OnChainTaskStatus.Cancelled });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(false);
  });

  it('rejects Disputed tasks', () => {
    const task = createTask({ status: OnChainTaskStatus.Disputed });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(false);
  });

  it('accepts InProgress tasks', () => {
    const task = createTask({ status: OnChainTaskStatus.InProgress });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(true);
  });

  it('rejects task when agent lacks required capabilities', () => {
    const task = createTask({ requiredCapabilities: STORAGE });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(false);
  });

  it('rejects task when slots are full', () => {
    const task = createTask({ maxWorkers: 3, currentWorkers: 3 });
    expect(matchesFilter(task, agentCaps, emptyFilter)).toBe(false);
  });

  it('rejects task below minRewardLamports', () => {
    const task = createTask({ rewardAmount: 500_000n });
    const filter: TaskFilterConfig = { minRewardLamports: 1_000_000n };
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('accepts task at exactly minRewardLamports', () => {
    const task = createTask({ rewardAmount: 1_000_000n });
    const filter: TaskFilterConfig = { minRewardLamports: 1_000_000n };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('rejects task above maxRewardLamports', () => {
    const task = createTask({ rewardAmount: 5_000_000n });
    const filter: TaskFilterConfig = { maxRewardLamports: 2_000_000n };
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('accepts task at exactly maxRewardLamports', () => {
    const task = createTask({ rewardAmount: 2_000_000n });
    const filter: TaskFilterConfig = { maxRewardLamports: 2_000_000n };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('rejects task with wrong task type', () => {
    const task = createTask({ taskType: TaskType.Collaborative });
    const filter: TaskFilterConfig = { taskTypes: [TaskType.Exclusive] };
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('accepts task matching one of multiple task types', () => {
    const task = createTask({ taskType: TaskType.Collaborative });
    const filter: TaskFilterConfig = {
      taskTypes: [TaskType.Exclusive, TaskType.Collaborative],
    };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('passes when taskTypes is empty array', () => {
    const task = createTask();
    const filter: TaskFilterConfig = { taskTypes: [] };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('rejects task without sufficient deadline buffer', () => {
    const now = Math.floor(Date.now() / 1000);
    const task = createTask({ deadline: now + 300 }); // 5 min remaining
    const filter: TaskFilterConfig = { minDeadlineBufferSeconds: 600 }; // Need 10 min
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('accepts task with sufficient deadline buffer', () => {
    const now = Math.floor(Date.now() / 1000);
    const task = createTask({ deadline: now + 3600 }); // 1 hour remaining
    const filter: TaskFilterConfig = { minDeadlineBufferSeconds: 600 }; // Need 10 min
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('skips deadline buffer check for tasks with no deadline', () => {
    const task = createTask({ deadline: 0 });
    const filter: TaskFilterConfig = { minDeadlineBufferSeconds: 3600 };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('privateOnly rejects public tasks', () => {
    const task = createTask({ constraintHash: new Uint8Array(32) }); // all zeros = public
    const filter: TaskFilterConfig = { privateOnly: true };
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('privateOnly accepts private tasks', () => {
    const constraintHash = new Uint8Array(32);
    constraintHash[0] = 1;
    const task = createTask({ constraintHash });
    const filter: TaskFilterConfig = { privateOnly: true };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('publicOnly rejects private tasks', () => {
    const constraintHash = new Uint8Array(32);
    constraintHash[0] = 1;
    const task = createTask({ constraintHash });
    const filter: TaskFilterConfig = { publicOnly: true };
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('publicOnly accepts public tasks', () => {
    const task = createTask({ constraintHash: new Uint8Array(32) });
    const filter: TaskFilterConfig = { publicOnly: true };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('custom filter is called and respected', () => {
    const task = createTask();
    const filter: TaskFilterConfig = {
      customFilter: (dt) => dt.task.rewardAmount > 2_000_000n,
    };
    // 1_000_000 < 2_000_000 — should fail
    expect(matchesFilter(task, agentCaps, filter)).toBe(false);
  });

  it('custom filter passes when returning true', () => {
    const task = createTask({ rewardAmount: 5_000_000n });
    const filter: TaskFilterConfig = {
      customFilter: (dt) => dt.task.rewardAmount > 2_000_000n,
    };
    expect(matchesFilter(task, agentCaps, filter)).toBe(true);
  });

  it('no filters configured accepts all claimable tasks', () => {
    const task = createTask();
    expect(matchesFilter(task, agentCaps, {})).toBe(true);
  });
});

describe('defaultTaskScorer', () => {
  it('scores higher for higher reward', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 3600;

    const lowReward = toDiscoveredTask(createTask({ rewardAmount: 1_000n, deadline }));
    const highReward = toDiscoveredTask(createTask({ rewardAmount: 10_000n, deadline }));

    expect(defaultTaskScorer(highReward)).toBeGreaterThan(defaultTaskScorer(lowReward));
  });

  it('scores higher for more urgent tasks', () => {
    const now = Math.floor(Date.now() / 1000);

    const soon = toDiscoveredTask(createTask({ rewardAmount: 1_000_000n, deadline: now + 60 }));
    const later = toDiscoveredTask(createTask({ rewardAmount: 1_000_000n, deadline: now + 86400 }));

    expect(defaultTaskScorer(soon)).toBeGreaterThan(defaultTaskScorer(later));
  });

  it('uses 86400 default for tasks with no deadline', () => {
    const task = toDiscoveredTask(createTask({ rewardAmount: 86400n, deadline: 0 }));
    const score = defaultTaskScorer(task);
    // 86400 / 86400 = 1
    expect(score).toBeCloseTo(1, 1);
  });

  it('handles past-deadline edge case', () => {
    const now = Math.floor(Date.now() / 1000);
    const task = toDiscoveredTask(createTask({ rewardAmount: 1_000n, deadline: now - 100 }));
    const score = defaultTaskScorer(task);
    // timeRemaining is negative, Math.max(1, negative) = 1
    expect(score).toBe(1000);
  });
});

describe('rankTasks', () => {
  it('returns new array in descending score order', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 3600;

    const tasks: DiscoveredTask[] = [
      toDiscoveredTask(createTask({ rewardAmount: 1_000n, deadline })),
      toDiscoveredTask(createTask({ rewardAmount: 10_000n, deadline })),
      toDiscoveredTask(createTask({ rewardAmount: 5_000n, deadline })),
    ];

    const ranked = rankTasks(tasks);

    expect(ranked.length).toBe(3);
    expect(ranked[0].task.rewardAmount).toBe(10_000n);
    expect(ranked[1].task.rewardAmount).toBe(5_000n);
    expect(ranked[2].task.rewardAmount).toBe(1_000n);
  });

  it('does not mutate the input array', () => {
    const tasks: DiscoveredTask[] = [
      toDiscoveredTask(createTask({ rewardAmount: 1_000n })),
      toDiscoveredTask(createTask({ rewardAmount: 10_000n })),
    ];

    const originalFirst = tasks[0];
    rankTasks(tasks);

    expect(tasks[0]).toBe(originalFirst);
    expect(tasks.length).toBe(2);
  });

  it('updates relevanceScore on ranked results', () => {
    const tasks: DiscoveredTask[] = [
      toDiscoveredTask(createTask({ rewardAmount: 1_000_000n })),
    ];

    const ranked = rankTasks(tasks);

    expect(ranked[0].relevanceScore).toBeGreaterThan(0);
  });

  it('accepts custom scorer', () => {
    const tasks: DiscoveredTask[] = [
      toDiscoveredTask(createTask({ rewardAmount: 1_000n, maxWorkers: 10 })),
      toDiscoveredTask(createTask({ rewardAmount: 10_000n, maxWorkers: 1 })),
    ];

    // Score by maxWorkers instead of reward
    const ranked = rankTasks(tasks, (dt) => dt.task.maxWorkers);

    expect(ranked[0].task.maxWorkers).toBe(10);
    expect(ranked[1].task.maxWorkers).toBe(1);
  });

  it('handles empty array', () => {
    const ranked = rankTasks([]);
    expect(ranked).toEqual([]);
  });

  it('handles single task', () => {
    const tasks: DiscoveredTask[] = [
      toDiscoveredTask(createTask({ rewardAmount: 5_000n })),
    ];
    const ranked = rankTasks(tasks);
    expect(ranked.length).toBe(1);
    expect(ranked[0].relevanceScore).toBeGreaterThan(0);
  });
});

describe('filterAndRank', () => {
  const agentCaps = COMPUTE | INFERENCE;

  it('filters then ranks correctly', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 3600;

    const tasks: OnChainTask[] = [
      createTask({ rewardAmount: 1_000n, deadline }),
      createTask({ rewardAmount: 10_000n, deadline }),
      createTask({ rewardAmount: 5_000n, deadline, status: OnChainTaskStatus.Completed }), // should be filtered out
    ];

    const result = filterAndRank(tasks, agentCaps, {});

    expect(result.length).toBe(2);
    expect(result[0].task.rewardAmount).toBe(10_000n);
    expect(result[1].task.rewardAmount).toBe(1_000n);
  });

  it('produces same results as filter then rank separately', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 3600;

    const tasks: OnChainTask[] = [
      createTask({ rewardAmount: 3_000n, deadline }),
      createTask({ rewardAmount: 1_000n, deadline }),
      createTask({ rewardAmount: 5_000n, deadline }),
    ];

    const filter: TaskFilterConfig = { minRewardLamports: 2_000n };

    // Using filterAndRank
    const combined = filterAndRank(tasks, agentCaps, filter);

    // Manual filter + rank
    const filtered = tasks
      .filter((t) => matchesFilter(t, agentCaps, filter))
      .map((task) => toDiscoveredTask(task));
    const separate = rankTasks(filtered);

    expect(combined.length).toBe(separate.length);
    for (let i = 0; i < combined.length; i++) {
      expect(combined[i].task.rewardAmount).toBe(separate[i].task.rewardAmount);
    }
  });

  it('returns empty array when all tasks filtered out', () => {
    const tasks: OnChainTask[] = [
      createTask({ requiredCapabilities: STORAGE }), // agent lacks STORAGE
    ];

    const result = filterAndRank(tasks, agentCaps, {});

    expect(result).toEqual([]);
  });

  it('accepts custom scorer', () => {
    const tasks: OnChainTask[] = [
      createTask({ rewardAmount: 1_000n, maxWorkers: 10 }),
      createTask({ rewardAmount: 10_000n, maxWorkers: 1 }),
    ];

    const result = filterAndRank(tasks, agentCaps, {}, (dt) => dt.task.maxWorkers);

    expect(result[0].task.maxWorkers).toBe(10);
  });
});
