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
#   bash scripts/setup-verifier-localnet.sh --mode real
#   bash scripts/setup-verifier-localnet.sh --mode mock
#
# Prerequisites:
#   - solana CLI (v3.0.13+)
#   - anchor CLI (v0.32.1+)
#   - Built AgenC program (anchor build)
#   - Optional for real verifier mode: ${AGENC_RISC0_SOLANA_DIR:-/tmp/risc0-solana/solana-verifier}
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/setup-verifier-localnet.sh --mode real
  bash scripts/setup-verifier-localnet.sh --mode mock

Modes:
  real  Build and load the real Verifier Router + Groth16 verifier stack.
  mock  Load the explicit mock verifier/router test stack.
EOF
  return 0
}

RISC0_SOLANA_DIR="${AGENC_RISC0_SOLANA_DIR:-/tmp/risc0-solana/solana-verifier}"
AGENC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENC_SO_ROOT="${AGENC_DIR}/target/deploy/agenc_coordination.so"
AGENC_SO_PROGRAMS="${AGENC_DIR}/programs/agenc-coordination/target/deploy/agenc_coordination.so"
MOCK_ROUTER_SO="${AGENC_DIR}/tests/mock-router/target/deploy/mock_router.so"
MOCK_ACCOUNT_DIR="${AGENC_DIR}/target/verifier-bootstrap"
VERIFIER_ANCHOR_VERSION="${VERIFIER_ANCHOR_VERSION:-}"

ROUTER_PROGRAM_ID="E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ"
VERIFIER_PROGRAM_ID="3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc"
AGENC_PROGRAM_ID="6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab"

MODE="${AGENC_VERIFIER_MODE:-real}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ "$#" -lt 2 ]]; then
        echo "ERROR: --mode requires a value of 'real' or 'mock'." >&2
        usage
        exit 1
      fi
      MODE="$2"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "${MODE}" in
  real|mock)
    ;;
  *)
    echo "ERROR: Invalid mode '${MODE}'. Expected 'real' or 'mock'." >&2
    usage
    exit 1
    ;;
esac

get_anchor_cli_version() {
  anchor --version | awk '{print $2}'
  return 0
}

build_real_verifier_stack() {
  local original_anchor_version=""
  local current_anchor_version=""
  local build_status=0

  if [[ -n "${VERIFIER_ANCHOR_VERSION}" ]]; then
    if ! command -v avm >/dev/null 2>&1; then
      echo "ERROR: VERIFIER_ANCHOR_VERSION=${VERIFIER_ANCHOR_VERSION} requested but avm is not installed." >&2
      return 1
    fi

    original_anchor_version="$(get_anchor_cli_version)"
    if [[ "${original_anchor_version}" != "${VERIFIER_ANCHOR_VERSION}" ]]; then
      echo "Switching Anchor CLI from ${original_anchor_version} to ${VERIFIER_ANCHOR_VERSION} for verifier build..."
      avm use "${VERIFIER_ANCHOR_VERSION}"
    fi
  fi

  if (cd "${RISC0_SOLANA_DIR}" && INITIAL_OWNER="${DEPLOYER_PUBKEY}" anchor build); then
    build_status=0
  else
    build_status=$?
  fi

  if [[ -n "${original_anchor_version}" ]]; then
    current_anchor_version="$(get_anchor_cli_version)"
    if [[ "${current_anchor_version}" != "${original_anchor_version}" ]]; then
      echo "Restoring Anchor CLI ${original_anchor_version}..."
      avm use "${original_anchor_version}"
    fi
  fi

  return "${build_status}"
}

resolve_agenc_program_artifact() {
  local candidate=""

  for candidate in "${AGENC_SO_ROOT}" "${AGENC_SO_PROGRAMS}"; do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

# 1. Get deployer pubkey
DEPLOYER_PUBKEY=$(solana address)
echo "Deployer pubkey: ${DEPLOYER_PUBKEY}"

# 2. Compute verifier PDAs used by setup/testing.
ROUTER_PDA=$(node -e "
const { PublicKey } = require('@solana/web3.js');
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from('router')],
  new PublicKey('${ROUTER_PROGRAM_ID}')
);
console.log(pda.toBase58());
")
VERIFIER_ENTRY_PDA=$(node -e "
const { PublicKey } = require('@solana/web3.js');
const selector = Buffer.from([0x52, 0x5a, 0x56, 0x4d]); // RZVM
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from('verifier'), selector],
  new PublicKey('${ROUTER_PROGRAM_ID}')
);
console.log(pda.toBase58());
")
echo "Router PDA: ${ROUTER_PDA}"
echo "Verifier Entry PDA: ${VERIFIER_ENTRY_PDA}"

# 3. Load either the real verifier stack or an explicit mock stack.
AGENC_SO="$(resolve_agenc_program_artifact || true)"
ROUTER_SO="${RISC0_SOLANA_DIR}/target/deploy/verifier_router.so"
VERIFIER_SO="${RISC0_SOLANA_DIR}/target/deploy/groth_16_verifier.so"

