import { useEffect, useRef, useState } from 'react'
import type {
  SessionInfo,
  Preset,
  CharacterDef,
  Settings,
  Workspace,
  CustomView,
  SessionPresentation,
  Agent,
  AgentRun
} from '../shared/types'
import type { GroupMode } from './grouping'
import { writeTo, disposePooled, setEngineMode, disposeTerminalFacade } from './terminal/facade'
import { clearInputMeter } from './input-meter'
import { windowSlot, readViewPref, writeViewPref } from './window-scope'
import { nextSelection } from '../shared/selection'
import { navigateToSession as navigateToVisibleSession } from './session-navigation'
import type { RevealRequest } from './reveal'

export type ViewMode = 'single' | 'grid'
/** Grid density (all horizontal-scroll): `two` = 1 row (2 tiles), `four` = 2 rows
 *  (2x2), `six` = 3 rows (2x3); scroll left/right for more, snapping to columns. */
export type GridDensity = 'two' | 'four' | 'six'

const NAV_MIN = 200
const NAV_MAX = 520
const NAV_DEFAULT = 300
const BUILTIN_GROUP_MODES: readonly GroupMode[] = ['none', 'needs', 'tag', 'recent']
const RECENT_PRESENTATION: SessionPresentation = { kind: 'builtin', mode: 'recent' }

interface InitialPresentationState {
  groupMode: GroupMode
  presentation: SessionPresentation
}

function readInitialGroupMode(): GroupMode {
  const saved = readViewPref('groupMode')
  if (saved && BUILTIN_GROUP_MODES.includes(saved as GroupMode)) return saved as GroupMode
  if (windowSlot === 0 && localStorage.getItem('crew.groupByTag') === '1') return 'tag'
  return 'none'
}

function readInitialPresentationState(): InitialPresentationState {
  const groupMode = readInitialGroupMode()
  const saved = readViewPref('sessionPresentation')
  if (!saved) return { groupMode, presentation: { kind: 'builtin', mode: groupMode } }
  try {
    const parsed = JSON.parse(saved) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      parsed.kind === 'builtin' &&
      'mode' in parsed &&
      BUILTIN_GROUP_MODES.includes(parsed.mode as GroupMode)
    ) {
      return {
        groupMode: parsed.mode as GroupMode,
        presentation: { kind: 'builtin', mode: parsed.mode as GroupMode }
      }
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      parsed.kind === 'custom' &&
      'viewId' in parsed &&
      typeof parsed.viewId === 'string' &&
      parsed.viewId.trim().length > 0
    ) {
      return {
        groupMode,
        presentation: { kind: 'custom', viewId: parsed.viewId }
      }
    }
  } catch {
    // Ignore corrupted renderer-local preferences and fall back to the legacy built-in state.
  }
  return { groupMode, presentation: { kind: 'builtin', mode: groupMode } }
}

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
  /** Select a session by user action, restoring (un-minimizing) it if hidden. */
  selectSession: (id: string) => void
  /** Reveal a session across workspace/presentation filters, then select it. */
  navigateToSession: (id: string) => void
  /**
   * The most recent deliberate navigation. The grid aligns that session's tile
   * to its left edge; a bare selection only moves it as far as it must.
   */
  revealRequest: RevealRequest | null
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
  customViews: CustomView[]
  presentation: SessionPresentation
  setPresentation: (p: SessionPresentation) => void
  showCustomViewEditor: string | 'new' | null
  setShowCustomViewEditor: (v: string | 'new' | null) => void
  collapsedGroups: Set<string>
  toggleGroup: (name: string) => void
  /** Session ids the user has minimized (hidden behind a per-bucket "show more"). */
  minimized: Set<string>
  toggleMinimize: (id: string) => void
  /** Session ids the user has explicitly revealed (by clicking/selecting or
   * restoring them). Overrides stale-hiding so a clicked session stays in the
   * visible nav list without needing "show more". */
  revealed: Set<string>
  groupOrder: string[]
  reorderGroups: (names: string[]) => void
  /** Active workspace filter (null = All Sessions). */
  activeWorkspace: string | null
  setActiveWorkspace: (name: string | null) => void
  /** First-class workspaces (id-based), the source of truth for the manager. */
  workspaces: Workspace[]
  /** Re-fetch the workspace list. */
  refreshWorkspaces: () => void
  /** Whether the full-screen Workspace Manager is open. */
  showWorkspaces: boolean
  setShowWorkspaces: (v: boolean) => void
  /** Specialist agents (the nav shelf). */
  agents: Agent[]
  /** Agent runs keyed by run id (streamed). */
  runs: Record<string, AgentRun>
  /** The run shown in the result drawer, or null. */
  activeRunId: string | null
  setActiveRunId: (id: string | null) => void
  /** Which agent is being edited ('new' = create), or null. */
  editingAgent: string | null | 'new'
  setEditingAgent: (v: string | null | 'new') => void
  settings: Settings | null
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

export function useCrew(): CrewState {
  const initialPresentation = useRef<InitialPresentationState>(readInitialPresentationState())
  const [roster, setRoster] = useState<SessionInfo[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [characters, setCharacters] = useState<CharacterDef[]>([])
  const [homeDir, setHomeDir] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null)
  const revealSeq = useRef(0)
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
  const [groupMode, setGroupModeState] = useState<GroupMode>(() => initialPresentation.current.groupMode)
  const [customViews, setCustomViews] = useState<CustomView[]>([])
  const [customViewsLoaded, setCustomViewsLoaded] = useState(false)
  const [presentation, setPresentationState] = useState<SessionPresentation>(
    () => initialPresentation.current.presentation
  )
  const [showCustomViewEditor, setShowCustomViewEditor] = useState<string | 'new' | null>(null)
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
  // Sessions the user has explicitly revealed (clicked/selected or restored).
  // Stored unscoped alongside `minimized`; overrides stale-hiding so a revealed
  // session stays in the visible nav list rather than falling back behind a
  // group's "show more" once it ages past the stale cutoff.
  const [revealed, setRevealed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('crew.revealed') || '[]'))
    } catch {
      return new Set<string>()
    }
  })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [activeWorkspace, setActiveWorkspaceState] = useState<string | null>(
    () => readViewPref('activeWorkspace') || null
  )
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [showWorkspaces, setShowWorkspaces] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<Record<string, AgentRun>>({})
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [editingAgent, setEditingAgent] = useState<string | null | 'new'>(null)
  const knownIds = useRef<Set<string>>(new Set())
  const navigationState = useRef({ roster, activeWorkspace, presentation, customViews })
  navigationState.current = { roster, activeWorkspace, presentation, customViews }

  const setActiveWorkspace = (name: string | null): void => {
    setActiveWorkspaceState(name)
    writeViewPref('activeWorkspace', name ?? '')
  }
  const refreshWorkspaces = (): void => {
    void window.crew.getWorkspaces().then(setWorkspaces)
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
  const writeSessionPresentationPref = (next: SessionPresentation): void => {
    writeViewPref('sessionPresentation', JSON.stringify(next))
  }
  const setPresentation = (next: SessionPresentation): void => {
    setPresentationState(next)
    writeSessionPresentationPref(next)
    if (next.kind !== 'builtin') return
    setGroupModeState(next.mode)
    writeViewPref('groupMode', next.mode)
  }
  const setGroupMode = (m: GroupMode): void => {
    setGroupModeState(m)
    writeViewPref('groupMode', m)
    const next: SessionPresentation = { kind: 'builtin', mode: m }
    setPresentationState(next)
    writeSessionPresentationPref(next)
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
    const restoring = minimized.has(id)
    setMinimized((prev) => {
      const n = new Set(prev)
      if (restoring) n.delete(id)
      else n.add(id)
      localStorage.setItem('crew.minimized', JSON.stringify([...n]))
      return n
    })
    // Keep the stale-hide override in sync: restoring reveals the session so it
    // resurfaces even when stale; minimizing clears any prior reveal.
    setRevealed((prev) => {
      const n = new Set(prev)
      if (restoring) n.add(id)
      else n.delete(id)
      localStorage.setItem('crew.revealed', JSON.stringify([...n]))
      return n
    })
  }
  // Selecting a session from the nav restores it: a minimized session should
  // reappear (its pane opens in the grid) the moment the user clicks it, rather
  // than staying hidden behind "show more". Selecting also reveals it so
  // stale-hiding (group sort) can't keep it tucked away — a clicked session is
  // always shown in the visible nav list.
  const selectSession = (id: string): void => {
    setMinimized((prev) => {
      if (!prev.has(id)) return prev
      const n = new Set(prev)
      n.delete(id)
      localStorage.setItem('crew.minimized', JSON.stringify([...n]))
      return n
    })
    setRevealed((prev) => {
      if (prev.has(id)) return prev
      const n = new Set(prev)
      n.add(id)
      localStorage.setItem('crew.revealed', JSON.stringify([...n]))
      return n
    })
    setSelectedId(id)
  }
  const navigateToSession = (id: string): void => {
    navigateToVisibleSession(
      { id, ...navigationState.current },
      { setActiveWorkspace, setPresentation, selectSession, setShowNew }
    )
    revealSeq.current += 1
    setRevealRequest({ id, seq: revealSeq.current })
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
    void window.crew.getWorkspaces().then((w) => mounted && setWorkspaces(w))
    void window.crew.getCustomViews().then((views) => {
      if (!mounted) return
      setCustomViews(views)
      setCustomViewsLoaded(true)
    })
    void window.crew.getAgents().then((a) => mounted && setAgents(a))

    const offRoster = window.crew.onRoster((r) => setRoster(r))
    const offState = window.crew.onState((e) =>
      setRoster((prev) =>
        prev.map((s) =>
          s.id === e.id ? { ...s, state: e.state, stateChangedAt: e.stateChangedAt } : s
        )
      )
    )
    const offOutput = window.crew.onOutput((e) => writeTo(e.id, e.data))
    const offJump = window.crew.onJump(navigateToSession)
    const offNew = window.crew.onNew(() => setShowNew(true))
    const offWorkspace = window.crew.onWorkspace((name) => setActiveWorkspace(name))
    const offWorkspaces = window.crew.onWorkspaces((w) => setWorkspaces(w))
    const offCustomViews = window.crew.onCustomViews((views) => {
      setCustomViews(views)
      setCustomViewsLoaded(true)
    })
    const offOpenWorkspaces = window.crew.onOpenWorkspaces(() => setShowWorkspaces(true))
    const offAgents = window.crew.onAgents((a) => setAgents(a))
    const offAgentRun = window.crew.onAgentRun((run) => {
      setRuns((prev) => ({ ...prev, [run.id]: run }))
      if (run.id) setActiveRunId((cur) => cur ?? run.id)
    })

    return () => {
      mounted = false
      offRoster()
      offState()
      offOutput()
      offJump()
      offNew()
      offWorkspace()
      offWorkspaces()
      offCustomViews()
      offOpenWorkspaces()
      offAgents()
      offAgentRun()
      disposeTerminalFacade()
    }
  }, [])

  useEffect(() => {
    if (!customViewsLoaded || presentation.kind !== 'custom') return
    if (customViews.some((view) => view.id === presentation.viewId)) return
    setPresentation(RECENT_PRESENTATION)
  }, [customViews, customViewsLoaded, presentation])

  // Keep the selection valid as sessions come and go, and as a workspace filter
  // hides them. One rule, one place — see nextSelection().
  useEffect(() => {
    setSelectedId(nextSelection(roster, selectedId, activeWorkspace))
  }, [roster, selectedId, activeWorkspace])

  // Point the terminal facade at the engine chosen in Settings (app-wide). Set
  // eagerly so output routes to the right pool as soon as settings load / change.
  useEffect(() => {
    setEngineMode(settings?.enhancedTerminal ? 'crew' : 'legacy')
  }, [settings?.enhancedTerminal])

  // Dispose pooled terminals for sessions that have left the roster (closed or
  // replaced by a restart), freeing their memory.
  useEffect(() => {
    const current = new Set(roster.map((s) => s.id))
    for (const id of knownIds.current) {
      if (!current.has(id)) {
        disposePooled(id)
        clearInputMeter(id)
      }
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
    selectSession,
    navigateToSession,
    revealRequest,
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
    customViews,
    presentation,
    setPresentation,
    showCustomViewEditor,
    setShowCustomViewEditor,
    collapsedGroups,
    toggleGroup,
    minimized,
    toggleMinimize,
    revealed,
    groupOrder,
    reorderGroups,
    activeWorkspace,
    setActiveWorkspace,
    workspaces,
    refreshWorkspaces,
    showWorkspaces,
    setShowWorkspaces,
    agents,
    runs,
    activeRunId,
    setActiveRunId,
    editingAgent,
    setEditingAgent,
    settings,
    setSetting
  }
}
