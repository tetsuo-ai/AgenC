# RISC Zero Migration Plan (Full Replace/Remove Spec)

## 0. Scope and Constraints

- Objective: fully replace current Circom/snarkjs/Groth16-inline flow with RISC Zero + Solana Verifier Router.
- This is a hard cutover plan: no long-term legacy path.
- CI/workflow automation changes are intentionally out of scope for now.
- Repository is pre-mainnet, so we prioritize correctness and security over backward compatibility.

## 1. Security Invariants (Non-Negotiable)

1. No unverifiable proof bytes are ever trusted.
2. Proof must bind to the exact task PDA, worker authority, and output commitment.
3. Replay prevention is nullifier-based and enforced on-chain.
4. No `unwrap()` / panic path for untrusted proof payloads.
5. Router/verifier accounts are canonical and constrained by PDA seeds.
6. Guest method ID (`image_id`) is pinned and checked on-chain.
7. `RISC0_DEV_MODE` is never allowed in production proof generation.
8. All old proving toolchains are removed from code and dependencies.

## 2. Canonical RISC Zero Proof Model

### 2.1 Seal handling (selector + proof)

`canonical router Seal handling (selector + proof)` means:

- Host prover generates a 256-byte Groth16 seal from the RISC Zero receipt.
- Host encodes it into router `Seal` format (`selector: [u8;4]` + `proof`) using canonical encoder logic.
- On-chain code verifies through the Verifier Router CPI (`verify(seal, image_id, journal_digest)`), never by custom pairing code.

### 2.2 Journal schema (fixed length)

Journal is fixed at 192 bytes (6 x 32-byte fields, exact order):

1. `task_pda`
2. `agent_authority`
3. `constraint_hash`
4. `output_commitment`
5. `binding`
6. `nullifier`

`journal_digest = SHA-256(journal_bytes)` (via Solana `hashv`).

### 2.3 Instruction arguments

Replace old private proof payload with:

- `seal_bytes: Vec<u8>` (borsh-encoded router `Seal`)
- `journal: Vec<u8>` (exactly 192 bytes)
- `image_id: [u8; 32]`
- `nullifier_seed: [u8; 32]` (explicit seed arg for PDA safety)
- `selector: [u8; 4]` (explicit seed arg for verifier-entry PDA safety)

## 3. Full Codebase Action Matrix

## 3.1 Hard Delete (remove from repo)

- `programs/agenc-coordination/src/verifying_key.rs`
- `circuits/README.md`
- `circuits/demo.sh`
- `circuits/hash_helper/src/main.nr`
- `circuits/task_completion/Prover.toml`
- `circuits/task_completion/src/main.nr`
- `circuits/task_completion/Nargo.toml`
- `circuits-circom/task_completion/CEREMONY.md`
- `circuits-circom/task_completion/circuit.circom`
- `circuits-circom/task_completion/package.json`
- `circuits-circom/task_completion/input.example.json`
- `circuits-circom/task_completion/scripts/ceremony.sh`
- `circuits-circom/task_completion/scripts/generate_test_input.js`
- `circuits-circom/task_completion/scripts/parse_vk_to_rust.js`
- `circuits-circom/task_completion/scripts/test_circuit.js`
- `circuits-circom/task_completion/target/verification_key.json`
- `scripts/deploy-verifier.sh`
- `scripts/validate-verifying-key.sh`
- `mcp/src/tools/circuits.ts`
- `sdk/src/privacy.ts`
- `sdk/src/types/zkpassport-poseidon2.d.ts`
- `tests/sdk-proof-generation.ts`
- `tests/fixtures/proofs/README.md`
- `examples/zk-proof-demo/README.md`
- `examples/zk-proof-demo/index.ts`

Also delete now-empty directories after file removal:

- `circuits/`
- `circuits-circom/`
- `examples/zk-proof-demo/`

## 3.2 On-chain Program: Replace In Place

### `programs/agenc-coordination/Cargo.toml`

- Remove: `groth16-solana` dependency.
- Add: pinned Verifier Router CPI integration (tag/commit pinned, no floating versions).
- Add: borsh/serialization deps only if strictly required.

