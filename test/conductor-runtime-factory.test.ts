import { describe, it, expect } from 'vitest'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { conductorPaths, createConductorRuntime, InvalidWorkspaceIdError } from '../src/main/conductor-runtime'
import type { ConductorConfig } from '../src/shared/conductor'

// A real containment proof: `child` is inside `parent` iff `path.relative`
// from parent to child is non-empty, does not climb out with a leading
// "..", and is not itself absolute (which `path.relative` returns when the
// two paths are on different Windows drives). A prefix check like
// `child.startsWith(parent)` is not equivalent — it also matches a sibling
// directory that merely shares parent as a string prefix, e.g. parent
// "/Users/test/data" wrongly "contains" "/Users/test/data-evil/x".
const isContainedIn = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
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
