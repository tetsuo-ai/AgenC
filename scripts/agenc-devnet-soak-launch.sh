#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${AGENC_DEVNET_SOAK_SESSION:-agenc-devnet-soak}"
STATE_DIR="${AGENC_DEVNET_SOAK_STATE_DIR:-$HOME/.agenc/devnet-soak/default}"
RPC_URL="${AGENC_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
KEYPAIR_PATH="${AGENC_DEVNET_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
WORKER_COUNT="${AGENC_DEVNET_SOAK_WORKERS:-4}"
REWARD_SOL="${AGENC_DEVNET_SOAK_REWARD_SOL:-0.05}"
INTERVAL_MS="${AGENC_DEVNET_SOAK_INTERVAL_MS:-15000}"
TASK_COUNT="${AGENC_DEVNET_SOAK_TASK_COUNT:-0}"
RUN_TOKEN="${AGENC_DEVNET_SOAK_RUN_TOKEN:-devnet-soak-$(date -u +%Y%m%d-%H%M%S)}"
PROGRAM_ID="${AGENC_DEVNET_PROGRAM_ID:-6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab}"
SCRIPT_PATH="$ROOT_DIR/scripts/agenc-devnet-soak.mjs"
LOG_WATCH_SCRIPT="$ROOT_DIR/scripts/agenc-devnet-log-watch.mjs"

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "Missing soak runner: $SCRIPT_PATH" >&2
  exit 1
fi

if [[ ! -f "$LOG_WATCH_SCRIPT" ]]; then
  echo "Missing log watcher: $LOG_WATCH_SCRIPT" >&2
  exit 1
fi

node "$SCRIPT_PATH" prepare \
  --rpc-url "$RPC_URL" \
  --keypair-path "$KEYPAIR_PATH" \
  --state-dir "$STATE_DIR" \
  --worker-count "$WORKER_COUNT" \
  --program-id "$PROGRAM_ID" \
  --reset-events

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -n CONTROL -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_1 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_2 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_3 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n AGENT_4 -c "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n WATCH -c "$ROOT_DIR"

controller_cmd="node \"$SCRIPT_PATH\" controller --rpc-url \"$RPC_URL\" --keypair-path \"$KEYPAIR_PATH\" --state-dir \"$STATE_DIR\" --worker-count \"$WORKER_COUNT\" --reward-sol \"$REWARD_SOL\" --interval-ms \"$INTERVAL_MS\" --count \"$TASK_COUNT\" --run-token \"$RUN_TOKEN\" --program-id \"$PROGRAM_ID\""
tmux send-keys -t "$SESSION_NAME:CONTROL" "$controller_cmd" C-m
tmux select-pane -t "$SESSION_NAME:CONTROL.0" -T CONTROL

for worker_index in 1 2 3 4; do
  if [[ "$worker_index" -gt "$WORKER_COUNT" ]]; then
    tmux send-keys -t "$SESSION_NAME:AGENT_$worker_index" "printf 'worker $worker_index disabled for this run\n'; exec zsh" C-m
  else
    worker_cmd="node \"$SCRIPT_PATH\" worker --worker-index \"$worker_index\" --rpc-url \"$RPC_URL\" --keypair-path \"$KEYPAIR_PATH\" --state-dir \"$STATE_DIR\" --worker-count \"$WORKER_COUNT\" --poll-ms 2000 --program-id \"$PROGRAM_ID\""
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
echo "State dir: $STATE_DIR"
echo "Run token: $RUN_TOKEN"
echo "Attach with: tmux attach -t $SESSION_NAME"
