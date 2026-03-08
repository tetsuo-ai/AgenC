# Incident Replay Runbook (CLI + MCP)

This runbook provides a deterministic, command-by-command workflow for replay-based incident reconstruction.
It covers both the CLI (`agenc-runtime replay ...`) and MCP tool paths (`agenc_replay_*`).

For runtime LLM/tool-pipeline incidents (context growth, tool-turn ordering, desktop hangs, delegation orchestration), use:
`docs/RUNTIME_PIPELINE_DEBUG_BUNDLE.md`.

---

## Runtime Pipeline How-To Debug (Minimal Repro Templates)

Use these minimal templates before deep replay analysis. They are designed to fail fast and isolate one class of issue.

### 1) Context growth regression template

```bash
cd runtime
npm run benchmark:pipeline:ci
npm run benchmark:pipeline:gates
```

Expected:

- `Pipeline quality gates: PASS`
- `context growth slope` and `max delta` stay under CI thresholds.

### 1b) Background-run autonomy regression template

Use this when a durable run stalls, completes without evidence, blocks silently, or fails to recover after restart.

```bash
cd runtime
npm run benchmark:background-runs:ci
npm run benchmark:background-runs:gates
```

Expected:

- `Background-run quality gates passed.`
- artifact written to `benchmarks/artifacts/background-run-quality.ci.json`
- `falseCompletionRate == 0`
- `blockedWithoutNoticeRate == 0`
- `replayInconsistencies == 0`

To inspect one artifact manually:

```bash
cat benchmarks/artifacts/background-run-quality.ci.json | jq '.scenarios[] | {scenarioId, finalState, replayConsistent, falseCompletion, blockedWithoutNotice}'
```

### 2) Tool-turn ordering validation template

Malformed sequence (must be rejected locally with `validation_error`, not forwarded):

```json
{
  "messages": [
    { "role": "user", "content": "test" },
    { "role": "assistant", "content": "" },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"stdout\":\"\",\"exitCode\":0}" }
  ]
}
```

Control sequence (must pass):

```json
{
  "messages": [
    { "role": "user", "content": "test" },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "call_1",
          "type": "function",
          "function": { "name": "system.bash", "arguments": "{\"command\":\"echo\",\"args\":[\"hi\"]}" }
        }
      ]
    },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"stdout\":\"hi\\n\",\"exitCode\":0}" }
  ]
}
```

### 3) Desktop hang/timeout template

```bash
npm --prefix runtime run repro:pipeline:http
```

Expected output shape:

- JSON with `overall`
- ordered `steps[]`
- no indefinite stall between server-start and teardown steps.

### 4) Stateful continuation mismatch template

Symptoms:

- `statefulResponses.enabled: true`
- `statefulSummary.fallbackCalls > 0`
- explicit fallback reason appears (`missing_previous_response_id`, `provider_retrieval_failure`, `state_reconciliation_mismatch`)

Expected:

- Runtime falls back deterministically (if configured) and does not silently reuse stale anchors.

### 4b) Compacted run inspection template

Use this when a long-running run resumes with missing facts, stale artifacts, or suspicious summary drift.

Inspect the traced response and durable run state for:

- `compaction.enabled`, `compaction.requested`, `compaction.active`
- `compaction.fallbackReason`
- `compaction.observedItemCount`
- `compaction.latestItem`
- `stateful.previousResponseId`
- durable carry-forward counts for:
  - `verifiedFacts`
  - `artifacts`
  - `memoryAnchors`
  - `summaryHealth`

Expected:

- fact/artifact counts do not drop unexpectedly across compaction boundaries
- `summaryHealth.status` only moves to `repairing` or `degraded` when drift was actually detected
- provider continuation anchors (`previous_response_id` / opaque compaction items) line up with the latest persisted durable run snapshot

### 5) Trace capture template

Enable:

```json
{
  "logging": {
    "trace": {
      "enabled": true,
      "includeHistory": true,
      "includeSystemPrompt": true,
      "includeToolArgs": true,
      "includeToolResults": true
    }
  }
}
```

