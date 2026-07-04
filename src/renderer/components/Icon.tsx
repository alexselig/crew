// Monochrome line icons for the roster header. They inherit `currentColor`, so
// they match the grey .icon-btn text color (and its hover/active states) exactly,
// keeping the header consistent with the settings gear instead of colored emoji.

interface IconProps {
  name: 'tag' | 'broadcast' | 'chart' | 'filter' | 'focus' | 'grid'
  size?: number
}

const PATHS: Record<IconProps['name'], JSX.Element> = {
  tag: (
    <>
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L3 13V3h10l7.59 7.59a2 2 0 0 1 0 2.82Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  broadcast: (
    <>
      <path d="m3 11 18-5v12L3 13Z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  chart: (
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ),
  // Filter / adjustments: three rules, each carrying a dot.
  filter: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="17" r="1.9" fill="currentColor" stroke="none" />
    </>
  ),
  // Focus view: a slim nav column of lines beside one big content box.
  focus: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.2" />
      <line x1="5.3" y1="8.5" x2="7.7" y2="8.5" />
      <line x1="5.3" y1="12" x2="7.7" y2="12" />
      <line x1="5.3" y1="15.5" x2="7.7" y2="15.5" />
      <rect x="12" y="4" width="9" height="16" rx="1.2" />
    </>
  ),
  // Grid view: an even 3x3 lattice.
  grid: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </>
  )
}

export function Icon({ name, size = 15 }: IconProps): JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
