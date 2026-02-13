# Deterministic Observability and Replay Pipeline (Epic #920)

This document defines the execution contract for issues `#920` → `#941`.

## Objectives

- Convert on-chain AgenC protocol events into canonical, deterministic timeline records.
- Support replay, backfill, diff, and anomaly detection for incident reconstruction.
- Keep the runtime integration optional so normal agent execution behavior is unchanged by default.
- Preserve deterministic outputs for the same input event stream across environments.

## End-to-end Runtime Architecture

```
Anchor Events
  -> event parsers (existing runtime events)
  -> projector (new trajectory-level canonical records)
  -> storage/replay sink (checkpointed)
  -> validator (transition checks)
  -> comparator (against local trajectory replay)
  -> reports/anomalies
```

### Canonical event stages

1. **Input**
   - Parsed on-chain runtime events with `(slot, signature, eventName)` identity.
2. **Projection**
   - Deterministic normalization into `taskId` / `disputeId` / `agentId` keyed records.
   - Includes `traceType` and lifecycle context.
3. **Persistence**
   - Cursor checkpointed by latest `(slot, signature, eventSeq)`.
   - Idempotent writes keyed by event tuple.
4. **Validation**
   - Transition integrity checks for task/dispute/speculation.
5. **Compare**
   - Timeline compare against local deterministic trajectory replay output.
   - Produce mismatch, hash, and provenance details.

## Deterministic contract

- Stable ordering: `(slot asc, signature asc, eventSeq asc)`.
- Stable output IDs: `traceId`/`recordId` derived from canonical JSON input only.
- Deterministic duplicate handling: duplicate `(slot, signature, eventName)` entries are ignored with explicit telemetry.
- Unknown event variants never crash the pipeline; they are recorded in telemetry and continue.
- Incident runbook and schema examples are tracked in
  `runtime/docs/observability-incident-runbook.md`.

## Trace propagation behavior (#932)

- Replay bridge events now ensure each ingested input has a deterministic `traceContext` for projection and persistence.
- Missing trace context is synthesized from `(slot, signature, eventName, sourceEventSequence)` using `buildReplayTraceContext`.
- Backfill writes trace identifiers into both `ReplayTimelineRecord` rows and cursor checkpoints to preserve resume continuity.
- `ReplayComparisonService` emits an optional internal span around comparison and can attach anomaly reporting/metrics under `replay.compare`.
- Optional OpenTelemetry output is controlled by `replay.tracing.emitOtel` and uses best-effort loading of `@opentelemetry/api`; when unavailable, operations remain no-op without changing runtime behavior.
- Span names follow deterministic patterns:
  - `replay.intake[slot=...,signature=...]`
  - `replay.projector[slot=...,signature=...]`
  - `replay.store.save[slot=...,signature=...]`
  - `replay.backfill.page[slot=...,signature=...]`
  - `replay.compare[slot=...,signature=...]`

## Issue execution chain

- Baseline:
  - `#921` Runtime event surface complete (already completed).
  - `#922` Projection module.
  - `#923` Persistent checkpoint + backfill.
  - `#924` Replay comparison and anomaly reporting.
  - `#925` Runtime integration.
  - `#926` Quality pass.
- Hardening:
  - `#928` IDL drift guard.
  - `#929` Lifecycle validation.
  - `#927` Hardening/operations packaging.
  - `#930` Pluggable storage.
  - `#932` Trace propagation.
  - `#933` Chaos/robustness tests.
  - `#931` Structured alerts.
  - `#934` Ops docs and runbooks.
- Operator access:
  - `#935` Incident replay CLI.
  - `#936` CLI foundation.
  - `#937` Backfill/compare/incident commands.
  - `#938` CLI fixtures and schema tests.
- MCP:
  - `#939` MCP replay tools.
  - `#940` MCP policy/security controls.
  - `#941` MCP test + doc hardening.

## Required outcomes

- Deterministic replay outputs are reproducible for the same event set.
- Incident windows can be reconstructed from signatures/cursors.
- High-risk lifecycle violations (disputes/task transitions/speculation outcomes) are surfaced with stable anomaly records.

## Operator defaults

- Replay bridge is opt-in at runtime/CLI.
- Replay services remain disabled unless explicitly enabled.
- Alerts are optional and default to no-op.
