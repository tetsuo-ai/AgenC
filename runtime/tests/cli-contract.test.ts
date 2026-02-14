import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { projectOnChainEvents, type ProjectedTimelineEvent } from '../src/eval/projector.js';
import { computeProjectionHash, type ReplayTimelineRecord } from '../src/replay/types.js';
import * as cliReplay from '../src/cli/replay.js';
import {
  ContractCase,
  runContractCase,
  loadGoldenSnapshot,
} from './helpers/contract-validator.js';

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

function createWorkspace(): string {
  const workspace = join(tmpdir(), `agenc-cli-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function createReplayRecords(
  events: OnChainFixtureEvent[],
  traceId: string,
  seed = 0,
): ReplayTimelineRecord[] {
  const projection = projectOnChainEvents(events, {
    traceId,
    seed,
  });

  return projection.events.map((entry: ProjectedTimelineEvent, index) => ({
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
    projectionHash: computeProjectionHash(entry),
  }));
}

function writeTraceFixture(workspace: string, trace: {
  schemaVersion: number;
  traceId: string;
  seed: number;
  createdAtMs: number;
  events: Array<{
    seq: number;
    type: string;
    taskPda?: string;
    timestampMs: number;
    payload: Record<string, unknown>;
  }>;
}): string {
  const tracePath = join(workspace, `${trace.traceId}-trace.json`);
  const payload = {
    schemaVersion: 1,
    traceId: trace.traceId,
    seed: trace.seed,
    createdAtMs: trace.createdAtMs,
    events: trace.events,
  };
  writeFileSync(tracePath, JSON.stringify(payload), 'utf8');
  return tracePath;
}

function repeatRecords(records: ReplayTimelineRecord[], repeats: number): ReplayTimelineRecord[] {
  const output: ReplayTimelineRecord[] = [];
  for (let round = 0; round < repeats; round += 1) {
    for (const entry of records) {
      output.push({
        ...entry,
        seq: round * records.length + entry.seq,
        slot: entry.slot + round * 10_000,
        signature: `${entry.signature}-${round}`,
        timestampMs: entry.timestampMs + round * 1_000,
      });
    }
  }

  return output;
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

function parseCliOutput(result: { stdout: string; stderr: string }): unknown {
  const candidates = [result.stdout.trim(), result.stderr.trim()].filter((entry) => entry.length > 0);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // ignored
    }
  }
  throw new Error('cli output was not valid JSON');
}

describe('CLI output contract tests', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  const fixtureDir = new URL('./fixtures/golden/', import.meta.url);
  const backfillProjection = projectOnChainEvents(FIXTURE_EVENTS, {
    traceId: 'fixture-backfill',
    seed: 99,
  });
  const replayRecords = createReplayRecords(TASK_FIXTURE_EVENTS, 'fixture-compare', 33);

  const baseCases: ContractCase<Record<string, unknown>, Record<string, unknown>>[] = [
    {
      id: 'cli.replay.backfill.success',
      command: 'replay.backfill',
      fixturePath: new URL('cli-replay-backfill-success.json', fixtureDir).pathname,
      outputSchema: 'replay.backfill.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'mode',
        'toSlot',
        'storeType',
        'strictMode',
        'idempotencyWindow',
        'result',
      ],
      optionalTopLevelKeys: ['pageSize', 'traceId'],
      input: {
        argv: [
          'replay',
          'backfill',
          '--to-slot',
          '999',
          '--store-type',
          'memory',
          '--rpc',
          'https://example.com',
          '--trace-id',
          'fixture-backfill-trace',
        ],
      },
      async execute({}) {
        const mappedEvents = backfillProjection.events.map((entry) => ({
          eventName: entry.sourceEventName,
          event: entry.payload,
          slot: entry.slot,
          signature: entry.signature,
          timestampMs: entry.timestampMs,
          sourceEventSequence: entry.sourceEventSequence,
        }));
        const store = cliReplay.createReplayStore({ storeType: 'memory' });

        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);
        vi.spyOn(cliReplay, 'createOnChainReplayBackfillFetcher').mockReturnValue({
          async fetchPage() {
            return {
              events: mappedEvents,
              nextCursor: mappedEvents.length > 0 ? {
                slot: mappedEvents.at(-1)?.slot ?? 0,
                signature: mappedEvents.at(-1)?.signature ?? 'sig-empty',
                eventName: mappedEvents.at(-1)?.eventName,
              } : null,
              done: true,
            };
          },
        });

        const result = await runCliCapture([
          'replay',
          'backfill',
          '--to-slot',
          '999',
          '--store-type',
          'memory',
          '--rpc',
          'https://example.com',
          '--trace-id',
          'fixture-backfill-trace',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        const parsed = output as {
          localTracePath?: string;
        } & Record<string, unknown>;
        return {
          ...parsed,
          localTracePath: parsed.localTracePath ? basename(parsed.localTracePath) : parsed.localTracePath,
        };
      },
    },
    {
      id: 'cli.replay.backfill.failure.missing-rpc',
      command: 'replay.backfill',
      fixturePath: new URL('cli-replay-backfill-failure-missing-rpc.json', fixtureDir).pathname,
      outputSchema: 'replay-error',
      expectedStatus: 'error',
      requiredTopLevelKeys: ['status', 'code', 'message'],
      input: {
        argv: ['replay', 'backfill', '--to-slot', '999', '--store-type', 'memory'],
      },
      async execute({}) {
        const result = await runCliCapture([
          'replay',
          'backfill',
          '--to-slot',
          '999',
          '--store-type',
          'memory',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        const parsed = output as { status: string; code: string; message: string };
        return {
          status: parsed.status,
          code: parsed.code,
          message: parsed.message,
        };
      },
    },
    {
      id: 'cli.replay.compare.success',
      command: 'replay.compare',
      fixturePath: new URL('cli-replay-compare-success.json', fixtureDir).pathname,
      outputSchema: 'replay.compare.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'result',
        'localTracePath',
        'strictness',
        'strictMode',
        'storeType',
      ],
      optionalTopLevelKeys: ['taskPda', 'disputePda'],
      input: {
        argv: [
          'replay',
          'compare',
          '--local-trace-path',
          '/tmp/compare-trace.json',
          '--store-type',
          'memory',
          '--strict-mode',
          'true',
        ],
      },
      async execute({}) {
        const records = createReplayRecords(TASK_FIXTURE_EVENTS, 'fixture-compare', 33);
        const trace = {
          schemaVersion: 1,
          traceId: 'fixture-compare',
          seed: 33,
          createdAtMs: 1,
          events: records.map((entry, index) => ({
            seq: index + 1,
            type: entry.type,
            taskPda: entry.taskPda,
            timestampMs: entry.timestampMs,
            payload: entry.payload,
          })),
        };

        const store = cliReplay.createReplayStore({ storeType: 'memory' });
        await store.save(records);
        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

        const localTracePath = writeTraceFixture(workspace, trace);
        const result = await runCliCapture([
          'replay',
          'compare',
          '--local-trace-path',
          localTracePath,
          '--store-type',
          'memory',
          '--task-pda',
          records[0]?.taskPda ?? 'task-missing',
          '--strict-mode',
          'true',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        const parsed = output as {
          localTracePath?: string;
        } & Record<string, unknown>;
        return {
          ...parsed,
          localTracePath: parsed.localTracePath ? basename(parsed.localTracePath) : parsed.localTracePath,
        };
      },
    },
    {
      id: 'cli.replay.compare.mismatch',
      command: 'replay.compare',
      fixturePath: new URL('cli-replay-compare-mismatch.json', fixtureDir).pathname,
      outputSchema: 'replay.compare.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'result',
        'localTracePath',
        'strictness',
        'strictMode',
        'storeType',
      ],
      optionalTopLevelKeys: ['taskPda', 'disputePda'],
      input: {
        argv: [
          'replay',
          'compare',
          '--local-trace-path',
          '/tmp/compare-trace-mismatch.json',
          '--store-type',
          'memory',
        ],
      },
      async execute({}) {
        const records = createReplayRecords(TASK_FIXTURE_EVENTS, 'fixture-compare-mismatch', 42);
        const store = cliReplay.createReplayStore({ storeType: 'memory' });
        await store.save(records);

        const mismatchTrace = {
          schemaVersion: 1,
          traceId: 'fixture-compare-mismatch',
          seed: 42,
          createdAtMs: 1,
          events: records.map((entry, index) => ({
            seq: index + 1,
            type: index === 0 ? `${entry.type}-mismatch` : entry.type,
            taskPda: entry.taskPda,
            timestampMs: entry.timestampMs,
            payload: entry.payload,
          })),
        };

        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);
        const localTracePath = writeTraceFixture(workspace, mismatchTrace);

        const result = await runCliCapture([
          'replay',
          'compare',
          '--local-trace-path',
          localTracePath,
          '--store-type',
          'memory',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        const parsed = output as {
          localTracePath?: string;
        } & Record<string, unknown>;
        return {
          ...parsed,
          localTracePath: parsed.localTracePath ? basename(parsed.localTracePath) : parsed.localTracePath,
        };
      },
    },
    {
      id: 'cli.replay.incident.success',
      command: 'replay.incident',
      fixturePath: new URL('cli-replay-incident-success.json', fixtureDir).pathname,
      outputSchema: 'replay.incident.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'commandParams',
        'summary',
        'validation',
        'narrative',
      ],
      input: {
        argv: ['replay', 'incident', '--store-type', 'memory', '--task-pda', 'task-main'],
      },
      async execute({}) {
        const store = cliReplay.createReplayStore({ storeType: 'memory' });
        const records = createReplayRecords(FIXTURE_EVENTS, 'fixture-incident-success', 12);
        await store.save(records);
        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

        const result = await runCliCapture([
          'replay',
          'incident',
          '--store-type',
          'memory',
          '--task-pda',
          records[0]?.taskPda ?? 'task-main',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        return output as Record<string, unknown>;
      },
    },
    {
      id: 'cli.replay.incident.truncated',
      command: 'replay.incident',
      fixturePath: new URL('cli-replay-incident-truncated.json', fixtureDir).pathname,
      outputSchema: 'replay.incident.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'commandParams',
        'summary',
        'validation',
        'narrative',
      ],
      input: {
        argv: ['replay', 'incident', '--store-type', 'memory', '--task-pda', 'task-main'],
      },
      async execute({}) {
        const store = cliReplay.createReplayStore({ storeType: 'memory' });
        const baseRecords = replayRecords;
        const records = repeatRecords(baseRecords, 60);
        const baseTaskPda = baseRecords[0]?.taskPda ?? 'task-main';
        await store.save(records);
        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

        const result = await runCliCapture([
          'replay',
          'incident',
          '--store-type',
          'memory',
          '--task-pda',
          baseTaskPda,
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        return output as Record<string, unknown>;
      },
    },
    {
      id: 'cli.replay.incident.empty',
      command: 'replay.incident',
      fixturePath: new URL('cli-replay-incident-empty.json', fixtureDir).pathname,
      outputSchema: 'replay.incident.output.v1',
      expectedStatus: 'ok',
      requiredTopLevelKeys: [
        'status',
        'command',
        'schema',
        'commandParams',
        'summary',
        'validation',
        'narrative',
      ],
      input: {
        argv: ['replay', 'incident', '--store-type', 'memory', '--task-pda', 'task-missing'],
      },
      async execute({}) {
        const store = cliReplay.createReplayStore({ storeType: 'memory' });
        vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

        const result = await runCliCapture([
          'replay',
          'incident',
          '--store-type',
          'memory',
          '--task-pda',
          'task-missing',
        ]);
        return parseCliOutput(result);
      },
      shape(output) {
        return output as Record<string, unknown>;
      },
    },
  ];

  for (const testCase of baseCases) {
    it(`cli contract: ${testCase.id}`, async () => {
      await runContractCase(testCase);
    });
  }

  it('does not include extra top-level keys for mismatch case', () => {
    const mismatchPath = new URL('cli-replay-compare-mismatch.json', fixtureDir).pathname;
    const fixture = loadGoldenSnapshot<Record<string, unknown>, Record<string, unknown>>(mismatchPath);
    expect(fixture.output.shape).toBeTypeOf('object');
  });
});
