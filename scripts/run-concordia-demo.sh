#!/bin/bash
# run-concordia-demo.sh — Run a Concordia simulation demo.
#
# This runs a standalone demo that doesn't require the full daemon pipeline.
# The bridge uses a simple mock LLM that returns canned responses.
#
# Usage: ./scripts/run-concordia-demo.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VENV="$ROOT_DIR/concordia_bridge/.venv"

if [ ! -d "$VENV" ]; then
    echo "ERROR: Python venv not found at $VENV"
    echo "Run: python3 -m venv concordia_bridge/.venv && source concordia_bridge/.venv/bin/activate && pip install gdm-concordia requests websockets"
    exit 1
fi

echo "=== AgenC x Concordia Demo ==="
echo ""
echo "This runs a standalone simulation using a mock bridge."
echo "Watch the event stream for real-time agent interactions."
echo ""

# Run the demo script
exec "$VENV/bin/python" "$ROOT_DIR/concordia_bridge/demo.py" "$@"
