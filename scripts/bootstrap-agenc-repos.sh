#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap-agenc-repos.sh [--root <dir>] [--private]

Clones or fast-forwards the AgenC repository set into a common parent
directory.

Options:
  --root <dir>  Destination parent directory. Defaults to the parent of the
                current AgenC checkout.
  --private     Include private repositories (`agenc-core`, `agenc-prover`).
  --help        Show this help text.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
TARGET_ROOT="$DEFAULT_ROOT"
INCLUDE_PRIVATE=0
ORG_URL_BASE="${AGENC_GIT_BASE:-https://github.com/tetsuo-ai}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      TARGET_ROOT="$2"
      shift 2
      ;;
    --private)
      INCLUDE_PRIVATE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

PUBLIC_REPOS=(
  "AgenC"
  "agenc-sdk"
  "agenc-protocol"
  "agenc-plugin-kit"
)

PRIVATE_REPOS=(
  "agenc-core"
  "agenc-prover"
)

mkdir -p "$TARGET_ROOT"

sync_repo() {
  local name="$1"
  local url="${ORG_URL_BASE}/${name}.git"
  local dest="${TARGET_ROOT}/${name}"

  if [[ -d "${dest}/.git" ]]; then
    echo "[bootstrap] updating ${name}"
    git -C "$dest" fetch --all --prune
    git -C "$dest" pull --ff-only
    return
  fi

  if [[ -e "$dest" ]]; then
    echo "[bootstrap] refusing to clone ${name}: ${dest} exists but is not a git repo" >&2
    exit 1
  fi

  echo "[bootstrap] cloning ${name}"
  git clone "$url" "$dest"
}

for repo in "${PUBLIC_REPOS[@]}"; do
  sync_repo "$repo"
done

if [[ "$INCLUDE_PRIVATE" -eq 1 ]]; then
  for repo in "${PRIVATE_REPOS[@]}"; do
    sync_repo "$repo"
  done
fi

echo
echo "[bootstrap] complete:"
for repo in "${PUBLIC_REPOS[@]}"; do
  echo "  - ${TARGET_ROOT}/${repo}"
done
if [[ "$INCLUDE_PRIVATE" -eq 1 ]]; then
  for repo in "${PRIVATE_REPOS[@]}"; do
    echo "  - ${TARGET_ROOT}/${repo}"
  done
fi
