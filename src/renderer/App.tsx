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
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { focusTerminal } from './terminal-pool'
import { NEEDS_YOU } from '../shared/types'
import { STATE_META } from './state-meta'
import type { CreateSessionRequest } from '../shared/types'

export function App(): JSX.Element {
  const c = useCrew()
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const anyOverlay = showSettings || showPalette || showBroadcast || showAnalytics || c.showNew
  const selected = c.roster.find((s) => s.id === c.selectedId) ?? null
  const usedCharacterIds = c.roster
    .filter((s) => s.status === 'active' && s.id !== selected?.id)
    .map((s) => s.characterId)

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

  // Return keyboard focus to the terminal whenever overlays (modals/palette)
  // close — otherwise focus is left on <body> and typed input goes nowhere.
  useEffect(() => {
    if (anyOverlay || c.viewMode !== 'single' || !c.selectedId) return
    const id = c.selectedId
    const raf = requestAnimationFrame(() => focusTerminal(id))
    return () => cancelAnimationFrame(raf)
  }, [anyOverlay, c.viewMode, c.selectedId])

  function jumpNextWaiting(): void {
    const waiting = c.roster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state))
    if (waiting.length === 0) return
    const cur = waiting.findIndex((s) => s.id === c.selectedId)
    focusSession(waiting[(cur + 1) % waiting.length].id)
  }

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
        c.setShowNew(true)
      } else if (k === 'j') {
        e.preventDefault()
        jumpNextWaiting()
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const s = c.roster[Number(e.key) - 1]
        if (s) focusSession(s.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.roster, c.selectedId])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const sessionItems: PaletteItem[] = c.roster.map((s) => ({
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
        id: 'act-view',
        label: c.viewMode === 'grid' ? 'Switch to focus view' : 'Switch to grid view',
        glyph: c.viewMode === 'grid' ? '▤' : '▦',
        run: () => c.setViewMode(c.viewMode === 'grid' ? 'single' : 'grid')
      },
      { id: 'act-next', label: 'Jump to next waiting', glyph: '🔴', hint: '⌘J', run: jumpNextWaiting },
      { id: 'act-broadcast', label: 'Broadcast a prompt…', glyph: '📣', run: () => setShowBroadcast(true) },
      { id: 'act-analytics', label: 'Activity & spend', glyph: '📊', run: () => setShowAnalytics(true) },
      { id: 'act-settings', label: 'Open Settings', glyph: '⚙', run: () => setShowSettings(true) }
    ]
    return [...sessionItems, ...actions]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.roster, c.characters, c.viewMode, c.selectedId])

  return (
    <div
      className={`app ${c.navCollapsed ? 'app--nav-collapsed' : ''}`}
      style={{ '--nav-width': `${c.navCollapsed ? 84 : c.navWidth}px` } as CSSProperties}
    >
      <Roster
        roster={c.roster}
        characters={c.characters}
        presets={c.presets}
        selectedId={c.selectedId}
        viewMode={c.viewMode}
        onSetViewMode={c.setViewMode}
        collapsed={c.navCollapsed}
        onSetCollapsed={c.setNavCollapsed}
        navWidth={c.navWidth}
        onNavWidth={c.setNavWidth}
        onSelect={c.setSelectedId}
        onJump={focusSession}
        onNew={() => c.setShowNew(true)}
        onOpenSettings={() => setShowSettings(true)}
        onBroadcast={() => setShowBroadcast(true)}
        onAnalytics={() => setShowAnalytics(true)}
        showSpend={c.settings?.showSpend ?? true}
        showCredits={c.settings?.showCredits ?? false}
        budgetUsd={c.settings?.budgetUsd ?? 0}
        onRestart={restart}
        onClose={close}
        onReorder={(ids) => void window.crew.reorder(ids)}
      />

      {c.viewMode === 'grid' ? (
        <GridView
          roster={c.roster}
          characters={c.characters}
          selectedId={c.selectedId}
          onSelect={c.setSelectedId}
          onExpand={focusSession}
          onNew={() => c.setShowNew(true)}
        />
      ) : (
        <SessionView
          session={selected}
          characters={c.characters}
          presets={c.presets}
          usedCharacterIds={usedCharacterIds}
          onRename={(id, l) => void window.crew.rename(id, l)}
          onSetCharacter={(id, ch) => void window.crew.setCharacter(id, ch)}
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
    </div>
  )
}
