import { useMemo } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { GridTile } from './GridTile'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onNew: () => void
}

export function GridView({
  roster,
  characters,
  selectedId,
  onSelect,
  onExpand,
  onNew
}: Props): JSX.Element {
  // Unlike the roster, the grid surfaces the latest input review first: sessions
  // that need you float to the top (stable within each group).
  const ordered = useMemo(() => {
    const rank = (s: SessionInfo): number =>
      s.status === 'active' && NEEDS_YOU.includes(s.state) ? 0 : s.status === 'active' ? 1 : 2
    return roster
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map((x) => x.s)
  }, [roster])

  if (roster.length === 0) {
    return (
      <main className="gridview gridview--empty">
        <div className="empty">
          <div className="empty__glyph">▦</div>
          <h2>No sessions yet</h2>
          <p>Launch some agents and they'll appear here as a live dashboard.</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={onNew}>
            ＋ New Session
          </button>
        </div>
      </main>
    )
  }

  const charById = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)

  return (
    <main className="gridview">
      <div className="grid">
        {ordered.map((s) => (
          <GridTile
            key={s.id}
            session={s}
            character={charById(s.characterId)}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onExpand={() => onExpand(s.id)}
          />
        ))}
      </div>
    </main>
  )
}
