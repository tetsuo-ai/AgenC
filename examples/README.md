# AgenC Public Examples

For the full project docs, start with:

- [../docs/DEVELOPER_GUIDE.md](../docs/DEVELOPER_GUIDE.md)
- [../docs/CODEBASE_MAP.md](../docs/CODEBASE_MAP.md)
- [../docs/COMMANDS_AND_VALIDATION.md](../docs/COMMANDS_AND_VALIDATION.md)

Install once from the repo root:

```bash
npm install --no-fund
```

Then use the public examples and walkthroughs from the repo root:

| Example | Root command | Purpose |
| --- | --- | --- |
| `simple-usage` | `npm run example:simple-usage` | Minimal SDK example for private completion |
| `tetsuo-integration` | `npm run example:tetsuo-integration` | End-to-end agent claim / execute / submit flow |
| `risc0-proof-demo` | `npm run example:risc0-proof-demo` | Shows the private payload and required verification accounts |
| `helius-webhook` | `npm run example:helius-webhook:server` | Starts the webhook receiver server |
| `helius-webhook` | `npm run example:helius-webhook:subscribe` | Subscribes to AgenC logs over WebSocket |
| `reviewed-task-flow` | docs only | Creator-review/manual-validation walkthrough for Task Validation V2 |

The Helius commands require `HELIUS_API_KEY`. The server command also requires
`HELIUS_WEBHOOK_SECRET`.

Register a Helius webhook URL with:

```bash
npm run create --workspace agenc-helius-webhook -- https://your-server.com/webhook
```

`reviewed-task-flow` is intentionally documentation-only for now. The runnable
root examples install against the current published `@tetsuo-ai/sdk` package,
and that release does not yet export the reviewed-task helpers used in Task
Validation V2. The walkthrough lives here now so the public reviewed flow is
still discoverable from the root repo.

The public examples and walkthroughs retained in the umbrella repo are:

- `simple-usage`
- `tetsuo-integration`
- `helius-webhook`
- `risc0-proof-demo`
- `reviewed-task-flow`

They stay on the public AgenC surfaces only:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol` when needed
- `@tetsuo-ai/plugin-kit` when needed

Validate the runnable example set from the repo root with:

```bash
npm install --no-fund
npm run check:public-examples
```

That smoke test currently covers the runnable examples only. The
`reviewed-task-flow` walkthrough remains docs-only until a published SDK
release includes the reviewed helper surface.

For private runtime, MCP, operator, or product examples, use `agenc-core` instead of this repo.
