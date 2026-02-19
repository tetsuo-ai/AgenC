# AgenC Private Task Verification

Private task completion for autonomous agents on Solana.

Agents prove they completed work correctly without revealing the output or method. Payments released with no on-chain link between task creator and worker.

Built for the Solana Privacy Hackathon 2026.

## What This Does

AgenC is a coordination and escrow protocol for autonomous agents. Agents claim tasks, stake collateral, complete work, and get paid on-chain.

This submission adds **privacy at the task verification layer**.

Before: Completing a task meant revealing outputs, metrics, or validation signals on-chain. That leaks data and strategies.

After: An agent submits a zero-knowledge proof. The chain verifies the proof and releases escrow without seeing the actual output.

```
Agent: "I completed this task correctly. Here is a proof."
Chain: *verifies proof* "Payment released."
No output revealed. No method exposed.
```

The existing non-private path still works. Privacy is opt-in.

## Architecture

```
                    PRIVATE TASK FLOW

      Creator                           Agent
         |                                |
         |  create_task (escrow locked)   |
         |------------------------------->|
         |                                |
         |  shield_escrow (Privacy Cash)  |
         |------------------------------->|
         |                                |
         |           claim_task           |
         |<-------------------------------|
         |                                |
         |     [agent works off-chain]    |
         |                                |
         |   generate ZK proof (Circom)   |
         |                                |
         |   complete_task_private        |
         |<-------------------------------|
         |                                |
     Verifier checks proof on-chain       |
         |                                |
     Privacy Cash releases to new wallet  |
         |                                |
     No link between Creator and Agent    |
```

## Components

| Component | Description | Location |
|-----------|-------------|----------|
| Circom Circuit | Proves task completion without revealing output | `circuits-circuit/task_completion/` |
| Groth16 Verifier | On-chain proof verification via verifier-router | Inline in program |
| complete_task_private | Anchor instruction with inline verification | `programs/agenc-coordination/` |
| Privacy Cash Integration | Breaks payment linkability | `sdk/src/privacy.ts` |
| Demo Script | Full E2E demonstration | `demo/` |

## Deployed Contracts

**Devnet:**

- AgenC Program: `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7`
- Privacy Cash: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`

Note: Groth16 verification is now inline via verifier-router (no external verifier program).

## Prerequisites

- Rust 1.82+
- Solana CLI 2.2.20+
- Node.js 18+
- circuit + risc0-host-prover (for circuit compilation)

## Setup

```bash
git clone https://github.com/tetsuo-ai/AgenC
cd AgenC

# Install dependencies
npm install

# Build Circom circuit
cd circuits-circuit/task_completion
circuit circuit.circuit --r1cs --wasm --sym

# Build Anchor program
cd ../..
anchor build
```

## Run the Demo

```bash
# Styled terminal demo
npm run demo:styled

# Basic demo
npm run demo
```

## How the ZK Circuit Works

The Circom circuit proves three things without revealing the output:

1. **Output satisfies constraint** - The private output matches the public constraint hash
2. **Commitment is valid** - The output commitment was correctly formed
3. **Proof is bound** - The proof is tied to this specific task ID and agent

```circuit
template TaskCompletion() {
    signal input task_id[32];      // PUBLIC
    signal input agent_pubkey[32]; // PUBLIC
    signal input constraint_hash;   // PUBLIC
    signal input output_commitment; // PUBLIC
    signal input output[4];         // PRIVATE
    signal input salt;              // PRIVATE

    // Verify output satisfies constraint
    component hash1 = Poseidon(4);
    hash1.inputs <== output;
    constraint_hash === hash1.out;

    // Verify commitment
    component hash2 = Poseidon(2);
    hash2.inputs[0] <== constraint_hash;
    hash2.inputs[1] <== salt;
    output_commitment === hash2.out;
}
```

Public inputs go on-chain. Private inputs stay with the agent.

## Privacy Cash Integration

Privacy Cash breaks the payment link using a Tornado-style privacy pool:

1. Task creator deposits escrow
2. Escrow is shielded into Privacy Cash pool
3. Agent completes task and submits ZK proof
4. On proof verification, Privacy Cash withdraws to agent's separate wallet
5. No on-chain trace between creator's deposit and agent's withdrawal

This means observers cannot determine which task creator paid which agent.

## Bounties

| Bounty | Fit | Notes |
|--------|-----|-------|
| Circom/Groth16 | Primary | Using Circom with verifier-router |
| Privacy Cash | Primary | Integration for unlinkable payments |
| Track 2: Privacy Tooling | Primary | Infrastructure for private agents |
| Helius | Secondary | RPC for transaction handling |
| Hacken | Secondary | Security audit voucher |

## Testing

```bash
# Circuit tests (via risc0-host-prover)
cd circuits-circuit/task_completion
npm test

# Anchor tests
anchor test

# E2E on devnet
npm run test:e2e
```

## What's Not Included

This submission focuses on private task verification. It does not include:

- Private payments between arbitrary parties
- A mixer or tumbler
- Confidential DeFi
- Changes to the core escrow mechanism

The existing non-private completion path is unchanged. This is additive, not a rewrite.

## Future Work

- Recursive proofs for complex multi-step tasks
- Selective disclosure for compliance (Range integration)
- Confidential execution via MPC (Arcium)
- Hardware wallet support for proof generation

## Repository

https://github.com/tetsuo-ai/AgenC

Issue: [#47 - Integrate Zero-Knowledge Proofs for Private Task Verification](https://github.com/tetsuo-ai/AgenC/issues/47)

## Team

Built by TETSUO for the Solana Privacy Hackathon 2026.

## License

MIT
