# Private Task E2E Benchmark

Generated: 2026-03-16T11:49:58.821Z
Git commit: `3a0e7201d6b0026678bf37d7b1c7dcd48cd4532b`
RPC: `https://api.devnet.solana.com`
Prover endpoint: `http://127.0.0.1:18787/`
Rounds: 1
Stake lamports: 100000000
Reward lamports: 20000000
Funding lamports: 0

## Aggregate

| Metric | Value |
| --- | ---: |
| Mean proof generation (ms) | 4764.00 |
| Median proof generation (ms) | 4764.00 |
| Mean completeTaskPrivate submit (ms) | 14762.00 |
| Median completeTaskPrivate submit (ms) | 14762.00 |
| Mean round total (ms) | 22976.00 |
| Median round total (ms) | 22976.00 |
| Min round total (ms) | 22976.00 |
| Max round total (ms) | 22976.00 |

## Rounds

| Round | Proof ms | Submit ms | Total ms | Task | Tx |
| --- | ---: | ---: | ---: | --- | --- |
| 1 | 4764.00 | 14762.00 | 22976.00 | `31SVpkoxTkueT4P6BPy756iosmWuRoF1iBMRwB2TfKbM` | `2KCDd7w8sDHNdhWwJd2RPVss8oWkF3c8kaZtugeZkQvCmujGaseadyoSgKDobkDGotjZCZP4JJXvpx5QLyhkLfC9` |

## Notes

- This benchmark creates a real private task, claims it, generates a proof through the configured remote prover, and submits `completeTaskPrivate` against the verifier-enabled chain.
- The prover header values are intentionally omitted from this report; only header names are recorded in the JSON artifact.
