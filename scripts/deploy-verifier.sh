#!/bin/bash
# DEPRECATED: This script was used for deploying Sunspot verifier keys.
#
# The project has migrated to groth16-solana with inline verification.
# The verification key is now embedded directly in the program code
# (see: programs/agenc-coordination/src/verifying_key.rs)
#
# This script is kept for historical reference only.
#
# See Issue #158 for migration details.

echo "DEPRECATED: This script is no longer needed."
echo "groth16-solana verification key is embedded in the program."
echo "See: programs/agenc-coordination/src/verifying_key.rs"
exit 0

# --- Legacy code below ---

# Deploy Sunspot verifier keys to Solana (DEPRECATED)
#
# This script uploads the verification key to an on-chain account
# for use with the Sunspot verifier program.
#
# Prerequisites:
# - solana-cli configured for target cluster
# - sunspot installed
# - Verifier program deployed (8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CIRCUIT_DIR="$PROJECT_ROOT/circuits/task_completion"

# Verifier program ID (Sunspot on Solana)
VERIFIER_PROGRAM_ID="8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ"

echo "========================================"
echo "  AgenC Verifier Deployment"
echo "========================================"
echo

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v solana &> /dev/null; then
    echo "Error: solana-cli not found"
    echo "Install: https://docs.solana.com/cli/install-solana-cli-tools"
    exit 1
fi
echo "  solana-cli: $(solana --version)"

if ! command -v sunspot &> /dev/null; then
    echo "Error: sunspot not found"
    echo "See: circuits/README.md for installation"
    exit 1
fi
echo "  sunspot: installed"

# Check for verification key
VK_PATH="$CIRCUIT_DIR/target/task_completion.vk"
if [ ! -f "$VK_PATH" ]; then
    echo
    echo "Error: Verification key not found at $VK_PATH"
    echo
    echo "Generate it with:"
    echo "  cd $CIRCUIT_DIR"
    echo "  nargo compile"
    echo "  sunspot setup target/task_completion.ccs"
    exit 1
fi
echo "  verification key: found"

# Show current cluster
CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $3}')
echo
echo "Target cluster: $CLUSTER"
echo "Verifier program: $VERIFIER_PROGRAM_ID"
echo

# Check balance
BALANCE=$(solana balance | awk '{print $1}')
echo "Wallet balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 0.1" | bc -l) )); then
    echo
    echo "Warning: Low balance. You may need more SOL for deployment."
    echo "  solana airdrop 2  (for devnet/testnet)"
fi

echo
read -p "Deploy verification key to $CLUSTER? (y/n) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo
echo "Deploying verification key..."
echo

# Upload verification key using sunspot
# The exact command depends on how Sunspot handles key uploads
# This is a placeholder for the actual deployment command
cd "$CIRCUIT_DIR"

# Note: The actual deployment mechanism depends on Sunspot's implementation
# This might be:
# 1. A direct program instruction to store the VK
# 2. A separate deployment tool
# 3. Part of the verifier program initialization

echo "Verification key info:"
echo "  Size: $(wc -c < "$VK_PATH") bytes"
echo "  Path: $VK_PATH"

echo
echo "========================================"
echo "  Deployment Notes"
echo "========================================"
echo
echo "The Sunspot verifier program ($VERIFIER_PROGRAM_ID) is already"
echo "deployed on Solana. To use it:"
echo
echo "1. Your proof must be generated with matching proving key"
echo "2. Submit proofs via completeTaskPrivate instruction"
echo "3. The verifier CPI will validate the proof on-chain"
echo
echo "For full integration, see:"
echo "  sdk/src/tasks.ts - completeTaskPrivate function"
echo "  programs/agenc-coordination/src/instructions/complete_task_private.rs"
echo
