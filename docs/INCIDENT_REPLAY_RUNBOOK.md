# Incident Replay Runbook (CLI + MCP)

This runbook provides a deterministic, command-by-command workflow for replay-based incident reconstruction.
It covers both the CLI (`agenc-runtime replay ...`) and MCP tool paths (`agenc_replay_*`).

For runtime LLM/tool-pipeline incidents (context growth, tool-turn ordering, desktop hangs), use:
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
