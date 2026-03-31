#!/bin/bash
# start-simulation.sh — Launch a complete Concordia simulation with AgenC agents.
#
# Usage: ./scripts/start-simulation.sh concordia_bridge.examples.medieval_town
#
# Prerequisites:
#   1. AgenC daemon must be running (agenc-runtime start)
#   2. Concordia bridge plugin must be enabled in daemon config
#   3. Python venv must be activated (source concordia_bridge/.venv/bin/activate)

set -euo pipefail

CONFIG="${1:-concordia_bridge.examples.medieval_town}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3200}"
STEPS="${STEPS:-}"

echo "=== AgenC x Concordia Simulation ==="
echo ""

# 1. Check AgenC daemon is running
echo "[1/4] Checking AgenC daemon..."
if ! agenc-runtime health &>/dev/null; then
    echo "  Starting AgenC daemon..."
    agenc-runtime start || {
        echo "  ERROR: Failed to start AgenC daemon"
        exit 1
    }
fi
echo "  Daemon is running."

# 2. Wait for bridge to be healthy
echo "[2/4] Checking Concordia bridge..."
for i in $(seq 1 10); do
    if curl -sf "$BRIDGE_URL/health" &>/dev/null; then
        echo "  Bridge is healthy."
        break
    fi
    if [ "$i" -eq 10 ]; then
        echo "  WARNING: Bridge not responding at $BRIDGE_URL — simulation may fail."
        echo "  Make sure the concordia channel is enabled in ~/.agenc/config.json"
    fi
    sleep 1
done

# 3. Run the simulation
echo "[3/4] Starting simulation with config: $CONFIG"
echo ""

EXTRA_ARGS=""
if [ -n "$STEPS" ]; then
    EXTRA_ARGS="--steps $STEPS"
fi

agenc-concordia run --config "$CONFIG" --bridge-url "$BRIDGE_URL" $EXTRA_ARGS

# 4. Done
echo ""
echo "[4/4] Simulation complete."
