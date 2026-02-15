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
const SCHEMA_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/replay-cli/replay-cli-output-schemas.json', import.meta.url), 'utf8'),
);

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

function toTopLevelKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort();
}

function assertOutputSchema(payload: Record<string, unknown>, expectedSchema: string, expectedCommand: string, schemaDef: { requiredTopLevel: string[]; optionalTopLevel?: string[] }): void {
  expect(payload.status).toBe('ok');
  expect(payload.schema).toBe(expectedSchema);
  expect(payload.command).toBe(expectedCommand);

  const requiredKeys = new Set(schemaDef.requiredTopLevel);
  const optionalKeys = new Set(schemaDef.optionalTopLevel ?? []);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);

  for (const key of requiredKeys) {
    expect(key in payload).toBe(true);
  }

  const actualKeys = toTopLevelKeys(payload);
  for (const key of actualKeys) {
    if (requiredKeys.has(key) || optionalKeys.has(key)) {
      continue;
    }
    if (schemaDef.optionalTopLevel === undefined) {
      continue;
    }
    throw new Error(`unexpected replay cli payload key: ${key}`);
  }
}

function assertResultKeys(result: Record<string, unknown>, required: string[]): void {
  const keys = new Set(Object.keys(result));
  for (const key of required) {
    expect(keys.has(key)).toBe(true);
  }
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
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;

    assertOutputSchema(
      payload,
      SCHEMA_FIXTURE.compare.schemaValue,
      SCHEMA_FIXTURE.compare.commandValue,
      SCHEMA_FIXTURE.compare,
    );
    assertResultKeys(payload.result as Record<string, unknown>, SCHEMA_FIXTURE.compare.resultRequired);

    expect((payload.result as Record<string, unknown>).status).toBe('clean');
    expect((payload.result as Record<string, unknown>).anomalyIds).toHaveLength(0);
    expect((payload.result as Record<string, unknown>).topAnomalies).toHaveLength(0);
    expect(payload.strictMode).toBe(false);
    expect((payload.result as Record<string, unknown>).strictness).toBe('lenient');
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
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assertOutputSchema(
      payload,
      SCHEMA_FIXTURE.compare.schemaValue,
      SCHEMA_FIXTURE.compare.commandValue,
      SCHEMA_FIXTURE.compare,
    );
    assertResultKeys(payload.result as Record<string, unknown>, SCHEMA_FIXTURE.compare.resultRequired);

    expect((payload.result as Record<string, unknown>).status).toBe('mismatched');
    expect((payload.result as Record<string, unknown>).mismatchCount).toBeGreaterThan(0);
  });

  it('redacts requested replay compare fields when --redact-fields is set', async () => {
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
    const signature = records[0]?.signature ?? 'SIG_MISSING';

    const result = await runCliCapture([
      'replay',
      'compare',
      '--local-trace-path',
      localTracePath,
      '--store-type',
      'memory',
      '--redact-fields',
      'signature',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(signature);

    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const topAnomalies = (payload.result as Record<string, unknown>).topAnomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(topAnomalies)).toBe(true);
    expect(topAnomalies.some((entry) => entry.signature === '[REDACTED]')).toBe(true);
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
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assertOutputSchema(
      payload,
      SCHEMA_FIXTURE.incident.schemaValue,
      SCHEMA_FIXTURE.incident.commandValue,
      SCHEMA_FIXTURE.incident,
    );
    assertResultKeys(payload.summary as Record<string, unknown>, SCHEMA_FIXTURE.incident.summaryRequired);
    assertResultKeys(payload.validation as Record<string, unknown>, SCHEMA_FIXTURE.incident.validationRequired);
    assertResultKeys(payload.narrative as Record<string, unknown>, SCHEMA_FIXTURE.incident.narrativeRequired);

    expect(payload.schema).toBe('replay.incident.output.v1');
    expect(payload.summary.totalEvents).toBeGreaterThan(0);
    expect(payload.summary.taskPdaFilters).toEqual([projection.events[0]?.taskPda]);
    expect(payload.commandParams.taskPda).toBe(projection.events[0]?.taskPda);
    expect(payload.validation.strictMode).toBe(false);
  });

  it('redacts incident narrative/signatures when --redact-fields is set', async () => {
    const projection = projectOnChainEvents(FIXTURE_EVENTS, {
      traceId: 'fixture-replay',
      seed: 99,
    });
    const records = buildReplayRecords(FIXTURE_EVENTS, 'fixture-replay', projection.trace.seed);
    const store = cliReplay.createReplayStore({ storeType: 'memory' });
    await store.save(records);
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);

    const signature = records[0]?.signature ?? 'SIG_MISSING';

    const result = await runCliCapture([
      'replay',
      'incident',
      '--store-type',
      'memory',
      '--task-pda',
      projection.events[0]?.taskPda ?? 'task-missing',
      '--redact-fields',
      'signature,task_pda,dispute_pda',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(signature);

    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect((payload.commandParams as Record<string, unknown>).taskPda).toBe('[REDACTED]');
    expect(((payload.summary as Record<string, unknown>).events as Array<Record<string, unknown>>)[0]?.signature).toBe('[REDACTED]');
    expect(((payload.narrative as Record<string, unknown>).lines as string[])[0]).toContain('[REDACTED]');
  });

  it('populates disputePda on incident summary from dispute event payloads', async () => {
    const disputeEvents = FIXTURE_EVENTS.filter(
      (entry) => entry.eventName.startsWith('dispute') || entry.eventName.startsWith('task'),
    );
    const projection = projectOnChainEvents(disputeEvents, {
      traceId: 'fixture-dispute',
      seed: 99,
    });
    const records = buildReplayRecords(disputeEvents, 'fixture-dispute', projection.trace.seed);
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
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;
    const uniqueDisputeIds = summary.uniqueDisputeIds as string[];
    expect(Array.isArray(uniqueDisputeIds)).toBe(true);

    const events = summary.events as Array<Record<string, unknown>>;
    const disputeEvent = events.find((entry) => entry.sourceEventName === 'disputeInitiated');
    expect(disputeEvent).toBeDefined();
    expect(typeof disputeEvent!.disputePda).toBe('string');
    expect((disputeEvent!.disputePda as string).length).toBeGreaterThan(0);
  });

  it('emits a sealed evidence pack when --sealed is set', async () => {
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
      '--sealed',
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;

    assertOutputSchema(
      payload,
      SCHEMA_FIXTURE.incident.schemaValue,
      SCHEMA_FIXTURE.incident.commandValue,
      {
        ...SCHEMA_FIXTURE.incident,
        optionalTopLevel: [...(SCHEMA_FIXTURE.incident.optionalTopLevel ?? []), 'evidencePack'],
      },
    );

    expect((payload.commandParams as Record<string, unknown>).sealed).toBe(true);
    const evidencePack = payload.evidencePack as Record<string, unknown>;
    expect(typeof evidencePack).toBe('object');
    expect(evidencePack).toBeTruthy();
    expect(typeof (evidencePack.manifest as Record<string, unknown>).queryHash).toBe('string');
    const files = evidencePack.files as Record<string, unknown>;
    expect(typeof files['manifest.json']).toBe('string');
    expect(typeof files['incident-case.jsonl']).toBe('string');
    expect(typeof files['events.jsonl']).toBe('string');
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
    assertOutputSchema(
      payload,
      SCHEMA_FIXTURE.backfill.schemaValue,
      SCHEMA_FIXTURE.backfill.commandValue,
      SCHEMA_FIXTURE.backfill,
    );
    assertResultKeys(payload.result as Record<string, unknown>, SCHEMA_FIXTURE.backfill.resultRequired);

    expect(payload.result.processed).toBeGreaterThan(0);
    expect(payload.result.duplicates).toBe(0);
  });
});
