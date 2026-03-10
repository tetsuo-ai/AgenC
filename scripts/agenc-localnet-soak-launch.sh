#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export PATH="$HOME/.cargo/bin:$DEFAULT_SOLANA_BIN:$HOME/.local/bin:$PATH"

SESSION_NAME="${AGENC_LOCALNET_SOAK_SESSION:-agenc-localnet-soak}"
STATE_DIR="${AGENC_LOCALNET_SOAK_STATE_DIR:-$HOME/.agenc/localnet-soak/default}"
RPC_URL="${AGENC_LOCALNET_RPC_URL:-http://127.0.0.1:8899}"
KEYPAIR_PATH="${AGENC_LOCALNET_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
WORKER_COUNT="${AGENC_LOCALNET_SOAK_WORKERS:-4}"
REWARD_SOL="${AGENC_LOCALNET_SOAK_REWARD_SOL:-0.05}"
INTERVAL_MS="${AGENC_LOCALNET_SOAK_INTERVAL_MS:-3000}"
TASK_COUNT="${AGENC_LOCALNET_SOAK_TASK_COUNT:-4}"
RUN_TOKEN="${AGENC_LOCALNET_SOAK_RUN_TOKEN:-localnet-soak-$(date -u +%Y%m%d-%H%M%S)}"
PROGRAM_ID="${AGENC_LOCALNET_PROGRAM_ID:-5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7}"
RISC0_REPO_ROOT="${AGENC_LOCALNET_RISC0_REPO_ROOT:-/tmp/agenc-risc0-solana}"
RISC0_SOLANA_REF="${AGENC_LOCALNET_RISC0_SOLANA_REF:-v3.0.0}"
RISC0_SOLANA_DIR="${AGENC_RISC0_SOLANA_DIR:-$RISC0_REPO_ROOT/solana-verifier}"
PROVER_ENDPOINT="${AGENC_LOCALNET_PROVER_ENDPOINT:-}"
PROVER_TIMEOUT_MS="${AGENC_LOCALNET_PROVER_TIMEOUT_MS:-600000}"
SCRIPT_PATH="$ROOT_DIR/scripts/agenc-devnet-soak.mjs"
LOG_WATCH_SCRIPT="$ROOT_DIR/scripts/agenc-devnet-log-watch.mjs"
VERIFIER_BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/setup-verifier-localnet.sh"
VERIFIER_INIT_SCRIPT="$ROOT_DIR/scripts/setup-verifier-localnet.ts"
VALIDATOR_LOG="$STATE_DIR/validator.log"

