# Unit Test Plan: Speculative Execution

> **Version:** 1.0  
> **Last Updated:** 2025-01-28  
> **Scope:** Unit tests for all speculative execution components

## Overview

This document specifies unit tests for the five core components of the speculative execution system:

1. **DependencyGraph** - Task dependency tracking and traversal
2. **CommitmentLedger** - Speculative commitment management
3. **ProofDeferralManager** - Deferred proof queue operations
4. **RollbackController** - State rollback orchestration
5. **SpeculativeScheduler** - Scheduling policy enforcement

Each test case includes: name, preconditions, inputs, expected outputs, and edge cases.

---

## 1. DependencyGraph

### 1.1 Node Operations

#### TEST-DG-001: Add Single Node
| Field | Value |
|-------|-------|
| **Name** | `add_node_single` |
| **Preconditions** | Empty graph |
| **Inputs** | `taskId: "task-001"` |
| **Expected Output** | Graph contains node "task-001" with depth 0 |
| **Verification** | `graph.hasNode("task-001") === true`, `graph.getDepth("task-001") === 0` |

#### TEST-DG-002: Add Node with Parent
| Field | Value |
|-------|-------|
| **Name** | `add_node_with_parent` |
| **Preconditions** | Graph contains "task-001" at depth 0 |
| **Inputs** | `taskId: "task-002", dependsOn: "task-001"` |
| **Expected Output** | "task-002" added with depth 1, edge from "task-001" to "task-002" |
| **Verification** | `graph.getDepth("task-002") === 1`, `graph.getParent("task-002") === "task-001"` |

#### TEST-DG-003: Add Node with Missing Parent
| Field | Value |
|-------|-------|
| **Name** | `add_node_missing_parent` |
| **Preconditions** | Graph does not contain "task-001" |
| **Inputs** | `taskId: "task-002", dependsOn: "task-001"` |
| **Expected Output** | Error: `PARENT_NOT_FOUND` |
| **Verification** | Exception thrown with code `PARENT_NOT_FOUND` |

#### TEST-DG-004: Add Duplicate Node
| Field | Value |
|-------|-------|
| **Name** | `add_node_duplicate` |
| **Preconditions** | Graph contains "task-001" |
| **Inputs** | `taskId: "task-001"` |
| **Expected Output** | Error: `NODE_ALREADY_EXISTS` |
| **Verification** | Exception thrown, graph unchanged |

#### TEST-DG-005: Remove Leaf Node
| Field | Value |
|-------|-------|
| **Name** | `remove_node_leaf` |
| **Preconditions** | Graph: A → B (B is leaf) |
| **Inputs** | `taskId: "B"` |
| **Expected Output** | Node B removed, A unchanged |
| **Verification** | `graph.hasNode("B") === false`, `graph.hasNode("A") === true` |

#### TEST-DG-006: Remove Node with Children
| Field | Value |
|-------|-------|
| **Name** | `remove_node_with_children` |
| **Preconditions** | Graph: A → B → C |
| **Inputs** | `taskId: "B"` |
| **Expected Output** | Error: `NODE_HAS_DEPENDENTS` |
| **Verification** | Exception thrown, graph unchanged |

#### TEST-DG-007: Remove Root Node (No Children)
| Field | Value |
|-------|-------|
| **Name** | `remove_root_no_children` |
| **Preconditions** | Graph: A (no children) |
| **Inputs** | `taskId: "A"` |
| **Expected Output** | Graph is empty |
| **Verification** | `graph.isEmpty() === true` |

### 1.2 Traversal Operations

#### TEST-DG-010: Get Ancestors - Linear Chain
| Field | Value |
|-------|-------|
| **Name** | `get_ancestors_linear` |
| **Preconditions** | Graph: A → B → C → D |
| **Inputs** | `taskId: "D"` |
| **Expected Output** | `["C", "B", "A"]` (ordered nearest to farthest) |
| **Verification** | Array matches expected order |

#### TEST-DG-011: Get Ancestors - Root Node
| Field | Value |
|-------|-------|
| **Name** | `get_ancestors_root` |
| **Preconditions** | Graph: A → B |
| **Inputs** | `taskId: "A"` |
| **Expected Output** | `[]` (empty array) |
| **Verification** | Empty array returned |

#### TEST-DG-012: Get Descendants - Single Child
| Field | Value |
|-------|-------|
| **Name** | `get_descendants_single` |
| **Preconditions** | Graph: A → B → C |
| **Inputs** | `taskId: "A"` |
| **Expected Output** | `["B", "C"]` (topological order) |
| **Verification** | Array contains both B and C |

