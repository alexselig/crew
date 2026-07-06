import { Icon } from './Icon'
import type { ViewMode } from '../hooks'

/**
 * Segmented focus/grid view switch. Shared by the expanded sidebar toolbar and
 * the grid-view top bar so the control never diverges between the two.
 */
export function ViewToggle({
  mode,
  onChange,
  onGridRepeat
}: {
  mode: ViewMode
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
        title={mode === 'grid' ? 'Grid view — click to change density' : 'Grid view'}
        onClick={() => (mode === 'grid' && onGridRepeat ? onGridRepeat() : onChange('grid'))}
      >
        <Icon name="grid" size={14} />
      </button>
    </div>
  )
}
