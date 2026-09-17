import type { SessionInfo, SessionState, Settings } from '../shared/types'
import { NEEDS_YOU } from '../shared/types'

interface NeedsYouTransition {
  session: SessionInfo
  from: SessionState
  to: SessionState
}

interface NotificationTray {
  notify(session: SessionInfo, silent: boolean): void
  suppress(id: string): void
}

export function handleNeedsYouTransition(
  transition: NeedsYouTransition,
  settings: Pick<Settings, 'notifications' | 'sound'>,
  tray: NotificationTray | null,
  isForeground: () => boolean
): void {
  const { session, from, to } = transition
  if (!NEEDS_YOU.includes(to) || NEEDS_YOU.includes(from) || !settings.notifications) return
  if (isForeground()) {
    tray?.suppress(session.id)
    return
  }
  tray?.notify(session, !settings.sound)
}