#### TEST-DG-013: Get Descendants - DAG Structure
| Field | Value |
|-------|-------|
| **Name** | `get_descendants_dag` |
| **Preconditions** | Graph: A → B, A → C, B → D, C → D |
| **Inputs** | `taskId: "A"` |
| **Expected Output** | `["B", "C", "D"]` (D appears once) |
| **Verification** | No duplicates, all descendants included |

#### TEST-DG-014: Get Leaves
| Field | Value |
|-------|-------|
| **Name** | `get_leaves` |
| **Preconditions** | Graph: A → B → D, A → C → E |
| **Inputs** | None |
| **Expected Output** | `["D", "E"]` |
| **Verification** | Only nodes with no children returned |

#### TEST-DG-015: Topological Sort
| Field | Value |
|-------|-------|
| **Name** | `topological_sort` |
| **Preconditions** | Graph: A → B → D, A → C → D |
| **Inputs** | None |
| **Expected Output** | A before B,C; B,C before D |
| **Verification** | For each edge (u,v), u appears before v |

### 1.3 Cycle Detection

#### TEST-DG-020: Detect Cycle - Direct
| Field | Value |
|-------|-------|
| **Name** | `detect_cycle_direct` |
| **Preconditions** | Graph: A → B |
| **Inputs** | `addEdge("B", "A")` |
| **Expected Output** | Error: `CYCLE_DETECTED` |
| **Verification** | Operation rejected, graph unchanged |

#### TEST-DG-021: Detect Cycle - Indirect
| Field | Value |
|-------|-------|
| **Name** | `detect_cycle_indirect` |
| **Preconditions** | Graph: A → B → C |
| **Inputs** | `addNode("C", dependsOn: "A")` creating C → A |
| **Expected Output** | Error: `CYCLE_DETECTED` |
| **Verification** | Operation rejected |

#### TEST-DG-022: Self-Loop Prevention
| Field | Value |
|-------|-------|
| **Name** | `self_loop_prevention` |
| **Preconditions** | Graph: A |
| **Inputs** | `addEdge("A", "A")` |
| **Expected Output** | Error: `SELF_LOOP_NOT_ALLOWED` |
| **Verification** | Operation rejected |

### 1.4 Depth Calculation

#### TEST-DG-030: Depth - Root Node
| Field | Value |
|-------|-------|
| **Name** | `depth_root` |
| **Preconditions** | Graph: A (root) |
| **Inputs** | `taskId: "A"` |
| **Expected Output** | `depth: 0` |
| **Verification** | `getDepth("A") === 0` |

#### TEST-DG-031: Depth - Linear Chain
| Field | Value |
|-------|-------|
| **Name** | `depth_linear_chain` |
| **Preconditions** | Graph: A → B → C → D → E |
| **Inputs** | `taskId: "E"` |
| **Expected Output** | `depth: 4` |
| **Verification** | `getDepth("E") === 4` |

#### TEST-DG-032: Depth - DAG Multiple Paths
| Field | Value |
|-------|-------|
| **Name** | `depth_dag_multiple_paths` |
| **Preconditions** | Graph: A → B → D, A → C → D (D has two parents) |
| **Inputs** | `taskId: "D"` |
| **Expected Output** | `depth: 2` (max path length) |
| **Verification** | Uses longest path to any root |

#### TEST-DG-033: Max Depth in Graph
| Field | Value |
|-------|-------|
| **Name** | `max_depth_graph` |
| **Preconditions** | Graph with multiple chains of varying depth |
| **Inputs** | None |
| **Expected Output** | Maximum depth across all nodes |
| **Verification** | `getMaxDepth() === max(all node depths)` |

### 1.5 Edge Cases

#### TEST-DG-040: Empty Graph Operations
| Field | Value |
|-------|-------|
| **Name** | `empty_graph_operations` |
| **Preconditions** | Empty graph |
| **Inputs** | `getLeaves()`, `topologicalSort()`, `getMaxDepth()` |
| **Expected Output** | `[]`, `[]`, `0` respectively |
| **Verification** | No exceptions, empty/zero returns |

#### TEST-DG-041: Large Chain (Stress)
| Field | Value |
|-------|-------|
| **Name** | `large_chain_stress` |
| **Preconditions** | None |
| **Inputs** | Create chain of 1000 nodes |
| **Expected Output** | Chain created, depth 999 for leaf |
| **Verification** | No stack overflow, correct depths |

