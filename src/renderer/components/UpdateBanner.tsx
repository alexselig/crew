import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../shared/update'

const DISMISS_KEY = 'crew.updateDismissed'

/**
 * A subtle "update available" toast. The main process checks GitHub Releases in
 * the background (and on mount here); when a newer signed release exists this
 * surfaces a one-click download. Dismissing remembers the version so it won't
 * nag again for the same release — but a later version will still show.
 */
export function UpdateBanner(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) ?? ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    let alive = true
    void window.crew.checkForUpdate().then((u) => {
      if (alive && u) setInfo(u)
    })
    const off = window.crew.onUpdate((u) => setInfo(u))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!info || info.version === dismissed) return null

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, info.version)
    } catch {
      /* ignore */
    }
    setDismissed(info.version)
  }

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-toast__spark" aria-hidden>
        ↑
      </span>
      <div className="update-toast__body">
        <span className="update-toast__title">
          Crew <strong>v{info.version}</strong> is available
        </span>
        <span className="update-toast__sub">A newer signed build is ready to download.</span>
      </div>
      <button
        type="button"
        className="btn btn--primary update-toast__btn"
        onClick={() => void window.crew.openExternal(info.url)}
      >
        Download
      </button>
      <button type="button" className="update-toast__dismiss" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
