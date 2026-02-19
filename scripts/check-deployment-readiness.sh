#!/usr/bin/env bash
# Pre-deployment readiness check for mainnet (issues #356, #358, #170)
#
# This script validates that the build is safe for mainnet deployment.
# It should be run as part of CI and before any mainnet deployment.
#
# Usage:
#   ./scripts/check-deployment-readiness.sh --network mainnet|devnet
#   ./scripts/check-deployment-readiness.sh mainnet|devnet   (positional, backward compat)

set -euo pipefail

NETWORK="devnet"
while [ $# -gt 0 ]; do
    case "$1" in
        --network)
            shift
            NETWORK="${1:-devnet}"
            ;;
        mainnet|devnet|localnet)
            NETWORK="$1"
            ;;
    esac
    shift
done
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

# 1. Router verifier policy checks
echo "--- Router Verifier Policy ---"

ROUTER_FILE="programs/agenc-coordination/src/instructions/complete_task_private.rs"
if [ ! -f "$ROUTER_FILE" ]; then
    fail "Private completion handler not found"
else
    if grep -q "TRUSTED_RISC0_SELECTOR" "$ROUTER_FILE"; then
        pass "Trusted selector pinning present"
    else
        fail "Missing trusted selector pinning"
    fi

    if grep -q "TRUSTED_RISC0_IMAGE_ID" "$ROUTER_FILE"; then
        pass "Trusted image ID pinning present"
    else
        fail "Missing trusted image ID pinning"
    fi

    if grep -q "TRUSTED_RISC0_ROUTER_PROGRAM_ID" "$ROUTER_FILE" && grep -q "TRUSTED_RISC0_VERIFIER_PROGRAM_ID" "$ROUTER_FILE"; then
        pass "Trusted router and verifier program pinning present"
    else
        fail "Missing trusted router/verifier program pinning"
    fi

    if grep -q "binding_spend" "$ROUTER_FILE" && grep -q "nullifier_spend" "$ROUTER_FILE"; then
        pass "Dual spend replay checks present"
    else
        fail "Missing dual spend replay checks"
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

# 5. Proof policy evidence archive (mainnet only)
echo "--- Proof Policy Evidence (mainnet requirement) ---"
POLICY_DIR="artifacts/risc0/router-policy"
if [ "$NETWORK" = "mainnet" ]; then
    if [ -f "$POLICY_DIR/transcript.json" ]; then
        pass "Proof policy transcript found"
        node -e "
            const t = JSON.parse(require('fs').readFileSync('$POLICY_DIR/transcript.json', 'utf8'));
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
        " 2>/dev/null || fail "Proof policy transcript validation failed"
    else
        fail "No proof policy transcript found (required for mainnet)"
    fi
else
    warn "Proof policy transcript check skipped for $NETWORK"
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
