/**
 * Deterministic mutation operator library for trajectory robustness testing.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import {
  parseTrajectoryTrace,
  stableStringifyJson,
  type JsonObject,
  type JsonValue,
  type TrajectoryEvent,
  type TrajectoryTrace,
} from './types.js';

export type MutationOperatorCategory = 'workflow' | 'tool_failure' | 'verifier';

export interface MutationOperatorContext {
  scenarioId: string;
  seed: number;
  mutationSeed: number;
}

export interface MutationOperatorResult {
  mutated: boolean;
  trace: TrajectoryTrace;
  note?: string;
}

export interface MutationOperator {
  id: string;
  category: MutationOperatorCategory;
  description: string;
  apply(
    trace: TrajectoryTrace,
    random: SeededRandom,
    context: MutationOperatorContext,
  ): MutationOperatorResult;
}

export interface MutationSelectionOptions {
  operatorIds?: string[];
  maxMutationsPerScenario?: number;
}

export interface MutationCandidate {
  mutationId: string;
  operatorId: string;
  operatorCategory: MutationOperatorCategory;
  scenarioId: string;
  seed: number;
  note?: string;
  trace: TrajectoryTrace;
  deterministicHash: string;
}

export interface MutationEngineConfig {
  operators?: MutationOperator[];
}

/**
 * Small deterministic RNG for reproducible operator behavior.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 1) {
      return 0;
    }
    return Math.floor(this.next() * maxExclusive);
  }
}

function deepCloneTrace(trace: TrajectoryTrace): TrajectoryTrace {
  return parseTrajectoryTrace(JSON.parse(JSON.stringify(trace)) as unknown);
}

function deepCloneEvents(events: TrajectoryEvent[]): TrajectoryEvent[] {
  return events.map((event) => ({
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload ?? {})) as JsonObject,
  }));
}

function terminalEventIndex(events: TrajectoryEvent[], taskPda: string, startIndex: number): number {
  return events.findIndex(
    (event, index) => index > startIndex
      && event.taskPda === taskPda
      && (event.type === 'completed'
        || event.type === 'completed_speculative'
        || event.type === 'failed'
        || event.type === 'proof_failed'
        || event.type === 'escalated'),
  );
}

function normalizeTrace(
  baseTrace: TrajectoryTrace,
  mutationId: string,
  events: TrajectoryEvent[],
): TrajectoryTrace {
  let lastTimestamp = Math.max(0, baseTrace.createdAtMs);
  const normalizedEvents = events.map((event, index) => {
    const proposed = Number.isInteger(event.timestampMs) ? event.timestampMs : lastTimestamp + 1;
    const timestampMs = Math.max(lastTimestamp + 1, proposed);
    lastTimestamp = timestampMs;
    return {
      seq: index + 1,
      type: event.type,
      taskPda: event.taskPda,
      timestampMs,
      payload: event.payload,
    };
  });

  const mutationMetadata: JsonObject = { mutationId };
  return {
    ...baseTrace,
    traceId: `${baseTrace.traceId}:${mutationId}`,
    metadata: {
      ...(baseTrace.metadata ?? {}),
      mutation: mutationMetadata,
    },
    events: normalizedEvents,
  };
}

function candidateHash(candidate: Omit<MutationCandidate, 'deterministicHash'>): string {
  const payload = {
    mutationId: candidate.mutationId,
    operatorId: candidate.operatorId,
    operatorCategory: candidate.operatorCategory,
    scenarioId: candidate.scenarioId,
    seed: candidate.seed,
    trace: candidate.trace,
  };
  return createHash('sha256')
    .update(stableStringifyJson(payload as unknown as JsonValue))
    .digest('hex');
}

function stableSeed(
  scenarioId: string,
  seed: number,
  mutationSeed: number,
  operatorId: string,
): number {
  const digest = createHash('sha256')
    .update(`${scenarioId}:${seed}:${mutationSeed}:${operatorId}`)
    .digest();
  return digest.readUInt32BE(0);
}

function createWorkflowDropCompletionOperator(): MutationOperator {
  return {
    id: 'workflow.drop_completion',
    category: 'workflow',
    description: 'Replaces a completion event with a failure to simulate workflow perturbation.',
    apply(trace, random) {
      const events = deepCloneEvents(trace.events);
      const completionIndexes = events
        .map((event, index) => ((event.type === 'completed' || event.type === 'completed_speculative')
          ? index
          : -1))
        .filter((index) => index >= 0);

      if (completionIndexes.length === 0) {
        return { mutated: false, trace };
      }

      const targetIndex = completionIndexes[random.nextInt(completionIndexes.length)]!;
      const target = events[targetIndex]!;
      events[targetIndex] = {
        ...target,
        type: 'failed',
        payload: {
          error: 'workflow_completion_dropped',
          previousType: target.type,
        },
      };

      return {
        mutated: true,
        trace: {
          ...trace,
          events,
        },
        note: 'Converted completion to failure',
      };
    },
  };
}

function createToolFailureInjectionOperator(): MutationOperator {
  return {
    id: 'tool.inject_failure',
    category: 'tool_failure',
    description: 'Injects tool timeout violation and forces terminal failure.',
    apply(trace, random) {
      const events = deepCloneEvents(trace.events);
      const executedIndexes = events
        .map((event, index) => ((event.type === 'executed' || event.type === 'executed_speculative')
          ? index
          : -1))
        .filter((index) => index >= 0);

      if (executedIndexes.length === 0) {
        return { mutated: false, trace };
      }

      const targetExecIndex = executedIndexes[random.nextInt(executedIndexes.length)]!;
      const targetExecEvent = events[targetExecIndex]!;
      const taskPda = targetExecEvent.taskPda;
      if (!taskPda) {
        return { mutated: false, trace };
      }

      const injectedViolation: TrajectoryEvent = {
        seq: targetExecEvent.seq + 1,
        type: 'policy_violation',
        taskPda,
        timestampMs: targetExecEvent.timestampMs + 1,
        payload: {
          code: 'tool_timeout_injected',
        },
      };
      events.splice(targetExecIndex + 1, 0, injectedViolation);

      const endIndex = terminalEventIndex(events, taskPda, targetExecIndex);
      if (endIndex >= 0) {
        const terminal = events[endIndex]!;
        if (terminal.type === 'completed' || terminal.type === 'completed_speculative') {
          events[endIndex] = {
            ...terminal,
            type: 'failed',
            payload: {
              error: 'tool_failure_injected',
              previousType: terminal.type,
            },
          };
        }
      } else {
        const latest = events[events.length - 1];
        events.push({
          seq: (latest?.seq ?? 0) + 1,
          type: 'failed',
          taskPda,
          timestampMs: (latest?.timestampMs ?? trace.createdAtMs) + 1,
          payload: {
            error: 'tool_failure_injected',
          },
        });
      }

      return {
        mutated: true,
        trace: {
          ...trace,
          events,
        },
        note: 'Injected tool timeout and forced failed terminal state',
      };
    },
  };
}

function createVerifierPerturbationOperator(): MutationOperator {
  return {
    id: 'verifier.flip_verdict',
    category: 'verifier',
    description: 'Flips verifier verdict to fail and escalates terminal completion.',
    apply(trace, random) {
      const events = deepCloneEvents(trace.events);
      const verdictIndexes = events
        .map((event, index) => (event.type === 'verifier_verdict' ? index : -1))
        .filter((index) => index >= 0);
      if (verdictIndexes.length === 0) {
        return { mutated: false, trace };
      }

      const verdictIndex = verdictIndexes[random.nextInt(verdictIndexes.length)]!;
      const verdictEvent = events[verdictIndex]!;
      const currentConfidence = typeof verdictEvent.payload.confidence === 'number'
        ? verdictEvent.payload.confidence
        : 0.8;

      verdictEvent.payload = {
        ...verdictEvent.payload,
        verdict: 'fail',
        confidence: Math.min(Math.max(currentConfidence / 2, 0.01), 0.49),
      };

      const taskPda = verdictEvent.taskPda;
      if (taskPda) {
        const completionIndex = events.findIndex(
          (event, index) => index > verdictIndex
            && event.taskPda === taskPda
            && (event.type === 'completed' || event.type === 'completed_speculative'),
        );

        if (completionIndex >= 0) {
          const completion = events[completionIndex]!;
          events[completionIndex] = {
            ...completion,
            type: 'escalated',
            payload: {
              reason: 'verifier_failure_injected',
            },
          };
        }
      }

      return {
        mutated: true,
        trace: {
          ...trace,
          events,
        },
        note: 'Forced verifier failure and escalation',
      };
    },
  };
}

/**
 * Default mutation operator set aligned to workflow/tool/verifier robustness categories.
 */
