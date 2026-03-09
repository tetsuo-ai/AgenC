# Runtime Pipeline Debug Bundle Runbook

Use this runbook when diagnosing:

- context growth ("why is prompt huge?")
- tool-turn ordering failures
- post-tool hangs/stalls

## 1) Enable trace logging

Edit `~/.agenc/config.json`:

```json
{
  "logging": {
    "level": "info",
    "trace": {
      "enabled": true,
      "includeHistory": true,
      "includeSystemPrompt": true,
      "includeToolArgs": true,
      "includeToolResults": true,
      "includeProviderPayloads": true,
      "maxChars": 20000
    }
  }
}
```

Restart daemon after changing config.

## 2) Run the canonical repro harness

From repository root:

```bash
npm --prefix runtime run repro:pipeline:http
```

Expected output is JSON with:

- `overall: "pass"|"fail"`
- step-by-step records for fixture create, HTTP server start, optional Playwright navigate, curl verification, process verification, teardown.

## 3) Capture a minimal provider repro payload

For malformed tool-turn validation bugs, keep payloads tiny and explicit.

Malformed example (missing assistant `tool_calls` linkage):

```json
{
  "model": "grok-code-fast-1",
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "test" },
    { "role": "assistant", "content": "" },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"stdout\":\"\",\"exitCode\":0}" }
  ],
  "max_tokens": 16
}
```

Control example (valid linkage):

```json
{
  "model": "grok-code-fast-1",
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "test" },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "call_1",
          "type": "function",
          "function": { "name": "desktop.bash", "arguments": "{\"command\":\"echo hi\"}" }
        }
      ]
    },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"stdout\":\"hi\\n\",\"exitCode\":0}" }
  ],
  "max_tokens": 16
}
```

## 4) Collect the debug bundle

Bundle these files/artifacts:

- `~/.agenc/daemon.log` (trace-enabled window only)
- `~/.agenc/config.json` (redact API keys/secrets)
- repro harness JSON output
- trace lines for `*.executor.*`
- trace lines for `*.provider.request` / `*.provider.response` / `*.provider.error`
- exact user prompt used

If the WebChat operator UI is available, the `TRACE` view can now pull the same evidence directly from the observability store:

- summary metrics via `observability.summary`
- trace list/detail via `observability.traces` and `observability.trace`
- exact artifact payloads via `observability.artifact`
- trace-filtered daemon log slices via `observability.logs`

Use the portal for fast triage, then fall back to raw files only when you need to export a bundle.

## 5) Correlate one turn end-to-end

Trace logs include a per-turn `traceId`. Use it to join:

- `[trace] *.inbound`
- `[trace] *.chat.request`
- `[trace] *.executor.model_call_prepared`
- `[trace] *.executor.contract_guidance_resolved`
- `[trace] *.executor.tool_rejected` / `.tool_arguments_invalid`
- `[trace] *.executor.tool_dispatch_started` / `.tool_dispatch_finished`
- `[trace] *.executor.route_expanded`
- `[trace] *.executor.completion_gate_checked`
- `[trace] *.provider.request` / `.provider.response` / `.provider.error`
- `[trace] *.tool.call` / `.tool.result` / `.tool.error`
- `[trace] *.chat.response`

Example:

```bash
rg "traceId\":\"<TRACE_ID>\"" ~/.agenc/daemon.log
```

Key fields for context diagnostics in `*.chat.response`:

- `requestShape.messageCountsBeforeBudget`
- `requestShape.messageCountsAfterBudget`
- `requestShape.estimatedPromptCharsBeforeBudget`
- `requestShape.estimatedPromptCharsAfterBudget`
- `requestShape.systemPromptCharsAfterBudget`
- `requestShape.toolSchemaChars`
- `callUsage[]` (per-provider-call usage attribution)

Key fields for exact provider repros in `*.provider.request` / `*.provider.response`:

- request `payload.tools[]` and `payload.tool_choice`
- request `payload.previous_response_id` / `payload.store`
- request `context.requestedToolNames[]` / `context.resolvedToolNames[]`
- request `context.missingRequestedToolNames[]` / `context.toolResolution`
- response `payload.output[]` and `payload.output_text`
- response/error `payload.status` / `payload.error`

Key fields for executor-state replay in `*.executor.*`:

- `model_call_prepared.payload.routedToolNames[]`
- `contract_guidance_resolved.payload.routedToolNames[]`
- `tool_rejected.payload.routingMiss` / `tool_rejected.payload.expandAfterRound`
- `route_expanded.payload.previousRoutedToolNames[]` / `nextRoutedToolNames[]`
- `completion_gate_checked.payload.decision`

## 6) Disable trace after triage

Set `logging.trace.enabled` back to `false` once incident capture is complete to keep log size bounded.
