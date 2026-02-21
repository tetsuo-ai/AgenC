import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_SCHEMA_CHANGELOG,
  getSchemaChanges,
  hasBreakingChanges,
} from "./replay-changelog.js";
import {
  REPLAY_BACKFILL_OUTPUT_SCHEMA,
  REPLAY_COMPARE_OUTPUT_SCHEMA,
  REPLAY_INCIDENT_OUTPUT_SCHEMA,
  REPLAY_STATUS_OUTPUT_SCHEMA,
} from "./replay-types.js";

const VALID_SCHEMAS = [
  REPLAY_BACKFILL_OUTPUT_SCHEMA,
  REPLAY_COMPARE_OUTPUT_SCHEMA,
  REPLAY_INCIDENT_OUTPUT_SCHEMA,
  REPLAY_STATUS_OUTPUT_SCHEMA,
];

test("schema changelog lint: valid schema names", () => {
  for (const entry of REPLAY_SCHEMA_CHANGELOG) {
    assert.ok(
      VALID_SCHEMAS.includes(entry.schema),
      `Invalid schema name: ${entry.schema}`,
    );
  }
});

test("schema changelog lint: valid dates", () => {
  for (const entry of REPLAY_SCHEMA_CHANGELOG) {
    assert.ok(
      /^\d{4}-\d{2}-\d{2}$/.test(entry.date),
      `Invalid date format: ${entry.date}`,
    );
  }
});

test("schema changelog lint: valid change types", () => {
  for (const entry of REPLAY_SCHEMA_CHANGELOG) {
    assert.ok(
      ["breaking", "additive", "deprecation"].includes(entry.changeType),
      `Invalid changeType: ${entry.changeType}`,
    );
  }
});

test("schema changelog lint: breaking changes require migration", () => {
  for (const entry of REPLAY_SCHEMA_CHANGELOG) {
    if (entry.changeType === "breaking") {
      assert.ok(
        entry.migration !== undefined && entry.migration.length > 0,
        `Breaking change in ${entry.schema} at ${entry.version} missing migration instructions`,
      );
    }
  }
});

test("schema changelog lint: entries are chronological per schema", () => {
  for (const schema of VALID_SCHEMAS) {
    const entries = REPLAY_SCHEMA_CHANGELOG.filter(
      (entry) => entry.schema === schema,
    );
    for (let i = 1; i < entries.length; i += 1) {
      assert.ok(
        entries[i].date >= entries[i - 1].date,
        `Changelog entries for ${schema} are not in chronological order`,
      );
    }
  }
});

test("getSchemaChanges: filter by schema", () => {
  const entries = getSchemaChanges(REPLAY_BACKFILL_OUTPUT_SCHEMA);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.schema, REPLAY_BACKFILL_OUTPUT_SCHEMA);
  }
});

test("hasBreakingChanges: no breaking", () => {
  assert.equal(
    hasBreakingChanges(REPLAY_BACKFILL_OUTPUT_SCHEMA, "0.1.0", "0.1.1"),
    false,
  );
});
