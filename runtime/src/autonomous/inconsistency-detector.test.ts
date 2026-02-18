import { describe, expect, it } from 'vitest';
import { InMemoryBackend } from '../memory/in-memory/backend.js';
import { MemoryGraph } from '../memory/graph.js';
import type { GeneratedExecutionCandidate } from './candidate-generator.js';
import { detectCandidateInconsistencies } from './inconsistency-detector.js';
import { createTask as makeTask } from './test-utils.js';

function candidate(id: string, output: bigint[]): GeneratedExecutionCandidate {
  return {
    id,
    attempt: 1,
    output,
    fingerprint: `${id}-fp`,
    noveltyScore: 1,
    tokenEstimate: 16,
    cumulativeCostLamports: 100n,
  };
}

describe('detectCandidateInconsistencies', () => {
  it('detects structural and semantic disagreements with reason codes', async () => {
    const task = makeTask();
    const result = await detectCandidateInconsistencies({
      task,
      candidates: [
        candidate('c1', [1n, 2n]),
        candidate('c2', [1n, 3n]),
        candidate('c3', [1n, 2n, 3n]),
      ],
      semanticDistanceThreshold: 0.3,
    });

    expect(result.totalPairs).toBe(3);
    expect(result.totalDisagreements).toBe(3);
    expect(result.disagreementRate).toBeCloseTo(1, 6);
    expect(
      result.disagreements.some((entry) =>
        entry.reasons.some((reason) => reason.code === 'length_mismatch')),
    ).toBe(true);
    expect(
      result.disagreements.some((entry) =>
        entry.reasons.some((reason) => reason.code === 'value_mismatch')),
    ).toBe(true);
    expect(
      result.disagreements.some((entry) =>
        entry.reasons.some((reason) => reason.code === 'semantic_distance')),
    ).toBe(true);
  });

  it('writes contradiction provenance links to MemoryGraph when configured', async () => {
    const backend = new InMemoryBackend();
    const graph = new MemoryGraph(backend);

    const result = await detectCandidateInconsistencies({
      task: makeTask(),
      candidates: [
        candidate('c1', [1n]),
        candidate('c2', [2n]),
      ],
      memoryGraph: graph,
      sessionId: 'candidate:test',
    });

    expect(result.totalDisagreements).toBe(1);
    expect(result.provenanceLinks).toHaveLength(1);
    expect(result.disagreements[0]!.provenanceLinkIds).toHaveLength(1);

    const edges = await graph.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.type).toBe('contradicts');
  });
});
