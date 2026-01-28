# Integration Test Plan: Speculative Execution

> **Version:** 1.0  
> **Last Updated:** 2025-01-28  
> **Scope:** End-to-end integration tests for speculative execution flows

## Overview

This document specifies integration tests that verify the interaction between multiple components in the speculative execution system. Tests cover happy paths, failure scenarios, limit enforcement, and edge cases.

---

## Test Environment

### Test Setup Requirements

```typescript
interface IntegrationTestContext {
  // Core components
  dependencyGraph: DependencyGraph;
  commitmentLedger: CommitmentLedger;
  proofDeferralManager: ProofDeferralManager;
  rollbackController: RollbackController;
  speculativeScheduler: SpeculativeScheduler;
  
  // External dependencies (mocked or local)
  solanaValidator: LocalValidator;  // local-validator or mock
  proofGenerator: MockProofGenerator;
  stateStore: InMemoryStateStore;
  
  // Test utilities
  clock: MockClock;
  eventCollector: EventCollector;
}
```

### Test Lifecycle

```typescript
beforeEach(async () => {
  // 1. Start fresh local validator (or reset mock)
  await ctx.solanaValidator.reset();
  
  // 2. Deploy program with test configuration
  await deploySpeculationProgram(ctx.solanaValidator, {
    ...defaultConfig,
    confirmation_timeout_ms: 5000,  // Faster for tests
  });
  
  // 3. Initialize components
  ctx.dependencyGraph = new DependencyGraph();
  ctx.commitmentLedger = new CommitmentLedger(ctx.solanaValidator);
  ctx.proofDeferralManager = new ProofDeferralManager(ctx.commitmentLedger);
  ctx.rollbackController = new RollbackController(ctx.dependencyGraph, ctx.commitmentLedger);
  ctx.speculativeScheduler = new SpeculativeScheduler(ctx);
  
  // 4. Fund test agents
  await ctx.solanaValidator.airdrop("agent-A", 10_000_000_000);  // 10 SOL
  await ctx.solanaValidator.airdrop("agent-B", 10_000_000_000);
  
  // 5. Clear event collector
  ctx.eventCollector.clear();
});

afterEach(async () => {
  // 1. Verify no resource leaks
  expect(ctx.dependencyGraph.size()).toBeLessThanOrEqual(0);
  
  // 2. Verify all stakes returned or slashed
  const pendingStakes = await ctx.commitmentLedger.getPendingStakes();
  expect(pendingStakes).toEqual(0);
  
  // 3. Stop components
  await ctx.speculativeScheduler.stop();
});
```

---

## 1. Happy Path Scenarios

### INT-HP-001: Single Speculation Success

**Description:** A single speculative task executes before ancestor confirmation, then confirms successfully.

**Diagram:**
```
Time →
Task A: [create] ──── [execute] ──── [proof] ─── [confirm] ─────────────────────
Task B: ─────────────── [speculate] ── [execute] ──────────── [proof] ─ [confirm]
```

**Steps:**
1. Create Task A (no dependency)
2. Execute Task A
3. Create Task B with `depends_on: Task A`
4. Before A's proof confirms, scheduler speculates on B
5. Execute B speculatively
6. A's proof confirms on-chain
7. B's proof can now be submitted
8. B confirms

**Assertions:**
- [ ] B executes before A confirms (speculative execution occurred)
- [ ] B's proof is held in deferral queue until A confirms
- [ ] After A confirms, B's proof is released and submitted
- [ ] Both tasks end in CONFIRMED state
- [ ] All stake returned to agents
- [ ] `speculation_success` metric incremented

