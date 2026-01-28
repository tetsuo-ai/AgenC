# Performance Test Plan: Speculative Execution

> **Version:** 1.0  
> **Last Updated:** 2025-01-28  
> **Scope:** Performance benchmarks and load testing for speculative execution

## Overview

This document specifies performance tests to validate that speculative execution delivers the expected latency improvements while maintaining acceptable throughput and resource utilization.

**Key Goals:**
- Validate 2-3× latency reduction claim
- Establish baseline and regression thresholds
- Identify scalability limits
- Measure resource overhead

---

## 1. Latency Benchmarks

### 1.1 End-to-End Latency: Without Speculation

**Objective:** Establish baseline latency for sequential execution.

**Scenario:** Linear chain of 3 dependent tasks, executed sequentially.

```
Task A → Task B → Task C

Timeline (Sequential):
A: [execute......] [proof....] [confirm]
B: ──────────────────────────── [execute......] [proof....] [confirm]
C: ──────────────────────────────────────────── [execute......] [proof....] [confirm]

Total: 3 × (execute + proof + confirm)
```

**Test Configuration:**
```typescript
const baselineLatencyTest = {
  name: "baseline_latency_no_speculation",
  tasks: 3,
  chainType: "linear",
  speculation: false,
  iterations: 100,
  warmupIterations: 10,
  
  measure: {
    e2eLatency: "time from first task create to last task confirm",
    perTaskLatency: "individual task execution time",
    proofLatency: "proof generation time",
    confirmLatency: "on-chain confirmation time",
  },
};
```

**Expected Results:**
| Metric | Expected | Tolerance |
|--------|----------|-----------|
| Execute time | ~1000ms | ±200ms |
| Proof time | ~500ms | ±100ms |
| Confirm time | ~2000ms | ±500ms |
| **E2E (3 tasks)** | ~10.5s | - |

---

### 1.2 End-to-End Latency: With Speculation

**Objective:** Measure latency improvement with speculative execution.

**Scenario:** Same 3-task chain with speculation enabled.

```
Timeline (Speculative):
A: [execute......] [proof....] ─────────── [confirm]
B: ──── [speculate] [execute......] [proof deferred...] [confirm]
C: ──────────────── [speculate] [execute......] [proof deferred...] [confirm]

Total: execute_A + max(proof_A + confirm_A, execute_B, execute_C) + confirm_B + confirm_C
```

**Test Configuration:**
```typescript
const speculativeLatencyTest = {
  name: "speculative_latency",
  tasks: 3,
  chainType: "linear",
  speculation: true,
  specConfig: {
    mode: "balanced",
    max_depth: 5,
  },
  iterations: 100,
  warmupIterations: 10,
  
  measure: {
    e2eLatency: "time from first task create to last task confirm",
    speculationDepth: "max concurrent speculation depth",
    parallelExecutions: "tasks executing in parallel",
    proofQueueTime: "time proofs spend in deferral queue",
  },
};
```

**Expected Results:**
| Metric | Expected | Improvement |
|--------|----------|-------------|
| E2E (3 tasks, speculation) | ~5s | 2.1× faster |
| Speculation depth | 2 | - |
| Parallel executions | 2-3 | - |

---

### 1.3 Latency Comparison Matrix

**Test Matrix:**
| Chain Length | Without Speculation | With Speculation | Speedup |
|--------------|--------------------|--------------------|---------|
| 2 tasks | ~7s | ~4s | 1.75× |
| 3 tasks | ~10.5s | ~5s | 2.1× |
| 5 tasks | ~17.5s | ~6s | 2.9× |
| 10 tasks | ~35s | ~8s | 4.4× |

