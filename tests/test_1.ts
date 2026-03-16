/**
 * Main integration test suite — now a thin barrel that re-exports domain test files.
 *
 * The original monolithic test_1.ts (11,527 lines, 140 tests) has been split into
 * focused domain files, each independently runnable via ts-mocha:
 *
 *   test-create-task.ts      — create_task happy paths and rejection cases
 *   test-claim-task.ts       — claim_task happy paths and rejection cases
 *   test-lifecycle.ts        — Lifecycle, adversarial, and design-bounded invariants
 *   test-state-machine.ts    — Issue #19: Task lifecycle state machine
 *   test-authority.ts        — Issue #20: Authority and PDA validation
 *   test-audit-gaps.ts       — Issues #3 & #4: Audit gap filling
 *   test-escrow.ts           — Issue #21: Escrow fund safety and lamport accounting
 *   test-disputes.ts         — Issues #22 & #23: Dispute initiation, voting, resolution
 *   test-reputation-stake.ts — Issue #24: Reputation and stake safety
 *   test-concurrency.ts      — Issue #25: Concurrency and race condition simulation
 *   test-invariants.ts       — Issue #26: Instruction fuzzing and invariant validation
 *   test-reputation-gate.ts  — Reputation system gate tests
 *
 * To run all tests: npm run test:fast
 * To run a single domain: npx ts-mocha -p ./tsconfig.json -t 300000 tests/test-create-task.ts
 */