**Test Code:**
```typescript
test("INT-HP-001: Single speculation success", async () => {
  // Arrange
  const taskA = await createTask({ id: "A", agent: "agent-A" });
  await executeTask(taskA);
  
  const taskB = await createTask({ id: "B", agent: "agent-A", dependsOn: taskA.id });
  
  // Act - Start proof generation for A but don't confirm yet
  const proofA = await ctx.proofGenerator.generateProof(taskA);
  
  // Assert - Scheduler should speculate on B
  const shouldSpec = ctx.speculativeScheduler.shouldSpeculate(taskB);
  expect(shouldSpec).toBe(true);
  
  // Execute B speculatively
  const commitment = await ctx.commitmentLedger.createCommitment({
    taskId: taskB.id,
    agentId: "agent-A",
    depth: 1,
  });
  expect(commitment.status).toBe("PENDING");
  
  // B's proof generated but deferred
  const proofB = await ctx.proofGenerator.generateProof(taskB);
  ctx.proofDeferralManager.enqueue({ taskId: taskB.id, proof: proofB });
  
  expect(ctx.proofDeferralManager.isReady(taskB.id)).toBe(false);
  
  // Confirm A on-chain
  await submitProof(taskA.id, proofA);
  await ctx.clock.advance(1000);  // Wait for confirmation
  
  // Now B should be ready
  expect(ctx.proofDeferralManager.isReady(taskB.id)).toBe(true);
  
  // Submit B's proof
  const readyProofs = ctx.proofDeferralManager.dequeueReady();
  expect(readyProofs).toHaveLength(1);
  await submitProof(taskB.id, readyProofs[0].proof);
  
  // Final state
  expect(await getTaskStatus(taskA.id)).toBe("CONFIRMED");
  expect(await getTaskStatus(taskB.id)).toBe("CONFIRMED");
});
```

---

### INT-HP-002: Chain Speculation (3 levels)

**Description:** A chain of 3 speculative tasks execute in sequence before any proof confirms.

**Diagram:**
```
Task A: [create] ── [execute] ────────────────────────────────────── [confirm]
Task B: ──────────── [speculate] ── [execute] ──────────────────────── [confirm]
Task C: ──────────────────────────── [speculate] ── [execute] ───────── [confirm]
```

**Steps:**
1. Create and execute Task A
2. Create Task B (depends on A), speculate and execute
3. Create Task C (depends on B), speculate and execute
4. Confirm A → release B's proof → confirm B
5. After B confirms → release C's proof → confirm C

**Assertions:**
- [ ] All three tasks execute before any proof confirms
- [ ] Depths: A=0, B=1, C=2
- [ ] Stakes: A=base, B=2×base, C=4×base
- [ ] Proofs released in order: A, B, C
- [ ] Total speculation time < 3× sequential time

**Test Code:**
```typescript
test("INT-HP-002: Chain speculation 3 levels", async () => {
  // Create chain
  const taskA = await createTask({ id: "A", agent: "agent-A" });
  const taskB = await createTask({ id: "B", agent: "agent-A", dependsOn: "A" });
  const taskC = await createTask({ id: "C", agent: "agent-A", dependsOn: "B" });
  
  // Execute all speculatively
  await executeTask(taskA);
  
  const commitmentB = await ctx.commitmentLedger.createCommitment({
    taskId: "B", agentId: "agent-A", depth: 1
  });
  await executeTaskSpeculative(taskB);
  
  const commitmentC = await ctx.commitmentLedger.createCommitment({
    taskId: "C", agentId: "agent-A", depth: 2
  });
  await executeTaskSpeculative(taskC);
  
  // Verify stakes (exponential)
  const baseBond = 1_000_000;
  expect(commitmentB.stake).toBe(baseBond * 2);  // 2^1
  expect(commitmentC.stake).toBe(baseBond * 4);  // 2^2
  
  // Generate all proofs
  const proofs = await Promise.all([
    ctx.proofGenerator.generateProof(taskA),
    ctx.proofGenerator.generateProof(taskB),
    ctx.proofGenerator.generateProof(taskC),
  ]);
  
  // Defer B and C proofs
  ctx.proofDeferralManager.enqueue({ taskId: "B", proof: proofs[1], ancestors: ["A"] });
  ctx.proofDeferralManager.enqueue({ taskId: "C", proof: proofs[2], ancestors: ["B"] });
  
  // Confirm in order
  await submitProof("A", proofs[0]);
  await ctx.clock.advance(1000);
  
  const readyB = ctx.proofDeferralManager.dequeueReady();
  expect(readyB[0].taskId).toBe("B");
  await submitProof("B", readyB[0].proof);
  await ctx.clock.advance(1000);
  
  const readyC = ctx.proofDeferralManager.dequeueReady();
  expect(readyC[0].taskId).toBe("C");
  await submitProof("C", readyC[0].proof);
  
  // All confirmed
  expect(await getTaskStatus("A")).toBe("CONFIRMED");
  expect(await getTaskStatus("B")).toBe("CONFIRMED");
  expect(await getTaskStatus("C")).toBe("CONFIRMED");
});
```

