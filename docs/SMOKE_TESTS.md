# Devnet Smoke Tests

## Overview

The Devnet smoke tests validate the end-to-end lifecycle of agents, tasks, escrow, and disputes against the deployed program. Tests are designed to confirm invariants and ensure instructions succeed under Devnet conditions.

The suite is implemented in `tests/smoke.ts` and is intended to be run against Devnet with an already-deployed program.

## Coverage Map

| Test Section | Protocol Feature | Expected Outcome |
| --- | --- | --- |
| Protocol Initialization | Global config creation | Protocol config PDA is created and initialized. |
| Agent Registration | Capability and stake setup | Agents register with expected capabilities. |
| Task Creation with Escrow | Task + escrow funding | Task PDA and escrow PDA are created with correct balances. |
| Task Claiming | Capability gating | Claims succeed for matching capabilities and fail for mismatches. |
| Task Completion | Reward distribution | Escrow pays out and completion state is recorded. |
| Task Cancellation Flow | Refund path | Unclaimed task cancellation returns escrowed funds. |
| Dispute Flow | Dispute lifecycle | Dispute initiates, votes are recorded, and resolution finalizes. |
| Agent Deregistration | Exit and stake return | Agent account closes and stake is returned. |
| Protocol Stats | Aggregate metrics | Config counters reflect on-chain state. |

## Expected Behavior and Failure Modes

- Funding failures: Devnet faucet can rate-limit airdrops (HTTP 429). Tests should retry with backoff before failing.
- PDA derivation: Incorrect seeds or program IDs cause "Account not found" or address mismatch errors.
- Capability checks: Mismatched capabilities should produce deterministic failures when claiming tasks.
- Dispute timing: Votes or resolutions outside the voting window should be rejected.

## Running the Suite

```bash
anchor test --provider.cluster devnet --skip-local-validator -- --grep "AgenC Devnet Smoke Tests"
```
