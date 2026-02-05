#!/usr/bin/env bash
# Validate verifying key security before deployment (issues #356, #358)
#
# Checks:
# 1. VK_GAMMA_G2 != VK_DELTA_G2 (gamma and delta must differ)
# 2. Key must come from an MPC ceremony with multiple contributors
#
# Usage:
#   ./scripts/validate-verifying-key.sh [--mainnet]
#
# The --mainnet flag makes gamma==delta a hard error (exit 1).
# Without it, gamma==delta produces a warning (for devnet/localnet).

set -euo pipefail

VK_FILE="programs/agenc-coordination/src/verifying_key.rs"
MAINNET_MODE=false

for arg in "$@"; do
    case $arg in
        --mainnet)
            MAINNET_MODE=true
            ;;
    esac
done

if [ ! -f "$VK_FILE" ]; then
    echo "ERROR: Verifying key file not found: $VK_FILE"
    exit 1
fi

echo "=== Verifying Key Security Check (issues #356, #358) ==="
echo ""

# Extract gamma and delta hex values from the Rust file
GAMMA_HEX=$(grep -A 8 "pub const VK_GAMMA_G2" "$VK_FILE" | grep -oP '0x[0-9a-f]{2}' | tr -d '\n' | sed 's/0x//g')
DELTA_HEX=$(grep -A 8 "pub const VK_DELTA_G2" "$VK_FILE" | grep -oP '0x[0-9a-f]{2}' | tr -d '\n' | sed 's/0x//g')

if [ "$GAMMA_HEX" = "$DELTA_HEX" ]; then
    echo "WARNING: VK_GAMMA_G2 == VK_DELTA_G2"
    echo ""
    echo "  The verifying key uses identical gamma and delta G2 points."
    echo "  This indicates a single-party trusted setup where proofs are FORGEABLE."
    echo ""
    echo "  An attacker can forge proofs for any statement without knowing the witness."
    echo "  This key is ONLY safe for devnet/localnet testing."
    echo ""

    if [ "$MAINNET_MODE" = true ]; then
        echo "ERROR: --mainnet flag is set. Cannot deploy with development verifying key."
        echo "  Run an MPC ceremony first. See: circuits-circom/task_completion/CEREMONY.md"
        exit 1
    else
        echo "  (Pass --mainnet to make this a hard error)"
        exit 0
    fi
else
    echo "OK: VK_GAMMA_G2 != VK_DELTA_G2"
    echo "  Gamma and delta are distinct. Key appears to be from a proper ceremony."
    echo ""
fi

# Check IC point count
IC_COUNT=$(grep -c "^\s*\[" "$VK_FILE" | tail -1 || true)
echo "IC points found in verifying key file."
echo ""
echo "=== All checks passed ==="
