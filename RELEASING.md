# Releasing Crew

Ship Apple Silicon, Intel, and Windows together. macOS apps are Developer ID
signed, notarized, and stapled; Windows builds are currently unsigned and may
show SmartScreen warnings. Publishing does not install or restart Crew.

## One-time prerequisites

- Developer ID Application certificate in the login keychain. Verify with
  `security find-identity -v -p codesigning`.
- Apple notarization credentials stored in the `crew-notary` keychain profile:
  ```bash
  xcrun notarytool store-credentials crew-notary \
    --apple-id "you@example.com" --team-id "42KAR3VVM7"
  ```
  Supply the app-specific password through the prompt, not a committed file.
- Personal GitHub account `alexselig` available through `gh auth`.
- Rosetta for testing the Intel app on Apple Silicon.

## Prepare and merge

1. Bump both package files with `npm version <version> --no-git-tag-version`,
   update `CHANGELOG.md`, and finish the release review.
2. Run `npm run typecheck && npm test && npm run build`, then the isolated
   Electron checks in `test/e2e/`. Never replace the installed app for testing.
3. Commit, push, and merge the release PR through the normal repository workflow.
   Check out the merged `main` commit. The publisher rejects a dirty tree,
   a tag/version mismatch, or a HEAD different from remote `main`.
   ```bash
   export GH_TOKEN="$(gh auth token --user alexselig)"
   git -c credential.helper= -c credential.helper='!gh auth git-credential' push
   ```

## Build, sign, and test both macOS architectures

```bash
npm run build
npx electron-builder --mac --arm64 --dir
bash scripts/sign-notarize.sh
```

Build Intel with `npx electron-builder --mac --x64 --dir`, then
`CREW_ARCH=x64 bash scripts/sign-notarize.sh`. Prefer a separate checkout and
dependency directory for Intel: packaging rebuilds node-pty for the target
architecture and can otherwise break a running development environment.
Do not use a universal bundle; node-pty is packaged per architecture.

`CREW_APP` selects a prebuilt bundle outside the default output directory.
Signing checks the bundle ID, version, target architecture, and presence of
native PTY binaries before signing. The two architectures use distinct
notarization archives. See [MACOS-SIGNING.md](./MACOS-SIGNING.md) for background.

Test each actual packaged native module with the corresponding Electron:

```bash
ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/Crew.app/Contents/MacOS/Crew \
  scripts/smoke-packaged-pty.cjs \
  "$PWD/dist/mac-arm64/Crew.app/Contents/Resources/app.asar"
```

Repeat against `dist/mac/Crew.app` for Intel. This starts a harmless shell,
checks its PTY output/exit, and never loads Crew's UI or session store.
Verify fresh ZIP extractions as well as the build directory:
`codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl -a -t exec`.
Check the extracted bundle version and CPU architecture.

## Stage a draft before pushing the tag

Put both signed ZIP/DMG pairs in the release checkout's `dist/`, then:

```bash
CREW_SKIP_SIGN=1 bash scripts/publish.sh
```

This creates a **draft** targeting the exact HEAD, uploads both macOS
architectures and stable aliases, and checks their uploaded SHA-256 digests.
Without `CREW_SKIP_SIGN=1`, it signs both prebuilt bundles first.
An existing public release or a draft targeting another commit is never changed.
Draft metadata is resolved by stable release ID: GitHub's REST tag endpoint does
not expose drafts. Lookup failures stop the script rather than implying absence.

After staging, create and push the matching tag:

```bash
TAG="v$(node -p "require('./package.json').version")"
git tag "$TAG"
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin "$TAG"
```

The tag triggers **Build Windows**, which runs typechecks/tests, builds the
installer and portable ZIP, checks the packaged native PTY, and attaches assets
only to the matching draft. A manual workflow run with a tag checks out that
tag; a blank tag builds workflow artifacts without publishing.
The test job installs SQLite and Playwright's Chromium; neither is bundled into
the app. POSIX permission-bit assertions run only on Unix, while all platforms
check that atomic writes request restrictive permissions.

## Verify and publish the complete release

Add the final release notes to the draft and wait for Build Windows to succeed:

```bash
CREW_SKIP_SIGN=1 CREW_PUBLISH=1 bash scripts/publish.sh
```

The final gate requires matching local/remote tags and a successful Windows run
at the release commit. It downloads and verifies all eleven required assets and
their stable aliases before publishing the draft as latest. Failed uploads,
missing platforms, mismatched hashes, or failed verification stop publication.
The public stable download URLs are checked afterward.

Required assets are versioned arm64/x64 ZIPs and DMGs, the versioned Windows
installer/ZIP, `Crew-AppleSilicon.zip`, `Crew-Intel.zip`, `Crew-arm64.dmg`,
`Crew-Setup.exe`, and `install.sh`. Never expose a partial release as latest or
silently replace assets on an existing public release; use a new version.

Users can install the latest notarized macOS build with:

```bash
curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
```
