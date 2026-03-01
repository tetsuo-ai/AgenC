#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export ANCHOR_PROVIDER_URL ANCHOR_WALLET

LOCAL_RPC_REGEX='^http://(127\.0\.0\.1|localhost):[0-9]+/?$'
STARTED_VALIDATOR=0
VAL_PID=""

cleanup() {
  if [[ "$STARTED_VALIDATOR" == "1" && -n "$VAL_PID" ]]; then
    kill "$VAL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

port_open() {
  local host="$1"
  local port="$2"
  (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"

  for _ in $(seq 1 "$timeout_seconds"); do
    if port_open "$host" "$port"; then
      return 0
    fi
    sleep 1
  done

  return 1
}

run_anchor_bootstrap() {
  if [[ ! "$ANCHOR_PROVIDER_URL" =~ $LOCAL_RPC_REGEX ]]; then
    if [[ "${AGENC_MATRIX_ALLOW_REMOTE_DEPLOY:-0}" != "1" ]]; then
      cat >&2 <<MSG
Refusing automatic anchor deploy to non-local provider: $ANCHOR_PROVIDER_URL
Set AGENC_MATRIX_ALLOW_REMOTE_DEPLOY=1 to override.
MSG
      exit 1
    fi

    echo "Remote provider override enabled; proceeding with anchor build/deploy..."
  else
    local host_port="${ANCHOR_PROVIDER_URL#http://}"
    local host="${host_port%%:*}"
    local port="${host_port##*:}"
    port="${port%/}"

    if ! port_open "$host" "$port"; then
      require_cmd solana-test-validator
      echo "Starting local validator on $ANCHOR_PROVIDER_URL..."
      solana-test-validator --reset --quiet >/tmp/agenc-validator.log 2>&1 &
      VAL_PID="$!"
      STARTED_VALIDATOR=1

      if ! wait_for_port "$host" "$port" 60; then
        echo "Validator did not become ready within 60s. See /tmp/agenc-validator.log" >&2
        exit 1
      fi
    fi
  fi

  require_cmd anchor

  echo "Running anchor build/deploy bootstrap..."
  anchor build
  anchor deploy
}

echo "[phase01-matrix] ANCHOR_PROVIDER_URL=$ANCHOR_PROVIDER_URL"
echo "[phase01-matrix] ANCHOR_WALLET=$ANCHOR_WALLET"

npm run test:fast
npm run test --prefix runtime

run_anchor_bootstrap

npm run test:anchor:integration
npm run test:anchor:smoke

echo "[phase01-matrix] all stages passed"
