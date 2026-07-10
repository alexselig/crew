import { LayoutGlyph, type LayoutState } from './LayoutGlyph'
import type { ViewMode, GridDensity } from '../hooks'

const DENSITY_STATE: Record<GridDensity, LayoutState> = { two: 2, four: 4, six: 6 }
const DENSITY_LABEL: Record<GridDensity, string> = { two: 'Split (2)', four: 'Quad (4)', six: 'Six-up (6)' }

/**
 * Focus / grid view switch. The grid button doubles as a live layout indicator:
 * its glyph shows the current grid density (2 / 4 / 6 panes) and clicking it
 * while already in grid view advances to the next density, so the icon always
 * matches the current window layout. Shared by the sidebar toolbar and the grid
 * top bar so the control never diverges.
 */
export function ViewToggle({
  mode,
  density,
  onChange,
  onGridRepeat
}: {
  mode: ViewMode
  /** Current grid density, previewed by (and cycled from) the grid button. */
  density: GridDensity
  onChange: (m: ViewMode) => void
  /** Called when the grid button is clicked while already in grid view. */
  onGridRepeat?: () => void
}): JSX.Element {
  return (
    <div className="view-toggle" role="tablist" aria-label="View mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'single'}
        className={`view-toggle__btn ${mode === 'single' ? 'is-active' : ''}`}
        title="Focus view (single pane)"
        onClick={() => onChange('single')}
      >
        <LayoutGlyph state={1} size={14} />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'grid'}
        className={`view-toggle__btn ${mode === 'grid' ? 'is-active' : ''}`}
        title={
          mode === 'grid'
            ? `Grid view · ${DENSITY_LABEL[density]} — click to change layout`
            : `Grid view · ${DENSITY_LABEL[density]}`
        }
        onClick={() => (mode === 'grid' && onGridRepeat ? onGridRepeat() : onChange('grid'))}
      >
        <LayoutGlyph state={DENSITY_STATE[density]} size={14} />
      </button>
    </div>
  )
}

