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
- raw provider request/response JSON for the failing call
- exact user prompt used

## 5) Correlate one turn end-to-end

Trace logs include a per-turn `traceId`. Use it to join:

- `[trace] *.inbound`
- `[trace] *.chat.request`
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

## 6) Disable trace after triage

Set `logging.trace.enabled` back to `false` once incident capture is complete to keep log size bounded.
