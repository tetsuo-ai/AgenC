# RISC Zero ZK Migration Plan

## Overview

Replace the entire Circom/snarkjs/Groth16/Poseidon ZK stack with RISC Zero zkVM.
The on-chain verifier (`risc0-solana`) is audited by Veridise. The underlying
`groth16-solana` crate is audited as part of Light Protocol v3. No custom audit needed.

**Hash function:** SHA-256 everywhere (replaces Poseidon). Solana has a native SHA-256
syscall, SHA-256 is universally audited, and RISC Zero has SHA-256 precompiles for
fast proving.

**Proof format:** 256-byte Groth16 (identical size to current). On-chain verification
via CPI to RISC Zero's deployed verifier router program.

**Trusted setup:** Universal (maintained by RISC Zero). No MPC ceremony needed.

---

## Phase 1: Create SP1 Guest Program (new `zkvm/` directory)

### 1.1 Create workspace structure

```
zkvm/
├── Cargo.toml              # Workspace root
├── methods/
│   ├── Cargo.toml          # risc0-build generates ELF + image ID
│   ├── build.rs            # risc0_build::embed_methods()
│   └── guest/
│       ├── Cargo.toml      # Guest program (risc0-zkvm guest)
│       └── src/
│           └── main.rs     # Task completion logic
└── host/
    ├── Cargo.toml          # Host-side prover binary
    └── src/
        └── main.rs         # ProverClient, stdin/stdout JSON interface
```

### 1.2 Guest program: `zkvm/methods/guest/Cargo.toml`

```toml
[package]
name = "agenc-task-completion-guest"
version = "0.1.0"
edition = "2021"

[dependencies]
risc0-zkvm = { version = "3.0", default-features = false, features = ["std"] }
sha2 = "0.10"

[profile.release]
opt-level = 3
lto = true
```

### 1.3 Guest program: `zkvm/methods/guest/src/main.rs`

The guest program replaces `circuits-circom/task_completion/circuit.circom`.
All hashing uses SHA-256 instead of Poseidon.

```rust
#![no_main]
risc0_zkvm::guest::entry!(main);

use risc0_zkvm::guest::env;
use sha2::{Sha256, Digest};

/// Public values committed to the journal (192 bytes total).
/// The on-chain program deserializes this and validates against account state.
#[repr(C)]
struct JournalOutput {
    task_pda: [u8; 32],
    agent_pubkey: [u8; 32],
    constraint_hash: [u8; 32],
    output_commitment: [u8; 32],
    binding: [u8; 32],
    nullifier: [u8; 32],
}

fn main() {
    // === Read private inputs from host ===
    let task_pda: [u8; 32] = env::read();
    let agent_pubkey: [u8; 32] = env::read();
    let output_values: [[u8; 32]; 4] = env::read();
    let salt: [u8; 32] = env::read();
    let agent_secret: [u8; 32] = env::read();

    // === Compute constraint_hash = SHA256(output[0] || output[1] || output[2] || output[3]) ===
    let mut hasher = Sha256::new();
    for output in &output_values {
        hasher.update(output);
    }
    let constraint_hash: [u8; 32] = hasher.finalize().into();

    // === Compute output_commitment = SHA256(output[0..3] || salt) ===
    let mut hasher = Sha256::new();
    for output in &output_values {
        hasher.update(output);
    }
    hasher.update(&salt);
    let output_commitment: [u8; 32] = hasher.finalize().into();

    // === Compute binding = SHA256(SHA256(task_pda || agent_pubkey) || output_commitment) ===
    let mut hasher = Sha256::new();
    hasher.update(&task_pda);
    hasher.update(&agent_pubkey);
    let inner: [u8; 32] = hasher.finalize().into();

    let mut hasher = Sha256::new();
    hasher.update(&inner);
    hasher.update(&output_commitment);
    let binding: [u8; 32] = hasher.finalize().into();

    // === Compute nullifier = SHA256(constraint_hash || agent_secret) ===
    let mut hasher = Sha256::new();
    hasher.update(&constraint_hash);
    hasher.update(&agent_secret);
    let nullifier: [u8; 32] = hasher.finalize().into();

    // === Commit public values to journal ===
    // Only these values are visible to the verifier / on-chain program.
    // output_values, salt, and agent_secret remain private.
    env::commit_slice(&task_pda);
    env::commit_slice(&agent_pubkey);
    env::commit_slice(&constraint_hash);
    env::commit_slice(&output_commitment);
    env::commit_slice(&binding);
    env::commit_slice(&nullifier);
}
```

