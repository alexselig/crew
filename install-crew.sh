#!/bin/bash
# Install the freshly-built Crew from dist/ into /Applications and relaunch.
#
# RUN THIS FROM Terminal.app / iTerm — NOT from a shell inside Crew, because it
# quits Crew (which would kill any agent session running inside it).
#
#   bash install-crew.sh        # from the repo root, after building
#
# Build first with:  npm run build && npx electron-builder --mac --dir
#
# After relaunch: autopilot is runtime-only, so toggle a Copilot session into
# autopilot (Shift+Tab) to see the plane badge; use File > Change Workspace to
# switch workspaces; click the grid button to cycle 2/4/6-pane layouts.

set -u
# Resolve the repo dir from this script's location so it works on any machine.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/dist/mac-arm64/Crew.app"
DST="/Applications/Crew.app"
SUPPORT="$HOME/Library/Application Support/crew"

[ -d "$SRC" ] || { echo "ERROR: staged app not found at $SRC — run 'npm run build && npx electron-builder --mac --dir' first."; exit 1; }
V=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$SRC/Contents/Info.plist" 2>/dev/null)
echo "==> Installing Crew $V"

echo "==> Quitting Crew (its sessions resume on relaunch)..."
osascript -e 'quit app "Crew"' 2>/dev/null || true
for _ in $(seq 1 30); do
  pgrep -f "Crew.app/Contents/MacOS/Crew" >/dev/null 2>&1 || break
  sleep 0.5
done
if pgrep -f "Crew.app/Contents/MacOS/Crew" >/dev/null 2>&1; then
  echo "    Crew didn't exit; quit it manually (Crew ▸ Quit) and re-run."
  exit 1
fi

echo "==> Removing stale copies..."
rm -rf "/Applications/Crew.app.old" 2>/dev/null || true

echo "==> Installing into /Applications..."
rm -rf "$DST" && cp -R "$SRC" "$DST" || { echo "ERROR: could not replace $DST (permissions?)."; exit 1; }

echo "==> Clearing stale single-instance lock + quarantine, relaunching..."
rm -f "$SUPPORT/SingletonLock" "$SUPPORT/SingletonSocket" "$SUPPORT/SingletonCookie" 2>/dev/null || true
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
open "$DST"

echo "==> Done. Crew $(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$DST/Contents/Info.plist" 2>/dev/null) installed and relaunching."
