#!/bin/bash
# Crew — one-command installer for the latest release.
#
#   curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
#
# Why this exists: Crew is signed + notarized by Apple, so it opens with no
# Gatekeeper warnings. Downloads are verified before the running app is touched;
# a same-volume backup is retained until the replacement launches successfully.
# CREW_INSTALL_DIR overrides /Applications for custom installations.
#
# Tip: run this from Terminal.app / iTerm — not from a shell *inside* Crew, since
# it quits any running Crew to replace it (sessions resume on relaunch).
set -euo pipefail

REPO="alexselig/crew"
APP="Crew.app"
TEAM="42KAR3VVM7"
WORK=""
LOCKED=0
COMMITTED=0
PROMOTING=0

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Crew is a macOS app; this installer only runs on macOS."

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET_ARCH=arm64 ;;
  x86_64) ASSET_ARCH=x64 ;;
  *) die "Unsupported architecture: $ARCH." ;;
esac

INSTALL_DIR="${CREW_INSTALL_DIR:-/Applications}"
[ -d "$INSTALL_DIR" ] || die "Install directory does not exist: $INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
DST="$INSTALL_DIR/$APP"
[ ! -L "$DST" ] || die "Refusing to replace a symlink: $DST"
[ ! -e "$DST" ] || [ -d "$DST" ] || die "Not an application directory: $DST"
LOCK="$INSTALL_DIR/.crew-install.lock"
# Escape regex metacharacters: only this installation's main process counts.
PROCESS="$(printf '%s' "$DST/Contents/MacOS/Crew" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
running() { pgrep -f "(^|[[:space:]])$PROCESS([[:space:]]|$)" >/dev/null 2>&1; }
quit_app() {
  running || return 0
  osascript - "$DST" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  tell application (item 1 of argv) to quit
end run
APPLESCRIPT
  local attempt=0
  while [ "$attempt" -lt 30 ]; do
    running || return 0
    sleep 0.5
    attempt=$((attempt + 1))
  done
  ! running
}

cleanup() {
  local status=$? keep=0
  trap - EXIT HUP INT TERM
  set +e
  if [ -n "$WORK" ] && [ "$COMMITTED" -eq 0 ]; then
    if [ -d "$WORK/previous.app" ]; then
      # Do not move a live replacement or overwrite an unexpected destination.
      if { [ "$PROMOTING" -eq 0 ] || quit_app; } &&
         { [ ! -e "$DST" ] || { [ "$PROMOTING" -eq 1 ] && mv "$DST" "$WORK/failed.app"; }; } &&
         mv "$WORK/previous.app" "$DST"; then
        warn "Restored the previous Crew at $DST."
        open "$DST" >/dev/null 2>&1 || warn "Could not relaunch the restored app; open $DST manually."
      else
        keep=1
        warn "Rollback failed. Your previous app is preserved at: $WORK/previous.app"
        warn "Quit Crew before moving that backup back to: $DST"
      fi
    elif [ "$PROMOTING" -eq 1 ] && [ -e "$DST" ]; then
      if quit_app && mv "$DST" "$WORK/failed.app"; then
        warn "Removed the unconfirmed new installation."
      else
        keep=1
        warn "Could not withdraw the unconfirmed app at $DST; staging preserved at: $WORK"
      fi
    fi
  fi
  # Only this invocation's private, resolved staging directory is removable.
  if [ -n "$WORK" ] && [ "$keep" -eq 0 ]; then
    case "$WORK" in
      "$INSTALL_DIR"/.crew-install.*)
        if [ ! -L "$WORK" ] && [ "$(cd "$WORK" 2>/dev/null && pwd -P)" = "$WORK" ]; then
          rm -rf "$WORK" || warn "Could not clean staging directory: $WORK"
        fi ;;
    esac
  fi
  if [ "$LOCKED" -eq 1 ]; then
    rmdir "$LOCK" || warn "Could not remove installer lock: $LOCK"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
