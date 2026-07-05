import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, Preset, CharacterDef, Settings } from '../shared/types'
import type { GroupMode } from './grouping'
import { writeTo, disposePooled } from './terminal-pool'

export type ViewMode = 'single' | 'grid'

const NAV_MIN = 200
const NAV_MAX = 520
const NAV_DEFAULT = 300

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
  navWidth: number
  setNavWidth: (w: number) => void
  navCollapsed: boolean
  setNavCollapsed: (v: boolean) => void
  groupMode: GroupMode
  setGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  toggleGroup: (name: string) => void
  groupOrder: string[]
  reorderGroups: (names: string[]) => void
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
  const [navWidth, setNavWidthState] = useState<number>(() => {
    const v = Number(localStorage.getItem('crew.navWidth'))
    return v >= NAV_MIN && v <= NAV_MAX ? v : NAV_DEFAULT
  })
  const [navCollapsed, setNavCollapsedState] = useState<boolean>(
    () => localStorage.getItem('crew.navCollapsed') === '1'
  )
  const [groupMode, setGroupModeState] = useState<GroupMode>(() => {
    const saved = localStorage.getItem('crew.groupMode')
    if (saved === 'none' || saved === 'needs' || saved === 'tag') return saved
    return localStorage.getItem('crew.groupByTag') === '1' ? 'tag' : 'none'
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('crew.collapsedGroups') || '[]'))
    } catch {
      return new Set<string>()
    }
  })
  const [groupOrder, setGroupOrderState] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('crew.groupOrder') || '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const [settings, setSettings] = useState<Settings | null>(null)
  const knownIds = useRef<Set<string>>(new Set())

  const setNavWidth = (w: number): void => {
    const clamped = Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(w)))
    setNavWidthState(clamped)
    localStorage.setItem('crew.navWidth', String(clamped))
  }
  const setNavCollapsed = (v: boolean): void => {
    setNavCollapsedState(v)
    localStorage.setItem('crew.navCollapsed', v ? '1' : '0')
  }
  const setGroupMode = (m: GroupMode): void => {
    setGroupModeState(m)
    localStorage.setItem('crew.groupMode', m)
  }
  const toggleGroup = (name: string): void => {
    setCollapsedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      localStorage.setItem('crew.collapsedGroups', JSON.stringify([...n]))
      return n
    })
  }
  const reorderGroups = (names: string[]): void => {
    setGroupOrderState(names)
    localStorage.setItem('crew.groupOrder', JSON.stringify(names))
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

    return () => {
      mounted = false
      offRoster()
      offState()
      offOutput()
      offJump()
      offNew()
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
    navWidth,
    setNavWidth,
    navCollapsed,
    setNavCollapsed,
    groupMode,
    setGroupMode,
    collapsedGroups,
    toggleGroup,
    groupOrder,
    reorderGroups,
    settings,
    setSetting
  }
}
