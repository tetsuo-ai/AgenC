# Zero-Knowledge Proof Flow

The ZK proof system enables agents to prove task completion without revealing the actual output data. Using Noir circuits compiled to Groth16 proofs, agents generate 256-byte proofs that are verified on-chain via CPI to the Sunspot verifier program. The system uses Poseidon2 hashing for ZK-friendly computations and enforces proof uniqueness through nullifier PDAs. Proofs bind the output commitment, task constraint hash, and agent identity to prevent replay attacks. The ProofEngine in the runtime provides caching and verification to optimize proof generation.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant Agent
    participant SDK
    participant ProofEngine
    participant Nargo
    participant Sunspot
    participant Program
    participant Verifier
    participant Nullifier

    Agent->>Agent: Execute task, compute output
    Agent->>Agent: Generate random salt (32 bytes)

    Agent->>SDK: completeTaskPrivate(taskPda, output, salt)
    SDK->>ProofEngine: Check cache

    alt Proof cached
        ProofEngine-->>SDK: Return cached proof
    else Generate new proof
        ProofEngine->>ProofEngine: Prepare circuit inputs
        ProofEngine->>ProofEngine: Compute Poseidon2 hashes
        ProofEngine->>Nargo: nargo execute
        Nargo-->>ProofEngine: Witness data
        ProofEngine->>Sunspot: Generate Groth16 proof
        Sunspot-->>ProofEngine: Proof (256 bytes)

        opt Verification enabled
            ProofEngine->>Sunspot: Verify proof locally
            Sunspot-->>ProofEngine: Verification result
        end

        ProofEngine->>ProofEngine: Cache proof (TTL 5 min)
        ProofEngine-->>SDK: Proof data
    end

    SDK->>SDK: Extract public inputs (67 values)
    SDK->>SDK: Validate expected_binding != 0
    SDK->>SDK: Validate output_commitment != 0

    SDK->>Program: complete_task_private
    Program->>Program: Verify constraint_hash matches task
    Program->>Program: Extract public inputs from proof
    Program->>Verifier: CPI verify_proof
    Verifier->>Verifier: Groth16 verification (~100-130k CU)
    Verifier-->>Program: Proof valid

    Program->>Nullifier: Create nullifier PDA (init)
    alt Nullifier already exists
        Nullifier-->>Program: Error (proof replay)
    else Nullifier created
        Nullifier-->>Program: Nullifier PDA created
        Program->>Program: Transfer reward to worker
        Program->>Program: Update task status
        Program->>Program: Emit TaskCompleted event
        Program-->>SDK: Task completed privately
    end
```

## Circuit Computation Flow

```mermaid
sequenceDiagram
    participant Circuit
    participant Poseidon2

    Note over Circuit: Public inputs (67 total)
    Circuit->>Circuit: task_id: [u64; 4]
    Circuit->>Circuit: agent_pubkey: [u64; 4]
    Circuit->>Circuit: constraint_hash: [u64; 4]
    Circuit->>Circuit: expected_binding: [u64; 4]
    Circuit->>Circuit: output_commitment: [u64; 4]
    Circuit->>Circuit: salt: [u64; 4]

    Note over Circuit: Private inputs
    Circuit->>Circuit: output: [u64; 4]

    Note over Circuit: Computations
    Circuit->>Poseidon2: Hash(output, salt)
    Poseidon2-->>Circuit: computed_commitment

    Circuit->>Circuit: Assert computed_commitment == output_commitment

    Circuit->>Poseidon2: Hash(task_id, agent_pubkey, output_commitment, salt)
    Poseidon2-->>Circuit: computed_binding

    Circuit->>Circuit: Assert computed_binding == expected_binding

    Circuit->>Circuit: Custom constraint validation
    Circuit->>Circuit: Assert output satisfies constraint_hash

    Note over Circuit: All constraints satisfied → proof valid
```

## Proof Caching Strategy

```mermaid
stateDiagram-v2
    [*] --> CacheCheck: Request proof
    CacheCheck --> CacheHit: Key exists + not expired
    CacheCheck --> CacheMiss: Key not found or expired

    CacheHit --> Validate: Check TTL
    Validate --> Return: TTL valid
    Validate --> CacheMiss: TTL expired

    CacheMiss --> Generate: Call nargo + sunspot
    Generate --> Verify: Optional local verification
    Verify --> Store: Verification passed
    Verify --> Error: Verification failed
    Store --> Return: Cache with TTL

    Return --> [*]
    Error --> [*]

    note right of CacheCheck
        Cache key format:
        taskPda|agentPubkey|output[0]|output[1]|output[2]|output[3]|salt
    end note

    note right of Store
        Default TTL: 300,000 ms (5 min)
        Max entries: 100 (LRU eviction)
    end note
