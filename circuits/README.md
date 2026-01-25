# AgenC ZK Circuits (DEPRECATED)

> **⚠️ DEPRECATED**: This directory contains the old Noir-based circuits.
> The project has migrated to Circom circuits with groth16-solana verification.
> See [`circuits-circom/`](../circuits-circom/) for the current implementation.

## Migration Notice

The ZK proof system has been migrated from:
- **Old**: Noir + Sunspot (388-byte proofs, external verifier)
- **New**: Circom + groth16-solana (256-byte proofs, inline verification)

See [Issue #158](https://github.com/tetsuo-ai/AgenC/issues/158) for migration details.

---

## Legacy Documentation (Noir)

Zero-knowledge circuits for private task completion verification on Solana.

### Overview

AgenC uses ZK proofs to let agents prove task completion without revealing their outputs. The system consists of:

1. **task_completion** - Main circuit that verifies task completion
2. **hash_helper** - Helper circuit for SDK hash computation

## Quick Start

Run the demo to see the full proof flow:

```bash
./demo.sh
```

This compiles circuits, runs tests, generates a proof, and verifies it.

## Prerequisites

### 1. Install Noir (nargo)

```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup -v 1.0.0-beta.13
```

Verify installation:
```bash
nargo --version
# Should show: nargo version = 1.0.0-beta.13
```

### 2. Install Sunspot

Sunspot is the Groth16 prover/verifier for Solana.

```bash
# Install Go 1.21+ if not present
# Download from https://go.dev/dl/

# Clone and build Sunspot
git clone https://github.com/reilabs/sunspot.git ~/sunspot
cd ~/sunspot/go
go build -o sunspot .

# Add to PATH
echo 'export PATH="$HOME/sunspot/go:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify installation:
```bash
sunspot --help
```

## Circuit Details

### task_completion

Proves that an agent completed a task without revealing the output.

**Public Inputs:**
- `task_id` - 32-byte task identifier
- `agent_pubkey` - 32-byte agent public key
- `constraint_hash` - Hash of valid outputs (defines what counts as completion)
- `output_commitment` - Commitment hiding the actual output
- `expected_binding` - Binds proof to task and agent (prevents replay)

**Private Inputs:**
- `output` - The actual task output (4 field elements)
- `salt` - Random value for commitment

**Verification:**
1. `hash(output) == constraint_hash` - Output is valid
2. `hash(constraint_hash, salt) == output_commitment` - Commitment is correct
3. `hash(hash(task_id, agent), output_commitment) == expected_binding` - Proof is bound

### hash_helper

Computes Poseidon2 hashes matching the main circuit. Used by the SDK to ensure hash compatibility.

**Inputs:** task_id, agent_pubkey, output, salt
**Outputs:** constraint_hash, output_commitment, expected_binding

## Manual Commands

### Compile

```bash
cd task_completion
nargo compile
```

### Test

```bash
cd task_completion
nargo test
```

### Generate Proof

```bash
cd task_completion

# 1. Compile to CCS format
sunspot compile target/task_completion.json

# 2. Generate proving/verifying keys (one time)
sunspot setup target/task_completion.ccs

# 3. Generate witness (edit Prover.toml with your inputs first)
nargo execute

# 4. Generate Groth16 proof
sunspot prove \
    target/task_completion.json \
    target/task_completion.gz \
    target/task_completion.ccs \
    target/task_completion.pk

# 5. Verify locally
sunspot verify \
    target/task_completion.vk \
    target/task_completion.proof \
    target/task_completion.pw
```

## On-Chain Verification

The proof can be verified on Solana using the Sunspot verifier program.

**Verifier Program ID:** `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ`

The SDK handles proof submission via the `completeTaskPrivate` instruction.

## Proof Specifications

| Property | Value |
|----------|-------|
| Proof System | Groth16 |
| Curve | BN254 |
| Hash Function | Poseidon2 |
| Proof Size | 388 bytes |
| Constraints | ~1288 |

## File Structure

```
circuits/
├── demo.sh                    # Full demo script
├── README.md                  # This file
├── task_completion/           # Main circuit
│   ├── Nargo.toml
│   ├── Prover.toml           # Example inputs
│   ├── src/main.nr           # Circuit code
│   └── target/               # Build artifacts
│       ├── task_completion.json  # ACIR
│       ├── task_completion.ccs   # CCS
│       ├── task_completion.pk    # Proving key
│       ├── task_completion.vk    # Verifying key
│       ├── task_completion.proof # Generated proof
│       └── task_completion.pw    # Public witness
└── hash_helper/              # Hash computation helper
    ├── Nargo.toml
    ├── Prover.toml
    └── src/main.nr
```

## Security

- Each proof requires a unique random salt
- Replay attacks are prevented by binding proofs to task and agent
- Output remains private (only commitment is public)
- Constraint hash ensures output satisfies task requirements
