#!/usr/bin/env bash
# Smoke test: verify all examples can be bundled by TypeScript tooling without execution.
set -euo pipefail

EXIT_CODE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { printf "  %bPASS%b: %s\n" "${GREEN}" "${NC}" "$1"; }
fail() { printf "  %bFAIL%b: %s\n" "${RED}" "${NC}" "$1"; EXIT_CODE=1; }

echo "=== Example Smoke Tests ==="

if [ ! -d "node_modules" ]; then
  echo "Installing root dependencies..."
  npm install --no-audit --no-fund
fi

if [ ! -d "sdk/dist" ] || [ ! -d "runtime/dist" ]; then
  echo "Building packages first..."
  npm run build
fi

for EXAMPLE_DIR in examples/*/; do
  EXAMPLE_NAME="$(basename "${EXAMPLE_DIR}")"
  ENTRY="${EXAMPLE_DIR}/index.ts"

  if [ ! -f "${ENTRY}" ]; then
    fail "${EXAMPLE_NAME}: missing index.ts"
    continue
  fi

  if [ -f "${EXAMPLE_DIR}/package.json" ] && [ ! -d "${EXAMPLE_DIR}/node_modules" ]; then
    echo "Installing ${EXAMPLE_NAME} dependencies..."
    npm install --no-audit --no-fund --no-package-lock --prefix "${EXAMPLE_DIR}"
  fi

  if ENTRY="${ENTRY}" node -e "
    const path = require('path');
    let esbuild;
    const candidates = [
      './node_modules/esbuild',
      './runtime/node_modules/esbuild',
      './sdk/node_modules/esbuild',
      './mcp/node_modules/esbuild',
    ];
    for (const candidate of candidates) {
      try {
        esbuild = require(candidate);
        break;
      } catch {}
    }
    if (!esbuild) {
      console.error('esbuild not found (install dependencies first)');
      process.exit(2);
    }
    const entry = path.resolve(process.env.ENTRY);
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    });
  " >/dev/null 2>&1; then
    pass "${EXAMPLE_NAME}: bundles"
  else
    fail "${EXAMPLE_NAME}: bundle failed"
  fi
done

echo ""
echo "--- Demo App ---"
if [ -f "demo-app/package.json" ]; then
  if [ ! -d "demo-app/node_modules" ]; then
    echo "Installing demo-app dependencies..."
    (cd demo-app && npm install --no-audit --no-fund)
  fi

  if (cd demo-app && npm run build >/dev/null 2>&1); then
    pass "demo-app: builds successfully"
  else
    fail "demo-app: build failed"
  fi
fi

echo ""
if [ "${EXIT_CODE}" -eq 0 ]; then
  printf "%bAll examples passed smoke test.%b\n" "${GREEN}" "${NC}"
else
  printf "%bSome examples failed. See above.%b\n" "${RED}" "${NC}"
fi

exit "${EXIT_CODE}"

