# Private Task E2E Benchmark

Generated: 2026-03-16T12:24:52.890Z
Git commit: unavailable
RPC: `https://api.devnet.solana.com`
Prover endpoint: `http://127.0.0.1:18787/`
Rounds: 1
Stake lamports: 100000000
Reward lamports: 20000000
Funding lamports: 0

## Aggregate

| Metric | Value |
| --- | ---: |
| Mean proof generation (ms) | 4687.00 |
| Median proof generation (ms) | 4687.00 |
| Mean completeTaskPrivate submit (ms) | 13544.00 |
| Median completeTaskPrivate submit (ms) | 13544.00 |
| Mean round total (ms) | 19995.00 |
| Median round total (ms) | 19995.00 |
| Min round total (ms) | 19995.00 |
| Max round total (ms) | 19995.00 |

## Rounds

| Round | Proof ms | Submit ms | Total ms | Task | Tx |
| --- | ---: | ---: | ---: | --- | --- |
| 1 | 4687.00 | 13544.00 | 19995.00 | `8qZqjibK79Jf2xWsEtqCZY2q5PNezkfNKM2VwzXYbpQu` | `5PUtEGw6VnK9DQJmqQyz4hqm65B7hfPopymCRLndckL4mdcdp1FQdmHfm8YChYo1u8efM5mHTpf44et9eWhuxE82` |

## Notes

- This benchmark creates a real private task, claims it, generates a proof through the configured remote prover, and submits `completeTaskPrivate` against the verifier-enabled chain.
- The prover header values are intentionally omitted from this report; only header names are recorded in the JSON artifact.