### 1.4 Methods crate: `zkvm/methods/Cargo.toml` + `build.rs`

```toml
# Cargo.toml
[package]
name = "agenc-task-completion-methods"
version = "0.1.0"
edition = "2021"

[build-dependencies]
risc0-build = "3.0"

[package.metadata.risc0]
methods = ["guest"]
```

```rust
// build.rs
fn main() {
    risc0_build::embed_methods();
}
```

This generates two constants at compile time:
- `TASK_COMPLETION_ELF: &[u8]` — the RISC-V binary
- `TASK_COMPLETION_ID: [u32; 8]` — the image ID (32 bytes as 8 x u32 LE)

### 1.5 Host prover binary: `zkvm/host/src/main.rs`

The SDK calls this binary to generate proofs. Accepts JSON on stdin, returns
proof + journal on stdout.

```rust
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
use agenc_task_completion_methods::TASK_COMPLETION_ELF;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
struct ProofRequest {
    task_pda: [u8; 32],
    agent_pubkey: [u8; 32],
    output_values: [[u8; 32]; 4],
    salt: [u8; 32],
    agent_secret: [u8; 32],
}

#[derive(Serialize)]
struct ProofResponse {
    seal: Vec<u8>,        // 256 bytes (Groth16)
    journal: Vec<u8>,     // 192 bytes (6 x 32-byte hashes)
    image_id: [u8; 32],
}

fn main() -> anyhow::Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let req: ProofRequest = serde_json::from_str(&input)?;

    let env = ExecutorEnv::builder()
        .write(&req.task_pda)?
        .write(&req.agent_pubkey)?
        .write(&req.output_values)?
        .write(&req.salt)?
        .write(&req.agent_secret)?
        .build()?;

    let prover = default_prover();
    let prove_info = prover.prove_with_opts(env, TASK_COMPLETION_ELF, &ProverOpts::groth16())?;
    let receipt = prove_info.receipt;

    let seal: [u8; 256] = receipt.inner
        .groth16()
        .expect("expected groth16 receipt")
        .seal
        .clone()
        .try_into()
        .expect("seal must be 256 bytes");

    let image_id = agenc_task_completion_methods::TASK_COMPLETION_ID;
    let image_id_bytes: [u8; 32] = image_id
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect::<Vec<u8>>()
        .try_into()
        .unwrap();

    let resp = ProofResponse {
        seal: seal.to_vec(),
        journal: receipt.journal.bytes,
        image_id: image_id_bytes,
    };

    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}
```

### 1.6 Workspace Cargo.toml

```toml
[workspace]
members = ["methods", "host"]
resolver = "2"
```

---

## Phase 2: On-Chain Program Changes

### 2.1 Cargo.toml — swap verifier crate

**File:** `programs/agenc-coordination/Cargo.toml`

Remove:
```toml
groth16-solana = "0.2"
```

Add:
```toml
# RISC Zero verifier router (CPI target)
verifier_router = { git = "https://github.com/risc0/risc0-solana", features = ["cpi"] }
```

**Anchor version note:** risc0-solana currently uses anchor-lang 0.31.1. AgenC uses
0.32.1. Two options:
- **Option A (recommended):** Fork risc0-solana and bump anchor-lang to 0.32.1. The
  verifier code is simple; the fork is minimal and maintainable.
- **Option B:** Pin anchor-lang to 0.31.1 across the project (not recommended — breaks
  existing features).

### 2.2 Delete `verifying_key.rs`

**File:** `programs/agenc-coordination/src/verifying_key.rs` — DELETE entirely.

Remove `pub mod verifying_key;` from `lib.rs`.

### 2.3 Create `sp1_config.rs` → `risc0_config.rs`

