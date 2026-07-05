interface Props {
  /** Extra class on the root, e.g. to drive intro animation phases. */
  className?: string
}

/**
 * The Crew brand lockup: serif italic wordmark over a rule / terminal-glyph /
 * rule divider, with a mono tagline. Used on the title launch sequence and
 * anywhere the full logo is needed. Inherits `currentColor` (ivory by default).
 */
export function CrewLogo({ className = '' }: Props): JSX.Element {
  return (
    <div className={`crew-logo ${className}`.trim()} aria-label="Crew">
      <div className="crew-logo__word">Crew</div>
      <div className="crew-logo__divider">
        <span className="crew-logo__rule" />
        <span className="crew-logo__term" aria-hidden="true">
          <svg viewBox="0 0 36 30" width="36" height="30" fill="none">
            <rect
              x="1.5"
              y="1.5"
              width="33"
              height="27"
              rx="5"
              stroke="currentColor"
              strokeWidth="2"
            />
            <polyline
              points="9,10 14,15 9,20"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="17"
              y1="20"
              x2="26"
              y2="20"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="crew-logo__rule" />
      </div>
      <div className="crew-logo__tag">Your Agents Organized</div>
    </div>
  )
}
