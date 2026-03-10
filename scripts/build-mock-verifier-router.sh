#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${ROOT_DIR}/tests/mock-router/Cargo.toml"
OUT_DIR="${ROOT_DIR}/tests/mock-router/target/deploy"
ARTIFACT_PATH="${OUT_DIR}/mock_router.so"

mkdir -p "${OUT_DIR}"

cargo build-sbf \
  --manifest-path "${MANIFEST_PATH}" \
  --sbf-out-dir "${OUT_DIR}"

if [[ ! -f "${ARTIFACT_PATH}" ]]; then
  echo "ERROR: expected artifact at ${ARTIFACT_PATH}" >&2
  exit 1
fi

echo "${ARTIFACT_PATH}"
