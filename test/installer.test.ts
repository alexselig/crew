import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

// Project-local scratch space avoids the shared system temp directory. Every
// potentially destructive/platform-specific command is intercepted as well.
const roots: string[] = []
const installer = resolve('install.sh')
type Options = {
  arch?: string
  invalid?: string
  fail?: string
  running?: boolean
  refuseQuit?: boolean
  alternatives?: boolean
}

function fixture(options: Options = {}) {
  const root = mkdtempSync(resolve('.installer-test-'))
  roots.push(root)
  const destination = join(root, 'Applications with spaces')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  for (const dir of [destination, bin, home]) mkdirSync(dir)
  const app = join(destination, 'Crew.app')
  mkdirSync(app)
  writeFileSync(join(app, 'old'), 'working previous bundle')
  const support = join(home, 'Library/Application Support/crew')
  mkdirSync(support, { recursive: true })
  for (const name of ['sentinel', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    writeFileSync(join(support, name), 'user-owned')
  }
  const source = join(root, 'fixture/Crew.app')
  mkdirSync(join(source, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(source, 'new'), 'new bundle')
  writeFileSync(join(source, 'Contents/MacOS/Crew'), 'fixture executable')
  mkdirSync(join(source, 'Contents/Resources'), { recursive: true })
  writeFileSync(join(source, 'Contents/Resources/addon.node'), 'fixture native module')
  const ptyRoot = 'Contents/Resources/app.asar.unpacked/node_modules/node-pty'
  const nativeFiles = [`${ptyRoot}/build/Release/pty.node`, `${ptyRoot}/build/Release/spawn-helper`]
  if (options.alternatives) {
    nativeFiles.push(
      `${ptyRoot}/bin/darwin-arm64-125/node-pty.node`,
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
      'Contents/Frameworks/Crew Helper.app/Contents/MacOS/Crew Helper'
    )
    for (const platform of ['win32', 'darwin']) {
      for (const arch of ['arm64', 'x64']) {
        nativeFiles.push(`${ptyRoot}/prebuilds/${platform}-${arch}/pty.node`)
        if (platform === 'darwin') nativeFiles.push(`${ptyRoot}/prebuilds/${platform}-${arch}/spawn-helper`)
        else nativeFiles.push(`${ptyRoot}/prebuilds/${platform}-${arch}/conpty.node`)
      }
    }
  }
  for (const name of nativeFiles) {
    const file = join(source, name)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, 'fixture native executable')
  }
  writeFileSync(join(source, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${options.invalid === 'bundle' ? 'com.other.app' : 'com.alexselig.crew'}</string>
<key>CFBundleShortVersionString</key><string>${options.invalid === 'version' ? '0.1.0' : '1.2.3'}</string>
<key>CFBundleExecutable</key><string>Crew</string>
</dict></plist>`)
  const zip = join(root, 'fixture.zip')
  const packed = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zip])
  if (packed.status !== 0) throw new Error('Could not generate isolated zip fixture')
  const urls = ['x64', 'arm64'].map(arch => `https://github.com/alexselig/crew/releases/download/v1.2.3/Crew-1.2.3-${arch}-mac.zip`)
  if (options.arch === 'x86_64') urls.reverse()
  writeFileSync(join(root, 'release.json'), JSON.stringify({
    tag_name: 'v1.2.3',
    assets: urls.map(browser_download_url => ({
      name: browser_download_url.split('/').pop(), browser_download_url
    }))
  }))
  writeFileSync(join(root, 'options.json'), JSON.stringify(options))
  if (options.running) writeFileSync(join(root, 'running'), '')
  const shim = join(bin, 'shim.cjs')
  writeFileSync(shim, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2), cmd = path.basename(process.argv[1]);
const opts = JSON.parse(fs.readFileSync(path.join(root, 'options.json'), 'utf8'));
const dst = path.join(root, 'Applications with spaces', 'Crew.app');
const running = path.join(root, 'running');
const exists = p => fs.existsSync(p);
const log = (command, argv) => fs.appendFileSync(path.join(root, 'events'), JSON.stringify({command, args:argv})+'\\n');
const safe = p => { if (!path.resolve(p).startsWith(root + '/')) throw Error('Blocked path outside fixture'); };
const real = (command, argv) => { const r = cp.spawnSync(command, argv, {stdio:'inherit'}); process.exit(r.status ?? 1); };
log(cmd,args);
switch(cmd) {
case 'uname': console.log(args[0] === '-s' ? 'Darwin' : opts.arch || 'arm64'); break;
case 'curl': {
  const out = args.indexOf('-o');
  const api = args.some(x=>x.includes('api.github.com'));
  const data = fs.readFileSync(path.join(root, api ? 'release.json' : 'fixture.zip'));
  if(out >= 0) { safe(args[out+1]); fs.writeFileSync(args[out+1],data); } else process.stdout.write(data);
  break;
}
case 'mktemp': {
  const template = args.find(x => x.includes('XXXXXX')) || path.join(root,'download.XXXXXX');
  safe(template); real('/usr/bin/mktemp',['-d',template]); break;
}
case 'mkdir':
  args.filter(x=>!x.startsWith('-')).forEach(safe); real('/bin/mkdir',args); break;
case 'rmdir':
  args.filter(x=>!x.startsWith('-')).forEach(safe); real('/bin/rmdir',args); break;
case 'rm':
  args.filter(x=>!x.startsWith('-')).forEach(safe); real('/bin/rm',args); break;
case 'ditto': {
  const target = args[args.length-1]; safe(target);
  if(args.includes('-x')) real('/usr/bin/ditto',args);
  if(opts.fail === 'copy') { fs.mkdirSync(target,{recursive:true}); fs.writeFileSync(path.join(target,'partial'),''); process.exit(1); }
  real('/usr/bin/ditto',args); break;
}
case 'mv': {
  const paths = args.filter(x=>!x.startsWith('-')); paths.forEach(safe);
  if(opts.fail === 'promote' && paths[1] === dst && !paths[0].endsWith('/previous.app')) process.exit(1);
  if(opts.fail === 'rollback' && paths[0].endsWith('/previous.app')) process.exit(1);
  if((opts.fail === 'interrupt-backup' && paths[1].endsWith('/previous.app')) ||
     (opts.fail === 'interrupt-promote' && paths[1] === dst && !paths[0].endsWith('/previous.app'))) {
    const result = cp.spawnSync('/bin/mv',args);
    if(result.status !== 0) process.exit(1);
    process.kill(process.ppid,'SIGTERM'); break;
  }
  real('/bin/mv',args); break;
}
case 'codesign':
  if(opts.invalid === 'signature') process.exit(1);
  if(opts.invalid === 'staged' && args.some(x=>x.endsWith('/Crew.app') && !x.includes('/unpack/'))) process.exit(1);
  if(args.some(x=>x.startsWith('-d'))) console.error('Authority=Developer ID Application: Aaron Selig (42KAR3VVM7)\\nTeamIdentifier='+(opts.invalid === 'team' ? 'WRONGTEAM' : '42KAR3VVM7'));
  break;
case 'spctl':
  if(opts.invalid === 'notarization') process.exit(1);
  console.error('accepted\\nsource='+(opts.invalid === 'unnotarized' ? 'Developer ID' : 'Notarized Developer ID')); break;
case 'lipo': {
  const file = args[args.length-1];
  if(file.includes('/prebuilds/win32-')) process.exit(1);
  const alternate = file.match(/\\/(?:prebuilds|bin)\\/darwin-(arm64|x64)(?:-|\\/)/);
  const invalid = opts.invalid === 'arch' ||
    (opts.invalid === 'native' && file.endsWith('.node')) ||
    (opts.invalid === 'active-pty' && file.endsWith('/build/Release/pty.node')) ||
    (opts.invalid === 'spawn-helper' && file.endsWith('/build/Release/spawn-helper')) ||
    (opts.invalid === 'framework' && file.endsWith('/Electron Framework')) ||
    (opts.invalid === 'helper' && file.endsWith('/MacOS/Crew Helper'));
  console.log(invalid ? 'wrong-arch' : alternate ? (alternate[1] === 'x64' ? 'x86_64' : 'arm64') : (opts.arch === 'x86_64' ? 'x86_64' : 'arm64'));
  break;
}
case 'pgrep':
  process.exit(exists(running) ? 0 : 1); break;
case 'osascript':
  if(!opts.refuseQuit && exists(running)) fs.unlinkSync(running); break;
case 'open':
  if(exists(path.join(dst,'new')) && opts.fail === 'open-partial') { fs.writeFileSync(running,''); process.exit(1); }
  if(exists(path.join(dst,'new')) && ['open','rollback'].includes(opts.fail)) process.exit(1);
  if(opts.fail !== 'launch') fs.writeFileSync(running,''); break;
case 'sleep': break;
case 'xattr': throw Error('Installer must not bypass Gatekeeper');
default: throw Error('Unexpected mock command');
}
`)
  chmodSync(shim, 0o755)
  for (const command of ['uname', 'curl', 'mktemp', 'mkdir', 'rmdir', 'rm', 'ditto', 'mv', 'codesign', 'spctl', 'lipo', 'pgrep', 'osascript', 'open', 'sleep', 'xattr']) {
    symlinkSync('shim.cjs', join(bin, command))
  }
  return {
    root, app, support, destination,
    run() {
      const result = spawnSync('/bin/bash', [installer], {
        cwd: root,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: home, TMPDIR: root, FIXTURE_ROOT: root, CREW_INSTALL_DIR: destination
        },
        encoding: 'utf8',
        timeout: 30_000
      })
      if (result.error) throw result.error
      return { status: result.status, output: result.stdout + result.stderr }
    },
    events(): Array<{ command: string; args: string[] }> {
      return readFileSync(join(root, 'events'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('transactional macOS installer', () => {
  it.each(['arm64', 'x86_64'])('accepts the %s package with inactive Windows and opposite-architecture PTY alternatives', arch => {
    const f = fixture({ arch, alternatives: true })
    const result = f.run()
    expect(result.status, result.output).toBe(0)
    const inspected = f.events().filter(e => e.command === 'lipo').map(e => e.args.at(-1)!)
    expect(inspected.some(path => path.endsWith('/build/Release/pty.node'))).toBe(true)
    expect(inspected.some(path => path.endsWith('/build/Release/spawn-helper'))).toBe(true)
    expect(inspected.some(path => path.includes('/node-pty/prebuilds/') || path.includes('/node-pty/bin/'))).toBe(false)
  })

  it.each([
    ['active-pty', '/build/Release/pty.node'],
    ['spawn-helper', '/build/Release/spawn-helper'],
    ['framework', '/Electron Framework'],
    ['helper', '/MacOS/Crew Helper']
  ])('rejects a wrong active %s architecture even when inactive alternatives exist', (invalid, suffix) => {
    const f = fixture({ invalid, alternatives: true, running: true })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(result.output).toContain(`Native architecture mismatch`)
    expect(result.output).toContain(suffix)
    expect(f.events().some(e => e.command === 'osascript')).toBe(false)
    expect(existsSync(join(f.app, 'old'))).toBe(true)
  })

  it.each(['arm64', 'x86_64'])('selects the exact %s asset despite opposite architecture listed first', arch => {
    const f = fixture({ arch })
    const result = f.run()
    expect(result.status, result.output).toBe(0)
    const download = f.events().find(e => e.command === 'curl' && e.args.some(a => a.endsWith('-mac.zip')))
    expect(download?.args.join(' ')).toContain(`Crew-1.2.3-${arch === 'arm64' ? 'arm64' : 'x64'}-mac.zip`)
    expect(existsSync(join(f.app, 'new'))).toBe(true)
  })

  it.each(['bundle', 'version', 'signature', 'team', 'notarization', 'unnotarized', 'arch', 'native', 'staged'])('rejects invalid %s before quitting or replacing', invalid => {
    const f = fixture({ invalid, running: true })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(f.events().some(e => e.command === 'osascript')).toBe(false)
    expect(existsSync(join(f.app, 'old'))).toBe(true)
  })

  it('leaves the old app running when the staged copy fails', () => {
    const f = fixture({ fail: 'copy', running: true })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(existsSync(join(f.app, 'old'))).toBe(true)
    expect(f.events().some(e => e.command === 'osascript')).toBe(false)
  })

  it.each(['promote', 'open', 'launch', 'interrupt-backup', 'interrupt-promote'])('restores the previous bundle after %s failure', fail => {
    const f = fixture({ fail })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(existsSync(join(f.app, 'old'))).toBe(true)
    expect(existsSync(join(f.app, 'new'))).toBe(false)
    expect(f.events().some(e => e.command === 'mv' && e.args.some(a => a.endsWith('/previous.app')))).toBe(true)
  })

  it('refuses to replace an app that will not quit', () => {
    const f = fixture({ running: true, refuseQuit: true })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(existsSync(join(f.app, 'old'))).toBe(true)
    expect(f.events().some(e => e.command === 'mv')).toBe(false)
  })

  it('preserves user data and Electron locks on successful replacement', () => {
    const f = fixture({ running: true })
    const result = f.run()
    expect(result.status, result.output).toBe(0)
    for (const name of ['sentinel', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(readFileSync(join(f.support, name), 'utf8')).toBe('user-owned')
    }
    const events = f.events()
    expect(events.filter(e => e.command === 'codesign' && e.args.includes('--verify'))).toHaveLength(2)
    expect(events.findIndex(e => e.command === 'ditto' && !e.args.includes('-x')))
      .toBeLessThan(events.findIndex(e => e.command === 'osascript'))
    expect(readdirSync(f.destination)).toEqual(['Crew.app'])
  })

  it.each(['rollback', 'open-partial'])('preserves and reports the exact backup path after %s prevents rollback', fail => {
    const f = fixture({ fail, refuseQuit: true })
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    const stage = readdirSync(f.destination).find(name => name.startsWith('.crew-install.') && name !== '.crew-install.lock')
    expect(stage).toBeTruthy()
    const backup = join(f.destination, stage!, 'previous.app')
    expect(readFileSync(join(backup, 'old'), 'utf8')).toBe('working previous bundle')
    expect(result.output).toContain(backup)
    expect(f.events().filter(e => e.command === 'rm').every(e => !e.args.includes(join(f.destination, stage!)))).toBe(true)
  })

  it('does not steal an existing installer lock', () => {
    const f = fixture()
    mkdirSync(join(f.destination, '.crew-install.lock'))
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(existsSync(join(f.destination, '.crew-install.lock'))).toBe(true)
    expect(f.events().some(e => e.command === 'curl')).toBe(false)
  })

  it('refuses a release without the matching asset rather than falling back', () => {
    const f = fixture({ running: true })
    writeFileSync(join(f.root, 'release.json'), JSON.stringify({
      tag_name: 'v1.2.3',
      assets: [{
        name: 'Crew-1.2.3-x64-mac.zip',
        browser_download_url: 'https://github.com/alexselig/crew/releases/download/v1.2.3/Crew-1.2.3-x64-mac.zip'
      }]
    }))
    const result = f.run()
    expect(result.status, result.output).not.toBe(0)
    expect(result.output).toContain('Crew-1.2.3-arm64-mac.zip')
    expect(existsSync(join(f.app, 'old'))).toBe(true)
    expect(f.events().some(e => e.command === 'osascript' || e.command === 'ditto')).toBe(false)
  })
})
