#!/bin/bash
# AgenC ZK Circuit Demo
# Demonstrates the full proof generation and verification flow

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_CIRCUIT="$SCRIPT_DIR/task_completion"
HASH_HELPER="$SCRIPT_DIR/hash_helper"
SUNSPOT="$HOME/sunspot/go/sunspot"

echo "========================================"
echo "AgenC ZK Circuit Demo"
echo "========================================"
echo ""

# Check prerequisites
echo "[1/7] Checking prerequisites..."
if ! command -v nargo &> /dev/null; then
    echo "Error: nargo not found. Install with: noirup -v 1.0.0-beta.13"
    exit 1
fi
if [ ! -f "$SUNSPOT" ]; then
    echo "Error: sunspot not found at $SUNSPOT"
    exit 1
fi
echo "  nargo: $(nargo --version | head -1)"
echo "  sunspot: found at $SUNSPOT"
echo ""

# Compile circuits
echo "[2/7] Compiling circuits..."
cd "$TASK_CIRCUIT"
nargo compile
cd "$HASH_HELPER"
nargo compile
echo "  task_completion: compiled"
echo "  hash_helper: compiled"
echo ""

# Run circuit tests
echo "[3/7] Running circuit tests..."
cd "$TASK_CIRCUIT"
nargo test
cd "$HASH_HELPER"
nargo test
echo ""

# Generate Sunspot artifacts
echo "[4/7] Generating Sunspot artifacts..."
cd "$TASK_CIRCUIT"
$SUNSPOT compile target/task_completion.json
$SUNSPOT setup target/task_completion.ccs
echo ""

# Generate witness using example inputs
echo "[5/7] Generating witness..."
cd "$TASK_CIRCUIT"
nargo execute
echo ""

# Generate Groth16 proof
echo "[6/7] Generating Groth16 proof..."
cd "$TASK_CIRCUIT"
$SUNSPOT prove \
    target/task_completion.json \
    target/task_completion.gz \
    target/task_completion.ccs \
    target/task_completion.pk
echo ""

# Verify proof
echo "[7/7] Verifying proof..."
cd "$TASK_CIRCUIT"
$SUNSPOT verify \
    target/task_completion.vk \
    target/task_completion.proof \
    target/task_completion.pw
echo ""

# Summary
PROOF_SIZE=$(stat -c%s target/task_completion.proof 2>/dev/null || stat -f%z target/task_completion.proof)
echo "========================================"
echo "Demo Complete!"
echo "========================================"
echo ""
echo "Generated artifacts:"
echo "  Proof:          target/task_completion.proof ($PROOF_SIZE bytes)"
echo "  Public witness: target/task_completion.pw"
echo "  Verifying key:  target/task_completion.vk"
echo ""
echo "The proof can be verified on Solana using the Sunspot verifier"
echo "program at: 8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ"