#### TEST-DG-042: Wide Graph (Many Children)
| Field | Value |
|-------|-------|
| **Name** | `wide_graph_many_children` |
| **Preconditions** | Root node A |
| **Inputs** | Add 100 children to A |
| **Expected Output** | All children at depth 1 |
| **Verification** | `getDescendants("A").length === 100` |

---

## 2. CommitmentLedger

### 2.1 CRUD Operations

#### TEST-CL-001: Create Commitment
| Field | Value |
|-------|-------|
| **Name** | `create_commitment` |
| **Preconditions** | Empty ledger |
| **Inputs** | `{ taskId: "task-001", agentId: "agent-A", stake: 1000000, depth: 1 }` |
| **Expected Output** | Commitment created with status `PENDING` |
| **Verification** | `ledger.get("task-001").status === PENDING` |

#### TEST-CL-002: Create Duplicate Commitment
| Field | Value |
|-------|-------|
| **Name** | `create_commitment_duplicate` |
| **Preconditions** | Ledger contains commitment for "task-001" |
| **Inputs** | `{ taskId: "task-001", ... }` |
| **Expected Output** | Error: `COMMITMENT_ALREADY_EXISTS` |
| **Verification** | Exception thrown, ledger unchanged |

#### TEST-CL-003: Read Commitment
| Field | Value |
|-------|-------|
| **Name** | `read_commitment` |
| **Preconditions** | Ledger contains commitment for "task-001" |
| **Inputs** | `taskId: "task-001"` |
| **Expected Output** | Full commitment object |
| **Verification** | All fields match original |

#### TEST-CL-004: Read Non-Existent Commitment
| Field | Value |
|-------|-------|
| **Name** | `read_commitment_missing` |
| **Preconditions** | Ledger does not contain "task-999" |
| **Inputs** | `taskId: "task-999"` |
| **Expected Output** | `null` or Error: `NOT_FOUND` |
| **Verification** | Returns null or throws appropriately |

#### TEST-CL-005: Update Commitment Status - Pending to Confirmed
| Field | Value |
|-------|-------|
| **Name** | `update_status_confirmed` |
| **Preconditions** | Commitment exists with status `PENDING` |
| **Inputs** | `taskId: "task-001", newStatus: CONFIRMED` |
| **Expected Output** | Status updated, timestamp recorded |
| **Verification** | `status === CONFIRMED`, `confirmedAt !== null` |

#### TEST-CL-006: Update Commitment Status - Pending to Failed
| Field | Value |
|-------|-------|
| **Name** | `update_status_failed` |
| **Preconditions** | Commitment exists with status `PENDING` |
| **Inputs** | `taskId: "task-001", newStatus: FAILED, reason: "proof_invalid"` |
| **Expected Output** | Status updated, failure reason recorded |
| **Verification** | `status === FAILED`, `failureReason === "proof_invalid"` |

#### TEST-CL-007: Invalid Status Transition
| Field | Value |
|-------|-------|
| **Name** | `invalid_status_transition` |
| **Preconditions** | Commitment with status `CONFIRMED` |
| **Inputs** | `newStatus: PENDING` |
| **Expected Output** | Error: `INVALID_STATUS_TRANSITION` |
| **Verification** | CONFIRMED cannot go back to PENDING |

#### TEST-CL-008: Delete Commitment
| Field | Value |
|-------|-------|
| **Name** | `delete_commitment` |
| **Preconditions** | Commitment exists for "task-001" |
| **Inputs** | `taskId: "task-001"` |
| **Expected Output** | Commitment removed |
| **Verification** | `ledger.has("task-001") === false` |

### 2.2 Stake Calculations

#### TEST-CL-010: Calculate Stake - Depth 0
| Field | Value |
|-------|-------|
| **Name** | `calculate_stake_depth_0` |
| **Preconditions** | `base_bond = 1_000_000` |
| **Inputs** | `depth: 0` |
| **Expected Output** | `stake: 1_000_000` (base × 2^0) |
| **Verification** | `calculateStake(0) === 1_000_000` |

#### TEST-CL-011: Calculate Stake - Depth 1
| Field | Value |
|-------|-------|
| **Name** | `calculate_stake_depth_1` |
| **Preconditions** | `base_bond = 1_000_000` |
| **Inputs** | `depth: 1` |
| **Expected Output** | `stake: 2_000_000` (base × 2^1) |
| **Verification** | `calculateStake(1) === 2_000_000` |

#### TEST-CL-012: Calculate Stake - Depth 5
| Field | Value |
|-------|-------|
| **Name** | `calculate_stake_depth_5` |
| **Preconditions** | `base_bond = 1_000_000` |
| **Inputs** | `depth: 5` |
| **Expected Output** | `stake: 32_000_000` (base × 2^5) |
| **Verification** | Exponential formula applied correctly |

