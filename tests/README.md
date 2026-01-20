# AgenC Test Suite

This directory contains the test suite for the AgenC coordination protocol.

## Test Organization

Tests are organized by functionality:

| File | Purpose | Lines |
|------|---------|-------|
| `smoke.ts` | Quick devnet validation tests | ~550 |
| `integration.ts` | Anchor 0.32 lifecycle tests | ~1200 |
| `coordination-security.ts` | Security focused tests (happy paths + edge cases) | ~1900 |
| `audit-high-severity.ts` | Tests for audit findings | ~900 |
| `complete_task_private.ts` | ZK private completion tests | ~700 |
| `sdk-proof-generation.ts` | SDK proof generation and binding tests | ~500 |
| `rate-limiting.ts` | Rate limiting behavior tests | ~900 |
| `upgrades.ts` | Protocol upgrade tests | ~500 |
| `task-state-machine.ts` | Task lifecycle state machine tests | ~1000 |
| `test_1.ts` | Main integration test suite (legacy) | ~7900 |
| `minimal.ts` | Minimal debugging tests | ~100 |

## Running Tests

### All Tests
```bash
anchor test
```

### Specific Test File
```bash
npx ts-mocha -p tsconfig.json tests/smoke.ts --timeout 120000
```

### Skip Long Tests
```bash
npx ts-mocha -p tsconfig.json tests/smoke.ts --grep "should" --timeout 60000
```

## Test Categories

### P0 Tests (Security Critical)
These tests verify security invariants and must pass before any deployment:
- `coordination-security.ts` - Core security tests
- `audit-high-severity.ts` - Audit finding validations
- `complete_task_private.ts` - ZK proof validation (including binding)
- `sdk-proof-generation.ts` - Binding security tests (fix #88, #96)

### P1 Tests (High Priority)
- `smoke.ts` - Basic deployment validation
- `rate-limiting.ts` - Rate limiting enforcement
- `task-state-machine.ts` - State machine invariants

### P2 Tests (Standard)
- `integration.ts` - Full lifecycle tests
- `upgrades.ts` - Version migration tests
- `test_1.ts` - Comprehensive integration tests

## Test Structure Guidelines

Each test file should:
1. Import shared helpers from a common module (avoid duplication)
2. Focus on one functional area
3. Include both happy path and rejection tests
4. Use unique agent/task IDs per run to avoid state conflicts
5. Clean up resources where practical

## Adding New Tests

When adding tests:
1. Determine which file the test belongs to (see table above)
2. If no appropriate file exists, create a new focused test file
3. Follow the existing patterns for setup/teardown
4. Use unique IDs to prevent conflicts with persistent validator state

## Legacy Tests and Consolidation Plan (Issue #95)

`test_1.ts` is a large legacy test file (7891 lines) that covers many scenarios.
New tests should be added to focused files rather than extending test_1.ts.

### Consolidation Plan

The following sections of test_1.ts should be extracted into focused files:

| Lines | Topic | Target File |
|-------|-------|-------------|
| 1859-2719 | Issue #19: Task Lifecycle State Machine | `task-state-machine.ts` |
| 2720-3835 | Issue #20: Authority and PDA Validation | `authority-validation.ts` |
| 4088-4899 | Issue #21: Escrow Fund Safety | `escrow-accounting.ts` |
| 4900-5799 | Issue #22: Dispute Initiation | `dispute-initiation.ts` |
| 5800-6351 | Issue #23: Dispute Voting/Resolution | `dispute-resolution.ts` |
| 6352-6754 | Issue #24: Reputation and Stake Safety | `reputation-stake.ts` |
| 6755-7225 | Issue #25: Concurrency/Race Conditions | `concurrency.ts` |
| 7226-7800 | Issue #26: Fuzzing/Invariants | `invariants.ts` |

### Migration Guidelines

When extracting tests:
1. Keep shared helpers in a common module to avoid duplication
2. Update imports to use the workspace pattern
3. Ensure unique IDs per test run
4. Run extracted tests to verify they still pass
5. Remove extracted tests from test_1.ts after verification

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANCHOR_PROVIDER_URL` | RPC endpoint (set by anchor test) |
| `ANCHOR_WALLET` | Wallet path (set by anchor test) |

## Common Issues

### Test Timeouts
Increase timeout for network-heavy tests:
```typescript
this.timeout(120000); // 2 minutes
```

### Rate Limiting on Devnet
Use the `ensureBalance` helper which handles airdrop rate limits with backoff.

### State Conflicts
Use unique run IDs (timestamp + random) for agent and task IDs:
```typescript
const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const agentId = Buffer.from(`test-${runId}`.slice(0, 32).padEnd(32, "\0"));
```