**File:** `programs/agenc-coordination/src/risc0_config.rs` — CREATE

```rust
/// RISC Zero task completion guest program image ID.
/// Generated by `risc0-build` from the guest ELF.
/// Update this when the guest program changes.
pub const TASK_COMPLETION_IMAGE_ID: [u8; 32] = [
    // Filled in after first `cargo build` of zkvm/methods
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
];

/// Journal size: 6 fields x 32 bytes = 192 bytes
pub const EXPECTED_JOURNAL_SIZE: usize = 192;

/// Groth16 proof size (unchanged from current system)
pub const GROTH16_PROOF_SIZE: usize = 256;

/// RISC Zero Verifier Router program ID (deployed on devnet + mainnet)
/// Source: https://github.com/risc0/risc0-solana
pub const VERIFIER_ROUTER_PROGRAM_ID: &str = "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7";
```

Add `pub mod risc0_config;` to `lib.rs`.

### 2.4 Rewrite `complete_task_private.rs`

**File:** `programs/agenc-coordination/src/instructions/complete_task_private.rs`

The entire verification logic changes from inline groth16-solana to CPI into the
RISC Zero verifier router.

#### New `PrivateCompletionProof` struct:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrivateCompletionProof {
    /// RISC Zero Groth16 seal: 4-byte selector + 256-byte proof
    pub seal: Vec<u8>,
    /// Journal bytes committed by the guest program (192 bytes)
    pub journal: Vec<u8>,
    /// Image ID of the guest program (32 bytes)
    pub image_id: [u8; 32],
}
```

#### New accounts struct:

```rust
#[derive(Accounts)]
#[instruction(task_id: [u8; 32], proof: PrivateCompletionProof)]
pub struct CompleteTaskPrivate<'info> {
    // --- Existing accounts (unchanged) ---
    #[account(mut)]
    pub task: Account<'info, Task>,
    #[account(mut)]
    pub claim: Account<'info, TaskClaim>,
    #[account(mut)]
    pub escrow: SystemAccount<'info>,
    /// CHECK: Validated as task.creator
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    #[account(mut)]
    pub worker: Account<'info, AgentRegistration>,
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = authority,
        space = Nullifier::SIZE,
        seeds = [b"nullifier", &proof.journal[160..192]], // nullifier from journal
        bump,
    )]
    pub nullifier_account: Account<'info, Nullifier>,
    /// CHECK: Validated as protocol_config.treasury
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,

    // --- RISC Zero verifier accounts (NEW) ---
    /// The verifier router program
    pub verifier_router_program: Program<'info, VerifierRouterProgram>,
    /// Router PDA: seeds = ["router"] on verifier_router
    pub router_account: Account<'info, VerifierRouter>,
    /// Verifier entry PDA: seeds = ["verifier", seal.selector] on verifier_router
    pub verifier_entry: Account<'info, VerifierEntry>,
    /// The Groth16 verifier program pointed to by verifier_entry
    /// CHECK: Validated by the router during CPI
    pub groth16_verifier_program: UncheckedAccount<'info>,

    // --- Optional SPL token accounts (unchanged) ---
    // ... same as current
}
```

#### New verification logic:

```rust
pub fn complete_task_private(
    ctx: Context<CompleteTaskPrivate>,
    task_id: [u8; 32],
    proof: PrivateCompletionProof,
) -> Result<()> {
    let task = &ctx.accounts.task;

    // --- Standard validations (same as current) ---
    // task_id match, deadline, version, dependency, completion prereqs...

    // --- Validate journal size ---
    require!(
        proof.journal.len() == EXPECTED_JOURNAL_SIZE,
        CoordinationError::InvalidProofSize
    );

    // --- Validate image ID matches expected guest program ---
    require!(
        proof.image_id == TASK_COMPLETION_IMAGE_ID,
        CoordinationError::InvalidProof
    );

    // --- Parse journal (6 x 32-byte fields) ---
    let journal_task_pda: [u8; 32] = proof.journal[0..32].try_into().unwrap();
    let journal_agent: [u8; 32] = proof.journal[32..64].try_into().unwrap();
    let journal_constraint_hash: [u8; 32] = proof.journal[64..96].try_into().unwrap();
    let journal_output_commitment: [u8; 32] = proof.journal[96..128].try_into().unwrap();
    let journal_binding: [u8; 32] = proof.journal[128..160].try_into().unwrap();
    let journal_nullifier: [u8; 32] = proof.journal[160..192].try_into().unwrap();

    // --- Validate journal fields against on-chain state ---
    // Task PDA must match
    require!(
        journal_task_pda == ctx.accounts.task.key().to_bytes(),
        CoordinationError::InvalidProofBinding
    );
    // Agent pubkey must match signer
    require!(
        journal_agent == ctx.accounts.authority.key().to_bytes(),
        CoordinationError::InvalidProofBinding
    );
    // Constraint hash must match task's stored value
    require!(
        task.constraint_hash != [0u8; 32],
        CoordinationError::NotPrivateTask
    );
    require!(
        journal_constraint_hash == task.constraint_hash,
        CoordinationError::ConstraintHashMismatch
    );
    // Non-zero checks
    require!(
        journal_output_commitment != [0u8; 32],
        CoordinationError::InvalidOutputCommitment
    );
    require!(
        journal_binding != [0u8; 32],
        CoordinationError::InvalidProofBinding
    );
    require!(
        journal_nullifier != [0u8; 32],
        CoordinationError::InvalidNullifier
    );

    // --- Compute journal digest (SHA-256 of journal bytes) ---
    let journal_digest = solana_program::hash::hashv(&[&proof.journal]).to_bytes();

    // --- CPI to RISC Zero verifier router ---
    let seal = verifier_router::Seal::try_from_slice(&proof.seal)
        .map_err(|_| CoordinationError::InvalidProofSize)?;

    let cpi_accounts = verifier_router::cpi::accounts::Verify {
        router: ctx.accounts.router_account.to_account_info(),
        verifier_entry: ctx.accounts.verifier_entry.to_account_info(),
        verifier_program: ctx.accounts.groth16_verifier_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.verifier_router_program.to_account_info(),
        cpi_accounts,
    );
    verifier_router::cpi::verify(cpi_ctx, seal, proof.image_id, journal_digest)
        .map_err(|_| CoordinationError::ZkVerificationFailed)?;

    // --- Initialize nullifier (replay protection, unchanged) ---
    let nullifier = &mut ctx.accounts.nullifier_account;
    nullifier.nullifier_value = journal_nullifier;
    nullifier.task = ctx.accounts.task.key();
    nullifier.agent = ctx.accounts.authority.key();
    nullifier.spent_at = Clock::get()?.unix_timestamp;
    nullifier.bump = ctx.bumps.nullifier_account;

    // --- Execute reward distribution (unchanged from current) ---
    // ... same completion_helpers logic ...

    Ok(())
}
```

### 2.5 Update `constants.rs`

**File:** `programs/agenc-coordination/src/instructions/constants.rs`

Remove:
```rust
pub const ZK_WITNESS_FIELD_COUNT: usize = 68;
pub const ZK_EXPECTED_PROOF_SIZE: usize = 256;
pub const ZK_PROOF_A_SIZE: usize = 64;
pub const ZK_PROOF_B_SIZE: usize = 128;
pub const ZK_PROOF_C_SIZE: usize = 64;
```

The proof size and format constants are now in `risc0_config.rs`.

### 2.6 Update `state.rs`

**File:** `programs/agenc-coordination/src/state.rs`

The `Task` struct keeps `constraint_hash: [u8; 32]` — same purpose (identifies what
output must satisfy), same size, just computed with SHA-256 now.

The `Nullifier` struct is unchanged. PDA seeds change from
`["nullifier", expected_binding]` to `["nullifier", journal_nullifier]` — the nullifier
bytes come from the journal instead of a separate proof field. Same concept, different
source.

No structural changes needed. Account sizes stay the same.

### 2.7 Update `errors.rs`

**File:** `programs/agenc-coordination/src/errors.rs`

Remove:
```rust
DevelopmentKeyNotAllowed  // No more dev key concept
InvalidProofHash          // proof_hash is computed differently now
```

Modify description of:
```rust
InvalidProofSize  // "Invalid proof: expected 192-byte journal and valid seal"
```

Keep all other ZK errors — they still apply to the journal validation logic.

### 2.8 Update `lib.rs`

**File:** `programs/agenc-coordination/src/lib.rs`

- Remove: `pub mod verifying_key;`
- Add: `pub mod risc0_config;`
- The `complete_task_private` instruction signature changes to accept the new
  `PrivateCompletionProof` struct

### 2.9 Update `complete_task.rs`

**File:** `programs/agenc-coordination/src/instructions/complete_task.rs`

The guard that prevents public completion of private tasks stays:
```rust
require!(
    task.constraint_hash == [0u8; HASH_SIZE],
    CoordinationError::PrivateTaskRequiresZkProof
);
```
No changes needed.

---

## Phase 3: SDK Changes

### 3.1 Rewrite `proofs.ts`

**File:** `sdk/src/proofs.ts` — REWRITE entirely

Remove all Poseidon/snarkjs imports. Replace with:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

// SHA-256 based hashing (matches guest program)
export function computeConstraintHash(output: Uint8Array[]): Uint8Array {
  const hasher = createHash('sha256');
  for (const o of output) hasher.update(o);
  return new Uint8Array(hasher.digest());
}

export function computeOutputCommitment(output: Uint8Array[], salt: Uint8Array): Uint8Array {
  const hasher = createHash('sha256');
  for (const o of output) hasher.update(o);
  hasher.update(salt);
  return new Uint8Array(hasher.digest());
}

export function computeBinding(taskPda: Uint8Array, agentPubkey: Uint8Array, commitment: Uint8Array): Uint8Array {
  const inner = createHash('sha256').update(taskPda).update(agentPubkey).digest();
  return new Uint8Array(createHash('sha256').update(inner).update(commitment).digest());
}

export function computeNullifier(constraintHash: Uint8Array, agentSecret: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update(constraintHash).update(agentSecret).digest()
  );
}

export function generateSalt(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

export interface ProofRequest {
  taskPda: Uint8Array;
  agentPubkey: Uint8Array;
  outputValues: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  salt: Uint8Array;
  agentSecret: Uint8Array;
}

export interface ProofResult {
  seal: Uint8Array;           // 260 bytes (4 selector + 256 proof)
  journal: Uint8Array;        // 192 bytes
  imageId: Uint8Array;        // 32 bytes
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
}

export async function generateProof(
  params: ProofRequest,
  proverBinaryPath: string,
): Promise<ProofResult> {
  const input = JSON.stringify({
    task_pda: Array.from(params.taskPda),
    agent_pubkey: Array.from(params.agentPubkey),
    output_values: params.outputValues.map(v => Array.from(v)),
    salt: Array.from(params.salt),
    agent_secret: Array.from(params.agentSecret),
  });

  const { stdout } = await execFileAsync(proverBinaryPath, ['--stdin'], {
    input,
    timeout: 600_000, // 10 min for Groth16 wrapping
    maxBuffer: 10 * 1024 * 1024,
  });

  const resp = JSON.parse(stdout);
  const journal = new Uint8Array(resp.journal);

  return {
    seal: new Uint8Array(resp.seal),
    journal,
    imageId: new Uint8Array(resp.image_id),
    constraintHash: journal.slice(64, 96),
    outputCommitment: journal.slice(96, 128),
    binding: journal.slice(128, 160),
    nullifier: journal.slice(160, 192),
  };
}

export function verifyJournalLocally(journal: Uint8Array, params: {
  taskPda: Uint8Array;
  agentPubkey: Uint8Array;
  outputValues: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  salt: Uint8Array;
  agentSecret: Uint8Array;
}): boolean {
  const ch = computeConstraintHash(params.outputValues);
  const oc = computeOutputCommitment(params.outputValues, params.salt);
  const b = computeBinding(params.taskPda, params.agentPubkey, oc);
  const n = computeNullifier(ch, params.agentSecret);

  const j = journal;
  return (
    Buffer.compare(j.slice(0, 32), params.taskPda) === 0 &&
    Buffer.compare(j.slice(32, 64), params.agentPubkey) === 0 &&
    Buffer.compare(j.slice(64, 96), ch) === 0 &&
    Buffer.compare(j.slice(96, 128), oc) === 0 &&
    Buffer.compare(j.slice(128, 160), b) === 0 &&
    Buffer.compare(j.slice(160, 192), n) === 0
  );
}
```

