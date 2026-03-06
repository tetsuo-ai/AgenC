#!/usr/bin/env bash
# Pre-deployment readiness check for mainnet (issues #356, #358, #170, #1385)
#
# This wrapper preserves the historical shell entrypoint while delegating the
# actual readiness logic to a testable Node module.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/check-deployment-readiness.mjs" "$@"