#### TEST-CL-013: Total Staked by Agent
| Field | Value |
|-------|-------|
| **Name** | `total_staked_by_agent` |
| **Preconditions** | Agent has 3 commitments: 1M, 2M, 4M lamports |
| **Inputs** | `agentId: "agent-A"` |
| **Expected Output** | `totalStake: 7_000_000` |
| **Verification** | Sum of all active commitments |

#### TEST-CL-014: Stake Limit Enforcement
| Field | Value |
|-------|-------|
| **Name** | `stake_limit_enforcement` |
| **Preconditions** | Agent at `max_stake` limit (1 SOL) |
| **Inputs** | New commitment requiring additional stake |
| **Expected Output** | Error: `STAKE_LIMIT_EXCEEDED` |
| **Verification** | Commitment rejected |

### 2.3 Failure Cascade

#### TEST-CL-020: Mark Failed - No Descendants
| Field | Value |
|-------|-------|
| **Name** | `mark_failed_no_descendants` |
| **Preconditions** | Commitment "task-001" has no dependents |
| **Inputs** | `markFailed("task-001", "proof_invalid")` |
| **Expected Output** | Only "task-001" marked failed |
| **Verification** | No cascade, single failure |

#### TEST-CL-021: Mark Failed - With Descendants
| Field | Value |
|-------|-------|
| **Name** | `mark_failed_with_descendants` |
| **Preconditions** | Chain: A → B → C (all PENDING) |
| **Inputs** | `markFailed("A", "proof_invalid")` |
| **Expected Output** | A, B, C all marked FAILED |
| **Verification** | Cascade affects all descendants |

#### TEST-CL-022: Mark Failed - DAG Cascade
| Field | Value |
|-------|-------|
| **Name** | `mark_failed_dag_cascade` |
| **Preconditions** | DAG: A → B, A → C, B → D, C → D |
| **Inputs** | `markFailed("A", "reason")` |
| **Expected Output** | A, B, C, D all marked FAILED |
| **Verification** | All reachable descendants affected |

#### TEST-CL-023: Mark Failed - Partial Confirmation
| Field | Value |
|-------|-------|
| **Name** | `mark_failed_partial_confirmed` |
| **Preconditions** | A (CONFIRMED) → B (PENDING) → C (PENDING) |
| **Inputs** | `markFailed("B", "timeout")` |
| **Expected Output** | A unchanged, B and C marked FAILED |
| **Verification** | Confirmed ancestors not affected |

#### TEST-CL-024: Get Affected Commitments
| Field | Value |
|-------|-------|
| **Name** | `get_affected_commitments` |
| **Preconditions** | DAG with multiple branches |
| **Inputs** | `getAffectedByFailure("task-001")` |
| **Expected Output** | List of all descendant task IDs |
| **Verification** | Used for pre-rollback analysis |

### 2.4 Query Operations

#### TEST-CL-030: List by Status
| Field | Value |
|-------|-------|
| **Name** | `list_by_status` |
| **Preconditions** | Mix of PENDING, CONFIRMED, FAILED commitments |
| **Inputs** | `listByStatus(PENDING)` |
| **Expected Output** | Only PENDING commitments |
| **Verification** | Filter works correctly |

#### TEST-CL-031: List by Agent
| Field | Value |
|-------|-------|
| **Name** | `list_by_agent` |
| **Preconditions** | Commitments from multiple agents |
| **Inputs** | `listByAgent("agent-A")` |
| **Expected Output** | Only agent-A's commitments |
| **Verification** | Agent filter works |

#### TEST-CL-032: List Expired
| Field | Value |
|-------|-------|
| **Name** | `list_expired` |
| **Preconditions** | Some commitments past timeout |
| **Inputs** | `listExpired(now)` |
| **Expected Output** | Commitments where `createdAt + timeout < now` |
| **Verification** | Timeout detection works |

---

## 3. ProofDeferralManager

### 3.1 Queue Operations

#### TEST-PD-001: Enqueue Proof
| Field | Value |
|-------|-------|
| **Name** | `enqueue_proof` |
| **Preconditions** | Empty queue |
| **Inputs** | `{ taskId: "task-001", proof: <proof_data>, ancestors: ["task-000"] }` |
| **Expected Output** | Proof added to queue |
| **Verification** | `queue.has("task-001") === true` |

