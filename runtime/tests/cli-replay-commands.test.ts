import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { projectOnChainEvents, type ProjectedTimelineEvent } from '../src/eval/projector.js';
import { computeProjectionHash, type ReplayTimelineRecord } from '../src/replay/types.js';
import * as cliReplay from '../src/cli/replay.js';

interface OnChainFixtureEvent {
  eventName: string;
  slot: number;
  signature: string;
  timestampMs: number;
  event: Record<string, unknown>;
}

interface CliCapture {
  stream: Writable;
  getText: () => string;
}

const FIXTURE_EVENTS = JSON.parse(
  readFileSync(new URL('./fixtures/replay-cli/onchain-events.json', import.meta.url), 'utf8'),
) as OnChainFixtureEvent[];
const TASK_FIXTURE_EVENTS = FIXTURE_EVENTS.filter((entry) => entry.eventName.startsWith('task'));

function createCapture(): CliCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return {
    stream,
    getText() {
      return chunks.join('');
    },
  };
}

async function runCliCapture(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = createCapture();
  const stderr = createCapture();

  const code = await runCli({
    argv,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  return {
    code,
    stdout: stdout.getText(),
    stderr: stderr.getText(),
  };
}

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenc-cli-replay-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function buildReplayRecords(
  events: OnChainFixtureEvent[],
  traceId: string,
  seed = 0,
): ReplayTimelineRecord[] {
  const projection = projectOnChainEvents(events, {
    traceId,
    seed,
  });

  return projection.events.map((entry) => ({
    seq: entry.seq,
    type: entry.type,
    taskPda: entry.taskPda,
    timestampMs: entry.timestampMs,
    payload: entry.payload,
    slot: entry.slot,
    signature: entry.signature,
    sourceEventName: entry.sourceEventName,
    sourceEventSequence: entry.sourceEventSequence,
    sourceEventType: entry.type,
    projectionHash: computeProjectionHash(entry as ProjectedTimelineEvent),
  }));
}

function writeTraceFixture(
  workspace: string,
  projectionTrace: ReturnType<typeof projectOnChainEvents>['trace'],
): string {
  const localTracePath = join(workspace, 'compare-trace.json');
  writeFileSync(localTracePath, JSON.stringify({
    schemaVersion: 1,
    traceId: projectionTrace.traceId,
    seed: projectionTrace.seed,
    createdAtMs: projectionTrace.createdAtMs,
    events: projectionTrace.events,
  }), 'utf8');
  return localTracePath;
}

describe('runtime replay cli commands', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = createTempWorkspace();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('emits a deterministic replay compare report in schema v1', async () => {
    const projection = projectOnChainEvents(TASK_FIXTURE_EVENTS, {
      traceId: 'fixture-replay',
      seed: 99,
    });
    const records = buildReplayRecords(TASK_FIXTURE_EVENTS, 'fixture-replay', projection.trace.seed);
    const store = cliReplay.createReplayStore({ storeType: 'memory' });

    await store.save(records);
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

    const localTracePath = writeTraceFixture(workspace, projection.trace);

    const result = await runCliCapture([
      'replay',
      'compare',
      '--local-trace-path',
      localTracePath,
      '--store-type',
      'memory',
      '--task-pda',
      projection.events[0]?.taskPda ?? 'task-missing',
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      schema: string;
      strictMode: boolean;
      command: string;
      result: {
        status: string;
        strictness: string;
        anomalyIds: string[];
        topAnomalies: Array<{
          anomalyId: string;
          code: string;
          severity: string;
          message: string;
        }>;
      };
    };

    expect(payload.schema).toBe('replay.compare.output.v1');
    expect(payload.command).toBe('replay.compare');
    expect(payload.result.status).toBe('clean');
    expect(payload.result.anomalyIds).toHaveLength(0);
    expect(payload.result.topAnomalies).toHaveLength(0);
    expect(payload.strictMode).toBe(false);
    expect(payload.result.strictness).toBe('lenient');
  });

  it('emits replay compare mismatches when local traces diverge', async () => {
    const projection = projectOnChainEvents(TASK_FIXTURE_EVENTS, {
      traceId: 'fixture-replay',
      seed: 99,
    });
    const records = buildReplayRecords(TASK_FIXTURE_EVENTS, 'fixture-replay', projection.trace.seed);
    const store = cliReplay.createReplayStore({ storeType: 'memory' });
    await store.save(records);
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

    const mismatchedTrace = {
      ...projection.trace,
      events: projection.trace.events.map((entry, index) =>
        index === 0
          ? { ...entry, type: 'claimed' as const, taskPda: 'task-mismatch' }
          : entry,
      ),
    };
    const localTracePath = writeTraceFixture(workspace, mismatchedTrace);

    const result = await runCliCapture([
      'replay',
      'compare',
      '--local-trace-path',
      localTracePath,
      '--store-type',
      'memory',
      '--strict-mode',
      'false',
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      result: { status: string; mismatchCount: number; anomalyIds: string[]; topAnomalies: Array<{ anomalyId: string }> };
    };
    expect(payload.result.status).toBe('mismatched');
    expect(payload.result.mismatchCount).toBeGreaterThan(0);
    expect(payload.result.anomalyIds).toHaveLength(payload.result.topAnomalies.length);
  });

  it('returns a stable incident reconstruction summary with validation', async () => {
    const projection = projectOnChainEvents(FIXTURE_EVENTS, {
      traceId: 'fixture-replay',
      seed: 99,
    });
    const records = buildReplayRecords(FIXTURE_EVENTS, 'fixture-replay', projection.trace.seed);
    const store = cliReplay.createReplayStore({ storeType: 'memory' });
    await store.save(records);
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

    const result = await runCliCapture([
      'replay',
      'incident',
      '--store-type',
      'memory',
      '--task-pda',
      projection.events[0]?.taskPda ?? 'task-missing',
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      schema: string;
      summary: {
        totalEvents: number;
        taskPdaFilters: Array<string | undefined>;
      };
      validation: {
        strictMode: boolean;
        anomalyIds: string[];
      };
      commandParams: { taskPda?: string };
    };

    expect(payload.schema).toBe('replay.incident.output.v1');
    expect(payload.summary.totalEvents).toBeGreaterThan(0);
    expect(payload.summary.taskPdaFilters).toEqual([projection.events[0]?.taskPda]);
    expect(payload.commandParams.taskPda).toBe(projection.events[0]?.taskPda);
    expect(payload.validation.strictMode).toBe(false);
  });

  it('runs backfill through deterministic on-chain fetcher output', async () => {
    const projectionInputs = FIXTURE_EVENTS.map((entry, index) => ({
      eventName: entry.eventName,
      event: entry.event,
      slot: entry.slot,
      signature: entry.signature,
      timestampMs: entry.timestampMs,
      sourceEventSequence: index,
    }));

    vi.spyOn(cliReplay, 'createOnChainReplayBackfillFetcher').mockReturnValue({
      fetchPage: async () => ({
        events: projectionInputs,
        nextCursor: {
          slot: projectionInputs.at(-1)?.slot ?? 0,
          signature: projectionInputs.at(-1)?.signature ?? 'SIG_EMPTY',
          eventName: projectionInputs.at(-1)?.eventName,
        },
        done: true,
      }),
    });

    const store = cliReplay.createReplayStore({ storeType: 'memory' });
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

    const result = await runCliCapture([
      'replay',
      'backfill',
      '--to-slot',
      '999',
      '--store-type',
      'memory',
      '--rpc',
      'https://example.com',
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      schema: string;
      result: { processed: number; duplicates: number; cursor: object | null };
    };
    expect(payload.schema).toBe('replay.backfill.output.v1');
    expect(payload.result.processed).toBeGreaterThan(0);
    expect(payload.result.duplicates).toBe(0);
  });
});
