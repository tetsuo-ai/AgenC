# Emergency Response Matrix

This matrix maps replay and protocol anomaly signals to immediate operator actions.
It is intended for on-call response during deployments, upgrades, and incident triage.

Coverage requirements:
- All `ReplayAnomalyCode` values emitted as `replay.compare.<code>` alerts
- All `ReplayAlertKind` values emitted by `runtime/src/replay/alerting.ts`

Sources of truth:
- `runtime/src/eval/replay-comparison.ts` (alert `code` + `kind` mapping)
- `runtime/src/replay/bridge.ts` (ingestion lag alert)

---

## Matrix

| Code | Kind | Severity | Symptom | Action | Escalation | Automated check | SLA |
|---|---|---|---|---|---|---|---|
| `replay.compare.hash_mismatch` | `replay_hash_mismatch` | critical | Replay deterministic hash mismatch between local and projected | Halt new task assignments for affected scope. Re-run compare on narrowed window. Preserve evidence payloads. | Security lead + on-call engineer | `agenc-runtime replay compare ...` on narrowed window | 15 minutes |
| `replay.compare.transition_invalid` | `transition_validation` | high | Invalid state transition detected in replay | Isolate affected task/dispute PDA. Re-backfill slot range and re-run incident reconstruction. | On-call engineer | `agenc-runtime replay incident ...` for the window | 30 minutes |
| `replay.compare.missing_event` | `replay_anomaly_repeat` | high | Expected event is missing in projected timeline | Re-backfill with smaller page size. Check RPC health and projector logs. | On-call engineer | `agenc-runtime replay backfill ...` and verify processed > 0 | 30 minutes |
| `replay.compare.unexpected_event` | `replay_anomaly_repeat` | high | Extra event present that should not exist | Verify slot/signature for duplicate ingestion. Inspect event parser inputs for replay. | On-call engineer | `agenc-runtime replay incident ...` and inspect anomalies | 30 minutes |
| `replay.compare.type_mismatch` | `replay_anomaly_repeat` | high | Event type differs between local and projected trace | Check concurrent transactions in same slot; validate ordering assumptions. | On-call engineer | `agenc-runtime replay compare ...` strictness=lenient then strict | 30 minutes |
| `replay.compare.task_id_mismatch` | `replay_anomaly_repeat` | high | Task/dispute association mismatched for an event | Freeze affected agent if suspicious. Verify on-chain state for referenced PDAs. | Security lead | `agenc_get_task` / `agenc_get_dispute` for referenced PDAs | 30 minutes |
| `replay.compare.duplicate_sequence` | `replay_anomaly_repeat` | medium | Duplicate sequence numbers detected | Inspect store for duplicate keys. Re-run backfill from cursor. | On-call engineer | Re-run backfill with cursor reset in a fresh store | 1 hour |
| `replay.ingestion.lag` | `replay_ingestion_lag` | medium | Event slot regression detected for a source event stream | Check RPC health and source clock. Switch to alternate RPC endpoint. | On-call engineer | Readiness: switch RPC + re-run backfill | 1 hour |
| `vk.gamma_eq_delta` | n/a | critical | Verifying key gamma equals delta (dev key in production) | Halt all private task completions. Trigger MPC ceremony process. | All multisig signers | `./scripts/validate-verifying-key.sh` | Immediate |
| `nullifier.already_spent` | n/a | critical | Proof replay detected | Freeze affected agent. Investigate double-spend and affected tasks. | Security lead | Query nullifier store / audit logs | Immediate |
| `escrow.balance.sudden_drop` | n/a | critical | Escrow balance dropped > 90% in a single block | Pause protocol if possible. Audit recent completions and distributions. | All multisig signers | `agenc_get_escrow` diffs for affected tasks | 15 minutes |
| `rate_limit.exceeded` | n/a | low | Agent hit rate limit | No action required; informational unless repeated. | None | None | N/A |

---

## Coverage checklist

Replay compare anomaly codes (emitted as `replay.compare.<code>`):
- [x] `hash_mismatch`
- [x] `missing_event`
- [x] `unexpected_event`
- [x] `type_mismatch`
- [x] `task_id_mismatch`
- [x] `duplicate_sequence`
- [x] `transition_invalid`

Replay alert kinds:
- [x] `transition_validation`
- [x] `replay_hash_mismatch`
- [x] `replay_anomaly_repeat`
- [x] `replay_ingestion_lag`

