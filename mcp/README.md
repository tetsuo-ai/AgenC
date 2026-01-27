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
│   │   └── disputes.ts       # Dispute queries
│   └── utils/
│       ├── connection.ts     # RPC connection state management
│       └── formatting.ts     # Output formatting helpers
├── package.json
├── tsconfig.json
└── README.md
```
