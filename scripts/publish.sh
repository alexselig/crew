#!/bin/bash
# Stage all macOS assets in a draft. Publish only after Windows assets exist and
# every required download has been verified.
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
# USAGE (after both architecture bundles have been built):
#   bash scripts/publish.sh [tag]        # stage a draft; does not push a tag
#   CREW_SKIP_SIGN=1 CREW_PUBLISH=1 bash scripts/publish.sh [tag]
#
# Env:
#   CREW_SKIP_SIGN=1   upload already-notarized dist artifacts without re-signing.
#   CREW_PUBLISH=1     verify the complete draft and publish it as latest.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

REPO="alexselig/crew"
VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$VERSION}"
[ "$TAG" = "v$VERSION" ] || { echo "ERROR: release tag must match package version v$VERSION." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "ERROR: commit release changes before staging assets." >&2; exit 1; }
COMMIT="$(git rev-parse HEAD)"
GH_TOKEN="$(gh auth token --user alexselig)"
export GH_TOKEN
[ -n "$GH_TOKEN" ] || { echo "ERROR: personal GitHub authentication is unavailable." >&2; exit 1; }
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | cut -f1)"
[ "$REMOTE_MAIN" = "$COMMIT" ] || { echo "ERROR: HEAD must be the pushed main release commit." >&2; exit 1; }

release_id() {
  # REST lookup by tag excludes drafts; resolve their stable database ID first.
  gh api graphql -f query='query($owner: String!, $name: String!, $tag: String!) {
    repository(owner: $owner, name: $name) { release(tagName: $tag) { databaseId } }
  }' -f owner="${REPO%/*}" -f name="${REPO#*/}" -f tag="$TAG" \
    --jq '.data.repository.release.databaseId // empty'
}
RELEASE_ID="$(release_id)"
RELEASE=""
if [ -n "$RELEASE_ID" ]; then
  RELEASE="$(gh api "repos/$REPO/releases/$RELEASE_ID")"
  node -e '
    const r = JSON.parse(process.argv[1])
    if (!r.draft || r.target_commitish !== process.argv[2]) {
      console.error("ERROR: refusing to modify a public release or a draft targeting another commit.")
      process.exit(1)
    }
  ' "$RELEASE" "$COMMIT"
fi

if [ "${CREW_SKIP_SIGN:-0}" != "1" ]; then
  CREW_ARCH=arm64 bash "$REPO_DIR/scripts/sign-notarize.sh"
  CREW_ARCH=x64 bash "$REPO_DIR/scripts/sign-notarize.sh"
fi
ASSETS=()
for ARCH in arm64 x64; do
  for FILE in "dist/Crew-${VERSION}-${ARCH}-mac.zip" "dist/Crew-${VERSION}-${ARCH}.dmg"; do
    [ -s "$FILE" ] || { echo "ERROR: missing release artifact: $FILE" >&2; exit 1; }
    ASSETS+=("$FILE")
  done
done
cp "dist/Crew-${VERSION}-arm64-mac.zip" dist/Crew-AppleSilicon.zip
cp "dist/Crew-${VERSION}-x64-mac.zip" dist/Crew-Intel.zip
cp "dist/Crew-${VERSION}-arm64.dmg" dist/Crew-arm64.dmg
ASSETS+=(dist/Crew-AppleSilicon.zip dist/Crew-Intel.zip dist/Crew-arm64.dmg install.sh)

if [ -z "$RELEASE" ]; then
  echo "==> Creating draft $TAG at $COMMIT"
  gh release create "$TAG" --repo "$REPO" --draft --target "$COMMIT" --title "Crew $TAG" \
    --notes "Crew $TAG. See CHANGELOG.md for changes. macOS builds are signed and notarized; Windows builds are unsigned."
  RELEASE_ID="$(release_id)"
  [ -n "$RELEASE_ID" ] || { echo "ERROR: the created draft could not be resolved." >&2; exit 1; }
fi
RELEASE="$(gh api "repos/$REPO/releases/$RELEASE_ID")"

# Upload one asset at a time and skip anything already stored intact. A bulk
# --clobber re-sends every artifact, so a single transient 422 or 500 discards
# hundreds of megabytes of completed work. Confirm each upload against the API
# rather than gh's exit status, which can report failure after a successful save.
pending_assets() {
  node - "$RELEASE" "$@" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const release = JSON.parse(process.argv[2])
for (const file of process.argv.slice(3)) {
  const bytes = fs.readFileSync(file)
  const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const asset = release.assets.find(a => a.name === path.basename(file))
  if (!asset || asset.state !== 'uploaded' || asset.size !== bytes.length || asset.digest !== digest) {
    console.log(file)
  }
}
NODE
}

