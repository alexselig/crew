# Signing & notarizing Crew

**✅ Current status: Crew is signed + notarized.** Releases are signed with
**Developer ID Application: Aaron Selig (42KAR3VVM7)**, notarized by Apple, and
stapled — so downloads open with no Gatekeeper warning and are not removed by
Microsoft Defender on managed Macs.

## Re-releasing (the working process)

After producing a build (`dist/mac-arm64/Crew.app`), run:

```bash
bash scripts/sign-notarize.sh
```

It signs the prebuilt app (Developer ID + hardened runtime + Chromium per-helper
entitlements, incl. the native `node-pty` binaries), notarizes + staples it, and
produces a notarized `dist/Crew-<ver>-arm64-mac.zip` and `dist/Crew-<ver>-arm64.dmg`.
Repeat for Intel with `CREW_ARCH=x64` and follow the draft-first, complete-platform
publication flow in [RELEASING.md](./RELEASING.md). The signing script rejects a
bundle with the wrong version, bundle ID, or architecture before signing it.

> **Why not `electron-builder`'s built-in notarize?** On this MDM-managed Mac the
> corporate npm proxy serves an *unsigned* Electron and Microsoft Defender deletes
> it, so a from-scratch `electron-builder --mac` package is unreliable here. The
> script signs a **prebuilt** app in place, needing no Electron re-download.

One-time prereqs and the manual steps behind the script are below.

---

## Background: why the "malware" warning happened

macOS Gatekeeper shows **"Crew.app was not opened because it contains malware"**
when a **downloaded** (browser-quarantined) copy of an app is **not notarized by
Apple**. Before notarization Crew was **ad-hoc signed** (`identity: null`), which
runs locally but trips that wall on download. Two ways to ship a clean app follow;
**Option B (notarization) is what Crew now uses.**

---

## Historical unsigned distribution (no longer supported)

Early releases avoided quarantine rather than notarizing the application.
That is not the current installation or release policy. The installer now
requires the expected Developer ID, architecture, version, and notarization
before replacing the installed app. It does not remove quarantine or bypass
Gatekeeper. Investigate a verification failure instead of stripping protection.

---

## Note for corporate-managed Macs (Microsoft Defender / MDM)

On a Mac enrolled in MDM with **Microsoft Defender for Endpoint** (or similar EDR),
an **un-notarized** app can be quarantined automatically: Defender may move
`Crew.app` **to the Trash** within a minute of launch, independent of the Gatekeeper
dialog. `mdatp threat list` can still say *"No threats"* because this is
policy-driven app control / tamper protection, not a named malware detection.

The reliable fix — now in place — is **Option B (Developer ID + notarization)**: a
notarized app from a known Developer ID is trusted and is not hit by the
unsigned-app heuristic. If your org also enforces strict app allow-listing, ask IT
to allow the bundle id `com.alexselig.crew`.

> ⚠️ On this machine, running from source did **not** help: the corporate npm proxy
> (`packagefeedproxy.microsoft.io`) serves an **unsigned** Electron whose broken
> ad-hoc signature makes AMFI `SIGKILL` it, and Defender deletes it outright — so
> `npm run dev` and any ad-hoc packaged build are both blocked. Notarization is the
> only path that works here. `mdatp` folder exclusions did not override the policy.

---

## Option B — Real fix: Developer ID + notarization ($99/yr)

This is the current distribution model. After one-time setup, use
`scripts/sign-notarize.sh`; `npm run dist` alone does not notarize the app.

### 1. Enroll & get a certificate
1. Join the **Apple Developer Program**: https://developer.apple.com/programs/enroll/ ($99/yr).
2. Create a **Developer ID Application** certificate (Xcode ▸ Settings ▸ Accounts ▸
   Manage Certificates ▸ **+** ▸ *Developer ID Application*, or via
   developer.apple.com ▸ Certificates).
3. Confirm it landed in your login keychain:
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (TEAMID)"
   ```

### 2. Notarization credentials
1. At https://appleid.apple.com ▸ Sign-In and Security ▸ **App-Specific Passwords**,
   generate one (e.g. `crew-notarize`).
2. Note your **Team ID** (developer.apple.com ▸ Membership, or the `(TEAMID)` in the
   cert name).
3. Export before building (add to your shell profile or a local, git-ignored file):
   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="ABCDE12345"
   ```

### 3. Flip on signing in `electron-builder.yml`
Replace the `mac:` block's `identity: null` with the notarized profile (the exact
lines are staged as comments in `electron-builder.yml`):

```yaml
mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  hardenedRuntime: true          # required for notarization
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true                 # electron-builder ≥24 uses notarytool
  # identity is auto-discovered from the keychain; or pin it:
  # identity: "Developer ID Application: Your Name (ABCDE12345)"
  target:
    - dmg
    - zip
```

`build/entitlements.mac.plist` (already committed) grants the JIT / unsigned-memory
entitlements Electron + node-pty need under the hardened runtime.

### 4. Build, verify, publish
```bash
npm run dist
spctl -a -vvv -t exec dist/mac-arm64/Crew.app
#   → "accepted"  source=Notarized Developer ID
stapler validate dist/mac-arm64/Crew.app
```
The configuration above is an alternative for unmanaged environments, not the
checked-in setup. This repository intentionally keeps `identity: null` and uses
the separate signing script. Publish through the draft-first flow in
[RELEASING.md](./RELEASING.md).

---

## Why not just re-sign ad-hoc?
Re-signing ad-hoc does **not** change the verdict — Gatekeeper blocks *quarantined,
un-notarized* apps regardless of how clean the ad-hoc signature is. Only Apple
notarization is supported for Crew releases; do not bypass quarantine.
