# RISC Zero Migration Plan (Full Replace/Remove Spec)

## 0. Scope and Constraints

- Objective: fully replace current Circom/snarkjs/Groth16-inline flow with RISC Zero + Solana Verifier Router.
- This is a hard cutover plan: no long-term legacy path.
- GitHub Actions / workflow YAML changes are out of scope for now.
- Local safety scripts are in scope only when they enforce proof-verification security invariants.
- Repository is pre-mainnet, so we prioritize correctness and security over backward compatibility.
- Zero-legacy policy: no legacy proof-stack terms/tools remain anywhere in tracked or untracked workspace files (code, tests, docs, examples, skill fixtures, local agent/rules docs) at migration completion.

## 1. Security Invariants (Non-Negotiable)

1. No unverifiable proof bytes are ever trusted.
2. Proof must bind to the exact task PDA, worker authority, and output commitment.
3. Replay prevention is enforced on-chain with binding and nullifier spend records.
4. No `unwrap()` / panic path for untrusted proof payloads.
5. Router/verifier accounts are canonical and constrained by PDA seeds.
6. Router program ID, trusted selector, and trusted verifier program ID are pinned and checked on-chain.
7. Guest method ID (`image_id`) is pinned and checked on-chain.
8. Production prover builds MUST compile with `risc0-zkvm` feature `disable-dev-mode`; runtime must fail closed if `RISC0_DEV_MODE` is set.
9. All RISC Zero Solana dependencies must pin to official releases (release tags or release commits), never floating refs or `main`.
10. Production deployments use canonical Verifier Router integration and pinned router/verifier IDs from a protocol allowlist (official deployments preferred; self-deployments require explicit security sign-off).
11. All old proving toolchains are removed from code and dependencies.
12. Pinned RISC0 crate versions must be outside known vulnerable ranges from official advisories before release.

## 2. Canonical RISC Zero Proof Model

### 2.1 Seal handling (selector + proof)

`canonical router Seal handling (selector + proof)` means:

- Host prover generates a 256-byte Groth16 seal from the RISC Zero receipt.
- Host encodes it into router `Seal` format (`selector: [u8;4]` + `proof`) using canonical encoder logic.
- On-chain code verifies through the Verifier Router CPI (`verify(seal, image_id, journal_digest)`), never by custom pairing code.
- For the pinned Groth16 router path, encoded `Seal` length is fixed: 260 bytes (`selector[4] + pi_a[64] + pi_b[128] + pi_c[64]`).

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
- `binding_seed: [u8; 32]` (explicit seed arg for binding-spend PDA safety)
- `nullifier_seed: [u8; 32]` (explicit seed arg for nullifier-spend PDA safety)

No user-provided selector argument is accepted. Selector is parsed from `seal`, then must match pinned `TRUSTED_RISC0_SELECTOR`.

### 2.4 Replay-Safety Semantics (Binding + Nullifier)

To avoid regressions and undefined behavior for repeated tasks with identical constraints:

- Add `BindingSpend` PDA seeded by `binding` (prevents statement replay for the same task/agent/commitment context).
- Add `NullifierSpend` PDA seeded by `nullifier` (prevents global proof-knowledge replay).
- Update nullifier derivation to include commitment context:
  - `nullifier = SHA256("AGENC_V2_NULLIFIER" || constraint_hash || output_commitment || agent_secret)`

This explicitly allows legitimate repeated work on identical constraints when commitment changes, while still rejecting exact replay.

### 2.5 Legacy Replay-Seed Mismatch to Resolve During Migration

Current code and docs are inconsistent:

- `complete_task_private` currently seeds replay protection using `expected_binding` in the PDA seed path.
- `state.rs` nullifier account docs describe nullifier-seeded replay semantics.

Migration must remove this ambiguity by implementing the explicit dual-spend model (`BindingSpend` + `NullifierSpend`) and deleting legacy single-account seed behavior.

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
- Add: pinned Verifier Router CPI integration using official release tags (or release commits), never floating versions or `main`.
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
  - `RISC0_GROTH16_SEAL_LEN = 256`
  - `RISC0_SEAL_BORSH_LEN = 260`

