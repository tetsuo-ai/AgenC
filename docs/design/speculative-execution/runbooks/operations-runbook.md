# Speculative Execution Operations Runbook

> **Target Audience:** SRE, On-Call Engineers, Operations  
> **Last Updated:** 2025-01-28  
> **Review Cycle:** Monthly

## Table of Contents
- [Monitoring Dashboard Setup](#monitoring-dashboard-setup)
- [Key Metrics to Watch](#key-metrics-to-watch)
- [Alert Thresholds](#alert-thresholds)
- [On-Call Procedures](#on-call-procedures)
- [Escalation Paths](#escalation-paths)
- [Routine Operations](#routine-operations)

---

## Monitoring Dashboard Setup

### Grafana Dashboard Import

```bash
# Import speculation dashboard
curl -X POST http://grafana:3000/api/dashboards/import \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d @dashboards/speculation-overview.json

# Dashboard UID: speculation-overview
# URL: http://grafana:3000/d/speculation-overview
```

### Dashboard Panels

#### Panel 1: Speculation Health Overview

```promql
# Speculation Success Rate (last 1h)
1 - (
  sum(rate(speculation_rollback_total[1h])) /
  sum(rate(speculation_tasks_total[1h]))
)
```

**Visualization:** Stat panel with thresholds
- Green: > 95%
- Yellow: 90-95%
- Red: < 90%

#### Panel 2: Active Speculative Tasks

```promql
# Current active speculative tasks
speculation_active_tasks

# By depth level
speculation_active_tasks_by_depth{depth=~".+"}
```

**Visualization:** Time series with stacked areas

#### Panel 3: Rollback Rate

```promql
# Rollback rate per minute
sum(rate(speculation_rollback_total[5m])) * 60

# Rollback by reason
sum(rate(speculation_rollback_total[5m])) by (reason) * 60
```

**Visualization:** Time series with legend showing reasons

#### Panel 4: Proof Generation Performance

```promql
# Proof generation p50, p90, p99
histogram_quantile(0.5, sum(rate(speculation_proof_generation_seconds_bucket[5m])) by (le))
histogram_quantile(0.9, sum(rate(speculation_proof_generation_seconds_bucket[5m])) by (le))
histogram_quantile(0.99, sum(rate(speculation_proof_generation_seconds_bucket[5m])) by (le))
```

**Visualization:** Time series with three lines

#### Panel 5: Memory Usage

```promql
# Total speculation memory
speculation_memory_usage_bytes / 1024 / 1024

# Memory by component
speculation_memory_usage_bytes{component=~".+"} / 1024 / 1024
```

**Visualization:** Time series (MB)

#### Panel 6: Proof Queue Depth

```promql
# Current queue depth
speculation_proof_queue_depth

# Queue capacity utilization
speculation_proof_queue_depth / speculation_proof_queue_capacity * 100
```

**Visualization:** Gauge with thresholds (80% warning, 95% critical)

#### Panel 7: Speculation Depth Distribution

```promql
# Histogram of speculation depths
sum(rate(speculation_depth_histogram_bucket[5m])) by (le)
```

**Visualization:** Heatmap

#### Panel 8: Stake Metrics

```promql
# Total stake locked
speculation_stake_locked_lamports / 1e9

# Stake slashed (last 24h)
sum(increase(speculation_stake_slashed_total[24h]))
```

**Visualization:** Stat panels

### Dashboard JSON Export

```json
{
  "dashboard": {
    "uid": "speculation-overview",
    "title": "Speculative Execution Overview",
    "tags": ["agenc", "speculation"],
    "refresh": "30s",
    "time": {
      "from": "now-1h",
      "to": "now"
    },
    "panels": [
      {
        "title": "Success Rate",
        "type": "stat",
        "gridPos": {"h": 4, "w": 6, "x": 0, "y": 0}
      },
      {
        "title": "Active Tasks",
        "type": "timeseries",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 4}
      },
      {
        "title": "Rollback Rate",
        "type": "timeseries",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 4}
      }
    ]
  }
}
```

---

## Key Metrics to Watch

### Tier 1: Critical (Check Every 5 Minutes During Incidents)

| Metric | Query | Healthy Range | Alert Threshold |
|--------|-------|---------------|-----------------|
| **Success Rate** | `1 - (rollback / total)` | > 95% | < 90% |
| **Active Tasks** | `speculation_active_tasks` | < 80% of max | > 90% of max |
| **Proof Queue** | `queue_depth / capacity` | < 70% | > 85% |
| **Memory Usage** | `memory_bytes / max_memory` | < 75% | > 85% |

### Tier 2: Important (Check Hourly)

| Metric | Query | Healthy Range | Warning Threshold |
|--------|-------|---------------|-------------------|
| **Rollback Rate** | `rate(rollback_total[5m])` | < 5/min | > 10/min |
| **Proof Latency p99** | `histogram_quantile(0.99, ...)` | < 60s | > 90s |
| **Stake Slashes** | `increase(slashed[1h])` | 0 | > 0 |
| **Max Depth** | `max(speculation_depth)` | ≤ configured max | > configured |

### Tier 3: Operational (Daily Review)

| Metric | Query | Purpose |
|--------|-------|---------|
| **Total Tasks** | `increase(tasks_total[24h])` | Volume trending |
| **Avg Speculation Depth** | `avg(speculation_depth)` | Behavior analysis |
| **Rollback Reasons** | `sum by (reason)` | Root cause patterns |
| **Resource Efficiency** | `confirmed / (confirmed + rollback)` | Waste analysis |

### Quick Health Check Script

```bash
#!/bin/bash
# speculation-health.sh - Run for quick status

METRICS_URL="http://localhost:9090/metrics"

echo "=== Speculative Execution Health Check ==="
echo "Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# Active tasks
ACTIVE=$(curl -s $METRICS_URL | grep '^speculation_active_tasks ' | awk '{print $2}')
echo "Active Speculative Tasks: $ACTIVE"

# Rollback rate (last 5 min)
ROLLBACKS=$(curl -s $METRICS_URL | grep '^speculation_rollback_total ' | awk '{print $2}')
echo "Total Rollbacks: $ROLLBACKS"

# Memory usage
MEMORY_MB=$(curl -s $METRICS_URL | grep '^speculation_memory_usage_bytes ' | awk '{printf "%.0f", $2/1024/1024}')
echo "Memory Usage: ${MEMORY_MB} MB"

# Proof queue
QUEUE=$(curl -s $METRICS_URL | grep '^speculation_proof_queue_depth ' | awk '{print $2}')
CAPACITY=$(curl -s $METRICS_URL | grep '^speculation_proof_queue_capacity ' | awk '{print $2}')
echo "Proof Queue: $QUEUE / $CAPACITY"

# Overall status
if [[ "$ACTIVE" -lt 1000 && "$MEMORY_MB" -lt 6000 ]]; then
  echo ""
  echo "Status: ✓ HEALTHY"
else
  echo ""
  echo "Status: ⚠ NEEDS ATTENTION"
fi
```

---

## Alert Thresholds

### Critical Alerts (P1 - Page Immediately)

```yaml
# prometheus/rules/speculation-critical.yaml

groups:
  - name: speculation-critical
    rules:
      - alert: SpeculationSuccessRateCritical
        expr: |
          (1 - sum(rate(speculation_rollback_total[5m])) / 
           sum(rate(speculation_tasks_total[5m]))) < 0.85
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Speculation success rate critically low"
          description: "Success rate is {{ $value | humanizePercentage }}"
          runbook: "https://wiki/runbooks/speculation/high-rollback-rate"

      - alert: SpeculationMemoryExhaustion
        expr: |
          speculation_memory_usage_bytes / 
          speculation_memory_limit_bytes > 0.95
        for: 2m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Speculation memory near exhaustion"
          description: "Memory at {{ $value | humanizePercentage }} of limit"
          runbook: "https://wiki/runbooks/speculation/memory-growth"

      - alert: SpeculationDisabledAutomatically
        expr: speculation_auto_disabled == 1
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Speculation auto-disabled due to failures"
          description: "System automatically disabled speculation"
          runbook: "https://wiki/runbooks/speculation/auto-disabled"

      - alert: SpeculationProofQueueBacklog
        expr: |
          speculation_proof_queue_depth / 
          speculation_proof_queue_capacity > 0.95
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Proof generation queue critically full"
          description: "Queue at {{ $value | humanizePercentage }} capacity"
          runbook: "https://wiki/runbooks/speculation/proof-queue-full"
```

### Warning Alerts (P2 - Investigate Soon)

```yaml
# prometheus/rules/speculation-warning.yaml

groups:
  - name: speculation-warning
    rules:
      - alert: SpeculationRollbackRateHigh
        expr: sum(rate(speculation_rollback_total[15m])) * 60 > 10
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Elevated speculation rollback rate"
          description: "{{ $value | printf \"%.1f\" }} rollbacks/min"

      - alert: SpeculationProofLatencyHigh
        expr: |
          histogram_quantile(0.99, 
            sum(rate(speculation_proof_generation_seconds_bucket[10m])) by (le)
          ) > 90
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Proof generation latency elevated"
          description: "p99 latency is {{ $value | printf \"%.0f\" }}s"

      - alert: SpeculationStakeSlashed
        expr: increase(speculation_stake_slashed_total[1h]) > 0
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Speculation stake was slashed"
          description: "{{ $value }} slashing events in last hour"

      - alert: SpeculationDepthExceeded
        expr: max(speculation_current_depth) > speculation_max_depth * 0.9
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Speculation depth approaching limit"
          description: "Current max depth: {{ $value }}"
```

### Info Alerts (P3 - Track and Trend)

```yaml
# prometheus/rules/speculation-info.yaml

groups:
  - name: speculation-info
    rules:
      - alert: SpeculationDisabled
        expr: speculation_enabled == 0
        labels:
          severity: info
          team: platform
        annotations:
          summary: "Speculation is disabled"
          description: "Feature is currently disabled"

      - alert: SpeculationLowUtilization
        expr: speculation_active_tasks < 10
        for: 1h
        labels:
          severity: info
          team: platform
        annotations:
          summary: "Low speculation utilization"
          description: "Only {{ $value }} active speculative tasks"
```

### Alert Routing (AlertManager)

```yaml
# alertmanager/config.yaml

route:
  receiver: 'default'
  routes:
    - match:
        severity: critical
        team: platform
      receiver: 'platform-pagerduty'
      continue: true
    - match:
        severity: warning
        team: platform  
      receiver: 'platform-slack'
    - match:
        severity: info
      receiver: 'platform-slack-low'

receivers:
  - name: 'platform-pagerduty'
    pagerduty_configs:
      - service_key: '$PAGERDUTY_KEY'
        severity: '{{ .CommonLabels.severity }}'
        
  - name: 'platform-slack'
    slack_configs:
      - channel: '#platform-alerts'
        send_resolved: true
        
  - name: 'platform-slack-low'
    slack_configs:
      - channel: '#platform-alerts-low'
```

---

## On-Call Procedures

### Receiving an Alert

1. **Acknowledge the alert** within 5 minutes
2. **Check the dashboard** at `grafana/d/speculation-overview`
3. **Run health check**: `./scripts/speculation-health.sh`
4. **Consult runbook** linked in alert annotation

### Triage Decision Tree

```
┌─────────────────────────────────────────────────────────────┐
│                     ALERT RECEIVED                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Is speculation functioning?                     │
│    (Check: speculation_enabled == 1, active_tasks > 0)      │
└─────────────────────────────────────────────────────────────┘
                    │                    │
                   Yes                   No
                    │                    │
                    ▼                    ▼
         ┌──────────────────┐   ┌──────────────────────┐
         │ Check rollback   │   │ Check auto-disable   │
         │ rate & memory    │   │ reason in logs       │
         └──────────────────┘   └──────────────────────┘
                    │                    │
          ┌────────┴────────┐            │
          │                 │            ▼
    High Rollback    High Memory   ┌───────────────────┐
          │                 │      │ Manual re-enable  │
          ▼                 ▼      │ after fixing root │
    See: High         See: Memory  │ cause             │
    Rollback Rate     Growth       └───────────────────┘
    Troubleshoot      Troubleshoot
```

### Shift Handoff Checklist

```markdown
## Speculation Status Handoff

**Date:** YYYY-MM-DD
**Outgoing:** [Name]
**Incoming:** [Name]

### Current State
- [ ] Speculation enabled: Yes/No
- [ ] Rollout percentage: X%
- [ ] Active tasks: X
- [ ] Memory usage: X MB

### Active Issues
- Issue 1: [Description]
- Issue 2: [Description]

### Recent Changes
- [YYYY-MM-DD HH:MM] Config change: [description]
- [YYYY-MM-DD HH:MM] Deployment: [version]

### Open Alerts
- Alert 1: [Name] - [Status]

### Notes for Next Shift
- [Important context]
```

### Daily Operations Checklist

| Time | Task | Command/Action |
|------|------|----------------|
| 09:00 | Review overnight alerts | Check PagerDuty/Slack history |
| 09:15 | Run health check | `./scripts/speculation-health.sh` |
| 09:30 | Check dashboard | Review 24h trends |
| 12:00 | Midday spot check | Quick metrics review |
| 17:00 | End-of-day review | Document any issues |
| 17:30 | Handoff notes | Update shift log |

---

## Escalation Paths

### Escalation Matrix

| Severity | Time to Escalate | Escalate To | Contact Method |
|----------|------------------|-------------|----------------|
| P1 Critical | Immediate if stuck > 15min | Platform Lead | PagerDuty |
| P1 Critical | 30 min | Engineering Manager | Phone |
| P2 Warning | 2 hours | Platform Lead | Slack |
| P2 Warning | 4 hours | Engineering Manager | Email |
| P3 Info | Next standup | Team | Standup |

### Escalation Triggers

**Escalate immediately if:**
- Rollback rate > 50% for > 5 minutes
- Memory > 95% and climbing
- Speculation auto-disabled with no obvious cause
- Stake slashing detected in production
- Customer-facing impact confirmed

**Escalate within 30 minutes if:**
- Cannot diagnose root cause
- Fix requires code change
- Need infrastructure changes
- Multiple subsystems affected

### Contact Directory

| Role | Name | Slack | PagerDuty | Phone |
|------|------|-------|-----------|-------|
| Primary On-Call | Rotation | @oncall-platform | Auto | Auto |
| Platform Lead | [Name] | @platform-lead | ID: xxx | +1-xxx |
| Eng Manager | [Name] | @eng-manager | ID: xxx | +1-xxx |
| Solana SME | [Name] | @solana-sme | ID: xxx | +1-xxx |
| ZK/Proof SME | [Name] | @zk-sme | ID: xxx | +1-xxx |

### Incident Bridge

For P1 incidents, open an incident bridge:
- **Zoom:** https://zoom.us/j/incident-bridge
- **Slack:** #incident-room (auto-created)
- **Passcode:** [From PagerDuty]

---

## Routine Operations

### Weekly Tasks

| Day | Task | Procedure |
|-----|------|-----------|
| Monday | Review past week metrics | Generate weekly report |
| Tuesday | Check capacity trends | Project 30-day growth |
| Wednesday | Review rollback patterns | Analyze top 5 reasons |
| Thursday | Proof worker health | Check CPU/memory trends |
| Friday | Documentation review | Update runbooks if needed |

### Monthly Tasks

| Task | Procedure |
|------|-----------|
| **Capacity Planning** | Review growth, plan scaling |
| **Configuration Audit** | Verify prod config matches docs |
| **Alert Tuning** | Review false positives, adjust thresholds |
| **Runbook Review** | Update based on incident learnings |
| **Dependency Updates** | Check for security patches |

### Quarterly Tasks

| Task | Procedure |
|------|-----------|
| **Load Testing** | Run full load test suite |
| **Chaos Testing** | Run failure injection tests |
| **DR Drill** | Practice full rollback procedure |
| **SLO Review** | Assess if SLOs need adjustment |

### Useful Commands Reference

```bash
# Quick status
agenc admin status --component speculation

# View current config
agenc config show --section speculation

# List active speculative tasks
agenc speculation list --status active

# Force GC of stale state
agenc admin gc --component speculation --force

# Check proof worker status
agenc proof-worker status

# View recent rollbacks
agenc speculation rollbacks --since 1h --limit 50

# Export metrics for analysis
curl -s localhost:9090/metrics | grep speculation > speculation_metrics_$(date +%Y%m%d_%H%M%S).txt

# Tail speculation logs
kubectl logs -l app=agenc-worker -n production -f | grep -E 'speculation|rollback|proof'
```

---

## See Also

- [deployment-runbook.md](./deployment-runbook.md) - Deployment procedures
- [troubleshooting-runbook.md](./troubleshooting-runbook.md) - Issue diagnosis
- [incident-response.md](./incident-response.md) - Incident procedures
- [tuning-guide.md](./tuning-guide.md) - Performance tuning