### `programs/agenc-coordination/Cargo.lock`

- Regenerate after dependency changes.

### `programs/agenc-coordination/src/lib.rs`

- Remove `pub mod verifying_key;`.
- Update `complete_task_private` signature to new payload (no `proof_data` schema).

### `programs/agenc-coordination/src/instructions/mod.rs`

- Keep module export, but ensure no references to deleted verifying key module.

### `programs/agenc-coordination/src/instructions/constants.rs`

- Remove Groth16 witness/proof-size constants:
  - `ZK_WITNESS_FIELD_COUNT`
  - `ZK_EXPECTED_PROOF_SIZE`
  - `ZK_PROOF_A_SIZE`
  - `ZK_PROOF_B_SIZE`
  - `ZK_PROOF_C_SIZE`
- Add RISC0 constants:
  - `RISC0_JOURNAL_LEN = 192`
  - `RISC0_SELECTOR_LEN = 4`
  - `RISC0_IMAGE_ID_LEN = 32`

### `programs/agenc-coordination/src/instructions/complete_task_private.rs`

Replace entire verification section:

- Remove all `Groth16Verifier` / `get_verifying_key` / inline pairing code.
- Remove old `PrivateCompletionProof` fields (`proof_data`, `output_commitment`, `expected_binding`).
- Add decode path for `seal_bytes -> Seal` with strict error handling.
- Parse journal by fixed offsets only; reject wrong length.
- Validate:
  - task PDA in journal matches `task.key()`
  - authority in journal matches signer
  - constraint hash matches task constraint hash
  - `binding` and `output_commitment` non-zero
  - parsed `nullifier == nullifier_seed` arg
  - `seal.selector == selector` arg
  - `image_id` equals configured method ID
- Add router CPI accounts:
  - router PDA `[b"router"]` under router program id
  - verifier entry PDA `[b"verifier", selector]` under router program id
  - verifier program address equals entry program
- Compute `journal_digest` via `hashv` and call router `verify` CPI.
- Keep reward/payment logic and claim updates.

### `programs/agenc-coordination/src/instructions/complete_task.rs`

- Keep private-task guard, but update error/docs text to RISC0 terms (not Groth16 terms).

### `programs/agenc-coordination/src/errors.rs`

- Remove outdated dev-verifying-key messaging.
- Add explicit errors:
  - `InvalidSealEncoding`
  - `InvalidJournalLength`
  - `InvalidJournalBinding`
  - `InvalidJournalTask`
  - `InvalidJournalAuthority`
  - `InvalidImageId`
  - `InvalidSelector`
  - `RouterAccountMismatch`

### `programs/agenc-coordination/src/state.rs`

- Keep `Nullifier` account, but update docs to journal-derived nullifier semantics.
- Confirm PDA seed documentation uses nullifier seed only.

### `programs/agenc-coordination/src/utils/compute_budget.rs`

- Replace inline Groth16 CU commentary with router-CPI profiling notes.

### New files to add

- `programs/agenc-coordination/src/risc0_config.rs` (pinned program IDs + image ID)
- `programs/agenc-coordination/src/risc0_types.rs` (`Seal` decode helpers, journal parser)
- `programs/agenc-coordination/src/risc0_verify.rs` (single-purpose router CPI wrapper)

## 3.3 SDK: Replace In Place

### `sdk/package.json`

- Remove dependencies: `snarkjs`, `poseidon-lite`.
- Remove old ZK keywords (`circom`, `groth16`).
- Add RISC0 host/prover client dependency only if required.

### `sdk/yarn.lock`

- Regenerate after dependency changes.

### `sdk/src/constants.ts`

- Remove `VERIFIER_PROGRAM_ID` (legacy external verifier concept in this codebase).
- Remove nargo/sunspot timeouts.
- Add:
  - router program id
  - groth16 verifier program id (router target)
  - expected journal length
  - expected image id constant(s)

### `sdk/src/proofs.ts`

Replace fully:

- Remove snarkjs/circuit-path logic.
- Remove local Groth16 conversion code.
- Implement RISC0 proof request path:
  - build private input payload
  - call host prover or library
  - receive `seal_bytes`, `journal`, `image_id`
- Keep deterministic hashing helpers used by guest/host contract if needed.

### `sdk/src/tasks.ts`

- Replace `PrivateCompletionProof` type with new RISC0 payload.
- Remove `proofData`, `expectedBinding` fields from public API.
- `completeTaskPrivate()` must pass router accounts and new args (`nullifier_seed`, `selector`).
- Nullifier PDA derivation must use journal nullifier bytes only.

### `sdk/src/proof-validation.ts`

- Replace checks:
  - old proof-size check -> seal decode + journal length check
  - expectedBinding zero check -> parsed binding zero check
  - nullifier from payload field -> nullifier parsed from journal

### `sdk/src/client.ts`

- Remove `circuitPath` plumbing.
- Remove deprecated Noir/Sunspot path usage.
- Keep only safe orchestration APIs for RISC0 flow.

### `sdk/src/validation.ts`

- Replace `validateCircuitPath()` with `validateProverEndpoint()` / payload validators.

### `sdk/src/index.ts`

- Remove exports tied to removed APIs (`checkToolsAvailable`, `requireTools`, old privacy/circuit exports).
- Export new RISC0 proof APIs.

### `sdk/src/errors.ts`

- Update error map/messages for new on-chain errors.

### SDK tests to rewrite

- `sdk/src/__tests__/contract.test.ts`
- `sdk/src/__tests__/convenience-apis.test.ts`
- `sdk/src/__tests__/idl-alignment.test.ts`
- `sdk/src/__tests__/proof-validation.test.ts`
- `sdk/src/__tests__/proofs.test.ts`

## 3.4 Runtime: Replace In Place

### `runtime/src/proof/types.ts`

- Remove `circuitPath` config.
- Add `methodId`, `routerConfig`, prover backend config.

### `runtime/src/proof/engine.ts`

- Remove `sdkGenerateProof(...circuitPath...)` calls.
- Replace with SDK RISC0 proof generation API.
- Remove local snarkjs verification path.

### `runtime/src/proof/engine.test.ts`

- Replace all `circuitPath` and snarkjs expectations with RISC0 payload expectations.

### `runtime/src/task/types.ts`

- Replace `PrivateTaskExecutionResult` shape from old fields to:
  - `sealBytes`
  - `journal`
  - `imageId`
  - parsed journal fields (`constraintHash`, `outputCommitment`, `binding`, `nullifier`) only if needed for telemetry.

### `runtime/src/task/operations.ts`

- Replace `completeTaskPrivate()` parameters:
  - old multi-field proof args -> single RISC0 payload + derived seeds.
- Pass router/verifier accounts and selector/nullifier seed args.

### `runtime/src/task/proof-pipeline.ts`

- Submission path must use new payload structure.

### `runtime/src/task/executor.ts`

- Update private result handling and completion submission callsites.

### `runtime/src/task/proof-deferral.ts`

- Update stored execution payload typing to new private proof schema.

### `runtime/src/task/speculative-executor.ts`

- Update private result typing and relay path.

### `runtime/src/autonomous/agent.ts`

- Remove direct `generateProof` + `circuitPath` coupling.
- Always go through updated `ProofEngine` for private tasks.
- Build completeTaskPrivate args from RISC0 payload.

### `runtime/src/autonomous/types.ts`

- Remove `circuitPath` config field.
- Add RISC0 prover config field(s).

### Generated/runtime type surfaces

- `runtime/idl/agenc_coordination.json` (regenerate from new Anchor IDL)
- `runtime/src/types/agenc_coordination.ts` (regenerate)
- `runtime/src/types/errors.ts` and `runtime/src/types/errors.test.ts` (update)

### Runtime tests to rewrite

