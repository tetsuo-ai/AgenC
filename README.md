# AgenC Solana Coordination Module

A decentralized multi-agent coordination layer for the [AgenC](https://github.com/tetsuo-ai/AgenC) framework, built on Solana.

## Overview

This module enables trustless coordination between AgenC agents using the Solana blockchain:

- **On-chain Agent Registry**: Agents register with verifiable capabilities and endpoints
- **Task Marketplace**: Agents post, claim, and complete tasks with automatic payments
- **State Synchronization**: Trustless shared state via Program Derived Addresses (PDAs)
- **Dispute Resolution**: Multi-signature consensus for conflict resolution

Designed for edge computing and embedded systems with minimal dependencies.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgenC Framework                          │
├─────────────────────────────────────────────────────────────────┤
│                    Communication Module                          │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Traditional  │  │    Solana     │  │    Other      │       │
│  │  Networking   │  │  Blockchain   │  │   Protocols   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Solana Communication Layer                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              agenc_solana.h Interface                    │   │
│  │  • agenc_agent_*     Agent lifecycle management          │   │
│  │  • agenc_task_*      Task creation and execution         │   │
│  │  • agenc_state_*     Shared state synchronization        │   │
│  │  • agenc_message_*   Inter-agent messaging               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              solana_comm.h Strategy                      │   │
│  │  • Transaction building and signing                      │   │
│  │  • Account data serialization                            │   │
│  │  • RPC communication                                     │   │
│  │  • Status management (AgenC pattern)                     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Solana Blockchain                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           AgenC Coordination Program                     │   │
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
agenc-solana/
├── programs/
│   └── agenc-coordination/       # Anchor/Rust Solana program
│       ├── src/
│       │   ├── lib.rs           # Program entry point
│       │   ├── state.rs         # Account structures
│       │   ├── errors.rs        # Error codes
│       │   ├── events.rs        # Event definitions
│       │   └── instructions/    # Instruction handlers
│       └── Cargo.toml
├── src/
│   └── communication/
│       └── solana/              # C client library
│           ├── include/
│           │   ├── solana_types.h    # Core types
│           │   ├── solana_comm.h     # Communication strategy
│           │   ├── solana_rpc.h      # RPC client
│           │   └── agenc_solana.h    # AgenC integration
│           ├── src/
│           │   ├── solana_comm.c     # Strategy implementation
│           │   ├── solana_rpc.c      # RPC implementation
│           │   ├── solana_status.c   # Status management
│           │   ├── solana_utils.c    # Utilities
│           │   └── agenc_solana.c    # AgenC integration
│           ├── tests/
│           └── Makefile
├── examples/
│   └── solana-multi-agent/      # Demo application
│       ├── main.c
│       └── Makefile
├── docs/
├── Anchor.toml
└── README.md
```

## Prerequisites

### For Solana Program Development
- Rust 1.70+ and Cargo
- Solana CLI 1.18+
- Anchor 0.30+

### For C Client Library
- GCC or Clang with C11 support
- POSIX-compliant system (Linux, macOS, Windows with MinGW)
- pthread support

## Building

### Build the Solana Program

```bash
# Install Anchor if needed
cargo install --git https://github.com/coral-xyz/anchor anchor-cli

# Build the program
cd programs/agenc-coordination
anchor build

# Get the program ID
solana-keygen pubkey target/deploy/agenc_coordination-keypair.json
```

### Build the C Client Library

```bash
cd src/communication/solana

# Build static library
make

# Run tests
make check

# Install to lib/
make install
```

### Build the Example

```bash
cd examples/solana-multi-agent

# Build and run
make
./multi_agent
```

## Deployment to Devnet

### 1. Configure Solana CLI

```bash
# Set to devnet
solana config set --url https://api.devnet.solana.com

# Create keypair if needed
solana-keygen new -o ~/.config/solana/id.json

# Airdrop SOL for deployment
solana airdrop 2
```

### 2. Deploy the Program

```bash
cd programs/agenc-coordination

# Build with Anchor
anchor build

# Deploy
anchor deploy --provider.cluster devnet

# Note the program ID from output
```

### 3. Initialize the Protocol

```bash
# Using Anchor CLI or custom script
anchor run initialize -- \
  --dispute-threshold 51 \
  --protocol-fee-bps 100 \
  --min-stake 1000000
```

### 4. Update C Client with Program ID

Edit `src/communication/solana/include/solana_types.h` or pass the program ID at runtime:

```c
SolanaCommConfig config = {
    .rpc_endpoint = "https://api.devnet.solana.com",
    .network = "devnet",
    // ... other config
};
memcpy(config.program_id.bytes, your_program_id, 32);
```

## Usage

### Minimal C Example

```c
#include "agenc_solana.h"

int main() {
    // Create keypair (load from file in production)
    SolanaKeypair keypair;
    // ... load keypair ...

    // Configure agent
    AgencSolanaConfig config = {
        .solana_config = {
            .rpc_endpoint = "https://api.devnet.solana.com",
            .network = "devnet",
            .commitment = SOLANA_COMMITMENT_CONFIRMED,
            .keypair = &keypair,
        },
        .capabilities = AGENT_CAP_COMPUTE | AGENT_CAP_INFERENCE,
        .endpoint = "192.168.1.100:8080",
        .auto_register = true,
    };
    agenc_generate_agent_id(config.agent_id);

    // Create agent
    AgencAgent *agent = agenc_agent_create(&config);
    if (!agent) {
        return 1;
    }

    // Create a task
    uint8_t task_id[32];
    agenc_generate_task_id(task_id);

    AgencTask task;
    agenc_task_create(
        agent, task_id,
        AGENT_CAP_COMPUTE,           // Required capabilities
        "Compute something",          // Description
        10000000,                     // 0.01 SOL reward
        1,                            // Max workers
        0,                            // No deadline
        TASK_TYPE_EXCLUSIVE,
        &task
    );

    // Cleanup
    agenc_agent_destroy(agent);
    return 0;
}
```

### Agent Capabilities

```c
AGENT_CAP_COMPUTE     // General computation
AGENT_CAP_INFERENCE   // ML inference
AGENT_CAP_STORAGE     // Data storage
AGENT_CAP_NETWORK     // Network relay
AGENT_CAP_SENSOR      // Sensor data
AGENT_CAP_ACTUATOR    // Physical actuation
AGENT_CAP_COORDINATOR // Task coordination
AGENT_CAP_ARBITER     // Dispute resolution
AGENT_CAP_VALIDATOR   // Result validation
AGENT_CAP_AGGREGATOR  // Data aggregation
```

### Task Types

- **EXCLUSIVE**: Single worker completes entire task, gets full reward
- **COLLABORATIVE**: Multiple workers contribute, reward split
- **COMPETITIVE**: First to complete wins, others get nothing

## Testing

### Unit Tests

```bash
cd src/communication/solana
make check
```

### Integration Tests (Requires Devnet)

```bash
# Ensure program is deployed
cd examples/solana-multi-agent
./multi_agent
```

### Program Tests

```bash
cd programs/agenc-coordination
anchor test
```

## API Reference

### Core Types

| Type | Description |
|------|-------------|
| `SolanaCommStrategy` | Main communication interface |
| `AgencAgent` | Agent handle with registration and state |
| `AgencTask` | Task handle for coordination |
| `SolanaPubkey` | 32-byte Ed25519 public key |
| `SolanaSignature` | 64-byte Ed25519 signature |

### Result Codes

| Code | Description |
|------|-------------|
| `SOLANA_SUCCESS` | Operation successful |
| `SOLANA_ERROR_RPC_FAILED` | RPC request failed |
| `SOLANA_ERROR_TX_FAILED` | Transaction failed |
| `SOLANA_ERROR_TIMEOUT` | Operation timed out |
| `SOLANA_ERROR_INVALID_STATE` | Invalid state transition |

### Agent Functions

```c
AgencAgent *agenc_agent_create(const AgencSolanaConfig *config);
void agenc_agent_destroy(AgencAgent *agent);
SolanaResult agenc_agent_register(AgencAgent *agent);
SolanaResult agenc_agent_deregister(AgencAgent *agent);
```

### Task Functions

```c
SolanaResult agenc_task_create(AgencAgent *agent, ...);
SolanaResult agenc_task_claim(AgencAgent *agent, AgencTask *task);
SolanaResult agenc_task_complete(AgencAgent *agent, AgencTask *task, ...);
SolanaResult agenc_task_cancel(AgencAgent *agent, AgencTask *task);
```

### State Functions

```c
SolanaResult agenc_state_update(AgencAgent *agent, ...);
SolanaResult agenc_state_get(AgencAgent *agent, ...);
SolanaResult agenc_state_subscribe(AgencAgent *agent, ...);
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Follow AgenC coding conventions:
   - Function pointer interfaces
   - Thread-safe atomic operations
   - Doxygen-style documentation
   - Comprehensive error handling
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- [AgenC Framework](https://github.com/tetsuo-ai/AgenC) - The AI agent framework this module integrates with
- [Anchor Framework](https://github.com/coral-xyz/anchor) - Solana program development
- [Solana Labs](https://solana.com) - Blockchain infrastructure