### `programs/agenc-coordination/src/instructions/complete_task_private.rs`

Replace entire verification section:

- Remove all `Groth16Verifier` / `get_verifying_key` / inline pairing code.
- Remove old `PrivateCompletionProof` fields (`proof_data`, `output_commitment`, `expected_binding`).
- Enforce strict pre-decode envelope check: `seal_bytes.len() == RISC0_SEAL_BORSH_LEN`.
- Add decode path for `seal_bytes -> Seal` with strict error handling.
- Parse journal by fixed offsets only; reject wrong length.
- Validate:
  - task PDA in journal matches `task.key()`
  - authority in journal matches signer
  - constraint hash matches task constraint hash
  - `binding`, `output_commitment`, and `nullifier` non-zero
  - parsed `binding == binding_seed` arg
  - parsed `nullifier == nullifier_seed` arg
  - `seal.selector == TRUSTED_RISC0_SELECTOR`
  - `image_id` equals configured method ID
- Add router CPI accounts:
  - router PDA `[b"router"]` under router program id
  - verifier entry PDA `[b"verifier", TRUSTED_RISC0_SELECTOR]` under router program id
  - verifier entry `selector` equals `TRUSTED_RISC0_SELECTOR`
  - verifier entry `verifier` equals `TRUSTED_RISC0_VERIFIER_PROGRAM_ID`
  - verifier program account equals `TRUSTED_RISC0_VERIFIER_PROGRAM_ID`
- Compute `journal_digest` via `hashv` and call router `verify` CPI.
- Initialize both `binding_spend` and `nullifier_spend` accounts.
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
  - `TrustedSelectorMismatch`
  - `TrustedVerifierProgramMismatch`
  - `RouterAccountMismatch`

### `programs/agenc-coordination/src/state.rs`

- Replace single replay account model with explicit dual model:
  - `BindingSpend` account seeded by binding
  - `NullifierSpend` account seeded by nullifier
- Update docs to describe V2 nullifier semantics and repeated-same-constraint behavior.

### `programs/agenc-coordination/src/utils/compute_budget.rs`

- Replace inline Groth16 CU commentary with router-CPI profiling notes.

### New files to add

- `programs/agenc-coordination/src/risc0_config.rs` (pinned router/verifier IDs + trusted selector + image ID)
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
  - trusted selector constant
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
- `completeTaskPrivate()` must pass router accounts and new args (`binding_seed`, `nullifier_seed`).
- Spend-account derivation must use journal binding/nullifier bytes only (no caller-chosen selector path).

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
- `sdk/src/__tests__/client.test.ts`
- `sdk/src/__tests__/convenience-apis.test.ts`
- `sdk/src/__tests__/idl-alignment.test.ts`
- `sdk/src/__tests__/proof-validation.test.ts`
- `sdk/src/__tests__/proofs.test.ts`
- `sdk/src/__tests__/validation.test.ts`

## 3.4 Runtime: Replace In Place

### `runtime/src/proof/types.ts`

- Remove `circuitPath` config.
- Add `methodId`, `routerConfig`, prover backend config.

### `runtime/src/proof/index.ts`

- Update exports to remove any legacy proof/circuit-facing APIs.

### `runtime/src/builder.ts`

- Replace defaults and wiring that still point to legacy proof-generation paths.

### `runtime/src/index.ts`

- Update public runtime API surface to expose only RISC0 private-proof flow.

### `runtime/src/types/index.ts`

- Update exported type barrel for renamed private-proof payload types.

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
- Pass router/verifier accounts with trusted selector constant and binding/nullifier seed args.

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

### Runtime skill-markdown surfaces to update

- `runtime/src/skills/markdown/types.ts` (replace legacy tool examples in comments/metadata examples)
- `runtime/src/skills/markdown/parser.test.ts` (replace legacy fixture terms with RISC0-neutral fixture content)
- `runtime/src/skills/markdown/compat.test.ts` (replace legacy fixture terms with RISC0-neutral fixture content)

