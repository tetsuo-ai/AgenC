# Replay CLI Guide

The replay CLI commands are available under the `replay` root command and are intended for incident reconstruction workflows.

## Bootstrap commands

The runtime CLI also provides operator bootstrap and diagnostics commands. All three commands return deterministic exit codes:

- `0`: healthy (all checks passed)
- `1`: degraded (warnings present)
- `2`: unhealthy (failures present)

### 1) onboard

Generate a runtime config file (default: `.agenc-runtime.json`) and run basic environment checks.

```bash
agenc-runtime onboard \
  --force \
  --rpc https://api.devnet.solana.com \
  --store-type sqlite \
  --sqlite-path .agenc/replay-events.sqlite
```

### 2) health

Report RPC reachability, replay store status, wallet availability, and config validity.

```bash
agenc-runtime health --deep
```

### 3) doctor

Run all health checks and surface remediation guidance. Use `--fix` to attempt safe automatic remediation where possible.

```bash
agenc-runtime doctor --deep --fix
```

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
