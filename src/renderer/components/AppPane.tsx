import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { CrewWebviewElement } from '../webview'
import { isLoopbackHttp } from '../../shared/detection'

interface Props {
  /** A dev-server URL detected in this session's output, if any. */
  appUrl?: string
}

type Phase = 'loading' | 'ready' | 'failed'

/**
 * The session "App" pane: a read-only viewer that renders a session's local dev
 * server in an isolated Electron <webview>. Crew shows it only once it has
 * detected a loopback URL in the session's own output — start the dev server in
 * the terminal and it appears here. The webview is hardened + loopback-only in
 * the main process (will-attach-webview). Crew never launches anything itself.
 */
export function AppPane({ appUrl }: Props): JSX.Element {
  const ref = useRef<CrewWebviewElement | null>(null)
  const url = appUrl && isLoopbackHttp(appUrl) ? appUrl : null
  const [phase, setPhase] = useState<Phase>('loading')

  // Reset to the loading state whenever the URL changes (e.g. the server
  // restarted on a new port).
  useEffect(() => {
    if (url) setPhase('loading')
  }, [url])

  // Wire webview lifecycle events to drive the load/failed states.
  useEffect(() => {
    const wv = ref.current
    if (!wv || !url) return
    const onLoad = (): void => setPhase('ready')
    const onFail = (e: Event): void => {
      // -3 is ABORTED (e.g. a redirect); ignore those, surface real failures.
      const code = (e as unknown as { errorCode?: number }).errorCode
      if (code === -3) return
      setPhase('failed')
    }
    const onStart = (): void => setPhase((p) => (p === 'ready' ? 'ready' : 'loading'))
    wv.addEventListener('did-finish-load', onLoad)
    wv.addEventListener('did-fail-load', onFail as EventListener)
    wv.addEventListener('did-start-loading', onStart)
    return () => {
      wv.removeEventListener('did-finish-load', onLoad)
      wv.removeEventListener('did-fail-load', onFail as EventListener)
      wv.removeEventListener('did-start-loading', onStart)
    }
  }, [url])

  const reload = (): void => {
    setPhase('loading')
    ref.current?.reload()
  }
  const openExternal = (): void => {
    if (url) void window.crew.openExternal(url)
  }

  if (!url) {
    return (
      <div className="app-pane app-pane--empty">
        <div className="app-pane__empty">
          <Icon name="globe" size={26} />
          <p className="app-pane__empty-title">No app running yet</p>
          <p className="app-pane__empty-sub">
            Start your app’s dev server in the terminal (e.g. <code>npm run dev</code>). When Crew sees its
            local URL, the app shows up here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-pane">
      <div className="app-pane__bar">
        <button type="button" className="app-pane__ctl" title="Reload" onClick={reload}>
          <Icon name="refresh" size={13} />
        </button>
        <span className="app-pane__url" title={url}>
          {url}
        </span>
        {phase === 'loading' && <span className="app-pane__spin" aria-hidden />}
        <button type="button" className="app-pane__ctl" title="Open in browser" onClick={openExternal}>
          <Icon name="external" size={13} />
        </button>
      </div>
      <div className="app-pane__view">
        {phase === 'failed' && (
          <div className="app-pane__overlay">
            <p className="app-pane__empty-title">Couldn’t reach the app</p>
            <p className="app-pane__empty-sub">The dev server may still be starting or has stopped.</p>
            <button type="button" className="btn btn--primary" onClick={reload}>
              Retry
            </button>
          </div>
        )}
        <webview ref={ref} src={url} partition="persist:crewapp" className="app-pane__webview" />
      </div>
    </div>
  )
}
