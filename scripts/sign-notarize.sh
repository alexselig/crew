#!/bin/bash
# Sign + notarize + staple a built Crew.app, then package a notarized zip + dmg.
#
# WHY THIS EXISTS (instead of electron-builder's built-in notarize):
# On an MDM-managed Mac with Microsoft Defender, the corporate npm proxy serves an
# unsigned Electron and Defender deletes it (breaking a from-scratch electron-builder
# package). This script signs a PREBUILT app in place — no Electron re-download — so
# it works in that environment. See MACOS-SIGNING.md for the full story.
#
# ONE-TIME PREREQS:
#   1. Developer ID Application cert in your login keychain
#      (Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates ▸ + ▸ Developer ID Application).
#   2. Notary credentials stored as a profile:
#        xcrun notarytool store-credentials "crew-notary" \
#          --apple-id "you@example.com" --team-id "42KAR3VVM7" \
#          --password "xxxx-xxxx-xxxx-xxxx"     # app-specific password from appleid.apple.com
#
# USAGE (after a build produced dist/mac-arm64/Crew.app):
#   npm run build && npx electron-builder --mac --dir   # produce the unsigned .app
#   bash scripts/sign-notarize.sh
#
# Override the identity/profile via env if needed:
#   CREW_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" CREW_NOTARY_PROFILE=crew-notary bash scripts/sign-notarize.sh
#
# Architecture: defaults to arm64 (Apple Silicon). For an Intel build, produce the
# app with `npx electron-builder --mac --x64 --dir` (emits dist/mac/Crew.app) then:
#   CREW_ARCH=x64 bash scripts/sign-notarize.sh
# This signs + notarizes dist/mac/Crew.app into Crew-<ver>-x64-mac.zip / -x64.dmg.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

IDENTITY="${CREW_SIGN_IDENTITY:-Developer ID Application: Aaron Selig (42KAR3VVM7)}"
PROFILE="${CREW_NOTARY_PROFILE:-crew-notary}"
TIMESTAMP_URL="${CREW_TIMESTAMP_URL:-$(bash "$REPO_DIR/scripts/resolve-timestamp-url.sh" http://timestamp.apple.com/ts01)}"
VERSION="$(node -p "require('./package.json').version")"
SIGN_BIN="$(mktemp -d)"
ln -s "$REPO_DIR/scripts/codesign-retry.sh" "$SIGN_BIN/codesign"
export CREW_TIMESTAMP_URL="$TIMESTAMP_URL"
export CREW_EXPECTED_AUTHORITY="$IDENTITY"
export PATH="$SIGN_BIN:$PATH"
trap 'rm -rf "$SIGN_BIN"' EXIT
# Which macOS architecture to sign/package. electron-builder --dir emits arm64 to
# dist/mac-arm64/ and x64 to dist/mac/. Override the app path with CREW_APP if needed.
ARCH="${CREW_ARCH:-arm64}"
if [ "$ARCH" = "x64" ] || [ "$ARCH" = "intel" ]; then
  ARCH=x64
  MACH_ARCH=x86_64
  APP="${CREW_APP:-dist/mac/Crew.app}"
  ZIP="dist/Crew-${VERSION}-x64-mac.zip"
  DMG="dist/Crew-${VERSION}-x64.dmg"
elif [ "$ARCH" = "arm64" ]; then
  MACH_ARCH=arm64
  APP="${CREW_APP:-dist/mac-arm64/Crew.app}"
  ZIP="dist/Crew-${VERSION}-arm64-mac.zip"
  DMG="dist/Crew-${VERSION}-arm64.dmg"
else
  echo "ERROR: unsupported architecture: $ARCH" >&2
  exit 1
fi

[ -d "$APP" ] || { echo "ERROR: $APP not found — run 'npm run build && npx electron-builder --mac --dir' first." >&2; exit 1; }
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
[ "$APP_VERSION" = "$VERSION" ] || { echo "ERROR: bundle version $APP_VERSION does not match package version $VERSION." >&2; exit 1; }
[ "$APP_ID" = "com.alexselig.crew" ] || { echo "ERROR: unexpected bundle identifier: $APP_ID" >&2; exit 1; }
APP_ARCHS="$(lipo -archs "$APP/Contents/MacOS/Crew")"
case " $APP_ARCHS " in
  *" $MACH_ARCH "*) ;;
  *) echo "ERROR: bundle architecture $APP_ARCHS does not include $MACH_ARCH." >&2; exit 1 ;;
esac
mkdir -p dist
NOTARY_ZIP="dist/.crew-notarize-${ARCH}.zip"

echo "==> Signing $APP"
echo "    identity: $IDENTITY"
# node-pty ships native binaries in asar.unpacked that must be signed explicitly
# (darwin only — the win32 prebuilds are PE, not Mach-O). electron-osx-sign handles
# the Electron frameworks/helpers and applies Chromium's per-helper entitlements.
NP=()
while IFS= read -r f; do NP+=("$f"); done < <(find "$APP/Contents/Resources/app.asar.unpacked/node_modules/node-pty" \( -name "*.node" -o -name "spawn-helper" \) ! -path "*win32*" 2>/dev/null || true)
[ "${#NP[@]}" -gt 0 ] || { echo "ERROR: packaged node-pty native binaries are missing." >&2; exit 1; }
# The PATH wrapper retries each codesign operation independently. Retrying only
# the whole Electron app repeatedly restarts at the first timestamp failure.
signed=0
for attempt in 1 2 3 4 5; do
  if node_modules/.bin/electron-osx-sign "$APP" "${NP[@]}" \
      --identity="$IDENTITY" --platform=darwin --type=distribution \
      --ignore='\.(pak|nib|dat|bin|asar|icns)$' \
      --timestamp="$TIMESTAMP_URL"; then
    signed=1
    break
  fi
  echo "    sign attempt $attempt failed (likely a transient timestamp.apple.com blip) — retrying in 15s…" >&2
  sleep 15
done
[ "$signed" = "1" ] || { echo "ERROR: signing failed after 5 attempts." >&2; exit 1; }
codesign --verify --deep --strict "$APP"

echo "==> Notarizing app (Apple, ~1-5 min)"
ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$PROFILE" --wait
rm -f "$NOTARY_ZIP"
xcrun stapler staple "$APP"
spctl -a -vvv -t exec "$APP"

echo "==> Packaging notarized zip -> $ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "==> Building + notarizing dmg -> $DMG"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Crew.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Crew" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
signed=0
for attempt in 1 2 3 4 5; do
  if codesign --force --sign "$IDENTITY" --timestamp="$TIMESTAMP_URL" "$DMG"; then
    signed=1
    break
  fi
  echo "    dmg sign attempt $attempt failed (transient timestamp blip) — retrying in 15s…" >&2
  sleep 15
done
[ "$signed" = "1" ] || { echo "ERROR: DMG signing failed after 5 attempts." >&2; exit 1; }
codesign --verify --strict "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo "==> Done."
echo "    Notarized: $ZIP"
echo "    Notarized: $DMG"
echo "    Publish:   GH_TOKEN=\$(gh auth token --user alexselig) gh release upload <tag> \"$ZIP\" \"$DMG\" --repo alexselig/crew --clobber"
