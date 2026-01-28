# Chaos Test Plan: Speculative Execution

> **Version:** 1.0  
> **Last Updated:** 2025-01-28  
> **Scope:** Chaos engineering and fuzz testing for speculative execution

## Overview

This document specifies chaos and fuzz testing strategies to validate the robustness of the speculative execution system under adverse conditions. The goal is to find edge cases, race conditions, and failure modes that deterministic testing might miss.

---

## 1. Chaos Testing Framework

### 1.1 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chaos Orchestrator                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Failure   │  │  Workload   │  │    Invariant        │  │
│  │  Injector   │  │  Generator  │  │    Checker          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    System Under Test                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  DependencyGraph │ CommitmentLedger │ ProofManager   │   │
│  │  RollbackController │ SpeculativeScheduler           │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                    Monitoring & Metrics                      │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Chaos Orchestrator Interface

```typescript
interface ChaosOrchestrator {
  // Configuration
  configure(config: ChaosConfig): void;
  
  // Execution
  start(): Promise<void>;
  stop(): Promise<ChaosReport>;
  
  // Manual control
  injectFailure(failure: FailureType): void;
  pauseInjection(): void;
  resumeInjection(): void;
  
  // Monitoring
  getStatus(): ChaosStatus;
  getInvariantViolations(): InvariantViolation[];
}

interface ChaosConfig {
  duration: Duration;
  workload: WorkloadConfig;
  failures: FailureConfig;
  invariants: InvariantConfig;
  seed?: number;  // For reproducibility
}
```

---

## 2. Failure Injection Parameters

### 2.1 Network Failures

| Failure Type | Parameters | Description |
|--------------|------------|-------------|
| `network.latency` | `minMs`, `maxMs`, `probability` | Add random latency to network calls |
| `network.drop` | `probability` | Drop network packets |
| `network.partition` | `durationMs`, `partitions[]` | Create network partition between components |
| `network.timeout` | `probability`, `component` | Cause specific components to timeout |

**Configuration:**
```typescript
const networkFailures: FailureConfig = {
  "network.latency": {
    enabled: true,
    minMs: 50,
    maxMs: 500,
    probability: 0.1,  // 10% of requests
  },
  "network.drop": {
    enabled: true,
    probability: 0.01,  // 1% packet loss
  },
  "network.partition": {
    enabled: true,
    durationMs: 5000,
    intervalMs: 60000,  // Partition every 60s
    partitions: [
      ["runtime", "validator"],  // Split runtime from chain
    ],
  },
};
```

### 2.2 Process Failures

| Failure Type | Parameters | Description |
|--------------|------------|-------------|
| `process.crash` | `component`, `probability`, `recoveryMs` | Crash and restart component |
| `process.hang` | `component`, `durationMs` | Freeze component temporarily |
| `process.oom` | `component`, `threshold` | Simulate out-of-memory |
| `process.cpu_spike` | `component`, `durationMs`, `utilization` | CPU contention |

**Configuration:**
```typescript
const processFailures: FailureConfig = {
  "process.crash": {
    enabled: true,
    component: "proof_generator",
    probability: 0.001,  // 0.1% chance per operation
    recoveryMs: 3000,
  },
  "process.hang": {
    enabled: true,
    component: "rollback_controller",
    durationMs: 2000,
    intervalMs: 120000,  // Every 2 minutes
  },
};
```

### 2.3 Data Failures

| Failure Type | Parameters | Description |
|--------------|------------|-------------|
| `data.corruption` | `component`, `probability`, `field` | Corrupt specific data fields |
| `data.delay` | `component`, `delayMs` | Delay data writes |
| `data.duplicate` | `probability` | Duplicate messages/events |
| `data.reorder` | `window` | Reorder operations within time window |

**Configuration:**
```typescript
const dataFailures: FailureConfig = {
  "data.reorder": {
    enabled: true,
    window: 100,  // Reorder operations within 100ms
  },
  "data.duplicate": {
    enabled: true,
    probability: 0.001,
  },
};
```