### 3.2 Update `constants.ts`

**File:** `sdk/src/constants.ts`

Remove:
```typescript
PROOF_SIZE_BYTES = 256
NARGO_EXECUTE_TIMEOUT_MS = 120_000
SUNSPOT_PROVE_TIMEOUT_MS = 300_000
PUBLIC_INPUTS_COUNT = 67
VERIFICATION_COMPUTE_UNITS = 50_000
VERIFIER_PROGRAM_ID = '8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ'
```

Add:
```typescript
export const RISC_ZERO_PROOF_SIZE = 256;
export const RISC_ZERO_SEAL_SIZE = 260; // 4-byte selector + 256-byte proof
export const RISC_ZERO_JOURNAL_SIZE = 192; // 6 x 32 bytes
export const RISC_ZERO_PROVE_TIMEOUT_MS = 600_000; // 10 min (Groth16 wrapping is slow)
export const VERIFIER_ROUTER_PROGRAM_ID = '6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7';
export const GROTH16_VERIFIER_PROGRAM_ID = 'THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge';
export const RECOMMENDED_CU_COMPLETE_TASK_PRIVATE = 280_000; // ~80k verify + journal hash + overhead
export const RECOMMENDED_CU_COMPLETE_TASK_PRIVATE_TOKEN = 350_000;
```

