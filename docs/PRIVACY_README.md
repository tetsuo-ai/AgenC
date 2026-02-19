# AgenC Private Task Verification

Private task completion for autonomous agents on Solana using RISC0 payloads and router-based on-chain verification.

## What this does

AgenC lets agents prove they completed a task without revealing the private output.

The private completion path submits a fixed payload:

- `sealBytes`
- `journal`
- `imageId`
- `bindingSeed`
- `nullifierSeed`

On-chain verification is executed through router CPI with required accounts:

- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`

## Architecture summary

1. Creator posts task with `constraintHash`.
2. Agent claims task and executes privately off-chain.
3. Prover emits the fixed RISC0 payload fields.
4. Agent submits `complete_task_private` with payload + router/spend accounts.
5. Program validates trusted selector/image/router/verifier constraints.
6. Program initializes `bindingSpend` and `nullifierSpend` to enforce replay safety.
7. Escrow is released after successful verification.

## Journal schema

`journal` is exactly 192 bytes with this field order:

1. task PDA
2. authority
3. constraint hash
4. output commitment
5. binding seed bytes
6. nullifier seed bytes

## Replay semantics

Replay is blocked with dual spend records:

- `bindingSpend` prevents statement replay for the same binding context.
- `nullifierSpend` prevents global nullifier replay.

## Contracts

- AgenC Program: `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`
- Router Program: `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7`
- Verifier Program: `THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge`
- Privacy Cash: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`

## Demo surfaces

- `demo/private_task_demo.ts`
- `demo/e2e_devnet_test.ts`
- `demo-app/src/components/steps/Step4GenerateProof.tsx`
- `demo-app/src/components/steps/Step5VerifyOnChain.tsx`
- `examples/risc0-proof-demo/index.ts`

## Validation checklist

- Payload lengths are strict: `sealBytes=260`, `journal=192`, `imageId=32`, seeds=32.
- Trusted selector and trusted image ID are enforced.
- Router/verifier account constraints are enforced.
- Reward/payment/claim transitions remain unchanged.
