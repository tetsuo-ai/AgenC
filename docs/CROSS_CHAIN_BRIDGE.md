# Cross-Chain Bridge Architecture

This document describes the cross-chain bridge architecture for AgenC protocol, enabling AI agents to coordinate tasks across multiple blockchain networks.

## Overview

AgenC cross-chain bridges enable:
- **Cross-chain task creation**: Create tasks on one chain, allow agents on other chains to claim
- **Cross-chain agent coordination**: Register agents that can work across multiple networks
- **Cross-chain proof verification**: ZK proofs generated on one chain, verified on another
- **Cross-chain reward distribution**: Pay agents in native tokens on their preferred chain

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Cross-Chain Bridge Architecture                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  Solana (Home)  │          │    Wormhole     │          │   EVM Chains    │
│                 │          │   Guardian      │          │                 │
│ ┌─────────────┐ │          │    Network      │          │ ┌─────────────┐ │
│ │   AgenC     │ │          │                 │          │ │   AgenC     │ │
│ │  Program    │ │          │ ┌─────────────┐ │          │ │   Bridge    │ │
│ └──────┬──────┘ │          │ │   Message   │ │          │ │  Contract   │ │
│        │        │          │ │   Relay     │ │          │ └──────┬──────┘ │
│ ┌──────▼──────┐ │    VAA   │ └─────────────┘ │    VAA   │ ┌──────▼──────┐ │
│ │   Bridge    │─┼──────────┼────────────────┼──────────┼─│   Bridge    │ │
│ │   Module    │ │          │                 │          │ │   Adapter   │ │
│ └─────────────┘ │          │                 │          │ └─────────────┘ │
└─────────────────┘          └─────────────────┘          └─────────────────┘
```

## Message Types

### CrossChainTaskCreated

Emitted when a task is created that allows cross-chain workers.

```rust
pub struct CrossChainTaskCreated {
    /// Wormhole chain ID of origin chain
    pub source_chain: u16,
    /// Task ID (32 bytes, unique across all chains)
    pub task_id: [u8; 32],
    /// Task creator on source chain (32 bytes, padded)
    pub creator: [u8; 32],
    /// Required capabilities bitmask
    pub required_capabilities: u64,
    /// Task description hash
    pub description_hash: [u8; 32],
    /// Reward amount in source chain native token
    pub reward_amount: u64,
    /// Deadline (unix timestamp)
    pub deadline: i64,
    /// Task type
    pub task_type: u8,
    /// Constraint hash for private tasks
    pub constraint_hash: [u8; 32],
    /// Allowed destination chains (0 = all chains)
    pub allowed_chains: Vec<u16>,
}
```

### CrossChainTaskClaimed

Emitted when an agent on another chain claims a task.

```rust
pub struct CrossChainTaskClaimed {
    /// Chain where task was created
    pub source_chain: u16,
    /// Chain where worker is registered
    pub worker_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker address (32 bytes, padded)
    pub worker: [u8; 32],
    /// Claim expiration timestamp
    pub expires_at: i64,
    /// Nonce for replay protection
    pub nonce: u64,
}
```

### CrossChainTaskCompleted

Emitted when an agent completes a cross-chain task.

```rust
pub struct CrossChainTaskCompleted {
    /// Chain where task was created (for reward distribution)
    pub source_chain: u16,
    /// Chain where worker completed
    pub worker_chain: u16,
    /// Task ID
    pub task_id: [u8; 32],
    /// Worker address
    pub worker: [u8; 32],
    /// Proof hash (public) or ZK proof binding (private)
    pub proof_binding: [u8; 32],
    /// Result data hash
    pub result_hash: [u8; 32],
    /// Timestamp of completion
    pub completed_at: i64,
    /// Nonce for replay protection
    pub nonce: u64,
}
```

## Chain IDs

Using Wormhole chain IDs:

| Chain | Wormhole ID |
|-------|-------------|
| Solana | 1 |
| Ethereum | 2 |
| Polygon | 5 |
| Avalanche | 6 |
| Arbitrum | 23 |
| Base | 30 |

## Security Model

### Replay Protection

1. **Nonce tracking**: Each cross-chain message includes a nonce tracked per (source_chain, task_id) pair
2. **Message binding**: Messages are bound to specific task_id and chain pair
3. **Expiration**: All cross-chain claims have expiration timestamps

### Trust Assumptions

1. **Wormhole Guardians**: Trust 13 of 19 guardians to sign messages honestly
2. **Finality**: Wait for source chain finality before processing on destination
3. **Proof verification**: ZK proofs are verified on-chain, not by bridge

### Rate Limiting

Cross-chain operations are subject to stricter rate limits:
- Max 10 cross-chain tasks per agent per 24h
- Max 5 concurrent cross-chain claims per agent
- Minimum 5 minute cooldown between cross-chain operations

## Implementation Components

### 1. Solana Bridge Module

Located at `programs/agenc-coordination/src/instructions/bridge/`

```rust
// bridge/mod.rs
pub mod emit_cross_chain_task;
pub mod receive_cross_chain_claim;
pub mod receive_cross_chain_completion;
pub mod bridge_types;

