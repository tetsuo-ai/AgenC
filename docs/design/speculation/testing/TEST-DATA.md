# AgenC Speculative Execution - Test Data Reference

> **Version:** 1.0.0  
> **Last Updated:** 2025-01-28  
> **Companion to:** [TEST-PLAN.md](./TEST-PLAN.md)

---

## Table of Contents

1. [Sample Task Chains](#1-sample-task-chains)
2. [Mock Configurations](#2-mock-configurations)
3. [Expected Outputs](#3-expected-outputs)
4. [Test Fixtures](#4-test-fixtures)
5. [Data Generators](#5-data-generators)
6. [Error Scenarios](#6-error-scenarios)

---

## 1. Sample Task Chains

### 1.1 Linear Chain Fixtures

#### CHAIN-LINEAR-001: Basic 3-Task Chain

```json
{
  "chainId": "chain-linear-001",
  "description": "Simple A → B → C linear chain",
  "topology": "linear",
  "tasks": [
    {
      "taskId": "task-A-001",
      "description": "Compute initial hash",
      "dependencies": [],
      "constraintHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "reward": 1000000000,
      "estimatedDuration": 800,
      "agent": null
    },
    {
      "taskId": "task-B-001",
      "description": "Transform data",
      "dependencies": ["task-A-001"],
      "constraintHash": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      "reward": 1500000000,
      "estimatedDuration": 600,
      "agent": null
    },
    {
      "taskId": "task-C-001",
      "description": "Final aggregation",
      "dependencies": ["task-B-001"],
      "constraintHash": "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba",
      "reward": 2000000000,
      "estimatedDuration": 500,
      "agent": null
    }
  ],
  "totalReward": 4500000000,
  "expectedDuration": {
    "sequential": 1900,
    "speculative": 900
  }
}
```

#### CHAIN-LINEAR-002: Extended 5-Task Chain

```json
{
  "chainId": "chain-linear-002",
  "description": "Extended 5-task linear chain for latency testing",
  "topology": "linear",
  "tasks": [
    {
      "taskId": "task-L5-A",
      "description": "Data ingestion",
      "dependencies": [],
      "constraintHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
      "reward": 500000000,
      "estimatedDuration": 500
    },
    {
      "taskId": "task-L5-B",
      "description": "Preprocessing",
      "dependencies": ["task-L5-A"],
      "constraintHash": "0x2222222222222222222222222222222222222222222222222222222222222222",
      "reward": 600000000,
      "estimatedDuration": 600
    },
    {
      "taskId": "task-L5-C",
      "description": "Feature extraction",
      "dependencies": ["task-L5-B"],
      "constraintHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
      "reward": 800000000,
      "estimatedDuration": 800
    },
    {
      "taskId": "task-L5-D",
      "description": "Model inference",
      "dependencies": ["task-L5-C"],
      "constraintHash": "0x4444444444444444444444444444444444444444444444444444444444444444",
      "reward": 1200000000,
      "estimatedDuration": 1200
    },
    {
      "taskId": "task-L5-E",
      "description": "Result aggregation",
      "dependencies": ["task-L5-D"],
      "constraintHash": "0x5555555555555555555555555555555555555555555555555555555555555555",
      "reward": 400000000,
      "estimatedDuration": 400
    }
  ],
  "totalReward": 3500000000,
  "expectedDuration": {
    "sequential": 3500,
    "speculative": 1400
  }
}
```

### 1.2 Diamond Pattern Fixtures

#### CHAIN-DIAMOND-001: Basic Diamond

```json
{
  "chainId": "chain-diamond-001",
  "description": "Diamond pattern: A → (B, C) → D",
  "topology": "diamond",
  "tasks": [
    {
      "taskId": "task-D-A",
      "description": "Initial computation",
      "dependencies": [],
      "constraintHash": "0xaaaa000000000000000000000000000000000000000000000000000000000000",
      "reward": 1000000000,
      "estimatedDuration": 500
    },
    {
      "taskId": "task-D-B",
      "description": "Branch B processing",
      "dependencies": ["task-D-A"],
      "constraintHash": "0xbbbb000000000000000000000000000000000000000000000000000000000000",
      "reward": 800000000,
      "estimatedDuration": 600
    },
    {
      "taskId": "task-D-C",
      "description": "Branch C processing",
      "dependencies": ["task-D-A"],
      "constraintHash": "0xcccc000000000000000000000000000000000000000000000000000000000000",
      "reward": 700000000,
      "estimatedDuration": 400
    },
    {
      "taskId": "task-D-D",
      "description": "Merge and finalize",
      "dependencies": ["task-D-B", "task-D-C"],
      "constraintHash": "0xdddd000000000000000000000000000000000000000000000000000000000000",
      "reward": 1500000000,
      "estimatedDuration": 300
    }
  ],
  "totalReward": 4000000000,
  "expectedDuration": {
    "sequential": 1800,
    "speculative": 1100
  },
  "criticalPath": ["task-D-A", "task-D-B", "task-D-D"]
}
```

#### CHAIN-DIAMOND-002: Multi-Agent Diamond

```json
{
  "chainId": "chain-diamond-002",
  "description": "Diamond with different agents per branch",
  "topology": "diamond",
  "tasks": [
    {
      "taskId": "task-MAD-A",
      "description": "Shared initial task",
      "dependencies": [],
      "constraintHash": "0xa000000000000000000000000000000000000000000000000000000000000001",
      "reward": 1000000000,
      "estimatedDuration": 500,
      "preferredAgent": "agent-alpha"
    },
    {
      "taskId": "task-MAD-B",
      "description": "Agent Beta's task",
      "dependencies": ["task-MAD-A"],
      "constraintHash": "0xb000000000000000000000000000000000000000000000000000000000000001",
      "reward": 1200000000,
      "estimatedDuration": 700,
      "preferredAgent": "agent-beta"
    },
    {
      "taskId": "task-MAD-C",
      "description": "Agent Gamma's task",
      "dependencies": ["task-MAD-A"],
      "constraintHash": "0xc000000000000000000000000000000000000000000000000000000000000001",
      "reward": 1100000000,
      "estimatedDuration": 800,
      "preferredAgent": "agent-gamma"
    },
    {
      "taskId": "task-MAD-D",
      "description": "Agent Alpha finalizes",
      "dependencies": ["task-MAD-B", "task-MAD-C"],
      "constraintHash": "0xd000000000000000000000000000000000000000000000000000000000000001",
      "reward": 1500000000,
      "estimatedDuration": 400,
      "preferredAgent": "agent-alpha"
    }
  ],
  "agents": [
    {
      "agentId": "agent-alpha",
      "pubkey": "11111111111111111111111111111111",
      "stake": 5000000000,
      "capabilities": ["COMPUTE", "INFERENCE"]
    },
    {
      "agentId": "agent-beta",
      "pubkey": "22222222222222222222222222222222",
      "stake": 3000000000,
      "capabilities": ["COMPUTE"]
    },
    {
      "agentId": "agent-gamma",
      "pubkey": "33333333333333333333333333333333",
      "stake": 3500000000,
      "capabilities": ["COMPUTE", "STORAGE"]
    }
  ]
}
```

### 1.3 Complex DAG Fixtures

#### CHAIN-DAG-001: 10-Node Complex DAG

```json
{
  "chainId": "chain-dag-001",
  "description": "Complex DAG with multiple paths and join points",
  "topology": "dag",
  "tasks": [
    {
      "taskId": "dag-01",
      "description": "Root node",
      "dependencies": [],
      "constraintHash": "0x0100000000000000000000000000000000000000000000000000000000000000",
      "reward": 500000000,
      "estimatedDuration": 300
    },
    {
      "taskId": "dag-02",
      "description": "Branch A level 1",
      "dependencies": ["dag-01"],
      "constraintHash": "0x0200000000000000000000000000000000000000000000000000000000000000",
      "reward": 400000000,
      "estimatedDuration": 400
    },
    {
      "taskId": "dag-03",
      "description": "Branch B level 1",
      "dependencies": ["dag-01"],
      "constraintHash": "0x0300000000000000000000000000000000000000000000000000000000000000",
      "reward": 450000000,
      "estimatedDuration": 350
    },
    {
      "taskId": "dag-04",
      "description": "Branch C level 1",
      "dependencies": ["dag-01"],
      "constraintHash": "0x0400000000000000000000000000000000000000000000000000000000000000",
      "reward": 380000000,
      "estimatedDuration": 420
    },
    {
      "taskId": "dag-05",
      "description": "Join A+B level 2",
      "dependencies": ["dag-02", "dag-03"],
      "constraintHash": "0x0500000000000000000000000000000000000000000000000000000000000000",
      "reward": 600000000,
      "estimatedDuration": 500
    },
    {
      "taskId": "dag-06",
      "description": "Branch A level 2",
      "dependencies": ["dag-02"],
      "constraintHash": "0x0600000000000000000000000000000000000000000000000000000000000000",
      "reward": 350000000,
      "estimatedDuration": 280
    },
    {
      "taskId": "dag-07",
      "description": "Join B+C level 2",
      "dependencies": ["dag-03", "dag-04"],
      "constraintHash": "0x0700000000000000000000000000000000000000000000000000000000000000",
      "reward": 550000000,
      "estimatedDuration": 450
    },
    {
      "taskId": "dag-08",
      "description": "Level 3 from 05+06",
      "dependencies": ["dag-05", "dag-06"],
      "constraintHash": "0x0800000000000000000000000000000000000000000000000000000000000000",
      "reward": 700000000,
      "estimatedDuration": 600
    },
    {
      "taskId": "dag-09",
      "description": "Level 3 from 07",
      "dependencies": ["dag-07"],
      "constraintHash": "0x0900000000000000000000000000000000000000000000000000000000000000",
      "reward": 480000000,
      "estimatedDuration": 380
    },
    {
      "taskId": "dag-10",
      "description": "Final aggregation",
      "dependencies": ["dag-08", "dag-09"],
      "constraintHash": "0x1000000000000000000000000000000000000000000000000000000000000000",
      "reward": 1000000000,
      "estimatedDuration": 400
    }
  ],
  "totalReward": 5410000000,
  "expectedDuration": {
    "sequential": 4080,
    "speculative": 1800
  },
  "criticalPath": ["dag-01", "dag-02", "dag-05", "dag-08", "dag-10"],
  "maxParallelism": 3
}
```

#### CHAIN-DAG-002: Visualization

```
DAG Structure for chain-dag-001:

              ┌─────┐
              │dag-01│  (Root)
              └──┬──┘
         ┌──────┼──────┐
         ▼      ▼      ▼
     ┌─────┐┌─────┐┌─────┐
     │dag-02││dag-03││dag-04│  (Level 1)
     └──┬─┬┘└──┬─┬┘└──┬──┘
        │ │    │ │    │
        │ └────┤ ├────┘
        │      │ │
        ▼      ▼ ▼
     ┌─────┐┌─────┐
     │dag-06││dag-05│dag-07│  (Level 2)
     └──┬──┘└──┬──┘└──┬──┘
        │      │      │
        └──────┤      │
               ▼      ▼
           ┌─────┐┌─────┐
           │dag-08││dag-09│  (Level 3)
           └──┬──┘└──┬──┘
              └──────┤
                     ▼
                 ┌─────┐
                 │dag-10│  (Final)
                 └─────┘

Critical Path: dag-01 → dag-02 → dag-05 → dag-08 → dag-10
Total length: 300 + 400 + 500 + 600 + 400 = 2200ms
```

---

## 2. Mock Configurations

### 2.1 Proof Deferral Manager Configuration

```typescript
// Mock configuration for ProofDeferralManager
export const MOCK_PDM_CONFIG = {
  // Timing
  CLAIM_TTL_MS: 1800000,           // 30 minutes
  VERIFICATION_TTL_MS: 300000,     // 5 minutes
  EXPIRY_GRACE_PERIOD_MS: 30000,   // 30 seconds
  
  // Stake requirements
  MIN_STAKE_LAMPORTS: 100000000,   // 0.1 SOL
  MAX_STAKE_LAMPORTS: 10000000000, // 10 SOL
  STAKE_MULTIPLIER_PER_DEPTH: 1.5,
  
  // Slashing rates (basis points, 10000 = 100%)
  TIMEOUT_SLASH_RATE_BPS: 1000,    // 10%
  PROOF_FAILURE_SLASH_RATE_BPS: 2500, // 25%
  FRAUD_SLASH_RATE_BPS: 10000,     // 100%
  
  // Rate limits
  MAX_CLAIMS_PER_AGENT: 10,
  MAX_CONCURRENT_VERIFICATIONS: 50,
  
  // Feature flags
  ENABLE_GRACE_PERIOD_EXTENSION: true,
  ENABLE_BATCH_PROOF_SUBMISSION: true,
  ENABLE_PRIORITY_QUEUE: true
};

// Test environment overrides
export const TEST_PDM_CONFIG = {
  ...MOCK_PDM_CONFIG,
  CLAIM_TTL_MS: 60000,            // 1 minute for faster tests
  VERIFICATION_TTL_MS: 30000,     // 30 seconds
  EXPIRY_GRACE_PERIOD_MS: 5000,   // 5 seconds
};
```

### 2.2 Commitment Ledger Configuration

```typescript
export const MOCK_CL_CONFIG = {
  // Size limits
  MAX_COMMITMENT_SIZE_BYTES: 1024,
  MAX_COMMITMENTS_PER_TASK: 100,
  MAX_COMMITMENTS_PER_AGENT: 1000,
  
  // Merkle tree config
  MERKLE_TREE_DEPTH: 20,
  MERKLE_BATCH_SIZE: 100,
  
  // Retention
  COMMITMENT_RETENTION_DAYS: 30,
  COMPACTION_THRESHOLD_ENTRIES: 100000,
  
  // Verification
  REQUIRE_SIGNATURE_VERIFICATION: true,
  REQUIRE_NONCE_VALIDATION: true,
  
  // Hash algorithm
  HASH_ALGORITHM: 'sha256',
  
  // Test mode settings
  TEST_MODE: {
    SKIP_SIGNATURE_VERIFICATION: false,
    MOCK_MERKLE_PROOFS: false,
    FAST_COMPACTION: true
  }
};
```

### 2.3 Rollback Controller Configuration

```typescript
export const MOCK_RC_CONFIG = {
  // Limits
  MAX_ROLLBACK_DEPTH: 50,
  MAX_ROLLBACK_WIDTH: 100,
  MAX_CONCURRENT_ROLLBACKS: 5,
  
  // Timeouts
  ROLLBACK_TIMEOUT_MS: 60000,      // 1 minute
  NOTIFICATION_TIMEOUT_MS: 10000,  // 10 seconds
  
  // Compensation
  COMPENSATION_POOL_PERCENTAGE: 80, // 80% of slashed stake
  PROTOCOL_FEE_PERCENTAGE: 20,      // 20% to treasury
  
  // Features
  ENABLE_DRY_RUN: true,
  ENABLE_ROLLBACK_UNDO: false,     // Experimental
  REQUIRE_APPROVAL_FOR_CASCADE: false,
  
  // Events
  EMIT_DETAILED_EVENTS: true,
  LOG_LEVEL: 'debug'
};
```

### 2.4 Speculative Scheduler Configuration

```typescript
export const MOCK_STS_CONFIG = {
  // Queue settings
  MAX_QUEUE_SIZE: 10000,
  PRIORITY_LEVELS: 5,
  
  // Speculation limits
  MAX_SPECULATIVE_CHAIN_LENGTH: 10,
  MAX_SPECULATIVE_CHAINS_PER_AGENT: 5,
  MAX_TOTAL_SPECULATIVE_STAKE: 100000000000, // 100 SOL
  
  // Scheduling
  SCHEDULING_INTERVAL_MS: 100,
  BATCH_SIZE: 10,
  
  // Retry policy
  MAX_RETRIES: 3,
  RETRY_BACKOFF_BASE_MS: 1000,
  RETRY_BACKOFF_MULTIPLIER: 2,
  
  // Timeouts
  TASK_TIMEOUT_MS: 300000,         // 5 minutes
  SCHEDULING_TIMEOUT_MS: 5000,
  
  // Resource limits
  MAX_MEMORY_MB: 512,
  MAX_CPU_PERCENT: 80,
  
  // Load balancing
  ENABLE_AGENT_AFFINITY: true,
  LOAD_BALANCE_STRATEGY: 'round-robin' // or 'least-loaded', 'weighted'
};
```

### 2.5 Mock Agent Configurations

```typescript
export const MOCK_AGENTS = [
  {
    agentId: 'agent-001',
    pubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
    secretKey: 'mock-secret-key-agent-001',
    stake: 5000000000,              // 5 SOL
    capabilities: 0b00001111,       // COMPUTE | INFERENCE | STORAGE | NETWORK
    endpoint: 'https://agent-001.test.agenc.io',
    status: 'Active',
    reputation: 950,
    config: {
      maxConcurrentTasks: 5,
      preferredTaskTypes: ['compute', 'inference'],
      speculationEnabled: true,
      maxSpeculativeDepth: 5
    }
  },
  {
    agentId: 'agent-002',
    pubkey: '5aYNuBiHwVgSPqNyZbHTqMxYcVSvfqQkHHQEwWWWWWWW',
    secretKey: 'mock-secret-key-agent-002',
    stake: 3000000000,              // 3 SOL
    capabilities: 0b00000011,       // COMPUTE | INFERENCE
    endpoint: 'https://agent-002.test.agenc.io',
    status: 'Active',
    reputation: 875,
    config: {
      maxConcurrentTasks: 3,
      preferredTaskTypes: ['compute'],
      speculationEnabled: true,
      maxSpeculativeDepth: 3
    }
  },
  {
    agentId: 'agent-003-offline',
    pubkey: '6bZOvCjIxWhTPrOzacIUsMzYdWTwgrRlIIRFxXXXXXXX',
    secretKey: 'mock-secret-key-agent-003',
    stake: 2000000000,              // 2 SOL
    capabilities: 0b00000001,       // COMPUTE only
    endpoint: 'https://agent-003.test.agenc.io',
    status: 'Offline',
    reputation: 720,
    config: {
      maxConcurrentTasks: 2,
      preferredTaskTypes: ['compute'],
      speculationEnabled: false,
      maxSpeculativeDepth: 0
    }
  },
  {
    agentId: 'agent-004-malicious',
    pubkey: '7cAPwDkJyXiUQsPatdJVtNaZeUXxhsSmlJJGxYYYYYYY',
    secretKey: 'mock-secret-key-agent-004',
    stake: 1000000000,              // 1 SOL
    capabilities: 0b00000111,       // COMPUTE | INFERENCE | STORAGE
    endpoint: 'https://agent-004.test.agenc.io',
    status: 'Active',
    reputation: 500,
    config: {
      maxConcurrentTasks: 5,
      preferredTaskTypes: ['compute'],
      speculationEnabled: true,
      maxSpeculativeDepth: 10,
      // Malicious behavior flags (for testing)
      __test_submit_invalid_proofs: true,
      __test_abandon_claims: false
    }
  }
];
```

### 2.6 Mock ZK Proof Configuration

```typescript
export const MOCK_ZK_CONFIG = {
  // Circuit info
  circuit: {
    name: 'task_completion',
    version: '1.0.0',
    verificationKey: 'mock-verification-key-base64...',
    provingKey: 'mock-proving-key-base64...'
  },
  
  // Proof generation
  proofGeneration: {
    // Simulated timing
    averageDurationMs: 800,
    standardDeviationMs: 200,
    
    // Failure simulation
    failureRate: 0.0,              // 0% default, adjust for chaos tests
    corruptionRate: 0.0,
    
    // Resource usage
    memoryMb: 256,
    cpuPercent: 50
  },
  
  // Verification
  verification: {
    averageDurationMs: 200,
    standardDeviationMs: 50,
    
    // On-chain verification
    computeUnits: 200000,
    accountSize: 256
  },
  
  // Mock proof templates
  templates: {
    valid: {
      pi_a: ['0x1234...', '0x5678...', '0x1'],
      pi_b: [['0xabcd...', '0xefgh...'], ['0xijkl...', '0xmnop...'], ['0x1', '0x0']],
      pi_c: ['0xqrst...', '0xuvwx...', '0x1'],
      protocol: 'groth16',
      curve: 'bn254'
    },
    invalid: {
      pi_a: ['0x0000...', '0x0000...', '0x1'],
      pi_b: [['0x0000...', '0x0000...'], ['0x0000...', '0x0000...'], ['0x1', '0x0']],
      pi_c: ['0x0000...', '0x0000...', '0x1'],
      protocol: 'groth16',
      curve: 'bn254'
    }
  }
};
```

---

## 3. Expected Outputs

### 3.1 Unit Test Expected Outputs

#### DependencyGraph Outputs

```typescript
// DG-007: Topological sort - linear chain
const input = {
  tasks: ['A', 'B', 'C'],
  edges: [['A', 'B'], ['B', 'C']]
};
const expectedOutput = ['A', 'B', 'C'];

// DG-008: Topological sort - diamond
const input = {
  tasks: ['A', 'B', 'C', 'D'],
  edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]
};
const validOutputs = [
  ['A', 'B', 'C', 'D'],
  ['A', 'C', 'B', 'D']
];

// DG-005: Cycle detection
const input = {
  tasks: ['A', 'B'],
  edges: [['A', 'B'], ['B', 'A']]
};
const expectedError = {
  code: 'CYCLE_DETECTED',
  message: 'Cycle detected: A → B → A',
  cycle: ['A', 'B', 'A']
};
```

#### ProofDeferralManager Outputs

```typescript
// PDM-001: Create deferred claim
const input = {
  taskId: 'task-123',
  commitment: {
    hash: '0xabc...',
    signature: '0xdef...',
    timestamp: 1706457600000
  },
  stake: 1000000000
};

const expectedOutput = {
  claimId: 'claim-uuid-generated',
  status: 'PENDING',
  taskId: 'task-123',
  agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
  commitment: input.commitment,
  stakeLocked: 1000000000,
  createdAt: 1706457600000,
  expiresAt: 1706459400000,  // +30 min
  proofSubmittedAt: null,
  verifiedAt: null
};

// PDM-006: Reject invalid proof
const input = {
  claimId: 'claim-456',
  proof: { /* invalid proof data */ }
};

const expectedOutput = {
  claimId: 'claim-456',
  status: 'REJECTED',
  rejectionReason: 'PROOF_VERIFICATION_FAILED',
  stakeSlashed: 250000000,  // 25% of 1 SOL
  stakeReturned: 750000000,
  slashDistribution: {
    protocolTreasury: 50000000,   // 20% of slashed
    affectedAgents: 200000000     // 80% of slashed
  }
};
```

#### CommitmentLedger Outputs

```typescript
// CL-001: Record new commitment
const input = {
  taskId: 'task-789',
  commitment: {
    outputHash: '0x111...',
    salt: '0x222...'
  },
  agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV'
};

const expectedOutput = {
  commitmentId: 'commit-uuid-generated',
  taskId: 'task-789',
  agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
  commitmentHash: '0x333...',  // SHA-256(outputHash || salt)
  merkleIndex: 42,
  merkleRoot: '0x444...',
  status: 'PENDING',
  recordedAt: 1706457600000,
  blockSlot: 123456789,
  signature: '0x555...'
};

// CL-012: Merkle proof generation
const expectedMerkleProof = {
  commitmentId: 'commit-uuid',
  leaf: '0x333...',
  index: 42,
  root: '0x444...',
  siblings: [
    '0x666...',
    '0x777...',
    '0x888...',
    // ... up to depth 20
  ],
  verified: true
};
```

#### RollbackController Outputs

```typescript
// RC-002: Cascade rollback - linear chain
const input = {
  failedTaskId: 'task-A',
  reason: 'PROOF_VERIFICATION_FAILED',
  chain: ['task-A', 'task-B', 'task-C']
};

const expectedOutput = {
  rollbackId: 'rollback-uuid',
  initiatingTask: 'task-A',
  reason: 'PROOF_VERIFICATION_FAILED',
  tasksRolledBack: ['task-A', 'task-B', 'task-C'],
  stakeActions: [
    {
      taskId: 'task-A',
      agentPubkey: 'agent-1',
      action: 'SLASH',
      amount: 250000000,
      destination: 'protocol_treasury'
    },
    {
      taskId: 'task-B',
      agentPubkey: 'agent-2',
      action: 'COMPENSATE',
      amount: 100000000,
      source: 'slashed_stake'
    },
    {
      taskId: 'task-C',
      agentPubkey: 'agent-3',
      action: 'COMPENSATE',
      amount: 100000000,
      source: 'slashed_stake'
    }
  ],
  events: [
    { type: 'RollbackInitiated', taskId: 'task-A', timestamp: 1706457600000 },
    { type: 'TaskRolledBack', taskId: 'task-B', timestamp: 1706457600100 },
    { type: 'TaskRolledBack', taskId: 'task-C', timestamp: 1706457600200 },
    { type: 'StakeSlashed', taskId: 'task-A', amount: 250000000, timestamp: 1706457600300 },
    { type: 'CompensationDistributed', recipients: 2, total: 200000000, timestamp: 1706457600400 },
    { type: 'RollbackComplete', rollbackId: 'rollback-uuid', timestamp: 1706457600500 }
  ],
  completedAt: 1706457600500,
  duration: 500
};
```

### 3.2 Integration Test Expected Outputs

#### INTG-HP-001: Linear Chain Speculative Execution

```typescript
const expectedTimeline = {
  events: [
    { time: 0, event: 'TaskSubmitted', taskId: 'A' },
    { time: 10, event: 'TaskStarted', taskId: 'A' },
    { time: 100, event: 'CommitmentRecorded', taskId: 'A' },
    { time: 110, event: 'TaskStarted', taskId: 'B', speculative: true },
    { time: 200, event: 'CommitmentRecorded', taskId: 'B' },
    { time: 210, event: 'TaskStarted', taskId: 'C', speculative: true },
    { time: 300, event: 'CommitmentRecorded', taskId: 'C' },
    { time: 850, event: 'ProofSubmitted', taskId: 'A' },
    { time: 900, event: 'ProofVerified', taskId: 'A' },
    { time: 950, event: 'ProofSubmitted', taskId: 'B' },
    { time: 1000, event: 'ProofVerified', taskId: 'B' },
    { time: 1050, event: 'ProofSubmitted', taskId: 'C' },
    { time: 1100, event: 'ProofVerified', taskId: 'C' },
    { time: 1110, event: 'ChainCompleted', chainId: 'chain-001' }
  ],
  metrics: {
    totalDuration: 1110,
    sequentialBaseline: 2700,
    improvement: '58.9%',
    speculativeOverhead: 30,
    proofGenerationTime: 750,
    verificationTime: 150
  },
  finalState: {
    tasks: {
      'A': { status: 'COMPLETED', proofVerified: true },
      'B': { status: 'COMPLETED', proofVerified: true },
      'C': { status: 'COMPLETED', proofVerified: true }
    },
    stakes: {
      'A': { locked: 0, returned: 1000000000, slashed: 0 },
      'B': { locked: 0, returned: 1000000000, slashed: 0 },
      'C': { locked: 0, returned: 1000000000, slashed: 0 }
    },
    commitments: {
      'A': { status: 'FULFILLED' },
      'B': { status: 'FULFILLED' },
      'C': { status: 'FULFILLED' }
    }
  }
};
```

#### INTG-FAIL-001: Proof Generation Fails Mid-Chain

```typescript
const expectedFailureOutput = {
  chainId: 'chain-fail-001',
  failurePoint: {
    taskId: 'B',
    reason: 'PROOF_GENERATION_TIMEOUT',
    timestamp: 1706458800000
  },
  rollbackCascade: {
    initiated: 1706458800100,
    completed: 1706458800600,
    tasksAffected: ['B', 'C', 'D'],
    taskUnaffected: ['A']  // A's proof was already verified
  },
  stakeOutcomes: {
    'A': { action: 'NONE', finalBalance: 'unchanged' },
    'B': { action: 'SLASHED', amount: 100000000, reason: 'timeout' },
    'C': { action: 'COMPENSATED', amount: 40000000 },
    'D': { action: 'COMPENSATED', amount: 40000000 }
  },
  retryEligibility: {
    'B': { canRetry: true, cooldownMs: 60000 },
    'C': { canRetry: true, requiresNewCommitment: true },
    'D': { canRetry: true, requiresNewCommitment: true }
  },
  auditTrail: [
    { event: 'ProofTimeout', taskId: 'B', details: { elapsed: 1800000 } },
    { event: 'SlashInitiated', taskId: 'B', amount: 100000000 },
    { event: 'RollbackCascade', tasks: ['C', 'D'] },
    { event: 'CompensationPaid', recipient: 'C', amount: 40000000 },
    { event: 'CompensationPaid', recipient: 'D', amount: 40000000 },
    { event: 'ProtocolFeeTaken', amount: 20000000 }
  ]
};
```

### 3.3 Performance Test Expected Outputs

```typescript
// PERF-LAT-003: 5-task chain benchmark
const expectedBenchmarkOutput = {
  testId: 'PERF-LAT-003',
  scenario: '5-task linear chain',
  iterations: 100,
  results: {
    sequential: {
      p50: 4850,
      p95: 5200,
      p99: 5500,
      max: 6100,
      mean: 4920,
      stdDev: 280
    },
    speculative: {
      p50: 1850,
      p95: 2100,
      p99: 2400,
      max: 2800,
      mean: 1920,
      stdDev: 210
    },
    improvement: {
      p50: '61.9%',
      p95: '59.6%',
      p99: '56.4%'
    }
  },
  breakdown: {
    commitmentOverhead: { mean: 50, p99: 80 },
    proofGeneration: { mean: 800, p99: 1100 },
    verification: { mean: 200, p99: 300 },
    scheduling: { mean: 10, p99: 25 }
  },
  resourceUsage: {
    peakMemoryMb: 384,
    avgCpuPercent: 45,
    networkIoMb: 2.5
  },
  passed: true,
  target: { speculativeP99: 2000 },
  margin: '+400ms over target'
};
```

---

## 4. Test Fixtures

### 4.1 Commitment Fixtures

```typescript
// tests/fixtures/speculation/commitments.ts

export const VALID_COMMITMENTS = [
  {
    id: 'commit-valid-001',
    taskId: 'task-001',
    agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
    outputHash: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    salt: '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    commitmentHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
    nonce: 1,
    timestamp: 1706457600000,
    signature: '0xsig...',
    status: 'PENDING'
  },
  {
    id: 'commit-valid-002',
    taskId: 'task-002',
    agentPubkey: '5aYNuBiHwVgSPqNyZbHTqMxYcVSvfqQkHHQEwWWWWWWW',
    outputHash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    salt: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    commitmentHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
    nonce: 1,
    timestamp: 1706457600100,
    signature: '0xsig...',
    status: 'PENDING'
  }
];

export const INVALID_COMMITMENTS = [
  {
    id: 'commit-invalid-001',
    description: 'Malformed hash (wrong length)',
    taskId: 'task-003',
    agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
    outputHash: '0x0123',  // Too short
    salt: '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    expectedError: 'INVALID_HASH_LENGTH'
  },
  {
    id: 'commit-invalid-002',
    description: 'Reused nonce',
    taskId: 'task-001',
    agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
    outputHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
    salt: '0x8888888888888888888888888888888888888888888888888888888888888888',
    nonce: 1,  // Same as commit-valid-001
    expectedError: 'NONCE_REUSED'
  },
  {
    id: 'commit-invalid-003',
    description: 'Invalid signature',
    taskId: 'task-004',
    agentPubkey: '4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
    outputHash: '0x7777777777777777777777777777777777777777777777777777777777777777',
    salt: '0x6666666666666666666666666666666666666666666666666666666666666666',
    signature: '0xinvalid',
    expectedError: 'SIGNATURE_VERIFICATION_FAILED'
  }
];
```

### 4.2 Proof Fixtures

```typescript
// tests/fixtures/speculation/proofs.ts

export const VALID_PROOFS = [
  {
    id: 'proof-valid-001',
    taskId: 'task-001',
    commitmentId: 'commit-valid-001',
    proof: {
      pi_a: [
        '0x2c1e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e',
        '0x1d2f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f',
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      ],
      pi_b: [
        [
          '0x3e4a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
          '0x4f5b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b'
        ],
        [
          '0x5c6d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d',
          '0x6e7f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f'
        ],
        [
          '0x0000000000000000000000000000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000000000000000000000000000000'
        ]
      ],
      pi_c: [
        '0x7a8b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b',
        '0x8c9dada0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0',
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      ],
      protocol: 'groth16',
      curve: 'bn254'
    },
    publicInputs: {
      taskId: 1,
      agentPubkey: '0x4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
      constraintHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      outputCommitment: '0x5555555555555555555555555555555555555555555555555555555555555555'
    },
    expectedVerificationResult: true
  }
];

export const INVALID_PROOFS = [
  {
    id: 'proof-invalid-001',
    description: 'Corrupted pi_a',
    taskId: 'task-001',
    proof: {
      pi_a: ['0x0', '0x0', '0x1'],  // Invalid
      pi_b: VALID_PROOFS[0].proof.pi_b,
      pi_c: VALID_PROOFS[0].proof.pi_c,
      protocol: 'groth16',
      curve: 'bn254'
    },
    expectedVerificationResult: false,
    expectedError: 'PROOF_VERIFICATION_FAILED'
  },
  {
    id: 'proof-invalid-002',
    description: 'Wrong public inputs',
    taskId: 'task-002',  // Different task
    proof: VALID_PROOFS[0].proof,  // Proof for task-001
    publicInputs: {
      taskId: 2,  // Mismatch
      agentPubkey: '0x4zXMtBjHgUfTRqMwYbGSvfqPkGGPE4CjJFPDvVVVVVVV',
      constraintHash: '0xdifferent...',
      outputCommitment: '0xdifferent...'
    },
    expectedVerificationResult: false,
    expectedError: 'PUBLIC_INPUT_MISMATCH'
  }
];
```

### 4.3 Stake Fixtures

```typescript
// tests/fixtures/speculation/stakes.ts

export const STAKE_SCENARIOS = {
  // Sufficient stake scenarios
  sufficient: [
    {
      id: 'stake-sufficient-001',
      description: 'Exact minimum stake',
      agentStake: 100000000,  // 0.1 SOL
      requiredStake: 100000000,
      chainDepth: 1,
      expected: { allowed: true }
    },
    {
      id: 'stake-sufficient-002',
      description: 'Ample stake for deep chain',
      agentStake: 5000000000,  // 5 SOL
      requiredStake: 1125000000,  // 0.1 * 1.5^3 for depth 3
      chainDepth: 3,
      expected: { allowed: true, remainingCapacity: 3875000000 }
    }
  ],
  
  // Insufficient stake scenarios
  insufficient: [
    {
      id: 'stake-insufficient-001',
      description: 'Below minimum',
      agentStake: 50000000,  // 0.05 SOL
      requiredStake: 100000000,
      chainDepth: 1,
      expected: {
        allowed: false,
        error: 'INSUFFICIENT_STAKE',
        shortfall: 50000000
      }
    },
    {
      id: 'stake-insufficient-002',
      description: 'Sufficient for shallow, not for deep',
      agentStake: 200000000,  // 0.2 SOL
      chainDepth: 5,
      expected: {
        maxAllowedDepth: 2,
        error: 'STAKE_DEPTH_LIMIT'
      }
    }
  ],
  
  // Slashing scenarios
  slashing: [
    {
      id: 'slash-timeout-001',
      description: 'Claim timeout slashing',
      stakedAmount: 1000000000,
      slashRateBps: 1000,  // 10%
      expected: {
        slashed: 100000000,
        returned: 900000000,
        protocolFee: 20000000,
        compensationPool: 80000000
      }
    },
    {
      id: 'slash-fraud-001',
      description: 'Fraud slashing (100%)',
      stakedAmount: 1000000000,
      slashRateBps: 10000,  // 100%
      expected: {
        slashed: 1000000000,
        returned: 0,
        protocolFee: 200000000,
        compensationPool: 800000000
      }
    }
  ]
};
```

---

## 5. Data Generators

### 5.1 Task Chain Generator

```typescript
// tests/generators/speculation/chain-generator.ts

import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';

export interface ChainGeneratorConfig {
  length: number;
  topology: 'linear' | 'diamond' | 'dag';
  proofDelay?: number;
  failureRate?: number;
  agents?: string[];
}

export function generateTaskChain(config: ChainGeneratorConfig) {
  const tasks = [];
  const chainId = `chain-${uuidv4().slice(0, 8)}`;
  
  switch (config.topology) {
    case 'linear':
      return generateLinearChain(chainId, config);
    case 'diamond':
      return generateDiamondChain(chainId, config);
    case 'dag':
      return generateDAGChain(chainId, config);
  }
}

function generateLinearChain(chainId: string, config: ChainGeneratorConfig) {
  const tasks = [];
  let previousId: string | null = null;
  
  for (let i = 0; i < config.length; i++) {
    const taskId = `${chainId}-task-${String(i + 1).padStart(3, '0')}`;
    tasks.push({
      taskId,
      description: `Task ${i + 1} of ${config.length}`,
      dependencies: previousId ? [previousId] : [],
      constraintHash: `0x${randomBytes(32).toString('hex')}`,
      reward: Math.floor(100000000 + Math.random() * 900000000),
      estimatedDuration: Math.floor(300 + Math.random() * 700),
      failureInjection: Math.random() < (config.failureRate || 0),
      agent: config.agents ? config.agents[i % config.agents.length] : null
    });
    previousId = taskId;
  }
  
  return {
    chainId,
    topology: 'linear',
    tasks,
    criticalPath: tasks.map(t => t.taskId),
    expectedDuration: calculateExpectedDuration(tasks, 'linear')
  };
}

function generateDiamondChain(chainId: string, config: ChainGeneratorConfig) {
  // Diamond: root → [parallel branches] → merge
  const tasks = [];
  const branches = Math.min(config.length - 2, 4);  // At least root + merge
  
  // Root task
  const rootId = `${chainId}-root`;
  tasks.push({
    taskId: rootId,
    description: 'Diamond root',
    dependencies: [],
    constraintHash: `0x${randomBytes(32).toString('hex')}`,
    reward: 500000000,
    estimatedDuration: 400
  });
  
  // Branch tasks
  const branchIds = [];
  for (let i = 0; i < branches; i++) {
    const branchId = `${chainId}-branch-${String.fromCharCode(65 + i)}`;
    branchIds.push(branchId);
    tasks.push({
      taskId: branchId,
      description: `Branch ${String.fromCharCode(65 + i)}`,
      dependencies: [rootId],
      constraintHash: `0x${randomBytes(32).toString('hex')}`,
      reward: 400000000 + i * 100000000,
      estimatedDuration: 300 + i * 100
    });
  }
  
  // Merge task
  const mergeId = `${chainId}-merge`;
  tasks.push({
    taskId: mergeId,
    description: 'Diamond merge',
    dependencies: branchIds,
    constraintHash: `0x${randomBytes(32).toString('hex')}`,
    reward: 600000000,
    estimatedDuration: 300
  });
  
  return {
    chainId,
    topology: 'diamond',
    tasks,
    branches,
    criticalPath: determineCriticalPath(tasks),
    expectedDuration: calculateExpectedDuration(tasks, 'diamond')
  };
}

function generateDAGChain(chainId: string, config: ChainGeneratorConfig) {
  const tasks = [];
  const layers = Math.ceil(Math.sqrt(config.length));
  
  let taskIndex = 0;
  const layerTasks: string[][] = [];
  
  for (let layer = 0; layer < layers && taskIndex < config.length; layer++) {
    const layerSize = layer === 0 ? 1 : Math.min(
      Math.floor(config.length / layers) + (layer % 2),
      config.length - taskIndex
    );
    
    layerTasks[layer] = [];
    
    for (let i = 0; i < layerSize && taskIndex < config.length; i++) {
      const taskId = `${chainId}-L${layer}-T${i}`;
      layerTasks[layer].push(taskId);
      
      // Determine dependencies (connect to previous layer)
      const deps: string[] = [];
      if (layer > 0) {
        const prevLayer = layerTasks[layer - 1];
        // Connect to 1-3 tasks from previous layer
        const numDeps = Math.min(prevLayer.length, Math.floor(Math.random() * 3) + 1);
        const selectedIndices = new Set<number>();
        while (selectedIndices.size < numDeps) {
          selectedIndices.add(Math.floor(Math.random() * prevLayer.length));
        }
        selectedIndices.forEach(idx => deps.push(prevLayer[idx]));
      }
      
      tasks.push({
        taskId,
        description: `DAG Layer ${layer}, Task ${i}`,
        dependencies: deps,
        constraintHash: `0x${randomBytes(32).toString('hex')}`,
        reward: 300000000 + Math.floor(Math.random() * 500000000),
        estimatedDuration: 200 + Math.floor(Math.random() * 600)
      });
      
      taskIndex++;
    }
  }
  
  return {
    chainId,
    topology: 'dag',
    tasks,
    layers: layerTasks.length,
    maxParallelism: Math.max(...layerTasks.map(l => l.length)),
    criticalPath: determineCriticalPath(tasks),
    expectedDuration: calculateExpectedDuration(tasks, 'dag')
  };
}

function calculateExpectedDuration(tasks: any[], topology: string) {
  // Simplified calculation
  const totalSequential = tasks.reduce((sum, t) => sum + t.estimatedDuration, 0);
  
  let speculativeFactor: number;
  switch (topology) {
    case 'linear':
      speculativeFactor = 0.4;  // ~40% of sequential
      break;
    case 'diamond':
      speculativeFactor = 0.5;  // ~50% of sequential
      break;
    case 'dag':
      speculativeFactor = 0.35; // ~35% of sequential
      break;
    default:
      speculativeFactor = 0.5;
  }
  
  return {
    sequential: totalSequential,
    speculative: Math.floor(totalSequential * speculativeFactor)
  };
}

function determineCriticalPath(tasks: any[]): string[] {
  // Simplified: return longest path by duration
  // Real implementation would use proper graph traversal
  const sorted = [...tasks].sort((a, b) => b.estimatedDuration - a.estimatedDuration);
  return sorted.slice(0, Math.ceil(tasks.length / 2)).map(t => t.taskId);
}
```

### 5.2 Commitment Generator

```typescript
// tests/generators/speculation/commitment-generator.ts

import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

export interface CommitmentGeneratorConfig {
  taskId: string;
  agent: { pubkey: string; secretKey: Uint8Array };
  outputData?: bigint[];
  includeSignature?: boolean;
}

function sha256Hash(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function generateCommitment(config: CommitmentGeneratorConfig) {
  const output = config.outputData || [
    BigInt('0x' + randomBytes(8).toString('hex')),
    BigInt('0x' + randomBytes(8).toString('hex')),
    BigInt('0x' + randomBytes(8).toString('hex')),
    BigInt('0x' + randomBytes(8).toString('hex'))
  ];

  const salt = BigInt('0x' + randomBytes(32).toString('hex'));
  const outputHash = sha256Hash(Buffer.from(output.map(b => b.toString(16).padStart(16, '0')).join(''), 'hex'));
  const commitmentHash = sha256Hash(Buffer.concat([outputHash, Buffer.from(salt.toString(16).padStart(64, '0'), 'hex')]));
  
  const nonce = Date.now();
  const timestamp = Date.now();
  
  let signature: string | null = null;
  if (config.includeSignature !== false) {
    const message = Buffer.concat([
      Buffer.from(config.taskId),
      Buffer.from(commitmentHash.toString(16), 'hex'),
      Buffer.from(nonce.toString())
    ]);
    const sig = nacl.sign.detached(message, config.agent.secretKey);
    signature = Buffer.from(sig).toString('hex');
  }
  
  return {
    taskId: config.taskId,
    agentPubkey: config.agent.pubkey,
    output,
    salt,
    outputHash: '0x' + outputHash.toString(16).padStart(64, '0'),
    commitmentHash: '0x' + commitmentHash.toString(16).padStart(64, '0'),
    nonce,
    timestamp,
    signature: signature ? '0x' + signature : null
  };
}

export function generateCommitmentChain(
  tasks: { taskId: string }[],
  agent: { pubkey: string; secretKey: Uint8Array }
) {
  return tasks.map((task, index) => {
    const commitment = generateCommitment({ taskId: task.taskId, agent });
    return {
      ...commitment,
      chainIndex: index,
      dependsOn: index > 0 ? tasks[index - 1].taskId : null
    };
  });
}
```

### 5.3 Proof Generator (Mock)

```typescript
// tests/generators/speculation/proof-generator.ts

export interface MockProofConfig {
  taskId: string;
  commitment: any;
  valid?: boolean;
  delay?: number;
}

export async function generateMockProof(config: MockProofConfig) {
  // Simulate proof generation delay
  const delay = config.delay ?? 800;
  await new Promise(resolve => setTimeout(resolve, delay));
  
  if (config.valid === false) {
    return generateInvalidProof(config);
  }
  
  return {
    taskId: config.taskId,
    commitmentId: config.commitment.commitmentHash,
    proof: {
      pi_a: generateValidPiA(),
      pi_b: generateValidPiB(),
      pi_c: generateValidPiC(),
      protocol: 'groth16',
      curve: 'bn254'
    },
    publicInputs: {
      taskId: BigInt(config.taskId.split('-').pop() || '0'),
      constraintHash: config.commitment.outputHash,
      outputCommitment: config.commitment.commitmentHash
    },
    generatedAt: Date.now(),
    generationTimeMs: delay
  };
}

function generateValidPiA(): string[] {
  // Generate plausible-looking proof elements
  return [
    '0x' + randomBn254Element(),
    '0x' + randomBn254Element(),
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  ];
}

function generateValidPiB(): string[][] {
  return [
    ['0x' + randomBn254Element(), '0x' + randomBn254Element()],
    ['0x' + randomBn254Element(), '0x' + randomBn254Element()],
    ['0x0000000000000000000000000000000000000000000000000000000000000001',
     '0x0000000000000000000000000000000000000000000000000000000000000000']
  ];
}

function generateValidPiC(): string[] {
  return [
    '0x' + randomBn254Element(),
    '0x' + randomBn254Element(),
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  ];
}

function generateInvalidProof(config: MockProofConfig) {
  return {
    taskId: config.taskId,
    proof: {
      pi_a: ['0x0', '0x0', '0x1'],
      pi_b: [['0x0', '0x0'], ['0x0', '0x0'], ['0x1', '0x0']],
      pi_c: ['0x0', '0x0', '0x1'],
      protocol: 'groth16',
      curve: 'bn254'
    },
    invalid: true,
    reason: 'MOCK_INVALID_PROOF'
  };
}

function randomBn254Element(): string {
  // Generate random element in BN254 field
  const bytes = randomBytes(32);
  // Ensure it's within field order (simplified)
  bytes[0] = bytes[0] & 0x1f;
  return bytes.toString('hex');
}
```

---

## 6. Error Scenarios

### 6.1 Error Code Reference

```typescript
// Error codes for speculative execution
export const SPECULATION_ERRORS = {
  // Dependency Graph Errors (1000-1099)
  CYCLE_DETECTED: { code: 1001, message: 'Cycle detected in dependency graph' },
  DEPENDENCY_NOT_FOUND: { code: 1002, message: 'Referenced dependency does not exist' },
  MAX_DEPTH_EXCEEDED: { code: 1003, message: 'Maximum graph depth exceeded' },
  MAX_WIDTH_EXCEEDED: { code: 1004, message: 'Maximum graph width exceeded' },
  DUPLICATE_TASK: { code: 1005, message: 'Task already exists in graph' },
  HAS_DEPENDENTS: { code: 1006, message: 'Cannot remove task with active dependents' },
  
  // Proof Deferral Errors (1100-1199)
  INSUFFICIENT_STAKE: { code: 1101, message: 'Insufficient stake for speculative claim' },
  CLAIM_EXPIRED: { code: 1102, message: 'Claim has expired without proof submission' },
  CLAIM_LOCKED: { code: 1103, message: 'Claim is locked and cannot be modified' },
  DUPLICATE_CLAIM: { code: 1104, message: 'Duplicate claim for same task and agent' },
  PROOF_VERIFICATION_FAILED: { code: 1105, message: 'Proof failed verification' },
  PROOF_TIMEOUT: { code: 1106, message: 'Proof verification timed out' },
  COMMITMENT_MISMATCH: { code: 1107, message: 'Proof does not match commitment' },
  RATE_LIMIT_EXCEEDED: { code: 1108, message: 'Agent exceeded claim rate limit' },
  
  // Commitment Ledger Errors (1200-1299)
  DUPLICATE_COMMITMENT: { code: 1201, message: 'Commitment hash already recorded' },
  COMMITMENT_TOO_LARGE: { code: 1202, message: 'Commitment exceeds size limit' },
  NONCE_REUSED: { code: 1203, message: 'Commitment nonce has been used before' },
  SIGNATURE_VERIFICATION_FAILED: { code: 1204, message: 'Commitment signature invalid' },
  IMMUTABLE_COMMITMENT: { code: 1205, message: 'Cannot modify fulfilled/violated commitment' },
  MERKLE_PROOF_INVALID: { code: 1206, message: 'Merkle proof verification failed' },
  
  // Rollback Errors (1300-1399)
  ROLLBACK_IN_PROGRESS: { code: 1301, message: 'Rollback already in progress for this task' },
  IMMUTABLE_TASK: { code: 1302, message: 'Cannot rollback finalized task' },
  ROLLBACK_TIMEOUT: { code: 1303, message: 'Rollback operation timed out' },
  CASCADE_LIMIT_EXCEEDED: { code: 1304, message: 'Rollback cascade depth limit exceeded' },
  UNAUTHORIZED_ROLLBACK: { code: 1305, message: 'Not authorized to trigger rollback' },
  
  // Scheduler Errors (1400-1499)
  QUEUE_FULL: { code: 1401, message: 'Scheduler queue is full' },
  TASK_TIMEOUT: { code: 1402, message: 'Task execution timed out' },
  SCHEDULER_PAUSED: { code: 1403, message: 'Scheduler is paused' },
  DEADLOCK_DETECTED: { code: 1404, message: 'Circular wait detected in scheduling' },
  RESOURCE_EXHAUSTED: { code: 1405, message: 'Insufficient resources for task execution' }
};
```

### 6.2 Error Injection Scenarios

```typescript
// tests/fixtures/speculation/error-scenarios.ts

export const ERROR_SCENARIOS = [
  {
    id: 'err-001',
    name: 'Proof generation timeout',
    setup: {
      chain: 'CHAIN-LINEAR-001',
      failTaskIndex: 1,
      failureType: 'PROOF_TIMEOUT'
    },
    injection: {
      delayMs: 2000000,  // > CLAIM_TTL
      atTask: 'task-B-001'
    },
    expected: {
      error: SPECULATION_ERRORS.CLAIM_EXPIRED,
      rollback: ['task-B-001', 'task-C-001'],
      slashing: { taskId: 'task-B-001', rateBps: 1000 }
    }
  },
  {
    id: 'err-002',
    name: 'Invalid proof submission',
    setup: {
      chain: 'CHAIN-LINEAR-001',
      failTaskIndex: 0,
      failureType: 'INVALID_PROOF'
    },
    injection: {
      corruptProof: true,
      atTask: 'task-A-001'
    },
    expected: {
      error: SPECULATION_ERRORS.PROOF_VERIFICATION_FAILED,
      rollback: ['task-A-001', 'task-B-001', 'task-C-001'],
      slashing: { taskId: 'task-A-001', rateBps: 10000 }  // 100% fraud
    }
  },
  {
    id: 'err-003',
    name: 'Commitment replay attack',
    setup: {
      chain: 'CHAIN-LINEAR-001'
    },
    injection: {
      replayCommitment: 'commit-valid-001',  // From previous chain
      atTask: 'task-A-001'
    },
    expected: {
      error: SPECULATION_ERRORS.NONCE_REUSED,
      rejection: true,
      slashing: null  // Rejected before stake locked
    }
  },
  {
    id: 'err-004',
    name: 'Concurrent rollback race',
    setup: {
      chain: 'CHAIN-DIAMOND-001'
    },
    injection: {
      failBothBranches: true,
      simultaneousFailure: true,
      tasks: ['task-D-B', 'task-D-C']
    },
    expected: {
      error: null,  // Should handle gracefully
      rollback: ['task-D-B', 'task-D-C', 'task-D-D'],
      rollbackDedup: true,
      finalState: 'consistent'
    }
  },
  {
    id: 'err-005',
    name: 'Stake exhaustion mid-chain',
    setup: {
      chain: 'CHAIN-LINEAR-002',  // 5-task chain
      agentStake: 200000000       // Only enough for ~2 tasks
    },
    injection: {
      triggerAt: 3  // Third task
    },
    expected: {
      error: SPECULATION_ERRORS.INSUFFICIENT_STAKE,
      stoppedAt: 'task-L5-C',
      completedTasks: ['task-L5-A', 'task-L5-B'],
      pendingTasks: ['task-L5-C', 'task-L5-D', 'task-L5-E']
    }
  }
];
```

---

## Appendix A: Hash Constants

```typescript
// Common test hashes
export const TEST_HASHES = {
  ZERO_HASH: '0x0000000000000000000000000000000000000000000000000000000000000000',
  MAX_HASH: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  SAMPLE_CONSTRAINT_HASH: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  SAMPLE_OUTPUT_HASH: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  SHA256_EMPTY: '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
};
```

## Appendix B: Time Constants

```typescript
// Time constants for testing (in milliseconds)
export const TEST_TIMES = {
  INSTANT: 0,
  QUICK: 100,
  NORMAL: 500,
  SLOW: 1000,
  TIMEOUT_SHORT: 5000,
  TIMEOUT_MEDIUM: 30000,
  TIMEOUT_LONG: 60000,
  CLAIM_TTL: 1800000,       // 30 minutes
  VERIFICATION_TTL: 300000  // 5 minutes
};
```

---

**Document Control:**
- Created: 2025-01-28
- Last Review: 2025-01-28
- Companion to: TEST-PLAN.md
