# Running Crew on Windows

Crew now builds and runs on Windows, not just macOS. The app code is
cross-platform; the only thing that can't be produced on the maintainer's Mac is
the actual Windows binary, because `node-pty` is a native module that must be
compiled **on Windows** (it can't be cross-compiled from macOS, and a `.exe`
can't be test-run there either).

## What already works

- **Sessions** spawn PowerShell on Windows (instead of `/bin/zsh`); the command
  is overridable per preset or via the `CREW_SHELL` env var.
- **Paths** use `os.homedir()` / `path.basename()` so `~/.copilot` and
  `~/.claude` session state, labels, and the tracker resolve correctly.
- **Window** uses the native frame on Windows (working min/max/close) while macOS
  keeps its hidden-inset traffic-light chrome.
- **Tray** shows a white ring/dot icon (visible on the dark taskbar) with a
  tooltip that reflects how many sessions need you.
- **Packaging** is configured in `electron-builder.yml` (`win` → NSIS installer +
  portable zip) with `build/icon.ico`.

> Note: agent *todo* pull-through in the Project Tracker uses the `sqlite3` CLI,
> which macOS ships but Windows does not. On Windows those live todos are simply
> omitted (task-file TODO/STATUS/ROADMAP items still show). Install `sqlite3` and
> put it on `PATH` to re-enable them.

## Build it on a Windows machine

On any Windows 10/11 (x64) box with Node 22 + Git:

```powershell
git clone https://github.com/alexselig/crew
cd crew
npm ci
npm run rebuild:native   # compile node-pty for Electron (needs VS Build Tools)
npm run dist:win         # -> dist\Crew-Setup-<version>.exe  and  dist\Crew-<version>-win.zip
```

The installer is **unsigned** for now, so Windows SmartScreen shows a
"Windows protected your PC" prompt on first launch → **More info → Run anyway**.
(Signing needs an Authenticode certificate; add `win.certificateFile` +
`CSC_KEY_PASSWORD` later to remove the warning.)

## Build it in CI (recommended, no Windows machine needed)

A ready-to-use GitHub Actions workflow builds on a `windows-latest` runner and
attaches `Crew-Setup-<ver>.exe` + `Crew-Setup.exe` + the portable zip to the
matching GitHub Release.

**Why it isn't committed already:** adding files under `.github/workflows/`
requires a token with the `workflow` OAuth scope. The token that has push access
to this personal repo doesn't have that scope, so it must be added one of two
ways:

1. **GitHub web UI (easiest):** repo → **Add file → Create new file** →
   name it `.github/workflows/build-windows.yml` → paste the YAML below →
   **Commit**. The web editor is allowed to create workflow files.
2. **CLI:** `gh auth refresh -h github.com -s workflow`, then recreate the file
   from the YAML below and `git add .github/workflows/build-windows.yml && git push`.

After it exists, run it from the **Actions** tab (**Build Windows → Run
workflow**) and pass the release tag, e.g. `v0.3.0`. It also runs automatically
on any pushed `v*` tag.

<details>
<summary><code>.github/workflows/build-windows.yml</code></summary>

```yaml
# Builds the Windows installer + portable zip on a real Windows runner, because
# node-pty is a native module that must be compiled on Windows (it can't be
# cross-compiled from the maintainer's Mac). The build is unsigned for now, so
# Windows SmartScreen will warn until the download earns reputation.
name: Build Windows

on:
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag to attach the build to (e.g. v0.3.0). Blank = artifact only."
        required: false
        default: ""
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build-windows:
    # Pinned to windows-2022 (Visual Studio 2022 / v17). windows-latest now ships
    # Visual Studio 18, which the bundled @electron/node-gyp doesn't recognize
    # ("unsupported version: 18"), so node-pty fails to compile there.
    runs-on: windows-2022
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Rebuild native modules (node-pty) for Electron
        run: npm run rebuild:native

      - name: Build + package Windows installer & portable zip
        run: npm run dist:win

      - name: Stage a stable-named installer alias
        shell: pwsh
        run: |
          $exe = Get-ChildItem dist -Filter 'Crew-Setup-*.exe' | Select-Object -First 1
          if ($exe) { Copy-Item $exe.FullName 'dist/Crew-Setup.exe' -Force }

      - name: Upload workflow artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: crew-windows
          path: |
            dist/*.exe
            dist/*.zip
          if-no-files-found: error

      - name: Attach build to the GitHub Release
        if: startsWith(github.ref, 'refs/tags/') || inputs.tag != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        shell: pwsh
        run: |
          $tag = if ($env:GITHUB_REF -like 'refs/tags/*') {
            $env:GITHUB_REF -replace 'refs/tags/', ''
          } else {
            '${{ inputs.tag }}'
          }
          $repo = '${{ github.repository }}'
          Write-Host "Attaching Windows assets to release $tag"
          gh release view $tag --repo $repo 2>$null
          if ($LASTEXITCODE -ne 0) {
            gh release create $tag --repo $repo --title "Crew $tag" --notes "Windows build for $tag."
          }
          # Only the top-level installers/zip — NOT -Recurse, which would also grab
          # node-pty's bundled OpenConsole.exe/winpty-agent.exe from win-unpacked
          # (and their duplicate names break the upload).
          $assets = @()
          $assets += Get-ChildItem dist -Filter 'Crew-Setup-*.exe' | ForEach-Object { $_.FullName }
          if (Test-Path 'dist/Crew-Setup.exe') { $assets += (Resolve-Path 'dist/Crew-Setup.exe').Path }
          $assets += Get-ChildItem dist -Filter 'Crew-*-win.zip' | ForEach-Object { $_.FullName }
          gh release upload $tag $assets --repo $repo --clobber
```

</details>

## Wiring the website's Windows download

Once a Windows asset is attached to the latest release, add a Windows button to
`docs/index.html` pointing at the stable alias:

```
https://github.com/alexselig/crew/releases/latest/download/Crew-Setup.exe
```

(Don't add it before the asset exists, or the button will 404 — the same
stable-alias pattern used for `Crew-arm64.dmg` on macOS.)
