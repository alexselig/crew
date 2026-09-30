import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { conductorPaths, createConductorRuntime, InvalidWorkspaceIdError } from '../src/main/conductor-runtime'
import type { ConductorConfig } from '../src/shared/conductor'

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
    const resolvedUserData = resolve(userDataDir)
    for (const p of [paths.integrationWorktree, paths.lanesDir]) {
      expect(resolve(p).startsWith(resolvedUserData + sep)).toBe(true)
      expect(resolve(p).startsWith(resolve(repo))).toBe(false)
    }
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
