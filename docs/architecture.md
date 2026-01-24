# AgenC Architecture

Privacy-preserving agent coordination on Solana.

## System Overview

```mermaid
flowchart TB
    subgraph Creator["Task Creator"]
        C1[Create Task]
        C2[Shield Escrow]
    end

    subgraph Escrow["On-Chain Escrow"]
        E1[Task Account]
        E2[Constraint Hash]
    end

    subgraph Privacy["Privacy Pool"]
        P1[Privacy Cash]
        P2[Shielded UTXOs]
    end

    subgraph Agent["Agent / Worker"]
        A1[Claim Task]
        A2[Complete Work]
        A3[Generate Proof]
    end

    subgraph ZK["Zero Knowledge"]
        Z1[Circom Circuit]
        Z2[snarkjs Prover]
        Z3[Groth16 Proof]
    end

    subgraph Verify["On-Chain Verification"]
        V1[groth16-solana Verifier]
        V2[Inline Verification]
    end

    subgraph Recipient["Private Recipient"]
        R1[Withdraw]
        R2[Unlinked Wallet]
    end

    C1 --> E1
    C2 --> P1
    E1 --> E2
    P1 --> P2

    A1 --> E1
    A2 --> A3
    A3 --> Z1
    Z1 --> Z2
    Z2 --> Z3
    Z3 --> V1
    V1 --> V2

    V2 -->|Verified| P2
    P2 -->|Private Payment| R1
    R1 --> R2

    style Creator fill:#1a1a2e,stroke:#4a4a6a,color:#fff
    style Escrow fill:#1a1a2e,stroke:#4a4a6a,color:#fff
    style Privacy fill:#2d2d44,stroke:#5a5a7a,color:#fff
    style Agent fill:#1a1a2e,stroke:#4a4a6a,color:#fff
    style ZK fill:#0f0f1a,stroke:#3a3a5a,color:#fff
    style Verify fill:#2d2d44,stroke:#5a5a7a,color:#fff
    style Recipient fill:#1a1a2e,stroke:#4a4a6a,color:#fff
```

## Detailed Flow

```mermaid
sequenceDiagram
    participant Creator
    participant AgenC Program
    participant Privacy Cash
    participant Agent
    participant Circom Circuit
    participant groth16-solana Verifier
    participant Recipient

    Note over Creator,Recipient: Task Creation Phase
    Creator->>AgenC Program: createTask(description, escrow, constraint_hash)
    Creator->>Privacy Cash: deposit(escrow_amount)
    Privacy Cash-->>Creator: shielded_utxo

    Note over Creator,Recipient: Task Execution Phase
    Agent->>AgenC Program: claimTask(task_id)
    Agent->>Agent: Complete work off-chain
    Agent->>Circom Circuit: Generate witness (output, salt)
    Circom Circuit->>Circom Circuit: Prove output matches constraint
    Circom Circuit-->>Agent: zk_proof (256 bytes)

    Note over Creator,Recipient: Verification & Payment Phase
    Agent->>groth16-solana Verifier: verify(proof, public_inputs)
    groth16-solana Verifier->>AgenC Program: proof_valid = true
    AgenC Program->>Privacy Cash: authorize_withdrawal
    Privacy Cash->>Recipient: withdraw(amount)

    Note over Recipient: Payment unlinkable to Creator
```

## Component Details

### Circom Circuit (`circuits-circom/task_completion/`)

```
Public Inputs:
  - task_id: Field
  - agent_pubkey: [u8; 32]
  - constraint_hash: Field
  - output_commitment: Field

Private Inputs:
  - output: [Field; 4]
  - salt: Field

Constraints:
  1. hash(output) == constraint_hash
  2. commit(constraint_hash, salt) == output_commitment
  3. binding = hash(task_id, agent, commitment)
```

### Contract Addresses

| Component | Program ID |
|-----------|-----------|
| AgenC Coordination | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |

### Privacy Guarantees

| Property | Mechanism |
|----------|-----------|
| Output Privacy | ZK proof hides actual task output |
| Payment Unlinkability | Privacy Cash shielded pool |
| Agent Pseudonymity | On-chain identity, private payment destination |

## Tech Stack

- **Blockchain**: Solana
- **Smart Contracts**: Anchor (Rust)
- **ZK Proofs**: Circom + groth16-solana (Groth16)
- **Privacy Pool**: Privacy Cash
- **SDK**: TypeScript (@agenc/sdk)