**Test Code:**
```typescript
async function benchmarkLatency(chainLength: number, speculation: boolean): Promise<LatencyResult> {
  const startTime = performance.now();
  
  // Create chain
  const tasks = [];
  for (let i = 0; i < chainLength; i++) {
    tasks.push(await createTask({
      id: `task-${i}`,
      dependsOn: i > 0 ? `task-${i - 1}` : null,
    }));
  }
  
  // Execute with or without speculation
  if (speculation) {
    await executeWithSpeculation(tasks);
  } else {
    await executeSequential(tasks);
  }
  
  // Wait for all confirmations
  await waitForAllConfirmed(tasks);
  
  const endTime = performance.now();
  return {
    e2eLatencyMs: endTime - startTime,
    chainLength,
    speculation,
  };
}
```

---

### 1.4 Latency Percentiles

**Objective:** Measure latency distribution, not just averages.

**Configuration:**
```typescript
const percentileTest = {
  iterations: 1000,
  measure: ["p50", "p75", "p90", "p95", "p99", "max"],
};
```

**Expected Results:**
| Percentile | Without Speculation | With Speculation |
|------------|--------------------|--------------------|
| P50 | 10.2s | 4.8s |
| P90 | 12.5s | 6.2s |
| P99 | 15.0s | 8.5s |
| Max | 18.0s | 12.0s |

**Success Criteria:**
- P50 improvement ≥ 2×
- P99 improvement ≥ 1.5×
- Max latency under speculation ≤ 2× baseline max

---

## 2. Throughput Benchmarks

### 2.1 Tasks Per Second: Baseline

**Objective:** Measure maximum throughput without speculation.

**Configuration:**
```typescript
const baselineThroughputTest = {
  name: "baseline_throughput",
  duration: "5m",
  targetTasksPerSecond: "max",
  taskDistribution: {
    rootTasks: 0.5,
    linearChain: 0.3,
    dagBranch: 0.2,
  },
  speculation: false,
  
  measure: {
    peakThroughput: "max sustained tasks/second",
    avgThroughput: "average over duration",
    errorRate: "percentage of failed tasks",
  },
};
```

**Expected Results:**
| Metric | Expected |
|--------|----------|
| Peak throughput | 20 tasks/sec |
| Sustained throughput | 15 tasks/sec |
| Error rate | <1% |

---

### 2.2 Tasks Per Second: With Speculation

**Objective:** Measure throughput impact of speculation.

**Hypothesis:** Throughput may decrease slightly due to speculation overhead, but latency improvement compensates.

**Configuration:**
```typescript
const speculativeThroughputTest = {
  name: "speculative_throughput",
  duration: "5m",
  targetTasksPerSecond: "max",
  taskDistribution: {
    rootTasks: 0.5,
    linearChain: 0.3,
    dagBranch: 0.2,
  },
  speculation: true,
  specConfig: {
    mode: "balanced",
    max_depth: 5,
    max_parallel_branches: 4,
  },
  
  measure: {
    peakThroughput: "max sustained tasks/second",
    speculativeOverhead: "% CPU for speculation management",
    rollbackRate: "% of tasks that required rollback",
  },
};
```

**Expected Results:**
| Metric | Expected |
|--------|----------|
| Peak throughput | 18 tasks/sec |
| Sustained throughput | 14 tasks/sec |
| Speculation overhead | <10% CPU |
| Rollback rate | <5% |

---

### 2.3 Throughput Under Load Profiles

**Test Matrix:**

| Profile | Tasks/sec | Duration | Success Criteria |
|---------|-----------|----------|------------------|
| Light | 5 | 10m | 100% success |
| Normal | 15 | 10m | >99% success |
| Heavy | 30 | 10m | >95% success |
| Peak | 50 | 5m | >90% success |
| Overload | 100 | 2m | Graceful degradation |

