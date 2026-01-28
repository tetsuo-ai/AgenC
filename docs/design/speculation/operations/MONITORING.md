# Speculative Execution Monitoring Guide

> **3am Quick Reference:** Jump to [Alert Runbook](#alert-runbook-quick-reference) for immediate action items

## Table of Contents
- [Key Metrics](#key-metrics)
- [Alert Rules](#alert-rules)
- [Dashboard Setup](#dashboard-setup)
- [Log Analysis](#log-analysis)
- [Alert Runbook Quick Reference](#alert-runbook-quick-reference)
- [Grafana Dashboard JSON](#grafana-dashboard-json)

---

## Key Metrics

### Health Indicators (Check These First)

| Metric | Good | Warning | Critical | Description |
|--------|------|---------|----------|-------------|
| `speculation_enabled` | 1 | - | 0 | Master switch status |
| `speculation_health_score` | > 0.8 | 0.5-0.8 | < 0.5 | Composite health (0-1) |
| `speculation_rollback_rate` | < 5% | 5-15% | > 15% | Rollbacks / total ops |
| `speculation_confirmation_latency_p99` | < 30s | 30-60s | > 60s | Time to finality |

---

### Core Speculation Metrics

#### Throughput
```
speculation_operations_total{status="pending|confirmed|rolled_back"}
```
- **Type:** Counter
- **Labels:** `status`, `agent_id`, `operation_type`
- **Good:** Confirmed >> Rolled back

```
speculation_operations_rate
```
- **Type:** Gauge
- **Unit:** ops/second
- **Typical:** 100-10,000 depending on load

---

#### Depth & Branches
```
speculation_current_depth
```
- **Type:** Gauge
- **Warning:** > 80% of `max_depth`
- **Critical:** = `max_depth` (blocking new speculation)

```
speculation_active_branches
```
- **Type:** Gauge
- **Warning:** > 80% of `max_parallel_branches`

```
speculation_depth_histogram
```
- **Type:** Histogram
- **Buckets:** 1, 2, 3, 5, 8, 10, 15, 20
- **Watch:** Shift toward higher buckets indicates slower confirmation

---

#### Latency
```
speculation_confirmation_latency_seconds
```
- **Type:** Histogram
- **Buckets:** 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300
- **Key percentiles:** p50, p95, p99

```
speculation_rollback_latency_seconds
```
- **Type:** Histogram
- **Description:** Time to complete a rollback cascade

---

### Stake Metrics

```
speculation_stake_locked_total
```
- **Type:** Gauge
- **Unit:** lamports
- **Description:** Total stake currently locked in speculation

```
speculation_stake_locked_per_agent
```
- **Type:** Gauge
- **Labels:** `agent_id`
- **Warning:** Agent near `max_stake` limit

```
speculation_stake_slashed_total
```
- **Type:** Counter
- **Labels:** `reason`
- **Alert if:** Rapid increase

```
speculation_stake_utilization
```
- **Type:** Gauge
- **Formula:** `locked / max_stake`
- **Warning:** > 0.8
- **Critical:** > 0.95

---

### Proof Generation Metrics

```
speculation_proof_queue_size
```
- **Type:** Gauge
- **Warning:** > 50% of configured `queue_size`
- **Critical:** > 80%

```
speculation_proof_generation_seconds
```
- **Type:** Histogram
- **Buckets:** 0.1, 0.5, 1, 2, 5, 10, 30, 60
- **Labels:** `proof_type`

```
speculation_proof_failures_total
```
- **Type:** Counter
- **Labels:** `error_type`
- **Alert if:** Any increase above baseline

```
speculation_proof_worker_utilization
```
- **Type:** Gauge
- **Range:** 0-1 per worker
- **Warning:** All workers > 0.9

---

### Resource Metrics

```
speculation_memory_bytes
```
- **Type:** Gauge
- **Warning:** > 80% of `max_memory_mb`
- **Critical:** > 95%

```
speculation_state_snapshots_count
```
- **Type:** Gauge
- **Warning:** > 80% of `max_state_snapshots`

```
speculation_pending_operations_count
```
- **Type:** Gauge
- **Warning:** > 80% of `max_pending_operations`

```
speculation_gc_duration_seconds
```
- **Type:** Histogram
- **Warning if:** p99 > gc_interval_ms

---

### Error Metrics

```
speculation_errors_total
```
- **Type:** Counter
- **Labels:** `error_type`, `severity`
- **Types:** `validation_failed`, `stake_insufficient`, `timeout`, `proof_failed`, `rollback_failed`

```
speculation_circuit_breaker_state
```
- **Type:** Gauge
- **Values:** 0=closed, 1=half-open, 2=open
- **Alert if:** != 0

---

## Alert Rules

### Critical (Page Immediately)

#### Speculation Disabled Unexpectedly
```yaml
- alert: SpeculationDisabledUnexpectedly
  expr: speculation_enabled == 0 and speculation_enabled offset 5m == 1
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Speculation was disabled unexpectedly"
    runbook: "Check for crashes, config changes, or circuit breaker trips"
```

#### High Rollback Rate
```yaml
- alert: SpeculationHighRollbackRate
  expr: |
    rate(speculation_operations_total{status="rolled_back"}[5m]) 
    / rate(speculation_operations_total[5m]) > 0.15
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Rollback rate exceeds 15%"
    runbook: "See RUNBOOK.md#high-rollback-rate"
```

#### Stake Accumulation Spike
```yaml
- alert: SpeculationStakeAccumulationSpike
  expr: |
    (speculation_stake_locked_total - speculation_stake_locked_total offset 5m) 
    / speculation_stake_locked_total offset 5m > 0.5
  for: 3m
  labels:
    severity: critical
  annotations:
    summary: "Stake accumulation increased >50% in 5 minutes"
    runbook: "See RUNBOOK.md#stake-accumulation-spike"
```

#### Proof Queue Backlog
```yaml
- alert: SpeculationProofBacklogCritical
  expr: speculation_proof_queue_size > speculation_proof_queue_size_max * 0.9
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Proof generation queue is 90% full"
    runbook: "See RUNBOOK.md#proof-generation-backlog"
```

#### Memory Pressure
```yaml
- alert: SpeculationMemoryCritical
  expr: speculation_memory_bytes / (speculation_memory_limit_bytes) > 0.95
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Speculation memory usage >95%"
    runbook: "See RUNBOOK.md#memory-pressure"
```

#### Circuit Breaker Open
```yaml
- alert: SpeculationCircuitBreakerOpen
  expr: speculation_circuit_breaker_state == 2
  for: 0m
  labels:
    severity: critical
  annotations:
    summary: "Speculation circuit breaker is OPEN"
    runbook: "System has auto-disabled speculation due to errors"
```

---

### Warning (Investigate Soon)

#### Elevated Rollback Rate
```yaml
- alert: SpeculationElevatedRollbackRate
  expr: |
    rate(speculation_operations_total{status="rolled_back"}[5m]) 
    / rate(speculation_operations_total[5m]) > 0.05
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Rollback rate exceeds 5%"
```

#### High Confirmation Latency
```yaml
- alert: SpeculationHighConfirmationLatency
  expr: histogram_quantile(0.99, speculation_confirmation_latency_seconds_bucket) > 60
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "P99 confirmation latency exceeds 60s"
```

#### Proof Worker Saturation
```yaml
- alert: SpeculationProofWorkersSaturated
  expr: avg(speculation_proof_worker_utilization) > 0.85
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Proof workers running hot (>85% utilization)"
```

#### Depth Limit Approaching
```yaml
- alert: SpeculationDepthLimitApproaching
  expr: speculation_current_depth / speculation_max_depth > 0.8
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Speculation depth at >80% of limit"
```

#### Stake Utilization High
```yaml
- alert: SpeculationStakeUtilizationHigh
  expr: speculation_stake_utilization > 0.8
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Stake utilization exceeds 80%"
```

---

### Info (Log for Review)

```yaml
- alert: SpeculationSlashOccurred
  expr: increase(speculation_stake_slashed_total[5m]) > 0
  labels:
    severity: info
  annotations:
    summary: "Stake slash occurred"
```

---

## Dashboard Setup

### Essential Panels

#### 1. Health Overview (Top Row)
- **Stat:** Speculation Enabled (speculation_enabled)
- **Stat:** Health Score (speculation_health_score)
- **Stat:** Current Rollback Rate
- **Stat:** Active Operations

#### 2. Throughput (Second Row)
- **Graph:** Operations by Status (stacked area)
  - Confirmed (green)
  - Pending (yellow)
  - Rolled Back (red)
- **Graph:** Operations Rate (line)

#### 3. Latency (Third Row)
- **Heatmap:** Confirmation Latency Distribution
- **Graph:** P50, P95, P99 Latency Lines
- **Stat:** Current P99

#### 4. Speculation Depth (Fourth Row)
- **Gauge:** Current Depth vs Max
- **Histogram:** Depth Distribution
- **Graph:** Active Branches Over Time

#### 5. Stake Health (Fifth Row)
- **Gauge:** Stake Utilization
- **Graph:** Locked Stake Over Time
- **Table:** Top 10 Agents by Locked Stake
- **Counter:** Slashes (24h)

#### 6. Proof Generation (Sixth Row)
- **Gauge:** Queue Size vs Max
- **Graph:** Proof Generation Rate
- **Heatmap:** Proof Generation Time
- **Graph:** Worker Utilization

#### 7. Resources (Bottom Row)
- **Gauge:** Memory Usage
- **Gauge:** Pending Operations
- **Gauge:** State Snapshots
- **Graph:** GC Duration

---

## Log Analysis

### Loki/LogQL Queries

#### Recent Rollbacks
```logql
{app="agenc"} |= "rollback" | json | line_format "{{.operation_id}} - {{.reason}}"
```

#### Proof Failures
```logql
{app="agenc"} |= "proof_generation_failed" | json 
| __error__="" 
| line_format "{{.timestamp}} {{.error_type}}: {{.message}}"
```

#### Stake Slashes
```logql
{app="agenc"} |= "stake_slashed" | json
| line_format "Agent: {{.agent_id}} Amount: {{.amount}} Reason: {{.reason}}"
```

#### High Depth Operations
```logql
{app="agenc"} | json | depth > 5
| line_format "Depth {{.depth}}: {{.operation_id}}"
```

#### Timeout Events
```logql
{app="agenc"} |= "speculation_timeout" | json
| count_over_time([5m])
```

### Elasticsearch Queries

#### Rollbacks Last Hour
```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "event_type": "speculation_rollback" }},
        { "range": { "@timestamp": { "gte": "now-1h" }}}
      ]
    }
  },
  "aggs": {
    "by_reason": { "terms": { "field": "reason.keyword" }}
  }
}
```

#### Proof Failures by Type
```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "event_type": "proof_generation_failed" }},
        { "range": { "@timestamp": { "gte": "now-24h" }}}
      ]
    }
  },
  "aggs": {
    "by_error": { "terms": { "field": "error_type.keyword" }}
  }
}
```

#### Operations by Agent (Anomaly Detection)
```json
{
  "query": {
    "range": { "@timestamp": { "gte": "now-1h" }}
  },
  "aggs": {
    "by_agent": {
      "terms": { "field": "agent_id.keyword", "size": 100 },
      "aggs": {
        "rollback_rate": {
          "filter": { "term": { "status": "rolled_back" }}
        }
      }
    }
  }
}
```

---

## Alert Runbook Quick Reference

### 🔴 SpeculationHighRollbackRate
**Symptom:** >15% of operations rolling back  
**Immediate Actions:**
1. Check `{app="agenc"} |= "rollback" | json | count_over_time([1m]) by (reason)`
2. If network issues → wait for recovery
3. If agent-specific → check that agent's logs
4. If widespread → reduce `max_depth` to 1
5. **Escalate if:** Persists >15 min after mitigation

### 🔴 SpeculationStakeAccumulationSpike
**Symptom:** Stake locked increasing rapidly  
**Immediate Actions:**
1. Check confirmation latency - is finality slow?
2. Check proof generation queue - backlog?
3. If confirmations stuck → check upstream chain
4. If proofs stuck → scale proof workers
5. **Emergency:** Reduce rollout_percentage to 0

### 🔴 SpeculationProofBacklogCritical
**Symptom:** Proof queue >90% full  
**Immediate Actions:**
1. Check worker utilization
2. Scale up workers if available: `kubectl scale deployment proof-workers --replicas=16`
3. Increase batch_size temporarily
4. If persistent → reduce speculation throughput
5. **Escalate if:** Queue not draining within 10 min

### 🔴 SpeculationMemoryCritical
**Symptom:** Memory >95%  
**Immediate Actions:**
1. Trigger manual GC: `curl -X POST http://localhost:9090/admin/gc`
2. Reduce `max_pending_operations`
3. Reduce `max_state_snapshots`
4. If OOM imminent → disable speculation gracefully
5. **Escalate if:** Memory not dropping after GC

### 🟡 SpeculationHighConfirmationLatency
**Symptom:** P99 >60s  
**Actions:**
1. Check upstream chain latency
2. Check network connectivity
3. Consider reducing `max_depth` to limit exposure

### 🟡 SpeculationDepthLimitApproaching
**Symptom:** Operating near max depth  
**Actions:**
1. Check why confirmations are slow
2. This is usually a symptom, not root cause
3. Address underlying confirmation delays

---

## Grafana Dashboard JSON

Save as `speculation-dashboard.json` and import:

```json
{
  "annotations": {
    "list": [
      {
        "datasource": "-- Grafana --",
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Deployments",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "id": null,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "mappings": [
            { "options": { "0": { "color": "red", "text": "DISABLED" }, "1": { "color": "green", "text": "ENABLED" }}, "type": "value" }
          ],
          "thresholds": { "steps": [{ "color": "red", "value": null }, { "color": "green", "value": 1 }]}
        }
      },
      "gridPos": { "h": 4, "w": 4, "x": 0, "y": 0 },
      "id": 1,
      "options": { "colorMode": "background", "graphMode": "none", "justifyMode": "auto", "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
      "pluginVersion": "9.3.6",
      "targets": [{ "expr": "speculation_enabled", "refId": "A" }],
      "title": "Speculation Status",
      "type": "stat"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "decimals": 2,
          "max": 1,
          "min": 0,
          "thresholds": { "steps": [{ "color": "red", "value": null }, { "color": "yellow", "value": 0.5 }, { "color": "green", "value": 0.8 }]},
          "unit": "percentunit"
        }
      },
      "gridPos": { "h": 4, "w": 4, "x": 4, "y": 0 },
      "id": 2,
      "options": { "colorMode": "background", "graphMode": "area", "justifyMode": "auto", "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
      "targets": [{ "expr": "speculation_health_score", "refId": "A" }],
      "title": "Health Score",
      "type": "stat"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "decimals": 1,
          "max": 100,
          "min": 0,
          "thresholds": { "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 5 }, { "color": "red", "value": 15 }]},
          "unit": "percent"
        }
      },
      "gridPos": { "h": 4, "w": 4, "x": 8, "y": 0 },
      "id": 3,
      "options": { "colorMode": "background", "graphMode": "area", "justifyMode": "auto", "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
      "targets": [{ "expr": "rate(speculation_operations_total{status=\"rolled_back\"}[5m]) / rate(speculation_operations_total[5m]) * 100", "refId": "A" }],
      "title": "Rollback Rate",
      "type": "stat"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisLabel": "", "drawStyle": "line", "fillOpacity": 30, "lineWidth": 1, "stacking": { "mode": "normal" }},
          "unit": "ops"
        },
        "overrides": [
          { "matcher": { "id": "byName", "options": "confirmed" }, "properties": [{ "id": "color", "value": { "fixedColor": "green", "mode": "fixed" }}]},
          { "matcher": { "id": "byName", "options": "pending" }, "properties": [{ "id": "color", "value": { "fixedColor": "yellow", "mode": "fixed" }}]},
          { "matcher": { "id": "byName", "options": "rolled_back" }, "properties": [{ "id": "color", "value": { "fixedColor": "red", "mode": "fixed" }}]}
        ]
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
      "id": 4,
      "options": { "legend": { "calcs": ["sum"], "displayMode": "table", "placement": "bottom" }, "tooltip": { "mode": "multi" }},
      "targets": [{ "expr": "sum by (status) (rate(speculation_operations_total[5m]))", "legendFormat": "{{status}}", "refId": "A" }],
      "title": "Operations by Status",
      "type": "timeseries"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "drawStyle": "line", "fillOpacity": 0, "lineWidth": 2 },
          "unit": "s"
        }
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
      "id": 5,
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" }},
      "targets": [
        { "expr": "histogram_quantile(0.50, sum(rate(speculation_confirmation_latency_seconds_bucket[5m])) by (le))", "legendFormat": "p50", "refId": "A" },
        { "expr": "histogram_quantile(0.95, sum(rate(speculation_confirmation_latency_seconds_bucket[5m])) by (le))", "legendFormat": "p95", "refId": "B" },
        { "expr": "histogram_quantile(0.99, sum(rate(speculation_confirmation_latency_seconds_bucket[5m])) by (le))", "legendFormat": "p99", "refId": "C" }
      ],
      "title": "Confirmation Latency",
      "type": "timeseries"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "max": 100,
          "min": 0,
          "thresholds": { "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 80 }, { "color": "red", "value": 95 }]},
          "unit": "percent"
        }
      },
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 12 },
      "id": 6,
      "options": { "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "showThresholdLabels": false, "showThresholdMarkers": true },
      "targets": [{ "expr": "speculation_current_depth / speculation_max_depth * 100", "refId": "A" }],
      "title": "Depth Utilization",
      "type": "gauge"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "max": 100,
          "min": 0,
          "thresholds": { "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 80 }, { "color": "red", "value": 95 }]},
          "unit": "percent"
        }
      },
      "gridPos": { "h": 4, "w": 6, "x": 6, "y": 12 },
      "id": 7,
      "options": { "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "showThresholdLabels": false, "showThresholdMarkers": true },
      "targets": [{ "expr": "speculation_stake_utilization * 100", "refId": "A" }],
      "title": "Stake Utilization",
      "type": "gauge"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "max": 100,
          "min": 0,
          "thresholds": { "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 50 }, { "color": "red", "value": 80 }]},
          "unit": "percent"
        }
      },
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 12 },
      "id": 8,
      "options": { "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "showThresholdLabels": false, "showThresholdMarkers": true },
      "targets": [{ "expr": "speculation_proof_queue_size / speculation_proof_queue_size_max * 100", "refId": "A" }],
      "title": "Proof Queue",
      "type": "gauge"
    },
    {
      "datasource": "${datasource}",
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "max": 100,
          "min": 0,
          "thresholds": { "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 80 }, { "color": "red", "value": 95 }]},
          "unit": "percent"
        }
      },
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 12 },
      "id": 9,
      "options": { "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "showThresholdLabels": false, "showThresholdMarkers": true },
      "targets": [{ "expr": "speculation_memory_bytes / speculation_memory_limit_bytes * 100", "refId": "A" }],
      "title": "Memory Usage",
      "type": "gauge"
    }
  ],
  "refresh": "10s",
  "schemaVersion": 37,
  "style": "dark",
  "tags": ["agenc", "speculation"],
  "templating": {
    "list": [
      {
        "current": { "selected": false, "text": "Prometheus", "value": "Prometheus" },
        "hide": 0,
        "includeAll": false,
        "label": "Data Source",
        "name": "datasource",
        "options": [],
        "query": "prometheus",
        "refresh": 1,
        "type": "datasource"
      }
    ]
  },
  "time": { "from": "now-1h", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "AgenC Speculative Execution",
  "uid": "agenc-speculation",
  "version": 1
}
```

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - What these metrics measure
- [RUNBOOK.md](./RUNBOOK.md) - Detailed incident response
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deploying monitoring changes
