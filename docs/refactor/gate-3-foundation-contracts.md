# Gate 3 — Foundation Contract Lock

> Produced by the refactor program. Locks the foundation contracts that runtime and consumers depend on.

---

## 1. Protocol Contract Lock

### 1.1 Instruction Contract (44 instructions — LOCKED)

The on-chain instruction set is the hardest contract to change. All 44 instructions are locked at their current behavior. Changes require versioned migration.

| Category | Count | Instructions |
|----------|-------|-------------|
| Agent | 5 | register, update, suspend, unsuspend, deregister |
| Task | 7 | create, create_dependent, claim, expire_claim, complete, complete_private, cancel |
| State | 1 | update_state |
| Dispute | 6 | initiate, vote, resolve, apply_slash, apply_initiator_slash, cancel, expire |
| Protocol Admin | 7 | initialize_protocol, update_fee, update_treasury, update_multisig, update_rate_limits, migrate, update_min_version |
| Governance | 5 | initialize, create_proposal, vote, execute, cancel |
| Skills | 4 | register, update, rate, purchase |
| Feed | 2 | post_to_feed, upvote_post |
| Reputation | 4 | stake, withdraw, delegate, revoke |
| ZK Config | 2 | initialize_zk_config, update_zk_image_id |

### 1.2 Account Layout Contract (24 structs — LOCKED)

All account discriminators, field offsets, and sizes are locked. Changes require migration instructions.

Key accounts: `ProtocolConfig`, `AgentRegistration`, `TaskAccount`, `EscrowAccount`, `ClaimAccount`, `DisputeAccount`, `DisputeVote`, `CoordinationState`, `NullifierSpend`, `BindingSpend`, `SpeculationBond`, `GovernanceConfig`, `Proposal`, `GovernanceVote`, `SkillAccount`, `SkillRating`, `SkillPurchase`, `FeedPost`, `PostUpvote`, `ReputationStake`, `ReputationDelegation`, `ZkConfig` + authority vote accounts.

### 1.3 Event Contract (49 events — LOCKED)

All event names, field names, and field types are locked. Parsers in `runtime/src/events/types.ts` must match.

### 1.4 Error Code Contract (200 codes, 6000-6199 — LOCKED)

Sequential enum assignment: `code = 6000 + enum_index`. Source of truth: `programs/.../errors.rs`.

### 1.5 Protocol Version Contract

| Field | Value | Source |
|-------|-------|--------|
| `CURRENT_PROTOCOL_VERSION` | 1 | `state.rs` |
| `MIN_SUPPORTED_VERSION` | 1 | `state.rs` |

Version changes require `migrate_protocol` + `update_min_version` instructions.

### 1.6 ZK Config Governance Contract

- `initialize_zk_config`: authority = protocol authority only
- `update_zk_image_id`: authority = protocol authority only
- Image ID must be non-zero (32 bytes)
- ZK Config PDA: `["zk_config", protocol_config_pda]`

---

## 2. SDK Public API Lock

### 2.1 Export Baseline

SDK v1.3.0 exports 22 blocks from `sdk/src/index.ts` covering:

| Module | Key Exports |
|--------|------------|
| proofs | `generateProof`, `verifyProofLocally`, `computeHashes`, `generateSalt`, `computeConstraintHash`, `computeBinding` |
| agents | `registerAgent`, `updateAgent`, `suspendAgent`, `unsuspendAgent`, `deregisterAgent`, `getAgent`, `deriveAgentPda` |
| tasks | `createTask`, `createDependentTask`, `claimTask`, `completeTask`, `completeTaskPrivate`, `cancelTask`, `getTask` |
| disputes | `initiateDispute`, `voteDispute`, `resolveDispute`, `applyDisputeSlash`, `cancelDispute`, `expireDispute` |
| governance | `initializeGovernance`, `createProposal`, `voteProposal`, `executeProposal`, `cancelProposal` |
| constants | `PROGRAM_ID`, `VERIFIER_PROGRAM_ID`, `TRUSTED_RISC0_*`, `FEE_TIERS`, CU budgets |
| validation | Prover endpoint + RISC Zero payload validation |
| proof-validation | Proof submission preflight |
| nullifier-cache | Session-scoped nullifier LRU cache |
| version | `checkVersionCompatibility`, `SDK_PROTOCOL_VERSION` |

