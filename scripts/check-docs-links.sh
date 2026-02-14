#!/usr/bin/env bash
# Validate internal markdown links across the repo (issue #983).

set -euo pipefail

EXIT_CODE=0

fail() { echo "BROKEN LINK: $1"; EXIT_CODE=1; }

is_external_link() {
  local link="$1"
  case "$link" in
    http://*|https://*|mailto:*|agenc://*|data:* )
      return 0
      ;;
    *://* )
      return 0
      ;;
  esac
  return 1
}

extract_links() {
  local file="$1"
  # Match basic inline markdown links and images: [text](target) / ![alt](target)
  # Note: This is intentionally conservative; it catches the common cases we use in this repo.
  grep -oE '!?\\[[^]]*\\]\\([^)]*\\)' "$file" \
    | sed -E 's/^!?\\[[^]]*\\]\\(([^)]*)\\)$/\\1/' || true
}

while IFS= read -r -d '' FILE; do
  DIR="$(dirname "$FILE")"

  while IFS= read -r LINK; do
    # Trim whitespace.
    LINK="${LINK#"${LINK%%[![:space:]]*}"}"
    LINK="${LINK%"${LINK##*[![:space:]]}"}"
    if [ -z "$LINK" ]; then
      continue
    fi

    if is_external_link "$LINK"; then
      continue
    fi

    # Pure anchor links are always local to the file.
    if [[ "$LINK" == \#* ]]; then
      continue
    fi

    TARGET="${LINK%%#*}"
    if [ -z "$TARGET" ]; then
      continue
    fi

    # Ignore common non-filesystem targets.
    case "$TARGET" in
      \<* )
        continue
        ;;
    esac

    RESOLVED="$DIR/$TARGET"
    if [ ! -e "$RESOLVED" ]; then
      fail "$FILE -> $LINK (resolved: $RESOLVED)"
    fi
  done < <(extract_links "$FILE")
done < <(find docs sdk runtime mcp -name '*.md' -not -path '*/node_modules/*' -print0)

exit $EXIT_CODE

