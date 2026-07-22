#!/bin/bash
# Full macOS publish flow for Crew: sign + notarize + package, then upload the
# notarized zip/dmg + install.sh to the GitHub release and verify.
#
# This is the learned, working flow for this MDM-managed Mac (Microsoft Defender +
# a corporate npm proxy that serves an unsigned Electron). It signs a PREBUILT app
# rather than re-packaging from scratch. See MACOS-SIGNING.md and RELEASING.md.
#
# ONE-TIME PREREQS:
#   * Developer ID Application cert in the login keychain.
#   * Notary profile stored:  xcrun notarytool store-credentials "crew-notary" ...
#   * gh authenticated with the personal 'alexselig' account
#     (the corporate gh account can't push to personal repos).
#
# USAGE (after a build produced dist/mac-arm64/Crew.app):
#   npm run build && npx electron-builder --mac --dir
#   bash scripts/publish.sh [tag]        # tag defaults to v<package.json version>
#
# Env:
#   CREW_SKIP_SIGN=1   upload already-notarized dist artifacts without re-signing.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

REPO="alexselig/crew"
VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$VERSION}"
ZIP="dist/Crew-${VERSION}-arm64-mac.zip"
DMG="dist/Crew-${VERSION}-arm64.dmg"
# Version-independent alias the marketing site's Download button links to.
STABLE_DMG="dist/Crew-arm64.dmg"

# 1. Sign + notarize + package (produces the notarized ZIP + DMG)
if [ "${CREW_SKIP_SIGN:-0}" = "1" ]; then
  echo "==> CREW_SKIP_SIGN=1 — using existing artifacts"
  [ -f "$ZIP" ] && [ -f "$DMG" ] || { echo "ERROR: $ZIP / $DMG not found." >&2; exit 1; }
else
  bash "$REPO_DIR/scripts/sign-notarize.sh"
fi

# 2. Publish to GitHub with the personal token (corp gh account can't push here).
GH_TOKEN="$(gh auth token --user alexselig)"
export GH_TOKEN
[ -n "$GH_TOKEN" ] || { echo "ERROR: could not get personal 'alexselig' gh token." >&2; exit 1; }

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> Uploading assets to existing release $TAG"
else
  echo "==> Creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "Crew $TAG" \
    --notes "Crew $TAG — signed & notarized by Apple. Install: \`curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash\`"
fi
# The marketing site links to a version-independent Crew-arm64.dmg, so ship a
# stable-named copy of the notarized DMG next to the versioned assets. Without it
# releases/latest/download/Crew-arm64.dmg 404s and the website Download button breaks.
cp -f "$DMG" "$STABLE_DMG"
gh release upload "$TAG" "$ZIP" "$DMG" "$STABLE_DMG" install.sh --repo "$REPO" --clobber

# 3. Verify the published assets + the stable installer URL.
echo "==> Published assets:"
gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' | sed 's/^/    /'
curl -fsSL -o /dev/null -w "    install.sh (latest) -> http %{http_code}\n" \
  "https://github.com/$REPO/releases/latest/download/install.sh" || true
curl -fsSL -o /dev/null -w "    Crew-arm64.dmg (latest) -> http %{http_code}\n" \
  "https://github.com/$REPO/releases/latest/download/Crew-arm64.dmg" || true
echo "==> Done: https://github.com/$REPO/releases/tag/$TAG"