Keep: `HASH_SIZE = 32`, `OUTPUT_FIELD_COUNT = 4`, `SEEDS.NULLIFIER`.

### 3.3 Update `tasks.ts`

**File:** `sdk/src/tasks.ts`

Update `PrivateCompletionProof` interface:
```typescript
export interface PrivateCompletionProof {
  seal: Uint8Array;       // 260 bytes (selector + Groth16)
  journal: Uint8Array;    // 192 bytes
  imageId: Uint8Array;    // 32 bytes
}
```

Update `completeTaskPrivate()`:
- Pass `seal`, `journal`, `imageId` to the program instead of
  `proofData`, `constraintHash`, `outputCommitment`, `expectedBinding`, `nullifier`
- Derive nullifier PDA from `journal.slice(160, 192)` (nullifier bytes in journal)
- Add `verifierRouterProgram`, `routerAccount`, `verifierEntry`,
  `groth16VerifierProgram` to remaining accounts

### 3.4 Update `nullifier-cache.ts`

**File:** `sdk/src/nullifier-cache.ts` — KEEP as-is.
Nullifier values are still 32-byte hashes, just SHA-256 instead of Poseidon.

### 3.5 Update `proof-validation.ts`

**File:** `sdk/src/proof-validation.ts`

Update size checks:
- `seal.length === 260` (was `proofData.length === 256`)
- `journal.length === 192`
- Parse journal to extract and validate individual fields

