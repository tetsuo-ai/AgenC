# Private Proof Flow (RISC0 + Router)

The private completion flow proves task correctness without revealing private outputs.

## Happy path

```mermaid
sequenceDiagram
    participant Agent
    participant Runtime
    participant SDK
    participant Prover as RISC0 Prover
    participant Program
    participant Router

    Agent->>Runtime: Execute task and produce output
    Runtime->>SDK: Request private payload
    SDK->>Prover: Generate receipt payload
    Prover-->>SDK: sealBytes, journal, imageId, bindingSeed, nullifierSeed
    SDK-->>Runtime: Private payload

    Runtime->>Program: complete_task_private(payload, accounts)
    Program->>Program: Validate payload shape + journal schema
    Program->>Router: CPI verify(sealBytes, imageId, hash(journal))
    Router-->>Program: Verified
    Program->>Program: Init bindingSpend + nullifierSpend
    Program-->>Runtime: Task completed privately
```

## Journal schema

`journal` is fixed at 192 bytes:

1. task PDA
2. authority
3. constraint hash
4. output commitment
5. binding seed bytes
6. nullifier seed bytes

## Replay protection

- `bindingSpend` blocks reuse of the same binding context.
- `nullifierSpend` blocks global nullifier replay.

## Failure modes

| Error | Condition |
|-------|-----------|
| `InvalidSealEncoding` | `sealBytes` cannot be decoded/validated |
| `InvalidJournalLength` | `journal` is not exactly 192 bytes |
| `TrustedSelectorMismatch` | selector is not trusted |
| `InvalidImageId` | image ID is not trusted |
| `RouterAccountMismatch` | router/verifier-entry account constraints fail |
| `NullifierAlreadyUsed` | `nullifierSpend` already exists |
| `BindingAlreadyUsed` | `bindingSpend` already exists |

## Payload/account checklist

Payload:
- `sealBytes`
- `journal`
- `imageId`
- `bindingSeed`
- `nullifierSeed`

Accounts:
- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`