---

### INT-HP-003: DAG Speculation (Diamond Pattern)

**Description:** A diamond-shaped dependency graph with convergent speculation.

**Diagram:**
```
        A
       / \
      B   C
       \ /
        D
```

**Steps:**
1. Create Task A, execute
2. Create Tasks B and C (both depend on A)
3. Speculate and execute B and C in parallel
4. Create Task D (depends on both B and C)
5. Speculate on D after both B and C are executing
6. Confirm A → B and C can confirm → D can confirm

**Assertions:**
- [ ] D waits for both B and C
- [ ] D's depth is 2 (max path to root)
- [ ] Parallel branches don't interfere
- [ ] Single confirmation of A unlocks both B and C

**Test Code:**
```typescript
test("INT-HP-003: DAG speculation diamond pattern", async () => {
  // Build DAG
  const taskA = await createTask({ id: "A" });
  const taskB = await createTask({ id: "B", dependsOn: "A" });
  const taskC = await createTask({ id: "C", dependsOn: "A" });
  const taskD = await createTask({ id: "D", dependsOn: ["B", "C"] });
  
  await executeTask(taskA);
  
  // Speculate B and C in parallel
  await Promise.all([
    (async () => {
      await ctx.commitmentLedger.createCommitment({ taskId: "B", depth: 1 });
      await executeTaskSpeculative(taskB);
    })(),
    (async () => {
      await ctx.commitmentLedger.createCommitment({ taskId: "C", depth: 1 });
      await executeTaskSpeculative(taskC);
    })(),
  ]);
  
  // D depends on both - depth should be 2
  const depthD = ctx.dependencyGraph.getDepth("D");
  expect(depthD).toBe(2);
  
  // D can speculate after B and C are executing
  await ctx.commitmentLedger.createCommitment({ taskId: "D", depth: 2 });
  await executeTaskSpeculative(taskD);
  
  // Confirm A
  await submitProof("A", await ctx.proofGenerator.generateProof(taskA));
  await ctx.clock.advance(1000);
  
  // Both B and C should now be ready
  const ready = ctx.proofDeferralManager.dequeueReady();
  expect(ready.map(r => r.taskId).sort()).toEqual(["B", "C"]);
  
  // Confirm B and C
  await submitProof("B", ready.find(r => r.taskId === "B").proof);
  await submitProof("C", ready.find(r => r.taskId === "C").proof);
  await ctx.clock.advance(1000);
  
  // Now D is ready
  const readyD = ctx.proofDeferralManager.dequeueReady();
  expect(readyD[0].taskId).toBe("D");
  await submitProof("D", readyD[0].proof);
  
  // All confirmed
  for (const id of ["A", "B", "C", "D"]) {
    expect(await getTaskStatus(id)).toBe("CONFIRMED");
  }
});
```

---

### INT-HP-004: Multi-Agent Speculation

**Description:** Two agents speculate on different branches of the same dependency.

**Steps:**
1. Agent A creates and executes Task 1
2. Agent A speculates on Task 2 (depends on 1)
3. Agent B speculates on Task 3 (also depends on 1)
4. Both complete speculatively
5. Task 1 confirms → both 2 and 3 confirm

**Assertions:**
- [ ] Both agents can speculate on same ancestor
- [ ] Stakes are independent per agent
- [ ] Confirmation unlocks both branches

---

## 2. Failure Scenarios

### INT-FAIL-001: Proof Verification Failure

**Description:** A speculative task's ancestor proof fails verification, triggering cascade rollback.

**Steps:**
1. Create chain A → B → C, all speculative
2. Submit A's proof, but it FAILS verification
3. Observe cascade rollback of B and C

**Assertions:**
- [ ] A marked FAILED
- [ ] B and C rolled back (FAILED status)
- [ ] Rollback order: C first, then B (leaves first)
- [ ] Stakes: A slashed 10%, B and C refunded 100%
- [ ] Downstream agents compensated from A's slash

