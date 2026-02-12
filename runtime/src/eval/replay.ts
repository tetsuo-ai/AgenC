/**
 * Deterministic trajectory replay engine.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import {
  canonicalizeTrajectoryTrace,
  parseTrajectoryTrace,
  stableStringifyJson,
  type JsonValue,
  type TrajectoryEvent,
  type TrajectoryTrace,
} from './types.js';

export type ReplayTaskStatus =
  | 'unknown'
  | 'discovered'
  | 'claimed'
  | 'executed'
  | 'completed'
  | 'failed'
  | 'escalated';

export interface ReplayTaskState {
  taskPda: string;
  status: ReplayTaskStatus;
  eventCount: number;
  verifierVerdicts: number;
  policyViolations: number;
  speculationAborts: number;
  lastEventType: string;
  lastTimestampMs: number;
}

export interface ReplaySummary {
  totalEvents: number;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  escalatedTasks: number;
  policyViolations: number;
  verifierVerdicts: number;
  speculationAborts: number;
}

export interface TrajectoryReplayResult {
  trace: TrajectoryTrace;
  deterministicHash: string;
  summary: ReplaySummary;
  tasks: Record<string, ReplayTaskState>;
  warnings: string[];
  errors: string[];
}

export interface TrajectoryReplayConfig {
  strictMode?: boolean;
  seed?: number;
}

interface MutableReplayTaskState extends ReplayTaskState {
  terminal: boolean;
}

const TASK_REQUIRED_EVENTS = new Set<string>([
  'discovered',
  'claimed',
  'executed',
  'executed_speculative',
  'completed',
  'completed_speculative',
  'failed',
  'proof_failed',
  'escalated',
  'speculation_started',
  'speculation_confirmed',
  'speculation_aborted',
]);

function isLifecycleStatus(status: ReplayTaskStatus): boolean {
  return status === 'discovered'
    || status === 'claimed'
    || status === 'executed'
    || status === 'completed'
    || status === 'failed'
    || status === 'escalated';
}

/**
 * Replays trace events deterministically and produces a stable replay hash.
 */
export class TrajectoryReplayEngine {
  private readonly strictMode: boolean;
  private readonly seed?: number;

  constructor(config: TrajectoryReplayConfig = {}) {
    this.strictMode = config.strictMode ?? true;
    this.seed = config.seed;
  }

  replay(input: unknown): TrajectoryReplayResult {
    const parsed = parseTrajectoryTrace(input);
    const trace = canonicalizeTrajectoryTrace(parsed);

    const warnings: string[] = [];
    const errors: string[] = [];
    const tasks = new Map<string, MutableReplayTaskState>();

    let previousSeq = 0;
    for (const event of trace.events) {
      if (event.seq <= previousSeq) {
        warnings.push(`non-monotonic sequence at event seq=${event.seq}`);
      }
      previousSeq = event.seq;
      this.applyEvent(event, tasks, warnings, errors);
    }

    const finalizedTasks: Record<string, ReplayTaskState> = {};
    for (const [taskPda, taskState] of tasks) {
      finalizedTasks[taskPda] = {
        taskPda: taskState.taskPda,
        status: taskState.status,
        eventCount: taskState.eventCount,
        verifierVerdicts: taskState.verifierVerdicts,
        policyViolations: taskState.policyViolations,
        speculationAborts: taskState.speculationAborts,
        lastEventType: taskState.lastEventType,
        lastTimestampMs: taskState.lastTimestampMs,
      };
    }

    const summary = this.buildSummary(trace, finalizedTasks);

    const replaySeed = this.seed ?? trace.seed;
    const deterministicHash = this.computeHash(trace, finalizedTasks, summary, replaySeed);

    return {
      trace,
      deterministicHash,
      summary,
      tasks: finalizedTasks,
      warnings,
      errors,
    };
  }