#### TEST-PD-002: Enqueue Duplicate Proof
| Field | Value |
|-------|-------|
| **Name** | `enqueue_duplicate` |
| **Preconditions** | Proof for "task-001" already queued |
| **Inputs** | Same proof for "task-001" |
| **Expected Output** | Error: `PROOF_ALREADY_QUEUED` or idempotent success |
| **Verification** | No duplicate entries |

#### TEST-PD-003: Dequeue Ready Proof
| Field | Value |
|-------|-------|
| **Name** | `dequeue_ready_proof` |
| **Preconditions** | Proof queued, all ancestors confirmed |
| **Inputs** | `dequeueReady()` |
| **Expected Output** | Proof returned, removed from queue |
| **Verification** | FIFO among ready proofs |

#### TEST-PD-004: Dequeue - No Ready Proofs
| Field | Value |
|-------|-------|
| **Name** | `dequeue_none_ready` |
| **Preconditions** | All queued proofs have unconfirmed ancestors |
| **Inputs** | `dequeueReady()` |
| **Expected Output** | `null` or empty array |
| **Verification** | No proof returned |

#### TEST-PD-005: Remove Proof from Queue
| Field | Value |
|-------|-------|
| **Name** | `remove_proof` |
| **Preconditions** | Proof in queue |
| **Inputs** | `remove("task-001")` |
| **Expected Output** | Proof removed |
| **Verification** | `queue.has("task-001") === false` |

### 3.2 Ancestor Checking

#### TEST-PD-010: Check Ancestors - All Confirmed
| Field | Value |
|-------|-------|
| **Name** | `ancestors_all_confirmed` |
| **Preconditions** | Ancestors A, B both CONFIRMED |
| **Inputs** | `areAncestorsConfirmed("task-C")` (depends on A, B) |
| **Expected Output** | `true` |
| **Verification** | All ancestor statuses checked |

#### TEST-PD-011: Check Ancestors - Some Pending
| Field | Value |
|-------|-------|
| **Name** | `ancestors_some_pending` |
| **Preconditions** | A CONFIRMED, B PENDING |
| **Inputs** | `areAncestorsConfirmed("task-C")` |
| **Expected Output** | `false` |
| **Verification** | Must wait for B |

#### TEST-PD-012: Check Ancestors - Ancestor Failed
| Field | Value |
|-------|-------|
| **Name** | `ancestors_failed` |
| **Preconditions** | Ancestor A FAILED |
| **Inputs** | `areAncestorsConfirmed("task-C")` |
| **Expected Output** | `false` or signal for rollback |
| **Verification** | Proof should not be submitted |

#### TEST-PD-013: Update on Ancestor Confirmation
| Field | Value |
|-------|-------|
| **Name** | `update_on_confirmation` |
| **Preconditions** | Proof waiting for ancestor A |
| **Inputs** | `onAncestorConfirmed("A")` |
| **Expected Output** | Dependent proofs re-evaluated |
| **Verification** | Ready proofs become available |

#### TEST-PD-014: Ancestor Chain - Deep Dependency
| Field | Value |
|-------|-------|
| **Name** | `ancestor_chain_deep` |
| **Preconditions** | Chain A → B → C → D, A PENDING, others CONFIRMED in ledger |
| **Inputs** | `areAncestorsConfirmed("D")` |
| **Expected Output** | `false` (A still pending) |
| **Verification** | Transitive ancestor check |

### 3.3 Timeout Handling

#### TEST-PD-020: Detect Timeout
| Field | Value |
|-------|-------|
| **Name** | `detect_timeout` |
| **Preconditions** | Proof queued for 31 seconds (timeout: 30s) |
| **Inputs** | `checkTimeouts()` |
| **Expected Output** | Proof marked as timed out |
| **Verification** | Timeout callback triggered |

#### TEST-PD-021: Near Timeout Warning
| Field | Value |
|-------|-------|
| **Name** | `near_timeout_warning` |
| **Preconditions** | Proof at 90% of timeout |
| **Inputs** | `checkWarnings()` |
| **Expected Output** | Warning event emitted |
| **Verification** | Metric/log generated |

#### TEST-PD-022: Timeout Triggers Rollback
| Field | Value |
|-------|-------|
| **Name** | `timeout_triggers_rollback` |
| **Preconditions** | Proof times out |
| **Inputs** | Timeout event |
| **Expected Output** | Rollback initiated for task and descendants |
| **Verification** | RollbackController called |

#### TEST-PD-023: Refresh Timeout
| Field | Value |
|-------|-------|
| **Name** | `refresh_timeout` |
| **Preconditions** | Proof in queue approaching timeout |
| **Inputs** | `refreshTimeout("task-001")` |
| **Expected Output** | Timeout extended |
| **Verification** | New timeout from now |

