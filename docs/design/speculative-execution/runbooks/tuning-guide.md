# Speculative Execution Performance Tuning Guide

> **Target Audience:** SRE, Performance Engineers, Platform Engineers  
> **Last Updated:** 2025-01-28  
> **Review Cycle:** Quarterly or after significant changes

## Table of Contents
- [Workload Characterization](#workload-characterization)
- [Tuning Parameters](#tuning-parameters)
- [Scenario-Based Configurations](#scenario-based-configurations)
- [Benchmarking Methodology](#benchmarking-methodology)
- [Before/After Comparison Template](#beforeafter-comparison-template)

---

## Workload Characterization

Before tuning, understand your workload. Different workloads require different configurations.

### Workload Profiling Script

```bash
#!/bin/bash
# workload-profile.sh - Run for 1 hour to characterize workload

echo "=== Workload Profile ==="
echo "Sample Period: $(date -u '+%Y-%m-%d %H:%M UTC') - 1 hour"
echo ""

METRICS_URL="http://localhost:9090/api/v1/query"

# Task throughput
TASK_RATE=$(curl -s "$METRICS_URL?query=rate(speculation_tasks_total[1h])*60" | jq -r '.data.result[0].value[1]')
echo "Task Rate: ${TASK_RATE} tasks/min"

# Speculation depth distribution
echo "Depth Distribution:"
for d in 1 2 3 4 5; do
  COUNT=$(curl -s "$METRICS_URL?query=sum(speculation_depth_histogram_bucket{le=\"$d\"})" | jq -r '.data.result[0].value[1]')
  echo "  Depth ≤$d: $COUNT"
done

# Proof generation time
PROOF_P50=$(curl -s "$METRICS_URL?query=histogram_quantile(0.5,rate(speculation_proof_generation_seconds_bucket[1h]))" | jq -r '.data.result[0].value[1]')
PROOF_P99=$(curl -s "$METRICS_URL?query=histogram_quantile(0.99,rate(speculation_proof_generation_seconds_bucket[1h]))" | jq -r '.data.result[0].value[1]')
echo "Proof Generation: p50=${PROOF_P50}s, p99=${PROOF_P99}s"

# Rollback rate
ROLLBACK_RATE=$(curl -s "$METRICS_URL?query=sum(rate(speculation_rollback_total[1h]))/sum(rate(speculation_tasks_total[1h]))*100" | jq -r '.data.result[0].value[1]')
echo "Rollback Rate: ${ROLLBACK_RATE}%"

# Memory usage
MEMORY=$(curl -s "$METRICS_URL?query=avg_over_time(speculation_memory_usage_bytes[1h])/1024/1024" | jq -r '.data.result[0].value[1]')
echo "Avg Memory: ${MEMORY} MB"

# Peak concurrent tasks
PEAK_ACTIVE=$(curl -s "$METRICS_URL?query=max_over_time(speculation_active_tasks[1h])" | jq -r '.data.result[0].value[1]')
echo "Peak Active Tasks: $PEAK_ACTIVE"
```

### Workload Types

| Workload Type | Characteristics | Recommended Focus |
|---------------|-----------------|-------------------|
| **High Volume / Shallow** | Many tasks, low depth (1-2) | Maximize throughput, proof batching |
| **Deep Chains** | Fewer tasks, deep dependencies (5+) | Optimize depth, careful rollback policy |
| **Burst Traffic** | Spiky load patterns | Queue sizing, auto-scaling |
| **Steady State** | Consistent load | Resource efficiency, cost optimization |
| **Mixed** | Combination of above | Balanced defaults, adaptive tuning |

### Workload Classification Matrix

```
               Low Volume (<100/min)    High Volume (>1000/min)
             ┌────────────────────────┬────────────────────────┐
Shallow      │  Conservative          │  Throughput-optimized  │
(depth ≤ 3)  │  - max_depth: 3        │  - max_depth: 5        │
             │  - parallel: 2         │  - parallel: 8         │
             │  - batch: 10           │  - batch: 50           │
             ├────────────────────────┼────────────────────────┤
Deep         │  Reliability-focused   │  Scale-out required    │
(depth > 3)  │  - max_depth: 5        │  - max_depth: 8        │
             │  - parallel: 4         │  - parallel: 16        │
             │  - rollback: cascade   │  - rollback: selective │
             └────────────────────────┴────────────────────────┘
```

---

## Tuning Parameters

### Core Parameters

#### `speculation.max_depth`

**What it does:** Maximum number of speculative tasks that can chain without confirmation.

**Trade-offs:**

| Lower (1-3) | Higher (5-10) |
|-------------|---------------|
| ✓ Smaller rollback blast radius | ✓ Higher throughput |
| ✓ Less memory usage | ✓ Better latency |
| ✗ More waiting for confirmation | ✗ Larger rollbacks when failures occur |
| ✗ Lower pipeline parallelism | ✗ Higher memory usage |

**Tuning guide:**

```bash
# Current effective depth (compare to configured)
EFFECTIVE_DEPTH=$(curl -s localhost:9090/metrics | grep 'speculation_depth_histogram' | tail -1)
echo "Effective max depth used: $EFFECTIVE_DEPTH"

# If tasks rarely exceed depth 3, reduce configured max
# If tasks frequently hit max, consider increasing
```

| Condition | Action |
|-----------|--------|
| Actual depth < configured - 2 | Reduce max_depth (save memory) |
| Actual depth = configured frequently | Consider increasing |
| Rollback rate > 10% | Reduce max_depth |
| Rollback blast radius > 20 tasks | Reduce max_depth |

---

#### `speculation.max_parallel_branches`

**What it does:** Maximum concurrent speculative execution paths.

**Memory impact:** ~100-200 MB per branch for state snapshots.

**Trade-offs:**

| Lower (1-2) | Higher (8-16) |
|-------------|---------------|
| ✓ Lower memory footprint | ✓ Higher parallelism |
| ✓ Simpler debugging | ✓ Better resource utilization |
| ✗ Serialized execution | ✗ Complex state management |
| ✗ Underutilized resources | ✗ Potential for conflicts |

**Tuning guide:**

```bash
# Check actual parallelism
ACTUAL_PARALLEL=$(curl -s localhost:9090/metrics | grep 'speculation_active_branches' | awk '{print $2}')
MAX_PARALLEL=$(agenc config show --section speculation | grep max_parallel | awk '{print $2}')
echo "Active: $ACTUAL_PARALLEL / $MAX_PARALLEL"

# Check memory per branch
MEMORY_MB=$(curl -s localhost:9090/metrics | grep 'speculation_memory_usage_bytes' | awk '{printf "%.0f", $2/1024/1024}')
PER_BRANCH=$((MEMORY_MB / ACTUAL_PARALLEL))
echo "Memory per branch: ~${PER_BRANCH} MB"
```

---

#### `speculation.confirmation_timeout_ms`

**What it does:** How long to wait for on-chain confirmation.

**Trade-offs:**

| Lower (10-30s) | Higher (60-120s) |
|----------------|------------------|
| ✓ Faster failure detection | ✓ Tolerant of network delays |
| ✓ Quicker resource cleanup | ✓ Handles RPC slowdowns |
| ✗ False timeouts during congestion | ✗ Stale state held longer |
| ✗ May waste valid work | ✗ Slower recovery from stuck tasks |

**Tuning guide:**

```bash
# Check actual confirmation times
CONFIRM_P99=$(curl -s localhost:9090/api/v1/query?query=histogram_quantile(0.99,rate(solana_confirmation_seconds_bucket[1h])) | jq -r '.data.result[0].value[1]')
echo "Actual p99 confirmation time: ${CONFIRM_P99}s"

# Timeout should be > p99 + buffer
# Recommended: 2x p99 confirmation time
```

---

#### `speculation.proof.worker_threads`

**What it does:** Number of parallel proof generation threads.

**Trade-offs:**

| Lower (2-4) | Higher (8-16) |
|-------------|---------------|
| ✓ Lower CPU usage | ✓ Faster proof throughput |
| ✓ Less heat generation | ✓ Lower queue depth |
| ✗ Higher queue latency | ✗ CPU contention possible |
| ✗ Backpressure risk | ✗ Memory pressure |

**Tuning guide:**

```bash
# Check CPU utilization on proof workers
kubectl top pods -l component=proof-worker

# Check queue depth trend
QUEUE_DEPTH=$(curl -s localhost:9090/metrics | grep 'speculation_proof_queue_depth' | awk '{print $2}')
QUEUE_CAPACITY=$(curl -s localhost:9090/metrics | grep 'speculation_proof_queue_capacity' | awk '{print $2}')
UTILIZATION=$((QUEUE_DEPTH * 100 / QUEUE_CAPACITY))
echo "Queue utilization: ${UTILIZATION}%"

# If >70%, increase workers
# If <30% consistently, reduce workers
```

---

#### `speculation.proof.batch_size`

**What it does:** Number of proofs batched together.

**Trade-offs:**

| Smaller (5-10) | Larger (30-50) |
|----------------|----------------|
| ✓ Lower latency per proof | ✓ Better throughput |
| ✓ Faster individual response | ✓ Amortized overhead |
| ✗ Higher per-proof overhead | ✗ Higher latency |
| ✗ More I/O operations | ✗ Bursty resource usage |

**Tuning guide:**

```bash
# Check batch efficiency
PROOFS_PER_BATCH=$(curl -s localhost:9090/metrics | grep 'speculation_proof_batch_size' | awk '{print $2}')
echo "Actual avg batch size: $PROOFS_PER_BATCH"

# If actual << configured, reduce batch_size (tasks not waiting)
# If queue growing, increase batch_size (more efficiency)
```

---

### Memory Parameters

#### `speculation.limits.max_memory_mb`

**Sizing formula:**

```
Required Memory = (max_parallel_branches × avg_state_size_mb) 
                + (max_pending_operations × 1kb per op)
                + (proof_cache_mb)
                + (20% buffer)

Example:
  = (4 branches × 200 MB) + (10000 ops × 1 KB) + (512 MB) + 20%
  = 800 + 10 + 512 + 264
  = 1586 MB → Round to 2048 MB
```

---

#### `speculation.limits.max_state_snapshots`

**Sizing formula:**

```
Snapshots = max_depth × max_parallel_branches × safety_factor

Example:
  = 5 × 4 × 2.5
  = 50 snapshots
```

---

### Resource Limit Parameters

| Parameter | Formula | Example |
|-----------|---------|---------|
| `max_pending_operations` | `peak_task_rate × confirmation_timeout_s × 2` | `100/s × 60s × 2 = 12000` |
| `gc_interval_ms` | `max(5000, confirmation_timeout_ms / 4)` | `60000 / 4 = 15000` |
| `proof.queue_size` | `peak_task_rate × avg_proof_time_s × 3` | `100/s × 30s × 3 = 9000` |

---

## Scenario-Based Configurations

### Scenario 1: Low Latency Trading

**Goal:** Minimize end-to-end latency, accept higher rollback cost

```toml
[speculation]
enabled = true
mode = "aggressive"
max_depth = 8
max_parallel_branches = 8
confirmation_timeout_ms = 15000
rollback_policy = "selective"

[speculation.stake]
min_stake = 500_000
stake_per_depth = 50_000
slash_percentage = 0.05

[speculation.proof]
generator = "groth16"
worker_threads = 16
queue_size = 5000
batch_size = 5  # Small batches for latency
timeout_ms = 30000

[speculation.limits]
max_memory_mb = 16384
max_pending_operations = 100000
gc_interval_ms = 5000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = true
enable_optimistic_proofs = true
```

**Expected metrics:**
- p99 latency: < 2s
- Rollback rate: < 8%
- Memory usage: 8-12 GB

---

### Scenario 2: High Reliability / Conservative

**Goal:** Minimize rollbacks and stake risk, accept higher latency

```toml
[speculation]
enabled = true
mode = "conservative"
max_depth = 2
max_parallel_branches = 2
confirmation_timeout_ms = 90000
rollback_policy = "cascade"

[speculation.stake]
min_stake = 2_000_000
stake_per_depth = 1_000_000
slash_percentage = 0.15
cooldown_period_ms = 600000

[speculation.proof]
generator = "groth16"
worker_threads = 4
queue_size = 1000
batch_size = 20
timeout_ms = 180000

[speculation.limits]
max_memory_mb = 4096
max_pending_operations = 10000
gc_interval_ms = 30000

[speculation.features]
enable_parallel_speculation = false
enable_cross_agent_speculation = false
enable_optimistic_proofs = false
```

**Expected metrics:**
- p99 latency: 5-10s
- Rollback rate: < 1%
- Memory usage: 2-3 GB

---

### Scenario 3: Cost Optimized

**Goal:** Minimize resource usage while maintaining functionality

```toml
[speculation]
enabled = true
mode = "balanced"
max_depth = 3
max_parallel_branches = 2
confirmation_timeout_ms = 60000
rollback_policy = "cascade"

[speculation.stake]
min_stake = 1_000_000
stake_per_depth = 200_000
slash_percentage = 0.1

[speculation.proof]
generator = "groth16"
worker_threads = 2
queue_size = 500
batch_size = 30  # Large batches for efficiency
timeout_ms = 120000

[speculation.limits]
max_memory_mb = 2048
max_pending_operations = 5000
max_state_snapshots = 25
gc_interval_ms = 10000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = false
enable_optimistic_proofs = true
```

**Expected metrics:**
- p99 latency: 3-5s
- Rollback rate: < 5%
- Memory usage: 1-2 GB
- CPU usage: Minimal

---

### Scenario 4: Burst Traffic Handling

**Goal:** Handle 10x traffic spikes without degradation

```toml
[speculation]
enabled = true
mode = "balanced"
max_depth = 5
max_parallel_branches = 16  # High for bursts
confirmation_timeout_ms = 45000
rollback_policy = "selective"

[speculation.stake]
min_stake = 1_000_000
stake_per_depth = 300_000
slash_percentage = 0.08

[speculation.proof]
generator = "groth16"
worker_threads = 12
queue_size = 10000  # Large queue for bursts
batch_size = 40
timeout_ms = 90000

[speculation.limits]
max_memory_mb = 12288  # Large for burst state
max_pending_operations = 75000
max_state_snapshots = 200
gc_interval_ms = 10000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = false
enable_optimistic_proofs = true
```

**Expected metrics:**
- Handles 10x normal traffic
- p99 latency: < 5s at baseline, < 15s during burst
- Graceful degradation, not failure

---

## Benchmarking Methodology

### Pre-Benchmark Checklist

- [ ] Baseline metrics captured (24h)
- [ ] Test environment isolated or canary
- [ ] Rollback config prepared
- [ ] Monitoring dashboards ready
- [ ] Alert thresholds adjusted for test

### Benchmark Test Suite

```bash
#!/bin/bash
# benchmark-speculation.sh

RESULTS_DIR="benchmark_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "=== Speculation Benchmark Suite ==="
echo "Results directory: $RESULTS_DIR"

# Capture starting state
agenc admin status --component speculation > "$RESULTS_DIR/pre_status.txt"
curl -s localhost:9090/metrics | grep speculation > "$RESULTS_DIR/pre_metrics.txt"

# Test 1: Throughput Test
echo "Test 1: Throughput (5 min)"
agenc benchmark speculation \
  --duration 5m \
  --rate 100 \
  --depth-distribution "uniform:1-5" \
  --output "$RESULTS_DIR/throughput.json"

# Test 2: Latency Test  
echo "Test 2: Latency (5 min)"
agenc benchmark speculation \
  --duration 5m \
  --rate 50 \
  --measure-latency \
  --output "$RESULTS_DIR/latency.json"

# Test 3: Deep Chain Test
echo "Test 3: Deep Chains (5 min)"
agenc benchmark speculation \
  --duration 5m \
  --rate 20 \
  --depth-distribution "fixed:8" \
  --output "$RESULTS_DIR/deep_chain.json"

# Test 4: Burst Test
echo "Test 4: Burst Traffic (10 min)"
agenc benchmark speculation \
  --duration 10m \
  --rate-pattern "burst:10x:30s:every:2m" \
  --output "$RESULTS_DIR/burst.json"

# Test 5: Rollback Recovery
echo "Test 5: Rollback Recovery"
agenc benchmark speculation \
  --duration 5m \
  --rate 50 \
  --inject-failures 0.1 \
  --output "$RESULTS_DIR/rollback.json"

# Capture ending state
agenc admin status --component speculation > "$RESULTS_DIR/post_status.txt"
curl -s localhost:9090/metrics | grep speculation > "$RESULTS_DIR/post_metrics.txt"

# Generate report
agenc benchmark report \
  --input-dir "$RESULTS_DIR" \
  --output "$RESULTS_DIR/report.md"

echo "=== Benchmark Complete ==="
echo "Report: $RESULTS_DIR/report.md"
```

### Key Metrics to Measure

| Metric | How to Measure | Target |
|--------|----------------|--------|
| **Throughput** | Tasks completed per second | Varies by hardware |
| **Latency p50** | End-to-end time | < 1s |
| **Latency p99** | End-to-end time | < 5s |
| **Rollback Rate** | Rollbacks / Total | < 5% |
| **Memory Efficiency** | MB per active task | < 10 MB |
| **Proof Latency** | Generation time p99 | < 60s |
| **Recovery Time** | Time to recover from failure | < 30s |

### Statistical Significance

- Run each test at least 3 times
- Use median of results
- Ensure coefficient of variation < 10%
- Account for warm-up period (discard first minute)

---

## Before/After Comparison Template

### Tuning Change Report

```markdown
# Speculation Tuning Report

**Date:** YYYY-MM-DD
**Author:** [Name]
**Change ID:** TUNE-XXX

---

## Change Summary

**Parameter Changed:** speculation.max_depth
**Previous Value:** 5
**New Value:** 3
**Reason for Change:** High rollback blast radius observed

---

## Baseline Metrics (Before)

| Metric | Value | Source |
|--------|-------|--------|
| Task Throughput | 85 tasks/sec | Prometheus 24h avg |
| Latency p50 | 0.8s | Prometheus 24h |
| Latency p99 | 3.2s | Prometheus 24h |
| Rollback Rate | 8.5% | Prometheus 24h |
| Avg Rollback Size | 12 tasks | Prometheus 24h |
| Memory Usage | 6.2 GB | Prometheus 24h avg |
| Proof Latency p99 | 45s | Prometheus 24h |

---

## Post-Change Metrics (After)

| Metric | Value | Change | Better/Worse |
|--------|-------|--------|--------------|
| Task Throughput | 82 tasks/sec | -3.5% | Slightly worse |
| Latency p50 | 0.9s | +12.5% | Worse |
| Latency p99 | 2.8s | -12.5% | Better |
| Rollback Rate | 4.2% | -50.6% | Better |
| Avg Rollback Size | 4 tasks | -66.7% | Better |
| Memory Usage | 4.8 GB | -22.6% | Better |
| Proof Latency p99 | 42s | -6.7% | Better |

---

## Analysis

### Positive Impacts
- Rollback rate reduced by 50%
- Rollback blast radius reduced by 67%
- Memory usage reduced by 23%
- p99 latency improved

### Negative Impacts
- Slight throughput reduction (3.5%)
- p50 latency increased (12.5%)

### Net Assessment
**POSITIVE** - The trade-off is favorable. Reduced rollback risk and memory 
usage outweigh the minor throughput and median latency impact.

---

## Rollback Plan

If negative impacts unacceptable:
```bash
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 5}'
```

---

## Recommendation

**Keep the change.** Monitor for 1 week to confirm stability.

Schedule follow-up review: YYYY-MM-DD

---

## Appendix

### Grafana Dashboard Screenshots

[Before Screenshot]
[After Screenshot]

### Raw Benchmark Data

See attached: benchmark_results_before.json, benchmark_results_after.json
```

### Quick Comparison Script

```bash
#!/bin/bash
# compare-tuning.sh <before_metrics.txt> <after_metrics.txt>

BEFORE=$1
AFTER=$2

echo "=== Tuning Comparison ==="
echo ""

compare_metric() {
  local metric=$1
  local name=$2
  
  before_val=$(grep "^$metric " "$BEFORE" | awk '{print $2}')
  after_val=$(grep "^$metric " "$AFTER" | awk '{print $2}')
  
  if [[ -n "$before_val" && -n "$after_val" ]]; then
    change=$(echo "scale=1; ($after_val - $before_val) / $before_val * 100" | bc)
    printf "%-30s %12s → %12s (%+.1f%%)\n" "$name" "$before_val" "$after_val" "$change"
  fi
}

compare_metric "speculation_active_tasks" "Active Tasks"
compare_metric "speculation_rollback_total" "Total Rollbacks"
compare_metric "speculation_memory_usage_bytes" "Memory (bytes)"
compare_metric "speculation_proof_queue_depth" "Proof Queue"
```

---

## See Also

- [deployment-runbook.md](./deployment-runbook.md) - Deployment procedures
- [operations-runbook.md](./operations-runbook.md) - Day-to-day operations
- [troubleshooting-runbook.md](./troubleshooting-runbook.md) - Issue diagnosis
- [incident-response.md](./incident-response.md) - Incident procedures
- [../operations/CONFIGURATION.md](../operations/CONFIGURATION.md) - Full config reference