Capture one `traceId`-correlated chain:

- `*.inbound`
- `*.chat.request`
- `*.tool.call`/`*.tool.result`/`*.tool.error`
- `*.chat.response`

Then disable trace again after triage.

### 6) Delegation orchestration regression template

```bash
npm --prefix runtime run benchmark:delegation:ci
npm --prefix runtime run benchmark:delegation:gates
```

Expected:

- delegation gate output reports `PASS`
- harmful delegation and runaway caps remain within thresholds
- pass@k and pass^k deltas do not regress below required baselines

Check artifact fields in `benchmarks/artifacts/delegation-quality.ci.json`:

- `delegation.delegationAttemptRate`
- `delegation.usefulDelegationRate`
- `delegation.harmfulDelegationRate`
- `delegation.depthCapHitRate`
- `delegation.fanoutCapHitRate`
- `delegation.passAtKDeltaVsBaseline`
- `delegation.passCaretKDeltaVsBaseline`

### 7) Decomposition search template

```bash
npm --prefix runtime run benchmark:decomposition-search
```

Expected output:

- JSON artifact written to `benchmarks/artifacts/decomposition-search.latest.json`
- includes `paretoFrontierIds[]` and `promotedVariantIds[]`
- promoted variants satisfy quality/cost/latency promotion gates

### 8) Delegation learning diagnostics template

When investigating routing drift or unstable delegation behavior, capture one traced turn and inspect:

- `plannerSummary.delegationDecision`
- `plannerSummary.delegationPolicyTuning`
- `plannerSummary.subagentVerification`
- `plannerSummary.diagnostics`
- `stopReason` + `stopReasonDetail`

Expected:

- arm selection reason is explicit (`initial_exploration`, `epsilon_exploration`, `ucb_exploitation`, `fallback`)
- tuned threshold is present when policy learning is enabled
- final reward signal is present after turn completion
- useful-delegation proxy fields are present for delegated turns (`usefulDelegation`, `usefulDelegationScore`, `rewardProxyVersion`)
- hard-block and handoff-confidence vetoes are explicit in `plannerSummary.delegationDecision.reason`
- overloaded child scopes surface `subagent_step_needs_decomposition` or `planner_runtime_refinement_retry` instead of repeating generic `validation_error` failures
- delegated `execute_with_agent` trace entries include raw objective/contract/acceptance summaries plus child validation and nested tool-call outcomes; inspect those fields before trusting collapsed UI status cards
- post-tool summary calls (`tool_followup`, `planner_synthesis`) now receive a runtime-injected authoritative execution ledger system message; inspect that ledger when verifying whether the final answer had enough external grounding
- for Grok-backed research turns, confirm whether routed tools included `web_search` and whether `providerEvidence.citations` was populated before assuming browser MCP was the intended evidence path
- if `llm.webSearch=true`, also confirm the selected Grok model actually supports xAI server-side tools; unsupported models such as `grok-code-fast-1` must not have `web_search` advertised or injected
- for terminal-window incidents, inspect routed tools for `mcp.kitty.launch` / `mcp.kitty.close` and check whether a cached route was invalidated on an open-vs-close action shift before blaming the desktop tools
- if runtime aggressiveness override is active, `/delegation status` shows profile and effective threshold

---

## CLI path

### Backfill replay events for the incident window

**Prerequisites**
- [ ] `agenc-runtime` is installed and on `$PATH`
- [ ] RPC URL for the target cluster
- [ ] Write access to the replay store path (recommended: `.agenc/replay-events.sqlite`)

**Steps**
1. Backfill events into a local sqlite store:
   ```bash
   agenc-runtime replay backfill \
     --to-slot <TO_SLOT> \
     --page-size 100 \
     --rpc <RPC_URL> \
     --store-type sqlite \
     --sqlite-path .agenc/replay-events.sqlite
   ```