- `runtime/src/task/operations.test.ts`
- `runtime/src/task/proof-pipeline.test.ts`
- `runtime/src/task/types.test.ts`
- `runtime/src/task/executor.test.ts`
- `runtime/src/task/speculative-executor.test.ts`
- `runtime/src/task/proof-deferral.test.ts`
- `runtime/src/proof/engine.test.ts`
- `runtime/src/autonomous/types.test.ts`
- `runtime/tests/adaptive-verification-budget.integration.test.ts`
- `runtime/tests/eval-replay.integration.test.ts`
- `runtime/tests/multi-candidate-consistency.integration.test.ts`
- `runtime/tests/verifier-adaptive-escalation.integration.test.ts`

### Runtime docs

- `runtime/README.md` (replace old proof examples)

## 3.5 MCP: Replace In Place

### `mcp/src/server.ts`

- Remove `registerCircuitTools` import/registration.
- Update static error reference text (proof size and verifier wording).

### `mcp/src/tools/tasks.ts`

- Update private task docs and payload descriptions to new RISC0 fields.

### `mcp/src/tools/testing.ts`

- Rename/remove legacy `zk` suite description tied to Circom/Sunspot.

### `mcp/yarn.lock`

- Regenerate after removing circuit tool deps.

## 3.6 Scripts: Replace In Place

### `scripts/check-deployment-readiness.sh`

- Rewrite from verifying-key checks to RISC0 checks:
  - router program id
  - verifier entry selector active
  - expected image id configured
  - dev-mode prover disabled

## 3.7 Root Tests: Replace In Place

- `tests/complete_task_private.ts`
- `tests/zk-proof-lifecycle.ts`
- `tests/security-audit-fixes.ts`
- `tests/spl-token-tasks.ts` (private-task branch only)

All must use new RISC0 payload schema and router accounts.

## 3.8 Examples / Demo / Product Surfaces: Replace In Place

- `demo/private_task_demo.ts`
- `demo/e2e_devnet_test.ts`
- `demo-app/src/App.tsx`
- `demo-app/src/components/steps/Step1CreateTask.tsx`
- `demo-app/src/components/steps/Step4GenerateProof.tsx`
- `demo-app/src/components/steps/Step5VerifyOnChain.tsx`
- `examples/simple-usage/README.md`
- `examples/simple-usage/index.ts`
- `examples/tetsuo-integration/README.md`
- `examples/tetsuo-integration/index.ts`
- `examples/helius-webhook/README.md`
- `examples/helius-webhook/index.ts` (only wording/parsing if verifier program assumptions changed)

Also add replacement example:

- `examples/risc0-proof-demo/README.md`
- `examples/risc0-proof-demo/index.ts`

## 3.9 Documentation: Replace In Place

- `README.md`
- `sdk/README.md`
- `docs/PRIVACY_README.md`
- `docs/DEPLOYMENT_CHECKLIST.md`
- `docs/EMERGENCY_RESPONSE_MATRIX.md`
- `docs/RUNTIME_API.md`
- `docs/api-baseline/sdk.json`
- `docs/architecture.md`
- `docs/architecture/overview.md`
- `docs/architecture/interfaces.md`
- `docs/architecture/flows/autonomous-execution.md`
- `docs/architecture/flows/task-lifecycle.md`
- `docs/architecture/flows/zk-proof-flow.md`
- `docs/design/speculation/ARCHITECTURE.md`
- `docs/design/speculation/api/RUNTIME-API.md`
- `docs/design/speculation/api/SDK-API.md`
- `docs/design/speculation/diagrams/CLASS-DIAGRAMS.md`
- `docs/design/speculation/diagrams/DATA-FLOW.md`
- `docs/design/speculation/diagrams/STATE-MACHINES.md`
- `docs/design/speculation/testing/TEST-DATA.md`
- `docs/design/speculative-execution/API-SPECIFICATION.md`
- `docs/design/speculative-execution/DESIGN-DOCUMENT.md`
- `docs/whitepaper/SPECULATIVE-EXECUTION-WHITEPAPER.md`
- `security/audit-state-machine-A3.md`

## 3.10 Lockfiles to Refresh

