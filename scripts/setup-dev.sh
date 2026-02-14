#!/usr/bin/env bash
# One-command developer environment setup for AgenC.
# Usage: ./scripts/setup-dev.sh [--skip-tests] [--skip-fixtures]
set -euo pipefail

SKIP_TESTS=false
SKIP_FIXTURES=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-fixtures) SKIP_FIXTURES=true ;;
    -h|--help)
      echo "Usage: ./scripts/setup-dev.sh [--skip-tests] [--skip-fixtures]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

echo "=== AgenC Developer Setup ==="

echo "[1/7] Validating environment..."
"${ROOT_DIR}/scripts/validate-env.sh"

echo "[2/7] Installing dependencies..."
npm install --no-audit --no-fund
npm install --no-audit --no-fund --prefix sdk
npm install --no-audit --no-fund --prefix runtime
npm install --no-audit --no-fund --prefix mcp

echo "[3/7] Building Anchor program..."
if command -v anchor >/dev/null 2>&1; then
  anchor build
else
  echo "  SKIP: anchor CLI not found (Rust/Anchor optional for TS-only development)"
fi

echo "[4/7] Building all packages..."
npm run build

if [ "${SKIP_TESTS}" = false ]; then
  echo "[5/7] Running unit tests..."
  npm run test
else
  echo "[5/7] Skipping unit tests (--skip-tests)"
fi

if [ "${SKIP_TESTS}" = false ]; then
  echo "[6/7] Running integration tests (LiteSVM)..."
  npm run test:fast
else
  echo "[6/7] Skipping integration tests (--skip-tests)"
fi

if [ "${SKIP_FIXTURES}" = false ] && [ "${SKIP_TESTS}" = false ]; then
  echo "[7/7] Running replay fixture simulation..."
  npm run test:fixtures
else
  echo "[7/7] Skipping fixture simulation"
fi

echo ""
echo "=== Setup Complete ==="
echo "Quick commands:"
echo "  npm run build          # Rebuild all packages"
echo "  npm run test           # Run SDK + runtime tests"
echo "  npm run test:fast      # Run LiteSVM integration tests (~5s)"
echo "  npm run test:fixtures  # Run replay fixture simulation"
echo "  cd runtime && npm test # Run runtime tests (~1800+ tests)"
echo "  anchor build           # Build Solana program"

