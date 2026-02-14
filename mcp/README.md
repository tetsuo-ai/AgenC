# @agenc/mcp

Model Context Protocol (MCP) server for AgenC protocol development. Exposes AgenC protocol operations as MCP tools, enabling AI coding assistants to interact directly with agents, tasks, disputes, and escrow state on Solana.

## Setup

### Prerequisites

```bash
cd mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add agenc-dev -- node /path/to/AgenC/mcp/dist/index.js
```

Or with environment variables:

```bash
claude mcp add agenc-dev \
  -e SOLANA_RPC_URL=http://localhost:8899 \
  -e SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  -- node /path/to/AgenC/mcp/dist/index.js
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agenc-dev": {
      "command": "node",
      "args": ["/path/to/AgenC/mcp/dist/index.js"],
      "env": {
        "SOLANA_RPC_URL": "http://localhost:8899"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agenc-dev": {
      "command": "node",
      "args": ["/path/to/AgenC/mcp/dist/index.js"],
      "env": {
        "SOLANA_RPC_URL": "http://localhost:8899"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | `http://localhost:8899` | Solana RPC endpoint |
| `SOLANA_KEYPAIR_PATH` | `~/.config/solana/id.json` | Path to signing keypair |
| `AGENC_PROGRAM_ID` | SDK default | Override program ID |
| `MCP_REPLAY_MAX_SLOT_WINDOW` | `2000000` | Max allowed slot window for replay tools |
| `MCP_REPLAY_MAX_EVENT_COUNT` | `250000` | Max events included in replay tool responses |
| `MCP_REPLAY_MAX_CONCURRENT_JOBS` | `2` | Max parallel replay requests |
| `MCP_REPLAY_TOOL_TIMEOUT_MS` | `180000` | Per-call tool timeout in milliseconds |
| `MCP_REPLAY_ALLOWLIST` | `""` | Comma-separated allowlisted MCP actor IDs |
| `MCP_REPLAY_DENYLIST` | `""` | Comma-separated denied MCP actor IDs |
| `MCP_REPLAY_REQUIRE_AUTH_FOR_HIGH_RISK` | `false` | Require authenticated actors for high-risk replay tools |
| `MCP_REPLAY_DEFAULT_REDACTIONS` | `signature` | Comma-separated field names to redact from output |
| `MCP_REPLAY_AUDIT_ENABLED` | `false` | Emit replay audit logs to stdout |
| `MCP_REPLAY_CAPS_<TOOL>_<FIELD>` | `""` | Per-tool replay caps override (example: `MCP_REPLAY_CAPS_BACKFILL_MAX_EVENT_COUNT=5000`) |

## Tools

### Connection

| Tool | Description |
|------|-------------|
| `agenc_set_network` | Switch RPC endpoint (localnet/devnet/mainnet/custom URL) |
| `agenc_get_balance` | Get SOL balance for any public key |
| `agenc_airdrop` | Request SOL airdrop (localnet/devnet only) |

### Agents

| Tool | Description |
|------|-------------|
| `agenc_register_agent` | Register a new agent with capabilities and stake |
| `agenc_deregister_agent` | Remove an agent from the protocol |
| `agenc_get_agent` | Get agent state by ID or PDA (decodes capabilities, status, reputation) |
| `agenc_list_agents` | List registered agents with optional status filter |
| `agenc_update_agent` | Update agent capabilities, status, or endpoint |
| `agenc_decode_capabilities` | Decode capability bitmask to human-readable names |

### Tasks

| Tool | Description |
|------|-------------|
| `agenc_get_task` | Get task state by PDA or creator + task ID |
| `agenc_list_tasks` | List tasks by creator public key |
| `agenc_get_escrow` | Get escrow balance and state for a task |
| `agenc_create_task` | Create task with escrow reward |
| `agenc_claim_task` | Claim a task as worker |
| `agenc_complete_task` | Submit completion proof |
| `agenc_cancel_task` | Cancel a task (creator only) |

