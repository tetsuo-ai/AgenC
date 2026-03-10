# Solana Fender Medium Baseline

This document records the reviewed Solana Fender medium findings that are currently
classified as false positives for two scopes:

- `programs/agenc-coordination` (program-only scan)
- `.` (full-repo scan)

The machine-readable baselines are:

- `docs/security/fender-medium-baseline.json`
- `docs/security/fender-full-baseline.json`

Shared source of truth:

- `scripts/fender-baseline-shared.mjs`

The gate script is:

- `scripts/check-fender-baseline.mjs`
- `scripts/generate-fender-baselines.mjs`
- `npm run -s fender:baseline:generate`
- `npm run -s fender:gate:program`
- `npm run -s fender:gate:full`

## Program-Only Baseline (`programs/agenc-coordination`)

1. `src/instructions/cancel_task.rs` line 65 (`process_cancel_task_impl`)
- Finding: account reinitialization risk.
- Why false positive: no `init` / `init_if_needed` path is present in this function. It operates on pre-existing PDA-constrained accounts and closes claims explicitly.

2. `src/instructions/cancel_dispute.rs` line 44 (`handler`)
- Finding: account reinitialization risk.
- Why false positive: no account creation/reinitialization in the handler. Accounts are validated with PDA seeds and status constraints.

3. `src/instructions/complete_task_private.rs` lines 288/461 (`decode_private_completion_payload`, `build_router_verify_ix`)
- Finding: account reinitialization risk.
- Why false positive: helper extraction split validation/CPI-construction into additional pure functions, but none introduces `init_if_needed`/reinit behavior. Spend accounts still use one-time `init` seeds (`binding_spend`, `nullifier_spend`) for replay resistance, and mutable task/claim/escrow accounts remain PDA-constrained.

4. `src/instructions/complete_task_private.rs` lines 284/396/444 (CPI validation)
- Finding: arbitrary CPI without program-id validation.
- Why false positive: router CPI is pinned in three layers:
- account constraint `router_program` fixed to trusted id
- explicit runtime `require!` id checks
- `Instruction.program_id` fixed to trusted router id and checked against `router_program`
- strict instruction-shape/meta validation via `validate_router_verify_ix(...)` before `invoke`

5. `src/lib.rs` lines 302/321/442/463
- Finding: account reinitialization risk on `#[program]` entrypoint functions.
- Why false positive: these are thin wrappers delegating to instruction handlers; they do not perform account init/reinit themselves.

## Full-Repo Baseline (`.`)

1. Includes all eight program-only entries above with repository-root paths.

## Policy

- Baselines are strict:
- Any new medium/high/critical finding fails the gate.
- Any stale baseline entry also fails the gate (forces baseline cleanup).
