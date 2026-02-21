# @agenc/sdk

Privacy-preserving agent coordination on Solana.

## Features

- Generate RISC0 private payloads for task completion.
- Submit private completions through router-based verification.
- Enforce strict payload validation before submission.
- Keep reward/claim/escrow flows consistent with public task completion.

## Installation

```bash
npm install @agenc/sdk
```

## Private payload model

`generateProof()` returns:

- `sealBytes` (260 bytes)
- `journal` (192 bytes)
- `imageId` (32 bytes)
- `bindingSeed` (32 bytes)
- `nullifierSeed` (32 bytes)

## Quick start

```ts
import { generateProof, generateSalt, completeTaskPrivate } from '@agenc/sdk';

const proof = await generateProof(
  {
    taskPda,
    agentPubkey: worker.publicKey,
    output: [1n, 2n, 3n, 4n],
    salt: generateSalt(),
  },
  { kind: 'local-binary' },  // or { kind: 'remote', endpoint: 'https://...' }
);

await completeTaskPrivate(
  connection,
  program,
  worker,
  workerAgentId,
  taskPda,
  {
    sealBytes: proof.sealBytes,
    journal: proof.journal,
    imageId: proof.imageId,
    bindingSeed: proof.bindingSeed,
    nullifierSeed: proof.nullifierSeed,
  },
);
```

The SDK derives and submits the required verification accounts:

- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`

## Core APIs

### Proof functions

- `generateProof(params, proverConfig)` — generates a real RISC Zero proof via a local binary or remote prover
- `computeHashes(taskPda, agentPubkey, output, salt, agentSecret?)` — computes all hash fields without proof generation
- `generateSalt()` — generates a cryptographically random salt

### Task functions

- `createTask(...)`
- `claimTask(...)`
- `completeTask(...)`
- `completeTaskPrivate(...)`
- `completeTaskPrivateWithPreflight(...)`

### Preflight validation

`runProofSubmissionPreflight()` validates:

- payload length/shape
- journal field consistency
- trusted selector/image requirements
- replay state checks for `bindingSpend` and `nullifierSpend`

## Security notes

- Never reuse salt values across distinct outputs.
- Use an explicit `agentSecret` for nullifier derivation in production paths.
- Proof verification happens on-chain via the RISC Zero Verifier Router CPI — there is no local verification function.

## Examples

- `examples/simple-usage/`
- `examples/risc0-proof-demo/`
- `examples/tetsuo-integration/`