  private applyEvent(
    event: TrajectoryEvent,
    tasks: Map<string, MutableReplayTaskState>,
    warnings: string[],
    errors: string[],
  ): void {
    const eventType = event.type;

    if (TASK_REQUIRED_EVENTS.has(eventType) && !event.taskPda) {
      const message = `event "${event.type}" at seq=${event.seq} requires taskPda`;
      if (this.strictMode) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
      return;
    }

    if (!event.taskPda) {
      return;
    }

    const task = this.getOrCreateTask(tasks, event.taskPda, event);
    task.eventCount++;
    task.lastEventType = event.type;
    task.lastTimestampMs = event.timestampMs;

    if (event.type === 'verifier_verdict') {
      task.verifierVerdicts++;
      return;
    }

    if (event.type === 'policy_violation') {
      task.policyViolations++;
      return;
    }

    if (event.type === 'speculation_aborted') {
      task.speculationAborts++;
    }

    const previousStatus = task.status;

    switch (event.type) {
      case 'discovered':
        task.status = 'discovered';
        break;
      case 'claimed':
        task.status = 'claimed';
        break;
      case 'executed':
      case 'executed_speculative':
      case 'speculation_started':
      case 'speculation_confirmed':
      case 'proof_generated':
      case 'sequential_enforcement_bypass':
      case 'verifier_verdict':
        task.status = isLifecycleStatus(previousStatus) ? previousStatus : 'executed';
        if (task.status === 'discovered' || task.status === 'claimed') {
          task.status = 'executed';
        }
        break;
      case 'completed':
      case 'completed_speculative':
        task.status = 'completed';
        task.terminal = true;
        break;
      case 'failed':
      case 'proof_failed':
      case 'speculation_aborted':
        task.status = 'failed';
        task.terminal = true;
        break;
      case 'escalated':
        task.status = 'escalated';
        task.terminal = true;
        break;
      default:
        warnings.push(`unknown event type "${event.type}" at seq=${event.seq}`);
        break;
    }

    this.validateTransition(previousStatus, task.status, event, warnings, errors);
  }

  private validateTransition(
    previous: ReplayTaskStatus,
    next: ReplayTaskStatus,
    event: TrajectoryEvent,
    warnings: string[],
    errors: string[],
  ): void {
    const invalidCompletion =
      (event.type === 'completed' || event.type === 'completed_speculative')
      && !(previous === 'executed' || previous === 'claimed');

    const invalidExecution =
      (event.type === 'executed' || event.type === 'executed_speculative')
      && !(previous === 'claimed' || previous === 'discovered');

    const invalidClaim = event.type === 'claimed' && previous === 'completed';

    const messages: string[] = [];
    if (invalidCompletion) {
      messages.push(`invalid completion transition ${previous} -> ${next} at seq=${event.seq}`);
    }
    if (invalidExecution) {
      messages.push(`invalid execution transition ${previous} -> ${next} at seq=${event.seq}`);
    }
    if (invalidClaim) {
      messages.push(`invalid claim transition ${previous} -> ${next} at seq=${event.seq}`);
    }

    for (const message of messages) {
      if (this.strictMode) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  private getOrCreateTask(
    tasks: Map<string, MutableReplayTaskState>,
    taskPda: string,
    event: TrajectoryEvent,
  ): MutableReplayTaskState {
    const existing = tasks.get(taskPda);
    if (existing) {
      return existing;
    }

    const created: MutableReplayTaskState = {
      taskPda,
      status: 'unknown',
      eventCount: 0,
      verifierVerdicts: 0,
      policyViolations: 0,
      speculationAborts: 0,
      lastEventType: event.type,
      lastTimestampMs: event.timestampMs,
      terminal: false,
    };
    tasks.set(taskPda, created);
    return created;
  }

  private buildSummary(
    trace: TrajectoryTrace,
    tasks: Record<string, ReplayTaskState>,
  ): ReplaySummary {
    const taskValues = Object.values(tasks);

    return {
      totalEvents: trace.events.length,
      taskCount: taskValues.length,
      completedTasks: taskValues.filter((task) => task.status === 'completed').length,
      failedTasks: taskValues.filter((task) => task.status === 'failed').length,
      escalatedTasks: taskValues.filter((task) => task.status === 'escalated').length,
      policyViolations: taskValues.reduce((acc, task) => acc + task.policyViolations, 0),
      verifierVerdicts: taskValues.reduce((acc, task) => acc + task.verifierVerdicts, 0),
      speculationAborts: taskValues.reduce((acc, task) => acc + task.speculationAborts, 0),
    };
  }

  private computeHash(
    trace: TrajectoryTrace,
    tasks: Record<string, ReplayTaskState>,
    summary: ReplaySummary,
    seed: number,
  ): string {
    const sortedTaskEntries = Object.entries(tasks)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, ReplayTaskState>>((acc, [taskPda, state]) => {
        acc[taskPda] = state;
        return acc;
      }, {});

    const payload = {
      schemaVersion: trace.schemaVersion,
      traceId: trace.traceId,
      seed,
      strictMode: this.strictMode,
      events: trace.events,
      summary,
      tasks: sortedTaskEntries,
    };

    return createHash('sha256')
      .update(stableStringifyJson(payload as unknown as JsonValue))
      .digest('hex');
  }
}
