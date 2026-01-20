# ZK Proof Demo

Demonstrates the full AgenC ZK proof generation flow using the SDK.

## Prerequisites

1. Install nargo:
```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup
```

2. Install sunspot (see `circuits/README.md` for details)

3. Compile circuits and generate proving keys:
```bash
cd ../../circuits/task_completion
nargo compile
sunspot setup target/task_completion.ccs

cd ../hash_helper
nargo compile
```

## Run

```bash
npm install
npm run demo
```

## What it does

1. Generates test data (task PDA, agent keypair, output, salt)
2. Computes Poseidon2 hashes via the hash_helper circuit
3. Generates a Groth16 proof via sunspot
4. Verifies the proof locally

The proof proves knowledge of an output satisfying a task constraint without revealing the output.

## Output

```
========================================
   AgenC ZK Proof Generation Demo
========================================

Checking prerequisites...
  nargo: installed
  sunspot: installed

Generating test data...
  Task PDA: 7xKXtg2CW6...
  Agent: 9mVvBqPz...
  Output: [1, 2, 3, 4]
  Salt: 12345678901234567890...

Step 1: Computing hashes via nargo...
  Hashes computed successfully!
  Constraint hash: 0x1a2b3c4d...
  Output commitment: 0x5e6f7a8b...
  Time: 1234 ms

Step 2: Generating ZK proof...
  Proof generated successfully!
  Proof size: 388 bytes
  Generation time: 45678 ms

Step 3: Verifying proof locally...
  Proof verified successfully!

========================================
   Demo Complete!
========================================
```