### 2.4 Blockchain-Specific Failures

| Failure Type | Parameters | Description |
|--------------|------------|-------------|
| `chain.reorg` | `depth`, `probability` | Simulate chain reorganization |
| `chain.slot_skip` | `count` | Skip slots (temporary unavailability) |
| `chain.confirmation_delay` | `multiplier` | Slow down confirmation |
| `chain.rpc_error` | `errorType`, `probability` | Return RPC errors |

**Configuration:**
```typescript
const chainFailures: FailureConfig = {
  "chain.reorg": {
    enabled: true,
    depth: 2,  // Reorg up to 2 slots
    probability: 0.0001,  // Rare
  },
  "chain.slot_skip": {
    enabled: true,
    count: 1,
    probability: 0.01,
  },
  "chain.rpc_error": {
    enabled: true,
    errorType: "429",  // Rate limit
    probability: 0.05,
  },
};
```

### 2.5 Application-Specific Failures

| Failure Type | Parameters | Description |
|--------------|------------|-------------|
| `app.proof_invalid` | `probability` | Generate invalid proofs |
| `app.proof_slow` | `multiplier` | Slow proof generation |
| `app.stake_insufficient` | `probability` | Simulate insufficient stake |
| `app.claim_expired` | `probability` | Simulate claim expiry |

**Configuration:**
```typescript
const appFailures: FailureConfig = {
  "app.proof_invalid": {
    enabled: true,
    probability: 0.05,  // 5% invalid proofs
  },
  "app.proof_slow": {
    enabled: true,
    multiplier: 3,  // 3x slower
    probability: 0.1,
  },
};
```

---

## 3. Invariant Assertions

### 3.1 Safety Invariants (Must NEVER Be Violated)

These invariants must hold at ALL times, regardless of failures.

#### INV-S01: No Orphaned Speculations
```typescript
invariant("no_orphaned_speculations", {
  description: "Every PENDING commitment has a valid ancestor chain to a root",
  severity: "critical",
  check: async (state: SystemState) => {
    for (const commitment of state.commitments.filter(c => c.status === "PENDING")) {
      const ancestors = state.graph.getAncestors(commitment.taskId);
      const root = ancestors[ancestors.length - 1] || commitment.taskId;
      
      // Root must exist and be valid
      if (!state.tasks.has(root)) {
        return { violated: true, message: `Orphaned: ${commitment.taskId}, missing root ${root}` };
      }
    }
    return { violated: false };
  },
});
```

#### INV-S02: Proof Ordering
```typescript
invariant("proof_ordering", {
  description: "A proof can only be submitted if all ancestor proofs are confirmed",
  severity: "critical",
  check: async (state: SystemState) => {
    for (const submittedProof of state.recentProofSubmissions) {
      const ancestors = state.graph.getAncestors(submittedProof.taskId);
      
      for (const ancestor of ancestors) {
        const ancestorCommitment = state.commitments.get(ancestor);
        if (ancestorCommitment && ancestorCommitment.status !== "CONFIRMED") {
          return { 
            violated: true, 
            message: `Proof ${submittedProof.taskId} submitted before ancestor ${ancestor} confirmed` 
          };
        }
      }
    }
    return { violated: false };
  },
});
```

#### INV-S03: No Double Rollback
```typescript
invariant("no_double_rollback", {
  description: "A task cannot be rolled back more than once",
  severity: "critical",
  check: async (state: SystemState) => {
    const rollbackCounts = new Map<string, number>();
    
    for (const event of state.rollbackEvents) {
      const count = (rollbackCounts.get(event.taskId) || 0) + 1;
      rollbackCounts.set(event.taskId, count);
      
      if (count > 1) {
        return { violated: true, message: `Task ${event.taskId} rolled back ${count} times` };
      }
    }
    return { violated: false };
  },
});
```

