import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { conductorPaths, createConductorRuntime, InvalidWorkspaceIdError, samePath } from '../src/main/conductor-runtime'
import type { ConductorConfig } from '../src/shared/conductor'

// A real containment proof: `child` is inside-or-equal-to `parent` iff
// `path.relative` from parent to child does not climb out with a leading
// "..", and is not itself absolute (which `path.relative` returns when the
// two paths are on different Windows drives). A prefix check like
// `child.startsWith(parent)` is not equivalent — it also matches a sibling
// directory that merely shares parent as a string prefix, e.g. parent
// "/Users/test/data" wrongly "contains" "/Users/test/data-evil/x".
//
// Deliberately treats `parent === child` (rel === '') as contained: this is
// the worst case an "is this path outside the repo" assertion is meant to
// catch — a derived path that lands exactly on the repo root is not
// "outside" it, it *is* it. An earlier version of this helper returned
// false for that case, which would have let a bug that made a derived path
// equal `repo` slip past the "not contained in repo" assertion below.
const isContainedIn = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child))
  return !rel.startsWith('..') && !isAbsolute(rel)
}

describe('conductorPaths', () => {
  const userDataDir = '/Users/test/Library/Application Support/Crew'

  it('derives integrationWorktree, lanesDir and journal under <userData>/conductor/<workspaceId>', () => {
    const paths = conductorPaths(userDataDir, 'ws-1')
    expect(paths).toEqual({
      integrationWorktree: join(userDataDir, 'conductor', 'ws-1', 'integration'),
      lanesDir: join(userDataDir, 'conductor', 'ws-1', 'lanes'),
      journal: join(userDataDir, 'conductor', 'ws-1', 'journal.ndjson')
    })
  })

  it('keeps both derived paths inside userDataDir and outside an unrelated repo path', () => {
    const repo = '/Users/test/code/some-project'
    const paths = conductorPaths(userDataDir, 'ws-1')
    for (const p of [paths.integrationWorktree, paths.lanesDir]) {
      expect(isContainedIn(userDataDir, p)).toBe(true)
      expect(isContainedIn(repo, p)).toBe(false)
    }
  })

  it('does not treat a sibling directory sharing a name prefix as containing the derived path', () => {
    // Regression guard for the prefix-comparison bug this test file used to
    // have: a naive `child.startsWith(parent)` check would wrongly call
    // "/Users/test/Library/Application Support/Crew-evil/x" contained in
    // "/Users/test/Library/Application Support/Crew", because the string
    // "...Crew" is a prefix of "...Crew-evil". `isContainedIn` must not.
    const evilSibling = join(userDataDir + '-evil', 'x')
    expect(isContainedIn(userDataDir, evilSibling)).toBe(false)
  })

  it('treats a derived path that equals the repo root as contained in it (Finding 4, fix round 2)', () => {
    // isContainedIn(repo, repo) must be true: it is the worst case the
    // "outside the repo" assertion above is meant to catch. If a bug ever
    // made a derived path equal `repo` exactly, `isContainedIn(repo, repo)`
    // returning false (the old behaviour) would let `expect(...).toBe(false)`
    // pass right past that bug. With equal-paths-are-contained semantics,
    // asserting "not contained" against an equal path now genuinely fails.
    const repo = '/Users/test/code/some-project'
    expect(isContainedIn(repo, repo)).toBe(true)
    expect(() => expect(isContainedIn(repo, repo)).toBe(false)).toThrow()
  })

  it('rejects a workspaceId containing ".."', () => {
    expect(() => conductorPaths(userDataDir, '../../etc')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId that is exactly ".."', () => {
    expect(() => conductorPaths(userDataDir, '..')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId that is exactly "."', () => {
    expect(() => conductorPaths(userDataDir, '.')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing a forward slash', () => {
    expect(() => conductorPaths(userDataDir, 'ws/1')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing a backslash', () => {
    expect(() => conductorPaths(userDataDir, 'ws\\1')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId that is an absolute path', () => {
    expect(() => conductorPaths(userDataDir, '/etc/passwd')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects an empty workspaceId', () => {
    expect(() => conductorPaths(userDataDir, '')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing a null byte', () => {
    expect(() => conductorPaths(userDataDir, 'ws\u00001')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a Windows drive letter ("C:")', () => {
    expect(() => conductorPaths(userDataDir, 'C:')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a Windows drive-relative id ("C:foo")', () => {
    expect(() => conductorPaths(userDataDir, 'C:foo')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing a newline control character', () => {
    expect(() => conductorPaths(userDataDir, 'ws\n1')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing other ASCII control characters', () => {
    expect(() => conductorPaths(userDataDir, 'ws\t1')).toThrow(InvalidWorkspaceIdError)
    expect(() => conductorPaths(userDataDir, 'ws\r1')).toThrow(InvalidWorkspaceIdError)
    expect(() => conductorPaths(userDataDir, `ws${String.fromCharCode(0x7f)}1`)).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId containing other Windows-reserved characters', () => {
    for (const bad of ['ws<1', 'ws>1', 'ws"1', 'ws|1', 'ws?1', 'ws*1']) {
      expect(() => conductorPaths(userDataDir, bad)).toThrow(InvalidWorkspaceIdError)
    }
  })

  it('rejects a workspaceId made up only of dots', () => {
    expect(() => conductorPaths(userDataDir, '...')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId longer than the bounded maximum', () => {
    expect(() => conductorPaths(userDataDir, 'a'.repeat(256))).toThrow(InvalidWorkspaceIdError)
  })

  it('accepts a workspaceId at the bounded maximum length', () => {
    expect(() => conductorPaths(userDataDir, 'a'.repeat(255))).not.toThrow()
  })

  it('rejects a non-string workspaceId', () => {
    // @ts-expect-error deliberately wrong type, exercising the runtime guard
    expect(() => conductorPaths(userDataDir, 42)).toThrow(InvalidWorkspaceIdError)
  })

  // Finding 1 (fix round 2): Windows strips trailing dots and spaces from a
  // path segment, so "ws.", "ws " and "ws.." would all actually name the
  // same on-disk directory as "ws" — accepting them as distinct ids would
  // silently alias two different workspaces onto one directory.
  it('rejects a workspaceId with a trailing dot', () => {
    expect(() => conductorPaths(userDataDir, 'ws.')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId with a trailing space', () => {
    expect(() => conductorPaths(userDataDir, 'ws ')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId with multiple trailing dots', () => {
    expect(() => conductorPaths(userDataDir, 'ws..')).toThrow(InvalidWorkspaceIdError)
  })

  it('rejects a workspaceId with a leading space', () => {
    expect(() => conductorPaths(userDataDir, ' ws')).toThrow(InvalidWorkspaceIdError)
  })

  // Finding 2 (fix round 2): CON/PRN/AUX/NUL/COM1-9/LPT1-9 are reserved
  // device basenames on Windows and cannot be used as a child directory
  // name there, whether alone or with an extension.
  it('rejects Windows reserved device basenames, case-insensitively', () => {
    for (const bad of ['CON', 'con', 'Con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      expect(() => conductorPaths(userDataDir, bad)).toThrow(InvalidWorkspaceIdError)
    }
  })

  it('rejects a Windows reserved device basename with a trailing extension', () => {
    expect(() => conductorPaths(userDataDir, 'CON.txt')).toThrow(InvalidWorkspaceIdError)
  })

  it('accepts a workspaceId that merely contains a reserved name as a substring', () => {
    // "CONSOLE" is not the reserved basename "CON" — only the segment
    // before the first dot is checked, and it must match exactly.
    expect(() => conductorPaths(userDataDir, 'CONSOLE')).not.toThrow()
  })

  // Finding 3 (fix round 2): macOS's normalising filesystem treats NFC and
  // NFD encodings of the same visible string as the same directory entry,
  // so accepting both as distinct ids would alias two workspaces together.
  // Enforced by rejection (require NFC), not by silently converting.
  it('rejects a workspaceId that is not in Unicode NFC form (NFD "e" + combining acute)', () => {
    const nfd = 'caf\u0065\u0301' // "cafe" + combining acute accent, decomposed
    expect(nfd.normalize('NFC')).not.toBe(nfd)
    expect(() => conductorPaths(userDataDir, nfd)).toThrow(InvalidWorkspaceIdError)
  })

  it('accepts the equivalent workspaceId already in NFC form ("café")', () => {
    const nfc = 'café' // precomposed é (U+00E9)
    expect(nfc.normalize('NFC')).toBe(nfc)
    expect(() => conductorPaths(userDataDir, nfc)).not.toThrow()
  })
})

describe('createConductorRuntime', () => {
  const config: ConductorConfig = {
    workspaceId: 'ws-1',
    repo: '/Users/test/code/some-project',
    integrationBranch: 'crew/integration',
    integrationWorktree: '/Users/test/Library/Application Support/Crew/conductor/ws-1/integration',
    lanesDir: '/Users/test/Library/Application Support/Crew/conductor/ws-1/lanes',
    maxLanes: 4,
    test: null
  }

  const createSession = async (request: { cwd: string; presetId: string; model: string | null; label: string }) => {
    void request
    return { id: 'session-1' }
  }
  const closeSession = (id: string): void => {
    void id
  }

  it('assembles a ConductorRuntime whose settings mirror the config', () => {
    const runtime = createConductorRuntime({
      config,
      journalPath: '/Users/test/Library/Application Support/Crew/conductor/ws-1/journal.ndjson',
      createSession,
      closeSession
    })
    expect(runtime.settings).toEqual({
      repo: config.repo,
      integrationBranch: config.integrationBranch,
      integrationWorktree: config.integrationWorktree,
      lanesDir: config.lanesDir,
      maxLanes: config.maxLanes,
      test: config.test
    })
    expect(typeof runtime.lanes.ensureIntegrationWorktree).toBe('function')
    expect(typeof runtime.conductor.publishLane).toBe('function')
    expect(runtime.createSession).toBe(createSession)
    expect(runtime.closeSession).toBe(closeSession)
  })
})

// composeRun's repo-mismatch check (conductor-compose.ts) is the load-bearing
// caller of samePath(): a false reject there blocks a legitimate run, a false
// accept creates lanes in the wrong repository. Under-normalized comparison
// (plain resolve()) gets both wrong on macOS: a case-variant or NFD/NFC
// alias of the user's own repo path would be wrongly rejected as "a
// different repository".
describe('samePath', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'samepath-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('treats a case-variant of a real directory as the same path (case-insensitive filesystem only)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      // Case-insensitivity is a filesystem property, not something to fake:
      // on a genuinely case-sensitive filesystem /repo and /REPO really are
      // different directories, so there is nothing portable to assert here.
      return
    }
    const dir = join(root, 'MyRepo')
    mkdirSync(dir)
    expect(samePath(dir, join(root, 'MYREPO'))).toBe(true)
    expect(samePath(dir, join(root, 'myrepo'))).toBe(true)
  })

  it('treats an NFD-encoded path as the same as its NFC alias for a real directory', () => {
    const nfc = 'caf\u00e9' // "café", precomposed
    const nfd = 'cafe\u0301' // "café", combining acute accent
    expect(nfc).not.toBe(nfd) // sanity: genuinely different code sequences
    const dirNfc = join(root, nfc)
    mkdirSync(dirNfc)
    expect(samePath(dirNfc, join(root, nfd))).toBe(true)
  })

  it('rejects a genuinely different repo even when both exist', () => {
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    mkdirSync(repoA)
    mkdirSync(repoB)
    expect(samePath(repoA, repoB)).toBe(false)
  })

  it('does not throw for a path that does not exist yet, and never treats unrelated non-existent paths as equal', () => {
    const missingA = join(root, 'does-not-exist-a')
    const missingB = join(root, 'does-not-exist-b')
    expect(() => samePath(missingA, missingB)).not.toThrow()
    expect(samePath(missingA, missingB)).toBe(false)
    expect(samePath(missingA, missingA)).toBe(true)
  })

  it('falls back to a resolve()-based comparison when realpath cannot resolve either side', () => {
    const unresolvable = (): string => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    expect(samePath('/some/repo/', '/some/repo', { realpath: unresolvable })).toBe(true)
    expect(samePath('/some/repo', '/some/other', { realpath: unresolvable })).toBe(false)
  })
})
