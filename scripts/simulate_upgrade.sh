#!/bin/bash
#
# simulate_upgrade.sh - Outline protocol upgrade steps for a given cluster
#
# Usage: ./scripts/simulate_upgrade.sh [devnet|testnet|localnet]
#
# This helper prints the commands to run manually. It does not execute them.

set -euo pipefail

CLUSTER="${1:-devnet}"
PROGRAM_ID="5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7"

echo "=== AgenC Protocol Upgrade Simulation (Manual) ==="
echo "Cluster: $CLUSTER"
echo "Program: $PROGRAM_ID"
echo ""

case "$CLUSTER" in
  devnet|testnet|localnet) ;;
  *)
    echo "Error: Unknown cluster '$CLUSTER'"
    echo "Use one of: devnet, testnet, localnet"
    exit 1
    ;;
esac

echo "1) Build the program"
echo "   anchor build"
echo ""

echo "2) Deploy or upgrade the program"
echo "   anchor upgrade target/deploy/agenc_coordination.so \\"
echo "     --program-id $PROGRAM_ID \\"
echo "     --provider.cluster $CLUSTER"
echo ""

echo "3) Run migration (TypeScript helper)"
echo "   yarn run migrate --cluster $CLUSTER --version <TARGET_VERSION>"
echo ""

echo "4) Verify protocol version"
echo "   yarn run check-version --cluster $CLUSTER"
echo ""

echo "5) Smoke test"
echo "   yarn run ts-mocha -p ./tsconfig.json -t 60000 tests/smoke.ts"
echo ""
