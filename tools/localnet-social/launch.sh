#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/tools/localnet-social"
SESSION_NAME="${AGENC_SOCIAL_SESSION:-agenc-live}"
STATE_DIR="${AGENC_SOCIAL_STATE_DIR:-$HOME/.agenc/localnet-soak/default}"
RPC_URL="${AGENC_SOCIAL_RPC_URL:-http://127.0.0.1:8899}"
BASE_CONFIG="${AGENC_SOCIAL_BASE_CONFIG:-$HOME/.agenc/config.json}"
SUMMARY_PATH="${AGENC_SOCIAL_SUMMARY_PATH:-$STATE_DIR/social/summary.json}"
BOOTSTRAP_SCRIPT="$PACKAGE_DIR/bootstrap.ts"
READINESS_SCRIPT="$ROOT_DIR/scripts/agenc-social-readiness.mjs"
DAEMON_BIN="$ROOT_DIR/runtime/dist/bin/agenc-runtime.js"
WATCH_SCRIPT="$ROOT_DIR/scripts/agenc-watch.mjs"

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

tmux_has_window() {
  local target="$1"
  tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -Fxq "$target"
}

wait_for_agent_ready() {
  local label="$1"
  local gateway_port="$2"
  local messaging_port="$3"
  local log_path="$4"

  node "$READINESS_SCRIPT" wait \
    --label "$label" \
    --gateway-port "$gateway_port" \
    --messaging-port "$messaging_port" \
    --log-path "$log_path"
}

require_command tmux
require_command node
require_command npx

if [[ ! -f "$BOOTSTRAP_SCRIPT" ]]; then
  echo "Missing bootstrap script: $BOOTSTRAP_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$READINESS_SCRIPT" ]]; then
  echo "Missing readiness script: $READINESS_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$DAEMON_BIN" ]]; then
  echo "Missing daemon binary: $DAEMON_BIN" >&2
  exit 1
fi

if [[ ! -f "$WATCH_SCRIPT" ]]; then
  echo "Missing watch client: $WATCH_SCRIPT" >&2
  exit 1
fi

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session not found: $SESSION_NAME" >&2
  exit 1
fi

(
  cd "$ROOT_DIR"
  npx tsx "$BOOTSTRAP_SCRIPT" \
    --rpc-url "$RPC_URL" \
    --state-dir "$STATE_DIR" \
    --base-config "$BASE_CONFIG" \
    --summary-path "$SUMMARY_PATH" >/dev/null
)

if [[ ! -f "$SUMMARY_PATH" ]]; then
  echo "Bootstrap did not produce summary: $SUMMARY_PATH" >&2
  exit 1
fi

mapfile -t AGENT_ROWS < <(
  node - "$SUMMARY_PATH" <<'NODE'
const fs = require("fs");
const summaryPath = process.argv[2];
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
for (const agent of summary.agents) {
  process.stdout.write(
    [
      agent.index,
      agent.label,
      agent.gatewayPort,
      agent.messagingPort,
      agent.configPath,
      agent.daemonLogPath,
    ].join("\t") + "\n",
  );
}
NODE
)

if [[ "${#AGENT_ROWS[@]}" -ne 4 ]]; then
  echo "Expected 4 agents in summary, found ${#AGENT_ROWS[@]}" >&2
  exit 1
fi

if tmux_has_window "DAEMONS"; then
  tmux kill-window -t "$SESSION_NAME:DAEMONS"
fi
tmux new-window -t "$SESSION_NAME" -n DAEMONS
tmux split-window -t "$SESSION_NAME:DAEMONS.0" -h
tmux split-window -t "$SESSION_NAME:DAEMONS.0" -v
tmux split-window -t "$SESSION_NAME:DAEMONS.1" -v
tmux select-layout -t "$SESSION_NAME:DAEMONS" tiled

for row in "${AGENT_ROWS[@]}"; do
  IFS=$'\t' read -r index label gateway_port messaging_port config_path log_path <<<"$row"
  pane_index=$((index - 1))
  tmux select-pane -t "$SESSION_NAME:DAEMONS.$pane_index" -T "$(printf 'DAEMON_%s' "$index")"
  tmux send-keys -t "$SESSION_NAME:DAEMONS.$pane_index" C-c
  tmux send-keys -t "$SESSION_NAME:DAEMONS.$pane_index" \
    "cd '$ROOT_DIR' && : > '$log_path' && env \
AGENC_DAEMON_LOG_PATH='$log_path' \
node '$DAEMON_BIN' start --foreground --config '$config_path'" C-m
done

if tmux_has_window "LOGS"; then
  tmux kill-window -t "$SESSION_NAME:LOGS"
fi
tmux new-window -t "$SESSION_NAME" -n LOGS
tmux split-window -t "$SESSION_NAME:LOGS.0" -h
tmux split-window -t "$SESSION_NAME:LOGS.0" -v
tmux split-window -t "$SESSION_NAME:LOGS.1" -v
tmux select-layout -t "$SESSION_NAME:LOGS" tiled

for row in "${AGENT_ROWS[@]}"; do
  IFS=$'\t' read -r index label gateway_port messaging_port config_path log_path <<<"$row"
  pane_index=$((index - 1))
  tmux select-pane -t "$SESSION_NAME:LOGS.$pane_index" -T "$(printf 'AGENT_%s_LOG' "$index")"
  tmux send-keys -t "$SESSION_NAME:LOGS.$pane_index" C-c
  tmux send-keys -t "$SESSION_NAME:LOGS.$pane_index" \
    "touch '$log_path' && tail -n 200 -F '$log_path'" C-m
done

if ! tmux_has_window "LIVE"; then
  tmux new-window -t "$SESSION_NAME" -n LIVE
  tmux split-window -t "$SESSION_NAME:LIVE.0" -h
  tmux split-window -t "$SESSION_NAME:LIVE.0" -v
  tmux split-window -t "$SESSION_NAME:LIVE.1" -v
  tmux select-layout -t "$SESSION_NAME:LIVE" tiled
fi

for row in "${AGENT_ROWS[@]}"; do
  IFS=$'\t' read -r index label gateway_port messaging_port config_path log_path <<<"$row"
  pane_index=$((index - 1))
  watch_state="$STATE_DIR/social/watch-state-agent-${index}.json"
  tmux select-pane -t "$SESSION_NAME:LIVE.$pane_index" -T "$(printf 'AGENT_%s' "$index")"
  tmux send-keys -t "$SESSION_NAME:LIVE.$pane_index" C-c
  tmux send-keys -t "$SESSION_NAME:LIVE.$pane_index" \
    "cd '$ROOT_DIR' && env \
AGENC_WATCH_WS_URL='ws://127.0.0.1:${gateway_port}' \
AGENC_WATCH_CLIENT_KEY='agenc-live-agent-${index}' \
AGENC_WATCH_STATE_FILE='$watch_state' \
node '$WATCH_SCRIPT'" C-m
done

for row in "${AGENT_ROWS[@]}"; do
  IFS=$'\t' read -r index label gateway_port messaging_port config_path log_path <<<"$row"
  wait_for_agent_ready "$label" "$gateway_port" "$messaging_port" "$log_path"
done

tmux select-window -t "$SESSION_NAME:LIVE"
printf 'Launched 4 localnet social daemons in tmux session %s\n' "$SESSION_NAME"
