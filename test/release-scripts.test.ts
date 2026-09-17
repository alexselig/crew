import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(version = '0.6.0', architecture = 'arm64', bundleId = 'com.alexselig.crew') {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sign-preflight-'))
  directories.push(dir)
  const app = join(dir, 'dist', 'mac-arm64', 'Crew.app')
  const bin = join(dir, 'bin')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  const native = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(native, { recursive: true })
  writeFileSync(join(native, 'pty.node'), 'fixture')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.6.0' }))
  writeFileSync(join(app, 'Contents', 'MacOS', 'Crew'), 'fixture')
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
</dict></plist>`)
  copyFileSync(resolve('scripts/sign-notarize.sh'), join(dir, 'scripts', 'sign-notarize.sh'))
  copyFileSync(resolve('scripts/codesign-retry.sh'), join(dir, 'scripts', 'codesign-retry.sh'))
  const executable = (path: string, body: string) => writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 })
  executable(join(dir, 'node_modules', '.bin', 'electron-osx-sign'), 'printf "%s\\n" "$@" > sign.args; touch signed.marker')
  executable(join(bin, 'codesign'), 'exit 0')
  executable(join(bin, 'lipo'), `printf '%s\\n' '${architecture}'`)
  executable(join(bin, 'xcrun'), 'printf "%s\\n" "$*" > notary.args; exit 1')
  executable(join(bin, 'ditto'), 'exit 0')
  const run = (arch = 'arm64') => spawnSync('/bin/bash', ['scripts/sign-notarize.sh'], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CREW_APP: app,
      CREW_ARCH: arch,
      CREW_REAL_CODESIGN: join(bin, 'codesign'),
      CREW_CODESIGN_RETRY_DELAY: '0'
    }
  })
  return { dir, run }
}

describe.skipIf(process.platform !== 'darwin')('release signing preflight', () => {
  it.each([
    ['wrong version', '0.5.14', 'arm64', 'com.alexselig.crew', 'arm64'],
    ['wrong architecture', '0.6.0', 'x86_64', 'com.alexselig.crew', 'arm64'],
    ['wrong bundle identifier', '0.6.0', 'arm64', 'other.app', 'arm64'],
    ['unknown target architecture', '0.6.0', 'arm64', 'com.alexselig.crew', 'typo']
  ])('refuses signing a bundle with %s', (_name, version, architecture, bundleId, target) => {
    const { dir, run } = fixture(version, architecture, bundleId)
    expect(run(target).status).not.toBe(0)
    expect(existsSync(join(dir, 'signed.marker'))).toBe(false)
  })

  function publisherFixture(mode = 'missing', windows = false) {
    const dir = mkdtempSync(join(tmpdir(), 'crew-publish-preflight-'))
    directories.push(dir)
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'dist'))
    copyFileSync(resolve('scripts/publish.sh'), join(dir, 'scripts', 'publish.sh'))
    writeFileSync(join(dir, 'package.json'), '{"version":"0.6.0"}')
    writeFileSync(join(dir, 'install.sh'), '# fixture installer\n')
    for (const arch of ['arm64', 'x64']) {
      writeFileSync(join(dir, 'dist', `Crew-0.6.0-${arch}-mac.zip`), `zip ${arch}`)
      writeFileSync(join(dir, 'dist', `Crew-0.6.0-${arch}.dmg`), `dmg ${arch}`)
    }
    if (windows) {
      for (const name of ['Crew-0.6.0-win.zip', 'Crew-Setup-0.6.0.exe', 'Crew-Setup.exe']) {
        writeFileSync(join(dir, 'dist', name), 'windows fixture')
      }
    }
    const executable = (name: string, body: string) =>
      writeFileSync(join(dir, 'bin', name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 })
    executable('git', `
  case "$1" in
    status) [ "$CREW_TEST_MODE" != dirty ] || echo " M package.json" ;;
    rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    ls-remote) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/main\\n' ;;
    *) exit 1 ;;
  esac`)
    executable('gh', `
  case "$1 $2" in
    'auth token') echo fixture-token ;;
    'api graphql')
      if [ "$CREW_TEST_MODE" = api-error ]; then echo 'Lookup unavailable' >&2; exit 1; fi
      if [ "$CREW_TEST_MODE" != missing ] || [ -f created.marker ]; then echo 123; fi ;;
    'api repos/alexselig/crew/releases/tags/'*)
      echo '{"message":"Not Found"}'; exit 1 ;;
    api*)
      if [ "$CREW_TEST_MODE" = missing ] && [ ! -f created.marker ]; then
        echo '{"message":"Not Found"}'; exit 1
      fi
      node release-fixture.cjs ;;
    'release create') touch created.marker; printf '%s\\n' "$*" > create.args ;;
    'release upload')
      if [ "$CREW_TEST_MODE" = missing ] && [ ! -f created.marker ]; then exit 1; fi
      touch uploaded.marker ;;
    'release download')
      while [ "$1" != --dir ]; do shift; done
      cp dist/* "$2/"
      cp install.sh "$2/" ;;
    'release edit') touch published.marker ;;
    'run list') echo '[{"status":"completed","conclusion":"success"}]' ;;
    *) exit 1 ;;
  esac`)
    executable('curl', 'exit 0')
    writeFileSync(join(dir, 'release-fixture.cjs'), `
  const fs = require('node:fs'), crypto = require('node:crypto')
  const assets = [...fs.readdirSync('dist').map(name => ['dist/' + name, name]), ['install.sh', 'install.sh']]
    .map(([file, name]) => {
      const bytes = fs.readFileSync(file)
      return { name, size: bytes.length, state: 'uploaded', digest: process.env.CREW_TEST_MODE === 'corrupt'
        ? 'sha256:invalid' : 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') }
    })
  console.log(JSON.stringify({ draft: process.env.CREW_TEST_MODE !== 'public',
    target_commitish: process.env.CREW_TEST_MODE === 'wrong-target' ? 'other' : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    assets }))
  `)
    const run = (publish = false, tag = 'v0.6.0') =>
      spawnSync('/bin/bash', ['scripts/publish.sh', tag], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
        env: {
          ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          CREW_SKIP_SIGN: '1', CREW_PUBLISH: publish ? '1' : '0', CREW_TEST_MODE: mode
        }
      })
    return { dir, run }
  }

  describe.skipIf(process.platform === 'win32')('draft-first release publication', () => {
    it.each(['public', 'wrong-target', 'dirty'])('refuses %s release state before upload', mode => {
      const { dir, run } = publisherFixture(mode)
      expect(run().status).not.toBe(0)
      expect(existsSync(join(dir, 'uploaded.marker'))).toBe(false)
    })

    it('refuses a tag that differs from the package version', () => {
      const { dir, run } = publisherFixture()
      expect(run(false, 'v0.5.14').status).not.toBe(0)
      expect(existsSync(join(dir, 'uploaded.marker'))).toBe(false)
    })

    it('does not treat a failed draft lookup as an absent release', () => {
      const { dir, run } = publisherFixture('api-error')
      expect(run().status).not.toBe(0)
      expect(existsSync(join(dir, 'created.marker'))).toBe(false)
      expect(existsSync(join(dir, 'uploaded.marker'))).toBe(false)
    })

    it('creates a missing draft at the exact commit without publishing it', () => {
      const { dir, run } = publisherFixture()
      expect(run().status).toBe(0)
      expect(readFileSync(join(dir, 'create.args'), 'utf8')).toContain('--draft --target aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(existsSync(join(dir, 'uploaded.marker'))).toBe(true)
      expect(existsSync(join(dir, 'published.marker'))).toBe(false)
    })

    it('rejects uploaded digests that differ from local artifacts', () => {
      const { dir, run } = publisherFixture('corrupt')
      expect(run(true).status).not.toBe(0)
      expect(existsSync(join(dir, 'published.marker'))).toBe(false)
    })

    it('does not publish without Windows downloads', () => {
      const { dir, run } = publisherFixture('draft')
      expect(run(true).status).not.toBe(0)
      expect(existsSync(join(dir, 'published.marker'))).toBe(false)
    })

    it('publishes only after all required downloads and aliases match', () => {
      const { dir, run } = publisherFixture('draft', true)
      expect(run(true).status).toBe(0)
      expect(existsSync(join(dir, 'published.marker'))).toBe(true)
    })
  })

  it('uses an architecture-specific archive for notarization', () => {
    const { dir, run } = fixture()
    const result = run()
    expect(result.status, result.stderr).not.toBeNull()
    expect(existsSync(join(dir, 'signed.marker'))).toBe(true)
    expect(readFileSync(join(dir, 'notary.args'), 'utf8')).toContain('dist/.crew-notarize-arm64.zip')
  })

  it('uses Apple timestamp service explicitly for app and DMG signatures', () => {
    const source = readFileSync(resolve('scripts/sign-notarize.sh'), 'utf8')
    expect(source).toContain('TIMESTAMP_URL="${CREW_TIMESTAMP_URL:-http://timestamp.apple.com/ts01}"')
    expect(source).toContain('--timestamp="$TIMESTAMP_URL"')
    expect(source).toContain('--timestamp="$TIMESTAMP_URL" "$DMG"')
  })

  it('does not individually sign Electron non-code resources', () => {
    const { dir, run } = fixture()
    run()
    expect(readFileSync(join(dir, 'sign.args'), 'utf8')).toContain('--ignore=\\.(pak|nib|dat|bin|asar|icns)$')
  })

  it('retries each codesign operation and expands a bare timestamp argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-codesign-retry-'))
    directories.push(dir)
    const fake = join(dir, 'codesign')
    const count = join(dir, 'count')
    const args = join(dir, 'args')
    writeFileSync(fake, `#!/bin/bash
count=0
[ ! -f "$CREW_TEST_COUNT" ] || count="$(cat "$CREW_TEST_COUNT")"
count=$((count + 1))
echo "$count" > "$CREW_TEST_COUNT"
printf '%s\n' "$@" > "$CREW_TEST_ARGS"
[ "$count" -ge 2 ]
`, { mode: 0o700 })

    const result = spawnSync('/bin/bash', [resolve('scripts/codesign-retry.sh'), '--force', '--timestamp', 'Crew.app'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CREW_REAL_CODESIGN: fake,
        CREW_CODESIGN_RETRIES: '2',
        CREW_CODESIGN_RETRY_DELAY: '0',
        CREW_TEST_COUNT: count,
        CREW_TEST_ARGS: args
      }
    })

    expect(result.status).toBe(0)
    expect(readFileSync(count, 'utf8').trim()).toBe('2')
    expect(readFileSync(args, 'utf8')).toContain('--timestamp=http://timestamp.apple.com/ts01')
  })

  it('accepts a valid current signature after codesign reports a timestamp failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-codesign-existing-signature-'))
    directories.push(dir)
    const fake = join(dir, 'codesign')
    const count = join(dir, 'count')
    writeFileSync(fake, `#!/bin/bash
case "$1" in
  --verify) [ -f "$CREW_TEST_COUNT" ] && exit 0 || exit 1 ;;
  -d*)
    echo "Authority=$CREW_EXPECTED_AUTHORITY" >&2
    echo "Timestamp=Sep 17, 2026 at 8:29:45 AM" >&2
    exit 0
    ;;
esac
count=0
[ ! -f "$CREW_TEST_COUNT" ] || count="$(cat "$CREW_TEST_COUNT")"
echo "$((count + 1))" > "$CREW_TEST_COUNT"
exit 1
`, { mode: 0o700 })

    const result = spawnSync('/bin/bash', [resolve('scripts/codesign-retry.sh'), '--sign', 'fixture', '--timestamp', 'locale.pak'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CREW_REAL_CODESIGN: fake,
        CREW_EXPECTED_AUTHORITY: 'Developer ID Application: Test Signer (TEAMID)',
        CREW_CODESIGN_RETRIES: '2',
        CREW_CODESIGN_RETRY_DELAY: '0',
        CREW_TEST_COUNT: count
      }
    })

    expect(result.status).toBe(0)
    expect(readFileSync(count, 'utf8').trim()).toBe('1')
  })

  it('does not submit an already valid timestamped signature again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-codesign-skip-valid-'))
    directories.push(dir)
    const fake = join(dir, 'codesign')
    const submitted = join(dir, 'submitted')
    writeFileSync(fake, `#!/bin/bash
case "$1" in
  --verify) exit 0 ;;
  -d*)
    echo "Authority=$CREW_EXPECTED_AUTHORITY" >&2
    echo "Timestamp=Sep 17, 2026 at 8:29:45 AM" >&2
    exit 0
    ;;
esac
touch "$CREW_TEST_SUBMITTED"
exit 1
`, { mode: 0o700 })

    const result = spawnSync('/bin/bash', [resolve('scripts/codesign-retry.sh'), '--sign', 'fixture', '--timestamp', 'locale.pak'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CREW_REAL_CODESIGN: fake,
        CREW_EXPECTED_AUTHORITY: 'Developer ID Application: Test Signer (TEAMID)',
        CREW_CODESIGN_RETRIES: '1',
        CREW_TEST_SUBMITTED: submitted
      }
    })

    expect(result.status).toBe(0)
    expect(existsSync(submitted)).toBe(false)
  })

  it('does not replace a requested deep verification with the signature shortcut', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-codesign-verify-'))
    directories.push(dir)
    const fake = join(dir, 'codesign')
    writeFileSync(fake, `#!/bin/bash
if [ "$1" = "--verify" ] && [ "$2" = "--deep" ]; then exit 1; fi
if [ "$1" = "--verify" ]; then exit 0; fi
if [[ "$1" = -d* ]]; then
  echo "Authority=$CREW_EXPECTED_AUTHORITY" >&2
  echo "Timestamp=Sep 17, 2026 at 8:29:45 AM" >&2
  exit 0
fi
exit 1
`, { mode: 0o700 })

    const result = spawnSync('/bin/bash', [resolve('scripts/codesign-retry.sh'), '--verify', '--deep', 'Crew.app'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CREW_REAL_CODESIGN: fake,
        CREW_EXPECTED_AUTHORITY: 'Developer ID Application: Test Signer (TEAMID)',
        CREW_CODESIGN_RETRIES: '1'
      }
    })

    expect(result.status).not.toBe(0)
  })
})
