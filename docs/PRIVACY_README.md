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
         |    generate ZK proof (Noir)    |
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
| Noir Circuit | Proves task completion without revealing output | `circuits/task_completion/` |
| Groth16 Verifier | On-chain proof verification via Sunspot | Deployed to devnet |
| complete_task_private | New Anchor instruction with CPI to verifier | `programs/agenc-coordination/` |
| Privacy Cash Integration | Breaks payment linkability | `sdk/src/privacy.ts` |
| Demo Script | Full E2E demonstration | `demo/` |

## Deployed Contracts

**Devnet:**

- Groth16 Verifier: `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ`
- AgenC Program: [existing program ID]
- Privacy Cash: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`

## Prerequisites

- Rust 1.82+
- Solana CLI 2.2.20+
- Node.js 18+
- Noir 1.0.0-beta.13
- Sunspot CLI

## Setup

```bash
git clone https://github.com/tetsuo-ai/AgenC
cd AgenC

# Install dependencies
npm install

# Build Noir circuit
cd circuits/task_completion
nargo compile
nargo test

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

The Noir circuit proves three things without revealing the output:

1. **Output satisfies constraint** - The private output matches the public constraint hash
2. **Commitment is valid** - The output commitment was correctly formed
3. **Proof is bound** - The proof is tied to this specific task ID and agent

```noir
fn main(
    task_id: pub Field,
    agent_pubkey: pub [u8; 32],
    constraint_hash: pub Field,
    output_commitment: pub Field,
    output: [Field; 4],        // PRIVATE
    salt: Field,               // PRIVATE
) {
    // Verify output satisfies constraint
    let computed = pedersen_hash(output);
    assert(computed == constraint_hash);
    
    // Verify commitment
    let commitment_preimage = [output[0], output[1], output[2], output[3], salt];
    let computed_commitment = pedersen_hash(commitment_preimage);
    assert(computed_commitment == output_commitment);
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
| Aztec Noir | Primary | Using Noir directly for ZK circuit |
| Privacy Cash | Primary | Integration for unlinkable payments |
| Track 2: Privacy Tooling | Primary | Infrastructure for private agents |
| Helius | Secondary | RPC for transaction handling |
| Hacken | Secondary | Security audit voucher |

## Testing

```bash
# Circuit tests
cd circuits/task_completion
nargo test

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