### Protocol

| Tool | Description |
|------|-------------|
| `agenc_get_protocol_config` | Get full protocol configuration |
| `agenc_derive_pda` | Derive any PDA (agent, task, escrow, claim, dispute, vote) |
| `agenc_decode_error` | Decode error code 6000-6077 to name + description |
| `agenc_get_program_info` | Get program deployment info |

### Disputes

| Tool | Description |
|------|-------------|
| `agenc_get_dispute` | Get dispute state by ID or PDA |
| `agenc_list_disputes` | List disputes with optional status filter |

### Replay

| Tool | Description |
|------|-------------|
| `agenc_replay_backfill` | Backfill on-chain events into replay store |
| `agenc_replay_compare` | Compare local trajectory trace vs replay projection |
| `agenc_replay_incident` | Reconstruct incident summary, validation, and narrative |
| `agenc_replay_status` | Inspect replay store status summary |

### Replay parity matrix

| Capability | Runtime (`eval/replay.ts`) | MCP (`tools/replay.ts`) | Status |
|---|---|---|---|
| Backfill on-chain events to store | `ReplayBackfillService.runBackfill()` | `agenc_replay_backfill` | Implemented |
| Compare projection vs local trace | `ReplayComparisonService.compare()` | `agenc_replay_compare` | Implemented |
| Reconstruct incident timeline | `TrajectoryReplayEngine.replay()` | `agenc_replay_incident` | Implemented |
| Query store status/cursor | `store.query()` + `store.getCursor()` | `agenc_replay_status` | Implemented |
| Payload truncation | N/A | `truncateOutput()` + trim functions | Implemented |
| Section selection | N/A | `applySectionSelection()` | Implemented |
| Field redaction | N/A | `applyRedaction()` | Implemented |
| Policy enforcement | N/A | `withReplayPolicyControl()` | Implemented |

## Resources

| URI | Description |
|-----|-------------|
| `agenc://error-codes` | Full error code reference (6000-6077) |
| `agenc://capabilities` | Capability bitmask reference |
| `agenc://pda-seeds` | PDA seed format reference |
| `agenc://task-states` | Task state machine documentation |

## Prompts

| Prompt | Description |
|--------|-------------|
| `debug-task` | Guided task debugging workflow |
| `inspect-agent` | Agent state inspection with decoded fields |
| `escrow-audit` | Escrow balance verification checklist |

## Development

```bash
npm run build      # Build with tsup
npm run typecheck  # Type check with tsc
```

## Replay forensics

Use this flow for incident reconstruction:

1. Backfill replay events for the incident window:

```bash
agenc_replay_backfill { "rpc": "https://mainnet.rpc", "to_slot": 12345678, "store_type": "memory", "strict_mode": true }
```

2. Compare replay projection against a saved trajectory trace:

```bash
agenc_replay_compare { "local_trace_path": "/var/tmp/incident-trace.json", "strict_mode": false, "max_payload_bytes": 120000 }
```

3. Reconstruct task or dispute timeline:

```bash
agenc_replay_incident { "task_pda": "Ag...task", "strict_mode": true }
```

4. Inspect store cursor and counts:

```bash
agenc_replay_status { "store_type": "memory", "max_payload_bytes": 120000 }
```

Recommended production controls:

```bash
MCP_REPLAY_MAX_SLOT_WINDOW=200000
MCP_REPLAY_MAX_EVENT_COUNT=2000
MCP_REPLAY_MAX_CONCURRENT_JOBS=2
MCP_REPLAY_TOOL_TIMEOUT_MS=180000
MCP_REPLAY_ALLOWLIST=incident-bot,security-operator
MCP_REPLAY_REQUIRE_AUTH_FOR_HIGH_RISK=true
MCP_REPLAY_AUDIT_ENABLED=true
```

Policy behavior:

- `MCP_REPLAY_DENYLIST` blocks matching actors first.
- If `MCP_REPLAY_ALLOWLIST` is set, only matching actors can run replay tools.
- If `MCP_REPLAY_REQUIRE_AUTH_FOR_HIGH_RISK=true`, high-risk tools require actors resolved via `authInfo.clientId` (not sessions/anonymous).
- Actor identity is resolved from MCP auth context in this order:
  1. `authInfo.clientId`
  2. `session:<sessionId>`
  3. `anonymous`

Any actor that is denied gets a `replay.access_denied` response with `retriable: false`.

Per-tool caps can be overridden via environment variables in this format:

- `MCP_REPLAY_CAPS_<TOOL>_<FIELD>=<positive integer>`

Where:

- `<TOOL>` is one of: `BACKFILL`, `COMPARE`, `INCIDENT`, `STATUS`
- `<FIELD>` is one of: `MAX_WINDOW_SLOTS`, `MAX_EVENT_COUNT`, `TIMEOUT_MS`, `MAX_PAYLOAD_BYTES`

Example:

```bash
MCP_REPLAY_CAPS_BACKFILL_MAX_WINDOW_SLOTS=500000
MCP_REPLAY_CAPS_COMPARE_TIMEOUT_MS=60000
```

See also:

- `runtime/docs/observability-incident-runbook.md`
- `runtime/docs/replay-cli.md`

## Schema Contracts

- `agenc_replay_backfill` returns `replay.backfill.output.v1` and validates `status: "ok"` on success.
- `agenc_replay_compare` returns `replay.compare.output.v1`.
- `agenc_replay_incident` returns `replay.incident.output.v1`.
- `agenc_replay_status` returns `replay.status.output.v1`.
- Failure payloads across replay tools use `status: "error"` with `schema: "replay.*.output.v1"` and the specific error `code`.
- Replay tool payloads may include `schema_hash` for schema drift detection.

### `replay.*.output.v1` formal shapes

- All `replay.*.output.v1` payloads include optional `schema_hash`.
- `replay.backfill.output.v1` includes: `status`, `command`, `schema`, `mode`, `to_slot`, `store_type`, optional `page_size`, `result`, `sections`, `redactions`, `command_params`, `truncated`, and optional `truncation_reason`.
- `replay.compare.output.v1` includes: `status`, `command`, `schema`, `strictness`, `local_trace_path`, `result`, optional `task_pda`, optional `dispute_pda`, `sections`, `redactions`, `command_params`, `truncated`, and optional `truncation_reason`.
- `replay.incident.output.v1` includes: `status`, `command`, `schema`, `command_params`, `sections`, `redactions`, nullable `summary`, nullable `validation`, nullable `narrative`, `truncated`, and optional `truncation_reason`.
- `replay.status.output.v1` includes: `status`, `command`, `schema`, `store_type`, `event_count`, `unique_task_count`, `unique_dispute_count`, nullable `active_cursor`, `sections`, and `redactions`.
- `replay tool errors` include: `status: "error"`, `command`, `schema`, optional `schema_hash`, `code`, `message`, optional `details`, and `retriable`.

## Architecture

```
mcp/
├── src/
│   ├── index.ts              # Entry point (stdio transport)
│   ├── server.ts             # MCP server setup, resources, prompts
│   ├── tools/
│   │   ├── connection.ts     # Network switching, balance, airdrop
│   │   ├── agents.ts         # Agent CRUD and capability decoding
│   │   ├── tasks.ts          # Task queries and escrow inspection
│   │   ├── protocol.ts       # Protocol config, PDA derivation, error decoder
│   │   ├── disputes.ts       # Dispute queries
│   │   └── replay.ts         # Replay and incident forensics tools
│   └── utils/
│       ├── connection.ts     # RPC connection state management
│       ├── formatting.ts     # Output formatting helpers
│       └── truncation.ts     # Shared payload truncation helper
├── package.json
├── tsconfig.json
└── README.md
```
