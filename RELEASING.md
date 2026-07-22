# Releasing Crew (macOS)

The learned, working release flow for this machine. Crew ships **signed +
notarized** so downloads open with no Gatekeeper warning and survive Microsoft
Defender on managed Macs. Background + why the usual `electron-builder` notarize
path doesn't work here: [`MACOS-SIGNING.md`](./MACOS-SIGNING.md).

## One-time prerequisites
- **Developer ID Application** cert in your login keychain
  (Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates ▸ **+** ▸ *Developer ID Application*).
  Confirm: `security find-identity -v -p codesigning` shows `Developer ID Application: Aaron Selig (42KAR3VVM7)`.
- **Notary credentials** stored as a profile (app-specific password from appleid.apple.com):
  ```bash
  xcrun notarytool store-credentials "crew-notary" \
    --apple-id "alex.selig@gmail.com" --team-id "42KAR3VVM7" --password "xxxx-xxxx-xxxx-xxxx"
  ```
- `gh` reachable with the personal **`alexselig`** account (`gh auth token --user alexselig`);
  the corporate account can't push/publish to personal repos.

## Release steps
1. **Bump** `version` in `package.json` and add a `CHANGELOG.md` entry.
2. **Verify + build** the unsigned app bundle:
   ```bash
   npm run typecheck && npm test && npm run build
   npx electron-builder --mac --dir     # -> dist/mac-arm64/Crew.app
   ```
   > If `node_modules/electron` was deleted by Defender, restore it first with
   > `npm install` (it comes back as unsigned/ad-hoc — that's fine; we re-sign it).
3. **Sign + notarize + publish** (one command):
   ```bash
   bash scripts/publish.sh              # tag defaults to v<version>
   ```
   This runs `scripts/sign-notarize.sh` (Developer ID sign → notarize → staple →
   package notarized `Crew-<ver>-arm64-mac.zip` + `Crew-<ver>-arm64.dmg`), then
   creates/updates the GitHub release and uploads the zip, dmg, and `install.sh`.
   - Just sign locally (no publish): `bash scripts/sign-notarize.sh`
   - Re-upload existing notarized artifacts: `CREW_SKIP_SIGN=1 bash scripts/publish.sh`
4. **Commit + push** the version/CHANGELOG/code changes (personal token):
   ```bash
   export TK=$(gh auth token --user alexselig)
   git -c credential.helper= \
       -c credential.helper='!f(){ echo username=alexselig; echo "password=$TK"; }; f' \
       push origin main
   ```

## Verify a release
```bash
# a fresh download is notarized:
curl -fsSL -o /tmp/crew.zip "https://github.com/alexselig/crew/releases/latest/download/Crew-<ver>-arm64-mac.zip"
ditto -x -k /tmp/crew.zip /tmp/crewv && spctl -a -vvv -t exec /tmp/crewv/Crew.app
#   -> accepted, source=Notarized Developer ID
```

Users install with:
```bash
curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
```
