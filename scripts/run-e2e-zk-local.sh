#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-${HOME}/.config/solana/id.json}"

VALIDATOR_LOG="${ROOT_DIR}/target/verifier-validator.log"
VALIDATOR_READY_TIMEOUT_SECONDS="${VALIDATOR_READY_TIMEOUT_SECONDS:-300}"

if pgrep -af "solana-test-validator" >/dev/null 2>&1; then
  echo "Stopping existing solana-test-validator processes..."
  pkill -f "solana-test-validator" || true
  sleep 2
fi

echo "Starting verifier-enabled local validator..."
nohup bash "${ROOT_DIR}/scripts/setup-verifier-localnet.sh" --mode real >"${VALIDATOR_LOG}" 2>&1 &
VALIDATOR_PID=$!
disown || true
echo "Validator PID: ${VALIDATOR_PID}"
echo "Validator log: ${VALIDATOR_LOG}"
echo "Waiting up to ${VALIDATOR_READY_TIMEOUT_SECONDS}s for validator readiness..."

READY=0
for _ in $(seq 1 "${VALIDATOR_READY_TIMEOUT_SECONDS}"); do
  if solana -u "${ANCHOR_PROVIDER_URL}" cluster-version >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "${VALIDATOR_PID}" >/dev/null 2>&1; then
    echo "ERROR: verifier validator exited before becoming ready." >&2
    tail -n 120 "${VALIDATOR_LOG}" || true
    exit 1
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "ERROR: validator did not become ready in time." >&2
  tail -n 120 "${VALIDATOR_LOG}" || true
  exit 1
fi

npx tsx scripts/setup-verifier-localnet.ts
npx ts-mocha -p ./tsconfig.json -t 60000 tests/e2e-real-proof.ts
