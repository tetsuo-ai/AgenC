/**
 * Deterministic candidate arbitration and escalation rules.
 *
 * @module
 */

import type { MultiCandidateConfig } from "./types.js";
import type { GeneratedExecutionCandidate } from "./candidate-generator.js";
import { fnv1aHashUnit as hashStringToUnit } from "../utils/encoding.js";
import type {
  CandidateDisagreementReasonCode,
  InconsistencyDetectionResult,
} from "./inconsistency-detector.js";

export interface CandidateArbitrationScore {
  candidateId: string;
  score: number;
  consistency: number;
  diversity: number;
  confidence: number;
  recency: number;
  disagreements: number;
}

export type CandidateArbitrationDecision =
  | {
      outcome: "selected";
      selected: GeneratedExecutionCandidate;
      ranked: CandidateArbitrationScore[];
      metadata: {
        disagreementRate: number;
        totalDisagreements: number;
        reasonCodes: CandidateDisagreementReasonCode[];
        provenanceLinkIds: string[];
      };
    }
  | {
      outcome: "escalate";
      reason: "no_candidates" | "disagreement_threshold";
      ranked: CandidateArbitrationScore[];
      metadata: {
        disagreementRate: number;
        totalDisagreements: number;
        reasonCodes: CandidateDisagreementReasonCode[];
        provenanceLinkIds: string[];
      };
    };

export interface CandidateArbitrationInput {
  candidates: GeneratedExecutionCandidate[];
  inconsistencies: InconsistencyDetectionResult;
  config?: MultiCandidateConfig;
  confidenceByCandidateId?: Record<string, number>;
}

interface ResolvedWeights {
  consistency: number;
  diversity: number;
  confidence: number;
  recency: number;
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}


function resolveWeights(
  config: MultiCandidateConfig | undefined,
): ResolvedWeights {
  const base = {
    consistency: Math.max(0, config?.arbitrationWeights?.consistency ?? 0.55),
    diversity: Math.max(0, config?.arbitrationWeights?.diversity ?? 0.2),
    confidence: Math.max(0, config?.arbitrationWeights?.confidence ?? 0.2),
    recency: Math.max(0, config?.arbitrationWeights?.recency ?? 0.05),
  };
  const total =
    base.consistency + base.diversity + base.confidence + base.recency;
  if (total <= 0) {
    return { consistency: 1, diversity: 0, confidence: 0, recency: 0 };
  }
  return {
    consistency: base.consistency / total,
    diversity: base.diversity / total,
    confidence: base.confidence / total,
    recency: base.recency / total,
  };
}

function collectReasonCodes(
  inconsistencies: InconsistencyDetectionResult,
): CandidateDisagreementReasonCode[] {
  const seen = new Set<CandidateDisagreementReasonCode>();
  for (const disagreement of inconsistencies.disagreements) {
    for (const reason of disagreement.reasons) {
      seen.add(reason.code);
    }
  }
  return [...seen].sort();
}

/**
 * Select a candidate deterministically or return an escalation decision.
 */
export function arbitrateCandidates(
  input: CandidateArbitrationInput,
): CandidateArbitrationDecision {
  const weights = resolveWeights(input.config);
  const seed = input.config?.seed ?? 17;
  const reasonCodes = collectReasonCodes(input.inconsistencies);
  const provenanceLinkIds = input.inconsistencies.provenanceLinks.map(
    (link) => link.edgeId,
  );

  if (input.candidates.length === 0) {
    return {
      outcome: "escalate",
      reason: "no_candidates",
      ranked: [],
      metadata: {
        disagreementRate: input.inconsistencies.disagreementRate,
        totalDisagreements: input.inconsistencies.totalDisagreements,
        reasonCodes,
        provenanceLinkIds,
      },
    };
  }

  const disagreementCountByCandidate = new Map<string, number>();
  for (const candidate of input.candidates) {
    disagreementCountByCandidate.set(candidate.id, 0);
  }
  for (const disagreement of input.inconsistencies.disagreements) {
    disagreementCountByCandidate.set(
      disagreement.leftCandidateId,
      (disagreementCountByCandidate.get(disagreement.leftCandidateId) ?? 0) + 1,
    );
    disagreementCountByCandidate.set(
      disagreement.rightCandidateId,
      (disagreementCountByCandidate.get(disagreement.rightCandidateId) ?? 0) +
        1,
    );
  }

  const maxDisagreements = input.config?.escalation?.maxPairwiseDisagreements;
  const maxDisagreementRate = input.config?.escalation?.maxDisagreementRate;
  const shouldEscalate =
    (maxDisagreements !== undefined &&
      input.inconsistencies.totalDisagreements >=
        Math.max(0, Math.floor(maxDisagreements))) ||
    (maxDisagreementRate !== undefined &&
      input.inconsistencies.disagreementRate >=
        clampRatio(maxDisagreementRate, 1));

  const candidateCount = input.candidates.length;
  const ranked = input.candidates.map((candidate) => {
    const disagreements = disagreementCountByCandidate.get(candidate.id) ?? 0;
    const consistency =
      candidateCount <= 1
        ? 1
        : clampRatio(1 - disagreements / (candidateCount - 1), 0);
    const diversity = clampRatio(candidate.noveltyScore, 0);
    const confidence = clampRatio(
      input.confidenceByCandidateId?.[candidate.id],
      0.5,
    );
    const recency = clampRatio(1 / Math.max(1, candidate.attempt), 1);
    const score =
      consistency * weights.consistency +
      diversity * weights.diversity +
      confidence * weights.confidence +
      recency * weights.recency;

    return {
      candidateId: candidate.id,
      score,
      consistency,
      diversity,
      confidence,
      recency,
      disagreements,
      tieBreaker: hashStringToUnit(`${seed}:${candidate.id}`),
    };
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.tieBreaker !== right.tieBreaker) {
      return left.tieBreaker - right.tieBreaker;
    }
    return left.candidateId.localeCompare(right.candidateId);
  });

  const rankedWithoutTie = ranked.map(
    ({ tieBreaker: _tieBreaker, ...entry }) => entry,
  );
  if (shouldEscalate) {
    return {
      outcome: "escalate",
      reason: "disagreement_threshold",
      ranked: rankedWithoutTie,
      metadata: {
        disagreementRate: input.inconsistencies.disagreementRate,
        totalDisagreements: input.inconsistencies.totalDisagreements,
        reasonCodes,
        provenanceLinkIds,
      },
    };
  }

  const selectedId = ranked[0]!.candidateId;
  const selected = input.candidates.find(
    (candidate) => candidate.id === selectedId,
  )!;
  return {
    outcome: "selected",
    selected,
    ranked: rankedWithoutTie,
    metadata: {
      disagreementRate: input.inconsistencies.disagreementRate,
      totalDisagreements: input.inconsistencies.totalDisagreements,
      reasonCodes,
      provenanceLinkIds,
    },
  };
}
