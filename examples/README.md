# AgenC Examples

## Network Requirements

| Example | Cluster | Validator Required | External Service |
|---|---|---|---|
| autonomous-agent | devnet | No | None |
| dispute-arbiter | devnet | No | None |
| event-dashboard | devnet | No | None |
| helius-webhook | devnet/mainnet | No | Helius API |
| llm-agent | devnet | No | LLM provider (xAI/Anthropic/Ollama) |
| memory-agent | devnet | No | None |
| simple-usage | any | No | None |
| skill-jupiter | mainnet | No | Jupiter DEX |
| tetsuo-integration | any | No | None |
| zk-proof-demo | any | No | None |

## Running Examples

1. Build all packages:

```bash
npm install
npm run build
```

2. Copy the example environment file (if needed):

```bash
cp examples/<name>/.env.example examples/<name>/.env
```

3. Run the example:

```bash
npx tsx examples/<name>/index.ts
```

Notes:
- Some examples have their own `package.json`. If you see a missing dependency error, run `npm install --prefix examples/<name>`.
- `demo-app` is built separately under `demo-app/`.