UPLOAD_RETRIES="${CREW_UPLOAD_RETRIES:-5}"
UPLOAD_RETRY_DELAY="${CREW_UPLOAD_RETRY_DELAY:-10}"
for FILE in "${ASSETS[@]}"; do
  ATTEMPT=1
  while [ -n "$(pending_assets "$FILE")" ]; do
    if [ "$ATTEMPT" -gt "$UPLOAD_RETRIES" ]; then
      echo "ERROR: $FILE is still not stored after $UPLOAD_RETRIES attempts." >&2
      exit 1
    fi
    echo "==> Uploading $(basename "$FILE") (attempt $ATTEMPT)"
    gh release upload "$TAG" "$FILE" --repo "$REPO" --clobber || true
    RELEASE="$(gh api "repos/$REPO/releases/$RELEASE_ID")"
    ATTEMPT=$((ATTEMPT + 1))
    [ -z "$(pending_assets "$FILE")" ] || sleep "$UPLOAD_RETRY_DELAY"
  done
done
RELEASE="$(gh api "repos/$REPO/releases/$RELEASE_ID")"

# GitHub provides a SHA-256 digest for uploaded release assets.
node - "$RELEASE" "${ASSETS[@]}" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const release = JSON.parse(process.argv[2])
for (const file of process.argv.slice(3)) {
  const asset = release.assets.find(a => a.name === path.basename(file))
  const bytes = fs.readFileSync(file)
  const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  if (!asset || asset.state !== 'uploaded' || asset.size !== bytes.length || asset.digest !== digest) {
    throw new Error(`Uploaded asset does not match local artifact: ${file}`)
  }
}
console.log('All staged macOS assets and installer match their uploaded SHA-256 digests.')
NODE

if [ "${CREW_PUBLISH:-0}" != "1" ]; then
  echo "==> Draft staged. Push tag $TAG at $COMMIT, wait for Build Windows, then run with CREW_SKIP_SIGN=1 CREW_PUBLISH=1."
  exit 0
fi

LOCAL_TAG="$(git rev-parse "$TAG^{commit}")"
REMOTE_TAG="$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}" | tail -n1 | cut -f1)"
[ "$LOCAL_TAG" = "$COMMIT" ] && [ "$REMOTE_TAG" = "$COMMIT" ] || { echo "ERROR: local and remote tags must identify the release commit." >&2; exit 1; }
RUNS="$(gh run list --repo "$REPO" --workflow build-windows.yml --commit "$COMMIT" --limit 10 --json status,conclusion)"
node -e '
  if (!JSON.parse(process.argv[1]).some(r => r.status === "completed" && r.conclusion === "success")) {
    console.error("ERROR: no successful Windows build for the release commit.")
    process.exit(1)
  }
' "$RUNS"

VERIFY_DIR="$(mktemp -d -t crew-release-verify)"
trap 'rm -rf "$VERIFY_DIR"' EXIT
gh release download "$TAG" --repo "$REPO" --dir "$VERIFY_DIR" \
  --pattern '*.zip' --pattern '*.dmg' --pattern '*.exe' --pattern install.sh
node - "$RELEASE" "$VERIFY_DIR" "$VERSION" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const [raw, dir, v] = process.argv.slice(2), release = JSON.parse(raw)
const names = [
  ...['arm64', 'x64'].flatMap(a => [`Crew-${v}-${a}-mac.zip`, `Crew-${v}-${a}.dmg`]),
  'Crew-AppleSilicon.zip', 'Crew-Intel.zip', 'Crew-arm64.dmg', 'install.sh',
  `Crew-${v}-win.zip`, `Crew-Setup-${v}.exe`, 'Crew-Setup.exe'
]
for (const name of names) {
  const asset = release.assets.find(a => a.name === name)
  const bytes = fs.readFileSync(path.join(dir, name))
  const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  if (!asset || asset.state !== 'uploaded' || !bytes.length || asset.digest !== digest) {
    throw new Error(`Missing or invalid downloaded asset: ${name}`)
  }
}
for (const [alias, original] of [
  ['Crew-AppleSilicon.zip', `Crew-${v}-arm64-mac.zip`], ['Crew-Intel.zip', `Crew-${v}-x64-mac.zip`],
  ['Crew-arm64.dmg', `Crew-${v}-arm64.dmg`], ['Crew-Setup.exe', `Crew-Setup-${v}.exe`]
]) {
  if (!fs.readFileSync(path.join(dir, alias)).equals(fs.readFileSync(path.join(dir, original)))) {
    throw new Error(`Stable alias differs from its versioned artifact: ${alias}`)
  }
}
console.log(`Verified all ${names.length} required release downloads and stable aliases.`)
NODE
gh release edit "$TAG" --repo "$REPO" --draft=false --latest
for NAME in install.sh Crew-arm64.dmg Crew-AppleSilicon.zip Crew-Intel.zip Crew-Setup.exe; do
  curl -fsSL --retry 3 -o /dev/null "https://github.com/$REPO/releases/latest/download/$NAME"
done
echo "==> Published: https://github.com/$REPO/releases/tag/$TAG"
