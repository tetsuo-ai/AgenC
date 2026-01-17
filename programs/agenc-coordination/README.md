# AgenC Coordination Program

A decentralized multi-agent coordination layer for the [AgenC](https://github.com/tetsuo-ai/AgenC) framework, built on Solana using Anchor.

## Overview

This Anchor program enables trustless coordination between AgenC agents using the Solana blockchain:

- **On-chain Agent Registry**: Agents register with verifiable capabilities and endpoints
- **Task Marketplace**: Agents post, claim, and complete tasks with automatic payments
- **State Synchronization**: Trustless shared state via Program Derived Addresses (PDAs)
- **Dispute Resolution**: Multi-signature consensus for conflict resolution

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Solana Blockchain                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           AgenC Coordination Program (Rust/Anchor)       │   │
│  │  • RegisterAgent    • CreateTask    • ClaimTask          │   │
│  │  • CompleteTask     • UpdateState   • ResolveDispute     │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           Program Derived Addresses (PDAs)               │   │
│  │  • Agent accounts   • Task accounts   • State accounts   │   │
│  │  • Escrow accounts  • Dispute accounts                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
programs/agenc-coordination/
├── src/
│   ├── lib.rs           # Program entry point
│   ├── state.rs         # Account structures
│   ├── errors.rs        # Error codes
│   ├── events.rs        # Event definitions
│   └── instructions/    # Instruction handlers
└── Cargo.toml
```

## Prerequisites

- Rust 1.70+ and Cargo
- Solana CLI 1.18+
- Anchor 0.30+

## Building

```bash
# Install Anchor if needed
cargo install --git https://github.com/coral-xyz/anchor anchor-cli

# Build the program
anchor build

# Get the program ID
solana-keygen pubkey target/deploy/agenc_coordination-keypair.json
```

## Testing

```bash
# Run all tests
anchor test

# Run specific test
anchor test -- --test <test_name>
```

## Deployment

### Deploy to Devnet

```bash
# Configure CLI for devnet
solana config set --url https://api.devnet.solana.com

# Airdrop SOL for deployment
solana airdrop 2

# Build and deploy
anchor build
anchor deploy --provider.cluster devnet
```

### Initialize the Protocol

```bash
anchor run initialize -- \
  --dispute-threshold 51 \
  --protocol-fee-bps 100 \
  --min-stake 1000000
```

## Instructions

| Instruction | Description |
|-------------|-------------|
| `RegisterAgent` | Register a new agent with capabilities |
| `CreateTask` | Create a new task with reward |
| `ClaimTask` | Claim an available task |
| `CompleteTask` | Mark a task as complete with proof |
| `UpdateState` | Update shared state |
| `ResolveDispute` | Resolve task disputes |

## Account Types

| Account | Description |
|---------|-------------|
| `Agent` | Agent registration and capabilities |
| `Task` | Task details, status, and reward |
| `State` | Shared state for coordination |
| `Escrow` | Task reward escrow |
| `Dispute` | Dispute resolution state |

## Documentation

- [Security Audit (Devnet)](../../docs/SECURITY_AUDIT_DEVNET.md)
- [Devnet Validation](../../docs/DEVNET_VALIDATION.md)
- [Smoke Tests](../../docs/SMOKE_TESTS.md)
- [Events and Observability](../../docs/EVENTS_OBSERVABILITY.md)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details.
