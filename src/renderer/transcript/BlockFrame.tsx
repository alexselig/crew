import type { ReactNode } from 'react'

/**
 * The rail frame every block hangs off: a tick on the hairline session rail,
 * an uppercase mono meta line, and the block body.
 */
export function BlockFrame({
  variant,
  tick,
  meta,
  children
}: {
  /** Suffix for the tr-blk-- modifier class, e.g. 'user', 'tool', 'ask'. */
  variant: string
  tick: ReactNode
  meta?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`tr-blk tr-blk--${variant}`}>
      <div className="tr-blk__tick">{tick}</div>
      <div className="tr-blk__body">
        {meta != null && <div className="tr-blk__meta">{meta}</div>}
        {children}
      </div>
    </div>
  )
}

/** "2:14 pm" from an epoch timestamp, for block meta lines. */
export function fmtTime(ts?: number): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

/** "1.2s" / "340ms" for tool-run durations. */
export function fmtDuration(ms?: number): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
