#!/usr/bin/env bash
# Smoke test: verify retained public examples typecheck from the umbrella repo.
set -euo pipefail

EXIT_CODE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { printf "  %bPASS%b: %s\n" "${GREEN}" "${NC}" "$1"; }
fail() { printf "  %bFAIL%b: %s\n" "${RED}" "${NC}" "$1"; EXIT_CODE=1; }

echo "=== Public Example Checks ==="

if [ ! -d "node_modules" ]; then
  echo "Installing root dependencies..."
  npm install --no-fund
fi

for EXAMPLE in \
  "@tetsuo-ai/simple-usage" \
  "tetsuo-agenc-integration" \
  "agenc-helius-webhook" \
  "@tetsuo-ai/example-risc0-proof-demo"
do
  if npm run typecheck --workspace="${EXAMPLE}" >/dev/null 2>&1; then
    pass "${EXAMPLE}: typechecks"
  else
    fail "${EXAMPLE}: typecheck failed"
  fi
done

echo ""
if [ "${EXIT_CODE}" -eq 0 ]; then
  printf "%bAll retained public examples passed.%b\n" "${GREEN}" "${NC}"
else
  printf "%bSome retained public examples failed. See above.%b\n" "${RED}" "${NC}"
fi

exit "${EXIT_CODE}"
