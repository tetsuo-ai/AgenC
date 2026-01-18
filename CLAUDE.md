# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgenC is a privacy-preserving AI agent coordination protocol built on Solana. It enables decentralized task coordination with zero-knowledge proofs for private task completions.

**Modules:**
- **Anchor Program** - Solana smart contract for task coordination, disputes, and rewards
- **TypeScript SDK** - Privacy-preserving task coordination client (`@agenc/sdk`)
- **Demo App** - React web interface for privacy workflow demonstration
- **ZK Circuits** - Noir circuits for private task completion proofs (Sunspot/Groth16)
- **Test Infrastructure** - TypeScript integration tests and Rust fuzz testing

## Build Commands

### Solana Anchor Program (Rust)

```bash
# Prerequisites: solana-cli, anchor-cli
cd programs/agenc-coordination
anchor build      # Build the Solana program
anchor test       # Run tests (requires local validator)
```

### TypeScript SDK

```bash
cd sdk
npm install       # Install dependencies
npm run build     # Build SDK (outputs to dist/)
npm run typecheck # Type checking only
```

### Demo App

```bash
cd demo-app
npm install       # Install dependencies
npm run dev       # Development server
npm run build     # Production build (outputs to dist/)
```

### ZK Circuits (Noir)

```bash
cd circuits/task_completion
nargo compile     # Compile circuit
nargo test        # Run circuit tests
nargo prove       # Generate proof (requires Prover.toml inputs)
```

### Integration Tests

```bash
anchor test                           # Run all TypeScript tests
npx ts-mocha tests/smoke.ts          # Run specific test file
npx ts-mocha tests/test_1.ts         # Main test suite
```

### Fuzz Tests

```bash
cd programs/agenc-coordination
cargo fuzz run claim_task            # Fuzz claim_task instruction
cargo fuzz run complete_task         # Fuzz complete_task instruction
cargo fuzz run vote_dispute          # Fuzz vote_dispute instruction
cargo fuzz run resolve_dispute       # Fuzz resolve_dispute instruction
```

## Architecture

```
AgenC/
├── programs/agenc-coordination/     # Solana Anchor program (Rust)
│   ├── src/
│   │   ├── lib.rs                   # Program entrypoint
│   │   ├── state.rs                 # Account structures
│   │   ├── errors.rs                # Error definitions
│   │   ├── events.rs                # Event emissions
│   │   ├── instructions/            # Instruction handlers (20 instructions)
│   │   └── utils/                   # Multisig and version utilities
│   └── fuzz/                        # Fuzz testing targets
│       ├── fuzz_targets/            # claim_task, complete_task, vote_dispute, resolve_dispute
│       └── src/                     # Fuzz test infrastructure
├── sdk/                             # TypeScript SDK (@agenc/sdk)
│   ├── src/
│   │   ├── index.ts                 # Main exports
│   │   ├── client.ts                # PrivacyClient class
│   │   ├── proofs.ts                # ZK proof generation/verification
│   │   ├── tasks.ts                 # Task operations
│   │   ├── privacy.ts               # Privacy Cash integration
│   │   └── constants.ts             # Program IDs, RPC endpoints
│   └── dist/                        # Build output
├── demo-app/                        # React web interface
│   ├── src/
│   │   ├── App.tsx                  # Main application
│   │   └── components/
│   │       └── steps/               # 6-step privacy workflow UI
│   └── dist/                        # Production build
├── circuits/task_completion/        # Noir ZK circuits
│   ├── src/main.nr                  # Task completion proof circuit
│   ├── Nargo.toml                   # Circuit configuration
│   └── Prover.toml                  # Example prover inputs
├── examples/
│   ├── helius-webhook/              # Webhook handler (TypeScript)
│   └── tetsuo-integration/          # Tetsuo integration example
├── tests/                           # TypeScript test suite
│   ├── test_1.ts                    # Main integration tests
│   ├── smoke.ts                     # Devnet smoke tests
│   ├── coordination-security.ts     # Security-focused tests
│   ├── audit-high-severity.ts       # Audit issue tests
│   ├── rate-limiting.ts             # Rate limiting tests
│   ├── upgrades.ts                  # Protocol upgrade tests
│   ├── complete_task_private.ts     # ZK private completion tests
│   ├── integration.ts               # Anchor 0.32 lifecycle tests
│   └── minimal.ts                   # Minimal debugging tests
├── migrations/                      # Protocol migration tools
│   ├── migration_utils.ts           # Migration utilities
│   ├── v1_to_v2.rs                  # Version migration
│   └── README.md
├── scripts/                         # Build/deployment scripts
│   └── simulate_upgrade.sh          # Upgrade simulation
├── audit/                           # Bug bounty & reviews
│   ├── BOUNTY_PROGRAM.md            # Bug bounty details
│   └── INTERNAL_REVIEW.md           # Internal review notes
└── docs/                            # Documentation
    ├── DEPLOYMENT.md                # Solana deployment guide
    ├── INTEGRATION.md               # Framework integration guide
    ├── PRIVACY_README.md            # Privacy features documentation
    ├── FUZZ_TESTING.md              # Fuzz testing guide
    ├── UPGRADE_GUIDE.md             # Version upgrade guide
    ├── MAINNET_DEPLOYMENT.md        # Mainnet deployment checklist
    ├── SECURITY_AUDIT_*.md          # Security audit documentation
    ├── architecture.md              # Architecture overview
    └── audit/                       # Audit documentation
        ├── AUDIT_ROADMAP.md
        ├── RUST_MIGRATION_ROADMAP.md
        └── THREAT_MODEL.md
```

