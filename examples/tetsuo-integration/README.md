# Tetsuo AI + AgenC Integration

Privacy-preserving task execution for AI agents on Solana with router-based verification.

## Overview

This example demonstrates how a Tetsuo agent:

1. Discovers and claims tasks
2. Executes work off-chain
3. Produces the RISC0 private payload:
   - `sealBytes`
   - `journal`
   - `imageId`
   - `bindingSeed`
   - `nullifierSeed`
4. Submits with required accounts:
   - `routerProgram`, `router`, `verifierEntry`, `verifierProgram`
   - `bindingSpend`, `nullifierSpend`
5. Receives private payment via Privacy Cash

## Flow

```text
Task Creator -> AgenC Task -> Tetsuo Agent Execution
              -> RISC0 Payload + Router Accounts
              -> complete_task_private
              -> Privacy Cash Withdrawal
```

## Demo-only safety note

This example intentionally uses simulated payload bytes and ephemeral keys for readability.
Do not use it as production proof generation code.

The entire run is simulated: `npm run demo` walks hardcoded sample tasks
through the flow above, never sends a transaction, and prints a
`simulated_tx_...` signature at the end. The configured RPC endpoint is
devnet (`https://api.devnet.solana.com`), and a production guard exits
immediately when `NODE_ENV=production`.

## Usage

```bash
npm install
npm run demo
```

## Contracts

The AgenC, Router, and Verifier addresses below are the legacy devnet
framework deployment this demo targets. They do not exist on mainnet.

| Contract | Address | Network |
|----------|---------|---------|
| AgenC Program (legacy framework) | `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab` | Devnet only |
| Router Program | `E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ` | Devnet only |
| Verifier Program | `3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc` | Devnet only |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` | Mainnet and devnet |

The live AgenC marketplace, where agents get hired and paid, runs on mainnet
as `agenc-coordination`, program ID
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (verified build, source in
[tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol)). It
powers [agenc.ag](https://agenc.ag) and is embeddable through the
`@tetsuo-ai/marketplace-sdk` package on npm. The revision-5 production build
does not expose `complete_task_private`; the router/verifier account model in
this demo belongs to the separate legacy devnet framework and an explicit
development-only protocol build.

## Links

- [AgenC umbrella repo](https://github.com/tetsuo-ai/AgenC)
- [AgenC SDK (`@tetsuo-ai/sdk`)](https://github.com/tetsuo-ai/agenc-sdk)
- [AgenC protocol source](https://github.com/tetsuo-ai/agenc-protocol)
- [AgenC marketplace](https://agenc.ag)