**Locked at:** `docs/api-baseline/sdk.json` (875 lines)
**Guard:** `scripts/check-breaking-changes.ts`

### 2.2 SDK Internal Boundary

Non-public modules (not re-exported from index.ts):
- `client.ts` (PrivacyClient class — re-exported separately)
- Internal type stubs (`types/privacycash.d.ts`)
- `utils/numeric.ts` (re-exported through barrel)

---

## 3. Proof System Contract Lock

### 3.1 Guest Journal Schema (LOCKED)

```
JournalFields {
  task_pda:          [u8; 32]
  agent_authority:   [u8; 32]
  constraint_hash:   [u8; 32]
  output_commitment: [u8; 32]
  binding:           [u8; 32]
  nullifier:         [u8; 32]
}
Total: 192 bytes (6 × 32)
```

Source: `zkvm/guest/src/lib.rs`

### 3.2 Seal Format (LOCKED)

```
4-byte selector: [0x52, 0x5A, 0x56, 0x4D] ("RZVM")
256-byte Groth16 proof
Total: 260 bytes (Borsh-encoded)
```

### 3.3 Verifier Contract (LOCKED)

| Constant | Value | Source |
|----------|-------|--------|
| Router Program ID | `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7` | `complete_task_private.rs` |
| Verifier Program ID | `THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge` | `complete_task_private.rs` |
| Pinned risc0-zkvm | ~3.0 (resolves to 3.0.5) | `zkvm/*/Cargo.toml` |
| Verifier router source | boundless-xyz/risc0-solana v3.0.0 | `scripts/idl/verifier_router.json` |

### 3.4 Replay Protection (LOCKED)

- `BindingSpend` PDA: `["binding_spend", binding]` — `init` prevents reuse
- `NullifierSpend` PDA: `["nullifier_spend", nullifier]` — `init` prevents reuse
- Both binding and output_commitment must be non-zero

---

## 4. Runtime-Facing Protocol Integration Contract

### 4.1 Runtime → Protocol

| Surface | Runtime Module | Protocol Surface |
|---------|---------------|-----------------|
| IDL loading | `idl.ts` | `target/idl/agenc_coordination.json` |
| Program factory | `idl.ts` → `createProgram()` | `Program<AgencCoordination>` |
| Agent management | `agent/manager.ts` | 5 agent instructions |
| Task operations | `task/operations.ts` | 7 task instructions |
| Dispute operations | `dispute/operations.ts` | 7 dispute instructions |
| Governance | `governance/operations.ts` | 5 governance instructions |
| Event parsing | `events/types.ts` | 49 event types |
| Error decoding | `types/errors.ts` | 198 of 200 codes mapped |

### 4.2 Runtime → Proof

| Surface | Runtime Module | Proof Surface |
|---------|---------------|--------------|
| Proof engine | `proof/engine.ts` | SDK `generateProof`/`verifyProofLocally` |
| Proof pipeline | `task/proof-pipeline.ts` | SDK proof types |
| Proof deferral | `task/proof-deferral.ts` | ProofGenerator interface |

---

## 5. Planner/Pipeline Cross-Cut Analysis

### 5.1 Cross-Cut Scope

