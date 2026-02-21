import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { computeSchemaHash } from "../utils/schema-hash.js";
import {
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  REPLAY_BACKFILL_OUTPUT_SCHEMA,
  REPLAY_COMPARE_OUTPUT_SCHEMA,
  REPLAY_INCIDENT_OUTPUT_SCHEMA,
  REPLAY_STATUS_OUTPUT_SCHEMA,
  REPLAY_SCHEMA_HASHES,
} from "./replay-types.js";

const PINNED_HASHES = {
  [REPLAY_BACKFILL_OUTPUT_SCHEMA]: "a98f92cd016e3338",
  [REPLAY_COMPARE_OUTPUT_SCHEMA]: "6827a16d81fa9dbb",
  [REPLAY_INCIDENT_OUTPUT_SCHEMA]: "c237bc370cdd5241",
  [REPLAY_STATUS_OUTPUT_SCHEMA]: "7fbe5363088b59e7",
} as const;

test("schema hash: deterministic", () => {
  const hash1 = computeSchemaHash(ReplayBackfillOutputSchema);
  const hash2 = computeSchemaHash(ReplayBackfillOutputSchema);
  assert.equal(hash1, hash2);
});

test("schema hash: different schemas", () => {
  const backfillHash = computeSchemaHash(ReplayBackfillOutputSchema);
  const statusHash = computeSchemaHash(ReplayStatusOutputSchema);
  assert.notEqual(backfillHash, statusHash);
});

test("schema hash: pinned backfill", () => {
  const hash = computeSchemaHash(ReplayBackfillOutputSchema);
  assert.equal(
    hash,
    PINNED_HASHES[REPLAY_BACKFILL_OUTPUT_SCHEMA],
    "Backfill schema changed. Update PINNED_HASHES and add a changelog entry.",
  );
});

test("schema hash: pinned compare", () => {
  const hash = computeSchemaHash(ReplayCompareOutputSchema);
  assert.equal(
    hash,
    PINNED_HASHES[REPLAY_COMPARE_OUTPUT_SCHEMA],
    "Compare schema changed. Update PINNED_HASHES and add a changelog entry.",
  );
});

test("schema hash: pinned incident", () => {
  const hash = computeSchemaHash(ReplayIncidentOutputSchema);
  assert.equal(
    hash,
    PINNED_HASHES[REPLAY_INCIDENT_OUTPUT_SCHEMA],
    "Incident schema changed. Update PINNED_HASHES and add a changelog entry.",
  );
});

test("schema hash: pinned status", () => {
  const hash = computeSchemaHash(ReplayStatusOutputSchema);
  assert.equal(
    hash,
    PINNED_HASHES[REPLAY_STATUS_OUTPUT_SCHEMA],
    "Status schema changed. Update PINNED_HASHES and add a changelog entry.",
  );
});

test("schema hash: field addition detected", () => {
  const base = z.object({ a: z.string() });
  const extended = base.extend({ b: z.number() });
  assert.notEqual(computeSchemaHash(base), computeSchemaHash(extended));
});

test("schema hash: field removal detected", () => {
  const base = z.object({ a: z.string(), b: z.number() });
  const removed = base.omit({ b: true });
  assert.notEqual(computeSchemaHash(base), computeSchemaHash(removed));
});

test("schema hash: module hashes match pinned values", () => {
  assert.deepEqual(REPLAY_SCHEMA_HASHES, PINNED_HASHES);
});
