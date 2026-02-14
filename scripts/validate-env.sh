#!/usr/bin/env bash
# Validate required tools and versions for local development.
set -euo pipefail

EXIT_CODE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { printf "  %bPASS%b: %s\n" "${GREEN}" "${NC}" "$1"; }
fail() { printf "  %bFAIL%b: %s\n" "${RED}" "${NC}" "$1"; EXIT_CODE=1; }
warn() { printf "  %bWARN%b: %s\n" "${YELLOW}" "${NC}" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ANCHOR_TOML="${ROOT_DIR}/Anchor.toml"

EXPECTED_ANCHOR=""
EXPECTED_SOLANA=""

if [ -f "${ANCHOR_TOML}" ]; then
  EXPECTED_ANCHOR="$(awk -F'\"' '/anchor_version/ { print $2; exit }' "${ANCHOR_TOML}" 2>/dev/null || true)"
  EXPECTED_SOLANA="$(awk -F'\"' '/solana_version/ { print $2; exit }' "${ANCHOR_TOML}" 2>/dev/null || true)"
fi

echo "--- Environment Validation ---"

# Node.js >= 18
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(printf "%s" "${NODE_VERSION}" | cut -d. -f1)"
  if [ "${NODE_MAJOR}" -ge 18 ]; then
    pass "Node.js ${NODE_VERSION} (>= 18 required)"
  else
    fail "Node.js ${NODE_VERSION} (>= 18 required)"
  fi
else
  fail "Node.js not found"
fi

# npm
if command -v npm >/dev/null 2>&1; then
  pass "npm $(npm -v)"
else
  fail "npm not found"
fi

# Git
if command -v git >/dev/null 2>&1; then
  pass "Git $(git --version | awk '{print $3}')"
else
  fail "Git not found"
fi

# Rust (optional for TS-only development)
if command -v rustc >/dev/null 2>&1; then
  pass "Rust $(rustc --version | awk '{print $2}')"
else
  warn "Rust not found (required for Anchor program, optional for TS development)"
fi

# Solana CLI (optional)
if command -v solana >/dev/null 2>&1; then
  SOLANA_VERSION="$(solana --version | awk '{print $2}')"
  pass "Solana CLI ${SOLANA_VERSION}"
  if [ -n "${EXPECTED_SOLANA}" ] && [ "${SOLANA_VERSION}" != "${EXPECTED_SOLANA}" ]; then
    warn "Solana CLI ${SOLANA_VERSION} does not match Anchor.toml (${EXPECTED_SOLANA})"
  fi
else
  warn "Solana CLI not found (required for on-chain operations)"
fi

# Anchor CLI (optional)
if command -v anchor >/dev/null 2>&1; then
  ANCHOR_VERSION="$(anchor --version | awk '{print $2}')"
  pass "Anchor CLI ${ANCHOR_VERSION}"
  if [ -n "${EXPECTED_ANCHOR}" ] && [ "${ANCHOR_VERSION}" != "${EXPECTED_ANCHOR}" ]; then
    warn "Anchor CLI ${ANCHOR_VERSION} does not match Anchor.toml (${EXPECTED_ANCHOR})"
  fi
else
  warn "Anchor CLI not found (required for program builds)"
fi

echo ""
if [ "${EXIT_CODE}" -eq 0 ]; then
  printf "%bEnvironment validated successfully.%b\n" "${GREEN}" "${NC}"
else
  printf "%bEnvironment validation failed. Fix issues above before proceeding.%b\n" "${RED}" "${NC}"
fi

exit "${EXIT_CODE}"

