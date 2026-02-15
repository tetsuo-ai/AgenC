#!/usr/bin/env bash
# Pre-deployment readiness check for mainnet (issues #356, #358, #170)
#
# This script validates that the build is safe for mainnet deployment.
# It should be run as part of CI and before any mainnet deployment.
#
# Usage:
#   ./scripts/check-deployment-readiness.sh [--network mainnet|devnet]

set -euo pipefail

NETWORK="${1:-devnet}"
EXIT_CODE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; EXIT_CODE=1; }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "=== AgenC Deployment Readiness Check ==="
echo "Network: $NETWORK"
echo ""

# 1. Verifying key security (issues #356, #358)
echo "--- Verifying Key Security ---"

VK_FILE="programs/agenc-coordination/src/verifying_key.rs"
if [ ! -f "$VK_FILE" ]; then
    fail "Verifying key file not found"
else
    # Check for is_development_key function
    if grep -q "is_development_key" "$VK_FILE"; then
        pass "Development key detection function present"
    else
        warn "is_development_key() function not found in verifying key"
    fi

    # Check gamma != delta
    GAMMA_LINE=$(grep -n "VK_GAMMA_G2" "$VK_FILE" | head -1 | cut -d: -f1)
    DELTA_LINE=$(grep -n "VK_DELTA_G2" "$VK_FILE" | head -1 | cut -d: -f1)

    if [ -n "$GAMMA_LINE" ] && [ -n "$DELTA_LINE" ]; then
        GAMMA_FIRST=$(sed -n "$((GAMMA_LINE+1))p" "$VK_FILE" | tr -d ' ')
        DELTA_FIRST=$(sed -n "$((DELTA_LINE+1))p" "$VK_FILE" | tr -d ' ')

        if [ "$GAMMA_FIRST" = "$DELTA_FIRST" ]; then
            if [ "$NETWORK" = "mainnet" ]; then
                fail "VK_GAMMA_G2 == VK_DELTA_G2: Single-party setup detected (CRITICAL for mainnet)"
            else
                warn "VK_GAMMA_G2 == VK_DELTA_G2: Development key (acceptable for $NETWORK)"
            fi
        else
            pass "VK_GAMMA_G2 != VK_DELTA_G2: MPC ceremony key detected"
        fi
    fi

    # Check VK_VERSION (fix #962)
    VK_VERSION=$(sed -n 's/.*pub const VK_VERSION.*= \([0-9][0-9]*\).*/\1/p' "$VK_FILE" | head -1 || echo "")
    if [ -n "$VK_VERSION" ]; then
        if [ "$VK_VERSION" = "0" ]; then
            if [ "$NETWORK" = "mainnet" ]; then
                fail "VK_VERSION is 0 (development key)"
            else
                warn "VK_VERSION is 0 (development key, acceptable for $NETWORK)"
            fi
        else
            pass "VK_VERSION is $VK_VERSION"
        fi
    fi

    # Check allow-dev-key not in default features (fix #962)
    CARGO_FILE="programs/agenc-coordination/Cargo.toml"
    if grep -q 'default.*allow-dev-key' "$CARGO_FILE" 2>/dev/null; then
        fail "'allow-dev-key' is in default Cargo features"
    else
        pass "'allow-dev-key' not in default features"
    fi
fi
echo ""

# 2. Nullifier protection
echo "--- Nullifier Protection ---"
PRIVATE_RS="programs/agenc-coordination/src/instructions/complete_task_private.rs"
if grep -q "nullifier_account" "$PRIVATE_RS"; then
    pass "Nullifier account present in CompleteTaskPrivate"
else
    fail "Missing nullifier protection"
fi

if grep -q "InvalidNullifier" "$PRIVATE_RS"; then
    pass "Zero-nullifier validation present"
else
    fail "Missing zero-nullifier check"
fi
echo ""

# 3. Defense-in-depth checks
echo "--- Defense-in-Depth ---"
if grep -q "InvalidProofBinding" "$PRIVATE_RS"; then
    pass "Proof binding validation present"
else
    fail "Missing proof binding check"
fi

if grep -q "InvalidOutputCommitment" "$PRIVATE_RS"; then
    pass "Output commitment validation present"
else
    fail "Missing output commitment check"
fi

if grep -q "ConstraintHashMismatch" "$PRIVATE_RS"; then
    pass "Constraint hash validation present"
else
    fail "Missing constraint hash check"
fi
echo ""

# 4. Rate limiting
echo "--- Rate Limiting ---"
if grep -rq "task_creation_cooldown" programs/agenc-coordination/src/; then
    pass "Task creation cooldown configured"
else
    warn "No task creation cooldown found"
fi
echo ""

# 5. Ceremony transcript (mainnet only)
echo "--- MPC Ceremony (mainnet requirement) ---"
CEREMONY_DIR="circuits-circom/task_completion/ceremony"
if [ "$NETWORK" = "mainnet" ]; then
    if [ -f "$CEREMONY_DIR/transcript.json" ]; then
        pass "Ceremony transcript found"
        node -e "
            const t = JSON.parse(require('fs').readFileSync('$CEREMONY_DIR/transcript.json', 'utf8'));
            if (t.contributions.length >= 3) {
                console.log('  PASS: ' + t.contributions.length + ' contributions (>= 3 required)');
            } else {
                console.log('  FAIL: Only ' + t.contributions.length + ' contributions (>= 3 required)');
                process.exit(1);
            }
            if (t.beaconApplied) {
                console.log('  PASS: Random beacon applied');
            } else {
                console.log('  FAIL: Random beacon not applied');
                process.exit(1);
            }
        " 2>/dev/null || fail "Ceremony transcript validation failed"
    else
        fail "No ceremony transcript found (required for mainnet)"
    fi
else
    warn "MPC ceremony check skipped for $NETWORK"
fi
echo ""

# Summary
echo "=== Summary ==="
if [ $EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}All checks passed for $NETWORK deployment.${NC}"
else
    echo -e "${RED}Some checks failed. Fix issues before $NETWORK deployment.${NC}"
fi

exit $EXIT_CODE
