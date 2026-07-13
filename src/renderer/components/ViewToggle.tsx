import { Icon } from './Icon'
import { LayoutGlyph, type LayoutState } from './LayoutGlyph'
import type { ViewMode, GridDensity } from '../hooks'

const DENSITY_STATE: Record<GridDensity, LayoutState> = { two: 2, four: 4, six: 6 }
const DENSITY_LABEL: Record<GridDensity, string> = { two: 'Split (2)', four: 'Quad (4)', six: 'Six-up (6)' }

/**
 * Focus / grid view switch. The focus button keeps its columns icon; the grid
 * button shows a 3×3 "grid" glyph by default and, once grid view is active,
 * becomes a live layout indicator — its glyph reflects the current density
 * (2 / 4 / 6 panes) and clicking it again cycles the layout. Shared by the
 * sidebar toolbar and the grid top bar so the control never diverges.
 */
export function ViewToggle({
  mode,
  density,
  onChange,
  onGridRepeat
}: {
  mode: ViewMode
  /** Current grid density, reflected by (and cycled from) the grid button once in grid view. */
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
        title="Focus view"
        onClick={() => onChange('single')}
      >
        <Icon name="columns" size={14} />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'grid'}
        className={`view-toggle__btn ${mode === 'grid' ? 'is-active' : ''}`}
        title={
          mode === 'grid'
            ? `Grid view · ${DENSITY_LABEL[density]} — click to change layout`
            : 'Grid view'
        }
        onClick={() => (mode === 'grid' && onGridRepeat ? onGridRepeat() : onChange('grid'))}
      >
        {/* Default 3×3 grid glyph in focus view; reflects the live density in grid view. */}
        <LayoutGlyph state={mode === 'grid' ? DENSITY_STATE[density] : 1} size={14} />
      </button>
    </div>
  )
}

