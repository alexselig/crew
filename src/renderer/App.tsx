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
import { focusTerminal } from './terminal-pool'
import { existingGroups } from './grouping'
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

  // Global keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // Arrow keys scroll the grid when focus is on the app chrome — but never
      // eat them while a text field or the terminal (an xterm hidden textarea)
      // has focus.
      if (e.key.startsWith('Arrow') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
        const sc = document.querySelector<HTMLElement>('.gridview__scroll')
        if (!sc) return
        const tile = sc.querySelector<HTMLElement>('.tile')
        const stepX = tile?.offsetWidth ?? 240
        const stepY = tile?.offsetHeight ?? 240
        const dx = e.key === 'ArrowLeft' ? -stepX : e.key === 'ArrowRight' ? stepX : 0
        const dy = e.key === 'ArrowUp' ? -stepY : e.key === 'ArrowDown' ? stepY : 0
        if (dx || dy) {
          e.preventDefault()
          sc.scrollBy({ left: dx, top: dy, behavior: 'smooth' })
        }
        return
      }
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
    const sessionItems: PaletteItem[] = visibleRoster.map((s) => ({
      id: 'sess-' + s.id,
      label: s.label,
      hint: STATE_META[s.state].label,
      glyph: c.characters.find((ch) => ch.id === s.characterId)?.glyph ?? '●',
      keywords: s.cwd,
      run: () => focusSession(s.id)
    }))
    const actions: PaletteItem[] = [
      { id: 'act-new', label: 'New Session', glyph: '＋', hint: '⌘N', run: () => c.setShowNew(true) },
      {
        id: 'act-window',
        label: 'New Window',
        glyph: '⧉',
        hint: '⇧⌘N',
        run: () => void window.crew.openWindow()
      },
      {
        id: 'act-view',
        label: c.viewMode === 'grid' ? 'Switch to focus view' : 'Switch to grid view',
        glyph: c.viewMode === 'grid' ? '▤' : '▦',
        run: () => c.setViewMode(c.viewMode === 'grid' ? 'single' : 'grid')
      },
      { id: 'act-next', label: 'Jump to next waiting', glyph: '🔴', hint: '⌘J', run: jumpNextWaiting },
      { id: 'act-broadcast', label: 'Broadcast a prompt…', glyph: '📣', run: () => setShowBroadcast(true) },
      { id: 'act-analytics', label: 'Activity & spend', glyph: '📊', run: () => setShowAnalytics(true) },
      { id: 'act-transcripts', label: 'Search transcripts…', glyph: '🔎', run: () => setShowTranscripts(true) },
      { id: 'act-settings', label: 'Open Settings', glyph: '⚙', run: () => setShowSettings(true) }
    ]
    // Workspace switching (mirrors the File → Change Workspace menu).
    const workspaceItems: PaletteItem[] = [
      {
        id: 'ws-all',
        label: 'Workspace: All Sessions',
        glyph: '🗂',
        keywords: 'workspace change filter set',
        run: () => c.setActiveWorkspace(null)
      },
      ...c.workspaces.map((name) => ({
        id: 'ws-' + name,
        label: `Workspace: ${name}`,
        glyph: '🗂',
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
          defaultSets={c.activeWorkspace ? [c.activeWorkspace] : []}
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
