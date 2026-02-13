# Replay Incident Runbook

This playbook is for reconstructing and triaging replay anomalies in production.
It maps common incidents to deterministic steps and expected payload shapes.

## Prerequisites

- Replay enabled with deterministic tracing policy.
- A stable `traceId` for the investigation window.
- Access to either:
  - runtime replay APIs (`AgentRuntime`, `ReplayEventBridge`, stores), or
  - CLI replay commands introduced in issue #935.

Recommended config for forensic windows:

```ts
import { AgentRuntime } from '@agenc/runtime';

const runtime = new AgentRuntime({
  replay: {
    enabled: true,
    traceId: 'incident-2026-02-13',
    tracing: {
      sampleRate: 1,
    },
    store: {
      type: 'sqlite',
      sqlitePath: '.agenc/replay-events.sqlite',
    },
    backfill: {
      toSlot: 9_000_000,
      pageSize: 200,
    },
    retention: {
      ttlMs: 86_400_000,
      maxEventsTotal: 200_000,
    },
  },
});
```

## 1) Backfill window

Backfill should replay on-chain events for the incident window only:

1. Set `toSlot` to the incident end slot.
2. Start from `cursor = null` unless re-run after a partial result.
3. Use fixed `pageSize` and deterministic fetch ordering (`slot`, `signature`, `eventName`).
4. Persist cursor and compare replay report between runs.

Expected summary fields:

- `processed`: newly inserted projected events.
- `duplicates`: duplicate event rows ignored by event key.
- `cursor`: next cursor `{ slot, signature, eventName?, traceId?, traceSpanId? }`.

Failure handling:

- if cursor stalls, rerun with same inputs; stalled window should be reproducible.
- if `runBackfill()` fails, retry after fixing source fetcher only; do not mutate the store policy.

## 2) Comparison workflow

1. Build the local trajectory target trace from the worker run.
2. Compare with projected records through `ReplayComparisonService`.
3. Persist report snapshot plus output hash before acting on remediation.

Interpreting outcomes:

- `status = 'matched'`: hashes and timeline are aligned.
- `status = 'mismatched'`: inspect first mismatch list and compare event IDs.
- `status = 'invalid_input'`: strict input validation failed before replay could continue.

## 3) Interpreting mismatch and transition reports

### Anomaly record schema

```json
{
  "id": "string",
  "code": "replay.compare.hash_mismatch",
  "kind": "replay_hash_mismatch",
  "severity": "error",
  "message": "deterministic replay hash mismatch",
  "taskPda": "TaskPda...",
  "disputePda": "DisputePda...",
  "sourceEventName": "taskCompleted",
  "signature": "SIG_...",
  "slot": 12345,
  "traceId": "incident-2026-02-13",
  "repeatCount": 2,
  "emittedAtMs": 1707820000000,
  "metadata": {
    "strictness": "lenient",
    "localReplayHash": "a1b2...",
    "projectedReplayHash": "c3d4..."
  }
}
```

`metadata.localReplayHash` and `metadata.projectedReplayHash` should be compared first; if different,
continue with event-level diffs.

### Replay cursor schema

```json
{
  "slot": 100021,
  "signature": "SIG_TASK_COMPLETED_DUP",
  "eventName": "taskCompleted",
  "traceId": "incident-2026-02-13",
  "traceSpanId": "8f0a..."
}
```

Use this cursor to resume precisely from last processed event when rerunning backfill.

## Alert triage playbook

1. Group by `(code, kind, slot, signature, taskPda)`.
2. Verify event source consistency for the grouped window.
3. Re-run backfill for the smallest reproducible slot range containing the alert.
4. If transition violations repeat with same IDs, inspect actor/state drift in source data.
5. If transition violations are one-time and hashes align, mark as benign race ordering.

## Reproduction snippets

### Minimal fixture-driven reproduction

```ts
import { REPLAY_QUALITY_FIXTURE_V1 } from '../tests/fixtures/replay-quality-fixture.v1.ts';
import { projectOnChainEvents } from '../src/eval/projector.js';
import { TrajectoryReplayEngine, ReplayComparisonService } from '@agenc/runtime';

const projected = projectOnChainEvents(REPLAY_QUALITY_FIXTURE_V1.onChainEvents, {
  traceId: REPLAY_QUALITY_FIXTURE_V1.traceId,
  seed: REPLAY_QUALITY_FIXTURE_V1.seed,
});

const local = new TrajectoryReplayEngine({ strictMode: true }).replay(projected.trace);
const comparison = await new ReplayComparisonService().compare({
  projected: projected.events,
  localTrace: local,
  options: { strictness: 'lenient', traceId: 'incident-repro' },
});

console.log(comparison.status, comparison.report.mismatchCount);
```

## Known fast checks (15-minute target)

- Backfill can resume from latest cursor after failure.
- Replay comparison output shape is stable between re-runs.
- At least one strict transition anomaly list can be reproduced with a fixture.
- Cursor + anomaly payloads are retained with full traceId + span identifiers.