**Test Code:**
```typescript
async function benchmarkThroughput(profile: ThroughputProfile): Promise<ThroughputResult> {
  const results = {
    totalTasks: 0,
    successfulTasks: 0,
    failedTasks: 0,
    rolledBackTasks: 0,
    throughputSamples: [] as number[],
  };
  
  const startTime = Date.now();
  const endTime = startTime + profile.durationMs;
  
  let lastSampleTime = startTime;
  let tasksSinceLastSample = 0;
  
  while (Date.now() < endTime) {
    // Submit tasks at target rate
    const tasksToSubmit = calculateTasksToSubmit(profile.tasksPerSecond);
    
    for (let i = 0; i < tasksToSubmit; i++) {
      const task = await submitTask(generateTask(profile.distribution));
      results.totalTasks++;
      
      task.onComplete((status) => {
        if (status === "confirmed") results.successfulTasks++;
        else if (status === "failed") results.failedTasks++;
        else if (status === "rolled_back") results.rolledBackTasks++;
      });
      
      tasksSinceLastSample++;
    }
    
    // Sample throughput every second
    if (Date.now() - lastSampleTime > 1000) {
      results.throughputSamples.push(tasksSinceLastSample);
      tasksSinceLastSample = 0;
      lastSampleTime = Date.now();
    }
    
    await sleep(1000 / profile.tasksPerSecond);
  }
  
  return results;
}
```

---

### 2.4 Effective Throughput (Accounting for Rollbacks)

**Metric:** Useful work completed, excluding rolled-back tasks.

```
Effective Throughput = (Confirmed Tasks - Rolled Back Tasks) / Duration
```

**Expected Results:**
| Mode | Raw Throughput | Rollback Rate | Effective Throughput |
|------|----------------|---------------|---------------------|
| No speculation | 15/sec | 0% | 15/sec |
| Conservative | 14/sec | 2% | 13.7/sec |
| Balanced | 13/sec | 4% | 12.5/sec |
| Aggressive | 12/sec | 8% | 11/sec |

---

## 3. Memory Benchmarks

### 3.1 Memory Under Deep Chains

**Objective:** Measure memory growth with speculation depth.

**Configuration:**
```typescript
const memoryDepthTest = {
  name: "memory_depth_scaling",
  depths: [1, 2, 5, 10, 15, 20],
  tasksPerDepth: 100,
  
  measure: {
    heapUsed: "V8 heap used (MB)",
    heapTotal: "V8 heap total (MB)",
    external: "external memory (MB)",
    stateSnapshots: "memory for state snapshots",
    graphSize: "dependency graph memory",
  },
};
```

**Expected Results:**
| Max Depth | Heap Used | State Snapshots | Total |
|-----------|-----------|-----------------|-------|
| 1 | 100MB | 50MB | 150MB |
| 5 | 200MB | 200MB | 400MB |
| 10 | 300MB | 500MB | 800MB |
| 20 | 400MB | 1GB | 1.4GB |

**Memory Model:**
```
Total Memory ≈ Base + (depth × snapshotSize) + (nodeCount × nodeOverhead)

Where:
- Base ≈ 100MB
- snapshotSize ≈ 50MB per depth level (state diff)
- nodeOverhead ≈ 1KB per node
```

---

### 3.2 Memory Under Wide DAGs

**Objective:** Measure memory growth with parallel branches.

**Configuration:**
```typescript
const memoryWidthTest = {
  name: "memory_width_scaling",
  branches: [2, 4, 8, 16, 32],
  depth: 3,
  
  measure: {
    concurrentSnapshots: "active state snapshots",
    graphMemory: "graph structure memory",
    commitmentLedgerSize: "commitment storage",
  },
};
```

**Expected Results:**
| Branches | Concurrent Snapshots | Graph Memory | Total |
|----------|---------------------|--------------|-------|
| 2 | 150MB | 10MB | 260MB |
| 4 | 300MB | 20MB | 420MB |
| 8 | 600MB | 50MB | 750MB |
| 16 | 1.2GB | 100MB | 1.4GB |

---

### 3.3 Memory Leak Detection

**Objective:** Ensure no memory leaks over extended operation.

**Configuration:**
```typescript
const memoryLeakTest = {
  name: "memory_leak_detection",
  duration: "4h",
  tasksPerSecond: 10,
  sampleIntervalMs: 60000,
  
  measure: {
    memoryTrend: "linear regression slope of heap usage",
    gcPauses: "garbage collection pause times",
  },
  
  successCriteria: {
    maxTrend: 0.1,  // MB/minute growth
    maxGcPause: 100,  // ms
  },
};
```