## TypeScript SDK

### Installation

```bash
npm install @agenc/sdk
```

### Core Client

```typescript
import { PrivacyClient, PrivacyClientConfig } from '@agenc/sdk';
import { Connection, Keypair } from '@solana/web3.js';

const config: PrivacyClientConfig = {
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: keypair,
};
const client = new PrivacyClient(config);
```

### Task Operations

```typescript
import { createTask, claimTask, completeTask, completeTaskPrivate, getTask } from '@agenc/sdk';
import { TaskParams, TaskState, TaskStatus } from '@agenc/sdk';

// Create task
const params: TaskParams = {
  taskId: 'task-123',
  reward: 1_000_000, // lamports
  constraintHash: [...],
};
await createTask(client, params);

// Claim and complete
await claimTask(client, taskId);
await completeTask(client, taskId, proofHash, resultData);

// Private completion (with ZK proof)
await completeTaskPrivate(client, taskId, proof);
```

### ZK Proof Operations

```typescript
import { generateProof, verifyProofLocally, ProofGenerationParams, ProofResult } from '@agenc/sdk';

const params: ProofGenerationParams = {
  taskId: 42n,
  agentPubkey: agent.publicKey.toBytes(),
  output: [1n, 2n, 3n, 4n],
  salt: 12345n,
};

const result: ProofResult = await generateProof(params);
const valid = await verifyProofLocally(result.proof);
```

### Constants

```typescript
import { PROGRAM_ID, VERIFIER_PROGRAM_ID, PRIVACY_CASH_PROGRAM_ID, DEVNET_RPC, MAINNET_RPC } from '@agenc/sdk';
```

## Zero-Knowledge Circuits

### Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Circuit | Noir | ZK circuit definition |
| Prover | Sunspot (Groth16) | Off-chain proof generation |
| Verifier | Sunspot on Solana | On-chain proof verification |
| Hash | Poseidon2 | ZK-friendly hashing |

**Verifier Program ID:** `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ`
**Expected Proof Size:** 388 bytes

The Noir circuit at `circuits/task_completion/src/main.nr` proves task completion without revealing the output:

**Public Inputs:**
- `task_id` - Task identifier
- `agent_pubkey` - Agent's public key (32 bytes)
- `constraint_hash` - Hash of task constraints
- `output_commitment` - Commitment to output