**Expected Output**
```
status: ok
schema: replay.backfill.output.v1
result.processed: <number>
result.duplicates: <number>
result.cursor: <object|null>
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| output is `status: error` with `code: replay.timeout` | RPC slow or window too large | retry with smaller slot window or faster RPC |
| cursor stalls (same cursor on repeated runs) | RPC instability or nondeterministic fetch ordering | rerun with the same inputs; if still stalled, switch RPC and retry |
| store write fails | filesystem permissions | fix permissions and rerun |

### Compare replay projection vs local trajectory trace

**Prerequisites**
- [ ] Local trace JSON available (e.g. `./trace.json`)
- [ ] Backfill store exists at `.agenc/replay-events.sqlite`

**Steps**
1. Compare:
   ```bash
   agenc-runtime replay compare \
     --local-trace-path ./trace.json \
     --task-pda <TASK_PDA> \
     --store-type sqlite \
     --sqlite-path .agenc/replay-events.sqlite
   ```

**Expected Output**
```
status: ok
schema: replay.compare.output.v1
result.status: clean|mismatched
result.anomalyIds: <string[]>
result.topAnomalies: <object[]>
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| `replay.slot_window_exceeded` | window violates policy caps | reduce `from_slot`/`to_slot` window |
| `result.status: mismatched` | drift or missing/extra events | proceed to incident reconstruction and inspect anomaly IDs |

### Build incident timeline reconstruction

**Prerequisites**
- [ ] Backfill store exists at `.agenc/replay-events.sqlite`

**Steps**
1. Reconstruct:
   ```bash
   agenc-runtime replay incident \
     --task-pda <TASK_PDA> \
     --from-slot <FROM_SLOT> \
     --to-slot <TO_SLOT> \
     --store-type sqlite \
     --sqlite-path .agenc/replay-events.sqlite
   ```

**Expected Output**
```
status: ok
schema: replay.incident.output.v1
summary: <object|null>
validation: <object|null>
narrative.lines: <string[]>
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| summary/validation are null | filters too narrow or no events in window | widen slot window and rerun |
| narrative is empty | no meaningful reconstruction possible | inspect raw events via store query / compare anomalies |

---

## MCP path

### Backfill (MCP tool)

**Prerequisites**
- [ ] MCP server configured and running
- [ ] Actor is permitted by replay policy (allowlist/denylist/high-risk auth as configured)

**Steps**
1. Invoke MCP tool `agenc_replay_backfill`:
   ```json
   {
     "rpc": "<RPC_URL>",
     "to_slot": "<TO_SLOT>",
     "page_size": 100,
     "store_type": "sqlite",
     "sqlite_path": ".agenc/replay-events.sqlite"
   }
   ```

**Expected Output**
```
structuredContent.status: ok
structuredContent.schema: replay.backfill.output.v1
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| `replay.access_denied` | actor policy denied | check allowlist/denylist; require auth for high-risk if enabled |
| `replay.concurrency_limit` | too many concurrent jobs | retry after previous job completes |

### Compare (MCP tool)

**Steps**
1. Invoke MCP tool `agenc_replay_compare`:
   ```json
   {
     "local_trace_path": "./trace.json",
     "task_pda": "<TASK_PDA>",
     "store_type": "sqlite",
     "sqlite_path": ".agenc/replay-events.sqlite"
   }
   ```

**Expected Output**
```
structuredContent.status: ok
structuredContent.schema: replay.compare.output.v1
```

### Incident (MCP tool)

**Steps**
1. Invoke MCP tool `agenc_replay_incident`:
   ```json
   {
     "task_pda": "<TASK_PDA>",
     "from_slot": "<FROM_SLOT>",
     "to_slot": "<TO_SLOT>",
     "store_type": "sqlite",
     "sqlite_path": ".agenc/replay-events.sqlite"
   }
   ```

**Expected Output**
```
structuredContent.status: ok
structuredContent.schema: replay.incident.output.v1
```

---

## Notes

- Replay tool outputs are schema-validated. See:
  - `mcp/src/tools/replay-types.ts` for MCP response schemas
  - `runtime/docs/replay-cli.md` for CLI usage
- Replay outputs may include optional `schema_hash` to detect schema drift.
