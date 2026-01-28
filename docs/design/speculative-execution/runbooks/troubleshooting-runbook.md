# Speculative Execution Troubleshooting Runbook

> **Target Audience:** SRE, On-Call Engineers, Support Engineers  
> **Last Updated:** 2025-01-28  
> **Review Cycle:** Monthly (after incidents)

## Table of Contents
- [Quick Reference](#quick-reference)
- [Common Issues](#common-issues)
  - [High Rollback Rate](#high-rollback-rate)
  - [Speculation Disabled Automatically](#speculation-disabled-automatically)
  - [Memory Growth](#memory-growth)
  - [Proof Generation Slow](#proof-generation-slow)
  - [Stuck Speculative Tasks](#stuck-speculative-tasks)
- [Debug Commands Reference](#debug-commands-reference)
- [Log Query Reference](#log-query-reference)

---

## Quick Reference

### Diagnostic Commands Cheatsheet

```bash
# Overall health
agenc admin status --component speculation

# Active speculative tasks
agenc speculation list --status active --limit 20

# Recent rollbacks
agenc speculation rollbacks --since 1h

# Proof queue status
agenc proof-worker status

# Memory breakdown
agenc admin memory --component speculation

# Check for stuck tasks
agenc speculation stuck --threshold 5m

# View speculation config
agenc config show --section speculation
```

### Key Log Files

| Log | Location | Contents |
|-----|----------|----------|
| Speculation | `/var/log/agenc/speculation.log` | Main speculation logs |
| Rollback | `/var/log/agenc/rollback.log` | Rollback events |
| Proof Worker | `/var/log/agenc/proof-worker.log` | Proof generation |
| Scheduler | `/var/log/agenc/scheduler.log` | Task scheduling |

### Metrics Quick Check

```bash
curl -s localhost:9090/metrics | grep -E '^speculation_' | sort
```

---

## Common Issues

### High Rollback Rate

#### Symptoms
- Alert: `SpeculationRollbackRateHigh` or `SpeculationSuccessRateCritical`
- Dashboard shows rollback rate > 10/min
- Users report failed transactions
- Stake being slashed

#### Diagnosis

**Step 1: Identify rollback reasons**

```bash
# Get rollback breakdown by reason
curl -s localhost:9090/metrics | grep 'speculation_rollback_total' 

# Expected labels: {reason="ancestor_failed|proof_invalid|timeout|state_conflict|manual"}
```

```promql
# Grafana query: Rollbacks by reason (last 1h)
sum(increase(speculation_rollback_total[1h])) by (reason)
```

**Step 2: Check ancestor chain health**

```bash
# List recent rollbacks with details
agenc speculation rollbacks --since 30m --verbose

# Example output:
# ID: spec-12345
#   Reason: ancestor_failed
#   Ancestor: task-67890
#   Depth: 3
#   Duration: 12.5s
#   Stake Impact: 0.001 SOL
```

**Step 3: Examine failing ancestors**

```bash
# Get details on a failing ancestor
agenc task inspect task-67890

# Check if pattern exists
agenc speculation analyze-failures --since 1h
```

**Step 4: Check external dependencies**

```bash
# Solana RPC health
curl -X POST $SOLANA_RPC_URL -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Check confirmation times
agenc metrics query --name solana_confirmation_time_p99 --since 1h
```

#### Resolution by Root Cause

| Root Cause | Resolution | Prevention |
|------------|------------|------------|
| **Ancestor failures cascading** | Reduce `max_depth` to limit blast radius | Lower depth in high-failure periods |
| **RPC instability** | Switch to backup RPC, pause speculation | Implement RPC health checks |
| **Proof verification failures** | Check proof generator logs, verify circuit | Run proof generator health check |
| **State conflicts** | Clear conflicting state, restart | Improve conflict detection |
| **Timeout exceeded** | Increase timeout or reduce depth | Tune timeouts to network conditions |

**Immediate mitigation:**

```bash
# Reduce blast radius
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 2}'

# Or temporarily pause new speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'
```

---

### Speculation Disabled Automatically

#### Symptoms
- Alert: `SpeculationDisabledAutomatically`
- `speculation_enabled` metric shows 0
- `speculation_auto_disabled` metric shows 1
- No new speculative tasks being created

#### Diagnosis

**Step 1: Check disable reason**

```bash
# Check current status
agenc admin status --component speculation --verbose

# Example output:
# Speculation Status: DISABLED (auto)
# Disable Reason: consecutive_failures_exceeded
# Disabled At: 2025-01-28T14:32:15Z
# Failure Count: 15 (threshold: 10)
# Cooldown Until: 2025-01-28T14:37:15Z
```

**Step 2: Review failure pattern**

```bash
# Get failures leading to disable
agenc speculation failures --since 30m --limit 20

# Check logs around disable time
grep -A 5 "auto-disabling speculation" /var/log/agenc/speculation.log | tail -50
```

**Step 3: Identify trigger**

```promql
# Query: What happened before disable?
speculation_rollback_total offset 10m - speculation_rollback_total offset 15m
```

Auto-disable triggers:
| Trigger | Threshold | Cooldown |
|---------|-----------|----------|
| Consecutive failures | 10 failures in 5 min | 5 minutes |
| Rollback rate | > 50% for 2 min | 10 minutes |
| Memory exhaustion | > 95% | Until memory < 80% |
| Proof queue full | > 98% for 5 min | Until queue < 50% |

#### Resolution

**After identifying and fixing root cause:**

```bash
# Check if cooldown has passed
agenc speculation status

# Manual re-enable (if cooldown passed)
curl -X POST http://localhost:9090/admin/speculation/enable \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Force re-enable (override cooldown - use with caution)
curl -X POST http://localhost:9090/admin/speculation/enable \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"force": true, "reason": "root cause fixed: <description>"}'

# Verify re-enabled
agenc admin status --component speculation
```

**If root cause unclear:**

```bash
# Re-enable with conservative settings
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "speculation.enabled": true,
    "speculation.mode": "conservative",
    "speculation.max_depth": 2,
    "speculation.features.rollout_percentage": 5
  }'

# Monitor closely and gradually increase
```

---

### Memory Growth

#### Symptoms
- Alert: `SpeculationMemoryExhaustion`
- `speculation_memory_usage_bytes` climbing over time
- OOM kills in pod logs
- Slow GC warnings

#### Diagnosis

**Step 1: Check memory breakdown**

```bash
# Memory by component
agenc admin memory --component speculation --breakdown

# Example output:
# Component                 Used (MB)    Max (MB)    %
# ─────────────────────────────────────────────────────
# state_snapshots           2048         4096        50%
# pending_operations        1536         -           -
# proof_cache               512          1024        50%
# rollback_logs             256          512         50%
# commitment_ledger         128          256         50%
# ─────────────────────────────────────────────────────
# Total                     4480         8192        55%
```

**Step 2: Check for memory leaks**

```bash
# Memory trend over time
curl -s 'localhost:9090/api/v1/query_range?query=speculation_memory_usage_bytes&start=-2h&step=60s' | jq

# Count of state snapshots
agenc speculation snapshots count

# Oldest uncollected snapshot
agenc speculation snapshots oldest
```

**Step 3: Check GC health**

```bash
# GC stats
agenc admin gc-stats --component speculation

# Example output:
# Last GC: 2025-01-28T14:30:00Z (2 min ago)
# GC Duration: 1.2s
# Objects Collected: 1523
# Memory Freed: 256 MB
# GC Interval: 15s (configured: 15s)
# GC Errors (1h): 0
```

#### Resolution

**Immediate: Force garbage collection**

```bash
# Trigger manual GC
agenc admin gc --component speculation --force

# Verify memory freed
agenc admin memory --component speculation
```

**If snapshots accumulating:**

```bash
# List old snapshots
agenc speculation snapshots list --older-than 1h

# Clear stale snapshots
agenc speculation snapshots clear --older-than 1h --dry-run
agenc speculation snapshots clear --older-than 1h --confirm

# Reduce snapshot limit
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.limits.max_state_snapshots": 50}'
```

**If pending operations piling up:**

```bash
# Check for stuck operations
agenc speculation list --status pending --older-than 10m

# Timeout and clean stuck operations
agenc speculation timeout --older-than 30m --dry-run
agenc speculation timeout --older-than 30m --confirm
```

**If proof cache growing:**

```bash
# Clear proof cache
agenc proof-cache clear --confirmed-only

# Reduce cache size
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.proof.cache_size_mb": 256}'
```

**Long-term fixes:**

| Issue | Fix | Config Change |
|-------|-----|---------------|
| Too many snapshots | Reduce max_depth | `max_depth: 3` |
| Slow GC | Increase GC frequency | `gc_interval_ms: 10000` |
| Large state per task | Enable state compression | `state_compression: true` |
| Memory limit too low | Increase limit (if resources allow) | `max_memory_mb: 12288` |

---

### Proof Generation Slow

#### Symptoms
- Alert: `SpeculationProofLatencyHigh`
- `speculation_proof_generation_seconds` p99 > 90s
- Tasks stuck in `proof_pending` state
- Proof queue depth increasing

#### Diagnosis

**Step 1: Check proof worker status**

```bash
# Proof worker health
agenc proof-worker status

# Example output:
# Worker Status: HEALTHY
# Active Workers: 8/8
# Queue Depth: 1523/2000 (76%)
# Avg Generation Time: 45.2s
# p99 Generation Time: 112.3s
# Failed (1h): 12
# Timeout (1h): 5
```

**Step 2: Analyze queue**

```bash
# Queue breakdown
agenc proof-worker queue --analyze

# Example output:
# Queue Analysis:
#   Waiting: 1200 (avg wait: 2.3 min)
#   In Progress: 323
#   By Circuit Type:
#     - compute: 800 (66%)
#     - transfer: 400 (33%)
#     - complex: 23 (2%)
```

**Step 3: Check resource utilization**

```bash
# CPU usage on proof workers
kubectl top pods -l component=proof-worker -n production

# Check for thermal throttling (if bare metal)
cat /sys/class/thermal/thermal_zone*/temp
```

**Step 4: Check for problematic proofs**

```bash
# Find slowest proofs
agenc proof-worker slow --since 1h --limit 10

# Analyze a slow proof
agenc proof-worker inspect <proof_id>
```

#### Resolution

**Immediate: Scale proof workers**

```bash
# Scale up proof workers (Kubernetes)
kubectl scale deployment proof-worker -n production --replicas=12

# Or add more threads (config)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.proof.worker_threads": 12}'
```

**Reduce incoming load:**

```bash
# Increase batching (fewer but larger batches)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.proof.batch_size": 30}'

# Temporarily reduce speculation volume
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 50}'
```

**Clear stuck proofs:**

```bash
# List stuck proofs
agenc proof-worker stuck --threshold 10m

# Retry stuck proofs
agenc proof-worker retry --stuck --older-than 10m

# Or timeout them
agenc proof-worker timeout --older-than 30m
```

**Long-term fixes:**

| Issue | Fix |
|-------|-----|
| Consistent high latency | Add more proof workers |
| Specific circuit slow | Optimize circuit, file issue |
| Memory pressure | Reduce batch size, add memory |
| CPU bottleneck | Use GPU acceleration if available |

---

### Stuck Speculative Tasks

#### Symptoms
- Tasks in `speculative` state for > `confirmation_timeout_ms`
- No state transitions occurring
- Ancestor tasks also appear stuck
- `speculation_active_tasks` flat despite traffic

#### Diagnosis

**Step 1: Identify stuck tasks**

```bash
# Find stuck speculative tasks
agenc speculation stuck --threshold 5m

# Example output:
# Stuck Speculative Tasks (> 5 min):
# 
# ID           State        Age      Depth  Blocked By
# ─────────────────────────────────────────────────────
# spec-12345   speculative  12m 30s  3      spec-12340
# spec-12346   speculative  10m 15s  4      spec-12340
# spec-12347   speculative  8m 45s   2      task-67890
```

**Step 2: Check blocker status**

```bash
# Inspect the blocking task
agenc task inspect spec-12340

# Check if it's a proof issue
agenc proof-worker inspect spec-12340

# Check on-chain status
agenc task on-chain-status spec-12340
```

**Step 3: Check dependency graph**

```bash
# Visualize dependency chain
agenc speculation graph spec-12345

# Example output:
# spec-12345 (SPECULATIVE, 12m)
#   └── spec-12340 (PROOF_PENDING, 15m) ← BLOCKED
#         └── task-67890 (CONFIRMED)
```

**Step 4: Check for deadlocks**

```bash
# Detect circular dependencies
agenc speculation check-deadlocks

# Check for resource starvation
agenc admin resources --component speculation
```

#### Resolution

**If blocker is proof-pending:**

```bash
# Check proof worker for the task
agenc proof-worker inspect spec-12340

# Retry proof generation
agenc proof-worker retry spec-12340

# If proof repeatedly fails, investigate
agenc proof-worker logs spec-12340 --since 30m
```

**If blocker is waiting on-chain:**

```bash
# Check transaction status
agenc tx status <tx_signature>

# If tx failed, retry
agenc task retry spec-12340

# If tx stuck, check RPC
curl -X POST $SOLANA_RPC_URL -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[["<tx_signature>"]]}'
```

**If deadlock detected:**

```bash
# Force rollback one side of deadlock
agenc speculation rollback spec-12345 --reason "deadlock_resolution"

# Clear deadlock
agenc speculation clear-deadlock --confirm
```

**Manual unstick (last resort):**

```bash
# Force state transition
agenc speculation force-transition spec-12345 --to rolled_back --reason "manual_unstick"

# Or force the entire stuck chain
agenc speculation force-rollback-chain spec-12345 --reason "chain_stuck"

# Verify cleanup
agenc speculation stuck --threshold 5m
```

---

## Debug Commands Reference

### Speculation Commands

```bash
# List speculative tasks
agenc speculation list [--status <status>] [--limit <n>]
  # Status: active, pending, speculative, confirmed, rolled_back, all

# Get detailed task info
agenc speculation inspect <task_id>

# Show dependency graph
agenc speculation graph <task_id>

# Find stuck tasks
agenc speculation stuck --threshold <duration>

# View rollback history
agenc speculation rollbacks [--since <duration>] [--reason <reason>]

# Analyze failure patterns
agenc speculation analyze-failures --since <duration>

# Check for deadlocks
agenc speculation check-deadlocks

# Force state transition (emergency)
agenc speculation force-transition <task_id> --to <state> --reason <reason>

# Rollback a speculative task
agenc speculation rollback <task_id> --reason <reason>

# List state snapshots
agenc speculation snapshots list [--older-than <duration>]

# Clear old snapshots
agenc speculation snapshots clear --older-than <duration> [--dry-run|--confirm]
```

### Proof Worker Commands

```bash
# Proof worker status
agenc proof-worker status

# Queue analysis
agenc proof-worker queue --analyze

# Find slow proofs
agenc proof-worker slow --since <duration> --limit <n>

# Inspect specific proof
agenc proof-worker inspect <proof_id>

# Retry failed proof
agenc proof-worker retry <proof_id>

# Timeout stuck proofs
agenc proof-worker timeout --older-than <duration>

# View proof worker logs
agenc proof-worker logs [<proof_id>] [--since <duration>]

# Clear proof cache
agenc proof-cache clear [--confirmed-only]
```

### Admin Commands

```bash
# Component status
agenc admin status --component speculation [--verbose]

# Memory breakdown
agenc admin memory --component speculation [--breakdown]

# Force garbage collection
agenc admin gc --component speculation [--force]

# GC statistics
agenc admin gc-stats --component speculation

# Resource status
agenc admin resources --component speculation

# Enable/disable speculation
agenc admin speculation-enable [--force]
agenc admin speculation-disable [--graceful]

# View current config
agenc config show --section speculation

# Check integrity
agenc admin check-integrity --component speculation
```

---

## Log Query Reference

### Loki/Grafana Queries

```logql
# All speculation errors
{app="agenc"} |= "speculation" |= "error"

# Rollback events
{app="agenc"} |= "rollback" | json | reason != ""

# Proof generation failures
{app="agenc", component="proof-worker"} |= "failed" | json

# Auto-disable events
{app="agenc"} |= "auto-disabling speculation"

# Slow proofs (> 60s)
{app="agenc", component="proof-worker"} | json | duration > 60000

# Tasks stuck waiting
{app="agenc"} |= "task waiting" |= "exceeded threshold"

# Memory pressure warnings
{app="agenc"} |= "memory" |= "pressure" or "exceeding"

# State transition errors
{app="agenc"} |= "state transition" |= "error" or "failed"
```

### Grep Patterns for Local Logs

```bash
# Rollback events
grep -E "rollback|rolled_back" /var/log/agenc/speculation.log

# Proof failures
grep -E "proof.*fail|proof.*error|proof.*timeout" /var/log/agenc/proof-worker.log

# Memory warnings
grep -E "memory.*exceed|memory.*pressure|OOM" /var/log/agenc/speculation.log

# State machine errors
grep -E "invalid.*transition|state.*error" /var/log/agenc/speculation.log

# Timeout events
grep -E "timeout.*exceeded|confirmation.*timeout" /var/log/agenc/speculation.log

# Auto-disable
grep "auto-disabling" /var/log/agenc/speculation.log

# Stack traces
grep -A 20 "panic\|FATAL\|stack trace" /var/log/agenc/speculation.log
```

### Useful Log Analysis Commands

```bash
# Count errors by type (last hour)
grep "error" /var/log/agenc/speculation.log | \
  grep "$(date -d '1 hour ago' '+%Y-%m-%d %H')" | \
  sed 's/.*error: //' | sort | uniq -c | sort -rn

# Rollback frequency by minute
grep "rolled_back" /var/log/agenc/speculation.log | \
  cut -d'T' -f2 | cut -d':' -f1,2 | uniq -c

# Find correlation with timestamps
grep -E "error|rollback|timeout" /var/log/agenc/*.log | \
  sort -t: -k1,2 | less

# Extract task IDs from errors
grep "error" /var/log/agenc/speculation.log | \
  grep -oE 'task_id=[^ ]+' | sort | uniq -c | sort -rn
```

---

## See Also

- [deployment-runbook.md](./deployment-runbook.md) - Deployment procedures
- [operations-runbook.md](./operations-runbook.md) - Day-to-day operations
- [incident-response.md](./incident-response.md) - Incident procedures
- [tuning-guide.md](./tuning-guide.md) - Performance optimization