**Private Inputs:**
- `output` - Actual task output (4 fields)
- `salt` - Randomness for commitment

**Verification:**
1. Output satisfies task constraint: `hash(output) == constraint_hash`
2. Commitment is correct: `hash(constraint_hash, salt) == output_commitment`
3. Proof is bound to task and agent

### Proof Flow

```
1. Agent computes task output locally
2. Agent generates Noir proof via nargo/sunspot
3. Agent submits proof on-chain via complete_task_private
4. Verifier CPI validates proof
5. If valid, agent receives reward without revealing output
```

## Anchor Program Instructions

| Instruction | Purpose |
|-------------|---------|
| `initialize_protocol` | Set up protocol config, treasury, fees |
| `register_agent` | Register agent with capabilities + stake |
| `deregister_agent` | Unregister agent from protocol |
| `update_agent` | Update agent capabilities |
| `create_task` | Post task with escrow reward |
| `claim_task` | Worker claims a task |
| `expire_claim` | Handle claim timeout |
| `complete_task` | Submit proof, receive payment |
| `complete_task_private` | Submit ZK proof for private completion |
| `cancel_task` | Creator cancels, gets refund |
| `update_state` | Sync shared state with version |
| `initiate_dispute` | Start dispute resolution |
| `vote_dispute` | Arbiters vote on dispute |
| `resolve_dispute` | Execute dispute resolution |
| `apply_dispute_slash` | Apply penalty for disputes |
| `expire_dispute` | Handle dispute timeout |
| `migrate` | Version migration handler |
| `update_protocol_fee` | Adjust protocol fees |
| `update_rate_limits` | Configure rate limits |

## Code Style

- **Rust**: Anchor framework conventions
- **TypeScript**: Strict mode, ESM and CJS dual builds

### Naming Conventions

| Language | Type | Convention | Example |
|----------|------|------------|---------|
| Rust | Types | `PascalCase` | `AgentRegistration`, `TaskStatus` |
| Rust | Functions | `snake_case` | `register_agent`, `complete_task` |
| TypeScript | Types | `PascalCase` | `PrivacyClient`, `TaskParams` |
| TypeScript | Functions | `camelCase` | `generateProof`, `createTask` |

## Error Handling

### Anchor Program (CoordinationError)

Error codes are organized by category:

```rust
// Agent errors (6000-6099)
AgentAlreadyRegistered  // Agent already exists
AgentNotFound           // Agent doesn't exist
UnauthorizedAgent       // Signer doesn't own agent
AgentHasActiveTasks     // Can't deregister with active tasks

// Task errors (6100-6199)
TaskNotOpen             // Task not accepting claims
TaskExpired             // Past deadline
TaskNotInProgress       // Wrong task state
CompetitiveTaskAlreadyWon // Someone else completed first
ConstraintHashMismatch  // ZK proof constraint doesn't match task
NotPrivateTask          // Task has no constraint_hash

// Claim errors (6200-6299)
AlreadyClaimed          // Worker already claimed
NotClaimed              // Worker hasn't claimed
ClaimAlreadyCompleted   // Can't complete twice
ZkVerificationFailed    // ZK proof invalid
InvalidProofSize        // Proof not 388 bytes

// Dispute errors (6300-6399)
DisputeNotActive        // Dispute already resolved
VotingEnded             // Past voting deadline
AlreadyVoted            // Arbiter voted already
NotArbiter              // Missing ARBITER capability

// General errors (6600-6699)
InvalidInput            // Bad parameter
ArithmeticOverflow      // Math overflow
InsufficientFunds       // Not enough lamports
InvalidAccountOwner     // Account not owned by program

// Rate limiting (6700-6799)
RateLimitExceeded       // 24h limit reached
CooldownNotElapsed      // Too soon since last action

// Version errors (6800-6899)
AccountVersionTooOld    // Needs migration
AccountVersionTooNew    // Needs program upgrade
```

## Key Design Patterns

### PDA Seeds (Anchor)