**Test Code:**
```typescript
test("INT-FAIL-001: Proof verification failure cascade", async () => {
  // Setup chain
  const taskA = await createTask({ id: "A" });
  const taskB = await createTask({ id: "B", dependsOn: "A" });
  const taskC = await createTask({ id: "C", dependsOn: "B" });
  
  await executeTask(taskA);
  await ctx.commitmentLedger.createCommitment({ taskId: "B", depth: 1 });
  await executeTaskSpeculative(taskB);
  await ctx.commitmentLedger.createCommitment({ taskId: "C", depth: 2 });
  await executeTaskSpeculative(taskC);
  
  // Generate invalid proof for A
  const invalidProof = await ctx.proofGenerator.generateInvalidProof(taskA);
  
  // Attempt to submit - should fail
  await expect(submitProof("A", invalidProof)).rejects.toThrow("PROOF_INVALID");
  
  // Trigger failure cascade
  await ctx.commitmentLedger.markFailed("A", "PROOF_INVALID");
  const affected = await ctx.commitmentLedger.getAffectedByFailure("A");
  expect(affected.sort()).toEqual(["B", "C"]);
  
  // Execute rollback
  const rollbackEvents = [];
  ctx.eventCollector.on("rollback", (e) => rollbackEvents.push(e.taskId));
  
  await ctx.rollbackController.cascadeRollback("A");
  
  // Verify order (leaves first)
  expect(rollbackEvents).toEqual(["C", "B", "A"]);
  
  // Verify stakes
  const agentBalance = await ctx.solanaValidator.getBalance("agent-A");
  // A slashed 10%, B and C fully refunded
  const expectedRefund = (2_000_000 + 4_000_000) + (1_000_000 * 0.9);
  // (B stake + C stake + A stake after slash)
});
```

---

### INT-FAIL-002: Timeout Failure

**Description:** A speculative commitment times out waiting for ancestor confirmation.

**Steps:**
1. Create A → B, A executed, B speculating
2. Do NOT submit A's proof
3. Advance clock past timeout (30s default)
4. Observe timeout handling

**Assertions:**
- [ ] Timeout detected after confirmation_timeout_ms
- [ ] B marked FAILED (reason: TIMEOUT)
- [ ] B's stake refunded (timeout is not slashable)
- [ ] `speculation_timeout` metric incremented

**Test Code:**
```typescript
test("INT-FAIL-002: Speculation timeout", async () => {
  // Setup
  const taskA = await createTask({ id: "A" });
  const taskB = await createTask({ id: "B", dependsOn: "A" });
  
  await executeTask(taskA);
  await ctx.commitmentLedger.createCommitment({ taskId: "B", depth: 1 });
  await executeTaskSpeculative(taskB);
  
  // Don't submit A's proof - let it timeout
  const startBalance = await ctx.solanaValidator.getBalance("agent-A");
  
  // Advance past timeout
  await ctx.clock.advance(31_000);  // 31 seconds
  
  // Check timeout detection
  await ctx.proofDeferralManager.checkTimeouts();
  
  // B should be failed
  const statusB = await ctx.commitmentLedger.getStatus("B");
  expect(statusB).toBe("FAILED");
  expect((await ctx.commitmentLedger.get("B")).failureReason).toBe("TIMEOUT");
  
  // Stake refunded (no slash for timeout)
  const endBalance = await ctx.solanaValidator.getBalance("agent-A");
  expect(endBalance).toBe(startBalance);  // Full refund
});
```

---

### INT-FAIL-003: Ancestor Fails While Speculating

**Description:** An ancestor fails verification while a descendant is still executing.

**Steps:**
1. A → B, A executed, B executing speculatively
2. A's proof submitted but fails verification
3. B should be aborted mid-execution

**Assertions:**
- [ ] B execution interrupted
- [ ] B state rolled back to pre-execution
- [ ] No partial state committed
- [ ] Resources (compute, memory) released

