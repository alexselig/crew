import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo, Preset, CharacterDef, Settings } from '../shared/types'
import type { GroupMode } from './grouping'
import { writeTo, disposePooled } from './terminal-pool'
import { windowSlot, readViewPref, writeViewPref } from './window-scope'
import { workspaceNames } from '../shared/workspaces'

export type ViewMode = 'single' | 'grid'
/** Grid density (all horizontal-scroll): `two` = 1 row (2 tiles), `four` = 2 rows
 *  (2x2), `six` = 3 rows (2x3); scroll left/right for more, snapping to columns. */
export type GridDensity = 'two' | 'four' | 'six'

const NAV_MIN = 200
const NAV_MAX = 520
const NAV_DEFAULT = 300

/** Force a re-render on an interval while `active`, so wall-clock-derived views
 *  (the 'recent' grouping buckets) migrate sessions between buckets as time
 *  passes rather than freezing until an unrelated roster update. */
export function useNowTick(active: boolean, intervalMs = 30_000): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
}

export interface CrewState {
  roster: SessionInfo[]
  presets: Preset[]
  characters: CharacterDef[]
  homeDir: string
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  showNew: boolean
  setShowNew: (v: boolean) => void
  viewMode: ViewMode
  setViewMode: (m: ViewMode) => void
  gridDensity: GridDensity
  setGridDensity: (d: GridDensity) => void
  navWidth: number
  setNavWidth: (w: number) => void
  navCollapsed: boolean
  setNavCollapsed: (v: boolean) => void
  groupMode: GroupMode
  setGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  toggleGroup: (name: string) => void
  /** Session ids the user has minimized (hidden behind a per-bucket "show more"). */
  minimized: Set<string>
  toggleMinimize: (id: string) => void
  groupOrder: string[]
  reorderGroups: (names: string[]) => void
  /** Active workspace filter (null = All Sessions). */
  activeWorkspace: string | null
  setActiveWorkspace: (name: string | null) => void
  /** All known workspace (named set) names — saved sets ∪ live memberships. */
  workspaces: string[]
  /** Re-fetch saved set names (after save/delete in a modal). */
  refreshWorkspaces: () => void
  settings: Settings | null
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

export function useCrew(): CrewState {
  const [roster, setRoster] = useState<SessionInfo[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [characters, setCharacters] = useState<CharacterDef[]>([])
  const [homeDir, setHomeDir] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [gridDensity, setGridDensityState] = useState<GridDensity>(() => {
    const v = readViewPref('gridDensity')
    return v === 'two' || v === 'four' || v === 'six' ? v : 'four'
  })
  const [navWidth, setNavWidthState] = useState<number>(() => {
    const v = Number(readViewPref('navWidth'))
    return v >= NAV_MIN && v <= NAV_MAX ? v : NAV_DEFAULT
  })
  const [navCollapsed, setNavCollapsedState] = useState<boolean>(
    () => readViewPref('navCollapsed') === '1'
  )
  const [groupMode, setGroupModeState] = useState<GroupMode>(() => {
    const saved = readViewPref('groupMode')
    if (saved === 'none' || saved === 'needs' || saved === 'tag' || saved === 'recent') return saved
    if (windowSlot === 0 && localStorage.getItem('crew.groupByTag') === '1') return 'tag'
    return 'none'
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(readViewPref('collapsedGroups') || '[]'))
    } catch {
      return new Set<string>()
    }
  })
  const [groupOrder, setGroupOrderState] = useState<string[]>(() => {
    try {
      const v = JSON.parse(readViewPref('groupOrder') || '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  // Minimized sessions are stored unscoped (shared across windows) — minimizing
  // is a property of the session, not of one window's layout.
  const [minimized, setMinimized] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('crew.minimized') || '[]'))
    } catch {
      return new Set<string>()
    }
  })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [activeWorkspace, setActiveWorkspaceState] = useState<string | null>(
    () => readViewPref('activeWorkspace') || null
  )
  const [setNames, setSetNames] = useState<string[]>([])
  const knownIds = useRef<Set<string>>(new Set())

  const setActiveWorkspace = (name: string | null): void => {
    setActiveWorkspaceState(name)
    writeViewPref('activeWorkspace', name ?? '')
  }
  const refreshWorkspaces = (): void => {
    void window.crew.getSets().then((s) => setSetNames(s.map((x) => x.name)))
  }

  const setNavWidth = (w: number): void => {
    const clamped = Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(w)))
    setNavWidthState(clamped)
    writeViewPref('navWidth', String(clamped))
  }
  const setGridDensity = (d: GridDensity): void => {
    setGridDensityState(d)
    writeViewPref('gridDensity', d)
  }
  const setNavCollapsed = (v: boolean): void => {
    setNavCollapsedState(v)
    writeViewPref('navCollapsed', v ? '1' : '0')
  }
  const setGroupMode = (m: GroupMode): void => {
    setGroupModeState(m)
    writeViewPref('groupMode', m)
  }
  const toggleGroup = (name: string): void => {
    setCollapsedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      writeViewPref('collapsedGroups', JSON.stringify([...n]))
      return n
    })
  }
  const reorderGroups = (names: string[]): void => {
    setGroupOrderState(names)
    writeViewPref('groupOrder', JSON.stringify(names))
  }
  const toggleMinimize = (id: string): void => {
    setMinimized((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      localStorage.setItem('crew.minimized', JSON.stringify([...n]))
      return n
    })
  }
  const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    void window.crew.updateSettings({ [key]: value } as Partial<Settings>).then(setSettings)
  }

  useEffect(() => {
    let mounted = true

    void window.crew.getRoster().then((r) => {
      if (!mounted) return
      setRoster(r)
      setSelectedId((cur) => cur ?? r[0]?.id ?? null)
    })
    void window.crew.getPresets().then((p) => mounted && setPresets(p))
    void window.crew.getCharacters().then((c) => mounted && setCharacters(c))
    void window.crew.getHomeDir().then((h) => mounted && setHomeDir(h))
    void window.crew.getSettings().then((s) => mounted && setSettings(s))
    void window.crew.getSets().then((s) => mounted && setSetNames(s.map((x) => x.name)))

    const offRoster = window.crew.onRoster((r) => setRoster(r))
    const offState = window.crew.onState((e) =>
      setRoster((prev) =>
        prev.map((s) =>
          s.id === e.id ? { ...s, state: e.state, stateChangedAt: e.stateChangedAt } : s
        )
      )
    )
    const offOutput = window.crew.onOutput((e) => writeTo(e.id, e.data))
    const offJump = window.crew.onJump((id) => {
      setSelectedId(id)
      setShowNew(false)
    })
    const offNew = window.crew.onNew(() => setShowNew(true))
    const offWorkspace = window.crew.onWorkspace((name) => setActiveWorkspace(name))

    return () => {
      mounted = false
      offRoster()
      offState()
      offOutput()
      offJump()
      offNew()
      offWorkspace()
    }
  }, [])

  // Keep the selection valid as sessions come and go.
  useEffect(() => {
    if (selectedId && !roster.some((s) => s.id === selectedId)) {
      setSelectedId(roster[0]?.id ?? null)
    } else if (!selectedId && roster.length > 0) {
      setSelectedId(roster[0].id)
    }
  }, [roster, selectedId])

  // Dispose pooled terminals for sessions that have left the roster (closed or
  // replaced by a restart), freeing their memory.
  useEffect(() => {
    const current = new Set(roster.map((s) => s.id))
    for (const id of knownIds.current) {
      if (!current.has(id)) disposePooled(id)
    }
    knownIds.current = current
  }, [roster])

  // Known workspace names: saved sets ∪ every session's live membership.
  const workspaces = useMemo(
    () => workspaceNames(setNames, roster.map((s) => s.sets)),
    [setNames, roster]
  )

  return {
    roster,
    presets,
    characters,
    homeDir,
    selectedId,
    setSelectedId,
    showNew,
    setShowNew,
    viewMode,
    setViewMode,
    gridDensity,
    setGridDensity,
    navWidth,
    setNavWidth,
    navCollapsed,
    setNavCollapsed,
    groupMode,
    setGroupMode,
    collapsedGroups,
    toggleGroup,
    minimized,
    toggleMinimize,
    groupOrder,
    reorderGroups,
    activeWorkspace,
    setActiveWorkspace,
    workspaces,
    refreshWorkspaces,
    settings,
    setSetting
  }
}
