# Solana Fender Medium Baseline

This document records the reviewed Solana Fender medium findings that are currently
classified as false positives for two scopes:

- `programs/agenc-coordination` (program-only scan)
- `.` (full-repo scan)

The machine-readable baselines are:

- `docs/security/fender-medium-baseline.json`
- `docs/security/fender-full-baseline.json`

The gate script is:

- `scripts/check-fender-baseline.mjs`
- `npm run -s fender:gate:program`
- `npm run -s fender:gate:full`

## Program-Only Baseline (`programs/agenc-coordination`)

1. `src/instructions/cancel_task.rs` line 65 (`process_cancel_task_impl`)
- Finding: account reinitialization risk.
- Why false positive: no `init` / `init_if_needed` path is present in this function. It operates on pre-existing PDA-constrained accounts and closes claims explicitly.

2. `src/instructions/cancel_dispute.rs` line 44 (`handler`)
- Finding: account reinitialization risk.
- Why false positive: no account creation/reinitialization in the handler. Accounts are validated with PDA seeds and status constraints.

3. `src/instructions/complete_task_private.rs` line 194 (`complete_task_private`)
- Finding: account reinitialization risk.
- Why false positive: spend accounts use `init` (not `init_if_needed`) and deterministic one-time seeds (`binding_spend`, `nullifier_spend`) to enforce replay resistance. Existing accounts are PDA-constrained.

4. `src/instructions/complete_task_private.rs` line 298 (CPI validation)
- Finding: arbitrary CPI without program-id validation.
- Why false positive: router CPI is pinned in three layers:
- account constraint `router_program` fixed to trusted id
- explicit runtime `require!` id checks
- `Instruction.program_id` fixed to trusted router id and checked against `router_program`

5. `src/lib.rs` lines 285/296/393/414
- Finding: account reinitialization risk on `#[program]` entrypoint functions.
- Why false positive: these are thin wrappers delegating to instruction handlers; they do not perform account init/reinit themselves.

## Full-Repo Baseline (`.`)

1. Includes all eight program-only entries above with repository-root paths, plus:
- `zkvm/methods/guest/src/main.rs` (`guest_entry`)
- Why false positive: this is a RISC Zero guest entrypoint that reads pre-committed guest inputs and commits a journal payload. It does not initialize or reinitialize Solana accounts.

## Policy

- Baselines are strict:
- Any new medium/high/critical finding fails the gate.
- Any stale baseline entry also fails the gate (forces baseline cleanup).