export function createDefaultMutationOperators(): MutationOperator[] {
  return [
    createWorkflowDropCompletionOperator(),
    createToolFailureInjectionOperator(),
    createVerifierPerturbationOperator(),
  ];
}

export const DEFAULT_MUTATION_OPERATOR_IDS = createDefaultMutationOperators()
  .map((operator) => operator.id);

/**
 * Deterministic mutation candidate generator.
 */
export class MutationEngine {
  private readonly operators: MutationOperator[];

  constructor(config: MutationEngineConfig = {}) {
    const configured = config.operators ?? createDefaultMutationOperators();
    this.operators = [...configured].sort((left, right) => left.id.localeCompare(right.id));
  }

  getOperators(): MutationOperator[] {
    return this.operators.map((operator) => ({ ...operator }));
  }

  createMutations(
    input: unknown,
    context: MutationOperatorContext,
    options: MutationSelectionOptions = {},
  ): MutationCandidate[] {
    const parsed = parseTrajectoryTrace(input);
    const baseTrace = deepCloneTrace(parsed);
    const selectedIds = options.operatorIds ? new Set(options.operatorIds) : null;
    const maxMutations = Math.max(1, Math.floor(options.maxMutationsPerScenario ?? this.operators.length));
    const generated: MutationCandidate[] = [];

    for (const operator of this.operators) {
      if (selectedIds && !selectedIds.has(operator.id)) {
        continue;
      }
      if (generated.length >= maxMutations) {
        break;
      }

      const random = new SeededRandom(stableSeed(
        context.scenarioId,
        context.seed,
        context.mutationSeed,
        operator.id,
      ));

      const result = operator.apply(deepCloneTrace(baseTrace), random, context);
      if (!result.mutated) {
        continue;
      }

      const mutationId = `${context.scenarioId}:seed-${context.seed}:${operator.id}`;
      const normalizedTrace = normalizeTrace(result.trace, mutationId, deepCloneEvents(result.trace.events));
      const candidateWithoutHash: Omit<MutationCandidate, 'deterministicHash'> = {
        mutationId,
        operatorId: operator.id,
        operatorCategory: operator.category,
        scenarioId: context.scenarioId,
        seed: context.seed,
        note: result.note,
        trace: normalizedTrace,
      };
      generated.push({
        ...candidateWithoutHash,
        deterministicHash: candidateHash(candidateWithoutHash),
      });
    }

    return generated;
  }
}

