# Shipping Crew without the "malware" warning

macOS Gatekeeper shows **"Crew.app was not opened because it contains malware"**
when a **downloaded** (browser-quarantined) copy of the app is **not notarized by
Apple**. Crew is currently built **ad-hoc signed** (`identity: null`), which is
fine to run locally but trips that wall on download.

There are two ways to ship a clean app. Pick based on whether you have an Apple
Developer account.

---

## Option A — Free, no Apple account (what ships today)

Distribute via the one-command installer, which downloads with `curl` (curl does
**not** set the `com.apple.quarantine` flag a browser would) and strips quarantine
defensively:

```bash
curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
```

The app is unchanged; only the *delivery* avoids the quarantine flag, so Gatekeeper
never blocks it. Anyone who instead double-clicks the `.dmg` from a browser can
clear it manually once:

```bash
xattr -cr /Applications/Crew.app   # after dragging Crew into Applications
```

> On modern macOS the "malware" verdict suppresses the right-click ▸ Open and the
> System Settings ▸ "Open Anyway" shortcuts, so the `xattr` command (or the
> installer) is the reliable fix.

---

## Note for corporate-managed Macs (Microsoft Defender / MDM)

On a Mac enrolled in MDM with **Microsoft Defender for Endpoint** (or similar EDR),
an **un-notarized** app can be quarantined automatically: Defender may move
`Crew.app` **to the Trash** within a minute of launch, independent of the Gatekeeper
dialog. `mdatp threat list` can still say *"No threats"* because this is
policy-driven app control / tamper protection, not a named malware detection.

The reliable fix is **Option B (Developer ID + notarization)** below — a notarized
app from a known Developer ID is trusted and is not hit by the unsigned-app
heuristic. If your org also enforces strict app allow-listing, ask IT to allow the
bundle id `com.alexselig.crew`.

Until the app is notarized, run Crew from source rather than the packaged bundle
(dev mode is not remediated):

```bash
npm install && npm run dev
```

---

## Option B — Real fix: Developer ID + notarization ($99/yr)

This makes a **browser download open with zero warnings** for everyone. One-time
setup, then `npm run dist` signs + notarizes automatically.

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
Then publish the `dmg`/`zip` as usual. Notarized downloads open with no prompt, so
the `install.sh` workaround becomes optional.

---

## Why not just re-sign ad-hoc?
Re-signing ad-hoc does **not** change the verdict — Gatekeeper blocks *quarantined,
un-notarized* apps regardless of how clean the ad-hoc signature is. Only Apple
notarization (Option B) or avoiding the quarantine flag (Option A) removes the wall.
