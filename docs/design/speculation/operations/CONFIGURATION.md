# Speculative Execution Configuration Guide

> **Quick Reference:** For a 3am incident, jump to [Emergency Overrides](#emergency-overrides)

## Table of Contents
- [Core Configuration](#core-configuration)
- [Stake Management](#stake-management)
- [Proof Generation](#proof-generation)
- [Resource Limits](#resource-limits)
- [Feature Flags](#feature-flags)
- [Environment Configs](#environment-specific-configurations)
- [Emergency Overrides](#emergency-overrides)
- [Example Files](#complete-example-configurations)

---

## Core Configuration

### `speculation.enabled`
**Type:** `bool`  
**Default:** `false`  
**Description:** Master switch for speculative execution. When disabled, all operations execute synchronously with immediate finality.

```toml
[speculation]
enabled = true
```

⚠️ **Warning:** Disabling this while speculative operations are in-flight will trigger rollbacks. See [RUNBOOK.md](./RUNBOOK.md#graceful-shutdown) for safe disable procedure.

---

### `speculation.mode`
**Type:** `enum`  
**Default:** `"conservative"`  
**Options:** `"conservative"` | `"balanced"` | `"aggressive"` | `"custom"`

| Mode | Max Depth | Parallel Branches | Risk Tolerance |
|------|-----------|-------------------|----------------|
| `conservative` | 3 | 2 | Low - rollback early |
| `balanced` | 5 | 4 | Medium |
| `aggressive` | 10 | 8 | High - maximize throughput |
| `custom` | User-defined | User-defined | User-defined |

```toml
[speculation]
mode = "balanced"
```

---

### `speculation.max_depth`
**Type:** `u32`  
**Default:** `5`  
**Range:** `1-20`  
**Recommended:** `3-8`

Maximum number of speculative operations that can chain without confirmation. Higher values increase throughput but risk larger rollbacks.

```toml
[speculation]
max_depth = 5
```

**Guidelines:**
- **Production:** 3-5 (balance throughput and rollback cost)
- **High-throughput:** 8-10 (accept larger rollback windows)
- **Safety-critical:** 1-2 (minimize speculation)

---

### `speculation.max_parallel_branches`
**Type:** `u32`  
**Default:** `4`  
**Range:** `1-16`  
**Recommended:** `2-8`

Maximum concurrent speculative execution paths. Each branch consumes memory for state snapshots.

```toml
[speculation]
max_parallel_branches = 4
```

**Memory impact:** ~50-200MB per branch depending on state size.

---

### `speculation.confirmation_timeout_ms`
**Type:** `u64`  
**Default:** `30000` (30 seconds)  
**Range:** `5000-300000`

How long to wait for finality before considering a speculative operation stale.

```toml
[speculation]
confirmation_timeout_ms = 30000
```

---

### `speculation.rollback_policy`
**Type:** `enum`  
**Default:** `"cascade"`  
**Options:** `"cascade"` | `"selective"` | `"checkpoint"`

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `cascade` | Rollback all dependent operations | Simple, predictable |
| `selective` | Only rollback directly affected | Higher throughput, complex |
| `checkpoint` | Rollback to last checkpoint | Hybrid approach |

```toml
[speculation]
rollback_policy = "cascade"
```

---

## Stake Management

### `speculation.stake.min_stake`
**Type:** `u64` (lamports)  
**Default:** `1_000_000` (0.001 SOL)

Minimum stake required to initiate speculative execution.

```toml
[speculation.stake]
min_stake = 1_000_000
```

---

### `speculation.stake.max_stake`
**Type:** `u64` (lamports)  
**Default:** `1_000_000_000` (1 SOL)

Maximum stake that can be locked in speculative operations per agent.

```toml
[speculation.stake]
max_stake = 1_000_000_000
```

---

### `speculation.stake.stake_per_depth`
**Type:** `u64` (lamports)  
**Default:** `100_000` (0.0001 SOL)

Additional stake required per speculation depth level.

```toml
[speculation.stake]
stake_per_depth = 100_000
```

**Formula:** `total_stake = min_stake + (depth * stake_per_depth)`

---

### `speculation.stake.slash_percentage`
**Type:** `f64`  
**Default:** `0.1` (10%)  
**Range:** `0.01-0.5`

Percentage of stake slashed on invalid speculation.

```toml
[speculation.stake]
slash_percentage = 0.1
```

---

### `speculation.stake.cooldown_period_ms`
**Type:** `u64`  
**Default:** `60000` (1 minute)

Cooldown after slash before agent can speculate again.

```toml
[speculation.stake]
cooldown_period_ms = 60000
```

---

## Proof Generation

### `speculation.proof.generator`
**Type:** `enum`  
**Default:** `"groth16"`  
**Options:** `"groth16"` | `"plonk"` | `"stark"` | `"mock"`

```toml
[speculation.proof]
generator = "groth16"
```

⚠️ **Warning:** `mock` is for testing only. Never use in production.

---

### `speculation.proof.worker_threads`
**Type:** `u32`  
**Default:** `4`  
**Range:** `1-32`  
**Recommended:** `num_cpus / 2`

```toml
[speculation.proof]
worker_threads = 4
```

---

### `speculation.proof.queue_size`
**Type:** `u32`  
**Default:** `1000`  
**Range:** `100-10000`

Maximum pending proof generation requests before backpressure.

```toml
[speculation.proof]
queue_size = 1000
```

---

### `speculation.proof.timeout_ms`
**Type:** `u64`  
**Default:** `60000`

Maximum time for proof generation before failure.

```toml
[speculation.proof]
timeout_ms = 60000
```

---

### `speculation.proof.batch_size`
**Type:** `u32`  
**Default:** `10`  
**Range:** `1-100`

Number of proofs to batch together for efficiency.

```toml
[speculation.proof]
batch_size = 10
```

---

## Resource Limits

### `speculation.limits.max_memory_mb`
**Type:** `u64`  
**Default:** `4096` (4GB)

Maximum memory for speculative state storage.

```toml
[speculation.limits]
max_memory_mb = 4096
```

---

### `speculation.limits.max_pending_operations`
**Type:** `u64`  
**Default:** `10000`

Maximum speculative operations awaiting confirmation.

```toml
[speculation.limits]
max_pending_operations = 10000
```

---

### `speculation.limits.max_state_snapshots`
**Type:** `u32`  
**Default:** `100`

Maximum concurrent state snapshots for rollback capability.

```toml
[speculation.limits]
max_state_snapshots = 100
```

---

### `speculation.limits.gc_interval_ms`
**Type:** `u64`  
**Default:** `30000`

How often to garbage collect confirmed/rolled-back state.

```toml
[speculation.limits]
gc_interval_ms = 30000
```

---

## Feature Flags

Use these for gradual rollout and A/B testing.

### `speculation.features.enable_parallel_speculation`
**Type:** `bool`  
**Default:** `true`

Allow multiple speculation branches simultaneously.

---

### `speculation.features.enable_cross_agent_speculation`
**Type:** `bool`  
**Default:** `false`

Allow speculative operations that depend on other agents' speculative state.

⚠️ **Risk:** High rollback cascade potential.

---

### `speculation.features.enable_optimistic_proofs`
**Type:** `bool`  
**Default:** `true`

Generate proofs optimistically before confirmation.

---

### `speculation.features.enable_stake_delegation`
**Type:** `bool`  
**Default:** `false`

Allow stake delegation for speculation.

---

### `speculation.features.rollout_percentage`
**Type:** `f64`  
**Default:** `100.0`  
**Range:** `0.0-100.0`

Percentage of agents/operations using speculation.

```toml
[speculation.features]
rollout_percentage = 10.0  # 10% canary
```

---

## Environment-Specific Configurations

### Development (`config/dev.toml`)

```toml
[speculation]
enabled = true
mode = "aggressive"
max_depth = 10
max_parallel_branches = 8
confirmation_timeout_ms = 5000

[speculation.stake]
min_stake = 1000  # Very low for testing
max_stake = 100_000
slash_percentage = 0.01

[speculation.proof]
generator = "mock"  # Fast, no real proofs
worker_threads = 2
queue_size = 100

[speculation.limits]
max_memory_mb = 1024
max_pending_operations = 1000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = true
enable_optimistic_proofs = true
rollout_percentage = 100.0
```

---

### Staging (`config/staging.toml`)

```toml
[speculation]
enabled = true
mode = "balanced"
max_depth = 5
max_parallel_branches = 4
confirmation_timeout_ms = 30000

[speculation.stake]
min_stake = 100_000
max_stake = 100_000_000
slash_percentage = 0.05

[speculation.proof]
generator = "groth16"
worker_threads = 4
queue_size = 500

[speculation.limits]
max_memory_mb = 2048
max_pending_operations = 5000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = false
enable_optimistic_proofs = true
rollout_percentage = 50.0
```

---

### Production (`config/prod.toml`)

```toml
[speculation]
enabled = true
mode = "conservative"
max_depth = 3
max_parallel_branches = 2
confirmation_timeout_ms = 60000
rollback_policy = "cascade"

[speculation.stake]
min_stake = 1_000_000
max_stake = 1_000_000_000
stake_per_depth = 500_000
slash_percentage = 0.1
cooldown_period_ms = 300000  # 5 minutes

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
rollout_percentage = 100.0
```

---

## Emergency Overrides

### Runtime Configuration (No Restart Required)

These can be changed via admin API or config reload:

```bash
# Disable speculation immediately
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.enabled": false}'

# Reduce max depth
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.max_depth": 1}'

# Pause new speculations (drain existing)
curl -X POST http://localhost:9090/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"speculation.features.rollout_percentage": 0}'
```

### Environment Variable Overrides

Environment variables take precedence over config files:

```bash
# Emergency disable
export AGENC_SPECULATION_ENABLED=false

# Reduce limits
export AGENC_SPECULATION_MAX_DEPTH=1
export AGENC_SPECULATION_MAX_PARALLEL_BRANCHES=1

# Force conservative mode
export AGENC_SPECULATION_MODE=conservative
```

### Config File Priority

1. Environment variables (highest)
2. Runtime API changes
3. `config/{env}.toml`
4. `config/default.toml`
5. Compiled defaults (lowest)

---

## Complete Example Configurations

### Minimal Safe Config

```toml
# Minimum viable speculation config
[speculation]
enabled = true
mode = "conservative"
max_depth = 2

[speculation.stake]
min_stake = 1_000_000

[speculation.proof]
generator = "groth16"
```

### High-Throughput Config

```toml
# Maximum performance, accept higher risk
[speculation]
enabled = true
mode = "aggressive"
max_depth = 10
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
batch_size = 50

[speculation.limits]
max_memory_mb = 16384
max_pending_operations = 100000

[speculation.features]
enable_parallel_speculation = true
enable_cross_agent_speculation = true
enable_optimistic_proofs = true
```

---

## Configuration Validation

The system validates configuration on startup:

```
✓ speculation.max_depth within range [1, 20]
✓ speculation.stake.slash_percentage within range [0.01, 0.5]
✓ speculation.proof.generator is valid
✓ speculation.limits.max_memory_mb >= 512
✓ Feature flag combinations are valid
```

Invalid configurations will:
1. Log detailed error messages
2. Fall back to defaults (if `--strict=false`)
3. Refuse to start (if `--strict=true`, recommended for prod)

---

## See Also

- [MONITORING.md](./MONITORING.md) - Metrics for these settings
- [RUNBOOK.md](./RUNBOOK.md) - When to change settings
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Rolling out config changes