#### INV-S04: Stake Consistency
```typescript
invariant("stake_consistency", {
  description: "Total staked + slashed + returned = total originally staked",
  severity: "critical",
  check: async (state: SystemState) => {
    for (const agent of state.agents) {
      const originallyStaked = sumStakes(state.allCommitmentsFor(agent));
      const currentlyStaked = sumStakes(state.pendingCommitmentsFor(agent));
      const slashed = state.slashEvents.filter(e => e.agent === agent).reduce((s, e) => s + e.amount, 0);
      const returned = state.returnEvents.filter(e => e.agent === agent).reduce((s, e) => s + e.amount, 0);
      
      const expected = originallyStaked;
      const actual = currentlyStaked + slashed + returned;
      
      if (Math.abs(expected - actual) > 1) {  // Allow 1 lamport rounding
        return { 
          violated: true, 
          message: `Agent ${agent}: expected ${expected}, got ${actual} (staked=${currentlyStaked}, slashed=${slashed}, returned=${returned})` 
        };
      }
    }
    return { violated: false };
  },
});
```

#### INV-S05: DAG Acyclicity
```typescript
invariant("dag_acyclic", {
  description: "Dependency graph must remain acyclic",
  severity: "critical",
  check: async (state: SystemState) => {
    try {
      state.graph.topologicalSort();  // Throws on cycle
      return { violated: false };
    } catch (e) {
      return { violated: true, message: `Cycle detected: ${e.message}` };
    }
  },
});
```

#### INV-S06: Confirmed Immutability
```typescript
invariant("confirmed_immutable", {
  description: "CONFIRMED commitments cannot transition to any other state",
  severity: "critical",
  check: async (state: SystemState) => {
    for (const transition of state.statusTransitions) {
      if (transition.from === "CONFIRMED" && transition.to !== "CONFIRMED") {
        return { 
          violated: true, 
          message: `Task ${transition.taskId} transitioned from CONFIRMED to ${transition.to}` 
        };
      }
    }
    return { violated: false };
  },
});
```

### 3.2 Liveness Invariants (Must Eventually Be True)

These invariants may be temporarily violated but must resolve within bounds.

#### INV-L01: Bounded Speculation Time
```typescript
invariant("bounded_speculation_time", {
  description: "Speculative commitments must resolve within 2× timeout",
  severity: "high",
  check: async (state: SystemState) => {
    const timeout = state.config.confirmation_timeout_ms;
    const maxAge = timeout * 2;
    const now = Date.now();
    
    for (const commitment of state.commitments.filter(c => c.status === "PENDING")) {
      const age = now - commitment.createdAt;
      if (age > maxAge) {
        return { 
          violated: true, 
          message: `Commitment ${commitment.taskId} pending for ${age}ms (max ${maxAge}ms)` 
        };
      }
    }
    return { violated: false };
  },
});
```

#### INV-L02: Progress Under Load
```typescript
invariant("progress_under_load", {
  description: "System must make progress (confirm or fail) on tasks",
  severity: "high",
  windowMs: 30000,  // Check every 30s
  check: async (state: SystemState, prevState: SystemState) => {
    const progressEvents = state.confirmations.length + state.failures.length;
    const prevProgress = prevState?.confirmations.length + prevState?.failures.length || 0;
    
    // Must have at least 1 progress event per window under load
    if (state.workload.tasksPerSecond > 0 && progressEvents === prevProgress) {
      return { violated: true, message: "No progress in last window" };
    }
    return { violated: false };
  },
});
```

