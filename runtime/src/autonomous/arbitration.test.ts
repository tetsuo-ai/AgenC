import { describe, expect, it } from "vitest";
import type { GeneratedExecutionCandidate } from "./candidate-generator.js";
import { arbitrateCandidates } from "./arbitration.js";
import type { InconsistencyDetectionResult } from "./inconsistency-detector.js";

function candidate(
  id: string,
  attempt: number,
  noveltyScore: number,
): GeneratedExecutionCandidate {
  return {
    id,
    attempt,
    output: [BigInt(attempt)],
    fingerprint: `${id}-fp`,
    noveltyScore,
    tokenEstimate: 16,
    cumulativeCostLamports: BigInt(attempt * 100),
  };
}

function inconsistencies(
  overrides: Partial<InconsistencyDetectionResult> = {},
): InconsistencyDetectionResult {
  return {
    totalPairs: 3,
    totalDisagreements: 1,
    disagreementRate: 1 / 3,
    disagreements: [
      {
        leftCandidateId: "c1",
        rightCandidateId: "c2",
        semanticDistance: 1,
        reasons: [{ code: "value_mismatch", message: "different outputs" }],
        provenanceLinkIds: ["edge-1"],
      },
    ],
    provenanceLinks: [
      {
        edgeId: "edge-1",
        fromNodeId: "n1",
        toNodeId: "n2",
        fromCandidateId: "c1",
        toCandidateId: "c2",
        reasonCodes: ["value_mismatch"],
      },
    ],
    ...overrides,
  };
}

describe("arbitrateCandidates", () => {
  it("selects deterministically under fixed seed/config", () => {
    const candidates = [
      candidate("c1", 1, 0.2),
      candidate("c2", 2, 0.8),
      candidate("c3", 3, 0.5),
    ];
    const input = {
      candidates,
      inconsistencies: inconsistencies(),
      config: {
        enabled: true,
        seed: 42,
        arbitrationWeights: {
          consistency: 0.6,
          diversity: 0.3,
          confidence: 0.1,
          recency: 0,
        },
      },
      confidenceByCandidateId: {
        c1: 0.4,
        c2: 0.9,
        c3: 0.5,
      },
    } as const;

    const first = arbitrateCandidates(input);
    const second = arbitrateCandidates(input);

    expect(first.outcome).toBe("selected");
    expect(second.outcome).toBe("selected");
    if (first.outcome === "selected" && second.outcome === "selected") {
      expect(first.selected.id).toBe(second.selected.id);
      expect(first.ranked.map((entry) => entry.candidateId)).toEqual(
        second.ranked.map((entry) => entry.candidateId),
      );
    }
  });

  it("escalates when disagreement thresholds are exceeded", () => {
    const decision = arbitrateCandidates({
      candidates: [candidate("c1", 1, 0.1), candidate("c2", 2, 0.9)],
      inconsistencies: inconsistencies({
        totalPairs: 1,
        totalDisagreements: 1,
        disagreementRate: 1,
      }),
      config: {
        enabled: true,
        seed: 7,
        escalation: {
          maxPairwiseDisagreements: 1,
        },
      },
    });

    expect(decision.outcome).toBe("escalate");
    if (decision.outcome === "escalate") {
      expect(decision.reason).toBe("disagreement_threshold");
      expect(decision.metadata.reasonCodes).toContain("value_mismatch");
      expect(decision.metadata.provenanceLinkIds).toContain("edge-1");
    }
  });
});
