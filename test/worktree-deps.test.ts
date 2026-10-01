import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** `lstat` without throwing, so a missing path reads as "no link" rather than an error. */
function lstatSyncSafe(path: string) {
  try { return lstatSync(path) } catch { return null }
}

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake repo with N worktrees, so we can exercise the script's decisions
 * without a real 1 GB install.
 *
 * The script finds worktrees via `git worktree list --porcelain`, so the
 * fixture stubs `git` on PATH rather than building a real repo -- building one
 * would make the test depend on git's worktree layout, which is not what is
 * under test here.
 */
function fixture(worktrees: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-worktree-deps-'))
  directories.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(resolve('scripts/worktree-deps.sh'), join(dir, 'scripts', 'worktree-deps.sh'))
  chmodSync(join(dir, 'scripts', 'worktree-deps.sh'), 0o700)

  const paths = worktrees.map((name) => join(dir, name))
  for (const p of paths) mkdirSync(p, { recursive: true })

  // `git worktree list --porcelain`, `rev-parse --git-common-dir` and
  // `rev-parse --show-toplevel` are the only three git calls the script makes.
  const listing = join(dir, 'worktree-list.txt')
  writeFileSync(listing, paths.map((p) => `worktree ${p}\n`).join('\n'))
  writeFileSync(join(bin, 'git'), `#!/bin/bash
case "$*" in
  *"worktree list"*) cat ${JSON.stringify(listing)} ;;
  *"--git-common-dir"*) printf '%s\\n' "${dir}/.git" ;;
  *"--show-toplevel"*) printf '%s\\n' "$PWD" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })

  /** A node_modules that can run the tests and launch the app. */
  const completeInstall = (worktree: string) => {
    const nm = join(dir, worktree, 'node_modules')
    mkdirSync(join(nm, '.bin'), { recursive: true })
    writeFileSync(join(nm, '.bin', 'vitest'), '#!/bin/bash\n', { mode: 0o700 })
    mkdirSync(join(nm, 'electron', 'dist', 'Electron.app'), { recursive: true })
  }

  /** Packages present, Electron binary gone -- the common real-world breakage. */
  const installWithoutElectron = (worktree: string) => {
    const nm = join(dir, worktree, 'node_modules')
    mkdirSync(join(nm, '.bin'), { recursive: true })
    writeFileSync(join(nm, '.bin', 'vitest'), '#!/bin/bash\n', { mode: 0o700 })
  }

  const danglingLink = (worktree: string, target: string) => {
    symlinkSync(target, join(dir, worktree, 'node_modules'))
  }

  const run = (args: string[] = [], cwd = paths[0]) =>
    spawnSync('/bin/bash', [join(dir, 'scripts', 'worktree-deps.sh'), ...args], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    })

  /** The symlink's target, or null if there is no symlink there (including nothing at all). */
  const linkTarget = (worktree: string) => {
    const nm = join(dir, worktree, 'node_modules')
    const stat = lstatSyncSafe(nm)
    return stat?.isSymbolicLink() ? readlinkSync(nm) : null
  }

  return { dir, paths, run, completeInstall, installWithoutElectron, danglingLink, linkTarget }
}

describe('worktree-deps.sh', () => {
  it('points a worktree with nothing at the one complete install', () => {
    const f = fixture(['donor', 'empty'])
    f.completeInstall('donor')

    const result = f.run(['--all'])

    expect(result.status).toBe(0)
    // Relative, so the link survives the repo being moved or renamed.
    expect(f.linkTarget('empty')).toBe('../donor/node_modules')
  })

  it('repairs a link that points at a target which does not exist', () => {
    // This is the state every worktree started in: a committed symlink to
    // ../../node_modules, a path that was never populated.
    const f = fixture(['donor', 'broken'])
    f.completeInstall('donor')
    f.danglingLink('broken', '../../node_modules')

    expect(f.run(['--all']).status).toBe(0)
    expect(f.linkTarget('broken')).toBe('../donor/node_modules')
  })

  it('refuses to adopt a donor whose Electron binary has gone missing', () => {
    // Checking only for vitest is how a worktree passes `npm test` and then
    // dies at `npm start` with an ENOENT deep inside node_modules.
    const f = fixture(['half', 'empty'])
    f.installWithoutElectron('half')

    const result = f.run(['--all'])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('no Electron binary')
    expect(result.stdout).toContain('npx electron install')
    expect(f.linkTarget('empty')).toBeNull()
  })

  it('names the install command when nothing is installed anywhere', () => {
    const f = fixture(['a', 'b'])

    const result = f.run(['--all'])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('npm ci')
  })

  it('leaves a worktree that has its own complete install alone', () => {
    const f = fixture(['donor', 'independent'])
    f.completeInstall('donor')
    f.completeInstall('independent')

    expect(f.run(['--all']).status).toBe(0)
    expect(f.linkTarget('independent')).toBeNull()
  })

  it('does not chain one link through another', () => {
    // A symlink can never be the donor, or a repair would resolve through a
    // second hop and break the moment either end moved.
    const f = fixture(['donor', 'linked', 'empty'])
    f.completeInstall('donor')
    f.danglingLink('linked', '../donor/node_modules')

    expect(f.run(['--all']).status).toBe(0)
    expect(f.linkTarget('empty')).toBe('../donor/node_modules')
  })

  it('reports without changing anything under --check', () => {
    const f = fixture(['donor', 'empty'])
    f.completeInstall('donor')

    const result = f.run(['--check'], f.paths[1])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('needs linking')
    expect(f.linkTarget('empty')).toBeNull()
  })

  it('fixes only the worktree it is run from by default', () => {
    const f = fixture(['donor', 'here', 'elsewhere'])
    f.completeInstall('donor')

    expect(f.run([], f.paths[1]).status).toBe(0)
    expect(f.linkTarget('here')).toBe('../donor/node_modules')
    expect(f.linkTarget('elsewhere')).toBeNull()
  })

  it('is idempotent', () => {
    const f = fixture(['donor', 'empty'])
    f.completeInstall('donor')

    f.run(['--all'])
    const second = f.run(['--all'])

    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already linked')
    expect(f.linkTarget('empty')).toBe('../donor/node_modules')
  })

  it('rejects an unknown option rather than guessing', () => {
    const f = fixture(['donor'])
    f.completeInstall('donor')

    const result = f.run(['--force'])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown option')
  })
})