#### INV-L03: Queue Draining
```typescript
invariant("queue_draining", {
  description: "Proof deferral queue must drain when ancestors confirm",
  severity: "medium",
  check: async (state: SystemState) => {
    const queuedProofs = state.proofQueue.filter(p => p.status === "QUEUED");
    
    for (const proof of queuedProofs) {
      const allAncestorsConfirmed = proof.ancestors.every(
        a => state.commitments.get(a)?.status === "CONFIRMED"
      );
      const queueTime = Date.now() - proof.queuedAt;
      
      // If ancestors confirmed >5s ago and still queued, problem
      if (allAncestorsConfirmed && queueTime > 5000) {
        return { 
          violated: true, 
          message: `Proof ${proof.taskId} stuck in queue despite confirmed ancestors` 
        };
      }
    }
    return { violated: false };
  },
});
```

### 3.3 Performance Invariants

#### INV-P01: Memory Bounded
```typescript
invariant("memory_bounded", {
  description: "Memory usage must stay within limits",
  severity: "high",
  check: async (state: SystemState) => {
    const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
    const limitMB = state.config.maxMemoryMB || 4096;
    
    if (memoryMB > limitMB) {
      return { violated: true, message: `Memory ${memoryMB.toFixed(0)}MB exceeds ${limitMB}MB` };
    }
    return { violated: false };
  },
});
```

#### INV-P02: Rollback Latency
```typescript
invariant("rollback_latency", {
  description: "Cascade rollback must complete within timeout",
  severity: "high",
  check: async (state: SystemState) => {
    for (const rollback of state.cascadeRollbacks) {
      if (rollback.durationMs > state.config.maxRollbackLatencyMs) {
        return { 
          violated: true, 
          message: `Rollback ${rollback.id} took ${rollback.durationMs}ms (max ${state.config.maxRollbackLatencyMs}ms)` 
        };
      }
    }
    return { violated: false };
  },
});
```

---

## 4. Workload Generation

### 4.1 Workload Profiles

#### Profile: Steady State
```typescript
const steadyState: WorkloadConfig = {
  name: "steady_state",
  duration: "30m",
  tasksPerSecond: 10,
  taskDistribution: {
    rootTasks: 0.3,      // 30% root tasks (no dependency)
    linearChain: 0.4,    // 40% extend linear chains
    dagBranch: 0.2,      // 20% create DAG branches
    dagMerge: 0.1,       // 10% merge branches
  },
  agentDistribution: {
    count: 5,
    stakeDistribution: "uniform",  // Equal stake
  },
  specConfig: {
    mode: "balanced",
    max_depth: 5,
  },
};
```

#### Profile: Burst Load
```typescript
const burstLoad: WorkloadConfig = {
  name: "burst_load",
  duration: "15m",
  phases: [
    { durationSec: 60, tasksPerSecond: 5 },    // Warmup
    { durationSec: 30, tasksPerSecond: 100 },  // Burst
    { durationSec: 60, tasksPerSecond: 5 },    // Recovery
    { durationSec: 30, tasksPerSecond: 100 },  // Burst
    { durationSec: 120, tasksPerSecond: 20 },  // Cooldown
  ],
  // ... rest of config
};
```

#### Profile: Deep Chains
```typescript
const deepChains: WorkloadConfig = {
  name: "deep_chains",
  duration: "20m",
  tasksPerSecond: 5,
  taskDistribution: {
    rootTasks: 0.1,
    linearChain: 0.8,   // Mostly extend chains
    dagBranch: 0.05,
    dagMerge: 0.05,
  },
  specConfig: {
    mode: "aggressive",
    max_depth: 10,  // Allow deep speculation
  },
};
```

#### Profile: Wide DAG
```typescript
const wideDAG: WorkloadConfig = {
  name: "wide_dag",
  duration: "20m",
  tasksPerSecond: 20,
  taskDistribution: {
    rootTasks: 0.1,
    linearChain: 0.1,
    dagBranch: 0.6,    // Lots of branching
    dagMerge: 0.2,     // Lots of merging
  },
  specConfig: {
    mode: "balanced",
    max_parallel_branches: 8,
  },
};
```