**Test Code:**
```typescript
test("INT-FAIL-003: Ancestor fails mid-execution", async () => {
  const taskA = await createTask({ id: "A" });
  const taskB = await createTask({ id: "B", dependsOn: "A" });
  
  await executeTask(taskA);
  await ctx.commitmentLedger.createCommitment({ taskId: "B", depth: 1 });
  
  // Start B execution (long-running)
  const executionPromise = executeTaskSpeculative(taskB, { simulateLatency: 5000 });
  
  // While B is executing, A fails
  await ctx.clock.advance(1000);  // B is mid-execution
  const invalidProof = await ctx.proofGenerator.generateInvalidProof(taskA);
  
  try {
    await submitProof("A", invalidProof);
  } catch {
    await ctx.commitmentLedger.markFailed("A", "PROOF_INVALID");
  }
  
  // B should be aborted
  await ctx.rollbackController.cascadeRollback("A");
  
  // B execution should reject
  await expect(executionPromise).rejects.toThrow("EXECUTION_ABORTED");
  
  // B state should be rolled back
  const stateSnapshot = await ctx.stateStore.get("B");
  expect(stateSnapshot).toBeNull();  // No partial state
});
```

---

### INT-FAIL-004: Claim Expiry During Speculation

**Description:** A claim expires while waiting for ancestor confirmation.

**Steps:**
1. Task A has claim expiring in 60s
2. B speculates on A
3. A takes 70s to confirm
4. Claim expires before A confirms

**Assertions:**
- [ ] Claim expiry detected
- [ ] Different from timeout (claim-specific handling)
- [ ] May trigger re-claim or abort

---

### INT-FAIL-005: Network Partition Recovery

**Description:** Network partition causes temporary inability to confirm proofs.

**Steps:**
1. Speculation chain in progress
2. Network partition prevents proof submission
3. Partition heals before timeout
4. Proofs submitted successfully

**Assertions:**
- [ ] Retry logic handles transient failures
- [ ] Timeout only triggered for true staleness
- [ ] Metrics track network-related delays

---

## 3. Limit Enforcement

### INT-LIM-001: Depth Limit Enforcement

**Description:** Scheduler refuses to speculate beyond max_depth.

**Setup:**
- `max_depth = 3`

**Steps:**
1. Create chain A → B → C → D → E
2. Execute A, speculate B (depth 1)
3. Speculate C (depth 2)
4. Speculate D (depth 3) - at limit
5. Attempt to speculate E (depth 4)

**Assertions:**
- [ ] D speculation succeeds (at limit)
- [ ] E speculation refused
- [ ] E waits until D confirms (reducing effective depth)
- [ ] After D confirms, E can speculate at depth 1

**Test Code:**
```typescript
test("INT-LIM-001: Depth limit enforcement", async () => {
  // Configure max_depth = 3
  ctx.speculativeScheduler.configure({ max_depth: 3 });
  
  // Create chain A → B → C → D → E
  const tasks = ["A", "B", "C", "D", "E"].map((id, i) => 
    createTask({ id, dependsOn: i > 0 ? tasks[i-1].id : null })
  );
  
  await executeTask(tasks[0]);  // A
  
  // B, C, D should speculate
  for (let i = 1; i <= 3; i++) {
    expect(ctx.speculativeScheduler.shouldSpeculate(tasks[i])).toBe(true);
    await ctx.commitmentLedger.createCommitment({ taskId: tasks[i].id, depth: i });
    await executeTaskSpeculative(tasks[i]);
  }
  
  // E should NOT speculate (depth would be 4)
  expect(ctx.speculativeScheduler.shouldSpeculate(tasks[4])).toBe(false);
  
  // Confirm D
  await confirmTask("D");
  
  // Now E can speculate (depth relative to last confirmed)
  expect(ctx.speculativeScheduler.shouldSpeculate(tasks[4])).toBe(true);
});
```

---

### INT-LIM-002: Stake Limit Enforcement

**Description:** Agent cannot speculate when stake limit would be exceeded.

**Setup:**
- `max_stake = 10_000_000` (0.01 SOL)
- `base_bond = 1_000_000`

**Steps:**
1. Agent speculates at depth 3 (stake = 8M)
2. Agent attempts depth 1 speculation (stake = 2M, total = 10M)
3. Agent attempts another depth 1 (total would = 12M)

**Assertions:**
- [ ] First two speculations succeed (total = 10M = max)
- [ ] Third refused due to stake limit
- [ ] After first speculation confirms, stake freed for new speculation