### Runtime docs

- `runtime/README.md` (replace old proof examples)

## 3.5 MCP: Replace In Place

### `mcp/src/server.ts`

- Remove `registerCircuitTools` import/registration.
- Update static error reference text (proof size and verifier wording), including stale claim-error lines.

### `mcp/src/tools/errors.ts`

- Update stale static error mappings/messages tied to legacy proof stack.

### `mcp/src/tools/tasks.ts`

- Update private task docs and payload descriptions to new RISC0 fields.

### `mcp/src/tools/testing.ts`

- Rename/remove legacy `zk` suite description tied to Circom/Sunspot.

### `mcp/yarn.lock`

- Regenerate after removing circuit tool deps.

## 3.6 Local Safety Scripts: Replace In Place

### `scripts/check-deployment-readiness.sh`

- Rewrite from verifying-key checks to RISC0 checks:
  - router program id matches protocol allowlist (official deployment ID where available, otherwise explicitly approved self-deployment ID)
  - pinned selector present and active
  - verifier entry program equals pinned trusted verifier
  - expected image id configured
  - prover build config enables `disable-dev-mode`
  - runtime/dev environment does not permit `RISC0_DEV_MODE` in production
  - dependency refs are pinned to release tags/commits (not `main`)

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
- `demo-app/src/components/CompletionSummary.tsx`
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
- `CLAUDE.md` (if tracked in target branch)
- `sdk/README.md`
- `docs/ROADMAP.md`
- `docs/PRIVACY_README.md`
- `docs/DEPLOYMENT_CHECKLIST.md`
- `docs/EMERGENCY_RESPONSE_MATRIX.md`
- `docs/RUNTIME_API.md`
- `docs/api-baseline/sdk.json`
- `docs/architecture.md`
- `docs/architecture.svg`
- `docs/benchmark.svg`
- `docs/architecture/overview.md`
- `docs/architecture/interfaces.md`
- `docs/architecture/guides/type-conventions.md`
- `docs/architecture/flows/autonomous-execution.md`
- `docs/architecture/flows/task-lifecycle.md`
- `docs/architecture/flows/zk-proof-flow.md`
- `docs/design/speculation/ARCHITECTURE.md`
- `docs/design/speculation/api/RUNTIME-API.md`
- `docs/design/speculation/api/SDK-API.md`
- `docs/design/speculation/diagrams/CLASS-DIAGRAMS.md`
- `docs/design/speculation/diagrams/DATA-FLOW.md`
- `docs/design/speculation/diagrams/SEQUENCE-DIAGRAMS.md`
- `docs/design/speculation/diagrams/STATE-MACHINES.md`
- `docs/design/speculation/diagrams/SWIMLANE-DIAGRAMS.md`
- `docs/design/speculation/testing/TEST-DATA.md`
- `docs/design/speculation/operations/CONFIGURATION.md`
- `docs/design/speculative-execution/API-SPECIFICATION.md`
- `docs/design/speculative-execution/DESIGN-DOCUMENT.md`
- `docs/design/speculative-execution/runbooks/deployment-runbook.md`
- `docs/design/speculative-execution/runbooks/tuning-guide.md`
- `docs/whitepaper/SPECULATIVE-EXECUTION-WHITEPAPER.md`
- `security/audit-state-machine-A3.md`

## 3.10 Workspace Rule/Agent Surfaces: Replace In Place

- `AGENTS.md` (if present in workspace)
- `.claude/agents/solana-implementer.md`
- `.claude/rules/anchor-zk-verification.md`
- `.claude/rules/noir-circuits.md`
- `.claude/rules/runtime.md`
- `.claude/rules/zk-overview.md`
- `.claude/rules/zk-sdk.md`
- `.claude/skills/doc-to-issues/SKILL.md`
- `.claude/skills/solana-group-coordinator/SKILL.md`
- `.claude/skills/solana-master-orchestrator/SKILL.md`
- `.claude/notes/techdebt-2026-02-10-session5.md`
- `.claude/notes/techdebt-2026-02-12.md`
- `.claude/notes/techdebt-2026-02-15.md`

