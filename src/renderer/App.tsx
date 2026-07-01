import type { CSSProperties } from 'react'
import { useCrew } from './hooks'
import { Roster } from './components/Roster'
import { SessionView } from './components/SessionView'
import { GridView } from './components/GridView'
import { NewSessionModal } from './components/NewSessionModal'
import type { CreateSessionRequest } from '../shared/types'

export function App(): JSX.Element {
  const c = useCrew()
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
    </div>
  )
}