### 3.6 Rewrite `privacy.ts`

**File:** `sdk/src/privacy.ts`

Remove all nargo/sunspot references. The `PrivacyClient.proveAndComplete()` method
now calls the RISC Zero host binary via `generateProof()`.

### 3.7 Update `package.json`

**File:** `sdk/package.json`

Remove dependencies:
```json
"poseidon-lite": "^0.3.0",
"snarkjs": "^0.7.0"
```

No new npm dependencies needed. SHA-256 is in Node.js `crypto`. Proof generation
calls a Rust binary.

### 3.8 Update `index.ts` exports

**File:** `sdk/src/index.ts`

Update all ZK-related exports to match the new function signatures.

---

## Phase 4: Runtime Changes

### 4.1 Rewrite `proof/types.ts`

**File:** `runtime/src/proof/types.ts`

```typescript
export interface ProofEngineConfig {
  proverBinaryPath: string;     // Path to zkvm/host binary
  imageId?: Uint8Array;         // Override image ID (for testing)
  cache?: ProofCacheConfig;
  logger?: Logger;
  metrics?: MetricsCollector;
}

export interface ProofInputs {
  taskPda: Uint8Array;          // 32 bytes
  agentPubkey: Uint8Array;      // 32 bytes
  output: Uint8Array[];         // 4 x 32-byte values
  salt: Uint8Array;             // 32 bytes
  agentSecret?: Uint8Array;     // 32 bytes
}

export interface EngineProofResult {
  seal: Uint8Array;             // 260 bytes
  journal: Uint8Array;          // 192 bytes
  imageId: Uint8Array;          // 32 bytes
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
  generationTimeMs: number;
  fromCache: boolean;
}
```

