# Speculative Execution - Software Design Document

> **Version:** 1.0.0  
> **Status:** Design Complete  
> **Epic:** [#285](https://github.com/tetsuo-ai/AgenC/issues/285)  
> **Authors:** AgenC Team  
> **Last Updated:** 2026-01-28

---

## 1. Introduction

### 1.1 Purpose

This Software Design Document (SDD) provides the complete technical specification for implementing Speculative Execution with Optimistic Proof Deferral in the AgenC protocol. It serves as the authoritative reference for developers implementing, testing, and maintaining the speculative execution system.

The document covers:
- System architecture and component design
- API specifications and data structures
- Safety mechanisms and correctness guarantees
- Configuration and operational procedures
- Testing strategies and observability requirements

### 1.2 Scope

This document covers the speculative execution feature set within the AgenC agent runtime and its interactions with the Solana on-chain program. The scope includes:

**In Scope:**
- Runtime speculation engine (`@agenc/runtime` TypeScript package)
- Dependency tracking between tasks
- Proof generation and deferral queuing
- Commitment tracking and rollback mechanisms
- On-chain task dependency field extension
- Stake bonding for speculation
- Metrics, logging, and observability

**Out of Scope:**
- Changes to the core ZK circuit design
- Privacy Cash integration modifications
- Multi-chain speculation (future consideration)
- Speculative dispute resolution

### 1.3 Definitions & Acronyms

| Term | Definition |
|------|------------|
| **Speculation** | Executing downstream tasks before ancestor proofs are confirmed on-chain |
| **Speculative Commitment** | A local record that a task's output exists but isn't yet proven on-chain |
| **Ancestor** | A task whose output is consumed by another task (parent in dependency graph) |
| **Descendant** | A task that depends on another task's output (child in dependency graph) |
| **Speculation Depth** | Number of unconfirmed ancestors in the longest dependency path |
| **Rollback** | Reverting speculative work when an ancestor proof fails |
| **Proof Deferral** | Delaying proof submission until ancestors are confirmed |
| **Commitment Ledger** | Local registry tracking speculative task commitments |
| **Finality** | On-chain confirmation that a task's proof is accepted |
| **DAG** | Directed Acyclic Graph (task dependency structure) |
| **TTL** | Time-To-Live (commitment expiration) |
| **CPI** | Cross-Program Invocation (Solana) |
| **PDA** | Program Derived Address (Solana) |

### 1.4 References

#### GitHub Issues (Implementation Tracking)

| Issue | Component | Description |
|-------|-----------|-------------|
| [#259](https://github.com/tetsuo-ai/AgenC/issues/259) | On-Chain | Add `depends_on` field to Task struct |
| [#260](https://github.com/tetsuo-ai/AgenC/issues/260) | Runtime | DependencyGraph foundation types |
| [#261](https://github.com/tetsuo-ai/AgenC/issues/261) | Runtime | DependencyGraph core implementation |
| [#262](https://github.com/tetsuo-ai/AgenC/issues/262) | Runtime | DependencyGraph traversal algorithms |
| [#263](https://github.com/tetsuo-ai/AgenC/issues/263) | Runtime | DependencyGraph cycle detection |
| [#264](https://github.com/tetsuo-ai/AgenC/issues/264) | Runtime | ProofDeferralManager types |
| [#265](https://github.com/tetsuo-ai/AgenC/issues/265) | Runtime | ProofDeferralManager core implementation |
| [#266](https://github.com/tetsuo-ai/AgenC/issues/266) | Runtime | CommitmentLedger foundation |
| [#267](https://github.com/tetsuo-ai/AgenC/issues/267) | Runtime | CommitmentLedger state transitions |
| [#268](https://github.com/tetsuo-ai/AgenC/issues/268) | Runtime | CommitmentLedger persistence |
| [#269](https://github.com/tetsuo-ai/AgenC/issues/269) | Runtime | RollbackController core |
| [#270](https://github.com/tetsuo-ai/AgenC/issues/270) | Runtime | RollbackController cascade logic |
| [#271](https://github.com/tetsuo-ai/AgenC/issues/271) | Runtime | SpeculativeTaskScheduler core |
| [#272](https://github.com/tetsuo-ai/AgenC/issues/272) | Runtime | SpeculativeTaskScheduler policies |
| [#273](https://github.com/tetsuo-ai/AgenC/issues/273) | On-Chain | SpeculativeCommitment account type |
| [#274](https://github.com/tetsuo-ai/AgenC/issues/274) | On-Chain | `create_speculative_commitment` instruction |
| [#275](https://github.com/tetsuo-ai/AgenC/issues/275) | On-Chain | Stake bonding and slashing |
| [#276](https://github.com/tetsuo-ai/AgenC/issues/276) | SDK | Speculation client methods |
| [#277](https://github.com/tetsuo-ai/AgenC/issues/277) | SDK | Proof deferral helpers |
| [#278](https://github.com/tetsuo-ai/AgenC/issues/278) | Observability | Speculation metrics |
| [#279](https://github.com/tetsuo-ai/AgenC/issues/279) | Observability | Speculation tracing |
| [#280](https://github.com/tetsuo-ai/AgenC/issues/280) | Testing | Unit test suite |
| [#281](https://github.com/tetsuo-ai/AgenC/issues/281) | Testing | Integration test suite |
| [#282](https://github.com/tetsuo-ai/AgenC/issues/282) | Testing | Chaos test suite |
| [#283](https://github.com/tetsuo-ai/AgenC/issues/283) | Testing | Performance benchmarks |
| [#284](https://github.com/tetsuo-ai/AgenC/issues/284) | Docs | API documentation |
| [#285](https://github.com/tetsuo-ai/AgenC/issues/285) | Epic | Master tracking issue |
| [#286](https://github.com/tetsuo-ai/AgenC/issues/286) | Runtime | Configuration schema |
| [#287](https://github.com/tetsuo-ai/AgenC/issues/287) | Runtime | Event monitoring integration |
| [#288](https://github.com/tetsuo-ai/AgenC/issues/288) | Ops | Runbook documentation |
| [#289](https://github.com/tetsuo-ai/AgenC/issues/289) | Ops | Alerting rules |
| [#290](https://github.com/tetsuo-ai/AgenC/issues/290) | Security | Security review |
| [#291](https://github.com/tetsuo-ai/AgenC/issues/291) | Security | Formal verification |

#### Related Documents

- [Architecture Overview](/docs/architecture.md)
- [Runtime Phase 2 Design](/docs/design/speculation/README.md)
- [Decision Log](/docs/design/speculation/DECISION-LOG.md)
- [Configuration Guide](/docs/design/speculation/operations/CONFIGURATION.md)

---

## 2. System Overview

### 2.1 Problem Statement

In the current AgenC protocol, task pipelines execute **synchronously with immediate finality**:

```
Task A claims → Task A computes → Task A generates proof → Task A submits proof → WAIT FOR CONFIRMATION
                                                                                        ↓
Task B claims → Task B computes → Task B generates proof → Task B submits proof → WAIT FOR CONFIRMATION
```

This sequential pattern introduces significant latency:

1. **Proof Generation Latency**: Groth16 proofs take 2-10 seconds to generate
2. **Network Latency**: Solana slot confirmation adds 400ms-2s per transaction
3. **Finality Latency**: Full confirmation requires 1-32 slots (~400ms-13s)
4. **Pipeline Multiplier**: N-task pipelines suffer N× cumulative delays

For a 5-task pipeline with average 5s proof generation and 2s confirmation:
- **Current**: 5 × (5s + 2s) = **35 seconds**
- **Ideal (parallel)**: 5s + (5 × 0.4s) = **7 seconds**

The 5× latency penalty makes AgenC uncompetitive for real-time agent coordination.

### 2.2 Proposed Solution

**Speculative Execution with Optimistic Proof Deferral** allows downstream tasks to begin execution before ancestor proofs are confirmed:

```
Task A claims → Task A computes → Task A generates proof ─────────────────────→ Submit A
                     ↓ (speculative output)
Task B claims → Task B computes → Task B generates proof ─────────────────────→ Submit B (after A confirms)
                     ↓ (speculative output)
Task C claims → Task C computes → Task C generates proof ─────────────────────→ Submit C (after B confirms)
```

**Key Mechanisms:**

1. **Speculative Commitments**: Local records that a task's output exists (but isn't proven on-chain yet)
2. **Dependency Tracking**: DAG of task dependencies with speculative state
3. **Proof Deferral Queue**: Ordered queue ensuring proofs submit only when ancestors are confirmed
4. **Rollback Controller**: Cascade undo mechanism when ancestor proofs fail
5. **Stake Bonding**: Economic security through locked collateral

### 2.3 Design Goals

| Goal | Priority | Success Metric |
|------|----------|----------------|
| **Latency Reduction** | P0 | 2-3× reduction in pipeline execution time |
| **Safety First** | P0 | Zero invalid state transitions on-chain |
| **Correctness** | P0 | All invariants maintained under all scenarios |
| **Graceful Degradation** | P1 | Fall back to synchronous on failure |
| **Observability** | P1 | Full visibility into speculation state |
| **Configurability** | P1 | Tunable depth, stake, and timeout parameters |
| **Minimal On-Chain Changes** | P2 | Leverage existing infrastructure where possible |

### 2.4 Non-Goals / Out of Scope

| Non-Goal | Rationale |
|----------|-----------|
| **Cross-Agent Speculation** | Phase 1 focuses on single-agent speculation; cross-agent trust requires on-chain commitments (Phase 2) |
| **Speculative Dispute Resolution** | Disputes involve third-party arbiters; speculation complexity too high |
| **ZK Circuit Modifications** | Current Groth16 circuits are sufficient |
| **Multi-Chain Speculation** | Single-chain focus for initial release |
| **Automatic Depth Optimization** | Manual configuration preferred for predictability |
| **Speculation for Competitive Tasks** | Race conditions make speculation unsafe |

---

## 3. Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Agent Runtime (@agenc/runtime)                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SpeculativeExecutionEngine                          │ │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐  │ │
│  │  │ Dependency    │  │ Commitment    │  │ ProofDeferral │  │  Rollback    │  │ │
│  │  │ Graph         │←→│ Ledger        │←→│ Manager       │←→│  Controller  │  │ │
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘  └──────┬───────┘  │ │
│  │          │                  │                  │                  │          │ │
│  │          └──────────────────┼──────────────────┼──────────────────┘          │ │
│  │                             │                  │                             │ │
│  │                    ┌────────┴────────┐  ┌──────┴───────┐                     │ │
│  │                    │  Speculative    │  │    Event     │                     │ │
│  │                    │  TaskScheduler  │  │   Monitor    │                     │ │
│  │                    └────────┬────────┘  └──────┬───────┘                     │ │
│  └─────────────────────────────┼──────────────────┼─────────────────────────────┘ │
│                                │                  │                               │
│  ┌─────────────────────────────┼──────────────────┼─────────────────────────────┐ │
│  │              AgentManager / TaskExecutor / ProofGenerator                    │ │
│  └─────────────────────────────┼──────────────────┼─────────────────────────────┘ │
└────────────────────────────────┼──────────────────┼───────────────────────────────┘
                                 │                  │
                    ┌────────────┴──────────────────┴────────────┐
                    │            Solana RPC / WebSocket           │
                    └────────────────────┬───────────────────────┘
                                         │
┌────────────────────────────────────────┼───────────────────────────────────────┐
│                        Solana Blockchain                                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                 │
│  │   Task Account  │  │  TaskClaim      │  │ SpeculativeComm │                 │
│  │  (w/ depends_on)│  │  Account        │  │ Account (Opt)   │                 │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                 │
│  │  TaskEscrow     │  │ AgentRegister   │  │ ProtocolConfig  │                 │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Descriptions

#### 3.2.1 DependencyGraph

**Purpose**: Track task dependency relationships as a directed acyclic graph (DAG).

**Responsibilities**:
- Maintain parent/child relationships between tasks
- Compute speculation depth for any task
- Detect cycles (reject cyclic dependencies)
- Provide topological ordering for proof submission
- Track confirmation status of each node

**Key Data Structures**:
```typescript
interface DependencyNode {
  taskId: Uint8Array;           // 32-byte task identifier
  taskPda: PublicKey;           // Task account address
  parentTaskId: Uint8Array | null;  // Dependency (null = root)
  children: Set<string>;        // Hex-encoded child task IDs
  status: DependencyStatus;     // Pending | Speculative | Confirmed | Failed
  depth: number;                // Speculation depth (0 = confirmed ancestor)
  createdAt: number;            // Unix timestamp
  confirmedAt: number | null;   // When proof was confirmed
}

enum DependencyStatus {
  Pending = 'pending',          // Task created, not yet executed
  Speculative = 'speculative',  // Executed speculatively
  Confirmed = 'confirmed',      // Proof confirmed on-chain
  Failed = 'failed',            // Proof rejected or rolled back
}
```

#### 3.2.2 CommitmentLedger

**Purpose**: Local registry of speculative task commitments before on-chain finality.

**Responsibilities**:
- Store speculative output commitments (hash of output + salt)
- Track commitment lifecycle (created → submitted → confirmed/failed)
- Provide lookup by task ID or commitment hash
- Enforce TTL-based expiration
- Support atomic batch operations

**Key Data Structures**:
```typescript
interface Risc0PrivatePayload {
  sealBytes: Uint8Array;
  journal: Uint8Array;
  imageId: Uint8Array;
  bindingSeed: Uint8Array;
  nullifierSeed: Uint8Array;
}

interface SpeculativeCommitment {
  taskId: Uint8Array;           // Task identifier
  outputCommitment: Uint8Array; // SHA-256(constraintHash, salt)
  constraintHash: Uint8Array;   // SHA-256(output)
  salt: bigint;                 // Randomness for commitment
  status: CommitmentStatus;
  speculationDepth: number;
  createdAt: number;
  expiresAt: number;            // TTL-based expiration
  privatePayload: Risc0PrivatePayload | null; // seal/journal/image/binding/nullifier bundle
  bondedStake: bigint;          // Lamports bonded for this commitment
}

enum CommitmentStatus {
  Created = 'created',          // Commitment generated locally
  ProofGenerated = 'proof_generated',
  Submitted = 'submitted',      // Proof sent to chain
  Confirmed = 'confirmed',      // On-chain confirmation
  Failed = 'failed',            // Proof rejected
  Expired = 'expired',          // TTL exceeded
  RolledBack = 'rolled_back',   // Cascade rollback
}
```

#### 3.2.3 ProofDeferralManager

**Purpose**: Queue and order proof submissions to maintain the proof ordering invariant.

**Responsibilities**:
- Queue proofs awaiting ancestor confirmation
- Monitor ancestor status via event subscriptions
- Trigger proof submission when ancestors confirm
- Handle submission failures with retry logic
- Coordinate with RollbackController on failures

**Key Data Structures**:
```typescript
interface DeferredProof {
  taskId: Uint8Array;
  payload: Risc0PrivatePayload; // Private payload bundle for complete_task_private
  ancestors: Uint8Array[];      // Task IDs that must confirm first
  pendingAncestors: Set<string>;  // Hex-encoded IDs still unconfirmed
  status: DeferralStatus;
  queuedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  error: string | null;
}

enum DeferralStatus {
  Waiting = 'waiting',          // Awaiting ancestors
  Ready = 'ready',              // All ancestors confirmed
  Submitting = 'submitting',    // Submission in progress
  Confirmed = 'confirmed',
  Failed = 'failed',
}
```

#### 3.2.4 RollbackController

**Purpose**: Cascade undo operations when speculative execution fails.

**Responsibilities**:
- Detect rollback triggers (proof failure, timeout, explicit cancel)
- Compute affected descendants via DependencyGraph
- Execute rollback in reverse topological order (leaves first)
- Release bonded stake (minus slashing if applicable)
- Emit rollback events for observability

**Key Data Structures**:
```typescript
interface RollbackPlan {
  triggerTaskId: Uint8Array;    // Task that failed
  triggerReason: RollbackReason;
  affectedTasks: Uint8Array[];  // Reverse topological order
  totalBondedStake: bigint;
  slashAmount: bigint;
  createdAt: number;
  executedAt: number | null;
  status: RollbackStatus;
}

enum RollbackReason {
  ProofFailed = 'proof_failed',
  ProofTimeout = 'proof_timeout',
  AncestorFailed = 'ancestor_failed',
  ClaimExpired = 'claim_expired',
  ManualCancel = 'manual_cancel',
}
```

#### 3.2.5 SpeculativeTaskScheduler

**Purpose**: Coordinate speculative task execution with safety bounds.

**Responsibilities**:
- Accept task execution requests
- Validate speculation eligibility (depth, stake, expiry)
- Coordinate with DependencyGraph for dependency resolution
- Invoke ProofGenerator and queue in ProofDeferralManager
- Enforce resource limits (memory, concurrent operations)

**Key Data Structures**:
```typescript
interface SchedulerConfig {
  maxDepth: number;             // Max speculation depth
  maxParallelBranches: number;  // Max concurrent spec paths
  minStake: bigint;             // Min stake per speculation
  stakePerDepth: bigint;        // Additional stake per depth
  claimBufferMs: number;        // Min time before claim expiry
  proofTimeoutMs: number;       // Max proof generation time
  confirmationTimeoutMs: number; // Max on-chain confirmation wait
  rollbackPolicy: 'cascade' | 'selective' | 'checkpoint';
}

interface ScheduleRequest {
  taskId: Uint8Array;
  taskPda: PublicKey;
  parentTaskId: Uint8Array | null;
  claimExpiresAt: number;
  requiredCapabilities: bigint;
}

interface ScheduleResult {
  accepted: boolean;
  reason?: string;
  speculationDepth?: number;
  estimatedBond?: bigint;
}
```

### 3.3 Component Interactions

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            Component Interaction Matrix                          │
├───────────────────┬──────────┬────────────┬───────────┬──────────┬──────────────┤
│                   │ DepGraph │ CommLedger │ ProofMgr  │ Rollback │ Scheduler    │
├───────────────────┼──────────┼────────────┼───────────┼──────────┼──────────────┤
│ DependencyGraph   │    -     │   reads    │  reads    │  reads   │ reads/writes │
│ CommitmentLedger  │  reads   │     -      │  writes   │  writes  │ reads/writes │
│ ProofDeferralMgr  │  reads   │   reads    │     -     │  signals │ reads        │
│ RollbackController│  reads   │   writes   │  signals  │    -     │ signals      │
│ TaskScheduler     │  writes  │   writes   │  writes   │  reads   │     -        │
└───────────────────┴──────────┴────────────┴───────────┴──────────┴──────────────┘
```

**Key Interaction Flows**:

1. **Schedule Speculative Task**:
   ```
   Scheduler → DependencyGraph.addNode()
            → CommitmentLedger.create()
            → ProofDeferralManager.enqueue()
   ```

2. **Ancestor Confirms**:
   ```
   EventMonitor → ProofDeferralManager.onAncestorConfirmed()
               → CommitmentLedger.updateStatus()
               → DependencyGraph.markConfirmed()
               → ProofDeferralManager.submitReady()
   ```

3. **Ancestor Fails**:
   ```
   EventMonitor → RollbackController.triggerRollback()
               → DependencyGraph.getDescendants()
               → CommitmentLedger.rollback() (for each)
               → ProofDeferralManager.cancelPending()
   ```

### 3.4 Data Flow

```
                                   ┌─────────────────┐
                                   │  Task Request   │
                                   │  (with parent)  │
                                   └────────┬────────┘
                                            │
                                            ▼
                              ┌─────────────────────────────┐
                              │    SpeculativeTaskScheduler │
                              │                             │
                              │  1. Validate speculation    │
                              │  2. Check depth limit       │
                              │  3. Check stake available   │
                              │  4. Check claim expiry      │
                              └──────────────┬──────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
                    ▼                        ▼                        ▼
         ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
         │  DependencyGraph │    │ CommitmentLedger │    │ ProofGenerator   │
         │                  │    │                  │    │                  │
         │ Add node, compute│    │ Create commitment│    │ Generate proof   │
         │ depth, track     │    │ with salt, hash  │    │ (async)          │
         └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
                  │                       │                       │
                  └───────────────────────┼───────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────────┐
                              │   ProofDeferralManager   │
                              │                          │
                              │  Queue proof with        │
                              │  ancestor dependencies   │
                              └────────────┬─────────────┘
                                           │
                          ┌────────────────┴────────────────┐
                          │                                 │
                          ▼                                 ▼
               ┌────────────────────┐            ┌────────────────────┐
               │  EventMonitor      │            │  Proof Queue       │
               │                    │            │                    │
               │  Watch for         │            │  [Proof A]         │
               │  - TaskCompleted   │            │  [Proof B] ←wait   │
               │  - ProofConfirmed  │            │  [Proof C] ←wait   │
               └─────────┬──────────┘            └────────┬───────────┘
                         │                                │
                         │  ancestor confirmed            │
                         └────────────────────────────────┘
                                           │
                                           ▼
                              ┌──────────────────────────┐
                              │   Submit Proof On-Chain  │
                              │   (complete_task_private)│
                              └────────────┬─────────────┘
                                           │
                          ┌────────────────┴────────────────┐
                          │                                 │
                          ▼                                 ▼
               ┌────────────────────┐            ┌────────────────────┐
               │     Success        │            │     Failure        │
               │                    │            │                    │
               │ Update ledger:     │            │ Trigger rollback:  │
               │ status=confirmed   │            │ cascade to         │
               │ Release stake      │            │ descendants        │
               │ Emit events        │            │ Slash stake        │
               └────────────────────┘            └────────────────────┘
```

---

## 4. Detailed Design

### 4.1 DependencyGraph

**File**: `runtime/src/speculation/dependency-graph.ts`  
**Issue**: [#261](https://github.com/tetsuo-ai/AgenC/issues/261)

#### 4.1.1 Type Definitions

```typescript
import { PublicKey } from '@solana/web3.js';

/**
 * Status of a dependency node in the speculation graph
 */
export enum DependencyStatus {
  /** Task created, not yet executed */
  Pending = 'pending',
  /** Executed speculatively, awaiting ancestor confirmation */
  Speculative = 'speculative',
  /** Proof confirmed on-chain */
  Confirmed = 'confirmed',
  /** Proof rejected or rolled back */
  Failed = 'failed',
}

/**
 * A node in the task dependency graph
 */
export interface DependencyNode {
  /** 32-byte unique task identifier */
  taskId: Uint8Array;
  /** Solana PDA address for the task account */
  taskPda: PublicKey;
  /** Parent task ID (null for root tasks) */
  parentTaskId: Uint8Array | null;
  /** Set of child task IDs (hex-encoded for Set efficiency) */
  children: Set<string>;
  /** Current status in speculation lifecycle */
  status: DependencyStatus;
  /** Speculation depth (0 = no unconfirmed ancestors) */
  depth: number;
  /** Node creation timestamp (Unix ms) */
  createdAt: number;
  /** Confirmation timestamp (null if not confirmed) */
  confirmedAt: number | null;
  /** Associated commitment ID if speculative */
  commitmentId: string | null;
}

/**
 * Result of adding a node to the graph
 */
export interface AddNodeResult {
  success: boolean;
  node?: DependencyNode;
  error?: string;
  depth?: number;
}

/**
 * Traversal result for topological operations
 */
export interface TraversalResult {
  /** Nodes in traversal order */
  nodes: DependencyNode[];
  /** Total speculation depth */
  maxDepth: number;
}
```

#### 4.1.2 Core Implementation

```typescript
import { bytesToHex, hexToBytes } from '../utils/encoding';

/**
 * Directed Acyclic Graph for tracking task dependencies
 * 
 * Supports O(1) parent/child lookups and O(n) topological traversal.
 * Thread-safe for concurrent reads; writes should be serialized.
 */
export class DependencyGraph {
  /** Map from hex-encoded taskId to DependencyNode */
  private nodes: Map<string, DependencyNode> = new Map();
  
  /** Map from parent taskId (hex) to set of child taskIds (hex) */
  private childIndex: Map<string, Set<string>> = new Map();
  
  /** Root nodes (tasks with no parent) */
  private roots: Set<string> = new Set();

  /**
   * Add a new task node to the graph
   * 
   * @param taskId - 32-byte task identifier
   * @param taskPda - Task account public key
   * @param parentTaskId - Parent task ID (null for root tasks)
   * @returns Result with success status and computed depth
   */
  addNode(
    taskId: Uint8Array,
    taskPda: PublicKey,
    parentTaskId: Uint8Array | null
  ): AddNodeResult {
    const taskIdHex = bytesToHex(taskId);
    
    // Check for duplicate
    if (this.nodes.has(taskIdHex)) {
      return { success: false, error: 'Task already exists in graph' };
    }
    
    // Validate parent exists if specified
    let parentNode: DependencyNode | undefined;
    let depth = 0;
    
    if (parentTaskId !== null) {
      const parentHex = bytesToHex(parentTaskId);
      parentNode = this.nodes.get(parentHex);
      
      if (!parentNode) {
        return { success: false, error: 'Parent task not found in graph' };
      }
      
      // Check for cycle (parent cannot be a descendant of this node)
      // Since we're adding a new node, this is always safe
      
      // Compute depth based on parent
      depth = this.computeDepth(parentNode);
    }
    
    // Create node
    const node: DependencyNode = {
      taskId,
      taskPda,
      parentTaskId,
      children: new Set(),
      status: DependencyStatus.Pending,
      depth,
      createdAt: Date.now(),
      confirmedAt: null,
      commitmentId: null,
    };
    
    // Add to graph
    this.nodes.set(taskIdHex, node);
    
    // Update parent's children
    if (parentTaskId !== null) {
      const parentHex = bytesToHex(parentTaskId);
      parentNode!.children.add(taskIdHex);
      
      // Update child index
      if (!this.childIndex.has(parentHex)) {
        this.childIndex.set(parentHex, new Set());
      }
      this.childIndex.get(parentHex)!.add(taskIdHex);
    } else {
      this.roots.add(taskIdHex);
    }
    
    return { success: true, node, depth };
  }

  /**
   * Compute speculation depth for a node
   * Depth = number of unconfirmed ancestors in the path to root
   */
  private computeDepth(node: DependencyNode): number {
    let depth = 0;
    let current: DependencyNode | undefined = node;
    
    while (current !== undefined) {
      if (current.status !== DependencyStatus.Confirmed) {
        depth++;
      }
      
      if (current.parentTaskId === null) {
        break;
      }
      
      current = this.nodes.get(bytesToHex(current.parentTaskId));
    }
    
    return depth;
  }

  /**
   * Get a node by task ID
   */
  getNode(taskId: Uint8Array): DependencyNode | undefined {
    return this.nodes.get(bytesToHex(taskId));
  }

  /**
   * Mark a node as confirmed and update descendant depths
   */
  markConfirmed(taskId: Uint8Array): boolean {
    const taskIdHex = bytesToHex(taskId);
    const node = this.nodes.get(taskIdHex);
    
    if (!node) {
      return false;
    }
    
    node.status = DependencyStatus.Confirmed;
    node.confirmedAt = Date.now();
    
    // Update depths of all descendants
    this.updateDescendantDepths(taskIdHex);
    
    return true;
  }

  /**
   * Mark a node as failed
   */
  markFailed(taskId: Uint8Array): boolean {
    const taskIdHex = bytesToHex(taskId);
    const node = this.nodes.get(taskIdHex);
    
    if (!node) {
      return false;
    }
    
    node.status = DependencyStatus.Failed;
    return true;
  }

  /**
   * Get all descendants of a task in reverse topological order (leaves first)
   * Used for rollback operations
   */
  getDescendantsReverseTopological(taskId: Uint8Array): DependencyNode[] {
    const taskIdHex = bytesToHex(taskId);
    const result: DependencyNode[] = [];
    const visited = new Set<string>();
    
    // DFS to collect descendants
    const collectDescendants = (nodeHex: string) => {
      if (visited.has(nodeHex)) return;
      visited.add(nodeHex);
      
      const node = this.nodes.get(nodeHex);
      if (!node) return;
      
      // Visit children first (leaves will be added first)
      for (const childHex of node.children) {
        collectDescendants(childHex);
      }
      
      // Add this node after all descendants
      if (nodeHex !== taskIdHex) {  // Don't include the trigger node
        result.push(node);
      }
    };
    
    // Start from the failed node's children
    const failedNode = this.nodes.get(taskIdHex);
    if (failedNode) {
      for (const childHex of failedNode.children) {
        collectDescendants(childHex);
      }
    }
    
    return result;
  }

  /**
   * Get ancestors of a task from immediate parent to root
   */
  getAncestors(taskId: Uint8Array): DependencyNode[] {
    const ancestors: DependencyNode[] = [];
    let current = this.nodes.get(bytesToHex(taskId));
    
    while (current && current.parentTaskId !== null) {
      const parent = this.nodes.get(bytesToHex(current.parentTaskId));
      if (parent) {
        ancestors.push(parent);
        current = parent;
      } else {
        break;
      }
    }
    
    return ancestors;
  }

  /**
   * Get unconfirmed ancestors (for proof deferral)
   */
  getUnconfirmedAncestors(taskId: Uint8Array): DependencyNode[] {
    return this.getAncestors(taskId).filter(
      (node) => node.status !== DependencyStatus.Confirmed
    );
  }

  /**
   * Check if adding a dependency would create a cycle
   */
  wouldCreateCycle(childId: Uint8Array, parentId: Uint8Array): boolean {
    // If parent is a descendant of child, adding child→parent creates cycle
    const childHex = bytesToHex(childId);
    const parentHex = bytesToHex(parentId);
    
    const visited = new Set<string>();
    const stack = [parentHex];
    
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === childHex) {
        return true;  // Found cycle
      }
      
      if (visited.has(current)) continue;
      visited.add(current);
      
      const node = this.nodes.get(current);
      if (node?.parentTaskId) {
        stack.push(bytesToHex(node.parentTaskId));
      }
    }
    
    return false;
  }

  /**
   * Remove a node and all its descendants
   */
  removeSubtree(taskId: Uint8Array): number {
    const taskIdHex = bytesToHex(taskId);
    const descendants = this.getDescendantsReverseTopological(taskId);
    
    // Remove descendants first (leaves to root)
    for (const desc of descendants) {
      const descHex = bytesToHex(desc.taskId);
      this.nodes.delete(descHex);
      this.roots.delete(descHex);
      
      // Clean up child index
      if (desc.parentTaskId) {
        const parentHex = bytesToHex(desc.parentTaskId);
        this.childIndex.get(parentHex)?.delete(descHex);
      }
    }
    
    // Remove the root of subtree
    const node = this.nodes.get(taskIdHex);
    if (node) {
      if (node.parentTaskId) {
        const parentHex = bytesToHex(node.parentTaskId);
        const parent = this.nodes.get(parentHex);
        parent?.children.delete(taskIdHex);
        this.childIndex.get(parentHex)?.delete(taskIdHex);
      }
      this.nodes.delete(taskIdHex);
      this.roots.delete(taskIdHex);
    }
    
    return descendants.length + 1;
  }

  /**
   * Update depths for all descendants after a node is confirmed
   */
  private updateDescendantDepths(confirmedNodeHex: string): void {
    const queue = [...(this.childIndex.get(confirmedNodeHex) || [])];
    
    while (queue.length > 0) {
      const childHex = queue.shift()!;
      const child = this.nodes.get(childHex);
      
      if (child && child.status !== DependencyStatus.Confirmed) {
        // Recompute depth
        child.depth = this.computeDepth(child);
        
        // Process grandchildren
        for (const grandchildHex of child.children) {
          queue.push(grandchildHex);
        }
      }
    }
  }

  /**
   * Get statistics about the graph
   */
  getStats(): {
    totalNodes: number;
    rootNodes: number;
    maxDepth: number;
    byStatus: Record<DependencyStatus, number>;
  } {
    const byStatus: Record<DependencyStatus, number> = {
      [DependencyStatus.Pending]: 0,
      [DependencyStatus.Speculative]: 0,
      [DependencyStatus.Confirmed]: 0,
      [DependencyStatus.Failed]: 0,
    };
    
    let maxDepth = 0;
    
    for (const node of this.nodes.values()) {
      byStatus[node.status]++;
      maxDepth = Math.max(maxDepth, node.depth);
    }
    
    return {
      totalNodes: this.nodes.size,
      rootNodes: this.roots.size,
      maxDepth,
      byStatus,
    };
  }
}
```

### 4.2 CommitmentLedger

**File**: `runtime/src/speculation/commitment-ledger.ts`  
**Issue**: [#266](https://github.com/tetsuo-ai/AgenC/issues/266)

#### 4.2.1 Type Definitions

```typescript
/**
 * Status of a speculative commitment
 */
export enum CommitmentStatus {
  /** Commitment created locally */
  Created = 'created',
  /** Proof has been generated */
  ProofGenerated = 'proof_generated',
  /** Proof submitted to chain */
  Submitted = 'submitted',
  /** On-chain confirmation received */
  Confirmed = 'confirmed',
  /** Proof rejected by verifier */
  Failed = 'failed',
  /** TTL exceeded before confirmation */
  Expired = 'expired',
  /** Rolled back due to ancestor failure */
  RolledBack = 'rolled_back',
}

/**
 * A speculative commitment record
 */
export interface SpeculativeCommitment {
  /** Unique commitment ID (hex string) */
  id: string;
  /** 32-byte task identifier */
  taskId: Uint8Array;
  /** Task PDA address */
  taskPda: PublicKey;
  /** SHA-256(constraintHash, salt) */
  outputCommitment: Uint8Array;
  /** SHA-256(output) - matches task's constraint_hash */
  constraintHash: Uint8Array;
  /** Randomness for commitment hiding */
  salt: bigint;
  /** Current status */
  status: CommitmentStatus;
  /** Number of unconfirmed ancestors when created */
  speculationDepth: number;
  /** Creation timestamp */
  createdAt: number;
  /** Expiration timestamp (createdAt + TTL) */
  expiresAt: number;
  /** Generated private payload bundle for complete_task_private */
  privatePayload: Risc0PrivatePayload | null;
  /** Bonded stake in lamports */
  bondedStake: bigint;
  /** Transaction signature if submitted */
  submissionTx: string | null;
  /** Error message if failed */
  error: string | null;
}

/**
 * Options for creating a commitment
 */
export interface CreateCommitmentOptions {
  taskId: Uint8Array;
  taskPda: PublicKey;
  outputCommitment: Uint8Array;
  constraintHash: Uint8Array;
  salt: bigint;
  speculationDepth: number;
  ttlMs?: number;
  bondedStake?: bigint;
}

/**
 * Query options for listing commitments
 */
export interface CommitmentQueryOptions {
  status?: CommitmentStatus[];
  minDepth?: number;
  maxDepth?: number;
  beforeExpiry?: number;
  limit?: number;
}
```

#### 4.2.2 Core Implementation

```typescript
import { randomBytes } from 'crypto';

/**
 * Local registry for speculative task commitments
 * 
 * Provides atomic operations for commitment lifecycle management.
 * Supports persistence via snapshot/restore for crash recovery.
 */
export class CommitmentLedger {
  /** Map from commitment ID to commitment */
  private commitments: Map<string, SpeculativeCommitment> = new Map();
  
  /** Index from taskId (hex) to commitment ID */
  private taskIndex: Map<string, string> = new Map();
  
  /** Index from outputCommitment (hex) to commitment ID */
  private outputIndex: Map<string, string> = new Map();
  
  /** Default TTL for commitments (5 minutes) */
  private defaultTtlMs: number = 5 * 60 * 1000;
  
  /** Expiration check interval handle */
  private expirationTimer: NodeJS.Timeout | null = null;

  constructor(options?: { defaultTtlMs?: number }) {
    if (options?.defaultTtlMs) {
      this.defaultTtlMs = options.defaultTtlMs;
    }
  }

  /**
   * Create a new speculative commitment
   */
  create(options: CreateCommitmentOptions): SpeculativeCommitment {
    const taskIdHex = bytesToHex(options.taskId);
    
    // Check for existing commitment for this task
    if (this.taskIndex.has(taskIdHex)) {
      throw new Error(`Commitment already exists for task ${taskIdHex}`);
    }
    
    // Generate unique commitment ID
    const id = bytesToHex(randomBytes(16));
    const now = Date.now();
    
    const commitment: SpeculativeCommitment = {
      id,
      taskId: options.taskId,
      taskPda: options.taskPda,
      outputCommitment: options.outputCommitment,
      constraintHash: options.constraintHash,
      salt: options.salt,
      status: CommitmentStatus.Created,
      speculationDepth: options.speculationDepth,
      createdAt: now,
      expiresAt: now + (options.ttlMs ?? this.defaultTtlMs),
      privatePayload: null,
      bondedStake: options.bondedStake ?? 0n,
      submissionTx: null,
      error: null,
    };
    
    // Store commitment
    this.commitments.set(id, commitment);
    this.taskIndex.set(taskIdHex, id);
    this.outputIndex.set(bytesToHex(options.outputCommitment), id);
    
    return commitment;
  }

  /**
   * Get commitment by ID
   */
  get(id: string): SpeculativeCommitment | undefined {
    return this.commitments.get(id);
  }

  /**
   * Get commitment by task ID
   */
  getByTaskId(taskId: Uint8Array): SpeculativeCommitment | undefined {
    const taskIdHex = bytesToHex(taskId);
    const id = this.taskIndex.get(taskIdHex);
    return id ? this.commitments.get(id) : undefined;
  }

  /**
   * Get commitment by output commitment hash
   */
  getByOutputCommitment(outputCommitment: Uint8Array): SpeculativeCommitment | undefined {
    const outputHex = bytesToHex(outputCommitment);
    const id = this.outputIndex.get(outputHex);
    return id ? this.commitments.get(id) : undefined;
  }

  /**
   * Update commitment with generated proof
   */
  setProof(id: string, privatePayload: Risc0PrivatePayload): boolean {
    const commitment = this.commitments.get(id);
    if (!commitment) return false;
    
    if (
      privatePayload.sealBytes.length !== 260
      || privatePayload.journal.length !== 192
      || privatePayload.imageId.length !== 32
      || privatePayload.bindingSeed.length !== 32
      || privatePayload.nullifierSeed.length !== 32
    ) {
      throw new Error('Invalid private payload shape for complete_task_private');
    }

    commitment.privatePayload = privatePayload;
    commitment.status = CommitmentStatus.ProofGenerated;
    return true;
  }

  /**
   * Mark commitment as submitted to chain
   */
  markSubmitted(id: string, txSignature: string): boolean {
    const commitment = this.commitments.get(id);
    if (!commitment) return false;
    
    commitment.status = CommitmentStatus.Submitted;
    commitment.submissionTx = txSignature;
    return true;
  }

  /**
   * Mark commitment as confirmed on-chain
   */
  markConfirmed(id: string): boolean {
    const commitment = this.commitments.get(id);
    if (!commitment) return false;
    
    commitment.status = CommitmentStatus.Confirmed;
    return true;
  }

  /**
   * Mark commitment as failed
   */
  markFailed(id: string, error: string): boolean {
    const commitment = this.commitments.get(id);
    if (!commitment) return false;
    
    commitment.status = CommitmentStatus.Failed;
    commitment.error = error;
    return true;
  }

  /**
   * Mark commitment as rolled back (cascade failure)
   */
  markRolledBack(id: string, reason: string): boolean {
    const commitment = this.commitments.get(id);
    if (!commitment) return false;
    
    commitment.status = CommitmentStatus.RolledBack;
    commitment.error = `Rolled back: ${reason}`;
    return true;
  }

  /**
   * Query commitments with filters
   */
  query(options: CommitmentQueryOptions): SpeculativeCommitment[] {
    let results: SpeculativeCommitment[] = [];
    
    for (const commitment of this.commitments.values()) {
      // Filter by status
      if (options.status && !options.status.includes(commitment.status)) {
        continue;
      }
      
      // Filter by depth
      if (options.minDepth !== undefined && commitment.speculationDepth < options.minDepth) {
        continue;
      }
      if (options.maxDepth !== undefined && commitment.speculationDepth > options.maxDepth) {
        continue;
      }
      
      // Filter by expiry
      if (options.beforeExpiry !== undefined && commitment.expiresAt >= options.beforeExpiry) {
        continue;
      }
      
      results.push(commitment);
    }
    
    // Apply limit
    if (options.limit !== undefined) {
      results = results.slice(0, options.limit);
    }
    
    return results;
  }

  /**
   * Check for and mark expired commitments
   */
  checkExpirations(): SpeculativeCommitment[] {
    const now = Date.now();
    const expired: SpeculativeCommitment[] = [];
    
    for (const commitment of this.commitments.values()) {
      if (
        commitment.status !== CommitmentStatus.Confirmed &&
        commitment.status !== CommitmentStatus.Failed &&
        commitment.status !== CommitmentStatus.Expired &&
        commitment.status !== CommitmentStatus.RolledBack &&
        commitment.expiresAt <= now
      ) {
        commitment.status = CommitmentStatus.Expired;
        commitment.error = 'TTL exceeded';
        expired.push(commitment);
      }
    }
    
    return expired;
  }

  /**
   * Start periodic expiration checking
   */
  startExpirationChecker(intervalMs: number = 10000): void {
    if (this.expirationTimer) {
      clearInterval(this.expirationTimer);
    }
    
    this.expirationTimer = setInterval(() => {
      this.checkExpirations();
    }, intervalMs);
  }

  /**
   * Stop expiration checker
   */
  stopExpirationChecker(): void {
    if (this.expirationTimer) {
      clearInterval(this.expirationTimer);
      this.expirationTimer = null;
    }
  }

  /**
   * Create a snapshot for persistence
   */
  snapshot(): string {
    const data = {
      commitments: Array.from(this.commitments.entries()).map(([id, c]) => ({
        ...c,
        taskId: bytesToHex(c.taskId),
        outputCommitment: bytesToHex(c.outputCommitment),
        constraintHash: bytesToHex(c.constraintHash),
        salt: c.salt.toString(),
        privatePayload: c.privatePayload
          ? {
              sealBytes: bytesToHex(c.privatePayload.sealBytes),
              journal: bytesToHex(c.privatePayload.journal),
              imageId: bytesToHex(c.privatePayload.imageId),
              bindingSeed: bytesToHex(c.privatePayload.bindingSeed),
              nullifierSeed: bytesToHex(c.privatePayload.nullifierSeed),
            }
          : null,
        bondedStake: c.bondedStake.toString(),
        taskPda: c.taskPda.toBase58(),
      })),
    };
    return JSON.stringify(data);
  }

  /**
   * Restore from snapshot
   */
  restore(snapshotJson: string): void {
    const data = JSON.parse(snapshotJson);
    
    this.commitments.clear();
    this.taskIndex.clear();
    this.outputIndex.clear();
    
    for (const item of data.commitments) {
      const commitment: SpeculativeCommitment = {
        ...item,
        taskId: hexToBytes(item.taskId),
        outputCommitment: hexToBytes(item.outputCommitment),
        constraintHash: hexToBytes(item.constraintHash),
        salt: BigInt(item.salt),
        privatePayload: item.privatePayload
          ? {
              sealBytes: hexToBytes(item.privatePayload.sealBytes),
              journal: hexToBytes(item.privatePayload.journal),
              imageId: hexToBytes(item.privatePayload.imageId),
              bindingSeed: hexToBytes(item.privatePayload.bindingSeed),
              nullifierSeed: hexToBytes(item.privatePayload.nullifierSeed),
            }
          : null,
        bondedStake: BigInt(item.bondedStake),
        taskPda: new PublicKey(item.taskPda),
      };
      
      this.commitments.set(commitment.id, commitment);
      this.taskIndex.set(bytesToHex(commitment.taskId), commitment.id);
      this.outputIndex.set(bytesToHex(commitment.outputCommitment), commitment.id);
    }
  }

  /**
   * Get ledger statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<CommitmentStatus, number>;
    totalBondedStake: bigint;
    avgDepth: number;
  } {
    const byStatus: Record<CommitmentStatus, number> = {
      [CommitmentStatus.Created]: 0,
      [CommitmentStatus.ProofGenerated]: 0,
      [CommitmentStatus.Submitted]: 0,
      [CommitmentStatus.Confirmed]: 0,
      [CommitmentStatus.Failed]: 0,
      [CommitmentStatus.Expired]: 0,
      [CommitmentStatus.RolledBack]: 0,
    };
    
    let totalBondedStake = 0n;
    let totalDepth = 0;
    
    for (const c of this.commitments.values()) {
      byStatus[c.status]++;
      totalBondedStake += c.bondedStake;
      totalDepth += c.speculationDepth;
    }
    
    return {
      total: this.commitments.size,
      byStatus,
      totalBondedStake,
      avgDepth: this.commitments.size > 0 ? totalDepth / this.commitments.size : 0,
    };
  }
}
```

### 4.3 ProofDeferralManager

**File**: `runtime/src/speculation/proof-deferral-manager.ts`  
**Issue**: [#264](https://github.com/tetsuo-ai/AgenC/issues/264)

#### 4.3.1 Type Definitions

```typescript
/**
 * Status of a deferred proof
 */
export enum DeferralStatus {
  /** Waiting for ancestors to confirm */
  Waiting = 'waiting',
  /** All ancestors confirmed, ready to submit */
  Ready = 'ready',
  /** Submission in progress */
  Submitting = 'submitting',
  /** Proof confirmed on-chain */
  Confirmed = 'confirmed',
  /** Proof submission failed */
  Failed = 'failed',
  /** Cancelled due to rollback */
  Cancelled = 'cancelled',
}

/**
 * A proof awaiting submission
 */
export interface DeferredProof {
  /** Unique identifier */
  id: string;
  /** Task identifier */
  taskId: Uint8Array;
  /** Task PDA */
  taskPda: PublicKey;
  /** Commitment ID in ledger */
  commitmentId: string;
  /** 388-byte Groth16 proof */
  proof: Uint8Array;
  /** Proof public inputs (journal fields) */
  publicInputs: bigint[];
  /** Ancestor task IDs that must confirm first */
  ancestors: Uint8Array[];
  /** Ancestors still pending (hex-encoded) */
  pendingAncestors: Set<string>;
  /** Current status */
  status: DeferralStatus;
  /** Queue timestamp */
  queuedAt: number;
  /** Submission attempts */
  attempts: number;
  /** Last attempt timestamp */
  lastAttemptAt: number | null;
  /** Error message if failed */
  error: string | null;
  /** Priority (lower = higher priority) */
  priority: number;
}

/**
 * Options for enqueueing a proof
 */
export interface EnqueueProofOptions {
  taskId: Uint8Array;
  taskPda: PublicKey;
  commitmentId: string;
  proof: Uint8Array;
  publicInputs: bigint[];
  ancestors: Uint8Array[];
  priority?: number;
}

/**
 * Callback for proof submission
 */
export type ProofSubmitter = (
  taskPda: PublicKey,
  proof: Uint8Array,
  publicInputs: bigint[]
) => Promise<string>;  // Returns transaction signature
```

#### 4.3.2 Core Implementation

```typescript
import { EventEmitter } from 'events';

/**
 * Events emitted by ProofDeferralManager
 */
export interface ProofDeferralEvents {
  'proof:ready': (proof: DeferredProof) => void;
  'proof:submitted': (proof: DeferredProof, txSig: string) => void;
  'proof:confirmed': (proof: DeferredProof) => void;
  'proof:failed': (proof: DeferredProof, error: Error) => void;
  'ancestor:confirmed': (ancestorTaskId: Uint8Array, unblocked: DeferredProof[]) => void;
}

/**
 * Manages proof submission ordering to maintain the proof ordering invariant:
 * A task's proof can ONLY be submitted when ALL ancestor commitments are CONFIRMED.
 */
export class ProofDeferralManager extends EventEmitter {
  /** Map from proof ID to DeferredProof */
  private proofs: Map<string, DeferredProof> = new Map();
  
  /** Index from taskId (hex) to proof ID */
  private taskIndex: Map<string, string> = new Map();
  
  /** Index from ancestor taskId (hex) to set of waiting proof IDs */
  private waitingForAncestor: Map<string, Set<string>> = new Map();
  
  /** Queue of ready proofs (by priority) */
  private readyQueue: string[] = [];
  
  /** Maximum concurrent submissions */
  private maxConcurrent: number;
  
  /** Currently submitting */
  private submitting: Set<string> = new Set();
  
  /** Proof submitter callback */
  private submitter: ProofSubmitter | null = null;
  
  /** Maximum retry attempts */
  private maxRetries: number;
  
  /** Retry delay base (ms) */
  private retryDelayMs: number;

  constructor(options?: {
    maxConcurrent?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  }) {
    super();
    this.maxConcurrent = options?.maxConcurrent ?? 5;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
  }

  /**
   * Set the proof submitter callback
   */
  setSubmitter(submitter: ProofSubmitter): void {
    this.submitter = submitter;
  }

  /**
   * Enqueue a proof for deferred submission
   */
  enqueue(options: EnqueueProofOptions): DeferredProof {
    const taskIdHex = bytesToHex(options.taskId);
    
    if (this.taskIndex.has(taskIdHex)) {
      throw new Error(`Proof already queued for task ${taskIdHex}`);
    }
    
    const id = bytesToHex(randomBytes(16));
    const pendingAncestors = new Set(options.ancestors.map(bytesToHex));
    
    const proof: DeferredProof = {
      id,
      taskId: options.taskId,
      taskPda: options.taskPda,
      commitmentId: options.commitmentId,
      proof: options.proof,
      publicInputs: options.publicInputs,
      ancestors: options.ancestors,
      pendingAncestors,
      status: pendingAncestors.size === 0 ? DeferralStatus.Ready : DeferralStatus.Waiting,
      queuedAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      error: null,
      priority: options.priority ?? 0,
    };
    
    // Store proof
    this.proofs.set(id, proof);
    this.taskIndex.set(taskIdHex, id);
    
    // Index by ancestors
    for (const ancestorHex of pendingAncestors) {
      if (!this.waitingForAncestor.has(ancestorHex)) {
        this.waitingForAncestor.set(ancestorHex, new Set());
      }
      this.waitingForAncestor.get(ancestorHex)!.add(id);
    }
    
    // If ready immediately, add to queue
    if (proof.status === DeferralStatus.Ready) {
      this.addToReadyQueue(proof);
      this.emit('proof:ready', proof);
    }
    
    return proof;
  }

  /**
   * Called when an ancestor task is confirmed on-chain
   */
  onAncestorConfirmed(ancestorTaskId: Uint8Array): DeferredProof[] {
    const ancestorHex = bytesToHex(ancestorTaskId);
    const waitingProofIds = this.waitingForAncestor.get(ancestorHex);
    
    if (!waitingProofIds || waitingProofIds.size === 0) {
      return [];
    }
    
    const unblocked: DeferredProof[] = [];
    
    for (const proofId of waitingProofIds) {
      const proof = this.proofs.get(proofId);
      if (!proof || proof.status !== DeferralStatus.Waiting) {
        continue;
      }
      
      // Remove this ancestor from pending
      proof.pendingAncestors.delete(ancestorHex);
      
      // If no more pending ancestors, mark ready
      if (proof.pendingAncestors.size === 0) {
        proof.status = DeferralStatus.Ready;
        this.addToReadyQueue(proof);
        unblocked.push(proof);
        this.emit('proof:ready', proof);
      }
    }
    
    // Clean up index
    this.waitingForAncestor.delete(ancestorHex);
    
    if (unblocked.length > 0) {
      this.emit('ancestor:confirmed', ancestorTaskId, unblocked);
    }
    
    // Trigger submission processing
    this.processReadyQueue();
    
    return unblocked;
  }

  /**
   * Cancel all proofs waiting on a failed ancestor (for rollback)
   */
  cancelForAncestor(ancestorTaskId: Uint8Array): DeferredProof[] {
    const ancestorHex = bytesToHex(ancestorTaskId);
    const cancelled: DeferredProof[] = [];
    
    // Cancel proofs waiting on this ancestor
    const waitingProofIds = this.waitingForAncestor.get(ancestorHex);
    if (waitingProofIds) {
      for (const proofId of waitingProofIds) {
        const proof = this.proofs.get(proofId);
        if (proof && proof.status === DeferralStatus.Waiting) {
          proof.status = DeferralStatus.Cancelled;
          proof.error = `Ancestor ${ancestorHex.slice(0, 16)}... failed`;
          cancelled.push(proof);
        }
      }
      this.waitingForAncestor.delete(ancestorHex);
    }
    
    // Also cancel the failed ancestor's own proof if queued
    const ancestorProofId = this.taskIndex.get(ancestorHex);
    if (ancestorProofId) {
      const proof = this.proofs.get(ancestorProofId);
      if (proof && proof.status !== DeferralStatus.Confirmed) {
        proof.status = DeferralStatus.Cancelled;
        proof.error = 'Proof failed';
        cancelled.push(proof);
      }
    }
    
    return cancelled;
  }

  /**
   * Add proof to ready queue (sorted by priority)
   */
  private addToReadyQueue(proof: DeferredProof): void {
    // Insert in priority order (lower priority value = higher priority)
    let inserted = false;
    for (let i = 0; i < this.readyQueue.length; i++) {
      const existing = this.proofs.get(this.readyQueue[i]);
      if (existing && proof.priority < existing.priority) {
        this.readyQueue.splice(i, 0, proof.id);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.readyQueue.push(proof.id);
    }
  }

  /**
   * Process ready queue and submit proofs
   */
  async processReadyQueue(): Promise<void> {
    if (!this.submitter) {
      return;
    }
    
    while (
      this.readyQueue.length > 0 &&
      this.submitting.size < this.maxConcurrent
    ) {
      const proofId = this.readyQueue.shift()!;
      const proof = this.proofs.get(proofId);
      
      if (!proof || proof.status !== DeferralStatus.Ready) {
        continue;
      }
      
      // Submit asynchronously
      this.submitProof(proof);
    }
  }

  /**
   * Submit a single proof
   */
  private async submitProof(proof: DeferredProof): Promise<void> {
    proof.status = DeferralStatus.Submitting;
    proof.attempts++;
    proof.lastAttemptAt = Date.now();
    this.submitting.add(proof.id);
    
    try {
      const txSig = await this.submitter!(
        proof.taskPda,
        proof.proof,
        proof.publicInputs
      );
      
      proof.status = DeferralStatus.Confirmed;
      this.emit('proof:submitted', proof, txSig);
      this.emit('proof:confirmed', proof);
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      if (proof.attempts < this.maxRetries) {
        // Retry with exponential backoff
        proof.status = DeferralStatus.Ready;
        proof.error = `Attempt ${proof.attempts} failed: ${err.message}`;
        
        setTimeout(() => {
          if (proof.status === DeferralStatus.Ready) {
            this.addToReadyQueue(proof);
            this.processReadyQueue();
          }
        }, this.retryDelayMs * Math.pow(2, proof.attempts - 1));
        
      } else {
        proof.status = DeferralStatus.Failed;
        proof.error = `All ${this.maxRetries} attempts failed: ${err.message}`;
        this.emit('proof:failed', proof, err);
      }
    } finally {
      this.submitting.delete(proof.id);
    }
  }

  /**
   * Get proof by ID
   */
  get(id: string): DeferredProof | undefined {
    return this.proofs.get(id);
  }

  /**
   * Get proof by task ID
   */
  getByTaskId(taskId: Uint8Array): DeferredProof | undefined {
    const taskIdHex = bytesToHex(taskId);
    const id = this.taskIndex.get(taskIdHex);
    return id ? this.proofs.get(id) : undefined;
  }

  /**
   * Get manager statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<DeferralStatus, number>;
    readyQueueLength: number;
    activeSubmissions: number;
  } {
    const byStatus: Record<DeferralStatus, number> = {
      [DeferralStatus.Waiting]: 0,
      [DeferralStatus.Ready]: 0,
      [DeferralStatus.Submitting]: 0,
      [DeferralStatus.Confirmed]: 0,
      [DeferralStatus.Failed]: 0,
      [DeferralStatus.Cancelled]: 0,
    };
    
    for (const proof of this.proofs.values()) {
      byStatus[proof.status]++;
    }
    
    return {
      total: this.proofs.size,
      byStatus,
      readyQueueLength: this.readyQueue.length,
      activeSubmissions: this.submitting.size,
    };
  }
}
```

### 4.4 RollbackController

**File**: `runtime/src/speculation/rollback-controller.ts`  
**Issue**: [#269](https://github.com/tetsuo-ai/AgenC/issues/269)

#### 4.4.1 Type Definitions

```typescript
/**
 * Reason for triggering a rollback
 */
export enum RollbackReason {
  /** Proof verification failed on-chain */
  ProofFailed = 'proof_failed',
  /** Proof generation timed out */
  ProofTimeout = 'proof_timeout',
  /** Ancestor task's proof failed */
  AncestorFailed = 'ancestor_failed',
  /** Task claim expired before completion */
  ClaimExpired = 'claim_expired',
  /** Manual cancellation requested */
  ManualCancel = 'manual_cancel',
  /** Commitment TTL expired */
  CommitmentExpired = 'commitment_expired',
}

/**
 * Status of a rollback operation
 */
export enum RollbackStatus {
  /** Rollback plan created */
  Planned = 'planned',
  /** Rollback in progress */
  Executing = 'executing',
  /** Rollback completed */
  Completed = 'completed',
  /** Rollback failed (partial) */
  Failed = 'failed',
}

/**
 * A task affected by rollback
 */
export interface AffectedTask {
  taskId: Uint8Array;
  commitmentId: string;
  bondedStake: bigint;
  status: 'pending' | 'rolledBack' | 'failed';
  error?: string;
}

/**
 * A rollback execution plan
 */
export interface RollbackPlan {
  /** Unique plan ID */
  id: string;
  /** Task that triggered the rollback */
  triggerTaskId: Uint8Array;
  /** Reason for rollback */
  triggerReason: RollbackReason;
  /** Tasks to roll back (reverse topological order) */
  affectedTasks: AffectedTask[];
  /** Total stake bonded across all affected tasks */
  totalBondedStake: bigint;
  /** Amount to slash (depends on reason) */
  slashAmount: bigint;
  /** Plan creation time */
  createdAt: number;
  /** Execution completion time */
  executedAt: number | null;
  /** Current status */
  status: RollbackStatus;
  /** Error if failed */
  error: string | null;
}

/**
 * Callback for stake slashing
 */
export type SlashCallback = (
  agentPda: PublicKey,
  amount: bigint,
  reason: RollbackReason
) => Promise<void>;

/**
 * Configuration for rollback behavior
 */
export interface RollbackConfig {
  /** Slash percentage (0-100) for different reasons */
  slashPercentage: Record<RollbackReason, number>;
  /** Whether to continue on individual task rollback failure */
  continueOnError: boolean;
  /** Callback for stake slashing */
  slashCallback?: SlashCallback;
}
```

#### 4.4.2 Core Implementation

```typescript
import { EventEmitter } from 'events';

/**
 * Events emitted by RollbackController
 */
export interface RollbackEvents {
  'rollback:planned': (plan: RollbackPlan) => void;
  'rollback:executing': (plan: RollbackPlan) => void;
  'rollback:taskRolledBack': (plan: RollbackPlan, task: AffectedTask) => void;
  'rollback:completed': (plan: RollbackPlan) => void;
  'rollback:failed': (plan: RollbackPlan, error: Error) => void;
}

/**
 * Default slash percentages by reason
 */
const DEFAULT_SLASH_PERCENTAGES: Record<RollbackReason, number> = {
  [RollbackReason.ProofFailed]: 10,      // Invalid proof = 10% slash
  [RollbackReason.ProofTimeout]: 5,      // Timeout = 5% slash
  [RollbackReason.AncestorFailed]: 0,    // Cascade = no slash (not agent's fault)
  [RollbackReason.ClaimExpired]: 5,      // Expired claim = 5% slash
  [RollbackReason.ManualCancel]: 0,      // Manual = no slash
  [RollbackReason.CommitmentExpired]: 5, // TTL exceeded = 5% slash
};

/**
 * Controls cascade rollback of speculative executions
 * 
 * Invariant: Rollbacks execute in reverse topological order (leaves first).
 */
export class RollbackController extends EventEmitter {
  /** Completed rollback plans (for audit) */
  private history: Map<string, RollbackPlan> = new Map();
  
  /** Active rollback plan (only one at a time) */
  private activePlan: RollbackPlan | null = null;
  
  /** References to other components */
  private dependencyGraph: DependencyGraph;
  private commitmentLedger: CommitmentLedger;
  private proofDeferralManager: ProofDeferralManager;
  
  /** Configuration */
  private config: RollbackConfig;

  constructor(
    dependencyGraph: DependencyGraph,
    commitmentLedger: CommitmentLedger,
    proofDeferralManager: ProofDeferralManager,
    config?: Partial<RollbackConfig>
  ) {
    super();
    this.dependencyGraph = dependencyGraph;
    this.commitmentLedger = commitmentLedger;
    this.proofDeferralManager = proofDeferralManager;
    
    this.config = {
      slashPercentage: config?.slashPercentage ?? DEFAULT_SLASH_PERCENTAGES,
      continueOnError: config?.continueOnError ?? true,
      slashCallback: config?.slashCallback,
    };
  }

  /**
   * Trigger a rollback for a failed task and all its descendants
   */
  async triggerRollback(
    failedTaskId: Uint8Array,
    reason: RollbackReason
  ): Promise<RollbackPlan> {
    if (this.activePlan) {
      throw new Error('Rollback already in progress');
    }
    
    // Get all affected descendants in reverse topological order
    const descendants = this.dependencyGraph.getDescendantsReverseTopological(failedTaskId);
    
    // Build affected task list (including the trigger task)
    const affectedTasks: AffectedTask[] = [];
    let totalBondedStake = 0n;
    
    // Add descendants first (they'll be rolled back first)
    for (const node of descendants) {
      const commitment = this.commitmentLedger.getByTaskId(node.taskId);
      if (commitment) {
        affectedTasks.push({
          taskId: node.taskId,
          commitmentId: commitment.id,
          bondedStake: commitment.bondedStake,
          status: 'pending',
        });
        totalBondedStake += commitment.bondedStake;
      }
    }
    
    // Add the trigger task itself
    const triggerCommitment = this.commitmentLedger.getByTaskId(failedTaskId);
    if (triggerCommitment) {
      affectedTasks.push({
        taskId: failedTaskId,
        commitmentId: triggerCommitment.id,
        bondedStake: triggerCommitment.bondedStake,
        status: 'pending',
      });
      totalBondedStake += triggerCommitment.bondedStake;
    }
    
    // Calculate slash amount
    const slashPercentage = this.config.slashPercentage[reason];
    const slashAmount = (totalBondedStake * BigInt(slashPercentage)) / 100n;
    
    // Create plan
    const plan: RollbackPlan = {
      id: bytesToHex(randomBytes(16)),
      triggerTaskId: failedTaskId,
      triggerReason: reason,
      affectedTasks,
      totalBondedStake,
      slashAmount,
      createdAt: Date.now(),
      executedAt: null,
      status: RollbackStatus.Planned,
      error: null,
    };
    
    this.activePlan = plan;
    this.emit('rollback:planned', plan);
    
    // Execute the rollback
    await this.executeRollback(plan);
    
    return plan;
  }

  /**
   * Execute a rollback plan
   */
  private async executeRollback(plan: RollbackPlan): Promise<void> {
    plan.status = RollbackStatus.Executing;
    this.emit('rollback:executing', plan);
    
    let hasErrors = false;
    
    for (const affected of plan.affectedTasks) {
      try {
        // 1. Mark commitment as rolled back
        this.commitmentLedger.markRolledBack(
          affected.commitmentId,
          `Rollback due to ${plan.triggerReason}`
        );
        
        // 2. Cancel any pending proofs
        this.proofDeferralManager.cancelForAncestor(affected.taskId);
        
        // 3. Mark dependency node as failed
        this.dependencyGraph.markFailed(affected.taskId);
        
        affected.status = 'rolledBack';
        this.emit('rollback:taskRolledBack', plan, affected);
        
      } catch (error) {
        affected.status = 'failed';
        affected.error = error instanceof Error ? error.message : String(error);
        hasErrors = true;
        
        if (!this.config.continueOnError) {
          throw error;
        }
      }
    }
    
    // Apply slashing if configured
    if (plan.slashAmount > 0n && this.config.slashCallback) {
      try {
        // Slash would typically go to the agent who initiated the speculation
        // For now, we just record it
        // await this.config.slashCallback(agentPda, plan.slashAmount, plan.triggerReason);
      } catch (error) {
        // Log but don't fail rollback for slash failure
        console.error('Slash callback failed:', error);
      }
    }
    
    // Complete plan
    plan.executedAt = Date.now();
    plan.status = hasErrors ? RollbackStatus.Failed : RollbackStatus.Completed;
    
    // Archive and clear active
    this.history.set(plan.id, plan);
    this.activePlan = null;
    
    if (hasErrors) {
      plan.error = 'Some tasks failed to roll back';
      this.emit('rollback:failed', plan, new Error(plan.error));
    } else {
      this.emit('rollback:completed', plan);
    }
  }

  /**
   * Get active rollback plan
   */
  getActivePlan(): RollbackPlan | null {
    return this.activePlan;
  }

  /**
   * Get rollback history
   */
  getHistory(limit?: number): RollbackPlan[] {
    const plans = Array.from(this.history.values())
      .sort((a, b) => b.createdAt - a.createdAt);
    return limit ? plans.slice(0, limit) : plans;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalRollbacks: number;
    byReason: Record<RollbackReason, number>;
    totalSlashed: bigint;
    totalTasksRolledBack: number;
  } {
    const byReason: Record<RollbackReason, number> = {
      [RollbackReason.ProofFailed]: 0,
      [RollbackReason.ProofTimeout]: 0,
      [RollbackReason.AncestorFailed]: 0,
      [RollbackReason.ClaimExpired]: 0,
      [RollbackReason.ManualCancel]: 0,
      [RollbackReason.CommitmentExpired]: 0,
    };
    
    let totalSlashed = 0n;
    let totalTasksRolledBack = 0;
    
    for (const plan of this.history.values()) {
      byReason[plan.triggerReason]++;
      totalSlashed += plan.slashAmount;
      totalTasksRolledBack += plan.affectedTasks.filter(
        (t) => t.status === 'rolledBack'
      ).length;
    }
    
    return {
      totalRollbacks: this.history.size,
      byReason,
      totalSlashed,
      totalTasksRolledBack,
    };
  }
}
```

### 4.5 SpeculativeTaskScheduler

**File**: `runtime/src/speculation/speculative-task-scheduler.ts`  
**Issue**: [#271](https://github.com/tetsuo-ai/AgenC/issues/271)

#### 4.5.1 Core Implementation

```typescript
import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Result of scheduling a speculative task
 */
export interface ScheduleResult {
  /** Whether the task was accepted for speculation */
  accepted: boolean;
  /** Reason if rejected */
  reason?: string;
  /** Computed speculation depth */
  speculationDepth?: number;
  /** Required stake bond */
  requiredBond?: bigint;
  /** Commitment ID if created */
  commitmentId?: string;
}

/**
 * Events emitted by SpeculativeTaskScheduler
 */
export interface SchedulerEvents {
  'task:scheduled': (taskId: Uint8Array, depth: number) => void;
  'task:rejected': (taskId: Uint8Array, reason: string) => void;
  'task:executing': (taskId: Uint8Array) => void;
  'task:completed': (taskId: Uint8Array, commitmentId: string) => void;
  'task:confirmed': (taskId: Uint8Array) => void;
  'task:failed': (taskId: Uint8Array, error: Error) => void;
}

/**
 * Coordinates speculative task execution with safety bounds
 */
export class SpeculativeTaskScheduler extends EventEmitter {
  private dependencyGraph: DependencyGraph;
  private commitmentLedger: CommitmentLedger;
  private proofDeferralManager: ProofDeferralManager;
  private rollbackController: RollbackController;
  
  private config: SchedulerConfig;
  
  /** Currently executing tasks */
  private executing: Set<string> = new Set();
  
  /** Agent's available stake */
  private availableStake: bigint = 0n;
  
  /** Agent's locked stake */
  private lockedStake: bigint = 0n;

  constructor(
    dependencyGraph: DependencyGraph,
    commitmentLedger: CommitmentLedger,
    proofDeferralManager: ProofDeferralManager,
    rollbackController: RollbackController,
    config: Partial<SchedulerConfig> = {}
  ) {
    super();
    this.dependencyGraph = dependencyGraph;
    this.commitmentLedger = commitmentLedger;
    this.proofDeferralManager = proofDeferralManager;
    this.rollbackController = rollbackController;
    
    // Default configuration
    this.config = {
      maxDepth: config.maxDepth ?? 5,
      maxParallelBranches: config.maxParallelBranches ?? 4,
      minStake: config.minStake ?? 1_000_000n,  // 0.001 SOL
      stakePerDepth: config.stakePerDepth ?? 500_000n,  // 0.0005 SOL per depth
      claimBufferMs: config.claimBufferMs ?? 60_000,  // 1 minute
      proofTimeoutMs: config.proofTimeoutMs ?? 60_000,
      confirmationTimeoutMs: config.confirmationTimeoutMs ?? 30_000,
      rollbackPolicy: config.rollbackPolicy ?? 'cascade',
    };
    
    // Wire up event handlers
    this.setupEventHandlers();
  }

  /**
   * Set available stake for speculation
   */
  setAvailableStake(stake: bigint): void {
    this.availableStake = stake;
  }

  /**
   * Attempt to schedule a task for speculative execution
   */
  async schedule(request: ScheduleRequest): Promise<ScheduleResult> {
    const taskIdHex = bytesToHex(request.taskId);
    
    // 1. Check if already scheduled
    if (this.dependencyGraph.getNode(request.taskId)) {
      return {
        accepted: false,
        reason: 'Task already in dependency graph',
      };
    }
    
    // 2. Validate parent exists if specified
    let parentNode: DependencyNode | undefined;
    if (request.parentTaskId) {
      parentNode = this.dependencyGraph.getNode(request.parentTaskId);
      if (!parentNode) {
        return {
          accepted: false,
          reason: 'Parent task not found in dependency graph',
        };
      }
      
      // Check for cycles
      if (this.dependencyGraph.wouldCreateCycle(request.taskId, request.parentTaskId)) {
        return {
          accepted: false,
          reason: 'Adding dependency would create cycle',
        };
      }
    }
    
    // 3. Compute speculation depth
    let speculationDepth = 0;
    if (parentNode) {
      const unconfirmedAncestors = this.dependencyGraph.getUnconfirmedAncestors(
        request.parentTaskId!
      );
      speculationDepth = unconfirmedAncestors.length + 
        (parentNode.status !== DependencyStatus.Confirmed ? 1 : 0);
    }
    
    // 4. Check depth limit
    if (speculationDepth >= this.config.maxDepth) {
      this.emit('task:rejected', request.taskId, 'Max speculation depth exceeded');
      return {
        accepted: false,
        reason: `Speculation depth ${speculationDepth} exceeds max ${this.config.maxDepth}`,
        speculationDepth,
      };
    }
    
    // 5. Calculate required bond
    const requiredBond = this.config.minStake + 
      (this.config.stakePerDepth * BigInt(speculationDepth));
    
    // 6. Check stake availability
    if (this.availableStake - this.lockedStake < requiredBond) {
      this.emit('task:rejected', request.taskId, 'Insufficient stake');
      return {
        accepted: false,
        reason: `Required bond ${requiredBond} exceeds available stake`,
        speculationDepth,
        requiredBond,
      };
    }
    
    // 7. Check claim expiry buffer
    const now = Date.now();
    if (request.claimExpiresAt - now < this.config.claimBufferMs) {
      this.emit('task:rejected', request.taskId, 'Claim expiry too soon');
      return {
        accepted: false,
        reason: `Claim expires in ${request.claimExpiresAt - now}ms, need ${this.config.claimBufferMs}ms buffer`,
        speculationDepth,
      };
    }
    
    // 8. Check parallel branch limit
    const graphStats = this.dependencyGraph.getStats();
    if (graphStats.byStatus[DependencyStatus.Speculative] >= this.config.maxParallelBranches) {
      this.emit('task:rejected', request.taskId, 'Max parallel branches exceeded');
      return {
        accepted: false,
        reason: `${this.config.maxParallelBranches} parallel speculations already active`,
        speculationDepth,
      };
    }
    
    // 9. Add to dependency graph
    const addResult = this.dependencyGraph.addNode(
      request.taskId,
      request.taskPda,
      request.parentTaskId ?? null
    );
    
    if (!addResult.success) {
      return {
        accepted: false,
        reason: addResult.error,
      };
    }
    
    // 10. Lock stake
    this.lockedStake += requiredBond;
    
    this.emit('task:scheduled', request.taskId, speculationDepth);
    
    return {
      accepted: true,
      speculationDepth,
      requiredBond,
    };
  }

  /**
   * Record task execution completion with commitment
   */
  recordCompletion(
    taskId: Uint8Array,
    outputCommitment: Uint8Array,
    constraintHash: Uint8Array,
    salt: bigint,
    privatePayload: Risc0PrivatePayload
  ): string {
    const node = this.dependencyGraph.getNode(taskId);
    if (!node) {
      throw new Error('Task not found in dependency graph');
    }
    
    // Get required bond for this depth
    const requiredBond = this.config.minStake + 
      (this.config.stakePerDepth * BigInt(node.depth));
    
    // Create commitment
    const commitment = this.commitmentLedger.create({
      taskId,
      taskPda: node.taskPda,
      outputCommitment,
      constraintHash,
      salt,
      speculationDepth: node.depth,
      bondedStake: requiredBond,
    });
    
    // Add proof
    this.commitmentLedger.setProof(commitment.id, privatePayload);
    
    // Update node status
    node.status = DependencyStatus.Speculative;
    node.commitmentId = commitment.id;
    
    // Get unconfirmed ancestors for proof deferral
    const ancestors = this.dependencyGraph.getUnconfirmedAncestors(taskId);
    
    // Enqueue proof for deferred submission
    this.proofDeferralManager.enqueue({
      taskId,
      taskPda: node.taskPda,
      commitmentId: commitment.id,
      payload: privatePayload,
      publicInputs: [], // Would be populated by proof generator
      ancestors: ancestors.map((a) => a.taskId),
      priority: node.depth,  // Lower depth = higher priority
    });
    
    this.emit('task:completed', taskId, commitment.id);
    
    return commitment.id;
  }

  /**
   * Setup event handlers for component coordination
   */
  private setupEventHandlers(): void {
    // Handle proof confirmation
    this.proofDeferralManager.on('proof:confirmed', (proof: DeferredProof) => {
      // Mark as confirmed in dependency graph
      this.dependencyGraph.markConfirmed(proof.taskId);
      
      // Mark commitment as confirmed
      const commitment = this.commitmentLedger.get(proof.commitmentId);
      if (commitment) {
        this.commitmentLedger.markConfirmed(commitment.id);
        
        // Release locked stake
        this.lockedStake -= commitment.bondedStake;
      }
      
      this.emit('task:confirmed', proof.taskId);
    });
    
    // Handle proof failure
    this.proofDeferralManager.on('proof:failed', (proof: DeferredProof, error: Error) => {
      // Trigger rollback
      this.rollbackController.triggerRollback(
        proof.taskId,
        RollbackReason.ProofFailed
      );
      
      this.emit('task:failed', proof.taskId, error);
    });
    
    // Handle rollback completion
    this.rollbackController.on('rollback:completed', (plan: RollbackPlan) => {
      // Release stake for rolled-back tasks
      for (const affected of plan.affectedTasks) {
        if (affected.status === 'rolledBack') {
          this.lockedStake -= affected.bondedStake;
        }
      }
      
      // Apply slash
      this.availableStake -= plan.slashAmount;
    });
  }

  /**
   * Get scheduler statistics
   */
  getStats(): {
    availableStake: bigint;
    lockedStake: bigint;
    executingTasks: number;
    graphStats: ReturnType<DependencyGraph['getStats']>;
    ledgerStats: ReturnType<CommitmentLedger['getStats']>;
    deferralStats: ReturnType<ProofDeferralManager['getStats']>;
    rollbackStats: ReturnType<RollbackController['getStats']>;
  } {
    return {
      availableStake: this.availableStake,
      lockedStake: this.lockedStake,
      executingTasks: this.executing.size,
      graphStats: this.dependencyGraph.getStats(),
      ledgerStats: this.commitmentLedger.getStats(),
      deferralStats: this.proofDeferralManager.getStats(),
      rollbackStats: this.rollbackController.getStats(),
    };
  }

  /**
   * Get configuration
   */
  getConfig(): Readonly<SchedulerConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration (runtime tuning)
   */
  updateConfig(updates: Partial<SchedulerConfig>): void {
    Object.assign(this.config, updates);
  }
}
```

### 4.6 On-Chain Changes (Task struct, instructions)

**Issue**: [#259](https://github.com/tetsuo-ai/AgenC/issues/259), [#273](https://github.com/tetsuo-ai/AgenC/issues/273)

#### 4.6.1 Task Struct Extension

Add `depends_on` field to the Task account:

```rust
// programs/agenc-coordination/src/state.rs

/// Task account
/// PDA seeds: ["task", creator, task_id]
#[account]
#[derive(InitSpace)]
pub struct Task {
    // ... existing fields ...
    
    /// Parent task dependency (optional)
    /// When set, this task's proof cannot be submitted until parent's proof is confirmed.
    /// PDA of the parent task account (null bytes = no dependency)
    pub depends_on: Pubkey,
    
    /// Speculation depth at creation time
    /// 0 = no speculation (or root task)
    /// N = N unconfirmed ancestors in dependency chain
    pub speculation_depth: u8,
    
    // ... existing reserved field shrinks by 33 bytes ...
    pub _reserved: [u8; 0],  // Was [u8; 32]
}
```

**Migration Note**: Existing tasks have `depends_on = Pubkey::default()` (all zeros), indicating no dependency. This is backward-compatible.

#### 4.6.2 SpeculativeCommitment Account (Phase 2)

For cross-agent speculation, commitments can be recorded on-chain:

```rust
// programs/agenc-coordination/src/state.rs

/// On-chain record of a speculative commitment
/// PDA seeds: ["spec_commitment", task]
#[account]
pub struct SpeculativeCommitment {
    /// Task this commitment is for
    pub task: Pubkey,
    
    /// Agent who created the commitment
    pub agent: Pubkey,
    
    /// Output commitment (SHA-256(constraint_hash, salt))
    pub output_commitment: [u8; 32],
    
    /// Bonded stake in lamports
    pub bonded_stake: u64,
    
    /// Creation slot
    pub created_slot: u64,
    
    /// Expiration slot (created_slot + ttl_slots)
    pub expires_slot: u64,
    
    /// Whether the commitment has been resolved
    pub is_resolved: bool,
    
    /// Resolution: true = confirmed, false = slashed
    pub resolution: bool,
    
    /// Bump seed
    pub bump: u8,
}

impl SpeculativeCommitment {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // task
        32 + // agent
        32 + // output_commitment
        8 +  // bonded_stake
        8 +  // created_slot
        8 +  // expires_slot
        1 +  // is_resolved
        1 +  // resolution
        1;   // bump
}
```

#### 4.6.3 New Instructions

```rust
// programs/agenc-coordination/src/instructions/create_dependent_task.rs

/// Create a task that depends on another task
/// 
/// The parent task must exist and not be cancelled.
/// This task's proof cannot be submitted until parent's proof is confirmed.
#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateDependentTask<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    
    /// Creator's agent registration
    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        constraint = agent.authority == creator.key() @ CoordinationError::UnauthorizedAgent,
        constraint = agent.status == AgentStatus::Active @ CoordinationError::AgentNotActive,
    )]
    pub agent: Account<'info, AgentRegistration>,
    
    /// Parent task (must exist and not be cancelled)
    #[account(
        constraint = parent_task.status != TaskStatus::Cancelled @ CoordinationError::TaskCannotBeCancelled,
    )]
    pub parent_task: Account<'info, Task>,
    
    /// New task account
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump,
    )]
    pub task: Account<'info, Task>,
    
    /// Escrow for task reward
    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, TaskEscrow>,
    
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Account<'info, ProtocolConfig>,
    
    pub system_program: Program<'info, System>,
}

pub fn create_dependent_task(
    ctx: Context<CreateDependentTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    constraint_hash: [u8; 32],
    reward_amount: u64,
    deadline: i64,
    task_type: TaskType,
) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let parent = &ctx.accounts.parent_task;
    let clock = Clock::get()?;
    
    // Calculate speculation depth
    let speculation_depth = parent.speculation_depth
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    
    // Initialize task with dependency
    task.task_id = task_id;
    task.creator = ctx.accounts.creator.key();
    task.required_capabilities = required_capabilities;
    task.description = description;
    task.constraint_hash = constraint_hash;
    task.reward_amount = reward_amount;
    task.deadline = deadline;
    task.task_type = task_type;
    task.depends_on = parent.key();  // Set dependency
    task.speculation_depth = speculation_depth;
    task.created_at = clock.unix_timestamp;
    task.status = TaskStatus::Open;
    task.escrow = ctx.accounts.escrow.key();
    task.bump = ctx.bumps.task;
    
    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.task = task.key();
    escrow.amount = reward_amount;
    escrow.bump = ctx.bumps.escrow;
    
    // Transfer reward to escrow
    // ... (same as create_task)
    
    emit!(TaskCreated {
        task_id,
        creator: ctx.accounts.creator.key(),
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        depends_on: Some(parent.key()),
        speculation_depth,
        timestamp: clock.unix_timestamp,
    });
    
    Ok(())
}
```

#### 4.6.4 Modified complete_task_private

Add dependency validation:

```rust
// In complete_task_private.rs

pub fn complete_task_private(ctx: Context<CompleteTaskPrivate>, proof: [u8; 388]) -> Result<()> {
    let task = &ctx.accounts.task;
    
    // NEW: Check parent task is confirmed (if dependent)
    if task.depends_on != Pubkey::default() {
        // Parent task account must be passed in remaining_accounts
        let parent_account = ctx.remaining_accounts
            .get(0)
            .ok_or(CoordinationError::TaskNotFound)?;
        
        // Validate ownership
        require!(
            parent_account.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        
        // Deserialize and check status
        let parent_data = parent_account.try_borrow_data()?;
        let parent = Task::try_deserialize(&mut &parent_data[..])?;
        
        require!(
            parent.status == TaskStatus::Completed,
            CoordinationError::TaskNotInProgress  // Parent must be completed first
        );
    }
    
    // ... rest of existing logic ...
}
```

---

## 5. Safety & Correctness

### 5.1 Critical Invariants

| ID | Invariant | Enforcement | Violation Consequence |
|----|-----------|-------------|----------------------|
| **INV-1** | Proof Ordering | A task's proof is only submitted when ALL ancestor tasks are CONFIRMED on-chain | Invalid state transition, proof rejection |
| **INV-2** | Stake Sufficiency | Bonded stake ≥ minStake + (depth × stakePerDepth) | Speculation rejected |
| **INV-3** | Depth Bound | Speculation depth ≤ maxDepth for all tasks | Task scheduling rejected |
| **INV-4** | DAG Property | Dependency graph has no cycles | Task scheduling rejected |
| **INV-5** | Rollback Order | Rollbacks execute leaves-first (reverse topological) | Orphaned state |
| **INV-6** | Claim Expiry Buffer | Tasks only speculated if claimExpiry - now > claimBufferMs | Wasted computation |
| **INV-7** | Single Active Rollback | At most one rollback plan executes at a time | Race conditions |

### 5.2 Depth Limiting

**Rationale**: Deeper speculation chains have exponentially higher rollback risk.

```typescript
// Depth validation in SpeculativeTaskScheduler.schedule()
if (speculationDepth >= this.config.maxDepth) {
  return {
    accepted: false,
    reason: `Speculation depth ${speculationDepth} exceeds max ${this.config.maxDepth}`,
  };
}
```

**Default Configuration**:
- `maxDepth = 5` (conservative)
- Produces max chain: A → B → C → D → E → F (6 tasks, 5 speculative)

**Depth Calculation**:
```
depth(task) = count of unconfirmed ancestors in path to root
```

Example:
```
A (confirmed) → B (speculative) → C (speculative) → D (?)
                     depth=1          depth=2        depth=3
```

### 5.3 Stake Limiting

**Rationale**: Exponential stake prevents deep speculation abuse.

```typescript
// Bond calculation
const requiredBond = minStake + (stakePerDepth × depth);

// Example with minStake=0.001 SOL, stakePerDepth=0.0005 SOL:
// Depth 0: 0.001 SOL
// Depth 1: 0.0015 SOL
// Depth 2: 0.002 SOL
// Depth 3: 0.0025 SOL
// Depth 5: 0.0035 SOL
```

**Total Stake Cap**:
```typescript
// Agent cannot speculate beyond available stake
if (availableStake - lockedStake < requiredBond) {
  reject();
}
```

### 5.4 Claim Expiry Handling

**Problem**: If a claim expires while speculation is in-flight, the proof becomes unsubmittable.

**Solution**: Buffer validation at scheduling time:

```typescript
// Ensure sufficient time remains
const timeToExpiry = claimExpiresAt - Date.now();
if (timeToExpiry < claimBufferMs) {
  return {
    accepted: false,
    reason: 'Insufficient time before claim expiry',
  };
}
```

**Default Buffer**: 60 seconds (configurable)

**Monitoring**: Alert when `timeToExpiry < 2 × avgProofTime`.

### 5.5 Formal Correctness Arguments

#### Proof Ordering Correctness (INV-1)

**Claim**: If INV-1 holds, no invalid state transitions occur.

**Proof**:
1. Let T be a task with parent P
2. T's proof can only verify if P's proof is on-chain (circuit binding)
3. By INV-1, we only submit T's proof after P is confirmed
4. Therefore, T's proof verification has valid inputs
5. By induction, all tasks in chain verify correctly ∎

#### Rollback Completeness

**Claim**: Rollback leaves no orphaned speculative state.

**Proof**:
1. Let F be the failed task
2. DependencyGraph.getDescendantsReverseTopological(F) returns all descendants
3. For each descendant D in reverse order:
   - D has no unprocessed children (by reverse topological order)
   - D is marked as rolled back
   - D's commitment is invalidated
   - D's deferred proof is cancelled
4. Finally, F itself is processed
5. No node in subtree(F) remains speculative ∎

#### No Double-Spending

**Claim**: A task's reward cannot be claimed twice.

**Proof**:
1. On-chain TaskClaim.is_completed prevents double completion
2. Speculative commitments are local until proof submission
3. Proof submission goes through standard complete_task_private
4. On-chain constraints enforce single completion ∎

---

## 6. Error Handling

### 6.1 Proof Generation Failures

**Scenarios**:
- Circuit execution error
- Insufficient memory
- Timeout during generation

**Handling**:
```typescript
try {
  const proof = await generateProof(inputs);
  scheduler.recordCompletion(taskId, commitment, hash, salt, proof);
} catch (error) {
  if (error instanceof ProofGenerationError) {
    // Trigger rollback for this task
    rollbackController.triggerRollback(taskId, RollbackReason.ProofFailed);
    
    // Log for investigation
    logger.error('Proof generation failed', {
      taskId: bytesToHex(taskId),
      error: error.message,
    });
  }
  throw error;
}
```

**Recovery**: Task can be re-attempted after rollback completes (if claim not expired).

### 6.2 Proof Submission Failures

**Scenarios**:
- Network error during RPC call
- Transaction simulation failure
- Insufficient compute units
- Account constraint violation

**Handling**:
```typescript
// ProofDeferralManager retry logic
const maxRetries = 3;
const retryDelayMs = 1000;

for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    const txSig = await submitProof(taskPda, proof, publicInputs);
    return txSig;
  } catch (error) {
    if (attempt === maxRetries) {
      // Trigger rollback after all retries exhausted
      rollbackController.triggerRollback(taskId, RollbackReason.ProofFailed);
      throw error;
    }
    // Exponential backoff
    await sleep(retryDelayMs * Math.pow(2, attempt - 1));
  }
}
```

### 6.3 Network Failures

**Scenarios**:
- RPC endpoint unreachable
- WebSocket disconnection
- Consensus failure (unlikely)

**Handling**:
```typescript
// EventMonitor reconnection
eventMonitor.on('disconnected', async () => {
  logger.warn('WebSocket disconnected, reconnecting...');
  
  for (let i = 0; i < 10; i++) {
    try {
      await eventMonitor.reconnect();
      
      // Re-sync state after reconnection
      await syncPendingCommitments();
      return;
    } catch (error) {
      await sleep(1000 * Math.pow(2, i));
    }
  }
  
  // Graceful degradation: stop speculation
  scheduler.pauseSpeculation();
  logger.error('Failed to reconnect, speculation paused');
});
```

### 6.4 Timeout Handling

**Commitment TTL Expiration**:
```typescript
// CommitmentLedger expiration check (runs periodically)
const expired = commitmentLedger.checkExpirations();

for (const commitment of expired) {
  rollbackController.triggerRollback(
    commitment.taskId,
    RollbackReason.CommitmentExpired
  );
}
```

**Proof Submission Timeout**:
```typescript
// Configurable confirmation timeout
const confirmationTimeout = setTimeout(() => {
  if (proof.status === DeferralStatus.Submitted) {
    proof.status = DeferralStatus.Failed;
    proof.error = 'Confirmation timeout';
    
    rollbackController.triggerRollback(
      proof.taskId,
      RollbackReason.ProofTimeout
    );
  }
}, config.confirmationTimeoutMs);
```

---

## 7. Configuration

### 7.1 Configuration Options (table)

| Option | Type | Default | Range | Description |
|--------|------|---------|-------|-------------|
| `speculation.enabled` | bool | `false` | — | Master switch for speculation |
| `speculation.mode` | enum | `conservative` | conservative/balanced/aggressive/custom | Preset configuration |
| `speculation.maxDepth` | u32 | `5` | 1-20 | Maximum speculation chain length |
| `speculation.maxParallelBranches` | u32 | `4` | 1-16 | Concurrent speculation paths |
| `speculation.confirmationTimeoutMs` | u64 | `30000` | 5000-300000 | Proof confirmation timeout |
| `speculation.rollbackPolicy` | enum | `cascade` | cascade/selective/checkpoint | Rollback strategy |
| `speculation.stake.minStake` | u64 | `1000000` | — | Minimum stake (lamports) |
| `speculation.stake.maxStake` | u64 | `1000000000` | — | Maximum locked stake |
| `speculation.stake.stakePerDepth` | u64 | `500000` | — | Additional stake per depth |
| `speculation.stake.slashPercentage` | f64 | `0.1` | 0.01-0.5 | Slash on failure (10%) |
| `speculation.proof.workerThreads` | u32 | `4` | 1-32 | Proof generation threads |
| `speculation.proof.queueSize` | u32 | `1000` | 100-10000 | Max pending proofs |
| `speculation.proof.timeoutMs` | u64 | `60000` | — | Proof generation timeout |
| `speculation.limits.maxMemoryMb` | u64 | `4096` | 512+ | Memory limit |
| `speculation.limits.maxPendingOps` | u64 | `10000` | — | Max pending operations |
| `speculation.features.enableParallel` | bool | `true` | — | Allow parallel branches |
| `speculation.features.enableCrossAgent` | bool | `false` | — | Cross-agent speculation |

### 7.2 Default Values

```toml
# config/default.toml
[speculation]
enabled = false
mode = "conservative"
maxDepth = 5
maxParallelBranches = 4
confirmationTimeoutMs = 30000
rollbackPolicy = "cascade"

[speculation.stake]
minStake = 1000000        # 0.001 SOL
maxStake = 1000000000     # 1 SOL
stakePerDepth = 500000    # 0.0005 SOL
slashPercentage = 0.1

[speculation.proof]
workerThreads = 4
queueSize = 1000
timeoutMs = 60000

[speculation.limits]
maxMemoryMb = 4096
maxPendingOps = 10000
gcIntervalMs = 30000

[speculation.features]
enableParallel = true
enableCrossAgent = false
rolloutPercentage = 100.0
```

### 7.3 Tuning Guidelines

| Workload | maxDepth | maxParallel | minStake | Mode |
|----------|----------|-------------|----------|------|
| Low-latency pipelines | 8-10 | 8 | 0.0005 SOL | aggressive |
| Production default | 5 | 4 | 0.001 SOL | balanced |
| Safety-critical | 2-3 | 2 | 0.005 SOL | conservative |
| Testing | 10+ | 16 | 0.00001 SOL | aggressive + mock proofs |

**Monitoring-Based Tuning**:
1. Start with conservative mode
2. Monitor `speculation.rollback.rate`
3. If rollback rate < 1%, increase depth by 1
4. If rollback rate > 5%, decrease depth by 1
5. Adjust stake based on rollback cost analysis

---

## 8. Observability

### 8.1 Metrics

```typescript
// Prometheus-style metrics
const metrics = {
  // Counters
  speculation_tasks_scheduled_total: Counter,
  speculation_tasks_rejected_total: Counter,  // labels: reason
  speculation_proofs_submitted_total: Counter,
  speculation_proofs_confirmed_total: Counter,
  speculation_proofs_failed_total: Counter,
  speculation_rollbacks_total: Counter,  // labels: reason
  speculation_tasks_rolled_back_total: Counter,
  
  // Gauges
  speculation_active_commitments: Gauge,
  speculation_pending_proofs: Gauge,
  speculation_locked_stake_lamports: Gauge,
  speculation_max_depth_current: Gauge,
  
  // Histograms
  speculation_proof_generation_duration_ms: Histogram,
  speculation_proof_submission_duration_ms: Histogram,
  speculation_confirmation_latency_ms: Histogram,
  speculation_rollback_duration_ms: Histogram,
  speculation_chain_depth: Histogram,
};
```

**Key Dashboards**:

1. **Speculation Overview**
   - Active commitments over time
   - Confirmation rate (confirmed / total)
   - Average speculation depth

2. **Performance**
   - Proof generation latency p50/p95/p99
   - Confirmation latency distribution
   - Queue depths

3. **Reliability**
   - Rollback rate by reason
   - Stake slashed over time
   - Error rates by type

### 8.2 Traces

```typescript
// OpenTelemetry tracing
const tracer = trace.getTracer('speculation');

async function scheduleSpeculativeTask(request: ScheduleRequest) {
  return tracer.startActiveSpan('speculation.schedule', async (span) => {
    span.setAttributes({
      'task.id': bytesToHex(request.taskId),
      'task.parent_id': request.parentTaskId ? bytesToHex(request.parentTaskId) : null,
    });
    
    try {
      const result = await scheduler.schedule(request);
      span.setAttributes({
        'speculation.accepted': result.accepted,
        'speculation.depth': result.speculationDepth,
        'speculation.required_bond': result.requiredBond?.toString(),
      });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    }
  });
}
```

**Trace Spans**:
- `speculation.schedule` - Task scheduling decision
- `speculation.proof_generate` - Proof generation
- `speculation.proof_submit` - On-chain submission
- `speculation.confirm_wait` - Confirmation wait
- `speculation.rollback` - Rollback execution

### 8.3 Logs

```typescript
// Structured logging
const logger = createLogger('speculation');

// Scheduling
logger.info('Task scheduled for speculation', {
  taskId: bytesToHex(taskId),
  parentTaskId: parentTaskId ? bytesToHex(parentTaskId) : null,
  depth: speculationDepth,
  requiredBond: requiredBond.toString(),
});

// Confirmation
logger.info('Speculative proof confirmed', {
  taskId: bytesToHex(taskId),
  txSignature,
  confirmationLatencyMs: Date.now() - submittedAt,
});

// Rollback
logger.warn('Triggering rollback', {
  triggerTaskId: bytesToHex(failedTaskId),
  reason,
  affectedTasks: affectedTasks.length,
  totalBondedStake: totalBondedStake.toString(),
  slashAmount: slashAmount.toString(),
});
```

**Log Levels**:
- `DEBUG`: Detailed state transitions, queue operations
- `INFO`: Scheduling decisions, confirmations, completions
- `WARN`: Rollbacks, retries, degraded performance
- `ERROR`: Failures, exceptions, invariant violations

### 8.4 Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| SpeculationRollbackRateHigh | rollback_rate > 5% over 5m | Warning | Review configuration |
| SpeculationConfirmationSlow | p95 confirmation > 60s | Warning | Check RPC health |
| SpeculationQueueBacklog | pending_proofs > 100 | Warning | Scale proof workers |
| SpeculationStakeExhausted | available_stake < minStake | Critical | Add stake or disable |
| SpeculationErrorRate | error_rate > 1% | Critical | Investigate errors |
| SpeculationDisabled | enabled = false unexpectedly | Critical | Check for auto-disable |

---

## 9. Testing Strategy

### 9.1 Unit Testing

**Test Files**:
- `runtime/src/speculation/__tests__/dependency-graph.test.ts`
- `runtime/src/speculation/__tests__/commitment-ledger.test.ts`
- `runtime/src/speculation/__tests__/proof-deferral-manager.test.ts`
- `runtime/src/speculation/__tests__/rollback-controller.test.ts`
- `runtime/src/speculation/__tests__/speculative-task-scheduler.test.ts`

**Key Test Cases**:

```typescript
describe('DependencyGraph', () => {
  describe('addNode', () => {
    it('should add root node with depth 0');
    it('should add child node with correct depth');
    it('should reject duplicate task ID');
    it('should reject missing parent');
    it('should detect cycles');
  });
  
  describe('markConfirmed', () => {
    it('should update node status');
    it('should recalculate descendant depths');
  });
  
  describe('getDescendantsReverseTopological', () => {
    it('should return empty for leaf nodes');
    it('should return leaves before parents');
    it('should handle diamond dependencies');
  });
});

describe('CommitmentLedger', () => {
  describe('create', () => {
    it('should create commitment with unique ID');
    it('should index by taskId and outputCommitment');
    it('should reject duplicate task');
  });
  
  describe('checkExpirations', () => {
    it('should mark expired commitments');
    it('should not affect confirmed commitments');
  });
  
  describe('snapshot/restore', () => {
    it('should serialize and deserialize correctly');
    it('should preserve all indexes');
  });
});
```

### 9.2 Integration Testing

**Test Files**:
- `tests/speculation/full-pipeline.test.ts`
- `tests/speculation/rollback-scenarios.test.ts`
- `tests/speculation/event-coordination.test.ts`

**Test Scenarios**:

1. **Happy Path Pipeline**
   - Create dependent task chain A → B → C
   - Execute speculatively
   - Verify proofs submit in order
   - Verify all confirmations

2. **Rollback Cascade**
   - Create chain A → B → C → D
   - Fail A's proof
   - Verify B, C, D rolled back
   - Verify stake released/slashed correctly

3. **Parallel Branches**
   - Create: A → B, A → C, B → D, C → E
   - Execute all speculatively
   - Confirm A
   - Verify B, C become ready simultaneously
   - Verify D, E submit after respective parents

4. **Claim Expiry Race**
   - Create task with short claim window
   - Verify rejection if buffer insufficient
   - Verify rollback if claim expires mid-speculation

### 9.3 Chaos Testing

**Chaos Scenarios**:

1. **Network Partition**
   ```typescript
   // Simulate RPC failure during speculation
   mockRpc.failNextN(5);
   await scheduleSpeculativeChain(depth: 3);
   // Verify graceful degradation
   ```

2. **Proof Generation Crash**
   ```typescript
   // Kill proof worker mid-generation
   proofWorker.kill('SIGKILL');
   // Verify timeout triggers rollback
   ```

3. **Out-of-Order Events**
   ```typescript
   // Deliver confirmation events out of order
   eventMonitor.injectEvent(childConfirmed);
   eventMonitor.injectEvent(parentConfirmed);
   // Verify correct handling
   ```

4. **Memory Pressure**
   ```typescript
   // Fill memory to limit
   allocateMb(config.maxMemoryMb - 100);
   // Verify new speculations rejected gracefully
   ```

### 9.4 Performance Testing

**Benchmarks**:

1. **Throughput**
   - Schedule 1000 speculative tasks
   - Measure scheduling latency p50/p95/p99
   - Target: < 1ms p99

2. **Proof Submission Rate**
   - Generate 100 proofs
   - Measure submission throughput
   - Target: 50 proofs/second

3. **Rollback Performance**
   - Create 100-task chain
   - Fail root
   - Measure rollback completion time
   - Target: < 500ms

4. **Memory Footprint**
   - Create 10,000 commitments
   - Measure memory usage
   - Target: < 500MB

**Load Test Script**:
```bash
# Run speculation load test
npm run test:speculation:load -- \
  --depth=5 \
  --tasks=1000 \
  --parallel=8 \
  --duration=60s
```

---

## 10. Implementation Phases

### 10.1 Phase 0: On-Chain Prerequisites

**Duration**: 1 week  
**Issue**: [#259](https://github.com/tetsuo-ai/AgenC/issues/259)

**Deliverables**:
- [ ] Add `depends_on: Pubkey` to Task struct
- [ ] Add `speculation_depth: u8` to Task struct
- [ ] Create `create_dependent_task` instruction
- [ ] Update `complete_task_private` to validate parent
- [ ] Migration for existing tasks
- [ ] Integration tests for dependent tasks

### 10.2 Phase 1: Runtime Foundation

**Duration**: 2 weeks  
**Issues**: [#260](https://github.com/tetsuo-ai/AgenC/issues/260)-[#263](https://github.com/tetsuo-ai/AgenC/issues/263)

**Deliverables**:
- [ ] DependencyGraph implementation
  - [ ] Node management (add, remove)
  - [ ] Depth calculation
  - [ ] Cycle detection
  - [ ] Topological traversal
  - [ ] Unit tests
- [ ] TypeScript types and interfaces
- [ ] Integration with existing runtime

### 10.3 Phase 2: Full Speculation Core

**Duration**: 3 weeks  
**Issues**: [#264](https://github.com/tetsuo-ai/AgenC/issues/264)-[#272](https://github.com/tetsuo-ai/AgenC/issues/272)

**Deliverables**:
- [ ] CommitmentLedger implementation
  - [ ] Create/query/update operations
  - [ ] TTL expiration handling
  - [ ] Persistence (snapshot/restore)
- [ ] ProofDeferralManager implementation
  - [ ] Queue management
  - [ ] Ancestor tracking
  - [ ] Retry logic
- [ ] RollbackController implementation
  - [ ] Cascade rollback
  - [ ] Stake handling
- [ ] SpeculativeTaskScheduler implementation
  - [ ] Validation logic
  - [ ] Component coordination
- [ ] Unit tests for all components

### 10.4 Phase 3: Safety & Bounds

**Duration**: 1 week  
**Issues**: [#290](https://github.com/tetsuo-ai/AgenC/issues/290)

**Deliverables**:
- [ ] Depth limiting enforcement
- [ ] Stake bonding enforcement
- [ ] Claim expiry buffer validation
- [ ] Parallel branch limiting
- [ ] Invariant assertion tests
- [ ] Security review

### 10.5 Phase 4: On-Chain State (Optional)

**Duration**: 2 weeks  
**Issues**: [#273](https://github.com/tetsuo-ai/AgenC/issues/273)-[#275](https://github.com/tetsuo-ai/AgenC/issues/275)

**Deliverables**:
- [ ] SpeculativeCommitment account type
- [ ] `create_speculative_commitment` instruction
- [ ] `resolve_commitment` instruction
- [ ] Stake bonding on-chain
- [ ] Slash distribution logic
- [ ] Integration tests

### 10.6 Phase 5: Observability & Testing

**Duration**: 2 weeks  
**Issues**: [#278](https://github.com/tetsuo-ai/AgenC/issues/278)-[#283](https://github.com/tetsuo-ai/AgenC/issues/283)

**Deliverables**:
- [ ] Prometheus metrics
- [ ] OpenTelemetry tracing
- [ ] Structured logging
- [ ] Dashboard templates
- [ ] Alert rules
- [ ] Integration test suite
- [ ] Chaos test suite
- [ ] Performance benchmarks

### 10.7 Phase 6: Documentation

**Duration**: 1 week  
**Issues**: [#284](https://github.com/tetsuo-ai/AgenC/issues/284), [#288](https://github.com/tetsuo-ai/AgenC/issues/288)

**Deliverables**:
- [ ] API documentation
- [ ] Configuration guide (completed)
- [ ] Operational runbook
- [ ] Architecture diagrams
- [ ] Migration guide
- [ ] CHANGELOG updates

---

## 11. Risks & Mitigations

### 11.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Cascade rollback storm** | Medium | High | Depth limiting, circuit breaker for rollback rate |
| **Memory exhaustion** | Medium | Medium | Strict memory limits, GC tuning |
| **Proof generation bottleneck** | Medium | Medium | Worker pool scaling, queue limits |
| **Network partition during speculation** | Low | High | Timeout-based rollback, state persistence |
| **On-chain state divergence** | Low | Critical | Event reconciliation, periodic sync |
| **ZK proof malleability** | Low | Critical | Binding validation, proof uniqueness checks |

### 11.2 Operational Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Misconfiguration** | High | Medium | Validation, conservative defaults, config review |
| **Stake depletion** | Medium | High | Monitoring, alerts, auto-pause |
| **Runaway slashing** | Low | High | Slash rate limiting, manual override |
| **Observability gaps** | Medium | Medium | Comprehensive metrics, distributed tracing |
| **Upgrade compatibility** | Medium | Medium | Version checks, migration tooling |

### 11.3 Mitigations

#### Circuit Breaker Pattern

```typescript
class SpeculationCircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  private readonly threshold = 5;
  private readonly resetMs = 60000;

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger.warn('Circuit breaker opened', { failures: this.failures });
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
    }
  }

  canProceed(): boolean {
    if (this.state === 'closed') return true;
    
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    
    return true;
  }
}
```

#### Graceful Degradation

```typescript
// Auto-disable speculation on repeated failures
if (rollbackRate > 0.1 && speculationEnabled) {
  logger.warn('High rollback rate, disabling speculation');
  config.speculation.enabled = false;
  
  // Drain existing speculations
  await scheduler.drainPending();
  
  // Alert operators
  alerts.fire('SpeculationAutoDisabled', {
    rollbackRate,
    threshold: 0.1,
  });
}
```

---

## 12. Appendix

### 12.1 API Reference

#### SpeculativeTaskScheduler

```typescript
class SpeculativeTaskScheduler {
  /**
   * Schedule a task for speculative execution
   * @param request - Task scheduling request
   * @returns Schedule result with acceptance status
   */
  schedule(request: ScheduleRequest): Promise<ScheduleResult>;
  
  /**
   * Record task completion with speculative commitment
   * @param taskId - Task identifier
   * @param outputCommitment - Commitment hash
   * @param constraintHash - Constraint hash from output
   * @param salt - Commitment salt
   * @param privatePayload - Generated RISC0 payload bundle
   * @returns Commitment ID
   */
  recordCompletion(
    taskId: Uint8Array,
    outputCommitment: Uint8Array,
    constraintHash: Uint8Array,
    salt: bigint,
    privatePayload: Risc0PrivatePayload
  ): string;
  
  /**
   * Set available stake for speculation
   */
  setAvailableStake(stake: bigint): void;
  
  /**
   * Get scheduler statistics
   */
  getStats(): SchedulerStats;
  
  /**
   * Get current configuration
   */
  getConfig(): Readonly<SchedulerConfig>;
  
  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<SchedulerConfig>): void;
}
```

#### DependencyGraph

```typescript
class DependencyGraph {
  /**
   * Add a task node to the graph
   */
  addNode(
    taskId: Uint8Array,
    taskPda: PublicKey,
    parentTaskId: Uint8Array | null
  ): AddNodeResult;
  
  /**
   * Get node by task ID
   */
  getNode(taskId: Uint8Array): DependencyNode | undefined;
  
  /**
   * Mark node as confirmed
   */
  markConfirmed(taskId: Uint8Array): boolean;
  
  /**
   * Mark node as failed
   */
  markFailed(taskId: Uint8Array): boolean;
  
  /**
   * Get descendants in reverse topological order
   */
  getDescendantsReverseTopological(taskId: Uint8Array): DependencyNode[];
  
  /**
   * Get ancestors from immediate parent to root
   */
  getAncestors(taskId: Uint8Array): DependencyNode[];
  
  /**
   * Get unconfirmed ancestors
   */
  getUnconfirmedAncestors(taskId: Uint8Array): DependencyNode[];
  
  /**
   * Check if dependency would create cycle
   */
  wouldCreateCycle(childId: Uint8Array, parentId: Uint8Array): boolean;
  
  /**
   * Remove subtree
   */
  removeSubtree(taskId: Uint8Array): number;
  
  /**
   * Get graph statistics
   */
  getStats(): GraphStats;
}
```

#### CommitmentLedger

```typescript
class CommitmentLedger {
  /**
   * Create a new speculative commitment
   */
  create(options: CreateCommitmentOptions): SpeculativeCommitment;
  
  /**
   * Get commitment by ID
   */
  get(id: string): SpeculativeCommitment | undefined;
  
  /**
   * Get commitment by task ID
   */
  getByTaskId(taskId: Uint8Array): SpeculativeCommitment | undefined;
  
  /**
   * Set proof data for commitment
   */
  setProof(id: string, privatePayload: Risc0PrivatePayload): boolean;
  
  /**
   * Mark commitment as submitted
   */
  markSubmitted(id: string, txSignature: string): boolean;
  
  /**
   * Mark commitment as confirmed
   */
  markConfirmed(id: string): boolean;
  
  /**
   * Mark commitment as failed
   */
  markFailed(id: string, error: string): boolean;
  
  /**
   * Mark commitment as rolled back
   */
  markRolledBack(id: string, reason: string): boolean;
  
  /**
   * Query commitments with filters
   */
  query(options: CommitmentQueryOptions): SpeculativeCommitment[];
  
  /**
   * Check and mark expired commitments
   */
  checkExpirations(): SpeculativeCommitment[];
  
  /**
   * Create persistence snapshot
   */
  snapshot(): string;
  
  /**
   * Restore from snapshot
   */
  restore(snapshotJson: string): void;
  
  /**
   * Get ledger statistics
   */
  getStats(): LedgerStats;
}
```

#### ProofDeferralManager

```typescript
class ProofDeferralManager extends EventEmitter {
  /**
   * Set proof submitter callback
   */
  setSubmitter(submitter: ProofSubmitter): void;
  
  /**
   * Enqueue proof for deferred submission
   */
  enqueue(options: EnqueueProofOptions): DeferredProof;
  
  /**
   * Handle ancestor confirmation
   */
  onAncestorConfirmed(ancestorTaskId: Uint8Array): DeferredProof[];
  
  /**
   * Cancel proofs for failed ancestor
   */
  cancelForAncestor(ancestorTaskId: Uint8Array): DeferredProof[];
  
  /**
   * Process ready queue
   */
  processReadyQueue(): Promise<void>;
  
  /**
   * Get proof by ID
   */
  get(id: string): DeferredProof | undefined;
  
  /**
   * Get proof by task ID
   */
  getByTaskId(taskId: Uint8Array): DeferredProof | undefined;
  
  /**
   * Get manager statistics
   */
  getStats(): DeferralStats;
}
```

#### RollbackController

```typescript
class RollbackController extends EventEmitter {
  /**
   * Trigger rollback for failed task
   */
  triggerRollback(
    failedTaskId: Uint8Array,
    reason: RollbackReason
  ): Promise<RollbackPlan>;
  
  /**
   * Get active rollback plan
   */
  getActivePlan(): RollbackPlan | null;
  
  /**
   * Get rollback history
   */
  getHistory(limit?: number): RollbackPlan[];
  
  /**
   * Get rollback statistics
   */
  getStats(): RollbackStats;
}
```

### 12.2 Configuration Schema

```typescript
/**
 * Complete configuration schema for speculative execution
 */
interface SpeculationConfig {
  /** Master enable/disable switch */
  enabled: boolean;
  
  /** Preset mode (overrides individual settings) */
  mode: 'conservative' | 'balanced' | 'aggressive' | 'custom';
  
  /** Maximum speculation chain depth */
  maxDepth: number;
  
  /** Maximum parallel speculation branches */
  maxParallelBranches: number;
  
  /** Confirmation timeout in milliseconds */
  confirmationTimeoutMs: number;
  
  /** Rollback strategy */
  rollbackPolicy: 'cascade' | 'selective' | 'checkpoint';
  
  /** Stake configuration */
  stake: {
    /** Minimum stake per speculation (lamports) */
    minStake: bigint;
    
    /** Maximum total locked stake (lamports) */
    maxStake: bigint;
    
    /** Additional stake per depth level (lamports) */
    stakePerDepth: bigint;
    
    /** Slash percentage on failure (0.0-1.0) */
    slashPercentage: number;
    
    /** Cooldown after slash (milliseconds) */
    cooldownPeriodMs: number;
  };
  
  /** Proof generation configuration */
  proof: {
    /** Proof generator type */
    generator: 'groth16' | 'plonk' | 'stark' | 'mock';
    
    /** Worker thread count */
    workerThreads: number;
    
    /** Maximum pending proofs */
    queueSize: number;
    
    /** Proof generation timeout (milliseconds) */
    timeoutMs: number;
    
    /** Proof batch size for efficiency */
    batchSize: number;
  };
  
  /** Resource limits */
  limits: {
    /** Maximum memory usage (MB) */
    maxMemoryMb: number;
    
    /** Maximum pending operations */
    maxPendingOperations: number;
    
    /** Maximum state snapshots for rollback */
    maxStateSnapshots: number;
    
    /** Garbage collection interval (milliseconds) */
    gcIntervalMs: number;
  };
  
  /** Feature flags */
  features: {
    /** Enable parallel speculation branches */
    enableParallelSpeculation: boolean;
    
    /** Enable cross-agent speculation (Phase 2) */
    enableCrossAgentSpeculation: boolean;
    
    /** Enable optimistic proof generation */
    enableOptimisticProofs: boolean;
    
    /** Enable stake delegation */
    enableStakeDelegation: boolean;
    
    /** Rollout percentage (0-100) */
    rolloutPercentage: number;
  };
}

/**
 * Validation rules for configuration
 */
const CONFIG_VALIDATION = {
  maxDepth: { min: 1, max: 20 },
  maxParallelBranches: { min: 1, max: 16 },
  confirmationTimeoutMs: { min: 5000, max: 300000 },
  'stake.slashPercentage': { min: 0.01, max: 0.5 },
  'limits.maxMemoryMb': { min: 512 },
  'proof.workerThreads': { min: 1, max: 32 },
  'proof.queueSize': { min: 100, max: 10000 },
  'features.rolloutPercentage': { min: 0, max: 100 },
};
```

### 12.3 Glossary

| Term | Definition |
|------|------------|
| **Ancestor** | A task whose output is consumed by another task in the dependency chain |
| **Bonded Stake** | SOL locked as collateral during speculative execution |
| **Cascade Rollback** | Rollback policy that undoes all dependent tasks when one fails |
| **Commitment** | Cryptographic binding to a task output before on-chain proof |
| **Confirmation** | On-chain acceptance of a task's ZK proof |
| **DAG** | Directed Acyclic Graph - the structure of task dependencies |
| **Deferral** | Delaying proof submission until ancestors are confirmed |
| **Descendant** | A task that depends on another task's output |
| **Depth** | Number of unconfirmed ancestors in the dependency chain |
| **Finality** | Irreversible on-chain state after sufficient confirmations |
| **Groth16** | Zero-knowledge proof system used in AgenC |
| **Invariant** | Property that must always be true for system correctness |
| **Ledger** | Local storage for speculative commitments |
| **Output Commitment** | SHA-256(constraintHash, salt) - hides output until reveal |
| **Parallel Branches** | Multiple independent speculation chains executing concurrently |
| **SHA-256** | Hash function used for commitments (via Solana `hashv` syscall) |
| **Proof Ordering** | Requirement that proofs submit in dependency order |
| **Rollback** | Reverting speculative work when a task fails |
| **Salt** | Random value for commitment hiding |
| **Slash** | Stake penalty for failed speculation |
| **Speculation** | Executing tasks before dependencies are confirmed |
| **Topological Order** | Ordering where parents come before children |
| **TTL** | Time-To-Live - maximum lifetime for a commitment |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-28 | AgenC Team | Initial complete document |

---

## Approval

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Technical Lead | — | — | — |
| Security Review | — | — | — |
| Product Owner | — | — | — |