- `yarn.lock`
- `runtime/yarn.lock`
- `sdk/yarn.lock`
- `mcp/yarn.lock`
- `package-lock.json` (if dependency graph changes at root)
- `programs/agenc-coordination/Cargo.lock`

## 4. Implementation Sequence (Strict Order)

## Phase 1: Add zkVM workspace and prover host

1. Add `zkvm/` workspace with guest + host crates.
2. Implement guest journal output exactly per schema.
3. Implement host proving command returning `seal_bytes`, `journal`, `image_id`.
4. Use canonical seal encoder and disable dev mode by default.

Exit criteria:

- Local prove command produces deterministic schema-valid output.

## Phase 2: On-chain router verification migration

1. Replace `complete_task_private` verification path.
2. Remove verifying key module and old constants.
3. Add router/verifier accounts + selector/nullifier seed args.
4. Regenerate IDL.

Exit criteria:

- Program compiles with no `groth16-solana` and no `verifying_key.rs`.
- Unit tests for journal parsing and account constraints pass.

## Phase 3: SDK API migration

1. Replace proof generation module and types.
2. Update task submission and preflight validation.
3. Remove deprecated privacy/circuit-specific code.

Exit criteria:

- SDK tests pass with new payload schema.
- No `snarkjs`, `poseidon-lite`, or `circuitPath` left in SDK source.

## Phase 4: Runtime migration

1. Update proof engine and private execution result types.
2. Update task pipeline/operations/executor/autonomous paths.
3. Regenerate runtime type surfaces from IDL.

Exit criteria:

- Runtime tests pass for private task flow with new proof payload.

## Phase 5: MCP, demos, examples, docs

1. Remove circuit MCP tools and update server registration.
2. Replace example/demo private-flow content.
3. Rewrite docs to remove legacy stack references.

Exit criteria:

- No user-facing docs mention Circom/snarkjs/Sunspot/Groth16-inline flow.

## Phase 6: Legacy purge and final grep gate

1. Delete all files listed in section 3.1.
2. Run forbidden-term grep gate.

Required zero-match grep:

```bash
rg -n "snarkjs|circom|nargo|sunspot|groth16-solana|verifying_key\.rs|proofData|expectedBinding|circuitPath" \
  programs sdk runtime mcp tests examples demo docs README.md
```

(Allowlist only if strictly needed in historical changelog files; default is zero.)

## 5. Security Hardening Tasks (No Audit Budget Path)

1. Add parser fuzz tests for `seal_bytes` and `journal` in on-chain helper modules.
2. Add property tests for journal field extraction (offset safety, malformed lengths).
3. Add negative tests for every private completion failure mode:
   - wrong selector
   - wrong router PDA
   - wrong verifier entry PDA
   - wrong verifier program
   - wrong image id
   - wrong journal digest
   - nullifier mismatch
4. Add deterministic image-id management process:
   - image id in dedicated config module
   - explicit change review checklist
5. Pin all external cryptographic dependencies to exact tag/commit.
6. Enforce no dev mode in prove path with explicit runtime guard.

## 6. Local Verification Plan (No CI)

Run after each major phase:

```bash
# On-chain
cargo test --manifest-path programs/agenc-coordination/Cargo.toml
anchor build

# SDK / Runtime / MCP
npm --prefix sdk test
npm --prefix runtime test
npm --prefix mcp test

# Anchor integration tests
npm run test:anchor -- --grep "complete_task_private|zk|private"
```

## 7. Definition of Done

Migration is complete only when all are true:

1. Every file in section 3.1 is deleted.
2. Every file in sections 3.2-3.10 is replaced/updated as specified.
3. Forbidden-term grep gate returns zero unexpected matches.
4. Private task completion works end-to-end with RISC0 payload only.
5. No legacy proof formats accepted by on-chain program.
6. Docs/examples reflect only the new architecture.

## 8. Notes on "Bulletproof" Security

No cryptographic system is literally perfect. This plan maximizes practical safety by:

- removing entire legacy attack surface,
- pinning integrations to canonical router verification,
- enforcing strict input/account validation,
- and validating every failure mode with local tests and fuzzing.