All must be rewritten to remove legacy tool references and old proof-flow instructions.

## 3.11 Lockfiles to Refresh

- `yarn.lock`
- `runtime/yarn.lock`
- `sdk/yarn.lock`
- `mcp/yarn.lock`
- `programs/agenc-coordination/Cargo.lock`

Optional (only if npm lockfiles are adopted and tracked in git):

- `package-lock.json`
- `runtime/package-lock.json`
- `sdk/package-lock.json`
- `mcp/package-lock.json`

## 4. Implementation Phases (Execution Runbook)

### 4.0 Phase Map (What gets done, in order)

| Phase | Goal | Primary surfaces | Hard gate to move forward |
| --- | --- | --- | --- |
| 1 | Build zkVM proof producer | `zkvm/`, host/guest journal schema | deterministic `seal_bytes + journal + image_id`; dev mode compile lock enabled |
| 2 | Replace on-chain verification | `programs/agenc-coordination/src/**` | no `groth16-solana` / no `verifying_key.rs`; router verification passing |
| 3 | Replace SDK proof API | `sdk/src/**` | SDK tests green; no `snarkjs`/`circuitPath`/legacy proof payload |
| 4 | Replace runtime execution path | `runtime/src/**`, `runtime/idl/**` | runtime private-flow tests green on new payload |
| 5 | Replace external surfaces | `mcp/**`, `demo/**`, `examples/**`, `docs/**` | no user-facing legacy flow references |
| 6 | Remove legacy stack | files in section 3.1 + lockfiles | strict zero-match legacy grep passes |
| 7 | Final cleanup + freeze | migration artifacts + workspace docs/rules | zero legacy terms in tracked + untracked workspace |

### 4.1 Phase Execution Rules

1. Do not start a phase until the prior phase hard gate passes.
2. If a phase gate fails, fix within the same phase; do not defer.
3. Regenerate IDL/types immediately after program interface changes (Phase 2 and Phase 4).
4. After every phase, run local verification commands in section 6 before proceeding.

## Phase 1: Add zkVM workspace and prover host

1. Add `zkvm/` workspace with guest + host crates.
2. Implement guest journal output exactly per schema.
3. Implement host proving command returning `seal_bytes`, `journal`, `image_id`.
4. Use canonical seal encoder with pinned selector policy, and build prover artifacts with `disable-dev-mode`.

Exit criteria:

- Local prove command produces deterministic schema-valid output.
- Prover build is compiled with `disable-dev-mode`, and production runtime rejects accidental `RISC0_DEV_MODE` usage.
- Router/verifier IDs in config match the protocol allowlist and deployment provenance policy.

## Phase 2: On-chain router verification migration

1. Replace `complete_task_private` verification path.
2. Remove verifying key module and old constants.
3. Add router/verifier accounts + binding/nullifier seed args (selector is pinned constant, not caller arg).
4. Regenerate IDL.

Exit criteria:

- Program compiles with no `groth16-solana` and no `verifying_key.rs`.
- Unit tests for journal parsing and account constraints pass.
- Selector policy is enforced on-chain and covered by negative tests (including valid-format but untrusted selector).
- Replay semantics are finalized and implemented as specified in section 2.4, with regression tests for repeated-same-constraint behavior.

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

## Phase 6: Legacy purge and strict repo-wide grep gate

1. Delete all files listed in section 3.1.
2. Run forbidden-term grep gate across tracked and untracked workspace files (including hidden paths).

Required zero-match grep (strict scope, includes tests/docs/skills):

```bash
rg -n --hidden "snarkjs|circom|nargo|sunspot|groth16-solana|verifying_key\\.rs|proofData|expectedBinding|circuitPath|PrivateCompletionProof|Groth16Verifier|get_verifying_key" \
  . \
  --glob '!**/node_modules/**' \
  --glob '!**/dist/**' \
  --glob '!**/target/**' \
  --glob '!**/.git/**'
```