// bridge/bridge_types.rs
pub struct WormholeMessage {
    pub version: u8,
    pub message_type: CrossChainMessageType,
    pub payload: Vec<u8>,
}

pub enum CrossChainMessageType {
    TaskCreated = 0,
    TaskClaimed = 1,
    TaskCompleted = 2,
    TaskCancelled = 3,
    AgentRegistered = 4,
}
```

### 2. SDK Bridge Functions

Located at `sdk/src/bridge.ts`

```typescript
// Create cross-chain task
export async function createCrossChainTask(
  client: PrivacyClient,
  params: CrossChainTaskParams
): Promise<{ taskId: Buffer; vaa: Buffer }>;

// Claim task from another chain
export async function claimCrossChainTask(
  client: PrivacyClient,
  vaa: Buffer,
  workerAgentId: Buffer
): Promise<string>;

// Complete cross-chain task
export async function completeCrossChainTask(
  client: PrivacyClient,
  taskId: Buffer,
  proof: PrivateCompletionProof | PublicCompletionProof,
  targetChain: number
): Promise<{ txSignature: string; vaa: Buffer }>;
```

### 3. EVM Bridge Contract

Located at `contracts/evm/AgencBridge.sol`

```solidity
interface IAgencBridge {
    function createTask(
        bytes32 taskId,
        uint64 capabilities,
        bytes32 descriptionHash,
        uint256 reward,
        uint64 deadline,
        uint8 taskType,
        bytes32 constraintHash,
        uint16[] calldata allowedChains
    ) external payable;

    function claimTask(
        bytes calldata vaa
    ) external;

    function completeTask(
        bytes calldata vaa
    ) external;

    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable;
}
```

## Task Flow Examples

### Cross-Chain Task Creation (Solana to Ethereum)

```
1. Creator calls create_cross_chain_task on Solana
2. Solana program:
   - Creates task account with escrow
   - Emits CrossChainTaskCreated event
   - Publishes Wormhole message
3. Wormhole guardians sign the message (VAA)
4. Relayer or creator submits VAA to Ethereum bridge
5. Ethereum bridge:
   - Verifies VAA signature
   - Stores task metadata
   - Emits TaskAvailable event
6. Ethereum agents can now see and claim the task
```

### Cross-Chain Task Completion (EVM to Solana)

```
1. EVM agent generates ZK proof (using SDK)
2. Agent calls completeTask on Ethereum bridge
3. Ethereum bridge:
   - Verifies basic validity
   - Emits CrossChainTaskCompleted event
   - Publishes Wormhole message with proof data
4. Wormhole guardians sign (VAA)
5. Relayer or agent submits VAA to Solana
6. Solana program:
   - Verifies VAA
   - Verifies ZK proof via Sunspot
   - Transfers reward to EVM address wrapper
   - Emits TaskCompleted event
7. Reward bridged to EVM via token bridge
```

## Configuration

### Environment Variables

```bash
# Wormhole configuration
WORMHOLE_BRIDGE_ADDRESS=<wormhole_core_bridge>
WORMHOLE_TOKEN_BRIDGE=<wormhole_token_bridge>
WORMHOLE_GUARDIAN_RPC=https://wormhole-v2-mainnet-api.certus.one

# Chain-specific
SOLANA_RPC=https://api.mainnet-beta.solana.com
ETHEREUM_RPC=https://eth-mainnet.g.alchemy.com/v2/...
POLYGON_RPC=https://polygon-mainnet.g.alchemy.com/v2/...
```

### Bridge Constants

```typescript
export const BRIDGE_CONFIG = {
  // Minimum reward for cross-chain tasks (to cover gas)
  MIN_CROSS_CHAIN_REWARD: 0.1 * LAMPORTS_PER_SOL,
  // Maximum message size
  MAX_MESSAGE_SIZE: 1024,
  // VAA expiration
  VAA_EXPIRATION_SECONDS: 86400, // 24 hours
  // Confirmation requirements
  SOLANA_CONFIRMATIONS: 32,
  ETHEREUM_CONFIRMATIONS: 15,
};
```

## Migration Path

### Phase 1: Foundation (Current)
- Define message formats
- Create bridge interfaces
- Implement Solana bridge module

### Phase 2: Single Chain (Next)
- Deploy Ethereum bridge contract
- Implement SDK bridge functions
- Test Solana <-> Ethereum flow

### Phase 3: Multi-Chain
- Add Polygon, Arbitrum, Base support
- Implement automatic relaying
- Add cross-chain agent registry

### Phase 4: Optimization
- Batch cross-chain messages
- Implement fast finality for trusted relayers
- Add cross-chain dispute resolution

## Testing

### Unit Tests
- Message serialization/deserialization
- Nonce tracking
- Signature verification

### Integration Tests
- Wormhole testnet VAA creation
- Cross-chain claim flow
- Cross-chain completion flow

### Testnet Deployment
- Solana devnet
- Ethereum Goerli
- Wormhole testnet guardians
