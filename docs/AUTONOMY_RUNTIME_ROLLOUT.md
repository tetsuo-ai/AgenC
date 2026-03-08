# Autonomy Runtime Rollout

This document is the production rollout contract for AgenC's durable autonomy runtime.

## Production SLOs

- Run start latency: mean time to first acknowledgement must stay under `1000ms`.
- Update cadence: mean time to first verified update must stay under `10000ms`.
- Completion accuracy: end-state correctness must stay at or above `0.95`.
- Recovery success: restart recovery success must stay at or above `0.90`.
- Stop latency: mean stop latency must stay under `2000ms`.
- Event loss rate: replay inconsistency rate must stay at `0`.

Release automation enforces these targets with `npm --prefix runtime run autonomy:rollout:gates`.

## Feature Flags and Kill Switches

Every major autonomy subsystem must have both a positive feature flag and a kill switch:

- `backgroundRuns`
- `multiAgent`
- `notifications`
- `replayGates`
- `canaryRollout`

Feature flags are the rollout lever. Kill switches are the emergency rollback lever. Broad rollout is blocked if any of them are left implicit.

## Schema Migration and Backward Compatibility

- Persisted autonomy records are forward-migrated by schema version and remain backward-compatible across one schema generation.
- Rollback window: one release train.
- Operators must validate persisted record loading, lease recovery, and run replay before widening rollout.
- Migration playbook: update runtime schema validators, run migration tests, run replay tests, execute rollback drill, then widen canary.

## Canary Rollout Strategy

Autonomy rollout is staged by:

- tenant
- feature
- domain

The runtime hashes a stable session key into a deterministic canary cohort and combines that with explicit allow-lists. This is enforced for background runs and durable multi-agent orchestration before execution begins.

### Canary Success Criteria

- Background-run quality gates stay green.
- No autonomy SLO regression during the canary window.
- Multi-agent delegation benchmarks remain net-positive before enabling durable subruns broadly.
- Rollback drill stays green for the current release train.

## Stuck Runs

Symptoms:

- run remains `working` without fresh verified evidence
- operator sees pending signals that do not drain

Immediate actions:

- inspect the run dashboard
- check wake backlog and worker lease ownership
- pause or cancel if the run is unsafe to continue
- trigger replay reconstruction if event-loss is suspected

## Split-Brain

Symptoms:

- multiple workers believe they own the same run
- duplicate progress or conflicting lease heartbeats appear

Immediate actions:

- verify fencing token progression
- force drain non-owning workers
- confirm only one worker lease remains active
- run replay and lease-recovery validation before resuming canary traffic

## Bad Compaction

Symptoms:

- carry-forward summary drifts from verified evidence
- resumed runs repeat already-completed work or lose blockers

Immediate actions:

- force compaction refresh or retry from checkpoint
- inspect compaction trace metadata and replay bundle
- block the run if verifier state and compacted memory disagree

## Webhook Failure

Symptoms:

- durable wake webhooks stop arriving
- external completion signals remain queued or absent

Immediate actions:

- inspect webhook route health and dead-letter queue
- replay the missed event through the incident bundle flow
- keep the run blocked until deterministic evidence arrives through another wake source

## Policy Regressions

Symptoms:

- previously denied actions now pass
- approval or secret redaction behavior changes unexpectedly

Immediate actions:

- run policy simulation on the affected tool/action
- inspect governance audit records
- toggle the relevant kill switch if unsafe behavior is confirmed

## Rollback and Kill Switches

Rollback is release-blocking and must be validated by drill before widening rollout.

- disable the affected feature flag or raise the matching kill switch
- drain workers before tearing down ownership
- keep persisted run state intact so replay and recovery remain possible
- re-run rollout gates before restoring traffic

## Game Days and Chaos Drills

Required drill set:

- stuck run handling
- split-brain lease recovery
- bad compaction repair
- webhook failure recovery
- policy regression containment
- rollback drill

The machine-readable rollout manifest links each drill to automated coverage.

## External Review Gate

Broad production rollout still requires independent external review for:

- security
- privacy
- compliance

Until those reviews are complete, limited canary rollout can be green while broad rollout remains blocked.
