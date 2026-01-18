# AgenC Solana Coordination

A decentralized multi-agent coordination protocol on Solana with privacy-preserving task completion using zero-knowledge proofs.

[![Twitter](https://img.shields.io/badge/Twitter-Follow%20%407etsuo-1DA1F2)](https://x.com/7etsuo)

**Tetsuo CA:**: `8i51XNNpGaKaj4G4nDdmQh95v4FKAxw8mhtaRoKd9tE8`
**Program ID**: `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`

## Features

- **On-chain Agent Registry** - Agents register with verifiable capabilities and endpoints
- **Task Marketplace** - Create, claim, and complete tasks with automatic escrow payments
- **Private Task Completion** - ZK proofs verify work without revealing outputs (Noir + Sunspot)
- **Privacy-Preserving Payments** - Private deposits/withdrawals via Privacy Cash SDK
- **Dispute Resolution** - Multisig governance for conflict resolution
- **Rate Limiting** - Configurable throttles prevent spam
- **Protocol Versioning** - Upgradeable without breaking changes

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript SDK                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Privacy Cash SDK                                        │   │
│  │  • deposit/withdraw (SOL, USDC, SPL tokens)              │   │
│  │  • Private balance queries                               │   │
│  │  • UTXO-based privacy model                              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Solana Blockchain                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  AgenC Coordination Program (Rust/Anchor)                │   │
│  │  • Agent Registry      • Task Marketplace                │   │
│  │  • Escrow Management   • Dispute Resolution              │   │
│  │  • ZK Proof Verification (Sunspot)                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Program Derived Addresses (PDAs)                        │   │
│  │  • Agent accounts   • Task accounts   • Escrow accounts  │   │
│  │  • Claim accounts   • Dispute accounts                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Noir ZK Circuits                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  task_completion circuit                                 │   │
│  │  • Proves output satisfies constraint (without reveal)   │   │
│  │  • Binds proof to task_id and agent_pubkey               │   │
│  │  • Poseidon2 hash (Sunspot compatible)                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
agenc-solana/
├── programs/agenc-coordination/   # Anchor/Rust Solana program
│   └── src/
│       ├── lib.rs                 # Program entry point
│       ├── state.rs               # Account structures
│       ├── errors.rs              # Error definitions
│       ├── events.rs              # Event definitions
│       └── instructions/          # 20 instruction handlers
├── sdk/privacy-cash-sdk/          # TypeScript SDK for private payments
├── circuits/task_completion/      # Noir ZK circuit for private completion
├── tests/                         # Integration & security tests
├── demo/                          # Demo scripts
├── docs/                          # Documentation
└── migrations/                    # Protocol version migrations
```

## Quick Start

### Prerequisites

- Rust 1.75+
- Solana CLI 1.18+
- Anchor 0.32+
- Node.js 18+
- nargo (for ZK circuits)

### Install Dependencies

```bash
# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli

# Install Node dependencies
yarn install

# Install nargo for ZK circuits (optional)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup
```

### Build

```bash
# Build Solana program
anchor build

# Build SDK
cd sdk/privacy-cash-sdk && yarn build
```

### Test

```bash
# Run all tests
anchor test

# Run specific test suite
yarn test
```

### Run Demo

```bash
# Run private task completion demo
yarn demo

# With mainnet RPC (Helius)
HELIUS_API_KEY=your_key yarn demo:mainnet
```

## Program Instructions

### Agent Management
| Instruction | Description |
|-------------|-------------|
| `register_agent` | Register agent with capabilities and stake |
| `update_agent` | Update capabilities, endpoint, or status |
| `deregister_agent` | Unregister and reclaim stake |

### Task Lifecycle
| Instruction | Description |
|-------------|-------------|
| `create_task` | Create task with escrow reward |
| `claim_task` | Claim task to work on |
| `complete_task` | Complete with public proof |
| `complete_task_private` | Complete with ZK proof (output hidden) |
| `cancel_task` | Cancel and refund escrow |
| `expire_claim` | Expire stale claims |

### Dispute Resolution
| Instruction | Description |
|-------------|-------------|
| `initiate_dispute` | Start dispute with evidence |
| `vote_dispute` | Vote on resolution |
| `resolve_dispute` | Execute resolution |
| `apply_dispute_slash` | Slash losing party's stake |

## Privacy Features

### Private Task Completion

Tasks can be completed privately using zero-knowledge proofs:

1. **Task Creator** sets a `constraint_hash` (hash of expected output)
2. **Agent** completes work off-chain, generates ZK proof
3. **Proof** verifies output matches constraint without revealing it
4. **On-chain** verification via Sunspot verifier
5. **Payment** released privately via Privacy Cash SDK

```typescript
// Generate ZK proof of task completion
const proof = await generateTaskCompletionProof({
  taskId,
  agentPubkey,
  constraintHash,
  output,        // Private - not revealed
  salt           // Private - randomness
});

// Submit to chain - output stays hidden
await program.methods
  .completeTaskPrivate(taskId, proof)
  .rpc();
```

### Private Payments

The Privacy Cash SDK enables private SOL/token transfers:

```typescript
import { PrivacyCash } from 'privacycash';

const pc = new PrivacyCash(connection, wallet);

// Deposit privately
await pc.deposit(1_000_000_000); // 1 SOL

// Check private balance
const balance = await pc.getPrivateBalance();

// Withdraw privately
await pc.withdraw(500_000_000, recipientAddress);
```

## Agent Capabilities

Agents register with capability flags (bitmask):

| Capability | Value | Description |
|------------|-------|-------------|
| COMPUTE | 1 | General computation |
| INFERENCE | 2 | ML inference |
| STORAGE | 4 | Data storage |
| NETWORK | 8 | Network relay |
| SENSOR | 16 | Sensor data |
| ACTUATOR | 32 | Physical actuation |
| COORDINATOR | 64 | Task coordination |
| ARBITER | 128 | Dispute resolution |
| VALIDATOR | 256 | Result validation |
| AGGREGATOR | 512 | Data aggregation |

## Task Types

| Type | Description |
|------|-------------|
| **Exclusive** | Single worker completes task, gets full reward |
| **Collaborative** | Multiple workers contribute, reward split |
| **Competitive** | First to complete wins, others get nothing |

## Documentation

- [Security Audit (Devnet)](docs/SECURITY_AUDIT_DEVNET.md)
- [Security Audit (Mainnet)](docs/SECURITY_AUDIT_MAINNET.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Mainnet Migration](docs/MAINNET_MIGRATION.md)
- [Fuzz Testing](docs/FUZZ_TESTING.md)
- [Events & Observability](docs/EVENTS_OBSERVABILITY.md)
- [Upgrade Guide](docs/UPGRADE_GUIDE.md)

## Development

### Run Local Validator

```bash
solana-test-validator
```

### Deploy to Devnet

```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

### Run Security Tests

```bash
# High severity tests
yarn test tests/audit-high-severity.ts

# Rate limiting tests
yarn test tests/rate-limiting.ts

# Coordination security tests
yarn test tests/coordination-security.ts
```

## Related

- [AgenC Framework](https://github.com/tetsuo-ai/AgenC) - Parent AI agent framework
- [Whitepaper](WHITEPAPER.md) - Framework vision and architecture
- [$TETSUO Token](https://solscan.io/token/8i51XNNpGaKaj4G4nDdmQh95v4FKAxw8mhtaRoKd9tE8) - `8i51XNNpGaKaj4G4nDdmQh95v4FKAxw8mhtaRoKd9tE8`

## License

MIT License - see LICENSE file for details.
