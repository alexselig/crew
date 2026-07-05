import { Icon } from './Icon'
import type { ViewMode } from '../hooks'

/**
 * Segmented focus/grid view switch. Shared by the expanded sidebar toolbar and
 * the grid-view top bar so the control never diverges between the two.
 */
export function ViewToggle({
  mode,
  onChange
}: {
  mode: ViewMode
  onChange: (m: ViewMode) => void
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
        title="Grid view"
        onClick={() => onChange('grid')}
      >
        <Icon name="grid" size={14} />
      </button>
    </div>
  )
}
