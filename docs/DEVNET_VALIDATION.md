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
anchor test --provider.cluster devnet --skip-local-validator -- --grep "AgenC Devnet Smoke Tests"
```

Optional (full Anchor test suite on Devnet):

```bash
anchor test --provider.cluster devnet
```

## Notes on Devnet Rate Limits

- Devnet faucet requests can return HTTP 429 rate-limit errors.
- The smoke tests implement balance checks and capped exponential backoff to reduce repeated faucet requests.
- If rate limits persist, wait a few minutes and re-run the smoke test command.
