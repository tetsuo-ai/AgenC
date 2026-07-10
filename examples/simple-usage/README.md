# Simple Usage Example

Minimal SDK example for the RISC0 private completion flow.

## Which program is this?

This example derives its accounts under the legacy AgenC framework program
`6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`, the `PROGRAM_ID` exported by
`@tetsuo-ai/sdk` (pinned here at 1.4.0). That program exists on devnet only,
so the printed `bindingSpend` and `nullifierSpend` addresses are devnet
addresses. The live mainnet marketplace program is
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, documented in
[tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol).

## Run

```bash
npm install
npx tsx examples/simple-usage/index.ts
```

## What it demonstrates

- Generate a private payload with:
  - `sealBytes`
  - `journal`
  - `imageId`
  - `bindingSeed`
  - `nullifierSeed`
- Derive required submission accounts:
  - `routerProgram`
  - `router`
  - `verifierEntry`
  - `verifierProgram`
  - `bindingSpend`
  - `nullifierSpend`

## Submission shape

```ts
await program.methods
  .completeTaskPrivate(taskIdU64, {
    sealBytes: Buffer.from(proof.sealBytes),
    journal: Buffer.from(proof.journal),
    imageId: Array.from(proof.imageId),
    bindingSeed: Array.from(proof.bindingSeed),
    nullifierSeed: Array.from(proof.nullifierSeed),
  })
  .accountsPartial({
    routerProgram,
    router,
    verifierEntry,
    verifierProgram,
    bindingSpend,
    nullifierSpend,
    // ...task + escrow + authority accounts
  })
```
