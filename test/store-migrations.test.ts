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
