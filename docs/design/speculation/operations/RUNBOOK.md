# Speculative Execution Operations Runbook

> **It's 3am and something is broken?**  
> Jump to: [Incident Response](#incident-response-procedures) | [Emergency Commands](#emergency-commands-cheat-sheet)

## Table of Contents
- [Quick Reference](#quick-reference)
- [Operational Procedures](#operational-procedures)
- [Incident Response Procedures](#incident-response-procedures)
- [Recovery Procedures](#recovery-procedures)
- [Debugging Techniques](#debugging-techniques)
- [Common Issues and Solutions](#common-issues-and-solutions)
- [Emergency Commands Cheat Sheet](#emergency-commands-cheat-sheet)

---

## Quick Reference

### Service Endpoints
| Service | Endpoint | Purpose |
|---------|----------|---------|
| Admin API | `http://localhost:9090/admin` | Runtime config, health |
| Metrics | `http://localhost:9090/metrics` | Prometheus metrics |
| Health | `http://localhost:9090/health` | Liveness/readiness |
| Proof Workers | `http://localhost:9091/metrics` | Proof generation stats |

### Critical Thresholds
| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Rollback Rate | >5% | >15% | Reduce depth |
| Memory | >80% | >95% | Force GC / reduce limits |
| Proof Queue | >50% | >80% | Scale workers |
| Confirmation Latency P99 | >30s | >60s | Check upstream |
| Stake Utilization | >80% | >95% | Investigate accumulation |

---

## Operational Procedures

### Enable Speculation

**Prerequisites:**
- [ ] Monitoring dashboards active
- [ ] Alerting configured
- [ ] Stake pool funded
- [ ] Proof workers running

**Steps:**

1. **Verify system health:**
   ```bash
   curl http://localhost:9090/health
   # Expect: {"status":"healthy","speculation":"disabled"}
   ```

2. **Enable in conservative mode first:**
   ```bash
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "speculation.enabled": true,
       "speculation.mode": "conservative",
       "speculation.features.rollout_percentage": 10
     }'
   ```

3. **Monitor for 10 minutes:**
   - Watch rollback rate (should be <5%)
   - Watch confirmation latency
   - Check for errors in logs

4. **Gradually increase rollout:**
   ```bash
   # 25%
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"speculation.features.rollout_percentage": 25}'
   
   # Wait 10 min, then 50%
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"speculation.features.rollout_percentage": 50}'
   
   # Wait 10 min, then 100%
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"speculation.features.rollout_percentage": 100}'
   ```

5. **Verify full operation:**
   ```bash
   curl http://localhost:9090/health
   # Expect: {"status":"healthy","speculation":"enabled","rollout":100}
   ```

---

### Disable Speculation

#### Graceful Shutdown (Preferred)

Use when you have time and want clean state.

1. **Stop new speculations:**
   ```bash
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"speculation.features.rollout_percentage": 0}'
   ```

2. **Wait for pending operations to resolve:**
   ```bash
   # Watch until pending count reaches 0
   watch -n 5 'curl -s http://localhost:9090/metrics | grep speculation_pending_operations_count'
   ```

3. **Disable speculation:**
   ```bash
   curl -X POST http://localhost:9090/admin/config \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"speculation.enabled": false}'
   ```

4. **Verify:**
   ```bash
   curl http://localhost:9090/admin/status | jq .speculation
   # Expect: {"enabled":false,"pending_operations":0}
   ```

#### Emergency Shutdown

Use when something is actively broken.

```bash
# IMMEDIATE DISABLE - will trigger rollbacks for all pending operations
curl -X POST http://localhost:9090/admin/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "disable_speculation", "force": true}'
```

**⚠️ Warning:** This will:
- Immediately stop all speculation
- Trigger rollbacks for ALL pending operations
- Return stake (minus any slashing)
- May cause brief service disruption

---

### Adjust Limits On The Fly

#### Reduce Speculation Depth

When rollback costs are too high:

```bash
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 2}'
```

#### Reduce Parallel Branches

When memory is high:

```bash
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_parallel_branches": 2}'
```

#### Increase Proof Workers

When queue is backing up:

```bash
# Kubernetes
kubectl scale deployment proof-workers --replicas=16

# Or via config
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.proof.worker_threads": 16}'
```

#### Increase Memory Limit

When hitting memory ceiling:

```bash
# This requires restart - update config file
# Edit config/prod.toml:
# speculation.limits.max_memory_mb = 16384

# Then rolling restart
kubectl rollout restart deployment agenc
```

---

## Incident Response Procedures

### High Rollback Rate

**Symptoms:**
- `SpeculationHighRollbackRate` alert firing
- >15% of operations rolling back
- Possible stake losses

**Diagnosis:**

1. **Check rollback reasons:**
   ```bash
   curl -s http://localhost:9090/admin/rollback-stats | jq
   ```
   
   Output:
   ```json
   {
     "total_rollbacks_1h": 1523,
     "by_reason": {
       "confirmation_timeout": 45,
       "chain_reorg": 12,
       "invalid_state": 8,
       "stake_insufficient": 2,
       "proof_failed": 33
     }
   }
   ```

2. **Check if specific to certain agents:**
   ```bash
   curl -s 'http://localhost:9090/metrics' | \
     grep 'speculation_operations_total{status="rolled_back"' | \
     sort -t'=' -k3 -rn | head -10
   ```

3. **Check upstream chain health:**
   ```bash
   curl -s http://localhost:9090/admin/chain-status | jq
   ```

**Mitigation:**

| Cause | Action |
|-------|--------|
| `confirmation_timeout` | Check chain latency, increase timeout |
| `chain_reorg` | Normal during instability, reduce depth |
| `invalid_state` | Bug - investigate specific operations |
| `stake_insufficient` | Agent issue, may need exclusion |
| `proof_failed` | Check proof worker health |

**Immediate Actions:**

```bash
# 1. Reduce speculation aggressiveness
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 1, "speculation.mode": "conservative"}'

# 2. If still high after 5 min, reduce rollout
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 25}'

# 3. If still high, disable
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'
```

**Resolution Checklist:**
- [ ] Rollback rate below 5%
- [ ] Root cause identified
- [ ] Fix deployed or workaround in place
- [ ] Monitoring confirms stability
- [ ] Gradually re-enable speculation

---

### Stake Accumulation Spike

**Symptoms:**
- `SpeculationStakeAccumulationSpike` alert firing
- Locked stake growing >50% in 5 minutes
- Operations not confirming

**Diagnosis:**

1. **Check confirmation pipeline:**
   ```bash
   curl -s http://localhost:9090/admin/confirmation-status | jq
   ```
   
   Look for:
   - `pending_confirmations`: High = backlog
   - `avg_confirmation_time`: Growing = slowdown
   - `oldest_pending_age`: >60s = stuck

2. **Check proof generation:**
   ```bash
   curl -s http://localhost:9091/metrics | grep proof_queue
   ```

3. **Check chain connectivity:**
   ```bash
   curl -s http://localhost:9090/admin/chain-status | jq .connection_status
   ```

**Mitigation:**

| Cause | Action |
|-------|--------|
| Chain slowdown | Wait, reduce new speculation |
| Proof backlog | Scale workers, increase batch size |
| Network issue | Check connectivity, failover |
| Bug in confirmation | Disable, investigate |

**Immediate Actions:**

```bash
# 1. Stop new speculations to stop stake growth
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'

# 2. Check what's blocking confirmations
curl -s http://localhost:9090/admin/blocked-operations | jq '.[:10]'

# 3. If proofs are stuck, scale workers
kubectl scale deployment proof-workers --replicas=24

# 4. If chain is down, wait for recovery
# Monitor: curl -s http://localhost:9090/admin/chain-status

# 5. If nothing helps, force drain
curl -X POST http://localhost:9090/admin/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "drain_speculation"}'
```

**Resolution Checklist:**
- [ ] Stake accumulation rate normal
- [ ] Confirmation pipeline flowing
- [ ] Root cause addressed
- [ ] Re-enable speculation gradually

---

### Proof Generation Backlog

**Symptoms:**
- `SpeculationProofBacklogCritical` alert firing
- Proof queue >80% full
- Increasing confirmation latency

**Diagnosis:**

1. **Check queue status:**
   ```bash
   curl -s http://localhost:9091/metrics | grep -E 'proof_(queue|worker)'
   ```

2. **Check worker health:**
   ```bash
   curl -s http://localhost:9091/health | jq
   ```

3. **Check for proof failures:**
   ```bash
   curl -s http://localhost:9091/metrics | grep proof_failures
   ```

**Mitigation:**

```bash
# 1. Scale workers immediately
kubectl scale deployment proof-workers --replicas=24

# 2. Increase batch size for efficiency
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.proof.batch_size": 50}'

# 3. If workers are failing, check logs
kubectl logs -l app=proof-workers --tail=100

# 4. If hardware issue, redistribute
kubectl delete pod -l app=proof-workers --field-selector=status.phase=Failed

# 5. Reduce incoming work if not draining
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 50}'
```

**Typical Causes:**
- Not enough workers for load
- Worker crashes (check logs)
- Complex proofs taking too long
- Memory pressure on workers

**Resolution Checklist:**
- [ ] Queue size below 50%
- [ ] Workers healthy
- [ ] No ongoing failures
- [ ] Throughput matches demand

---

### Memory Pressure

**Symptoms:**
- `SpeculationMemoryCritical` alert firing
- Memory >95%
- Possible OOM kills

**Diagnosis:**

1. **Check memory breakdown:**
   ```bash
   curl -s http://localhost:9090/admin/memory-stats | jq
   ```
   
   ```json
   {
     "total_mb": 7800,
     "limit_mb": 8192,
     "state_snapshots_mb": 4200,
     "pending_operations_mb": 2100,
     "proof_cache_mb": 1000,
     "other_mb": 500
   }
   ```

2. **Check for leaks:**
   ```bash
   # Watch over time
   watch -n 10 'curl -s http://localhost:9090/admin/memory-stats | jq .total_mb'
   ```

**Mitigation:**

```bash
# 1. Force garbage collection
curl -X POST http://localhost:9090/admin/gc \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 2. Reduce state snapshot limit
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.limits.max_state_snapshots": 50}'

# 3. Reduce pending operations limit
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.limits.max_pending_operations": 5000}'

# 4. Reduce speculation depth (fewer snapshots needed)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 2}'

# 5. If still critical, emergency drain
curl -X POST http://localhost:9090/admin/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "drain_speculation"}'
```

**If OOM Occurred:**

```bash
# 1. Pod will restart automatically (if configured)

# 2. Check for data corruption
curl -s http://localhost:9090/admin/integrity-check | jq

# 3. If corruption detected
curl -X POST http://localhost:9090/admin/recovery \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "rebuild_state"}'
```

**Resolution Checklist:**
- [ ] Memory below 80%
- [ ] GC running successfully
- [ ] No memory leak detected
- [ ] Limits adjusted appropriately

---

## Recovery Procedures

### State Rebuild

After crash or corruption:

```bash
# 1. Stop speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# 2. Trigger state rebuild from chain
curl -X POST http://localhost:9090/admin/recovery \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "rebuild_state", "from_slot": "latest_confirmed"}'

# 3. Monitor progress
watch -n 5 'curl -s http://localhost:9090/admin/recovery/status | jq'

# 4. Verify integrity
curl -s http://localhost:9090/admin/integrity-check | jq

# 5. Re-enable speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": true}'
```

### Stake Recovery

After slashing or stuck stake:

```bash
# 1. List affected agents
curl -s http://localhost:9090/admin/stake/stuck | jq

# 2. Initiate stake recovery
curl -X POST http://localhost:9090/admin/stake/recover \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"agent_ids": ["agent1", "agent2"]}'

# 3. Verify recovery
curl -s http://localhost:9090/admin/stake/status | jq
```

### Full System Recovery

After catastrophic failure:

```bash
#!/bin/bash
# recovery.sh - Full system recovery script

set -e

echo "=== AgenC Speculation Recovery ==="

# 1. Ensure speculation is off
echo "1. Disabling speculation..."
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}' || true

# 2. Wait for services
echo "2. Waiting for services..."
until curl -s http://localhost:9090/health | grep -q "healthy"; do
  sleep 5
done

# 3. Check integrity
echo "3. Checking integrity..."
INTEGRITY=$(curl -s http://localhost:9090/admin/integrity-check)
if echo "$INTEGRITY" | grep -q "corrupted"; then
  echo "   Corruption detected, rebuilding state..."
  curl -X POST http://localhost:9090/admin/recovery \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"action": "rebuild_state"}'
  
  # Wait for rebuild
  while curl -s http://localhost:9090/admin/recovery/status | grep -q "in_progress"; do
    sleep 10
  done
fi

# 4. Recover stuck stake
echo "4. Recovering stuck stake..."
curl -X POST http://localhost:9090/admin/stake/recover-all \
  -H "Authorization: Bearer $ADMIN_TOKEN" || true

# 5. Clear proof queue
echo "5. Clearing proof queue..."
curl -X POST http://localhost:9090/admin/proof/clear-queue \
  -H "Authorization: Bearer $ADMIN_TOKEN" || true

# 6. Garbage collect
echo "6. Running garbage collection..."
curl -X POST http://localhost:9090/admin/gc \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 7. Re-enable cautiously
echo "7. Re-enabling speculation (10% rollout)..."
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "speculation.enabled": true,
    "speculation.mode": "conservative",
    "speculation.max_depth": 2,
    "speculation.features.rollout_percentage": 10
  }'

echo "=== Recovery complete. Monitor dashboards before increasing rollout. ==="
```

---

## Debugging Techniques

### Trace a Specific Operation

```bash
# Get operation details
curl -s "http://localhost:9090/admin/operation/OP_ID_HERE" | jq

# Get operation timeline
curl -s "http://localhost:9090/admin/operation/OP_ID_HERE/timeline" | jq
```

### Find Why Confirmations Are Slow

```bash
# Pipeline analysis
curl -s http://localhost:9090/admin/pipeline/analyze | jq

# Bottleneck detection
curl -s http://localhost:9090/admin/pipeline/bottlenecks | jq
```

### Check Agent-Specific Issues

```bash
# Agent's speculation stats
curl -s "http://localhost:9090/admin/agent/AGENT_ID/speculation" | jq

# Agent's recent rollbacks
curl -s "http://localhost:9090/admin/agent/AGENT_ID/rollbacks?limit=10" | jq
```

### Log Correlation

```bash
# Find all logs for an operation
kubectl logs -l app=agenc --since=1h | grep "OP_ID_HERE"

# Find rollback chain
kubectl logs -l app=agenc --since=1h | grep -E "(rollback|OP_ID_HERE)" | sort
```

### Performance Profiling

```bash
# Enable profiling (temporary)
curl -X POST http://localhost:9090/admin/debug/profile/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"duration_seconds": 30}'

# Get profile
curl -s http://localhost:9090/admin/debug/profile/result > profile.pb.gz

# Analyze with pprof
go tool pprof -http=:8080 profile.pb.gz
```

---

## Common Issues and Solutions

### Operations Stuck in Pending

**Symptom:** Operations stay pending indefinitely

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Chain not confirming | Wait or check chain status |
| Proofs not generating | Check proof workers |
| Bug in confirmation logic | Check logs, may need restart |
| Network partition | Check connectivity |

```bash
# Force timeout stale operations
curl -X POST http://localhost:9090/admin/operations/timeout-stale \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"older_than_seconds": 300}'
```

### Speculation Immediately Disabled After Enable

**Symptom:** Circuit breaker trips immediately

**Solution:**
```bash
# Check circuit breaker reason
curl -s http://localhost:9090/admin/circuit-breaker | jq

# Common: too many errors in window, reset and try slower rollout
curl -X POST http://localhost:9090/admin/circuit-breaker/reset \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Agents Getting Slashed Unexpectedly

**Symptom:** Stake slashing when operations seem valid

**Investigation:**
```bash
# Get slash history
curl -s http://localhost:9090/admin/slashes?limit=20 | jq

# Check specific slash reason
curl -s "http://localhost:9090/admin/slash/SLASH_ID" | jq
```

### High CPU on Proof Workers

**Symptom:** Workers at 100% CPU constantly

**Solutions:**
- Scale horizontally: `kubectl scale deployment proof-workers --replicas=N`
- Increase batch size for efficiency
- Check for infinite loop in proof generation (logs)
- Verify proof complexity hasn't increased

### Grafana Dashboard Shows No Data

**Symptom:** Metrics exist but dashboard empty

**Solutions:**
```bash
# Verify metrics endpoint
curl -s http://localhost:9090/metrics | grep speculation

# Check Prometheus scrape
kubectl port-forward svc/prometheus 9090:9090
# Then: http://localhost:9090/targets

# Check time range in Grafana (common mistake)
```

---

## Emergency Commands Cheat Sheet

```bash
# ==========================================
# EMERGENCY COMMANDS - COPY/PASTE READY
# ==========================================

# Admin token (set this first)
export ADMIN_TOKEN="your-token-here"
export ADMIN_URL="http://localhost:9090"

# ---------- DISABLE SPECULATION ----------
# Graceful (stops new, waits for pending)
curl -X POST $ADMIN_URL/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'

# Hard (immediate, triggers rollbacks)  
curl -X POST $ADMIN_URL/admin/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "disable_speculation", "force": true}'

# ---------- REDUCE LOAD ----------
# Conservative mode
curl -X POST $ADMIN_URL/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.mode": "conservative", "speculation.max_depth": 1}'

# Partial rollout
curl -X POST $ADMIN_URL/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 10}'

# ---------- MEMORY EMERGENCY ----------
# Force GC
curl -X POST $ADMIN_URL/admin/gc \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Reduce limits
curl -X POST $ADMIN_URL/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.limits.max_state_snapshots": 25, "speculation.limits.max_pending_operations": 1000}'

# ---------- PROOF EMERGENCY ----------
# Scale workers (k8s)
kubectl scale deployment proof-workers --replicas=24

# Clear stuck queue
curl -X POST $ADMIN_URL/admin/proof/clear-queue \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# ---------- DIAGNOSTICS ----------
# Health
curl -s $ADMIN_URL/health | jq

# Status
curl -s $ADMIN_URL/admin/status | jq

# Rollback stats
curl -s $ADMIN_URL/admin/rollback-stats | jq

# Memory stats  
curl -s $ADMIN_URL/admin/memory-stats | jq

# Blocked operations
curl -s $ADMIN_URL/admin/blocked-operations | jq

# ---------- RECOVERY ----------
# Rebuild state
curl -X POST $ADMIN_URL/admin/recovery \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"action": "rebuild_state"}'

# Recover stake
curl -X POST $ADMIN_URL/admin/stake/recover-all \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Reset circuit breaker
curl -X POST $ADMIN_URL/admin/circuit-breaker/reset \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - All configuration options
- [MONITORING.md](./MONITORING.md) - Metrics and alerts
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment procedures