**Analysis:**
```typescript
function analyzeMemoryLeak(samples: MemorySample[]): LeakAnalysis {
  // Calculate linear regression
  const times = samples.map((s, i) => i);
  const values = samples.map(s => s.heapUsed);
  
  const slope = linearRegression(times, values).slope;
  const correlation = pearsonCorrelation(times, values);
  
  return {
    trendMBPerMinute: slope,
    correlation,
    isLeaking: slope > 0.1 && correlation > 0.8,
  };
}
```

---

### 3.4 Memory Under Rollback

**Objective:** Ensure rollback properly releases memory.

**Test:**
1. Create deep speculation chain (10 levels)
2. Measure memory
3. Trigger cascade rollback
4. Force GC
5. Measure memory again

**Success Criteria:**
- Post-rollback memory within 10% of pre-speculation baseline
- All state snapshots released
- No orphaned references

---

## 4. Component-Specific Benchmarks

### 4.1 DependencyGraph Performance

| Operation | Input Size | Expected Time | Max Time |
|-----------|------------|---------------|----------|
| `addNode` | 1 node | <1ms | 5ms |
| `addNode` (1000 existing) | 1 node | <2ms | 10ms |
| `getAncestors` | depth 10 | <5ms | 20ms |
| `getDescendants` | 100 descendants | <10ms | 50ms |
| `topologicalSort` | 1000 nodes | <50ms | 200ms |
| `getDepth` (cached) | 1 query | <0.1ms | 1ms |

**Test Code:**
```typescript
async function benchmarkDependencyGraph(): Promise<BenchmarkResult[]> {
  const results = [];
  
  // addNode scaling
  for (const size of [100, 1000, 10000]) {
    const graph = new DependencyGraph();
    for (let i = 0; i < size - 1; i++) {
      graph.addNode(`node-${i}`, i > 0 ? `node-${i - 1}` : null);
    }
    
    const start = performance.now();
    graph.addNode(`node-${size}`, `node-${size - 1}`);
    const duration = performance.now() - start;
    
    results.push({ operation: 'addNode', size, durationMs: duration });
  }
  
  // getAncestors scaling
  for (const depth of [5, 10, 20, 50]) {
    const graph = createLinearChain(depth);
    
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      graph.getAncestors(`node-${depth}`);
    }
    const duration = (performance.now() - start) / 100;
    
    results.push({ operation: 'getAncestors', depth, durationMs: duration });
  }
  
  return results;
}
```

---

### 4.2 CommitmentLedger Performance

| Operation | Commitments | Expected Time | Max Time |
|-----------|-------------|---------------|----------|
| `create` | - | <5ms | 20ms |
| `get` | 1000 existing | <1ms | 5ms |
| `markFailed` (no cascade) | - | <5ms | 20ms |
| `markFailed` (10 descendants) | - | <20ms | 100ms |
| `getTotalStake(agent)` | 100 commitments | <10ms | 50ms |

---

### 4.3 ProofDeferralManager Performance

| Operation | Queue Size | Expected Time | Max Time |
|-----------|------------|---------------|----------|
| `enqueue` | 1000 existing | <2ms | 10ms |
| `dequeueReady` | 100 ready | <5ms | 20ms |
| `checkTimeouts` | 1000 items | <10ms | 50ms |
| `onAncestorConfirmed` | 50 dependents | <10ms | 50ms |

---

### 4.4 RollbackController Performance

| Operation | Cascade Size | Expected Time | Max Time |
|-----------|--------------|---------------|----------|
| Single rollback | 1 | <10ms | 50ms |
| Cascade (linear 5) | 5 | <50ms | 200ms |
| Cascade (linear 10) | 10 | <100ms | 500ms |
| Cascade (DAG 20) | 20 | <200ms | 1000ms |

---

## 5. Test Methodology

### 5.1 Environment

**Hardware Requirements:**
| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | SSD, 50GB | NVMe, 100GB |
| Network | 1 Gbps | 10 Gbps |

**Software:**
- Node.js 20+
- Solana local-validator 1.18+
- Prometheus + Grafana (for monitoring)

