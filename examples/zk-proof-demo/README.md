# ZK Proof Demo

Demonstrates the full AgenC ZK proof generation flow using the SDK.

## Prerequisites

1. Install circom and snarkjs:
```bash
npm install -g circom snarkjs
```

2. Compile circuits and generate proving keys:
```bash
cd ../../circuits-circom/task_completion
circom circuit.circom --r1cs --wasm --sym
snarkjs groth16 setup circuit.r1cs pot_final.ptau circuit_0000.zkey
```

## Run

```bash
npm install
npm run demo
```

## What it does

1. Generates test data (task PDA, agent keypair, output, salt)
2. Computes Poseidon hashes (circomlib compatible)
3. Generates a Groth16 proof via snarkjs
4. Verifies the proof locally

The proof proves knowledge of an output satisfying a task constraint without revealing the output.

## Output

```
========================================
   AgenC ZK Proof Generation Demo
========================================

Checking prerequisites...
  snarkjs: installed

Generating test data...
  Task PDA: 7xKXtg2CW6...
  Agent: 9mVvBqPz...
  Output: [1, 2, 3, 4]
  Salt: 12345678901234567890...

Step 1: Computing hashes...
  Hashes computed successfully!
  Constraint hash: 0x1a2b3c4d...
  Output commitment: 0x5e6f7a8b...
  Time: 50 ms

Step 2: Generating ZK proof...
  Proof generated successfully!
  Proof size: 256 bytes
  Generation time: 2500 ms

Step 3: Verifying proof locally...
  Proof verified successfully!

========================================
   Demo Complete!
========================================
```
