#!/usr/bin/env bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"

DESKTOP="$HOME/Desktop/AgenC.desktop"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Name=AgenC
Comment=Launch AgenC runtime
Exec=bash $ROOT/start-agenc.sh
Icon=$ROOT/moon.png
Terminal=true
Type=Application
EOF

chmod +x "$DESKTOP"

echo "?? AgenC desktop launcher installed"
