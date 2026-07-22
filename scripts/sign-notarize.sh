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
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

IDENTITY="${CREW_SIGN_IDENTITY:-Developer ID Application: Aaron Selig (42KAR3VVM7)}"
PROFILE="${CREW_NOTARY_PROFILE:-crew-notary}"
APP="dist/mac-arm64/Crew.app"
VERSION="$(node -p "require('./package.json').version")"
ZIP="dist/Crew-${VERSION}-arm64-mac.zip"
DMG="dist/Crew-${VERSION}-arm64.dmg"

[ -d "$APP" ] || { echo "ERROR: $APP not found — run 'npm run build && npx electron-builder --mac --dir' first." >&2; exit 1; }

echo "==> Signing $APP"
echo "    identity: $IDENTITY"
# node-pty ships native binaries in asar.unpacked that must be signed explicitly
# (darwin only — the win32 prebuilds are PE, not Mach-O). electron-osx-sign handles
# the Electron frameworks/helpers and applies Chromium's per-helper entitlements.
NP=()
while IFS= read -r f; do NP+=("$f"); done < <(find "$APP/Contents/Resources/app.asar.unpacked/node_modules/node-pty" \( -name "*.node" -o -name "spawn-helper" \) ! -path "*win32*" 2>/dev/null || true)
node_modules/.bin/electron-osx-sign "$APP" "${NP[@]}" \
  --identity="$IDENTITY" --platform=darwin --type=distribution
codesign --verify --deep --strict "$APP"

echo "==> Notarizing app (Apple, ~1-5 min)"
ditto -c -k --keepParent "$APP" "dist/.crew-notarize.zip"
xcrun notarytool submit "dist/.crew-notarize.zip" --keychain-profile "$PROFILE" --wait
rm -f "dist/.crew-notarize.zip"
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
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo "==> Done."
echo "    Notarized: $ZIP"
echo "    Notarized: $DMG"
echo "    Publish:   GH_TOKEN=\$(gh auth token --user alexselig) gh release upload <tag> \"$ZIP\" \"$DMG\" --repo alexselig/crew --clobber"
