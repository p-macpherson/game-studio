#!/usr/bin/env bash
# Sets up the stable Game Studio for this user: the launcher and updater in ~/.local/share/game-studio/bin, the icon,
# a "Game Studio" menu entry, then installs the latest pushed version. Run once from a checkout: install/install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${GAME_STUDIO_HOME:-$HOME/.local/share/game-studio}"
mkdir -p "$BASE/bin" "$HOME/.local/share/applications"
install -m 755 "$HERE/game-studio" "$HERE/game-studio-update" "$BASE/bin/"
install -m 644 "$HERE/icon.svg" "$BASE/icon.svg"
cat >"$HOME/.local/share/applications/game-studio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Game Studio
Comment=Agent-driven game development
Exec=$BASE/bin/game-studio
Icon=$BASE/icon.svg
Terminal=false
Categories=Development;IDE;
StartupWMClass=game-studio
EOF
"$BASE/bin/game-studio-update"
