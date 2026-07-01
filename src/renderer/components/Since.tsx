import { useEffect, useState } from 'react'
import { formatSince } from '../state-meta'

/** Live "time in current state" ticker (updates every second). */
export function Since({ from }: { from: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{formatSince(from, now)}</span>
}