### 3.4 Priority and Ordering

#### TEST-PD-030: FIFO Ordering
| Field | Value |
|-------|-------|
| **Name** | `fifo_ordering` |
| **Preconditions** | Proofs A, B, C queued in order (all ready) |
| **Inputs** | `dequeueReady()` three times |
| **Expected Output** | A, then B, then C |
| **Verification** | First-in-first-out |

#### TEST-PD-031: Priority Override
| Field | Value |
|-------|-------|
| **Name** | `priority_override` |
| **Preconditions** | B has high priority, A normal (both ready) |
| **Inputs** | `dequeueReady()` |
| **Expected Output** | B first (higher priority) |
| **Verification** | Priority trumps FIFO |

---

## 4. RollbackController

### 4.1 Single Rollback

#### TEST-RC-001: Rollback Single Task
| Field | Value |
|-------|-------|
| **Name** | `rollback_single` |
| **Preconditions** | Task "task-001" in PENDING state, no descendants |
| **Inputs** | `rollback("task-001")` |
| **Expected Output** | Task state reverted, commitment removed |
| **Verification** | State snapshot restored |

#### TEST-RC-002: Rollback Confirmed Task
| Field | Value |
|-------|-------|
| **Name** | `rollback_confirmed` |
| **Preconditions** | Task "task-001" in CONFIRMED state |
| **Inputs** | `rollback("task-001")` |
| **Expected Output** | Error: `CANNOT_ROLLBACK_CONFIRMED` |
| **Verification** | Confirmed tasks immutable |

#### TEST-RC-003: Rollback Non-Existent Task
| Field | Value |
|-------|-------|
| **Name** | `rollback_missing` |
| **Preconditions** | Task "task-999" does not exist |
| **Inputs** | `rollback("task-999")` |
| **Expected Output** | Error: `TASK_NOT_FOUND` or no-op |
| **Verification** | Graceful handling |

#### TEST-RC-004: Rollback Releases Stake
| Field | Value |
|-------|-------|
| **Name** | `rollback_releases_stake` |
| **Preconditions** | Task with 2M lamports staked |
| **Inputs** | `rollback("task-001")` |
| **Expected Output** | 2M lamports returned to agent |
| **Verification** | `agent.balance += stake` |

### 4.2 Cascade Rollback

#### TEST-RC-010: Cascade Rollback - Linear Chain
| Field | Value |
|-------|-------|
| **Name** | `cascade_linear` |
| **Preconditions** | Chain: A → B → C → D (all PENDING) |
| **Inputs** | `cascadeRollback("A")` |
| **Expected Output** | D, C, B, A rolled back (reverse order) |
| **Verification** | Leaves first, then parents |

#### TEST-RC-011: Cascade Rollback - DAG
| Field | Value |
|-------|-------|
| **Name** | `cascade_dag` |
| **Preconditions** | DAG: A → B, A → C, B → D, C → D |
| **Inputs** | `cascadeRollback("A")` |
| **Expected Output** | D rolled back once, then B, C, then A |
| **Verification** | No duplicate rollbacks |

#### TEST-RC-012: Cascade Rollback - Partial
| Field | Value |
|-------|-------|
| **Name** | `cascade_partial` |
| **Preconditions** | A (CONFIRMED) → B (PENDING) → C (PENDING) |
| **Inputs** | `cascadeRollback("B")` |
| **Expected Output** | C, B rolled back; A untouched |
| **Verification** | Stops at confirmed ancestor |

#### TEST-RC-013: Cascade Rollback - With Slash
| Field | Value |
|-------|-------|
| **Name** | `cascade_with_slash` |
| **Preconditions** | Failed speculation due to invalid proof |
| **Inputs** | `cascadeRollback("A", { slash: true })` |
| **Expected Output** | Stake slashed (10%), remainder returned |
| **Verification** | `slashed = stake * 0.1` |

#### TEST-RC-014: Cascade Order Verification
| Field | Value |
|-------|-------|
| **Name** | `cascade_order_verification` |
| **Preconditions** | Complex DAG |
| **Inputs** | `cascadeRollback("root")` |
| **Expected Output** | Rollback events in reverse topological order |
| **Verification** | Every child rolled back before parent |

### 4.3 Idempotency

#### TEST-RC-020: Idempotent Rollback - Same Task
| Field | Value |
|-------|-------|
| **Name** | `idempotent_same_task` |
| **Preconditions** | Task already rolled back |
| **Inputs** | `rollback("task-001")` again |
| **Expected Output** | No-op or idempotent success |
| **Verification** | No error, no state change |

