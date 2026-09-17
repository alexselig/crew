import { useNow } from '../now-clock'
import { formatSince } from '../state-meta'

export function Since({ from }: { from: number }): JSX.Element {
  return <span>{formatSince(from, useNow())}</span>
}
