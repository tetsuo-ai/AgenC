#!/usr/bin/env bash
# Validate verifying key security before deployment (issues #356, #358, #962)
#
# Checks:
# 1. VK_GAMMA_G2 != VK_DELTA_G2 (gamma and delta must differ)
# 2. VK_VERSION is non-zero for mainnet
# 3. VK_FINGERPRINT is not a placeholder for mainnet
# 4. allow-dev-key not in default features
#
# Usage:
#   ./scripts/validate-verifying-key.sh [--mainnet]
#
# The --mainnet flag makes all warnings hard errors (exit 1).
# Without it, dev-key issues produce warnings (for devnet/localnet).

set -euo pipefail

VK_FILE="programs/agenc-coordination/src/verifying_key.rs"
CARGO_FILE="programs/agenc-coordination/Cargo.toml"
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

echo "=== Verifying Key Security Check (issues #356, #358, #962) ==="
echo ""

# Check 1: gamma != delta
GAMMA_HEX=$(grep -A 8 "pub const VK_GAMMA_G2" "$VK_FILE" | grep -Eo '0x[0-9a-f]{2}' | tr -d '\n' | sed 's/0x//g')
DELTA_HEX=$(grep -A 8 "pub const VK_DELTA_G2" "$VK_FILE" | grep -Eo '0x[0-9a-f]{2}' | tr -d '\n' | sed 's/0x//g')

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
    fi
else
    echo "OK: VK_GAMMA_G2 != VK_DELTA_G2"
    echo "  Gamma and delta are distinct. Key appears to be from a proper ceremony."
    echo ""
fi

# Check 2: VK_VERSION
VK_VERSION=$(sed -n 's/.*pub const VK_VERSION.*= \([0-9][0-9]*\).*/\1/p' "$VK_FILE" | head -1)
echo "VK_VERSION: $VK_VERSION"
if [ "$VK_VERSION" = "0" ]; then
    if [ "$MAINNET_MODE" = true ]; then
        echo "ERROR: VK_VERSION is 0 (development). Must be >= 1 for mainnet."
        exit 1
    else
        echo "WARNING: VK_VERSION is 0 (development key)"
    fi
else
    echo "OK: VK_VERSION is $VK_VERSION (production key)"
fi

# Check 3: VK_FINGERPRINT is not all zeros
FINGERPRINT_ZEROS=$(grep -A 4 "pub const VK_FINGERPRINT" "$VK_FILE" | grep -c "0u8" || true)
if [ "$FINGERPRINT_ZEROS" -ge 1 ]; then
    if [ "$MAINNET_MODE" = true ]; then
        echo "ERROR: VK_FINGERPRINT is placeholder (all zeros). Must be set for mainnet."
        exit 1
    else
        echo "WARNING: VK_FINGERPRINT is placeholder (all zeros)"
    fi
else
    echo "OK: VK_FINGERPRINT is set"
fi

# Check 4: allow-dev-key not in default features
if grep -q 'default.*allow-dev-key' "$CARGO_FILE" 2>/dev/null; then
    echo "ERROR: 'allow-dev-key' is in default features. Remove before deployment."
    exit 1
else
    echo "OK: 'allow-dev-key' not in default features"
fi

# Check 5: IC array size matches PUBLIC_INPUTS_COUNT + 1
# Groth16 requires exactly (PUBLIC_INPUTS_COUNT + 1) IC points in the verifying key.
PIC=$(sed -n 's/.*pub const PUBLIC_INPUTS_COUNT.*= \([0-9][0-9]*\).*/\1/p' "$VK_FILE" | head -1)
EXPECTED_IC=$((PIC + 1))
# Count elements in VK_IC array (each IC point is a [u8; 64] line starting with spaces + '[')
IC_ACTUAL=$(sed -n '/pub const VK_IC/,/^];/p' "$VK_FILE" | grep -c '^\s*\[' || true)
echo "PUBLIC_INPUTS_COUNT: $PIC"
echo "Expected IC points:  $EXPECTED_IC"
echo "Actual IC points:    $IC_ACTUAL"
if [ "$IC_ACTUAL" -ne "$EXPECTED_IC" ] 2>/dev/null; then
    echo "WARNING: IC point count ($IC_ACTUAL) does not match PUBLIC_INPUTS_COUNT + 1 ($EXPECTED_IC)"
    if [ "$MAINNET_MODE" = true ]; then
        echo "ERROR: --mainnet flag is set. IC count mismatch is a hard error."
        exit 1
    fi
else
    echo "OK: IC count matches PUBLIC_INPUTS_COUNT + 1"
fi
echo ""
echo "=== All checks passed ==="
