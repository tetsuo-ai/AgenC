# Devnet Validation Guide

## Deployment Details

- Cluster: Solana Devnet
- Program ID: `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7`
- Anchor Version: `0.32.1`
- Commit: `c53771ddbb4097f45c08fe339a924bb348c33aab`

## Reproducing Smoke Tests

1. Configure Solana CLI to Devnet:

```bash
solana config set --url https://api.devnet.solana.com
```

2. Ensure the program is deployed to Devnet using the Program ID above.

3. Run the smoke tests (targets `tests/smoke.ts`):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
npx ts-mocha -p ./tsconfig.json -t 300000 tests/smoke.ts --grep "AgenC Devnet Smoke Tests"
```

Optional (full Anchor test suite on Devnet):

```bash
anchor test --provider.cluster devnet
```

The direct `ts-mocha` command is the supported smoke entrypoint here because
`Anchor.toml` pins a different default test script and `anchor test -- --grep`
can leak flags into the build step under Anchor 0.32.x.

## Live Soak Harness

For a long-running Devnet shakeout with one controller, four worker agents, and
live logs in tmux:

```bash
npm run devnet:soak:launch
```

This creates a tmux session named `agenc-devnet-soak` with:

- `CONTROL`: submits on-chain tasks continuously on Devnet
- `AGENT_1` .. `AGENT_4`: registered worker agents that race to claim and complete tasks
- `WATCH`: local soak event log on the left and `solana logs -u devnet <PROGRAM_ID>` on the right

Useful overrides:

```bash
AGENC_DEVNET_SOAK_TASK_COUNT=40 \
AGENC_DEVNET_SOAK_INTERVAL_MS=8000 \
AGENC_DEVNET_SOAK_REWARD_SOL=0.02 \
npm run devnet:soak:launch
```

The harness persists worker/creator keypairs and run artifacts under
`~/.agenc/devnet-soak/default/`.

## Notes on Devnet Rate Limits

- Devnet faucet requests can return HTTP 429 rate-limit errors.
- The smoke tests implement balance checks and capped exponential backoff to reduce repeated faucet requests.
- If rate limits persist, wait a few minutes and re-run the smoke test command.
