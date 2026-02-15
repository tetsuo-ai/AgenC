# Replay CLI Guide

The replay CLI commands are available under the `replay` root command and are intended for incident reconstruction workflows.

## Commands

### 1) backfill

Backfill ingests on-chain replay events into a selected store.

```bash
agenc-runtime replay backfill \
  --to-slot 1024 \
  --page-size 100 \
  --rpc https://api.mainnet-beta.solana.com \
  --store-type sqlite \
  --sqlite-path .agenc/replay-events.sqlite
```

Successful output schema:

- `status`: `ok`
- `schema`: `replay.backfill.output.v1`
- `result.processed`: number of inserted records
- `result.duplicates`: number of duplicate signature/sequence combinations
- `result.cursor`: persisted cursor snapshot for resume

### 2) compare

Compare projected on-chain replay records against a local trajectory trace.

```bash
agenc-runtime replay compare \
  --local-trace-path ./trace.json \
  --task-pda TaskPDA... \
  --store-type sqlite \
  --sqlite-path .agenc/replay-events.sqlite
```

Successful output schema:

- `status`: `ok`
- `schema`: `replay.compare.output.v1`
- `result.status`: `clean` or `mismatched`
- `result.localEventCount` / `result.projectedEventCount`
- `result.mismatchCount`
- `result.anomalyIds` / `result.topAnomalies`

### 3) incident

Summarize an incident timeline and replay validation state for a task/dispute window.

```bash
agenc-runtime replay incident \
  --task-pda TaskPDA... \
  --from-slot 1000 \
  --to-slot 2048 \
  --store-type sqlite \
  --sqlite-path .agenc/replay-events.sqlite
```

Role enforcement is opt-in. Provide `--role read|investigate|execute|admin` to enforce the incident permission matrix.

You can also provide a structured analyst query DSL:

```bash
agenc-runtime replay incident \
  --query "taskPda=TaskPDA... slotRange=1000-2048 eventType=discovered" \
  --store-type sqlite \
  --sqlite-path .agenc/replay-events.sqlite
```

Successful output schema:

- `status`: `ok`
- `schema`: `replay.incident.output.v1`
- `summary` object with event counts and grouped counts
- `validation` object with `errors`, `warnings`, and `replayTaskCount`
- `narrative.lines`: ordered reconstruction lines

## Deterministic troubleshooting flow

1. Seed deterministic fixtures and store type with no background writes.
2. Start with `replay backfill` against a small slot window.
3. Validate with `replay compare` using the same task/dispute scope.
4. Use `replay incident` to build replay lines and anomaly IDs.
5. Persist JSON payloads as evidence for post-incident analysis.

## Related docs

- `runtime/docs/observability-incident-runbook.md`
- `runtime/docs/observability-epic-920.md`
