#!/usr/bin/env bash
#
# Start a solana-test-validator with the AgenC program, Verifier Router,
# and Groth16 Verifier pre-loaded for E2E ZK proof testing.
#
# The router's `initialize` instruction checks that authority == INITIAL_OWNER,
# which is baked in at compile time. We rebuild the router with the local
# deployer's pubkey so that the TS setup script can call `initialize`.
#
# The `add_verifier` instruction checks that the groth16 verifier's
# upgrade authority == router PDA. We use --upgradeable-program to set
# the verifier's upgrade authority to the router PDA directly.
#
# Usage:
#   bash scripts/setup-verifier-localnet.sh
#
# Prerequisites:
#   - solana CLI (v3.0.13+)
#   - anchor CLI (v0.32.1+)
#   - Built AgenC program (anchor build)
#   - /tmp/risc0-solana/solana-verifier cloned and built
#
set -euo pipefail

RISC0_SOLANA_DIR="/tmp/risc0-solana/solana-verifier"
AGENC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENC_SO="${AGENC_DIR}/target/deploy/agenc_coordination.so"

ROUTER_PROGRAM_ID="6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7"
VERIFIER_PROGRAM_ID="THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge"
AGENC_PROGRAM_ID="5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7"

# 1. Get deployer pubkey
DEPLOYER_PUBKEY=$(solana address)
echo "Deployer pubkey: ${DEPLOYER_PUBKEY}"

# 2. Rebuild router with INITIAL_OWNER = deployer pubkey
echo "Building Verifier Router with INITIAL_OWNER=${DEPLOYER_PUBKEY}..."
(cd "${RISC0_SOLANA_DIR}" && INITIAL_OWNER="${DEPLOYER_PUBKEY}" anchor build)
echo "Router build complete."

ROUTER_SO="${RISC0_SOLANA_DIR}/target/deploy/verifier_router.so"
VERIFIER_SO="${RISC0_SOLANA_DIR}/target/deploy/groth_16_verifier.so"

# Verify built artifacts exist
for f in "${AGENC_SO}" "${ROUTER_SO}" "${VERIFIER_SO}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Missing artifact: $f"
    exit 1
  fi
done

# 3. Compute router PDA (seeds=["router"], program=ROUTER_PROGRAM_ID)
#    The TS setup script needs this, but we also need it for --upgradeable-program.
#    We derive it using a small inline node script.
ROUTER_PDA=$(node -e "
  const { PublicKey } = require('@solana/web3.js');
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('router')],
    new PublicKey('${ROUTER_PROGRAM_ID}')
  );
  console.log(pda.toBase58());
")
echo "Router PDA: ${ROUTER_PDA}"

# 4. Start solana-test-validator with all three programs
#    AgenC must be --upgradeable-program (not --bpf-program) so the ProgramData
#    account exists — initialize_protocol checks it via remaining_accounts.
echo ""
echo "Starting solana-test-validator with:"
echo "  AgenC:            ${AGENC_PROGRAM_ID} (upgrade authority = ${DEPLOYER_PUBKEY})"
echo "  Verifier Router:  ${ROUTER_PROGRAM_ID}"
echo "  Groth16 Verifier: ${VERIFIER_PROGRAM_ID} (upgrade authority = ${ROUTER_PDA})"
echo ""

exec solana-test-validator \
  --upgradeable-program "${AGENC_PROGRAM_ID}" "${AGENC_SO}" "${DEPLOYER_PUBKEY}" \
  --bpf-program "${ROUTER_PROGRAM_ID}" "${ROUTER_SO}" \
  --upgradeable-program "${VERIFIER_PROGRAM_ID}" "${VERIFIER_SO}" "${ROUTER_PDA}" \
  --reset