mkdir "$LOCK" 2>/dev/null || die "Another installer may be active, or the destination is not writable: $LOCK. If interrupted, inspect its staging backups before removing this lock."
LOCKED=1
WORK="$(mktemp -d "$INSTALL_DIR/.crew-install.XXXXXX")"
[ -d "$WORK" ] && [ ! -L "$WORK" ] || die "Could not create private staging directory."

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
validate_arch() {
  local architectures
  architectures="$(lipo -archs "$1")" || die "Could not inspect native architecture: $1"
  case " $architectures " in
    *" $ARCH "*) ;;
    *) die "Native architecture mismatch (wanted $ARCH, found $architectures): $1" ;;
  esac
}
validate_native_bundle() {
  local bundle="$1" pty_root layout active="" native
  pty_root="$bundle/Contents/Resources/app.asar.unpacked/node_modules/node-pty"
  # Match node-pty's loader order. Its shipped prebuilds/bin also contain
  # inactive Windows and other-architecture binaries, not runtime dependencies.
  for layout in build/Release build/Debug "prebuilds/darwin-$ASSET_ARCH"; do
    if [ -f "$pty_root/$layout/pty.node" ]; then
      active="$pty_root/$layout"
      break
    fi
  done
  [ -n "$active" ] || die "No runtime PTY native module found for $ASSET_ARCH."
  validate_arch "$active/pty.node"
  [ -f "$active/spawn-helper" ] || die "Missing runtime PTY spawn-helper: $active/spawn-helper"
  validate_arch "$active/spawn-helper"
  validate_arch "$bundle/Contents/MacOS/Crew"
  find "$bundle/Contents" -path "$pty_root" -prune -o -type f \
    \( -name '*.node' -o -name '*.dylib' -o -name 'spawn-helper' -o -path '*/MacOS/*' -o -path '*.framework/Versions/*/Electron Framework' \) \
    -print0 > "$WORK/native-files"
  while IFS= read -r -d '' native; do
    validate_arch "$native"
  done < "$WORK/native-files"
}
validate_bundle() {
  local bundle="$1" identity assessment
  [ -d "$bundle" ] && [ ! -L "$bundle" ] &&
    [ ! -L "$bundle/Contents" ] && [ ! -L "$bundle/Contents/Info.plist" ] ||
    die "Invalid application bundle: $bundle"
  [ "$(plist "$bundle" CFBundleIdentifier)" = "com.alexselig.crew" ] ||
    die "Downloaded bundle has the wrong identifier."
  [ "$(plist "$bundle" CFBundleShortVersionString)" = "$VER" ] ||
    die "Downloaded bundle version does not match release $VER."
  [ "$(plist "$bundle" CFBundleExecutable)" = "Crew" ] ||
    die "Unexpected bundle executable."
  codesign --verify --deep --strict "$bundle" || die "Code signature verification failed: $bundle"
  identity="$(codesign -d --verbose=4 "$bundle" 2>&1)" || die "Cannot inspect signing identity."
  printf '%s\n' "$identity" | grep -Fx "TeamIdentifier=$TEAM" >/dev/null ||
    die "Unexpected signing team (expected $TEAM)."
  printf '%s\n' "$identity" | grep '^Authority=Developer ID Application:' >/dev/null ||
    die "A Developer ID Application signature is required."
  assessment="$(spctl --assess --type execute --verbose=2 "$bundle" 2>&1)" ||
    die "Gatekeeper rejected the app: $assessment"
  printf '%s\n' "$assessment" | grep -Fx 'source=Notarized Developer ID' >/dev/null ||
    die "Gatekeeper did not confirm Developer ID notarization: $assessment"
  validate_native_bundle "$bundle"
}

say "Finding the latest Crew release..."
API="https://api.github.com/repos/$REPO/releases/latest"
curl --proto '=https' --tlsv1.2 -fsSL "$API" -o "$WORK/release.json"
TAG="$(/usr/bin/plutil -extract tag_name raw -o - "$WORK/release.json")"
VER="${TAG#v}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || die "Invalid release version: $TAG"
ASSET="Crew-$VER-$ASSET_ARCH-mac.zip"
ZIP_URL=""
index=0
while name="$(/usr/bin/plutil -extract "assets.$index.name" raw -o - "$WORK/release.json" 2>/dev/null)"; do
  if [ "$name" = "$ASSET" ]; then
    [ -z "$ZIP_URL" ] || die "Ambiguous release asset: $ASSET"
    ZIP_URL="$(/usr/bin/plutil -extract "assets.$index.browser_download_url" raw -o - "$WORK/release.json")"
  fi
  index=$((index + 1))
done
[ "$ZIP_URL" = "https://github.com/$REPO/releases/download/$TAG/$ASSET" ] ||
  die "Could not find the exact official release asset: $ASSET"
say "$ZIP_URL"

say "Downloading..."
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL# "$ZIP_URL" -o "$WORK/crew.zip"

say "Unpacking..."
ditto -x -k "$WORK/crew.zip" "$WORK/unpack"
SRC="$WORK/unpack/$APP"
validate_bundle "$SRC"

say "Staging Crew $VER in $INSTALL_DIR..."
ditto "$SRC" "$WORK/$APP" || die "Could not stage Crew; your existing app is unchanged."
validate_bundle "$WORK/$APP"

if running; then
  say "Quitting the running Crew (its sessions resume on relaunch)..."
  quit_app || die "Crew is still running — quit it (Crew ▸ Quit) and re-run this installer."
fi

say "Installing Crew $VER to $INSTALL_DIR..."
if [ -e "$DST" ]; then
  mv "$DST" "$WORK/previous.app" || die "Could not preserve the previous app."
fi
PROMOTING=1
mv "$WORK/$APP" "$DST" || die "Could not promote staged Crew."

say "Launching Crew..."
open "$DST" || die "Could not launch the replacement app."

attempt=0
while [ "$attempt" -lt 20 ]; do
  if running; then
    COMMITTED=1
    say "Crew $VER is installed and running. ✅"
    exit 0
  fi
  sleep 0.5
  attempt=$((attempt + 1))
done
die "The replacement did not start; restoring the previous app."