No allowlist for active workspace files.

## Phase 7: Transition-Artifact Cleanup and Final Zero-Legacy Gate

1. Remove or sanitize temporary migration artifacts so they contain no legacy stack terminology.
2. Re-run the strict repo-wide grep gate from Phase 6 with the same pattern set.

Exit criteria:

- Strict repo-wide grep gate returns zero matches across tracked and untracked workspace files.
- No code/tests/docs/examples/skill fixtures/agent docs contain legacy proof-stack terms or tool references.

### 4.2 Final Cutover Order (No skipping)

1. Phase 1 and 2 must complete before any new private-task integration work.
2. Phase 3 and 4 must complete before touching demos/examples/docs messaging.
3. Phase 5 must complete before deletion sweep in Phase 6.
4. Phase 7 is final sign-off only; no further feature edits after Phase 7 starts.

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
   - binding mismatch (`binding != binding_seed`)
   - nullifier mismatch
   - replay with pre-existing `binding_spend`
   - replay with pre-existing `nullifier_spend`
4. Add deterministic image-id management process:
   - image id in dedicated config module
   - explicit change review checklist
5. Pin all external cryptographic dependencies to release tags/commits (never `main`).
6. Enforce no dev mode in prove path with both compile-time (`disable-dev-mode`) and runtime guards.
7. Enforce strict seal envelope bounds before decode (`RISC0_SEAL_BORSH_LEN`).
8. Enforce upstream advisory floors for RISC0 crates in migration branch (as of 2026-02-18):
   - reject `risc0-zkvm` versions `< 2.3.2`
   - reject `r0vm` versions `< 2.3.1`
9. Maintain an in-repo trusted deployment snapshot for router/verifier IDs per cluster and require explicit review on any ID change.

## 6. Local Verification Plan (No CI)

Run after each major phase:

```bash
# On-chain
cargo test --manifest-path programs/agenc-coordination/Cargo.toml
anchor build

# Dependency/security checks
cargo audit --manifest-path programs/agenc-coordination/Cargo.toml
# When zkvm host is added:
# cargo audit --manifest-path zkvm/host/Cargo.toml
# Verify resolved RISC0 crate versions are outside advisory ranges:
# cargo tree --manifest-path zkvm/host/Cargo.toml | rg "risc0-zkvm|r0vm"

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
2. Every file in sections 3.2-3.11 is replaced/updated as specified.
3. Strict repo-wide forbidden-term grep gate returns zero matches.
4. Private task completion works end-to-end with RISC0 payload only.
5. No legacy proof formats accepted by on-chain program.
6. Docs/examples/skill fixtures reflect only the new architecture.

## 8. Notes on "Bulletproof" Security

No cryptographic system is literally perfect. This plan maximizes practical safety by:

- removing entire legacy attack surface,
- pinning integrations to canonical router verification,
- enforcing strict input/account validation,
- and validating every failure mode with local tests and fuzzing.

## 9. Wrong Assumptions (Do Not Reintroduce)

1. "Caller supplies selector at runtime."
   - Incorrect: selector must be pinned by protocol policy. It is parsed from `seal` and must match trusted config, not user-controlled instruction input.

2. "Replay protection is already nullifier-seeded on-chain."
   - Incorrect: current instruction path seeds replay PDA with `expected_binding` (`programs/agenc-coordination/src/instructions/complete_task_private.rs`), while state docs describe nullifier-seeded semantics (`programs/agenc-coordination/src/state.rs`). Migration must resolve this explicitly (section 2.5).

3. "Nullifier-only replay semantics are a safe drop-in replacement."
   - Incorrect: this can change repeated-same-constraint behavior. Replay policy must be explicitly selected and regression-tested before rollout (section 2.4 and Phase 2 exit criteria).

4. "Fixture/comment mentions of legacy tools can be ignored."
   - Incorrect: zero-legacy policy includes tests, examples, docs, skill fixtures, and local agent/rules docs. Update all such files to RISC0-compatible or neutral wording.

5. "Runtime `RISC0_DEV_MODE` checks alone are sufficient."
   - Incorrect: production prover artifacts must compile with `disable-dev-mode`; runtime checks are defense in depth, not the primary lockout.

6. "Pinning to any commit on `main` is sufficient for verifier dependencies."
   - Incorrect: official guidance is to use latest releases; pins must be to release tags/commits, not moving development branches.

7. "npm package-lock refresh is always required."
   - Incorrect: in current repo state, package-lock files are not tracked; refresh them only if lockfile policy changes and they become tracked.

8. "These files are not impacted by migration."
   - Incorrect: migration matrix must include `runtime/src/builder.ts`, `runtime/src/proof/index.ts`, `runtime/src/types/index.ts`, `mcp/src/tools/errors.ts`, and `sdk/src/__tests__/client.test.ts`.

9. "Generic skill-markdown parser fixtures do not need updates."
   - Incorrect: even non-security-critical fixtures must be updated under zero-legacy policy, because they are active workspace files and can reintroduce deprecated tooling language.

### 9.1 Review Checklist (Required Before Approving Plan Changes)

- [ ] No caller-provided selector reappears in on-chain instruction args, SDK payloads, or runtime submission APIs.
- [ ] On-chain checks pin trusted router program ID, trusted selector, and trusted verifier program ID.
- [ ] Replay policy remains explicit (section 2.4) and Phase 2 exit criteria include replay regression coverage.
- [ ] Strict repo-wide grep scope from section 6 is enforced with `--hidden`, including tests/docs/examples/skill fixtures/agent docs.
- [ ] Migration matrix still includes: `runtime/src/builder.ts`, `runtime/src/proof/index.ts`, `runtime/src/types/index.ts`, `mcp/src/tools/errors.ts`, `sdk/src/__tests__/client.test.ts`.
- [ ] Prover build config requires `disable-dev-mode`, and release-tag pinning is enforced for RISC Zero Solana dependencies.
- [ ] npm `package-lock.json` updates are only required if those lockfiles are tracked in git.
- [ ] Docs/diagram surfaces with legacy proof wording are included (including `docs/ROADMAP.md`, `docs/architecture.svg`, `docs/benchmark.svg`, and speculation sequence/swimlane diagrams).
- [ ] Resolved RISC0 crate versions are outside official advisory ranges (`risc0-zkvm < 2.3.2`, `r0vm < 2.3.1` rejected).

## 10. Official References (Normative)

- RISC Zero feature flag reference (`disable-dev-mode`) and production safety intent:
  - https://github.com/risc0/risc0/blob/main/README.md
  - https://docs.rs/risc0-zkvm/latest/risc0_zkvm/
- RISC0 dev-mode environment behavior and compile-time lockout interaction:
  - https://github.com/risc0/risc0/blob/main/risc0/zkvm/src/lib.rs
- RISC Zero Solana release and deployment guidance (`main` is development branch; use releases; use router integration):
  - https://github.com/boundless-xyz/risc0-solana
- RISC Zero deployment guidance (official verifier/router deployments where published):
  - https://dev.risczero.com/api/blockchain-integration/contracts/verifier
- Verifier Router `Seal` and Groth16 proof shape used for envelope constraints:
  - https://github.com/boundless-xyz/risc0-solana/blob/main/solana-verifier/programs/verifier_router/src/lib.rs
  - https://github.com/boundless-xyz/risc0-solana/blob/main/solana-verifier/programs/groth_16_verifier/src/lib.rs
  - https://github.com/boundless-xyz/risc0-solana/blob/main/solana-verifier/programs/verifier_router/src/client.rs
- Official vulnerability advisories for RISC0 dependencies:
  - https://github.com/advisories/GHSA-5qw5-8xrw-hjv8 (`risc0-zkvm`)
  - https://github.com/advisories/GHSA-h9x5-c9r9-ccf2 (`r0vm`)