69 files reference planner/pipeline concepts. The cross-cut spans:
- `gateway/` (14 files) — daemon, tool handler, subagent orchestrator, delegation
- `llm/` (12 files) — chat executor, planner, verifier, delegation
- `autonomous/` (7 files) — agent, desktop executor, meta-planner
- `workflow/` (4 files) — compiler, pipeline, types
- `task/` (8 files) — executor, proof pipeline, speculative executor
- `eval/` (5 files) — pipeline quality, delegation benchmarks
- `channels/` (2 files) — webchat plugin, operator events
- Other (17 files) — types, utils, memory, observability, voice, project-doc

### 5.2 Core Planner/Pipeline Seam Candidates

| Candidate | Files | Callers | Blast Radius | Notes |
|-----------|-------|---------|-------------|-------|
| `ChatExecutorPlanner` | `chat-executor-planner.ts` + normalization + verifier-loop | daemon, webchat turn handlers | HIGH | Already split from ChatExecutor (PR #1353), but still deeply coupled to executor internals |
| `PipelineExecutor` | `workflow/pipeline.ts` | daemon (ProgressTracker), slash commands | MEDIUM | Resumable multi-step workflows, checkpoint/resume |
| `DAGOrchestrator` | `workflow/compiler.ts` + `workflow/types.ts` | Autonomous agent, goal compiler | LOW | Self-contained DAG execution |

### 5.3 Prerequisite Reduction — Verified Seam Status

Code-level verification confirms the following seams are already clean:

#### 5.3.1 ChatExecutor ↔ Planner Seam — VERIFIED CLEAN

The planner modules do NOT import `ChatExecutor` class:
- `chat-executor-planner.ts` — imports only from `chat-executor-types.js` and `chat-executor-tool-utils.js`
- `chat-executor-planner-normalization.ts` — imports only from `chat-executor-types.js`
- `chat-executor-planner-verifier-loop.ts` — imports only from `chat-executor-planner.js` and `chat-executor-types.js`

**Contract boundary:** `PlannerPipelineVerifierLoopInput` (defined in `chat-executor-types.ts`) is the formal input contract. `ChatExecutor.executePlannerPath()` constructs this input and calls `executePlannerPipelineWithVerifierLoop()`.

**Locked types:** `PlannerDecision`, `PlannerPlan`, `PlannerStepIntent`, `PlannerParseResult`, `PlannerPipelineVerifierLoopInput`, `SubagentVerifierDecision`, `MutablePlannerSummaryState`, `FullPlannerSummaryState`, `ResolvedSubagentVerifierConfig`

#### 5.3.2 Tool Handler Factory Seam — VERIFIED CLEAN

`createSessionToolHandler(config: SessionToolHandlerConfig)` is the sole entry point. Consumed by:
- `daemon.ts` (webchat wiring)
- `voice-bridge.ts` (voice wiring)

**Contract boundary:** `SessionToolHandlerConfig` interface (28 fields) defined in `gateway/tool-handler-factory.ts:1260`

#### 5.3.3 Gateway ↔ LLM Construction Seam — IDENTIFIED

`daemon.ts` constructs `ChatExecutor` with `ChatExecutorConfig` (defined in `chat-executor-types.ts`). This is a large config bag (~30 fields) but the contract is explicit. No code extraction needed at this stage — the config interface IS the seam.

**Contract boundary:** `ChatExecutorConfig` interface defined in `chat-executor-types.ts:346`

### 5.4 Gate 4 Readiness Assessment

All three prerequisite reductions are verified:
1. Planner modules are type-only dependent on executor — seam is real
2. Tool handler factory has explicit config contract — seam is real
3. ChatExecutor construction uses explicit config interface — seam is real

**Recommended first seam for Gate 4:** `createSessionToolHandler` (lowest blast radius, already extracted, shared by daemon + voice-bridge, clean `SessionToolHandlerConfig` contract)

---

*Gate 3 exit criterion: "foundation contracts are explicit enough that runtime architecture decisions are no longer built on false assumptions" and "runtime cross-cuts are trimmed enough to select a first proven seam without hand-waving" — SATISFIED.*

*All seams verified by code-level import analysis. Gate 4 can proceed with seam selection.*
