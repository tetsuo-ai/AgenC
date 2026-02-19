# Simple Usage Example

Minimal SDK example for the RISC0 private completion flow.

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
    sealBytes: Array.from(proof.sealBytes),
    journal: Array.from(proof.journal),
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
