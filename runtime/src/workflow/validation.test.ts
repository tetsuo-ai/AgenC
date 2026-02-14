import { describe, expect, it } from 'vitest';
import { Capability } from '../agent/capabilities.js';
import { computeWorkflowPlanHash } from './compiler.js';
import {
  OnChainDependencyType,
  type TaskTemplate,
  type WorkflowDefinition,
} from './types.js';
import { topologicalSort } from './validation.js';

function makeTemplate(name: string): TaskTemplate {
  return {
    name,
    description: new Uint8Array(64),
    requiredCapabilities: Capability.COMPUTE,
    rewardAmount: 100n,
    maxWorkers: 1,
    deadline: 1000,
    taskType: 0,
    minReputation: 0,
  };
}

describe('topologicalSort determinism', () => {
  const treeDefinition: WorkflowDefinition = {
    id: 'tree-determinism',
    tasks: [
      makeTemplate('z_root'),
      makeTemplate('m_child'),
      makeTemplate('a_child'),
      makeTemplate('b_leaf'),
    ],
    edges: [
      {
        from: 'z_root',
        to: 'm_child',
        dependencyType: OnChainDependencyType.Ordering,
      },
      {
        from: 'z_root',
        to: 'a_child',
        dependencyType: OnChainDependencyType.Data,
      },
      {
        from: 'a_child',
        to: 'b_leaf',
        dependencyType: OnChainDependencyType.Data,
      },
    ],
  };

  it('returns identical order across repeated invocations', () => {
    const golden = topologicalSort(treeDefinition);
    for (let i = 0; i < 100; i += 1) {
      expect(topologicalSort(treeDefinition)).toEqual(golden);
    }
  });

  it('orders same-depth siblings lexicographically', () => {
    const result = topologicalSort(treeDefinition);
    const aIndex = result.indexOf('a_child');
    const mIndex = result.indexOf('m_child');
    const bIndex = result.indexOf('b_leaf');

    expect(result[0]).toBe('z_root');
    expect(aIndex).toBeGreaterThan(0);
    expect(mIndex).toBeGreaterThan(0);
    expect(aIndex).toBeLessThan(mIndex);
    expect(bIndex).toBeGreaterThan(aIndex);
  });

  it('produces same result for equivalent definitions with different array ordering', () => {
    const reordered: WorkflowDefinition = {
      id: 'tree-determinism',
      tasks: [
        makeTemplate('a_child'),
        makeTemplate('b_leaf'),
        makeTemplate('z_root'),
        makeTemplate('m_child'),
      ],
      edges: [
        {
          from: 'a_child',
          to: 'b_leaf',
          dependencyType: OnChainDependencyType.Data,
        },
        {
          from: 'z_root',
          to: 'a_child',
          dependencyType: OnChainDependencyType.Data,
        },
        {
          from: 'z_root',
          to: 'm_child',
          dependencyType: OnChainDependencyType.Ordering,
        },
      ],
    };

    expect(topologicalSort(reordered)).toEqual(topologicalSort(treeDefinition));
  });

  it('computes a stable workflow plan hash for the same definition', () => {
    const hash1 = computeWorkflowPlanHash(treeDefinition);
    const hash2 = computeWorkflowPlanHash(treeDefinition);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles a single-node workflow deterministically', () => {
    const single: WorkflowDefinition = {
      id: 'single',
      tasks: [makeTemplate('only')],
      edges: [],
    };

    expect(topologicalSort(single)).toEqual(['only']);
  });
});
