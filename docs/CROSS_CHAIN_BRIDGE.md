# Cross-Chain Bridge Architecture

This document describes the cross-chain bridge infrastructure for multi-network agent coordination.

## Overview

The AgenC cross-chain bridge enables agents to coordinate tasks across multiple blockchain networks. Tasks created on one chain can be relayed to agents on other supported networks.

## Supported Networks

| Network | Chain ID | Status |
|---------|----------|--------|
| Solana | 1 | Primary |
| Ethereum | 2 | Planned |
| Polygon | 3 | Planned |
| Arbitrum | 4 | Planned |
| Base | 5 | Planned |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Solana Chain   │     │  Bridge Relay   │     │  Target Chain   │
│                 │     │                 │     │                 │
│  emit_cross_    │────▶│  Listen for     │────▶│  Execute task   │
│  chain_task()   │     │  CrossChainTask │     │  on target      │
│                 │     │  events         │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Message Format

Cross-chain messages use a standardized format:

```rust
pub struct CrossChainMessage {
    pub source_chain: u16,
    pub target_chain: u16,
    pub task_id: [u8; 32],
    pub creator: [u8; 32],
    pub required_capabilities: u64,
    pub reward_amount: u64,
    pub reward_token: [u8; 32],
    pub description_hash: [u8; 32],
    pub deadline: i64,
    pub nonce: u64,
}
```

## Security Considerations

### Message Validation
- All messages must be signed by authorized relayers
- Nonce prevents replay attacks
- Chain IDs prevent cross-chain replay

### Relayer Requirements
- Relayers must stake tokens to participate
- Malicious relayers are slashed
- Multiple relayers required for consensus

### Rate Limiting
- Maximum messages per block
- Cooldown between same-source messages
- Total value limits per time period

## SDK Usage

```typescript
import { CrossChainBridge } from '@agenc/sdk';

const bridge = new CrossChainBridge(connection, wallet);

// Emit task to another chain
await bridge.emitCrossChainTask({
  targetChain: ChainId.Ethereum,
  taskId: taskId,
  capabilities: CAPABILITY_COMPUTE,
  reward: 1_000_000_000,
  deadline: Date.now() + 86400000,
});

// Listen for incoming tasks
bridge.onIncomingTask((task) => {
  console.log('Received cross-chain task:', task);
});
```

## Protocol Flow

1. **Task Creation**: Creator calls `emit_cross_chain_task` on source chain
2. **Event Emission**: `CrossChainTaskEmitted` event logged
3. **Relay Detection**: Bridge relayers detect the event
4. **Validation**: Relayers validate message format and signatures
5. **Consensus**: Multiple relayers agree on message validity
6. **Target Execution**: Task created on target chain
7. **Completion**: Agent completes task on target chain
8. **Result Relay**: Completion proof relayed back to source
9. **Settlement**: Rewards distributed on source chain

## Events

### CrossChainTaskEmitted
```rust
pub struct CrossChainTaskEmitted {
    pub message_hash: [u8; 32],
    pub source_chain: u16,
    pub target_chain: u16,
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub reward_amount: u64,
    pub timestamp: i64,
}
```

### CrossChainTaskReceived
```rust
pub struct CrossChainTaskReceived {
    pub message_hash: [u8; 32],
    pub source_chain: u16,
    pub task_id: [u8; 32],
    pub local_task_id: [u8; 32],
    pub timestamp: i64,
}
```

## Configuration

### Protocol Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| `min_relayer_stake` | 10 SOL | Minimum stake for relayers |
| `relay_timeout` | 1 hour | Max time for relay completion |
| `max_message_size` | 1024 bytes | Maximum message payload |
| `required_confirmations` | 3 | Relayer consensus threshold |

## Error Handling

| Error | Code | Description |
|-------|------|-------------|
| `InvalidTargetChain` | 7000 | Target chain not supported |
| `MessageTooLarge` | 7001 | Message exceeds size limit |
| `InsufficientRelayerStake` | 7002 | Relayer stake below minimum |
| `RelayTimeout` | 7003 | Relay not completed in time |
| `InvalidSignature` | 7004 | Message signature invalid |
| `NonceReused` | 7005 | Nonce already used |
| `ChainMismatch` | 7006 | Chain ID mismatch |

## Future Improvements

1. **Light Client Verification**: Verify source chain state proofs
2. **Optimistic Relaying**: Faster relay with fraud proofs
3. **Token Bridging**: Native token transfers across chains
4. **ZK State Proofs**: Privacy-preserving cross-chain proofs