**Test Code:**
```typescript
test("INT-LIM-002: Stake limit enforcement", async () => {
  ctx.speculativeScheduler.configure({
    stake: { max_stake: 10_000_000 }
  });
  
  // First: depth 3 = 8M stake
  const task1 = await createTask({ id: "T1", dependsOn: "root" });
  // Simulate depth 3 chain above
  ctx.dependencyGraph.setDepth("T1", 3);
  
  const canSpec1 = ctx.speculativeScheduler.shouldSpeculate(task1);
  expect(canSpec1).toBe(true);
  await ctx.commitmentLedger.createCommitment({ taskId: "T1", depth: 3 });
  // Stake: 1M × 2^3 = 8M
  
  // Second: depth 1 = 2M stake (total = 10M)
  const task2 = await createTask({ id: "T2", dependsOn: "other" });
  ctx.dependencyGraph.setDepth("T2", 1);
  
  const canSpec2 = ctx.speculativeScheduler.shouldSpeculate(task2);
  expect(canSpec2).toBe(true);
  await ctx.commitmentLedger.createCommitment({ taskId: "T2", depth: 1 });
  // Total stake: 8M + 2M = 10M (at limit)
  
  // Third: depth 1 = 2M (total would = 12M)
  const task3 = await createTask({ id: "T3", dependsOn: "another" });
  ctx.dependencyGraph.setDepth("T3", 1);
  
  const canSpec3 = ctx.speculativeScheduler.shouldSpeculate(task3);
  expect(canSpec3).toBe(false);  // Would exceed limit
  
  // Confirm T1, freeing 8M stake
  await confirmTask("T1");
  
  // Now T3 can speculate
  expect(ctx.speculativeScheduler.shouldSpeculate(task3)).toBe(true);
});
```

---

### INT-LIM-003: Claim Window Enforcement

**Description:** Tasks with tight claim windows are not speculated.

**Setup:**
- `claimBufferMs = 60_000` (60s buffer)

**Steps:**
1. Task with claim expiring in 90s → can speculate
2. Task with claim expiring in 30s → cannot speculate

**Assertions:**
- [ ] Buffer calculation: `expiry - now > claimBufferMs`
- [ ] Tight window tasks execute synchronously
- [ ] Metric tracks rejected-for-window count

---

### INT-LIM-004: Parallel Branches Limit

**Description:** max_parallel_branches limits concurrent speculation paths.

**Setup:**
- `max_parallel_branches = 2`

**Steps:**
1. Root → Branch1 → Leaf1a, Leaf1b
2. Root → Branch2 → Leaf2a
3. Root → Branch3 (would be third branch)

**Assertions:**
- [ ] Two branches can speculate concurrently
- [ ] Third branch waits until one confirms
- [ ] Branch counting accurate (not node counting)

---

## 4. Edge Cases

### INT-EDGE-001: Rapid Confirmation

**Description:** Ancestor confirms before speculation can start.

**Steps:**
1. Create A → B
2. Execute A and immediately submit proof
3. Proof confirms before B even tries to speculate

**Assertions:**
- [ ] B executes normally (no speculation needed)
- [ ] No commitment created for B
- [ ] No wasted speculation overhead

**Test Code:**
```typescript
test("INT-EDGE-001: Rapid confirmation prevents speculation", async () => {
  const taskA = await createTask({ id: "A" });
  const taskB = await createTask({ id: "B", dependsOn: "A" });
  
  // Execute A and immediately confirm
  await executeTask(taskA);
  const proof = await ctx.proofGenerator.generateProof(taskA);
  await submitProof("A", proof);
  await ctx.clock.advance(100);  // Quick confirmation
  
  // B should see A as confirmed
  const shouldSpec = ctx.speculativeScheduler.shouldSpeculate(taskB);
  expect(shouldSpec).toBe(false);  // A already confirmed
  
  // Execute B normally
  await executeTask(taskB);  // Not speculative
  
  // No commitment for B
  expect(ctx.commitmentLedger.has("B")).toBe(false);
});
```

---

### INT-EDGE-002: Concurrent Claims on Same Parent

**Description:** Two tasks claim the same parent simultaneously.

**Steps:**
1. Create Task A (root)
2. Two agents simultaneously claim tasks depending on A
3. Both try to speculate

