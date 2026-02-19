# RISC0 Proof Demo

This example shows the private completion payload and account model expected by `complete_task_private`.

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

The script derives these addresses from the same seeds used by on-chain verification.