#### TEST-RC-021: Idempotent Rollback - During Cascade
| Field | Value |
|-------|-------|
| **Name** | `idempotent_during_cascade` |
| **Preconditions** | Cascade in progress |
| **Inputs** | Concurrent `rollback("task-001")` |
| **Expected Output** | Single rollback, no race condition |
| **Verification** | Mutex or CAS prevents double rollback |

#### TEST-RC-022: Rollback State Machine
| Field | Value |
|-------|-------|
| **Name** | `rollback_state_machine` |
| **Preconditions** | Task in various states |
| **Inputs** | Rollback from each state |
| **Expected Output** | Only PENDING/EXECUTING can rollback |
| **Verification** | State machine enforced |

### 4.4 Hooks and Events

#### TEST-RC-030: Pre-Rollback Hook
| Field | Value |
|-------|-------|
| **Name** | `pre_rollback_hook` |
| **Preconditions** | Hook registered |
| **Inputs** | `rollback("task-001")` |
| **Expected Output** | Hook called before rollback |
| **Verification** | Hook can abort or log |

#### TEST-RC-031: Post-Rollback Event
| Field | Value |
|-------|-------|
| **Name** | `post_rollback_event` |
| **Preconditions** | Event listener registered |
| **Inputs** | Rollback completes |
| **Expected Output** | Event emitted with rollback details |
| **Verification** | Metrics/logging receives event |

---

## 5. SpeculativeScheduler

### 5.1 Policy Decisions

#### TEST-SS-001: Should Speculate - Eligible Task
| Field | Value |
|-------|-------|
| **Name** | `should_speculate_eligible` |
| **Preconditions** | Task has dependency, within limits |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `true` |
| **Verification** | All conditions pass |

#### TEST-SS-002: Should Speculate - No Dependency
| Field | Value |
|-------|-------|
| **Name** | `should_speculate_no_dep` |
| **Preconditions** | Task has no `depends_on` |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `false` (execute normally) |
| **Verification** | No speculation needed |

#### TEST-SS-003: Should Speculate - Speculation Disabled
| Field | Value |
|-------|-------|
| **Name** | `should_speculate_disabled` |
| **Preconditions** | `speculation.enabled = false` |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `false` |
| **Verification** | Master switch respected |

#### TEST-SS-004: Should Speculate - Ancestor Already Confirmed
| Field | Value |
|-------|-------|
| **Name** | `should_speculate_ancestor_confirmed` |
| **Preconditions** | Ancestor proof already on-chain |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `false` (no need to speculate) |
| **Verification** | Can execute normally |

### 5.2 Limit Enforcement

#### TEST-SS-010: Max Depth - At Limit
| Field | Value |
|-------|-------|
| **Name** | `max_depth_at_limit` |
| **Preconditions** | `max_depth = 5`, task would be depth 5 |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `true` (exactly at limit) |
| **Verification** | Boundary condition passes |

#### TEST-SS-011: Max Depth - Over Limit
| Field | Value |
|-------|-------|
| **Name** | `max_depth_over_limit` |
| **Preconditions** | `max_depth = 5`, task would be depth 6 |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `false` |
| **Verification** | Over limit rejected |

#### TEST-SS-012: Max Parallel Branches - At Limit
| Field | Value |
|-------|-------|
| **Name** | `max_branches_at_limit` |
| **Preconditions** | `max_parallel_branches = 4`, currently 4 active |
| **Inputs** | `shouldSpeculate(newTask)` (new branch) |
| **Expected Output** | `false` (wait for slot) |
| **Verification** | Branch limit enforced |

#### TEST-SS-013: Stake Limit Check
| Field | Value |
|-------|-------|
| **Name** | `stake_limit_check` |
| **Preconditions** | Agent near `max_stake` |
| **Inputs** | New speculation requiring more stake |
| **Expected Output** | `false` |
| **Verification** | Stake limit prevents speculation |

#### TEST-SS-014: Claim Expiry Buffer
| Field | Value |
|-------|-------|
| **Name** | `claim_expiry_buffer` |
| **Preconditions** | Claim expires in 30s, buffer is 60s |
| **Inputs** | `shouldSpeculate(task)` |
| **Expected Output** | `false` |
| **Verification** | Tight claim window rejected |

### 5.3 Mode-Specific Behavior

#### TEST-SS-020: Conservative Mode
| Field | Value |
|-------|-------|
| **Name** | `conservative_mode` |
| **Preconditions** | `mode = "conservative"` (max_depth=3, branches=2) |
| **Inputs** | Task at depth 4 |
| **Expected Output** | `false` |
| **Verification** | Mode limits applied |

