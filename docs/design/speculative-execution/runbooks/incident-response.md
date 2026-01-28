# Speculative Execution Incident Response

> **Target Audience:** SRE, On-Call Engineers, Incident Commanders  
> **Last Updated:** 2025-01-28  
> **Review Cycle:** After each P1/P2 incident

## Table of Contents
- [Severity Definitions](#severity-definitions)
- [Response Procedures by Severity](#response-procedures-by-severity)
- [Communication Templates](#communication-templates)
- [Post-Mortem Template](#post-mortem-template)
- [Incident Runbooks by Type](#incident-runbooks-by-type)

---

## Severity Definitions

### Severity Matrix

| Severity | Impact | Examples | Response Time | Escalation |
|----------|--------|----------|---------------|------------|
| **P1 - Critical** | Service down, data integrity risk, significant financial impact | Speculation causing data corruption, cascading failures across system, >50% rollback rate | 5 min acknowledge, 15 min on bridge | Immediate to engineering leadership |
| **P2 - High** | Significant degradation, partial outage | Speculation auto-disabled, 25-50% rollback rate, proof generation >90% capacity | 15 min acknowledge, 1h resolution target | 1h to platform lead |
| **P3 - Medium** | Minor degradation, workaround available | Elevated rollback rate 10-25%, slow proofs, single pod issues | 4h acknowledge, 24h resolution target | Daily standup |
| **P4 - Low** | Minimal impact, cosmetic issues | Metrics gap, dashboard issues, config drift | Next business day | Backlog grooming |

### Impact Assessment Guide

Ask these questions to determine severity:

| Question | Yes → Higher Severity | No → Lower Severity |
|----------|----------------------|---------------------|
| Is speculation completely non-functional? | P1 | P2-P4 |
| Is user data at risk of corruption? | P1 | P2-P4 |
| Are transactions failing or funds at risk? | P1-P2 | P3-P4 |
| Is the system auto-protecting (disabled speculation)? | P2 | P3 |
| Are more than 10% of operations affected? | P2 | P3-P4 |
| Is there a workaround? | Lower by 1 level | Keep current level |
| Is it business hours in primary region? | Higher by 1 level | Keep current level |

---

## Response Procedures by Severity

### P1 - Critical Incident Response

**Time: 0-5 minutes**

1. **Acknowledge alert** - Click acknowledge in PagerDuty
2. **Join incident bridge** - Zoom: https://zoom.us/j/incident-bridge
3. **Announce on Slack** - Post to #incidents

```bash
# Immediate status check (run while joining bridge)
agenc admin status --component speculation --verbose
```

**Time: 5-15 minutes**

4. **Assess blast radius**

```bash
# Check impact scope
curl -s localhost:9090/metrics | grep -E 'speculation_(active|rollback|error)'
kubectl get pods -n production -l component=speculation
agenc speculation stuck --threshold 1m
```

5. **Decide: Mitigate or Investigate**

   - If clear remediation exists → Execute immediately
   - If unclear → Stabilize first (disable speculation)

6. **Execute mitigation**

```bash
# Option A: Disable speculation (safest)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# Option B: Reduce blast radius
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 1, "speculation.features.rollout_percentage": 1}'

# Verify mitigation worked
agenc admin status --component speculation
```

**Time: 15-30 minutes**

7. **Escalate if needed** - If root cause unclear, escalate to next level
8. **Document initial findings** - Update incident ticket
9. **Send first customer communication** (if customer-facing)

**Time: 30+ minutes**

10. **Root cause investigation** (parallel with mitigation monitoring)
11. **Develop fix plan**
12. **Implement fix** (with rollback plan)
13. **Restore service** (gradual)
14. **Confirm resolution**

### P2 - High Severity Response

**Time: 0-15 minutes**

1. **Acknowledge alert** - PagerDuty within 15 min
2. **Initial assessment**

```bash
agenc admin status --component speculation
./scripts/speculation-health.sh
```

3. **Post to Slack #platform-alerts** with initial assessment

**Time: 15-60 minutes**

4. **Diagnose using troubleshooting runbook**
5. **Implement fix or mitigation**
6. **Monitor for recovery**

**Time: 1-4 hours**

7. **Confirm full recovery**
8. **Document in incident ticket**
9. **Schedule post-mortem if warranted**

### P3 - Medium Severity Response

1. **Acknowledge within 4 hours**
2. **Create ticket if not auto-created**
3. **Investigate during business hours**
4. **Fix within 24 hours or document workaround**
5. **Update ticket with resolution**

### P4 - Low Severity Response

1. **Acknowledge next business day**
2. **Add to backlog**
3. **Fix in next sprint or as time allows**

---

## Communication Templates

### Internal Slack Updates

**Initial Alert (P1/P2)**

```
🚨 [P{X}] Speculation Incident - {Short Description}

**Status:** Investigating
**Impact:** {Brief impact statement}
**Incident Lead:** @{name}
**Bridge:** {zoom link}

Next update in 15 minutes.
```

**Update Template**

```
🔄 [P{X}] Speculation Incident Update

**Status:** {Investigating|Mitigating|Monitoring|Resolved}
**Duration:** {X} minutes
**Impact:** {Current impact}

**Progress:**
- {What we learned}
- {What we did}

**Next Steps:**
- {What's happening next}

Next update in {X} minutes.
```

**Resolution**

```
✅ [P{X}] Speculation Incident Resolved

**Duration:** {Total time}
**Root Cause:** {Brief summary}
**Resolution:** {What fixed it}

**Action Items:**
- [ ] Post-mortem scheduled for {date}
- [ ] {Other follow-ups}

Full details in incident ticket: {link}
```

### Customer-Facing Communication

**Initial Notice (for customer-impacting P1)**

```
Subject: [Investigating] AgenC Speculation Service Degradation

We are currently investigating an issue affecting speculative task execution. 
Some transactions may experience delays or failures.

Impact: {Description of user-visible impact}
Started: {Time} UTC

We are actively working to resolve this and will provide updates every 30 minutes.

Status page: https://status.agenc.io
```

**Update**

```
Subject: [Update] AgenC Speculation Service Degradation

Update as of {Time} UTC:

We have identified the root cause and are implementing a fix. 
{Additional context if helpful}

Current Impact: {Updated impact}
ETA to Resolution: {If known}

Next update in 30 minutes or upon resolution.
```

**Resolution**

```
Subject: [Resolved] AgenC Speculation Service Degradation

The issue affecting speculative task execution has been resolved as of {Time} UTC.

Duration: {X hours/minutes}
Root Cause: {Customer-appropriate summary}
Resolution: {What was done}

All services are now operating normally. We apologize for any inconvenience.

A full post-mortem will be published within {X} days.
```

### Escalation Template

```
Subject: Escalation Required - P{X} Speculation Incident

Hi {Name},

I'm escalating a P{X} speculation incident that requires your attention.

**Summary:** {One-line description}

**Current Situation:**
- Started: {Time}
- Impact: {Description}
- What we've tried: {Brief list}

**Why escalating:**
- {Reason - e.g., "Need decision on emergency config change", "Root cause outside my expertise"}

**What we need:**
- {Specific ask}

**Bridge:** {Link}
**Ticket:** {Link}

--{Your name}
```

---

## Post-Mortem Template

### Incident Post-Mortem: {Title}

```markdown
# Incident Post-Mortem: {Title}

**Date:** YYYY-MM-DD
**Duration:** X hours Y minutes
**Severity:** P{X}
**Author:** {Name}
**Reviewers:** {Names}

---

## Executive Summary

{2-3 sentence summary of what happened, impact, and resolution}

---

## Timeline

All times in UTC.

| Time | Event |
|------|-------|
| HH:MM | Alert fired: {alert name} |
| HH:MM | On-call acknowledged |
| HH:MM | Incident bridge opened |
| HH:MM | Initial assessment complete |
| HH:MM | Mitigation applied: {what} |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Service recovered |
| HH:MM | Incident resolved |

---

## Impact

### User Impact
- {Number} users affected
- {Number} transactions failed
- {Number} rollbacks occurred
- {Financial impact if applicable}

### System Impact
- {Services affected}
- {SLO breaches}

### Duration
- Time to Detect (TTD): X minutes
- Time to Mitigate (TTM): X minutes  
- Time to Resolve (TTR): X minutes

---

## Root Cause Analysis

### What Happened
{Detailed technical explanation of the failure}

### Why It Happened
{Chain of causation - use 5 Whys if helpful}

1. Why? {First level}
2. Why? {Second level}
3. Why? {Third level}
4. Why? {Fourth level}
5. Why? {Root cause}

### Contributing Factors
- {Factor 1}
- {Factor 2}
- {Factor 3}

---

## What Went Well

- {Thing that worked}
- {Good decision made}
- {Process that helped}

---

## What Went Poorly

- {Thing that didn't work}
- {Process gap}
- {Missing information}

---

## Where We Got Lucky

- {Near miss or thing that could have been worse}

---

## Action Items

| ID | Action | Owner | Priority | Due Date | Status |
|----|--------|-------|----------|----------|--------|
| 1 | {Action description} | @name | P1/P2/P3 | YYYY-MM-DD | Open |
| 2 | {Action description} | @name | P1/P2/P3 | YYYY-MM-DD | Open |
| 3 | {Action description} | @name | P1/P2/P3 | YYYY-MM-DD | Open |

### Action Categories

**Detection Improvements**
- {Actions to detect faster}

**Prevention Improvements**
- {Actions to prevent recurrence}

**Response Improvements**
- {Actions to respond better}

**Documentation/Runbook Updates**
- {Actions to update docs}

---

## Lessons Learned

{Key takeaways for the team and organization}

---

## Appendix

### Relevant Logs/Graphs
{Screenshots or links to relevant data}

### Related Incidents
{Links to similar past incidents}

### References
{Links to relevant documentation, code, etc.}
```

---

## Incident Runbooks by Type

### INC-SPEC-001: Cascading Rollback Storm

**Trigger:** Rollback rate > 50% for > 2 minutes

**Immediate Actions:**
```bash
# 1. Disable speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# 2. Drain existing tasks
curl -X POST http://localhost:9090/admin/speculation/drain \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --max-time 120

# 3. Check for cascade source
agenc speculation rollbacks --since 10m --verbose | head -50
```

**Investigation:**
- Identify the originating failure
- Check if external dependency failed (RPC, Oracle)
- Check for recent config/code changes

**Recovery:**
- Fix root cause
- Re-enable with `max_depth: 1`
- Gradually increase

---

### INC-SPEC-002: Memory Exhaustion

**Trigger:** Memory > 95% or OOMKilled pods

**Immediate Actions:**
```bash
# 1. Force GC
agenc admin gc --component speculation --force

# 2. Clear old snapshots
agenc speculation snapshots clear --older-than 30m --confirm

# 3. If still high, reduce depth
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 2}'

# 4. If critical, disable
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'
```

**Investigation:**
- Check for memory leak pattern
- Look for stuck tasks holding state
- Analyze snapshot accumulation

**Recovery:**
- Fix leak if found
- Scale memory if legitimate growth
- Tune snapshot limits

---

### INC-SPEC-003: Proof Generation Failure

**Trigger:** Proof queue > 95% or proof worker pods failing

**Immediate Actions:**
```bash
# 1. Check proof worker status
agenc proof-worker status

# 2. Scale up workers
kubectl scale deployment proof-worker -n production --replicas=16

# 3. Reduce incoming load
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 25}'

# 4. Clear stuck proofs
agenc proof-worker timeout --older-than 10m
```

**Investigation:**
- Check proof worker logs for errors
- Verify circuit validity
- Check for resource exhaustion

**Recovery:**
- Fix circuit issues
- Increase worker capacity
- Tune batch sizes

---

### INC-SPEC-004: State Corruption

**Trigger:** State integrity check failures, inconsistent data

**Immediate Actions:**
```bash
# 1. IMMEDIATELY disable speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# 2. Stop all workers
kubectl scale deployment agenc-worker -n production --replicas=0

# 3. Run integrity check
agenc admin check-integrity --component speculation --full
```

**Investigation:**
- DO NOT attempt to fix data without understanding scope
- Engage data engineering team
- Check for race conditions or concurrent modification bugs

**Recovery:**
- Restore from last known good state
- Validate all data before re-enabling
- Deploy fix for root cause first

---

### INC-SPEC-005: Stake/Financial Impact

**Trigger:** Unexpected stake slashing, financial loss detected

**Immediate Actions:**
```bash
# 1. Disable speculation
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# 2. Document current stake status
agenc stake status > stake_snapshot_$(date +%Y%m%d_%H%M%S).txt

# 3. Check slashing events
agenc stake slashing-history --since 24h
```

**Escalation:** Immediately escalate to:
- Engineering Leadership
- Finance team
- Legal (if significant amount)

**Investigation:**
- Determine if slashing was legitimate or bug
- Calculate total financial impact
- Check for exploit patterns

**Recovery:**
- Fix root cause before re-enabling
- Consider recovery mechanisms if slashing was due to bug
- Update risk parameters

---

## See Also

- [deployment-runbook.md](./deployment-runbook.md) - Deployment procedures
- [operations-runbook.md](./operations-runbook.md) - Day-to-day operations
- [troubleshooting-runbook.md](./troubleshooting-runbook.md) - Issue diagnosis
- [tuning-guide.md](./tuning-guide.md) - Performance optimization
