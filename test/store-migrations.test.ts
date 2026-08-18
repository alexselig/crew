import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, DEFAULT_SETTINGS } from '../src/main/store'

const MIGRATION_ID = '2026-07-stale-hide-72h'

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'crew-store-')), 'store.json')
}

/** Seed a store file with a partial settings object (merged over defaults). */
function seed(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data))
}

describe('store migration — stale-hide 12h → 72h', () => {
  it('bumps a store still on the old 12h default up to 72h and records it', () => {
    const path = tmpStorePath()
    seed(path, { settings: { ...DEFAULT_SETTINGS, staleHideHours: 12 } })

    const store = new Store(path)
    expect(store.settings.staleHideHours).toBe(72)

    // Migration ran → data is written back so it never re-fires.
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.settings.staleHideHours).toBe(72)
    expect(persisted.migrations).toContain(MIGRATION_ID)
  })

  it('leaves a value the user chose themselves untouched', () => {
    const path = tmpStorePath()
    seed(path, { settings: { ...DEFAULT_SETTINGS, staleHideHours: 6 } })

    const store = new Store(path)
    expect(store.settings.staleHideHours).toBe(6)
  })

  it('does not re-run once recorded, so a later 12h is respected', () => {
    const path = tmpStorePath()
    // Migration already applied, and the user has since deliberately set 12h.
    seed(path, {
      settings: { ...DEFAULT_SETTINGS, staleHideHours: 12 },
      migrations: [MIGRATION_ID]
    })

    const store = new Store(path)
    expect(store.settings.staleHideHours).toBe(12)
  })

  it('records the migration as applied even when the value is already current', () => {
    const path = tmpStorePath()
    seed(path, { settings: { ...DEFAULT_SETTINGS, staleHideHours: 72 } })

    const store = new Store(path)
    expect(store.settings.staleHideHours).toBe(72)
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.migrations).toContain(MIGRATION_ID)
  })

  it('treats a fresh install as baseline: latest default, no destructive write', () => {
    const path = tmpStorePath()
    expect(existsSync(path)).toBe(false)

    const store = new Store(path)
    // Fresh installs already ship the new default and skip the migration.
    expect(store.settings.staleHideHours).toBe(DEFAULT_SETTINGS.staleHideHours)
    // No file is written until the first real save (non-destructive on a
    // missing/unreadable store), but the baseline is carried in memory.
    expect(existsSync(path)).toBe(false)

    // First real save writes the baseline migration list, so it never runs later.
    store.updateSettings({ staleHideHours: 12 })
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.migrations).toContain(MIGRATION_ID)
    expect(persisted.settings.staleHideHours).toBe(12)
  })
})

describe('store migration — first-class workspaces', () => {
  const WS_MIGRATION = '2026-08-workspaces-firstclass'

  it('promotes legacy name membership to Workspace entities + workspaceIds', () => {
    const path = tmpStorePath()
    seed(path, {
      sessions: [
        { id: 's1', presetId: null, command: 'x', args: [], cwd: '/tmp', label: 'S1', characterId: 'fox', sets: ['July 2026'] }
      ],
      sets: [{ name: 'July 2026', sessions: [] }],
      migrations: []
    })

    const store = new Store(path)
    const wss = store.getWorkspaces()
    expect(wss.map((w) => w.name)).toEqual(['July 2026'])
    const wsId = wss[0].id
    expect(store.getSessions()[0].workspaceIds).toEqual([wsId])

    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.migrations).toContain(WS_MIGRATION)
  })

  it('keeps non-empty resume bundles and does not double-run', () => {
    const path = tmpStorePath()
    seed(path, {
      sessions: [],
      sets: [{ name: 'Resume Bundle', sessions: [{ presetId: null, command: 'x', args: [], cwd: '/tmp', label: 'A' }] }],
      workspaces: [{ id: 'ws_keep', name: 'Kept', order: 0, createdAt: 1 }],
      migrations: [WS_MIGRATION]
    })

    const store = new Store(path)
    // Already migrated → workspaces untouched, resume bundle preserved.
    expect(store.getWorkspaces().map((w) => w.id)).toEqual(['ws_keep'])
    expect(store.sets.find((s) => s.name === 'Resume Bundle')?.sessions).toHaveLength(1)
  })
})

describe('store migration — seed built-in agents', () => {
  const ID = '2026-08-agents-seed'
  it('seeds built-in agents on an existing store missing them', () => {
    const p = tmpStorePath()
    seed(p, { sessions: [], migrations: [] })
    const store = new Store(p)
    const agents = store.getAgents()
    expect(agents.length).toBeGreaterThanOrEqual(3)
    expect(agents.some((a) => a.name === 'UX Critique')).toBe(true)
    const persisted = JSON.parse(readFileSync(p, 'utf8'))
    expect(persisted.migrations).toContain(ID)
  })
  it('does not duplicate seeds once present', () => {
    const p = tmpStorePath()
    seed(p, {
      agents: [{ id: 'ag_x', name: 'Mine', icon: 'spark', base: 'copilot-cli', persona: 'p', contextMode: 'cwd', writes: false, order: 0 }],
      migrations: [ID]
    })
    const store = new Store(p)
    expect(store.getAgents().map((a) => a.id)).toEqual(['ag_x'])
  })
})