### 4.2 Rewrite `proof/engine.ts`

**File:** `runtime/src/proof/engine.ts`

Same structure (implements `ProofGenerator` interface), but:
- Calls `generateProof()` from SDK (which shells out to Rust binary)
- `buildPublicSignals()` is deleted (no more 68-element array)
- `verify()` calls `verifyJournalLocally()` from SDK
- Cache key: `taskPda|agentPubkey|output[0]|...|output[3]|salt` (same concept, bytes now)

### 4.3 Update `task/proof-pipeline.ts`

**File:** `runtime/src/task/proof-pipeline.ts`

`ProofGenerator` interface stays. Implementations change to produce
`{ seal, journal, imageId }` instead of `{ proof, constraintHash, ... }`.

### 4.4 Update `task/operations.ts`

**File:** `runtime/src/task/operations.ts`

`completeTaskPrivate()` passes the new proof struct to the program.
Add verifier router accounts to the transaction.

### 4.5 Update `autonomous/agent.ts`

**File:** `runtime/src/autonomous/agent.ts`

- Replace `import { generateProof, generateSalt } from '@agenc/sdk'` with new SDK functions
- `DEFAULT_CIRCUIT_PATH` → `DEFAULT_PROVER_BINARY_PATH`
- Output is now `Uint8Array[]` instead of `bigint[]`

### 4.6 Update `builder.ts`

**File:** `runtime/src/builder.ts`

`withProofs(config)` accepts new `ProofEngineConfig` with `proverBinaryPath`.

### 4.7 Regenerate IDL

After `anchor build`, copy new IDL to `runtime/idl/agenc_coordination.json` and
regenerate `runtime/src/types/agenc_coordination.ts`.

---

## Phase 5: Delete Legacy

### Files to DELETE:

```
# Entire directories
circuits/                           # Noir circuits (deprecated)
circuits-circom/                    # Circom + MPC ceremony
examples/zk-proof-demo/             # snarkjs proof demo

# On-chain
programs/agenc-coordination/src/verifying_key.rs

# Scripts
scripts/deploy-verifier.sh
scripts/validate-verifying-key.sh

# Claude rules
.claude/rules/anchor-zk-verification.md
.claude/rules/noir-circuits.md
.claude/rules/zk-sdk.md
.claude/rules/zk-overview.md

# SDK
sdk/src/types/zkpassport-poseidon2.d.ts
```

### Files to UPDATE (remove stale references):

```
.claude/rules/runtime.md            # Update proof engine section
CLAUDE.md                           # Update ZK stack references
docs/PRIVACY_README.md              # Rewrite for RISC Zero
docs/DEPLOYMENT_CHECKLIST.md        # Remove MPC ceremony, add image ID check
docs/architecture/flows/zk-proof-flow.md  # Rewrite flow diagram
```

---

## Phase 6: MCP Server

### 6.1 Rewrite `mcp/src/tools/circuits.ts`

Replace Circom/snarkjs tools with RISC Zero equivalents:

| Old Tool | New Tool | What It Does |
|----------|----------|-------------|
| `agenc_compile_circuit` | `agenc_build_guest` | `cargo build` in `zkvm/` |
| `agenc_generate_witness` | (removed) | No separate witness step |
| `agenc_generate_proof` | `agenc_generate_proof` | Call host binary |
| `agenc_verify_proof` | `agenc_verify_journal` | Local journal validation |
| `agenc_get_circuit_info` | `agenc_get_guest_info` | Show image ID, ELF path |
| `agenc_get_proving_key_info` | (removed) | No trusted setup |