```

## Nullifier PDA Creation

```mermaid
sequenceDiagram
    participant Program
    participant Nullifier

    Program->>Program: Extract nullifier from public inputs
    Program->>Program: Derive nullifier PDA: ["nullifier", nullifier_bytes]

    Program->>Nullifier: Initialize account (init constraint)

    alt Account already exists
        Nullifier-->>Program: AccountAlreadyInitialized error
        Program-->>Program: Proof replay detected, reject
    else Account created
        Nullifier-->>Program: PDA initialized
        Program->>Program: Continue with reward distribution
    end
```

## Proof Verification State

```mermaid
stateDiagram-v2
    [*] --> Submitted: Proof received
    Submitted --> ExtractInputs: Parse 67 public inputs
    ExtractInputs --> ValidateFormat: Check sizes and ranges
    ValidateFormat --> Failed: Invalid format
    ValidateFormat --> ValidateBindings: Format valid

    ValidateBindings --> Failed: expected_binding == 0
    ValidateBindings --> Failed: output_commitment == 0
    ValidateBindings --> ValidateConstraint: Bindings non-zero

    ValidateConstraint --> Failed: constraint_hash mismatch
    ValidateConstraint --> CPIVerify: Constraint matches task

    CPIVerify --> Failed: Groth16 verification failed
    CPIVerify --> NullifierCheck: Proof valid

    NullifierCheck --> Failed: Nullifier PDA exists (replay)
    NullifierCheck --> Success: Nullifier created

    Success --> [*]
    Failed --> [*]
```

## Error Paths

| Error Code | Condition | Recovery |
|------------|-----------|----------|
| `ZkVerificationFailed` | Groth16 CPI returned false | Regenerate proof with correct inputs |
| `InvalidProofSize` | Proof != 256 bytes | Check proof generation output |
| `InvalidProofBinding` | expected_binding == 0 or all zeros | Regenerate with valid inputs |
| `InvalidOutputCommitment` | output_commitment == 0 or all zeros | Regenerate with valid inputs |
| `ConstraintHashMismatch` | proof.constraint_hash != task.constraint_hash | Use correct task constraint |
| `NullifierAlreadyExists` | Proof replay attempt | Cannot reuse proofs; generate new |
| `ProofGenerationError` | Nargo/sunspot failure | Check circuit compilation, retry |
| `ProofVerificationError` | Local verification failed | Fix inputs before submitting on-chain |

## Public Input Layout

| Index Range | Field | Size | Description |
|-------------|-------|------|-------------|
| 0-3 | task_id | 4 x u64 | Task PDA identifier |
| 4-7 | agent_pubkey | 4 x u64 | Agent public key |
| 8-11 | constraint_hash | 4 x u64 | Task constraint hash |
| 12-15 | expected_binding | 4 x u64 | Proof-task binding |
| 16-19 | output_commitment | 4 x u64 | Hash(output, salt) |
| 20-23 | salt | 4 x u64 | Random salt for commitment |
| 24-66 | (varies) | 43 x u64 | Circuit-specific public inputs |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Noir Circuit | `circuits/task_completion/src/main.nr` | Circuit definition, Poseidon2 usage |
| SDK Proof Gen | `sdk/src/proofs.ts` | `generateProof()`, `verifyProofLocally()` |
| On-chain Verification | `programs/agenc-coordination/src/instructions/complete_task_private.rs` | `handler()`, CPI verification |
| Verifying Key | `programs/agenc-coordination/src/verifying_key.rs` | `VK_GAMMA_G2`, `VK_DELTA_G2` constants |
| Proof Engine | `runtime/src/proof/engine.ts` | `ProofEngine`, caching logic |
| Proof Cache | `runtime/src/proof/cache.ts` | `ProofCache`, TTL + LRU eviction |

## Security Notes

- **Verifying key integrity**: Production deployment REQUIRES MPC ceremony with ≥3 contributors
- **Gamma != Delta check**: Validate `VK_GAMMA_G2 != VK_DELTA_G2` to prevent forgeable proofs
- **Nullifier uniqueness**: Enforced via PDA init constraint, prevents proof replay
- **Binding validation**: expected_binding and output_commitment MUST be non-zero
- **Constraint binding**: constraint_hash links proof to specific task requirements
- **Salt randomness**: Salt must be cryptographically random (32 bytes)

## Related Issues

- #1076: Execution sandboxing for secure proof generation environments
- #1109: Service marketplace integration with privacy-preserving task completion
