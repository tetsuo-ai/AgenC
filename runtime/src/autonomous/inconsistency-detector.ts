/**
 * Candidate inconsistency detection and provenance linkage.
 *
 * @module
 */

import type { MemoryGraph } from "../memory/graph.js";
import type { Task } from "./types.js";
import type { GeneratedExecutionCandidate } from "./candidate-generator.js";

export type CandidateDisagreementReasonCode =
  | "length_mismatch"
  | "value_mismatch"
  | "semantic_distance";

export interface CandidateDisagreementReason {
  code: CandidateDisagreementReasonCode;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CandidateDisagreement {
  leftCandidateId: string;
  rightCandidateId: string;
  semanticDistance: number;
  reasons: CandidateDisagreementReason[];
  provenanceLinkIds: string[];
}

export interface CandidateProvenanceLink {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  fromCandidateId: string;
  toCandidateId: string;
  reasonCodes: CandidateDisagreementReasonCode[];
}

export interface InconsistencyDetectionResult {
  totalPairs: number;
  totalDisagreements: number;
  disagreementRate: number;
  disagreements: CandidateDisagreement[];
  provenanceLinks: CandidateProvenanceLink[];
}

export interface InconsistencyDetectorInput {
  task: Task;
  candidates: GeneratedExecutionCandidate[];
  semanticDistanceThreshold?: number;
  memoryGraph?: MemoryGraph;
  sessionId?: string;
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function computeMismatchStats(
  left: readonly bigint[],
  right: readonly bigint[],
): { mismatchCount: number; distance: number } {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return { mismatchCount: 0, distance: 0 };
  }

  const overlap = Math.min(left.length, right.length);
  let mismatchCount = Math.abs(left.length - right.length);
  for (let i = 0; i < overlap; i++) {
    if (left[i] !== right[i]) mismatchCount++;
  }

  return { mismatchCount, distance: mismatchCount / maxLength };
}

function nodeIdFor(task: Task, candidate: GeneratedExecutionCandidate): string {
  return `candidate:${task.pda.toBase58()}:${candidate.id}`;
}

async function ensureCandidateNode(
  graph: MemoryGraph,
  task: Task,
  candidate: GeneratedExecutionCandidate,
  sessionId: string,
): Promise<string> {
  const nodeId = nodeIdFor(task, candidate);
  await graph.upsertNode({
    id: nodeId,
    sessionId,
    taskPda: task.pda.toBase58(),
    content: JSON.stringify({
      candidateId: candidate.id,
      fingerprint: candidate.fingerprint,
      output: candidate.output.map((value) => value.toString()),
    }),
    baseConfidence: 0.8,
    tags: ["candidate", "arbitration"],
    metadata: {
      attempt: candidate.attempt,
      noveltyScore: candidate.noveltyScore,
      tokenEstimate: candidate.tokenEstimate,
    },
    provenance: [
      {
        type: "materialization",
        sourceId: `candidate:${candidate.id}`,
        description: "Generated execution candidate",
      },
    ],
  });
  return nodeId;
}

async function linkDisagreementInGraph(
  graph: MemoryGraph,
  task: Task,
  left: GeneratedExecutionCandidate,
  right: GeneratedExecutionCandidate,
  reasons: CandidateDisagreementReason[],
  semanticDistance: number,
  sessionId: string,
): Promise<CandidateProvenanceLink> {
  const leftNodeId = await ensureCandidateNode(graph, task, left, sessionId);
  const rightNodeId = await ensureCandidateNode(graph, task, right, sessionId);

  const edge = await graph.addEdge({
    fromId: leftNodeId,
    toId: rightNodeId,
    type: "contradicts",
    metadata: {
      reasonCodes: reasons.map((reason) => reason.code),
      semanticDistance,
    },
  });

  return {
    edgeId: edge.id,
    fromNodeId: leftNodeId,
    toNodeId: rightNodeId,
    fromCandidateId: left.id,
    toCandidateId: right.id,
    reasonCodes: reasons.map((reason) => reason.code),
  };
}

/**
 * Detect structural/semantic disagreements between generated candidates.
 */
export async function detectCandidateInconsistencies(
  input: InconsistencyDetectorInput,
): Promise<InconsistencyDetectionResult> {
  const semanticDistanceThreshold = clampRatio(
    input.semanticDistanceThreshold,
    0.25,
  );
  const disagreements: CandidateDisagreement[] = [];
  const provenanceLinks: CandidateProvenanceLink[] = [];
  const sessionId = input.sessionId ?? `candidate:${input.task.pda.toBase58()}`;

  let totalPairs = 0;
  for (let i = 0; i < input.candidates.length; i++) {
    for (let j = i + 1; j < input.candidates.length; j++) {
      totalPairs++;
      const left = input.candidates[i]!;
      const right = input.candidates[j]!;
      const reasons: CandidateDisagreementReason[] = [];
      const mismatch = computeMismatchStats(left.output, right.output);

      if (left.output.length !== right.output.length) {
        reasons.push({
          code: "length_mismatch",
          message: "Candidate output lengths differ",
          metadata: {
            leftLength: left.output.length,
            rightLength: right.output.length,
          },
        });
      }

      if (mismatch.mismatchCount > 0) {
        reasons.push({
          code: "value_mismatch",
          message: "Candidate field values differ",
          metadata: { mismatchCount: mismatch.mismatchCount },
        });
      }

      if (mismatch.distance >= semanticDistanceThreshold) {
        reasons.push({
          code: "semantic_distance",
          message: "Candidate semantic distance exceeds threshold",
          metadata: {
            semanticDistance: mismatch.distance,
            threshold: semanticDistanceThreshold,
          },
        });
      }

      if (reasons.length === 0) {
        continue;
      }

      const provenanceLinkIds: string[] = [];
      if (input.memoryGraph) {
        const link = await linkDisagreementInGraph(
          input.memoryGraph,
          input.task,
          left,
          right,
          reasons,
          mismatch.distance,
          sessionId,
        );
        provenanceLinks.push(link);
        provenanceLinkIds.push(link.edgeId);
      }

      disagreements.push({
        leftCandidateId: left.id,
        rightCandidateId: right.id,
        semanticDistance: mismatch.distance,
        reasons,
        provenanceLinkIds,
      });
    }
  }

  const totalDisagreements = disagreements.length;
  const disagreementRate =
    totalPairs === 0 ? 0 : totalDisagreements / totalPairs;
  return {
    totalPairs,
    totalDisagreements,
    disagreementRate,
    disagreements,
    provenanceLinks,
  };
}