```rust
// Protocol config (singleton)
["protocol"]

// Agent registration
["agent", agent_id]              // agent_id: [u8; 32]

// Task and related accounts
["task", creator, task_id]       // creator: Pubkey, task_id: [u8; 32]
["escrow", task_pda]             // task_pda: Pubkey
["claim", task_pda, worker_pda]  // task_pda: Pubkey, worker_pda: Pubkey

// Disputes
["dispute", dispute_id]          // dispute_id: [u8; 32]
["vote", dispute_pda, voter]     // dispute_pda: Pubkey, voter: Pubkey

// Shared state (for coordination)
["state", key]                   // key: String
```

## Configuration

### Agent Capabilities (Bitmask)

```rust
COMPUTE    = 1 << 0   // Computational tasks
STORAGE    = 1 << 1   // Data storage
INFERENCE  = 1 << 2   // ML inference
NETWORK    = 1 << 3   // Network relay
COORDINATOR = 1 << 4  // Task coordination
ARBITER    = 1 << 7   // Dispute arbitration
```

### Task Types

```rust
Exclusive     // Single worker claims
Collaborative // Multiple workers contribute
Competitive   // First completion wins
```

## Testing

### TypeScript Integration Tests

Located in `tests/`:

| File | Purpose |
|------|---------|
| `test_1.ts` | Main integration test suite |
| `smoke.ts` | Devnet smoke tests |
| `coordination-security.ts` | Security-focused tests |
| `audit-high-severity.ts` | Tests for audit findings |
| `rate-limiting.ts` | Rate limiting behavior tests |
| `upgrades.ts` | Protocol upgrade tests |
| `complete_task_private.ts` | ZK private completion tests |
| `integration.ts` | Anchor 0.32 lifecycle tests |
| `minimal.ts` | Minimal debugging tests |

### Fuzz Testing

Located in `programs/agenc-coordination/fuzz/`:

| Target | Tests |
|--------|-------|
| `claim_task` | Task claiming edge cases |
| `complete_task` | Task completion scenarios |
| `vote_dispute` | Dispute voting logic |
| `resolve_dispute` | Dispute resolution |

## Documentation Index

| Document | Description |
|----------|-------------|
| `docs/DEPLOYMENT.md` | Solana deployment guide |
| `docs/INTEGRATION.md` | Framework integration guide |
| `docs/PRIVACY_README.md` | Privacy features documentation |
| `docs/FUZZ_TESTING.md` | Fuzz testing guide |
| `docs/UPGRADE_GUIDE.md` | Version upgrade instructions |
| `docs/MAINNET_DEPLOYMENT.md` | Mainnet deployment checklist |
| `docs/architecture.md` | Architecture overview |
| `docs/audit/THREAT_MODEL.md` | Security threat model |
| `docs/NOIR_REFERENCE.md` | Noir language reference for ZK circuits |
| `audit/BOUNTY_PROGRAM.md` | Bug bounty program details |
| `sdk/README.md` | SDK usage documentation |
| `migrations/README.md` | Migration tooling guide |

## Deployment

See `docs/DEPLOYMENT.md` for full Solana deployment guide.

```bash
# Devnet deployment
solana config set --url devnet
anchor deploy

# Update program ID in lib.rs after deployment
declare_id!("YOUR_ACTUAL_PROGRAM_ID");
```

## Thread Safety

- Anchor programs are single-threaded per transaction
- Account locking prevents concurrent modifications to the same accounts
- Use optimistic locking for shared state updates

## Security Patterns

### Critical Invariants

These invariants MUST be maintained across all code changes:

| Invariant | Location | Description |
|-----------|----------|-------------|
| Competitive task single-completion | `complete_task.rs`, `complete_task_private.rs` | Competitive tasks (`TaskType::Competitive`) must check `task.completions == 0` before paying rewards |
| Account owner validation | `resolve_dispute.rs` | Always validate `account.owner == crate::ID` before deserializing accounts from `remaining_accounts` |
| Constraint hash binding | `complete_task_private.rs` | ZK proofs must verify `proof.constraint_hash == task.constraint_hash` |
| Rate limit enforcement | `create_task.rs`, `initiate_dispute.rs` | Check cooldown and 24h limits before state-changing operations |