#### TEST-SS-021: Aggressive Mode
| Field | Value |
|-------|-------|
| **Name** | `aggressive_mode` |
| **Preconditions** | `mode = "aggressive"` (max_depth=10, branches=8) |
| **Inputs** | Task at depth 8 |
| **Expected Output** | `true` |
| **Verification** | Higher limits allow deeper speculation |

#### TEST-SS-022: Custom Mode
| Field | Value |
|-------|-------|
| **Name** | `custom_mode` |
| **Preconditions** | `mode = "custom"`, custom limits configured |
| **Inputs** | Various tasks |
| **Expected Output** | Custom limits applied |
| **Verification** | User-defined limits work |

### 5.4 Scheduling Priority

#### TEST-SS-030: Priority by Depth
| Field | Value |
|-------|-------|
| **Name** | `priority_by_depth` |
| **Preconditions** | Multiple tasks eligible |
| **Inputs** | `scheduleNext()` |
| **Expected Output** | Shallower depth first (less risky) |
| **Verification** | Depth-based prioritization |

#### TEST-SS-031: Priority by Stake
| Field | Value |
|-------|-------|
| **Name** | `priority_by_stake` |
| **Preconditions** | Equal depth, different stake requirements |
| **Inputs** | `scheduleNext()` |
| **Expected Output** | Lower stake first |
| **Verification** | Stake-aware scheduling |

#### TEST-SS-032: Priority by Claim Window
| Field | Value |
|-------|-------|
| **Name** | `priority_by_claim_window` |
| **Preconditions** | Tasks with varying claim expiry times |
| **Inputs** | `scheduleNext()` |
| **Expected Output** | Tighter window first (use it or lose it) |
| **Verification** | Time-sensitive prioritization |

---

## Test Utilities and Fixtures

### Common Test Fixtures

```typescript
// fixture: empty-graph
const emptyGraph = new DependencyGraph();

// fixture: linear-chain-5
const linearChain = new DependencyGraph();
["A", "B", "C", "D", "E"].forEach((id, i) => {
  linearChain.addNode(id, i > 0 ? linearChain.get(["A","B","C","D"][i-1]) : null);
});

// fixture: simple-dag
const simpleDAG = new DependencyGraph();
simpleDAG.addNode("A");
simpleDAG.addNode("B", "A");
simpleDAG.addNode("C", "A");
simpleDAG.addNode("D", "B");
simpleDAG.addEdge("C", "D");

// fixture: default-config
const defaultConfig = {
  enabled: true,
  mode: "balanced",
  max_depth: 5,
  max_parallel_branches: 4,
  confirmation_timeout_ms: 30000,
  stake: {
    min_stake: 1_000_000,
    max_stake: 1_000_000_000,
    stake_per_depth: 100_000,
    slash_percentage: 0.1
  }
};
```

### Mock Providers

```typescript
// Mock for on-chain state
interface MockChainState {
  setCommitmentStatus(taskId: string, status: Status): void;
  getCommitmentStatus(taskId: string): Status;
  getBalance(agentId: string): number;
}

// Mock for time
interface MockClock {
  now(): number;
  advance(ms: number): void;
  setTime(timestamp: number): void;
}

// Mock for proof generation
interface MockProofGenerator {
  generateProof(task: Task): Promise<Proof>;
  setLatency(ms: number): void;
  setFailure(taskId: string, error: Error): void;
}
```

---

## Test Execution Guidelines

### Running Unit Tests

```bash
# All unit tests
pnpm test:unit

# Specific component
pnpm test:unit --grep "DependencyGraph"
pnpm test:unit --grep "CommitmentLedger"
pnpm test:unit --grep "ProofDeferralManager"
pnpm test:unit --grep "RollbackController"
pnpm test:unit --grep "SpeculativeScheduler"

# With coverage
pnpm test:unit --coverage
```

### Coverage Requirements

| Component | Line Coverage | Branch Coverage |
|-----------|---------------|-----------------|
| DependencyGraph | ≥95% | ≥90% |
| CommitmentLedger | ≥95% | ≥90% |
| ProofDeferralManager | ≥90% | ≥85% |
| RollbackController | ≥95% | ≥90% |
| SpeculativeScheduler | ≥90% | ≥85% |

### Test Naming Convention

```
TEST-{COMPONENT}-{NUMBER}: {description}

Components:
- DG: DependencyGraph
- CL: CommitmentLedger
- PD: ProofDeferralManager
- RC: RollbackController
- SS: SpeculativeScheduler
```