if [[ "${MODE}" = "real" ]]; then
  if [[ ! -d "${RISC0_SOLANA_DIR}" ]]; then
    echo "ERROR: Real verifier repository not found at ${RISC0_SOLANA_DIR}." >&2
    echo "Run with '--mode mock' only if you explicitly want the mock verifier stack." >&2
    exit 1
  fi

  echo "Building Verifier Router with INITIAL_OWNER=${DEPLOYER_PUBKEY}..."
  if ! build_real_verifier_stack; then
    echo "ERROR: Failed to build the real verifier stack." >&2
    echo "Run with '--mode mock' only if you explicitly want the mock verifier stack." >&2
    exit 1
  fi

  if [[ ! -f "${ROUTER_SO}" || ! -f "${VERIFIER_SO}" ]]; then
    echo "ERROR: Real verifier artifacts are missing after build." >&2
    echo "Run with '--mode mock' only if you explicitly want the mock verifier stack." >&2
    exit 1
  fi
else
  echo "Using explicit mock verifier mode."
  if [[ ! -f "${MOCK_ROUTER_SO}" ]]; then
    echo "Building mock verifier router from source..."
    "${AGENC_DIR}/scripts/build-mock-verifier-router.sh" >/dev/null
  fi
  ROUTER_SO="${MOCK_ROUTER_SO}"
  VERIFIER_SO="${MOCK_ROUTER_SO}"
fi

if [[ -z "${AGENC_SO}" ]]; then
  echo "ERROR: Missing AgenC artifact. Checked:" >&2
  echo "  - ${AGENC_SO_ROOT}" >&2
  echo "  - ${AGENC_SO_PROGRAMS}" >&2
  exit 1
fi

for f in "${ROUTER_SO}" "${VERIFIER_SO}"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Missing artifact: $f" >&2
    exit 1
  fi
done

if [[ "${MODE}" = "mock" ]]; then
  mkdir -p "${MOCK_ACCOUNT_DIR}"
  export ROUTER_PDA
  export VERIFIER_ENTRY_PDA
  export ROUTER_PROGRAM_ID
  export VERIFIER_PROGRAM_ID
  export MOCK_ACCOUNT_DIR
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');

const outDir = process.env.MOCK_ACCOUNT_DIR;
const routerPda = process.env.ROUTER_PDA;
const verifierEntryPda = process.env.VERIFIER_ENTRY_PDA;
const routerProgramId = process.env.ROUTER_PROGRAM_ID;
const verifierProgramId = process.env.VERIFIER_PROGRAM_ID;

const writeAccount = (file, pubkey, owner, data) => {
  const payload = {
    pubkey,
    account: {
      lamports: 10_000_000,
      data: [data.toString('base64'), 'base64'],
      owner,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
};

// Router PDA account (data is not validated by AgenC, only owner/PDA address).
writeAccount(path.join(outDir, 'router-pda.json'), routerPda, routerProgramId, Buffer.alloc(0));

// VerifierEntry account layout expected by complete_task_private:
// [0..8] discriminator
// [8..12] selector "RZVM"
// [12..44] verifier program pubkey bytes
// [44] estopped flag = 0
const discriminator = Buffer.from([102, 247, 148, 158, 33, 153, 100, 93]);
const selector = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
const verifierPubkey = new PublicKey(verifierProgramId).toBuffer();
const estopped = Buffer.from([0]);
const verifierEntryData = Buffer.concat([discriminator, selector, verifierPubkey, estopped]);

writeAccount(
  path.join(outDir, 'verifier-entry.json'),
  verifierEntryPda,
  routerProgramId,
  verifierEntryData
);
NODE
fi

# 4. Start solana-test-validator with all three programs
#    AgenC must be --upgradeable-program (not --bpf-program) so the ProgramData
#    account exists — initialize_protocol checks it via remaining_accounts.
echo ""
echo "Starting solana-test-validator with:"
echo "  Mode:             ${MODE}"
echo "  AgenC:            ${AGENC_PROGRAM_ID} (upgrade authority = ${DEPLOYER_PUBKEY})"
echo "  Verifier Router:  ${ROUTER_PROGRAM_ID}"
if [[ "${MODE}" = "real" ]]; then
  echo "  Groth16 Verifier: ${VERIFIER_PROGRAM_ID} (upgrade authority = ${ROUTER_PDA})"
else
  echo "  Groth16 Verifier: ${VERIFIER_PROGRAM_ID} (mock BPF)"
  echo "  Preloaded mock accounts:"
  echo "    - ${MOCK_ACCOUNT_DIR}/router-pda.json"
  echo "    - ${MOCK_ACCOUNT_DIR}/verifier-entry.json"
fi
echo ""

if [ "${MODE}" = "real" ]; then
  exec solana-test-validator \
    --upgradeable-program "${AGENC_PROGRAM_ID}" "${AGENC_SO}" "${DEPLOYER_PUBKEY}" \
    --bpf-program "${ROUTER_PROGRAM_ID}" "${ROUTER_SO}" \
    --upgradeable-program "${VERIFIER_PROGRAM_ID}" "${VERIFIER_SO}" "${ROUTER_PDA}" \
    --reset
else
  exec solana-test-validator \
    --upgradeable-program "${AGENC_PROGRAM_ID}" "${AGENC_SO}" "${DEPLOYER_PUBKEY}" \
    --bpf-program "${ROUTER_PROGRAM_ID}" "${ROUTER_SO}" \
    --bpf-program "${VERIFIER_PROGRAM_ID}" "${VERIFIER_SO}" \
    --account "${ROUTER_PDA}" "${MOCK_ACCOUNT_DIR}/router-pda.json" \
    --account "${VERIFIER_ENTRY_PDA}" "${MOCK_ACCOUNT_DIR}/verifier-entry.json" \
    --reset
fi