usage() {
  cat <<EOF
Usage:
  ./scripts/agenc-localnet-soak-launch.sh

Starts a fresh verifier-enabled localnet, prepares AgenC agents, and opens a tmux
session with one controller, four worker panes, validator logs, and on-chain logs.

Environment overrides:
  AGENC_LOCALNET_SOAK_SESSION
  AGENC_LOCALNET_SOAK_STATE_DIR
  AGENC_LOCALNET_RPC_URL
  AGENC_LOCALNET_KEYPAIR_PATH
  AGENC_LOCALNET_SOAK_WORKERS
  AGENC_LOCALNET_SOAK_REWARD_SOL
  AGENC_LOCALNET_SOAK_INTERVAL_MS
  AGENC_LOCALNET_SOAK_TASK_COUNT
  AGENC_LOCALNET_SOAK_RUN_TOKEN
  AGENC_LOCALNET_PROGRAM_ID
  AGENC_LOCALNET_RISC0_REPO_ROOT
  AGENC_LOCALNET_RISC0_SOLANA_REF
  AGENC_RISC0_SOLANA_DIR
  AGENC_LOCALNET_PROVER_ENDPOINT
  AGENC_LOCALNET_PROVER_TIMEOUT_MS
EOF
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

port_open() {
  local host="$1"
  local port="$2"
  (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

wait_for_validator() {
  local timeout_seconds="$1"
  local validator_pid="$2"

  for _ in $(seq 1 "$timeout_seconds"); do
    if solana -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$validator_pid" >/dev/null 2>&1; then
      echo "Verifier validator exited before becoming ready. See $VALIDATOR_LOG" >&2
      tail -n 120 "$VALIDATOR_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "Verifier validator did not become ready within ${timeout_seconds}s. See $VALIDATOR_LOG" >&2
  tail -n 120 "$VALIDATOR_LOG" >&2 || true
  exit 1
}

wait_for_program() {
  local program_id="$1"
  local label="$2"
  local timeout_seconds="$3"

  for _ in $(seq 1 "$timeout_seconds"); do
    if solana -u "$RPC_URL" program show "$program_id" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "$label program $program_id was not queryable within ${timeout_seconds}s" >&2
  return 1
}

ensure_verifier_repo() {
  if [[ -d "$RISC0_REPO_ROOT/.git" ]]; then
    git -C "$RISC0_REPO_ROOT" fetch --tags origin >/dev/null 2>&1 || true
    git -C "$RISC0_REPO_ROOT" checkout -q "$RISC0_SOLANA_REF"
  elif [[ -e "$RISC0_REPO_ROOT" ]]; then
    echo "Verifier repo path exists but is not a git checkout: $RISC0_REPO_ROOT" >&2
    exit 1
  else
    mkdir -p "$(dirname "$RISC0_REPO_ROOT")"
    git clone --depth 1 --branch "$RISC0_SOLANA_REF" \
      https://github.com/boundless-xyz/risc0-solana.git \
      "$RISC0_REPO_ROOT"
  fi

  if [[ ! -d "$RISC0_SOLANA_DIR" ]]; then
    echo "Verifier source directory not found: $RISC0_SOLANA_DIR" >&2
    exit 1
  fi
}

require_command solana
require_command solana-test-validator
require_command anchor
require_command tmux
require_command node
require_command docker
require_command git

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "Missing soak runner: $SCRIPT_PATH" >&2
  exit 1
fi

if [[ ! -f "$LOG_WATCH_SCRIPT" ]]; then
  echo "Missing log watcher: $LOG_WATCH_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$VERIFIER_BOOTSTRAP_SCRIPT" || ! -f "$VERIFIER_INIT_SCRIPT" ]]; then
  echo "Missing verifier bootstrap scripts under $ROOT_DIR/scripts" >&2
  exit 1
fi

if [[ ! -f "$KEYPAIR_PATH" ]]; then
  echo "Missing localnet operator keypair: $KEYPAIR_PATH" >&2
  exit 1
fi

if [[ -z "$PROVER_ENDPOINT" ]]; then
  echo "Missing AGENC_LOCALNET_PROVER_ENDPOINT for private-proof soak run." >&2
  exit 1
fi

ensure_verifier_repo

mkdir -p "$STATE_DIR"

export ANCHOR_PROVIDER_URL="$RPC_URL"
export ANCHOR_WALLET="$KEYPAIR_PATH"
export AGENC_RISC0_SOLANA_DIR="$RISC0_SOLANA_DIR"

echo "Building AgenC program..."
anchor build >/dev/null

if pgrep -af "solana-test-validator" >/dev/null 2>&1; then
  echo "Stopping existing solana-test-validator processes..."
  pkill -f "solana-test-validator" || true
  sleep 2
fi

: >"$VALIDATOR_LOG"
echo "Starting verifier-enabled local validator..."
nohup bash "$VERIFIER_BOOTSTRAP_SCRIPT" --mode real >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!
wait_for_validator 120 "$VALIDATOR_PID"
wait_for_program "$PROGRAM_ID" "AgenC" 30
wait_for_program "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7" "Verifier router" 30
wait_for_program "THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge" "Groth16 verifier" 30
sleep 5

echo "Initializing verifier router state..."
npx tsx "$VERIFIER_INIT_SCRIPT"

SOLANA_PUBKEY="$(solana address -k "$KEYPAIR_PATH")"
solana -u "$RPC_URL" airdrop 100 "$SOLANA_PUBKEY" >/dev/null 2>&1 || true

node "$SCRIPT_PATH" prepare \
  --rpc-url "$RPC_URL" \
  --keypair-path "$KEYPAIR_PATH" \
  --state-dir "$STATE_DIR" \
  --worker-count "$WORKER_COUNT" \
  --program-id "$PROGRAM_ID" \
  --proof-mode private \
  --prover-endpoint "$PROVER_ENDPOINT" \
  --prover-timeout-ms "$PROVER_TIMEOUT_MS" \
  --reset-events

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -n VALIDATOR -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n CONTROL -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_1 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_2 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_3 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_4 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n WATCH -c "$ROOT_DIR"

tmux set-environment -t "$SESSION_NAME" PATH "$PATH"
tmux set-environment -t "$SESSION_NAME" ANCHOR_PROVIDER_URL "$RPC_URL"
tmux set-environment -t "$SESSION_NAME" ANCHOR_WALLET "$KEYPAIR_PATH"
tmux set-environment -t "$SESSION_NAME" AGENC_RISC0_SOLANA_DIR "$RISC0_SOLANA_DIR"

tmux send-keys -t "$SESSION_NAME:VALIDATOR" "tail -F \"$VALIDATOR_LOG\"" C-m
tmux select-pane -t "$SESSION_NAME:VALIDATOR.0" -T VALIDATOR

controller_cmd="node \"$SCRIPT_PATH\" controller --rpc-url \"$RPC_URL\" --keypair-path \"$KEYPAIR_PATH\" --state-dir \"$STATE_DIR\" --worker-count \"$WORKER_COUNT\" --reward-sol \"$REWARD_SOL\" --interval-ms \"$INTERVAL_MS\" --count \"$TASK_COUNT\" --run-token \"$RUN_TOKEN\" --program-id \"$PROGRAM_ID\" --proof-mode private --prover-endpoint \"$PROVER_ENDPOINT\" --prover-timeout-ms \"$PROVER_TIMEOUT_MS\""
tmux send-keys -t "$SESSION_NAME:CONTROL" "$controller_cmd" C-m
tmux select-pane -t "$SESSION_NAME:CONTROL.0" -T CONTROL

for worker_index in 1 2 3 4; do
  if [[ "$worker_index" -gt "$WORKER_COUNT" ]]; then
    tmux send-keys -t "$SESSION_NAME:AGENT_$worker_index" "printf 'worker $worker_index disabled for this run\n'; exec zsh" C-m
  else
    worker_cmd="node \"$SCRIPT_PATH\" worker --worker-index \"$worker_index\" --rpc-url \"$RPC_URL\" --keypair-path \"$KEYPAIR_PATH\" --state-dir \"$STATE_DIR\" --worker-count \"$WORKER_COUNT\" --poll-ms 1500 --program-id \"$PROGRAM_ID\" --proof-mode private --prover-endpoint \"$PROVER_ENDPOINT\" --prover-timeout-ms \"$PROVER_TIMEOUT_MS\""
    tmux send-keys -t "$SESSION_NAME:AGENT_$worker_index" "$worker_cmd" C-m
  fi
  tmux select-pane -t "$SESSION_NAME:AGENT_$worker_index.0" -T "WORKER_$worker_index"
done

tmux split-window -h -t "$SESSION_NAME:WATCH" -c "$ROOT_DIR"
tmux select-layout -t "$SESSION_NAME:WATCH" even-horizontal >/dev/null
tmux send-keys -t "$SESSION_NAME:WATCH.0" "tail -F \"$STATE_DIR/events.ndjson\"" C-m
tmux send-keys -t "$SESSION_NAME:WATCH.1" "node \"$LOG_WATCH_SCRIPT\" --rpc-url \"$RPC_URL\" --program-id \"$PROGRAM_ID\"" C-m
tmux select-pane -t "$SESSION_NAME:WATCH.0" -T EVENTS
tmux select-pane -t "$SESSION_NAME:WATCH.1" -T CHAIN_LOGS

tmux select-window -t "$SESSION_NAME:CONTROL"
tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null

echo "Session $SESSION_NAME ready"
echo "RPC URL: $RPC_URL"
echo "State dir: $STATE_DIR"
echo "Run token: $RUN_TOKEN"
echo "Proof mode: private"
echo "Prover endpoint: $PROVER_ENDPOINT"
echo "Verifier repo: $RISC0_REPO_ROOT ($RISC0_SOLANA_REF)"
echo "Validator log: $VALIDATOR_LOG"
echo "Attach with: tmux attach -t $SESSION_NAME"
