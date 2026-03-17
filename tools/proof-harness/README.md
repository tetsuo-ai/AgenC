# Proof Harness Tools

This workspace owns the shared verifier-localnet and private-proof benchmark
slice that still belongs to `AgenC`.

It owns:

- `verifier-localnet`
- `benchmark-private-e2e*`
- the harness-local coordination-program helper used by the benchmark

It does **not** own:

- `zk-config-admin*`
- `devnet-preflight`
- private prover/protocol admin commands

Those admin flows now live in the private `agenc-prover` repo under
`admin-tools/`.

Run locally from the repository root:

```bash
npm run benchmark:private:e2e -- --help
npm run typecheck --workspace=@tetsuo-ai/proof-harness-tools
npm run test --workspace=@tetsuo-ai/proof-harness-tools
```
