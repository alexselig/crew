#!/bin/bash
# Crew — one-command installer for the latest release.
#
#   curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
#
# Why this exists: Crew is not yet notarized by Apple, so a copy downloaded in a
# *browser* is stamped with the `com.apple.quarantine` flag and macOS Gatekeeper
# blocks it with "Crew.app was not opened because it contains malware."
# This script downloads the app with `curl` (which does NOT set that flag) and
# also strips quarantine defensively, so Crew installs and launches cleanly with
# no Gatekeeper prompt. Nothing about the app changes — only how it arrives.
#
# Tip: run this from Terminal.app / iTerm — not from a shell *inside* Crew, since
# it quits any running Crew to replace it (sessions resume on relaunch).
set -euo pipefail

REPO="alexselig/crew"
APP="Crew.app"
DST="/Applications/$APP"
SUPPORT="$HOME/Library/Application Support/crew"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Crew is a macOS app; this installer only runs on macOS."

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  warn "Crew currently ships Apple Silicon (arm64) builds only; detected: $ARCH."
  die "Build from source for Intel: https://github.com/$REPO"
fi

say "Finding the latest Crew release..."
# Public repo — the releases API needs no auth. Pull the *-mac.zip asset URL so
# this installer keeps working for every future version without edits.
API="https://api.github.com/repos/$REPO/releases/latest"
ZIP_URL="$(curl -fsSL "$API" | grep -oE 'https://[^"]*-mac\.zip' | head -1 || true)"
[ -n "$ZIP_URL" ] || die "Could not find a -mac.zip asset in the latest release of $REPO."
say "$ZIP_URL"

say "Downloading (curl — no quarantine flag is set)..."
curl -fL# "$ZIP_URL" -o "$TMP/crew.zip"

say "Unpacking..."
ditto -x -k "$TMP/crew.zip" "$TMP/unzip"
SRC="$(find "$TMP/unzip" -maxdepth 2 -name "$APP" -type d | head -1)"
[ -n "$SRC" ] || die "$APP not found inside the downloaded archive."

VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SRC/Contents/Info.plist" 2>/dev/null || echo '?')"

if pgrep -f "$APP/Contents/MacOS/Crew" >/dev/null 2>&1; then
  say "Quitting the running Crew (its sessions resume on relaunch)..."
  osascript -e 'quit app "Crew"' 2>/dev/null || true
  for _ in $(seq 1 30); do
    pgrep -f "$APP/Contents/MacOS/Crew" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -f "$APP/Contents/MacOS/Crew" >/dev/null 2>&1 && \
    die "Crew is still running — quit it (Crew ▸ Quit) and re-run this installer."
fi

say "Installing Crew $VER to /Applications..."
rm -rf "$DST"
ditto "$SRC" "$DST" || die "Could not write $DST (permissions?). Try: sudo rm -rf \"$DST\" then re-run."

say "Clearing quarantine + stale single-instance locks (belt & suspenders)..."
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
rm -f "$SUPPORT/SingletonLock" "$SUPPORT/SingletonSocket" "$SUPPORT/SingletonCookie" 2>/dev/null || true

say "Launching Crew..."
open "$DST"

for _ in $(seq 1 20); do
  if pgrep -f "$APP/Contents/MacOS/Crew" >/dev/null 2>&1; then
    say "Crew $VER is installed and running. ✅"
    exit 0
  fi
  sleep 0.5
done
say "Crew $VER installed to $DST. If it didn't open, launch it from Applications."