**Assertions:**
- [ ] Both speculations valid (different tasks)
- [ ] Stakes tracked separately
- [ ] No race condition in dependency graph

---

### INT-EDGE-003: Rollback During Proof Submission

**Description:** Rollback triggered while proof is being submitted on-chain.

**Steps:**
1. Task B's proof being submitted
2. Ancestor A fails, triggering rollback
3. B's proof submission in flight

**Assertions:**
- [ ] Proof submission completes (idempotent on-chain)
- [ ] Or proof submission cancelled
- [ ] No inconsistent state
- [ ] Transaction fee handling (refund or accept)

---

### INT-EDGE-004: Empty Dependency (Root Task Speculation)

**Description:** Attempt to speculate on a root task (no dependency).

**Assertions:**
- [ ] Root tasks never speculate (no ancestor to wait for)
- [ ] `shouldSpeculate()` returns false
- [ ] Normal execution path used

---

### INT-EDGE-005: Self-Referential Dependency (Cycle Prevention)

**Description:** Malformed input attempts to create cyclic dependency.

**Steps:**
1. Attempt to create Task A depending on itself
2. Attempt to create cycle: A → B → C → A

**Assertions:**
- [ ] Self-reference rejected at creation
- [ ] Cycle detected and rejected
- [ ] Clear error message
- [ ] Graph remains consistent

---

### INT-EDGE-006: Confirmation Reorg

**Description:** Blockchain reorg changes confirmation status.

**Steps:**
1. Task A's proof confirms on chain
2. B's proof submitted based on A's confirmation
3. Chain reorg invalidates A's confirmation

**Assertions:**
- [ ] Finality tracking handles reorg
- [ ] B's proof submission handled (retry or fail)
- [ ] State consistency maintained
- [ ] Metrics track reorg events

---

### INT-EDGE-007: Component Restart During Speculation

**Description:** Runtime component restarts while speculations are in-flight.

**Steps:**
1. Multiple speculations in progress
2. Component crashes and restarts
3. Recovery from persistent state

**Assertions:**
- [ ] Commitments recovered from on-chain state
- [ ] Pending proofs recovered from durable queue
- [ ] Timeouts correctly calculated from original start
- [ ] No duplicate executions

---

## 5. Mock Requirements

### 5.1 MockProofGenerator

```typescript
class MockProofGenerator implements ProofGenerator {
  private latencyMs: number = 100;
  private failures: Map<string, Error> = new Map();
  private invalidProofs: Set<string> = new Set();
  
  async generateProof(task: Task): Promise<Proof> {
    await sleep(this.latencyMs);
    
    if (this.failures.has(task.id)) {
      throw this.failures.get(task.id);
    }
    
    return {
      taskId: task.id,
      data: `mock-proof-${task.id}`,
      isValid: !this.invalidProofs.has(task.id),
    };
  }
  
  setLatency(ms: number): void { this.latencyMs = ms; }
  setFailure(taskId: string, error: Error): void { this.failures.set(taskId, error); }
  setInvalid(taskId: string): void { this.invalidProofs.add(taskId); }
  generateInvalidProof(task: Task): Proof {
    return { taskId: task.id, data: "invalid", isValid: false };
  }
}
```

### 5.2 MockSolanaValidator

```typescript
class MockSolanaValidator {
  private accounts: Map<string, AccountData> = new Map();
  private balances: Map<string, number> = new Map();
  private proofStatus: Map<string, "pending" | "confirmed" | "failed"> = new Map();
  
  async submitProof(taskId: string, proof: Proof): Promise<string> {
    if (!proof.isValid) {
      this.proofStatus.set(taskId, "failed");
      throw new Error("PROOF_INVALID");
    }
    
    this.proofStatus.set(taskId, "pending");
    // Simulate confirmation delay
    setTimeout(() => {
      this.proofStatus.set(taskId, "confirmed");
    }, 500);
    
    return `tx-${taskId}-${Date.now()}`;
  }
  
  async getProofStatus(taskId: string): Promise<string> {
    return this.proofStatus.get(taskId) || "unknown";
  }
  
  async airdrop(agentId: string, lamports: number): Promise<void> {
    const current = this.balances.get(agentId) || 0;
    this.balances.set(agentId, current + lamports);
  }
  
  async getBalance(agentId: string): Promise<number> {
    return this.balances.get(agentId) || 0;
  }
  
  async reset(): Promise<void> {
    this.accounts.clear();
    this.balances.clear();
    this.proofStatus.clear();
  }
}
```