---

## Phase 7: Tests

### 7.1 Rewrite integration tests

| File | Changes |
|------|---------|
| `tests/complete_task_private.ts` | New proof struct, verifier router accounts, journal parsing |
| `tests/zk-proof-lifecycle.ts` | SHA-256 based hashes, new proof format |
| `tests/sdk-proof-generation.ts` | Test host binary invocation, journal structure |
| `tests/audit-high-severity.ts` | Update nullifier tests (journal-sourced) |
| `tests/security-audit-fixes.ts` | Update zero-check tests |

### 7.2 Update all task creation tests

Every test that passes `null` for `constraint_hash` stays the same — the field
is still `Option<[u8; 32]>` on `create_task`, just computed with SHA-256 now.

### 7.3 LiteSVM considerations

The RISC Zero verifier is a separate program. In LiteSVM tests, you'll need to
either:
- **Mock the CPI** — have the verifier always return Ok (for unit tests)
- **Load the verifier program** into LiteSVM — for integration tests

Recommendation: Mock for fast tests, real verifier for CI integration tests.

---

## Phase 8: Examples & Docs

### 8.1 Rewrite `examples/simple-usage/`

Update proof generation to use the RISC Zero host binary.

### 8.2 Update docs

- `docs/PRIVACY_README.md` — Full rewrite for RISC Zero
- `docs/DEPLOYMENT_CHECKLIST.md` — Remove MPC ceremony, add image ID verification
- `docs/architecture/flows/zk-proof-flow.md` — New flow diagram
- `CLAUDE.md` — Update ZK stack section

---

## Dependency Order

```
Phase 1 (guest + host)  ← no dependencies, start here
    ↓
Phase 2 (on-chain)      ← needs image ID from Phase 1
    ↓
Phase 3 (SDK)           ← needs new instruction format from Phase 2
Phase 4 (runtime)       ← needs new SDK from Phase 3
    ↓
Phase 5 (delete legacy) ← after everything compiles
Phase 6 (MCP)           ← after SDK changes
Phase 7 (tests)         ← after on-chain + SDK changes
Phase 8 (docs)          ← last
```

Phases 1 and 2 are blocking. Phases 3-4 can partially overlap. Phases 5-8 are
cleanup and can be parallelized.

---

## Security Properties of Final System

| Property | How It's Achieved |
|----------|-------------------|
| **Proof soundness** | RISC Zero STARK + Groth16 wrapping (multi-audit: KALOS, Cantina, Zellic) |
| **On-chain verification** | CPI to risc0-solana verifier (Veridise audit) + groth16-solana (Light Protocol audit) |
| **Output privacy** | Private inputs (output, salt, secret) never leave the guest; only journal is public |
| **Replay protection** | Nullifier PDA (same mechanism as current, seeds from journal) |
| **Binding** | Journal contains task_pda + agent_pubkey, validated against on-chain accounts |
| **Program integrity** | image_id hardcoded on-chain, proves the exact guest binary that ran |
| **Hash security** | SHA-256 (NIST standard, no exotic math, universally audited) |
| **No trusted setup risk** | Universal Groth16 setup maintained by RISC Zero, not circuit-specific |

---

## Known Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| risc0-solana uses Anchor 0.31.1, AgenC uses 0.32.1 | Medium | Fork risc0-solana and bump Anchor version; verifier code is small |
| risc0-solana pins risc0-zkvm 3.0.3 (not latest 5.0) | Low | 3.0.x is the stable Solana-compatible version; use it |
| Groth16 local proving requires Docker + x86 | Medium | Use Bonsai for CI/cloud; local dev on x86 or use STARK-only for dev |
| CPI adds ~5k CU overhead vs inline verification | Low | Still under 300k CU total; use compute budget request |
| RISC Zero could change API in future versions | Low | Pin exact crate versions; the fork insulates you |