#### Profile: High Failure Rate
```typescript
const highFailure: WorkloadConfig = {
  name: "high_failure",
  duration: "20m",
  tasksPerSecond: 10,
  failureConfig: {
    "app.proof_invalid": { probability: 0.2 },  // 20% invalid proofs
    "app.claim_expired": { probability: 0.1 },  // 10% claim expiry
  },
};
```

### 4.2 Task Generator

```typescript
class TaskGenerator {
  private graph: DependencyGraph;
  private rng: SeededRandom;
  
  constructor(seed: number, graph: DependencyGraph) {
    this.rng = new SeededRandom(seed);
    this.graph = graph;
  }
  
  generateTask(distribution: TaskDistribution): Task {
    const type = this.selectType(distribution);
    
    switch (type) {
      case "rootTasks":
        return this.createRootTask();
        
      case "linearChain":
        const leaf = this.selectRandomLeaf();
        return this.createDependentTask(leaf);
        
      case "dagBranch":
        const parent = this.selectRandomNonLeaf();
        return this.createDependentTask(parent);
        
      case "dagMerge":
        const parents = this.selectMultipleLeaves(2);
        return this.createMergingTask(parents);
    }
  }
  
  private selectType(dist: TaskDistribution): string {
    const r = this.rng.random();
    let cumulative = 0;
    
    for (const [type, prob] of Object.entries(dist)) {
      cumulative += prob;
      if (r < cumulative) return type;
    }
    return "rootTasks";
  }
  
  private selectRandomLeaf(): string | null {
    const leaves = this.graph.getLeaves();
    if (leaves.length === 0) return null;
    return leaves[this.rng.randomInt(0, leaves.length - 1)];
  }
}
```

---

## 5. Chaos Test Scenarios

### CHAOS-001: Network Partition Resilience

**Objective:** Validate system behavior during network partitions between runtime and validator.

**Configuration:**
```typescript
const scenario = {
  name: "network_partition_resilience",
  duration: "30m",
  workload: steadyState,
  failures: {
    "network.partition": {
      enabled: true,
      durationMs: 10000,
      intervalMs: 60000,
      partitions: [["runtime", "validator"]],
    },
  },
  invariants: ["no_orphaned_speculations", "stake_consistency", "progress_under_load"],
};
```

**Expected Behavior:**
- During partition: Proof submissions fail, timeouts trigger
- After healing: Proofs retry, system recovers
- No data inconsistency

**Success Criteria:**
- [ ] Zero critical invariant violations
- [ ] Recovery within 2× partition duration
- [ ] All stakes properly accounted for

---

### CHAOS-002: Cascade Rollback Stress

**Objective:** Stress test rollback controller with deep chains and high failure rates.

**Configuration:**
```typescript
const scenario = {
  name: "cascade_rollback_stress",
  duration: "20m",
  workload: deepChains,
  failures: {
    "app.proof_invalid": {
      enabled: true,
      probability: 0.15,
    },
  },
  invariants: ["no_double_rollback", "proof_ordering", "rollback_latency"],
};
```

**Expected Behavior:**
- Frequent cascade rollbacks
- Deep chains (up to 10 levels) rolled back correctly
- Leaves-first ordering maintained

**Success Criteria:**
- [ ] All rollbacks complete within 5 seconds
- [ ] No task rolled back twice
- [ ] Correct rollback order (reverse topological)

---

### CHAOS-003: Component Crash Recovery

**Objective:** Validate system recovery after component crashes.

**Configuration:**
```typescript
const scenario = {
  name: "component_crash_recovery",
  duration: "45m",
  workload: steadyState,
  failures: {
    "process.crash": {
      enabled: true,
      components: ["proof_generator", "scheduler", "ledger"],
      probability: 0.0005,
      recoveryMs: 5000,
    },
  },
  invariants: ["dag_acyclic", "stake_consistency", "bounded_speculation_time"],
};
```

**Expected Behavior:**
- Components crash randomly
- Recovery from persistent state
- No duplicate processing

