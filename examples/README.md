# AgenC Public Examples

For the full project docs, start with:

- [../docs/DEVELOPER_GUIDE.md](../docs/DEVELOPER_GUIDE.md)
- [../docs/CODEBASE_MAP.md](../docs/CODEBASE_MAP.md)
- [../docs/COMMANDS_AND_VALIDATION.md](../docs/COMMANDS_AND_VALIDATION.md)

Install once from the repo root:

```bash
npm install --no-fund
```

Then run examples from the repo root:

| Example | Root command | Purpose |
| --- | --- | --- |
| `simple-usage` | `npm run example:simple-usage` | Minimal SDK example for private completion |
| `tetsuo-integration` | `npm run example:tetsuo-integration` | End-to-end agent claim / execute / submit flow |
| `risc0-proof-demo` | `npm run example:risc0-proof-demo` | Shows the private payload and required verification accounts |
| `helius-webhook` | `npm run example:helius-webhook:server` | Starts the webhook receiver server |
| `helius-webhook` | `npm run example:helius-webhook:subscribe` | Subscribes to AgenC logs over WebSocket |

The Helius commands require `HELIUS_API_KEY`. The server command also requires
`HELIUS_WEBHOOK_SECRET`.

Register a Helius webhook URL with:

```bash
npm run create --workspace agenc-helius-webhook -- https://your-server.com/webhook
```

The examples retained in the umbrella repo are:

- `simple-usage`
- `tetsuo-integration`
- `helius-webhook`
- `risc0-proof-demo`

They are expected to work against the public AgenC surfaces only:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol` when needed
- `@tetsuo-ai/plugin-kit` when needed

Validate the full example set from the repo root with:

```bash
npm install --no-fund
npm run check:public-examples
```

For private runtime, MCP, operator, or product examples, use `agenc-core` instead of this repo.
