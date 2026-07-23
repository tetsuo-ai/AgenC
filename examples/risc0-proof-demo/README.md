# RISC0 Proof Demo

This example shows the private completion payload and account model expected by `complete_task_private`.

## Which program is this?

This demo derives its spend accounts under the legacy AgenC framework program
`6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`, the `PROGRAM_ID` exported by
`@tetsuo-ai/sdk` (pinned here at 1.4.0). That program exists on devnet only.
The live mainnet marketplace program is
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, documented in
[tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol), and
its revision-5 production build does not ship `complete_task_private`. That
instruction remains confined to the legacy devnet framework and an explicit
development-only protocol build.

## Run

```bash
npm install
npx tsx examples/risc0-proof-demo/index.ts
```

## Payload fields

- `sealBytes` (260 bytes)
- `journal` (192 bytes)
- `imageId` (32 bytes)
- `bindingSeed` (32 bytes)
- `nullifierSeed` (32 bytes)

## Required accounts

- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`

The script derives these addresses from the same PDA seeds the on-chain
program uses. It derives `bindingSpend` and `nullifierSpend` under the
devnet-only legacy program ID above, so those two printed addresses are
devnet addresses, not mainnet marketplace addresses.

The demo prints the payload shape and account model only. Producing a real
`sealBytes` seal requires `generateProof()` against a trusted remote prover
backend; the prover service lives in the private `agenc-prover` repo, and the
risc0 zkVM guest lives in
[tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol).