**Success Criteria:**
- [ ] System recovers from all crashes
- [ ] No data loss
- [ ] No duplicate commitments

---

### CHAOS-004: Memory Pressure

**Objective:** Validate behavior under memory pressure with wide DAGs.

**Configuration:**
```typescript
const scenario = {
  name: "memory_pressure",
  duration: "30m",
  workload: wideDAG,
  failures: {
    "process.oom": {
      enabled: true,
      component: "state_store",
      threshold: 0.9,  // 90% memory
    },
  },
  invariants: ["memory_bounded", "queue_draining"],
};
```

**Expected Behavior:**
- Memory stays within limits
- Backpressure applied when needed
- Graceful degradation, not crash

**Success Criteria:**
- [ ] Peak memory < 4GB
- [ ] No OOM kills
- [ ] Tasks still make progress

---

### CHAOS-005: Race Condition Hunt

**Objective:** Find race conditions through randomized timing.

**Configuration:**
```typescript
const scenario = {
  name: "race_condition_hunt",
  duration: "60m",
  workload: burstLoad,
  failures: {
    "data.reorder": {
      enabled: true,
      window: 50,  // Aggressive reordering
    },
    "network.latency": {
      enabled: true,
      minMs: 0,
      maxMs: 200,
      probability: 0.3,
    },
  },
  invariants: ["all"],  // Check all invariants
  options: {
    seeds: [12345, 54321, 11111, 22222, 33333],  // Multiple runs
  },
};
```

**Expected Behavior:**
- Random timing variations expose races
- Multiple seeds for coverage
- Any invariant violation = bug found

**Success Criteria:**
- [ ] Zero invariant violations across all seeds
- [ ] Deterministic behavior despite timing variations

---

### CHAOS-006: Blockchain Reorg Handling

**Objective:** Validate handling of blockchain reorganizations.

**Configuration:**
```typescript
const scenario = {
  name: "blockchain_reorg",
  duration: "30m",
  workload: steadyState,
  failures: {
    "chain.reorg": {
      enabled: true,
      depth: 3,
      probability: 0.001,  // Rare but significant
    },
    "chain.slot_skip": {
      enabled: true,
      count: 2,
      probability: 0.01,
    },
  },
  invariants: ["proof_ordering", "confirmed_immutable", "stake_consistency"],
};
```

**Expected Behavior:**
- Reorg detected via finality tracking
- Affected proofs re-evaluated
- No false confirmations

**Success Criteria:**
- [ ] Reorgs detected and handled
- [ ] No proof submitted against invalid state
- [ ] Recovery without manual intervention

---

## 6. Fuzz Testing

### 6.1 API Fuzzing

```typescript
const apiFuzzer = {
  targets: [
    {
      method: "createCommitment",
      schema: {
        taskId: { type: "string", fuzz: "random_string(32)" },
        agentId: { type: "pubkey", fuzz: "random_pubkey" },
        depth: { type: "u32", fuzz: "random_int(0, 100)" },
        stake: { type: "u64", fuzz: "random_int(0, 10**18)" },
      },
    },
    {
      method: "markFailed",
      schema: {
        taskId: { type: "string", fuzz: "from_existing | random" },
        reason: { type: "string", fuzz: "random_string(256)" },
      },
    },
    {
      method: "rollback",
      schema: {
        taskId: { type: "string", fuzz: "from_existing | random" },
      },
    },
  ],
  iterations: 100000,
  oracles: ["no_crash", "invariants_hold"],
};
```

### 6.2 State Fuzzing

```typescript
const stateFuzzer = {
  description: "Generate random valid states and validate transitions",
  stateGenerator: {
    maxTasks: 1000,
    maxDepth: 20,
    statusDistribution: {
      PENDING: 0.5,
      CONFIRMED: 0.4,
      FAILED: 0.1,
    },
  },
  transitionGenerator: {
    operations: ["confirm", "fail", "rollback", "add_task"],
    distribution: "uniform",
  },
  oracle: (preState, operation, postState) => {
    return validateAllInvariants(postState);
  },
};
```

