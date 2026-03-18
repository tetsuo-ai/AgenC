# AgenC Public Examples

These are the public examples retained in the umbrella repo:

- `simple-usage`
- `tetsuo-integration`
- `helius-webhook`
- `risc0-proof-demo`

They are expected to work against the public AgenC surfaces only:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol` when needed
- `@tetsuo-ai/plugin-kit` when needed

Validate them from the repo root with:

```bash
npm install --no-fund
npm run check:public-examples
```

For private runtime, MCP, operator, or product examples, use `agenc-core` instead of this repo.
