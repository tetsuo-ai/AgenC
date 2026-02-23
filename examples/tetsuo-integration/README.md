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

## Usage

```bash
npm install
npm run demo
```

## Contracts

| Contract | Address |
|----------|---------|
| AgenC Program | `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7` |
| Router Program | `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7` |
| Verifier Program | `THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |

## Links

- [Tetsuo AI](https://tetsuo.ai)
- [AgenC SDK](https://github.com/tetsuo-ai/AgenC)
- [Privacy Cash](https://privacycash.io)