---

### 5.2 Test Harness

```typescript
class PerformanceTestHarness {
  private metrics: Metrics;
  private validator: LocalValidator;
  
  async setup(): Promise<void> {
    // Start fresh validator
    this.validator = await LocalValidator.start({
      resetOnStart: true,
      slots_per_epoch: 32,  // Fast epochs for testing
    });
    
    // Initialize metrics collection
    this.metrics = new Metrics({
      endpoint: "http://localhost:9090",
      interval: 1000,
    });
    
    // Deploy speculation program
    await deployProgram(this.validator);
    
    // Warmup JIT
    await this.runWarmup();
  }
  
  async runBenchmark<T>(
    name: string,
    fn: () => Promise<T>,
    options: BenchmarkOptions
  ): Promise<BenchmarkResult<T>> {
    const samples: T[] = [];
    const latencies: number[] = [];
    
    // Warmup
    for (let i = 0; i < options.warmup; i++) {
      await fn();
    }
    
    // Force GC before measurement
    if (global.gc) global.gc();
    
    // Measure
    for (let i = 0; i < options.iterations; i++) {
      const start = performance.now();
      const result = await fn();
      const end = performance.now();
      
      samples.push(result);
      latencies.push(end - start);
    }
    
    return {
      name,
      samples,
      stats: calculateStats(latencies),
    };
  }
  
  async teardown(): Promise<void> {
    await this.validator.stop();
    await this.metrics.flush();
  }
}

function calculateStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    stdDev: standardDeviation(values),
  };
}
```

---

### 5.3 Metrics Collection

**Key Metrics:**
```typescript
const metricsToCollect = {
  latency: {
    "speculation_e2e_latency_ms": "histogram",
    "speculation_execution_latency_ms": "histogram",
    "speculation_proof_latency_ms": "histogram",
    "speculation_confirm_latency_ms": "histogram",
  },
  throughput: {
    "speculation_tasks_total": "counter",
    "speculation_tasks_confirmed_total": "counter",
    "speculation_tasks_rolled_back_total": "counter",
    "speculation_tasks_in_flight": "gauge",
  },
  resources: {
    "speculation_memory_bytes": "gauge",
    "speculation_graph_nodes": "gauge",
    "speculation_pending_proofs": "gauge",
    "speculation_active_stakes_lamports": "gauge",
  },
  errors: {
    "speculation_errors_total": "counter",
    "speculation_timeouts_total": "counter",
  },
};
```

**Prometheus Recording Rules:**
```yaml
groups:
  - name: speculation_performance
    rules:
      - record: speculation:throughput:rate5m
        expr: rate(speculation_tasks_confirmed_total[5m])
      
      - record: speculation:latency:p99
        expr: histogram_quantile(0.99, rate(speculation_e2e_latency_ms_bucket[5m]))
      
      - record: speculation:rollback_rate:rate5m
        expr: rate(speculation_tasks_rolled_back_total[5m]) / rate(speculation_tasks_total[5m])
```

---

### 5.4 Statistical Rigor

**Iteration Count:**
- Quick benchmarks: 100 iterations
- Detailed benchmarks: 1000 iterations
- Latency distribution: 10000 iterations

**Confidence Intervals:**
```typescript
function confidenceInterval(values: number[], confidence: number): [number, number] {
  const mean = calculateMean(values);
  const stdErr = standardError(values);
  const z = zScore(confidence);  // e.g., 1.96 for 95%
  
  return [
    mean - z * stdErr,
    mean + z * stdErr,
  ];
}
```

**Outlier Handling:**
- Report with and without outliers
- Use median for robustness
- Flag runs with >5% outliers

---

## 6. Success Criteria

### 6.1 Latency Targets

| Metric | Target | Acceptable | Failure |
|--------|--------|------------|---------|
| 2-task chain speedup | ≥1.7× | ≥1.5× | <1.3× |
| 3-task chain speedup | ≥2.0× | ≥1.8× | <1.5× |
| 5-task chain speedup | ≥2.5× | ≥2.0× | <1.8× |
| P99 latency increase | <20% | <30% | >50% |

