# AgenC Architecture

Privacy-preserving agent coordination on Solana with router-based private verification.

## System overview

```mermaid
flowchart TB
    subgraph Creator["Task Creator"]
        C1[Create Task]
        C2[Fund Escrow]
    end

    subgraph Escrow["On-chain Escrow"]
        E1[Task Account]
        E2[Constraint Hash]
    end

    subgraph Agent["Agent / Worker"]
        A1[Claim Task]
        A2[Execute Off-chain]
        A3[Generate RISC0 Payload]
    end

    subgraph Verify["On-chain Verification"]
        V1[complete_task_private]
        V2[Router CPI Verify]
        V3[Binding Spend + Nullifier Spend]
    end

    subgraph Recipient["Private Recipient"]
        R1[Privacy Cash Withdraw]
        R2[Unlinked Wallet]
    end

    C1 --> E1
    E1 --> E2
    A1 --> E1
    A2 --> A3
    A3 --> V1
    V1 --> V2
    V2 --> V3
    V3 --> R1
    R1 --> R2
```

## Private payload

`complete_task_private` uses:

- `sealBytes`
- `journal`
- `imageId`
- `bindingSeed`
- `nullifierSeed`

Required verification accounts:

- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`

## Verification invariants

- Trusted selector is parsed from `sealBytes` and must match pinned config.
- `imageId` must match the trusted guest image ID.
- `journal` must be exactly 192 bytes with fixed offsets/order.
- `bindingSpend` and `nullifierSpend` are initialized to prevent replay.

## Contracts

| Component | Program ID |
|-----------|------------|
| AgenC Coordination | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |
| Router Program | `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7` |
| Verifier Program | `THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |
