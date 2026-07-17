import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useCrew } from './hooks'
import { Roster } from './components/Roster'
import { SessionView } from './components/SessionView'
import { GridView } from './components/GridView'
import { NewSessionModal } from './components/NewSessionModal'
import { SettingsModal } from './components/SettingsModal'
import { BroadcastModal } from './components/BroadcastModal'
import { AnalyticsModal } from './components/AnalyticsModal'
import { TranscriptsModal } from './components/TranscriptsModal'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { TitleSequence } from './components/TitleSequence'
import { Icon } from './components/Icon'
import { Character } from './components/Character'
import { focusTerminal } from './terminal-pool'
import { existingGroups, recencyOf } from './grouping'
import { arrowNavIntent } from './gridNav'
import { NEEDS_YOU } from '../shared/types'
import { sessionInWorkspace } from '../shared/workspaces'
import { STATE_META } from './state-meta'
import type { CreateSessionRequest } from '../shared/types'

export function App(): JSX.Element {
  const c = useCrew()
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [showTranscripts, setShowTranscripts] = useState(false)
  // The title launch sequence plays on boot (waiting for a "click to start")
  // and replays on logo click. Skipped under automation (Playwright e2e) so it
  // never blocks the tests, and on secondary windows (?intro=0) so only the
  // first window plays it.
  const [showIntro, setShowIntro] = useState(() => {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return false
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('intro') === '0')
      return false
    return true
  })
  const anyOverlay =
    showSettings ||
    showPalette ||
    showBroadcast ||
    showAnalytics ||
    showTranscripts ||
    showIntro ||
    c.showNew
  const selected = c.roster.find((s) => s.id === c.selectedId) ?? null
  const usedCharacterIds = c.roster
    .filter((s) => s.status === 'active' && s.id !== selected?.id)
    .map((s) => s.characterId)
  // Roster filtered to the active workspace (null = All). Non-destructive: hidden
  // sessions keep running; this only changes what's shown.
  const visibleRoster = useMemo(
    () => c.roster.filter((s) => sessionInWorkspace(s.sets, c.activeWorkspace)),
    [c.roster, c.activeWorkspace]
  )

  // Default workspace for a new session, always non-empty when any workspace
  // exists: the active workspace filter → else the most recently used one (the
  // workspace of the most recently prompted session) → else the first known
  // workspace. Empty only when no workspaces exist at all.
  const defaultWorkspaces = useMemo<string[]>(() => {
    if (c.activeWorkspace) return [c.activeWorkspace]
    const mostRecent = [...c.roster]
      .sort((a, b) => recencyOf(b) - recencyOf(a))
      .flatMap((s) => s.sets ?? [])[0]
    if (mostRecent) return [mostRecent]
    return c.workspaces.length > 0 ? [c.workspaces[0]] : []
  }, [c.activeWorkspace, c.roster, c.workspaces])

  async function create(req: CreateSessionRequest): Promise<void> {
    const info = await window.crew.createSession(req)
    c.setSelectedId(info.id)
    c.setShowNew(false)
  }

  async function restart(id: string): Promise<void> {
    const info = await window.crew.restartSession(id)
    if (info) c.setSelectedId(info.id)
  }

  function close(id: string): void {
    void window.crew.closeSession(id)
  }

  // Bring a session into focus view (used by "Needs you" buttons + tile expand).
  function focusSession(id: string): void {
    c.setSelectedId(id)
    c.setViewMode('single')
  }

  // When a workspace filter hides the selected session, fall back to the first
  // visible one so the focus view never shows a hidden session.
  useEffect(() => {
    if (!c.activeWorkspace) return
    if (c.selectedId && !visibleRoster.some((s) => s.id === c.selectedId)) {
      c.setSelectedId(visibleRoster[0]?.id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.activeWorkspace, visibleRoster, c.selectedId])

  // Return keyboard focus to the terminal whenever overlays (modals/palette)
  // close — otherwise focus is left on <body> and typed input goes nowhere.
  useEffect(() => {
    if (anyOverlay || c.viewMode !== 'single' || !c.selectedId) return
    const id = c.selectedId
    const raf = requestAnimationFrame(() => focusTerminal(id))
    return () => cancelAnimationFrame(raf)
  }, [anyOverlay, c.viewMode, c.selectedId])

  function jumpNextWaiting(): void {
    const waiting = visibleRoster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state))
    if (waiting.length === 0) return
    const cur = waiting.findIndex((s) => s.id === c.selectedId)
    focusSession(waiting[(cur + 1) % waiting.length].id)
  }

  // Grid column navigation with Left/Right arrows. Registered in the CAPTURE
  // phase (third arg `true`) on purpose: xterm attaches its own capture-phase
  // keydown listener to each terminal's hidden textarea and, for arrow keys,
  // calls preventDefault + stopPropagation. So once a tile's terminal held
  // focus the arrow never bubbled up to a normal window listener — the grid
  // stopped scrolling and the keystroke was "grabbed" by the session. Handling
  // it here, before xterm, lets the grid page left/right regardless of which
  // tile's terminal is focused, while genuine text fields keep their caret keys.
  useEffect(() => {
    function onArrowCapture(e: KeyboardEvent): void {
      const el = document.activeElement as HTMLElement | null
      const active = el
        ? {
            tag: el.tagName,
            isContentEditable: el.isContentEditable,
            isTerminal: el.classList.contains('xterm-helper-textarea')
          }
        : null
      // The scrollable element differs by layout: the flat grid scrolls on
      // .gridview__scroll, but grouped mode pins that to overflow:hidden and
      // scrolls the inner horizontal .grid-groups strip instead. Target
      // whichever is actually scrollable so arrows work in both states.
      const sc =
        document.querySelector<HTMLElement>('.grid-groups') ??
        document.querySelector<HTMLElement>('.gridview__scroll')
      const dir = arrowNavIntent(e.key, e, active, Boolean(sc))
      if (!dir || !sc) return
      // We own this arrow — stop it before xterm's terminal handler consumes it.
      e.preventDefault()
      e.stopPropagation()
      // Step ONE column per press, landing exactly on a column's left edge so a
      // session is never left half cut off. Column edges are read from the tiles'
      // real positions, so this works for both the flat grid and the grouped
      // strip (whose 2px group dividers make the columns slightly irregular).
      const scLeft = sc.getBoundingClientRect().left
      const edges = Array.from(
        new Set(
          Array.from(sc.querySelectorAll<HTMLElement>('.tile'))
            .filter((t) => t.getBoundingClientRect().width > 0)
            .map((t) => Math.round(t.getBoundingClientRect().left - scLeft + sc.scrollLeft))
        )
      ).sort((a, b) => a - b)
      const cur = sc.scrollLeft
      const maxLeft = sc.scrollWidth - sc.clientWidth
      let target =
        dir === 'right'
          ? edges.find((x) => x > cur + 2)
          : [...edges].reverse().find((x) => x < cur - 2)
      if (target === undefined) target = dir === 'right' ? maxLeft : 0
      sc.scrollTo({ left: Math.max(0, Math.min(maxLeft, target)), behavior: 'smooth' })
    }
    window.addEventListener('keydown', onArrowCapture, true)
    return () => window.removeEventListener('keydown', onArrowCapture, true)
  }, [])

  // Global keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        setShowPalette((v) => !v)
      } else if (k === 'n') {
        e.preventDefault()
        if (e.shiftKey) void window.crew.openWindow()
        else c.setShowNew(true)
      } else if (k === 'j') {
        e.preventDefault()
        jumpNextWaiting()
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const s = visibleRoster[Number(e.key) - 1]
        if (s) focusSession(s.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.roster, c.selectedId])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const sessionItems: PaletteItem[] = visibleRoster.map((s) => {
      const ch = c.characters.find((x) => x.id === s.characterId)
      return {
        id: 'sess-' + s.id,
        label: s.label,
        hint: STATE_META[s.state].label,
        icon: (
          <Character
            glyph={ch?.glyph ?? '●'}
            id={s.characterId}
            color={s.color}
            state={s.state}
            size={18}
            dot={false}
          />
        ),
        keywords: s.cwd,
        run: () => focusSession(s.id)
      }
    })
    const actions: PaletteItem[] = [
      { id: 'act-new', label: 'New Session', icon: <Icon name="plus" />, hint: '⌘N', run: () => c.setShowNew(true) },
      {
        id: 'act-window',
        label: 'New Window',
        icon: <Icon name="windows" />,
        hint: '⇧⌘N',
        run: () => void window.crew.openWindow()
      },
      {
        id: 'act-view',
        label: c.viewMode === 'grid' ? 'Switch to focus view' : 'Switch to grid view',
        icon: <Icon name={c.viewMode === 'grid' ? 'columns' : 'grid'} />,
        run: () => c.setViewMode(c.viewMode === 'grid' ? 'single' : 'grid')
      },
      { id: 'act-next', label: 'Jump to next waiting', icon: <Icon name="bell" />, hint: '⌘J', run: jumpNextWaiting },
      { id: 'act-broadcast', label: 'Broadcast a prompt…', icon: <Icon name="broadcast" />, run: () => setShowBroadcast(true) },
      { id: 'act-analytics', label: 'Activity & spend', icon: <Icon name="chart" />, run: () => setShowAnalytics(true) },
      { id: 'act-transcripts', label: 'Search transcripts…', icon: <Icon name="search" />, run: () => setShowTranscripts(true) },
      { id: 'act-settings', label: 'Open Settings', icon: <Icon name="settings" />, run: () => setShowSettings(true) }
    ]
    // Workspace switching (mirrors the File → Change Workspace menu).
    const workspaceItems: PaletteItem[] = [
      {
        id: 'ws-all',
        label: 'Workspace: All Sessions',
        icon: <Icon name="filter" />,
        keywords: 'workspace change filter set',
        run: () => c.setActiveWorkspace(null)
      },
      ...c.workspaces.map((name) => ({
        id: 'ws-' + name,
        label: `Workspace: ${name}`,
        icon: <Icon name="filter" />,
        keywords: 'workspace change filter set',
        run: () => c.setActiveWorkspace(name)
      }))
    ]
    return [...sessionItems, ...actions, ...workspaceItems]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoster, c.characters, c.viewMode, c.selectedId, c.workspaces, c.activeWorkspace])

  const navIsCollapsed = c.navCollapsed || c.viewMode === 'grid'
  // Float the rail open on hover whenever it is collapsed — in grid view too.
  const navFloating = navIsCollapsed
  // Advance the grid density 2 → 4 → 6 → 2 (shared by the rail + grid top-bar toggles).
  const cycleGridDensity = (): void => {
    const order = ['two', 'four', 'six'] as const
    c.setGridDensity(order[(order.indexOf(c.gridDensity) + 1) % order.length])
  }
  return (
    <div
      className={`app ${navIsCollapsed ? 'app--nav-collapsed' : ''} ${navFloating ? 'app--nav-floating' : ''}`}
      style={
        {
          '--nav-width': `${navIsCollapsed ? 84 : c.navWidth}px`,
          '--nav-expanded': `${c.navWidth || 300}px`
        } as CSSProperties
      }
    >
      <Roster
        roster={visibleRoster}
        characters={c.characters}
        presets={c.presets}
        selectedId={c.selectedId}
        viewMode={c.viewMode}
        onSetViewMode={c.setViewMode}
        onGridRepeat={cycleGridDensity}
        gridDensity={c.gridDensity}
        collapsed={navIsCollapsed}
        hoverExpand={navFloating}
        onSetCollapsed={c.setNavCollapsed}
        navWidth={c.navWidth}
        onNavWidth={c.setNavWidth}
        groupMode={c.groupMode}
        onSetGroupMode={c.setGroupMode}
        collapsedGroups={c.collapsedGroups}
        onToggleGroup={c.toggleGroup}
        minimized={c.minimized}
        onToggleMinimize={c.toggleMinimize}
        groupOrder={c.groupOrder}
        onReorderGroups={c.reorderGroups}
        onSelect={c.setSelectedId}
        onNew={() => c.setShowNew(true)}
        onReplayIntro={() => setShowIntro(true)}
        onOpenSettings={() => setShowSettings(true)}
        onBroadcast={() => setShowBroadcast(true)}
        onAnalytics={() => setShowAnalytics(true)}
        showSpend={c.settings?.showSpend ?? true}
        showCredits={c.settings?.showCredits ?? false}
        budgetUsd={c.settings?.budgetUsd ?? 0}
        staleHideHours={c.settings?.staleHideHours ?? 12}
        onRestart={restart}
        onClose={close}
        onReorder={(ids) => void window.crew.reorder(ids)}
        onSetTag={(id, tag) => void window.crew.setTag(id, tag)}
        activeWorkspace={c.activeWorkspace}
        onClearWorkspace={() => c.setActiveWorkspace(null)}
      />

      {c.viewMode === 'grid' ? (
        <GridView
          roster={visibleRoster}
          characters={c.characters}
          selectedId={c.selectedId}
          gridDensity={c.gridDensity}
          activeWorkspace={c.activeWorkspace}
          groupMode={c.groupMode}
          onSetGroupMode={c.setGroupMode}
          collapsedGroups={c.collapsedGroups}
          onToggleGroup={c.toggleGroup}
          minimized={c.minimized}
          onToggleMinimize={c.toggleMinimize}
          groupOrder={c.groupOrder}
          onReorderGroups={c.reorderGroups}
          onSelect={c.setSelectedId}
          onExpand={focusSession}
          onClose={close}
          onNew={() => c.setShowNew(true)}
          onReplayIntro={() => setShowIntro(true)}
          onSetViewMode={c.setViewMode}
          onGridRepeat={cycleGridDensity}
          onOpenSettings={() => setShowSettings(true)}
          onBroadcast={() => setShowBroadcast(true)}
          onAnalytics={() => setShowAnalytics(true)}
          showSpend={c.settings?.showSpend ?? true}
          showCredits={c.settings?.showCredits ?? false}
          staleHideHours={c.settings?.staleHideHours ?? 12}
          onReorder={(ids) => void window.crew.reorder(ids)}
          onSetTag={(id, tag) => void window.crew.setTag(id, tag)}
          allGroups={existingGroups(c.roster)}
          onSetCharacter={(id, ch) => void window.crew.setCharacter(id, ch)}
          onSetColor={(id, color) => void window.crew.setColor(id, color)}
        />
      ) : (
        <SessionView
          session={selected}
          characters={c.characters}
          presets={c.presets}
          usedCharacterIds={usedCharacterIds}
          groups={existingGroups(c.roster)}
          onRename={(id, l) => void window.crew.rename(id, l)}
          onSetCharacter={(id, ch) => void window.crew.setCharacter(id, ch)}
          onSetColor={(id, color) => void window.crew.setColor(id, color)}
          onSetTag={(id, tag) => void window.crew.setTag(id, tag)}
          onRestart={restart}
          onClose={close}
          onNew={() => c.setShowNew(true)}
        />
      )}

      {c.showNew && (
        <NewSessionModal
          presets={c.presets}
          homeDir={c.homeDir}
          groups={existingGroups(c.roster)}
          defaultSets={defaultWorkspaces}
          onCancel={() => c.setShowNew(false)}
          onCreate={create}
        />
      )}

      {showSettings && (
        <SettingsModal settings={c.settings} onToggle={c.setSetting} onClose={() => setShowSettings(false)} />
      )}
      {showPalette && <CommandPalette items={paletteItems} onClose={() => setShowPalette(false)} />}
      {showBroadcast && (
        <BroadcastModal
          roster={c.roster}
          characters={c.characters}
          onClose={() => setShowBroadcast(false)}
        />
      )}
      {showAnalytics && (
        <AnalyticsModal
          roster={c.roster}
          characters={c.characters}
          onClose={() => setShowAnalytics(false)}
        />
      )}
      {showTranscripts && (
        <TranscriptsModal
          roster={c.roster}
          selectedId={c.selectedId}
          onClose={() => setShowTranscripts(false)}
        />
      )}

      {showIntro && <TitleSequence onDone={() => setShowIntro(false)} />}
    </div>
  )
}
