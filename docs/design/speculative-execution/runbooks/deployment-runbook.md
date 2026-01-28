# Speculative Execution Deployment Runbook

> **Target Audience:** SRE, Platform Engineers, DevOps  
> **Last Updated:** 2025-01-28  
> **Review Cycle:** Quarterly

## Table of Contents
- [Prerequisites Checklist](#prerequisites-checklist)
- [Configuration Steps](#configuration-steps)
- [Feature Flag Rollout Strategy](#feature-flag-rollout-strategy)
- [Smoke Tests](#smoke-tests)
- [Rollback Procedure](#rollback-procedure)
- [Deployment Verification](#deployment-verification)

---

## Prerequisites Checklist

### Infrastructure Requirements

| Requirement | Minimum | Recommended | Verification Command |
|-------------|---------|-------------|---------------------|
| Memory per node | 8 GB | 16 GB | `free -h` |
| CPU cores | 4 | 8+ | `nproc` |
| Disk (SSD) | 100 GB | 250 GB | `df -h /var/lib/agenc` |
| Network bandwidth | 100 Mbps | 1 Gbps | `iperf3 -c $RPC_HOST` |
| Solana RPC latency | < 200ms | < 50ms | `curl -w "%{time_total}" $RPC_URL` |

```bash
# Run full prerequisite check
./scripts/check-prerequisites.sh --component speculation

# Expected output:
# ✓ Memory: 16384 MB (minimum: 8192 MB)
# ✓ CPU cores: 8 (minimum: 4)
# ✓ Disk space: 245 GB (minimum: 100 GB)
# ✓ Solana RPC responsive: 45ms
# ✓ Proof generation binary available
# ✓ Required accounts funded
```

### Software Dependencies

- [ ] **Runtime version:** AgenC v2.4.0+ with speculation support
- [ ] **Solana CLI:** v1.18.0+
- [ ] **Proof generator:** groth16-prover v0.8.0+ installed
- [ ] **Node.js:** v20.0.0+ (for SDK tests)

```bash
# Verify versions
agenc --version       # Should be >= 2.4.0
solana --version      # Should be >= 1.18.0
groth16-prover --version  # Should be >= 0.8.0
```

### Account Setup

- [ ] **Agent wallet funded:** Minimum 2 SOL for gas + stake
- [ ] **Speculation program deployed:** Note program ID
- [ ] **Stake account created:** Via `agenc stake init`

```bash
# Check agent balance
solana balance $AGENT_WALLET

# Initialize stake account (if not exists)
agenc stake init --amount 1000000000  # 1 SOL

# Verify stake
agenc stake status
```

### On-Chain Prerequisites

- [ ] **SpeculativeCommitment program:** Deployed to target cluster
- [ ] **Stake pool:** Initialized with sufficient liquidity
- [ ] **Oracle feeds:** Active for required price data

```bash
# Verify program deployment
solana program show $SPECULATION_PROGRAM_ID

# Check stake pool
agenc admin check-pool --program $SPECULATION_PROGRAM_ID
```

### Monitoring Infrastructure

- [ ] **Prometheus:** Running and scraping AgenC metrics
- [ ] **Grafana:** Speculation dashboard imported
- [ ] **AlertManager:** Alert rules configured
- [ ] **Log aggregation:** Loki/Elasticsearch receiving logs

```bash
# Test Prometheus connectivity
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="agenc")'

# Verify dashboard exists
curl -s http://grafana:3000/api/dashboards/uid/speculation-overview -u admin:$GRAFANA_PASS
```

---

## Configuration Steps

### Step 1: Create Configuration File

```bash
# Copy template
cp config/speculation-template.toml config/speculation-prod.toml
```

### Step 2: Configure Core Settings

Edit `config/speculation-prod.toml`:

```toml
[speculation]
enabled = false  # Start disabled, enable via feature flag
mode = "conservative"
max_depth = 3
max_parallel_branches = 2
confirmation_timeout_ms = 60000
rollback_policy = "cascade"

[speculation.stake]
min_stake = 1_000_000          # 0.001 SOL
max_stake = 1_000_000_000      # 1 SOL
stake_per_depth = 500_000      # 0.0005 SOL per level
slash_percentage = 0.1         # 10%
cooldown_period_ms = 300000    # 5 min

[speculation.proof]
generator = "groth16"
worker_threads = 8
queue_size = 2000
timeout_ms = 120000
batch_size = 20

[speculation.limits]
max_memory_mb = 8192
max_pending_operations = 50000
max_state_snapshots = 500
gc_interval_ms = 15000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = false
enable_optimistic_proofs = true
enable_stake_delegation = false
rollout_percentage = 0.0  # Start at 0, increment gradually
```

### Step 3: Validate Configuration

```bash
# Dry-run config validation
agenc config validate --config config/speculation-prod.toml --strict

# Expected output:
# ✓ speculation.max_depth within range [1, 20]
# ✓ speculation.stake.slash_percentage within range [0.01, 0.5]
# ✓ speculation.proof.generator is valid
# ✓ speculation.limits.max_memory_mb >= 512
# ✓ Feature flag combinations are valid
# Configuration valid!
```

### Step 4: Deploy Configuration

```bash
# Rolling config update (no downtime)
kubectl rollout restart deployment/agenc-worker -n production

# Or via config reload (preferred)
curl -X POST http://localhost:9090/admin/config/reload \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Feature Flag Rollout Strategy

### Rollout Phases

| Phase | Percentage | Duration | Success Criteria |
|-------|------------|----------|------------------|
| Canary | 1% | 24 hours | Rollback rate < 5%, No P1 alerts |
| Early Adopters | 5% | 48 hours | Rollback rate < 3%, Latency within SLO |
| Expanding | 25% | 72 hours | All metrics green, No escalations |
| Majority | 50% | 1 week | Stable performance |
| Full | 100% | Ongoing | Monitor for regressions |

### Rollout Commands

```bash
# Phase 1: Enable for 1% (canary)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": true, "speculation.features.rollout_percentage": 1.0}'

# Phase 2: Expand to 5%
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 5.0}'

# Phase 3: Expand to 25%
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 25.0}'

# Continue incrementally...
```

### Rollout Decision Matrix

| Condition | Action |
|-----------|--------|
| Rollback rate > 10% | Halt rollout, investigate |
| Rollback rate 5-10% | Pause rollout, continue monitoring |
| Memory growth > 20%/hour | Reduce max_parallel_branches |
| Proof queue > 80% capacity | Pause rollout, scale workers |
| P1 alert triggered | Immediate rollback to previous phase |
| All metrics green for 24h | Proceed to next phase |

### Monitoring During Rollout

```bash
# Watch key metrics
watch -n 10 'curl -s localhost:9090/metrics | grep speculation'

# Key queries to monitor:
# - speculation_rollback_total
# - speculation_active_tasks
# - speculation_proof_queue_depth
# - speculation_memory_usage_bytes
```

---

## Smoke Tests

### Automated Smoke Test Suite

```bash
# Run full smoke test suite
./scripts/smoke-tests/speculation-smoke.sh --env production

# Individual tests:
./scripts/smoke-tests/01-basic-speculation.sh
./scripts/smoke-tests/02-rollback-recovery.sh
./scripts/smoke-tests/03-proof-generation.sh
./scripts/smoke-tests/04-stake-mechanics.sh
./scripts/smoke-tests/05-metrics-emission.sh
```

### Test 1: Basic Speculation Flow

```bash
#!/bin/bash
# 01-basic-speculation.sh

set -e

echo "=== Test 1: Basic Speculation Flow ==="

# Submit parent task
PARENT_ID=$(agenc task submit \
  --type "compute" \
  --payload '{"value": 100}' \
  --output json | jq -r '.task_id')

echo "Parent task: $PARENT_ID"

# Submit dependent task (should speculate)
CHILD_ID=$(agenc task submit \
  --type "compute" \
  --payload '{"value": 200}' \
  --depends-on "$PARENT_ID" \
  --output json | jq -r '.task_id')

echo "Child task: $CHILD_ID"

# Wait and check status
sleep 5

CHILD_STATUS=$(agenc task status "$CHILD_ID" --output json | jq -r '.speculation_status')

if [[ "$CHILD_STATUS" == "speculative" ]]; then
  echo "✓ Child task executing speculatively"
else
  echo "✗ Expected speculative status, got: $CHILD_STATUS"
  exit 1
fi

# Wait for parent confirmation
agenc task wait "$PARENT_ID" --timeout 60

# Verify child transitions to confirmed
sleep 5
FINAL_STATUS=$(agenc task status "$CHILD_ID" --output json | jq -r '.status')

if [[ "$FINAL_STATUS" == "confirmed" ]]; then
  echo "✓ Child task confirmed after parent"
else
  echo "✗ Expected confirmed status, got: $FINAL_STATUS"
  exit 1
fi

echo "=== Test 1 PASSED ==="
```

### Test 2: Rollback Recovery

```bash
#!/bin/bash
# 02-rollback-recovery.sh

set -e

echo "=== Test 2: Rollback Recovery ==="

# Submit task designed to fail
FAIL_PARENT=$(agenc task submit \
  --type "compute" \
  --payload '{"fail": true}' \
  --output json | jq -r '.task_id')

# Submit speculative child
CHILD_ID=$(agenc task submit \
  --type "compute" \
  --payload '{"value": 100}' \
  --depends-on "$FAIL_PARENT" \
  --output json | jq -r '.task_id')

# Wait for rollback
sleep 15

CHILD_STATUS=$(agenc task status "$CHILD_ID" --output json | jq -r '.status')

if [[ "$CHILD_STATUS" == "rolled_back" ]]; then
  echo "✓ Child task rolled back correctly"
else
  echo "✗ Expected rolled_back status, got: $CHILD_STATUS"
  exit 1
fi

# Verify rollback metric incremented
ROLLBACK_COUNT=$(curl -s localhost:9090/metrics | grep 'speculation_rollback_total' | awk '{print $2}')
if [[ "$ROLLBACK_COUNT" -gt 0 ]]; then
  echo "✓ Rollback metric recorded"
else
  echo "✗ Rollback metric not recorded"
  exit 1
fi

echo "=== Test 2 PASSED ==="
```

### Test 3: Proof Generation

```bash
#!/bin/bash
# 03-proof-generation.sh

set -e

echo "=== Test 3: Proof Generation ==="

# Submit task and wait for proof
TASK_ID=$(agenc task submit \
  --type "compute" \
  --payload '{"value": 42}' \
  --output json | jq -r '.task_id')

# Wait for proof generation
agenc task wait "$TASK_ID" --timeout 120

# Check proof exists
PROOF=$(agenc proof get "$TASK_ID" --output json)

if [[ $(echo "$PROOF" | jq -r '.proof_type') == "groth16" ]]; then
  echo "✓ Proof generated with correct type"
else
  echo "✗ Proof generation failed"
  exit 1
fi

# Verify proof is valid
if agenc proof verify "$TASK_ID"; then
  echo "✓ Proof verification passed"
else
  echo "✗ Proof verification failed"
  exit 1
fi

echo "=== Test 3 PASSED ==="
```

### Test 4: Metrics Emission

```bash
#!/bin/bash
# 05-metrics-emission.sh

set -e

echo "=== Test 4: Metrics Emission ==="

METRICS_URL="http://localhost:9090/metrics"

# Check required metrics exist
REQUIRED_METRICS=(
  "speculation_tasks_total"
  "speculation_active_tasks"
  "speculation_rollback_total"
  "speculation_proof_generation_seconds"
  "speculation_memory_usage_bytes"
  "speculation_depth_histogram"
)

for metric in "${REQUIRED_METRICS[@]}"; do
  if curl -s "$METRICS_URL" | grep -q "^$metric"; then
    echo "✓ Metric exists: $metric"
  else
    echo "✗ Missing metric: $metric"
    exit 1
  fi
done

echo "=== Test 4 PASSED ==="
```

### Smoke Test Success Criteria

| Test | Pass Criteria | Failure Action |
|------|---------------|----------------|
| Basic Flow | Speculative execution observed | Check logs, verify config |
| Rollback | Clean rollback without orphans | Check RollbackController logs |
| Proof Gen | Proof generated < 120s | Check proof worker capacity |
| Metrics | All 6 core metrics present | Check Prometheus scrape |

---

## Rollback Procedure

### Immediate Rollback (Emergency)

**Use when:** P1 incident, data integrity concerns, cascading failures

```bash
#!/bin/bash
# EMERGENCY ROLLBACK - Execute immediately

# Step 1: Disable speculation (no new speculative tasks)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# Step 2: Drain existing speculative tasks (graceful)
curl -X POST http://localhost:9090/admin/speculation/drain \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --max-time 120

# Step 3: Force rollback if drain fails
if [[ $? -ne 0 ]]; then
  echo "Drain timeout, forcing rollback..."
  curl -X POST http://localhost:9090/admin/speculation/force-rollback \
    -H "Authorization: Bearer $ADMIN_TOKEN"
fi

# Step 4: Verify no speculative tasks remain
ACTIVE=$(curl -s localhost:9090/metrics | grep 'speculation_active_tasks' | awk '{print $2}')
if [[ "$ACTIVE" == "0" ]]; then
  echo "✓ Rollback complete, no active speculative tasks"
else
  echo "⚠ Warning: $ACTIVE speculative tasks still active"
fi
```

### Graceful Rollback (Planned)

**Use when:** Scheduled maintenance, config changes, gradual wind-down

```bash
#!/bin/bash
# GRACEFUL ROLLBACK

# Step 1: Stop new speculative tasks
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'

echo "Waiting for in-flight tasks to complete..."

# Step 2: Wait for natural drain (up to 10 minutes)
for i in {1..60}; do
  ACTIVE=$(curl -s localhost:9090/metrics | grep 'speculation_active_tasks' | awk '{print $2}')
  if [[ "$ACTIVE" == "0" ]]; then
    echo "All speculative tasks drained"
    break
  fi
  echo "Active tasks: $ACTIVE (waiting...)"
  sleep 10
done

# Step 3: Disable speculation entirely
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

echo "✓ Graceful rollback complete"
```

### Version Rollback

**Use when:** Defect in new code, need to revert to previous version

```bash
#!/bin/bash
# VERSION ROLLBACK

# Step 1: Graceful drain (as above)
./scripts/graceful-drain.sh

# Step 2: Rollback deployment
kubectl rollout undo deployment/agenc-worker -n production

# Step 3: Wait for rollout
kubectl rollout status deployment/agenc-worker -n production

# Step 4: Verify old version
CURRENT_VERSION=$(kubectl get deployment agenc-worker -n production -o jsonpath='{.spec.template.spec.containers[0].image}')
echo "Rolled back to: $CURRENT_VERSION"
```

### Post-Rollback Verification

```bash
# Verify speculation is fully disabled
curl -s localhost:9090/admin/status | jq '.speculation'

# Expected output:
# {
#   "enabled": false,
#   "active_tasks": 0,
#   "pending_rollbacks": 0
# }

# Check for orphaned state
agenc admin check-integrity --component speculation

# Review recent errors
kubectl logs -l app=agenc-worker -n production --since=30m | grep -i "speculation\|rollback\|error"
```

---

## Deployment Verification

### Post-Deployment Checklist

- [ ] All pods healthy: `kubectl get pods -n production -l component=speculation`
- [ ] Metrics flowing: Check Grafana dashboard
- [ ] No error spikes: Check log aggregation
- [ ] Smoke tests pass: `./scripts/smoke-tests/speculation-smoke.sh`
- [ ] Latency within SLO: p99 < 500ms
- [ ] Memory stable: No growth trend over 30 min

### Verification Commands

```bash
# Pod health
kubectl get pods -n production -l component=speculation -o wide

# Recent logs
kubectl logs -l app=agenc-worker -n production --since=10m | tail -100

# Metrics snapshot
curl -s localhost:9090/metrics | grep speculation | sort

# Active connections
ss -tuln | grep 9090

# Memory usage
kubectl top pods -n production -l app=agenc-worker
```

### Sign-Off Template

```markdown
## Deployment Sign-Off

**Date:** YYYY-MM-DD
**Deployer:** [Name]
**Version:** v2.4.x
**Environment:** Production

### Checklist
- [ ] Prerequisites verified
- [ ] Configuration deployed
- [ ] Feature flag at X%
- [ ] Smoke tests passed
- [ ] Monitoring confirmed
- [ ] Rollback tested

### Metrics Baseline
- speculation_tasks_total: X
- speculation_rollback_rate: X%
- speculation_p99_latency_ms: X

### Sign-Off
- [ ] SRE Lead: [Name] [Date]
- [ ] On-Call Engineer: [Name] [Date]
```

---

## See Also

- [operations-runbook.md](./operations-runbook.md) - Day-to-day operations
- [troubleshooting-runbook.md](./troubleshooting-runbook.md) - Issue diagnosis
- [incident-response.md](./incident-response.md) - Incident procedures
- [../operations/CONFIGURATION.md](../operations/CONFIGURATION.md) - Full config reference
