# Speculative Execution Deployment Guide

> **Quick Links:** [Prerequisites](#prerequisites) | [Deploy Checklist](#deployment-checklist) | [Rollback](#rollback-procedures)

## Table of Contents
- [Prerequisites](#prerequisites)
- [Deployment Checklist](#deployment-checklist)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Health Checks](#health-checks)
- [Smoke Tests](#smoke-tests)
- [Canary Deployment](#canary-deployment-strategy)
- [Rollback Procedures](#rollback-procedures)
- [Post-Deployment Verification](#post-deployment-verification)

---

## Prerequisites

### Infrastructure Requirements

| Component | Minimum | Recommended | Notes |
|-----------|---------|-------------|-------|
| CPU (per node) | 4 cores | 8+ cores | Proof generation is CPU-intensive |
| Memory (per node) | 8GB | 16GB+ | State snapshots consume memory |
| Disk | 100GB SSD | 500GB NVMe | For logs, state, proofs |
| Network | 1Gbps | 10Gbps | High throughput for chain sync |
| Proof Workers | 2 pods | 4-8 pods | Scale based on load |

### Software Dependencies

```bash
# Verify Kubernetes cluster
kubectl cluster-info

# Verify Helm
helm version
# Required: 3.x

# Verify monitoring stack
kubectl get pods -n monitoring | grep -E "(prometheus|grafana)"

# Verify secrets exist
kubectl get secret agenc-speculation-secrets -o name
```

### Pre-Deployment Checklist

- [ ] **Stake pool funded** - Verify sufficient SOL in stake pool
  ```bash
  solana balance <STAKE_POOL_ADDRESS> --url mainnet-beta
  # Minimum: 100 SOL for production
  ```

- [ ] **Chain connectivity verified**
  ```bash
  curl -s https://api.mainnet-beta.solana.com -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq
  ```

- [ ] **Monitoring dashboards imported**
  - Import [Grafana dashboard](./MONITORING.md#grafana-dashboard-json)
  - Verify Prometheus scrape targets

- [ ] **Alerting configured**
  - Alert rules deployed
  - PagerDuty/Slack integration verified
  - On-call rotation confirmed

- [ ] **Runbooks accessible**
  - Team has access to this documentation
  - Emergency contacts updated

- [ ] **Rollback plan ready**
  - Previous version tagged and accessible
  - Rollback procedure tested in staging

---

## Deployment Checklist

### Quick Checklist (Print This)

```
SPECULATION DEPLOYMENT CHECKLIST
================================

PRE-DEPLOY:
[ ] Staging tests passed
[ ] Monitoring ready
[ ] Alerts configured  
[ ] Stake pool funded
[ ] Team notified
[ ] Change ticket created

DEPLOY:
[ ] Deploy speculation components
[ ] Verify pods healthy
[ ] Run smoke tests
[ ] Enable speculation (10% canary)
[ ] Monitor 15 minutes
[ ] Expand to 50%
[ ] Monitor 15 minutes
[ ] Expand to 100%

POST-DEPLOY:
[ ] Verify metrics flowing
[ ] Check error rates
[ ] Confirm rollback rate <5%
[ ] Update documentation
[ ] Close change ticket

ROLLBACK TRIGGERS:
- Rollback rate >15% for >5 min
- Error rate spike >10x normal
- Memory/CPU critical
- Circuit breaker trips
```

---

## Step-by-Step Deployment

### Step 1: Prepare Environment

```bash
# Set environment
export ENV=production  # or staging, dev
export NAMESPACE=agenc-${ENV}
export VERSION=v1.2.3  # Version to deploy

# Verify context
kubectl config current-context
echo "Deploying to: $NAMESPACE"
```

### Step 2: Deploy Configuration

```bash
# Create/update config
kubectl create configmap speculation-config \
  --from-file=config/speculation-${ENV}.toml \
  -n $NAMESPACE \
  --dry-run=client -o yaml | kubectl apply -f -

# Verify
kubectl get configmap speculation-config -n $NAMESPACE -o yaml | head -30
```

### Step 3: Deploy Proof Workers

Deploy proof workers first (they're needed before speculation starts):

```bash
# Deploy proof workers
helm upgrade --install proof-workers ./charts/proof-workers \
  --namespace $NAMESPACE \
  --set image.tag=$VERSION \
  --set replicaCount=4 \
  --values ./charts/proof-workers/values-${ENV}.yaml \
  --wait --timeout 5m

# Verify workers are ready
kubectl rollout status deployment/proof-workers -n $NAMESPACE

# Check worker health
kubectl get pods -l app=proof-workers -n $NAMESPACE
```

### Step 4: Deploy Main Speculation Components

```bash
# Deploy speculation service
helm upgrade --install agenc-speculation ./charts/speculation \
  --namespace $NAMESPACE \
  --set image.tag=$VERSION \
  --set speculation.enabled=false  # Start disabled!
  --values ./charts/speculation/values-${ENV}.yaml \
  --wait --timeout 5m

# Verify deployment
kubectl rollout status deployment/agenc-speculation -n $NAMESPACE
```

### Step 5: Run Health Checks

```bash
# Port forward for local access
kubectl port-forward svc/agenc-speculation 9090:9090 -n $NAMESPACE &

# Wait for service
sleep 5

# Health check
curl -s http://localhost:9090/health | jq
# Expected: {"status":"healthy","speculation":"disabled"}

# Readiness check
curl -s http://localhost:9090/ready | jq
# Expected: {"ready":true}
```

### Step 6: Run Smoke Tests

```bash
# Run smoke test suite
./scripts/smoke-test.sh --env $ENV

# Or manual tests:

# 1. Verify metrics endpoint
curl -s http://localhost:9090/metrics | grep -c speculation
# Expected: >20 metrics

# 2. Verify admin API
curl -s http://localhost:9090/admin/status | jq
# Expected: status object

# 3. Verify proof workers reachable
curl -s http://localhost:9091/health | jq
# Expected: {"status":"healthy"}
```

### Step 7: Enable Speculation (Canary)

```bash
# Enable at 10% rollout
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "speculation.enabled": true,
    "speculation.mode": "conservative",
    "speculation.max_depth": 2,
    "speculation.features.rollout_percentage": 10
  }'

# Verify enabled
curl -s http://localhost:9090/admin/status | jq .speculation
# Expected: {"enabled":true,"rollout_percentage":10}
```

### Step 8: Monitor Canary (15 minutes)

```bash
# Watch key metrics
watch -n 10 '
echo "=== Health ==="
curl -s http://localhost:9090/health | jq -r ".speculation"

echo "=== Rollback Rate ==="
curl -s http://localhost:9090/metrics | grep "speculation_operations_total" | grep rolled_back

echo "=== Memory ==="
curl -s http://localhost:9090/admin/memory-stats | jq ".total_mb, .limit_mb"

echo "=== Errors ==="
curl -s http://localhost:9090/metrics | grep "speculation_errors_total"
'
```

**Go/No-Go Criteria:**
- ✅ Rollback rate <5%
- ✅ No error spikes
- ✅ Memory stable
- ✅ Latency normal
- ❌ Any critical alerts → Rollback

### Step 9: Expand Rollout

```bash
# Expand to 50%
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 50}'

# Monitor 15 minutes
# ... watch metrics ...

# Expand to 100%
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 100}'

# Final verification
curl -s http://localhost:9090/admin/status | jq
```

---

## Health Checks

### Kubernetes Probes

```yaml
# Already configured in Helm chart
livenessProbe:
  httpGet:
    path: /health
    port: 9090
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 9090
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

### Manual Health Checks

```bash
# Basic health
curl -s http://localhost:9090/health
# {"status":"healthy","speculation":"enabled","version":"v1.2.3"}

# Detailed health
curl -s http://localhost:9090/health/detailed | jq
# {
#   "status": "healthy",
#   "components": {
#     "speculation": "healthy",
#     "proof_workers": "healthy",
#     "chain_connection": "healthy",
#     "stake_pool": "healthy"
#   },
#   "checks": {
#     "memory": {"status": "ok", "usage_percent": 45},
#     "proof_queue": {"status": "ok", "size": 120, "max": 2000},
#     "rollback_rate": {"status": "ok", "rate": 0.02}
#   }
# }

# Readiness (for load balancing)
curl -s http://localhost:9090/ready
# {"ready":true}
```

### Health Check Script

```bash
#!/bin/bash
# health-check.sh

set -e

SERVICE_URL=${1:-"http://localhost:9090"}

echo "Checking $SERVICE_URL..."

# Basic health
HEALTH=$(curl -sf "$SERVICE_URL/health")
STATUS=$(echo "$HEALTH" | jq -r '.status')

if [ "$STATUS" != "healthy" ]; then
  echo "❌ Health check failed: $HEALTH"
  exit 1
fi

# Component health
COMPONENTS=$(curl -sf "$SERVICE_URL/health/detailed" | jq -r '.components | to_entries[] | select(.value != "healthy") | .key')

if [ -n "$COMPONENTS" ]; then
  echo "❌ Unhealthy components: $COMPONENTS"
  exit 1
fi

echo "✅ All health checks passed"
```

---

## Smoke Tests

### Automated Smoke Test Suite

```bash
#!/bin/bash
# smoke-test.sh

set -e

SERVICE_URL=${SERVICE_URL:-"http://localhost:9090"}
ADMIN_TOKEN=${ADMIN_TOKEN:-"test-token"}

echo "=== AgenC Speculation Smoke Tests ==="
echo "Target: $SERVICE_URL"
echo ""

# Test 1: Health endpoint
echo -n "1. Health endpoint... "
HEALTH=$(curl -sf "$SERVICE_URL/health")
if echo "$HEALTH" | jq -e '.status == "healthy"' > /dev/null; then
  echo "✅ PASS"
else
  echo "❌ FAIL: $HEALTH"
  exit 1
fi

# Test 2: Metrics endpoint
echo -n "2. Metrics endpoint... "
METRICS=$(curl -sf "$SERVICE_URL/metrics")
METRIC_COUNT=$(echo "$METRICS" | grep -c "^speculation_" || true)
if [ "$METRIC_COUNT" -gt 10 ]; then
  echo "✅ PASS ($METRIC_COUNT metrics)"
else
  echo "❌ FAIL: Only $METRIC_COUNT speculation metrics"
  exit 1
fi

# Test 3: Admin API accessible
echo -n "3. Admin API... "
STATUS=$(curl -sf "$SERVICE_URL/admin/status" -H "Authorization: Bearer $ADMIN_TOKEN")
if echo "$STATUS" | jq -e '.speculation' > /dev/null; then
  echo "✅ PASS"
else
  echo "❌ FAIL: $STATUS"
  exit 1
fi

# Test 4: Config API
echo -n "4. Config API... "
CONFIG=$(curl -sf "$SERVICE_URL/admin/config" -H "Authorization: Bearer $ADMIN_TOKEN")
if echo "$CONFIG" | jq -e '.speculation.enabled != null' > /dev/null; then
  echo "✅ PASS"
else
  echo "❌ FAIL: $CONFIG"
  exit 1
fi

# Test 5: Proof workers reachable
echo -n "5. Proof workers... "
PROOF_HEALTH=$(curl -sf "http://localhost:9091/health" 2>/dev/null || echo '{"status":"unreachable"}')
if echo "$PROOF_HEALTH" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
  echo "✅ PASS"
else
  echo "⚠️ WARN: Proof workers may not be accessible"
fi

# Test 6: Chain connectivity
echo -n "6. Chain connectivity... "
CHAIN=$(curl -sf "$SERVICE_URL/admin/chain-status" -H "Authorization: Bearer $ADMIN_TOKEN")
if echo "$CHAIN" | jq -e '.connected == true' > /dev/null; then
  echo "✅ PASS"
else
  echo "❌ FAIL: Chain not connected"
  exit 1
fi

echo ""
echo "=== All smoke tests passed ==="
```

### Manual Smoke Tests

```bash
# 1. Create test speculation (if test mode available)
curl -X POST http://localhost:9090/admin/test/speculation \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"type": "synthetic", "depth": 2}'

# 2. Wait and check completion
sleep 10
curl -s http://localhost:9090/admin/test/speculation/latest | jq

# 3. Verify metrics updated
curl -s http://localhost:9090/metrics | grep speculation_operations_total

# 4. Check no errors logged
kubectl logs -l app=agenc-speculation --since=5m | grep -i error
```

---

## Canary Deployment Strategy

### Overview

```
Day 1: Deploy → 10% traffic → Monitor 4h
Day 2: 25% traffic → Monitor 8h  
Day 3: 50% traffic → Monitor 24h
Day 4: 100% traffic → Monitor ongoing
```

### Canary Configuration

```yaml
# values-canary.yaml
speculation:
  enabled: true
  mode: conservative
  features:
    rollout_percentage: 10
    
canary:
  enabled: true
  steps:
    - percentage: 10
      duration: 4h
      metrics:
        - name: rollback_rate
          threshold: 0.05
          operator: lt
        - name: error_rate
          threshold: 0.01
          operator: lt
    - percentage: 25
      duration: 8h
    - percentage: 50
      duration: 24h
    - percentage: 100
```

### Automated Canary with Flagger

```yaml
# flagger-canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: agenc-speculation
  namespace: agenc-production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: agenc-speculation
  progressDeadlineSeconds: 3600
  service:
    port: 9090
  analysis:
    interval: 5m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: speculation-rollback-rate
        templateRef:
          name: speculation-rollback-rate
          namespace: agenc-production
        thresholdRange:
          max: 5
        interval: 1m
      - name: speculation-error-rate
        templateRef:
          name: speculation-error-rate
          namespace: agenc-production
        thresholdRange:
          max: 1
        interval: 1m
    webhooks:
      - name: smoke-test
        type: pre-rollout
        url: http://flagger-loadtester.agenc-production/
        timeout: 5m
        metadata:
          type: bash
          cmd: "/scripts/smoke-test.sh"
```

### Manual Canary Progression

```bash
#!/bin/bash
# canary-progress.sh

ROLLOUT_STEPS=(10 25 50 100)
WAIT_TIMES=(240 480 1440 0)  # minutes

for i in "${!ROLLOUT_STEPS[@]}"; do
  PERCENT=${ROLLOUT_STEPS[$i]}
  WAIT=${WAIT_TIMES[$i]}
  
  echo "Setting rollout to ${PERCENT}%..."
  curl -X POST http://localhost:9090/admin/config \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d "{\"speculation.features.rollout_percentage\": $PERCENT}"
  
  if [ $WAIT -gt 0 ]; then
    echo "Monitoring for ${WAIT} minutes..."
    echo "Check dashboards. Ctrl+C to abort."
    
    # Simple monitoring loop
    for ((m=0; m<WAIT; m++)); do
      sleep 60
      
      # Check for issues
      ROLLBACK_RATE=$(curl -s http://localhost:9090/metrics | \
        grep 'speculation_rollback_rate' | awk '{print $2}')
      
      if (( $(echo "$ROLLBACK_RATE > 0.15" | bc -l) )); then
        echo "❌ Rollback rate too high ($ROLLBACK_RATE). Aborting!"
        curl -X POST http://localhost:9090/admin/config \
          -H "Authorization: Bearer $ADMIN_TOKEN" \
          -d '{"speculation.features.rollout_percentage": 0}'
        exit 1
      fi
      
      echo "  [$m/$WAIT min] Rollback rate: $ROLLBACK_RATE"
    done
  fi
done

echo "✅ Canary complete - 100% rollout"
```

---

## Rollback Procedures

### Quick Rollback (Config Only)

When speculation is causing issues but code is fine:

```bash
# Disable speculation immediately
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# Or reduce to 0%
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'
```

### Full Rollback (Code Change)

When you need to revert to previous version:

```bash
#!/bin/bash
# rollback.sh

PREVIOUS_VERSION=${1:-"v1.2.2"}
NAMESPACE=${NAMESPACE:-"agenc-production"}

echo "=== Rolling back to $PREVIOUS_VERSION ==="

# 1. Disable speculation first
echo "1. Disabling speculation..."
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# 2. Wait for pending operations
echo "2. Waiting for pending operations to drain..."
while true; do
  PENDING=$(curl -s http://localhost:9090/metrics | \
    grep speculation_pending_operations_count | awk '{print $2}')
  
  if [ "$PENDING" -lt 10 ]; then
    echo "   Pending operations: $PENDING (acceptable)"
    break
  fi
  
  echo "   Pending operations: $PENDING (waiting...)"
  sleep 10
done

# 3. Rollback Helm release
echo "3. Rolling back Helm release..."
helm rollback agenc-speculation -n $NAMESPACE

# Or deploy specific version
# helm upgrade --install agenc-speculation ./charts/speculation \
#   --namespace $NAMESPACE \
#   --set image.tag=$PREVIOUS_VERSION \
#   --wait --timeout 5m

# 4. Rollback proof workers
echo "4. Rolling back proof workers..."
helm rollback proof-workers -n $NAMESPACE

# 5. Wait for rollout
echo "5. Waiting for rollout..."
kubectl rollout status deployment/agenc-speculation -n $NAMESPACE
kubectl rollout status deployment/proof-workers -n $NAMESPACE

# 6. Verify health
echo "6. Verifying health..."
sleep 30
curl -s http://localhost:9090/health | jq

echo "=== Rollback complete ==="
echo "Speculation is DISABLED. Re-enable manually after verification."
```

### Kubernetes Native Rollback

```bash
# View rollout history
kubectl rollout history deployment/agenc-speculation -n $NAMESPACE

# Rollback to previous revision
kubectl rollout undo deployment/agenc-speculation -n $NAMESPACE

# Rollback to specific revision
kubectl rollout undo deployment/agenc-speculation -n $NAMESPACE --to-revision=3

# Watch rollback progress
kubectl rollout status deployment/agenc-speculation -n $NAMESPACE
```

### Emergency Rollback

When things are very broken:

```bash
# Nuclear option: scale to 0
kubectl scale deployment agenc-speculation --replicas=0 -n $NAMESPACE
kubectl scale deployment proof-workers --replicas=0 -n $NAMESPACE

# Wait for pods to terminate
kubectl wait --for=delete pod -l app=agenc-speculation -n $NAMESPACE --timeout=60s

# Deploy known good version
helm upgrade --install agenc-speculation ./charts/speculation \
  --namespace $NAMESPACE \
  --set image.tag=v1.2.1 \  # Last known good
  --set speculation.enabled=false \
  --wait --timeout 5m

# Bring up proof workers
helm upgrade --install proof-workers ./charts/proof-workers \
  --namespace $NAMESPACE \
  --set image.tag=v1.2.1 \
  --wait --timeout 5m
```

---

## Post-Deployment Verification

### Immediate (0-15 minutes)

- [ ] All pods running
  ```bash
  kubectl get pods -l app=agenc-speculation -n $NAMESPACE
  ```
- [ ] Health checks passing
- [ ] Metrics flowing to Prometheus
- [ ] No error spikes in logs
- [ ] Grafana dashboard showing data

### Short-term (15 min - 1 hour)

- [ ] Rollback rate <5%
- [ ] Confirmation latency stable
- [ ] Memory usage stable
- [ ] No alerts firing
- [ ] Proof queue draining normally

### Medium-term (1-24 hours)

- [ ] No drift in key metrics
- [ ] Stake pool balance stable
- [ ] No user complaints
- [ ] Error budget not depleting
- [ ] Performance matches staging

### Verification Script

```bash
#!/bin/bash
# verify-deployment.sh

echo "=== Post-Deployment Verification ==="

# Check pods
echo -n "Pods: "
READY=$(kubectl get pods -l app=agenc-speculation -n $NAMESPACE -o jsonpath='{.items[*].status.containerStatuses[*].ready}' | tr ' ' '\n' | grep -c true)
TOTAL=$(kubectl get pods -l app=agenc-speculation -n $NAMESPACE -o jsonpath='{.items[*].status.containerStatuses[*].ready}' | wc -w)
echo "$READY/$TOTAL ready"

# Check health
echo -n "Health: "
curl -sf http://localhost:9090/health | jq -r '.status'

# Check metrics
echo -n "Metrics: "
curl -sf http://localhost:9090/metrics | grep -c "^speculation_" 
echo " speculation metrics"

# Check rollback rate
echo -n "Rollback rate: "
curl -sf http://localhost:9090/metrics | grep 'speculation_rollback_rate' | awk '{print $2}'

# Check memory
echo -n "Memory: "
curl -sf http://localhost:9090/admin/memory-stats | jq -r '"\(.total_mb)MB / \(.limit_mb)MB"'

# Check proof queue
echo -n "Proof queue: "
curl -sf http://localhost:9091/metrics | grep 'proof_queue_size' | awk '{print $2}'

echo ""
echo "=== Verification complete ==="
```

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration options
- [MONITORING.md](./MONITORING.md) - Metrics and alerts
- [RUNBOOK.md](./RUNBOOK.md) - Operational procedures