### 6.2 Throughput Targets

| Metric | Target | Acceptable | Failure |
|--------|--------|------------|---------|
| Throughput impact | <5% decrease | <10% decrease | >20% decrease |
| Effective throughput | >95% of raw | >90% of raw | <85% of raw |
| Error rate | <1% | <3% | >5% |

### 6.3 Resource Targets

| Metric | Target | Acceptable | Failure |
|--------|--------|------------|---------|
| Memory (depth 5) | <500MB | <750MB | >1GB |
| Memory growth rate | <0.05 MB/min | <0.1 MB/min | >0.5 MB/min |
| CPU overhead | <5% | <10% | >20% |

### 6.4 Regression Thresholds

Any metric degrading by more than these amounts triggers investigation:
- Latency: >10% increase from baseline
- Throughput: >5% decrease from baseline
- Memory: >20% increase from baseline

---

## 7. Test Execution

### 7.1 Running Performance Tests

```bash
# Full performance suite
pnpm perf:run --suite full

# Latency benchmarks only
pnpm perf:run --suite latency

# Throughput benchmarks only
pnpm perf:run --suite throughput

# Memory benchmarks only
pnpm perf:run --suite memory

# Quick smoke test
pnpm perf:run --suite smoke --iterations 10

# With custom configuration
pnpm perf:run --config ./perf-config.json

# Generate report
pnpm perf:report --format html --output ./perf-report.html
```

### 7.2 CI Integration

```yaml
# .github/workflows/performance.yml
name: Performance Tests
on:
  pull_request:
    paths:
      - 'packages/speculation/**'
  schedule:
    - cron: '0 0 * * *'  # Nightly

jobs:
  performance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup
        run: pnpm install
        
      - name: Run Performance Tests
        run: pnpm perf:run --suite full
        
      - name: Check Regression
        run: pnpm perf:check-regression --baseline ./perf-baseline.json
        
      - name: Upload Results
        uses: actions/upload-artifact@v4
        with:
          name: perf-results
          path: ./perf-results/
```

### 7.3 Baseline Management

```bash
# Capture new baseline
pnpm perf:baseline --capture

# Compare against baseline
pnpm perf:baseline --compare

# Update baseline (after review)
pnpm perf:baseline --update
```

---

## 8. Reporting

### 8.1 Report Format

```typescript
interface PerformanceReport {
  timestamp: Date;
  gitCommit: string;
  environment: EnvironmentInfo;
  
  summary: {
    passed: boolean;
    latencySpeedup: number;
    throughputImpact: number;
    memoryOverhead: number;
  };
  
  latency: {
    baseline: LatencyResults;
    speculative: LatencyResults;
    speedup: Record<string, number>;
  };
  
  throughput: {
    raw: ThroughputResults;
    effective: ThroughputResults;
    rollbackRate: number;
  };
  
  memory: {
    baseline: MemoryResults;
    peak: MemoryResults;
    leakAnalysis: LeakAnalysis;
  };
  
  components: ComponentBenchmarks;
  
  recommendations: string[];
}
```

### 8.2 Dashboard

**Grafana Dashboard Panels:**
1. Latency Over Time (with speculation vs without)
2. Throughput (tasks/sec with breakdown)
3. Memory Usage (with alerts)
4. Rollback Rate
5. Component Latencies (heatmap)
6. Error Rates

---

## 9. Tools

### 9.1 Required Tools

| Tool | Purpose | Version |
|------|---------|---------|
| Node.js | Runtime | 20+ |
| clinic.js | Profiling | latest |
| autocannon | Load testing | latest |
| prometheus | Metrics | 2.40+ |
| grafana | Visualization | 9+ |

### 9.2 Custom Tools

```bash
# CPU profiling
pnpm perf:profile --type cpu --duration 60

# Memory profiling
pnpm perf:profile --type heap --snapshots 5

# Flame graph
pnpm perf:flame --output flame.svg
```