### Anchor Security Best Practices

```rust
// ALWAYS validate remaining_accounts ownership before deserialization
require!(
    account_info.owner == &crate::ID,
    CoordinationError::InvalidAccountOwner
);

// ALWAYS use checked arithmetic, NOT saturating
let result = a.checked_add(b).ok_or(CoordinationError::ArithmeticOverflow)?;

// NEVER use saturating_add/sub in production code (masks overflows)
// let result = a.saturating_add(b);  // BAD - hides errors

// ALWAYS check task type before reward distribution
if task.task_type == TaskType::Competitive {
    require!(task.completions == 0, CoordinationError::CompetitiveTaskAlreadyWon);
}
```

### SDK Production Requirements

The SDK contains placeholder implementations that MUST be replaced for production:

| Function | File | Issue | Production Fix |
|----------|------|-------|----------------|
| `computeConstraintHashFromOutput` | `proofs.ts` | XOR-based placeholder | Implement Poseidon2 hash |
| `computeCommitment` | `proofs.ts` | XOR-based placeholder | Implement Poseidon2 hash |
| `computeConstraintHash` | `privacy.ts` | Returns empty buffer | Implement real hash |
| `computeOutputCommitment` | `privacy.ts` | Returns empty buffer | Implement real hash |

These functions throw errors in production mode (`process.env.NODE_ENV === 'production'`).

### Path Traversal Prevention

When accepting file paths (e.g., `circuitPath` in proof generation):

```typescript
// Validate paths to prevent directory traversal
if (circuitPath.includes('..') || path.isAbsolute(circuitPath)) {
    throw new Error('Invalid circuit path');
}
```

## Common Pitfalls

### Anchor 0.32 Compatibility

Test files must use these patterns for Anchor 0.32:

```typescript
// Use .accountsPartial() instead of .accounts() for optional accounts
await program.methods
    .resolveDispute()
    .accountsPartial({
        worker: null,           // Optional account
        workerClaim: null,      // Optional account
    })
    .rpc();

// Event names are camelCase, not PascalCase
const events = await program.addEventListener('taskCompleted', callback);
// NOT: 'TaskCompleted'
```

### Test Logic Errors

```typescript
// WRONG: Modifying local copy has no on-chain effect
const agent = await program.account.agentRegistration.fetch(agentPda);
agent.activeTasks = 10;  // This only changes local JS object!

// RIGHT: Use program instructions to modify on-chain state
await program.methods.updateAgent(...).rpc();
```

### Keypair Reuse in Tests

```typescript
// WRONG: Creating new keypair loses authority
const worker = Keypair.generate();  // in before()
// ... later in test ...
const worker = Keypair.generate();  // DIFFERENT keypair!

// RIGHT: Store and reuse keypairs
let workerKeypair: Keypair;
before(() => { workerKeypair = Keypair.generate(); });
// ... use workerKeypair throughout ...
```

## Environment Variables

| Variable | Used In | Purpose |
|----------|---------|---------|
| `VITE_SOLANA_RPC_URL` | demo-app | Custom RPC endpoint (defaults to devnet) |
| `HELIUS_API_KEY` | examples/helius-webhook | Helius API authentication |
| `NODE_ENV` | sdk | When `production`, SDK placeholder functions throw errors |

## Security Audit Checklist

When modifying instruction handlers, verify:

- [ ] Account ownership validated for `remaining_accounts`
- [ ] Competitive task completion check present
- [ ] Arithmetic uses `checked_*` operations
- [ ] Rate limits enforced where applicable
- [ ] Events emitted for state changes
- [ ] PDA seeds match expected format
- [ ] Signer constraints properly applied
- [ ] Version compatibility checked