### 6.3 Input Fuzzing

```typescript
const inputFuzzer = {
  description: "Fuzz inputs to find edge cases",
  generators: {
    taskId: [
      "empty_string",
      "max_length_string(1024)",
      "unicode_string",
      "null_bytes",
      "special_chars",
    ],
    depth: [
      "negative",
      "zero",
      "max_u32",
      "overflow",
    ],
    stake: [
      "zero",
      "one",
      "max_u64",
      "overflow",
    ],
  },
};
```

---

## 7. Test Execution

### 7.1 Running Chaos Tests

```bash
# Full chaos suite
pnpm chaos:run --duration 2h --profile all

# Specific scenario
pnpm chaos:run --scenario network_partition_resilience

# With specific seed (reproducible)
pnpm chaos:run --scenario race_condition_hunt --seed 12345

# Dry run (validate config)
pnpm chaos:run --dry-run --scenario cascade_rollback_stress

# Generate report
pnpm chaos:report --run-id abc123
```

### 7.2 Duration and Load Parameters

| Scenario | Duration | Tasks/sec | Expected Failures |
|----------|----------|-----------|-------------------|
| Quick smoke | 5m | 5 | Few |
| Standard | 30m | 10 | Moderate |
| Extended | 2h | 20 | Many |
| Soak | 24h | 5 | Variable |

### 7.3 Resource Requirements

| Test Type | CPU Cores | Memory | Disk |
|-----------|-----------|--------|------|
| Unit chaos | 2 | 4GB | 10GB |
| Integration chaos | 4 | 8GB | 50GB |
| Full chaos suite | 8 | 16GB | 100GB |
| Soak test | 4 | 8GB | 200GB |

---

## 8. Success Criteria

### 8.1 Per-Test Success

| Criteria | Threshold | Notes |
|----------|-----------|-------|
| Critical invariant violations | 0 | Any violation = failure |
| High severity violations | ≤1 | Investigate all |
| Recovery time | <2× failure duration | Must recover |
| Data loss | 0 | No lost commitments |

### 8.2 Overall Chaos Campaign Success

| Metric | Target |
|--------|--------|
| Total scenarios passed | 100% |
| Unique bugs found | Document all |
| Mean time to recovery | <30 seconds |
| Invariant check coverage | 100% |

### 8.3 Acceptance Gate

Before release, the following chaos tests must pass:
- [ ] `network_partition_resilience` - 30 minutes, zero violations
- [ ] `cascade_rollback_stress` - 20 minutes, correct ordering
- [ ] `component_crash_recovery` - 45 minutes, full recovery
- [ ] `race_condition_hunt` - 60 minutes, 5 seeds, zero violations

---

## 9. Reporting

### 9.1 Report Structure

```typescript
interface ChaosReport {
  runId: string;
  scenario: string;
  duration: Duration;
  startTime: Date;
  endTime: Date;
  
  summary: {
    passed: boolean;
    totalOperations: number;
    failuresInjected: number;
    invariantChecks: number;
    violations: InvariantViolation[];
  };
  
  timeline: TimelineEvent[];
  
  metrics: {
    p50LatencyMs: number;
    p99LatencyMs: number;
    maxMemoryMB: number;
    rollbackCount: number;
    recoveryTimeMs: number[];
  };
  
  recommendations: string[];
}
```

### 9.2 Violation Documentation

```typescript
interface InvariantViolation {
  invariant: string;
  severity: "critical" | "high" | "medium";
  timestamp: Date;
  message: string;
  context: {
    systemState: Partial<SystemState>;
    recentEvents: Event[];
    stackTrace?: string;
  };
  reproducible: boolean;
  seed?: number;
}
```
