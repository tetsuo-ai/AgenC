import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  ReplayToolErrorSchema,
} from './replay-types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as unknown;
}

const backfillFixture = readFixture('replay-backfill-output.json') as Record<string, unknown>;
const compareFixture = readFixture('replay-compare-output.json');
const incidentFixture = readFixture('replay-incident-output.json');
const statusFixture = readFixture('replay-status-output.json');
const errorFixture = readFixture('replay-error-output.json');

test('schema contract: backfill fixture', () => {
  const result = ReplayBackfillOutputSchema.safeParse(backfillFixture);
  assert.equal(result.success, true);
});

test('schema contract: compare fixture', () => {
  const result = ReplayCompareOutputSchema.safeParse(compareFixture);
  assert.equal(result.success, true);
});

test('schema contract: incident fixture', () => {
  const result = ReplayIncidentOutputSchema.safeParse(incidentFixture);
  assert.equal(result.success, true);
});

test('schema contract: status fixture', () => {
  const result = ReplayStatusOutputSchema.safeParse(statusFixture);
  assert.equal(result.success, true);
});

test('schema contract: error fixture', () => {
  const result = ReplayToolErrorSchema.safeParse(errorFixture);
  assert.equal(result.success, true);
});

test('schema contract: backfill fixture has required fields', () => {
  assert.equal(backfillFixture.status, 'ok');
  assert.equal(backfillFixture.schema, 'replay.backfill.output.v1');

  const result = backfillFixture.result as { processed?: unknown } | undefined;
  assert.equal(typeof result?.processed, 'number');
  assert.equal(typeof backfillFixture.truncated, 'boolean');
});