### 5.3 MockClock

```typescript
class MockClock {
  private currentTime: number;
  private timers: Array<{ at: number; callback: () => void }> = [];
  
  constructor(initialTime: number = Date.now()) {
    this.currentTime = initialTime;
  }
  
  now(): number {
    return this.currentTime;
  }
  
  async advance(ms: number): Promise<void> {
    this.currentTime += ms;
    
    // Fire any scheduled timers
    const due = this.timers.filter(t => t.at <= this.currentTime);
    this.timers = this.timers.filter(t => t.at > this.currentTime);
    
    for (const timer of due) {
      timer.callback();
    }
    
    // Allow async effects to propagate
    await new Promise(resolve => setImmediate(resolve));
  }
  
  setTimeout(callback: () => void, delayMs: number): void {
    this.timers.push({ at: this.currentTime + delayMs, callback });
    this.timers.sort((a, b) => a.at - b.at);
  }
}
```

### 5.4 EventCollector

```typescript
class EventCollector {
  private events: Array<{ type: string; data: any; timestamp: number }> = [];
  private listeners: Map<string, Array<(data: any) => void>> = new Map();
  
  emit(type: string, data: any): void {
    this.events.push({ type, data, timestamp: Date.now() });
    
    const handlers = this.listeners.get(type) || [];
    handlers.forEach(h => h(data));
  }
  
  on(type: string, handler: (data: any) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  
  getEvents(type?: string): Array<{ type: string; data: any }> {
    if (type) {
      return this.events.filter(e => e.type === type);
    }
    return [...this.events];
  }
  
  clear(): void {
    this.events = [];
  }
}
```

---

## 6. Test Data Fixtures

### 6.1 Standard Task Chains

```typescript
// Linear chain: A → B → C → D → E
const linearChain = {
  tasks: [
    { id: "A", dependsOn: null },
    { id: "B", dependsOn: "A" },
    { id: "C", dependsOn: "B" },
    { id: "D", dependsOn: "C" },
    { id: "E", dependsOn: "D" },
  ],
  maxDepth: 4,
};

// Diamond DAG
const diamondDAG = {
  tasks: [
    { id: "A", dependsOn: null },
    { id: "B", dependsOn: "A" },
    { id: "C", dependsOn: "A" },
    { id: "D", dependsOn: ["B", "C"] },
  ],
  maxDepth: 2,
};

// Wide tree
const wideTree = {
  tasks: [
    { id: "root", dependsOn: null },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `child-${i}`,
      dependsOn: "root",
    })),
  ],
  maxDepth: 1,
};
```

### 6.2 Edge Case Configurations

```typescript
const tightLimits = {
  max_depth: 2,
  max_parallel_branches: 1,
  confirmation_timeout_ms: 5000,
  stake: {
    max_stake: 5_000_000,
  },
};

const relaxedLimits = {
  max_depth: 10,
  max_parallel_branches: 8,
  confirmation_timeout_ms: 120000,
  stake: {
    max_stake: 100_000_000_000,
  },
};
```

---

## Test Execution

### Running Integration Tests

```bash
# All integration tests
pnpm test:integration

# Specific scenario
pnpm test:integration --grep "happy path"
pnpm test:integration --grep "failure"
pnpm test:integration --grep "limits"

# With local validator
pnpm test:integration --validator=local

# With mock validator (faster)
pnpm test:integration --validator=mock
```

### Test Environment Matrix

| Environment | Validator | Speed | Fidelity |
|-------------|-----------|-------|----------|
| CI (fast) | Mock | ~1min | Medium |
| CI (full) | local-validator | ~10min | High |
| Local dev | Mock | ~30s | Medium |
| Pre-release | Devnet | ~30min | Very High |

### Success Criteria

- [ ] All happy path tests pass
- [ ] All failure scenarios correctly handled
- [ ] Limit enforcement works at boundaries
- [ ] No flaky tests (run 10x without failure)
- [ ] Test coverage ≥85% for integration paths
