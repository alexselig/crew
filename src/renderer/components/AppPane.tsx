import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { CrewWebviewElement } from '../webview'
import { isLoopbackHttp } from '../../shared/detection'

interface Props {
  sessionId: string
  /** A dev-server URL detected in this session's output, if any. */
  appUrl?: string
}

type Phase = 'idle' | 'launching' | 'loading' | 'ready' | 'failed'

/**
 * The session "App" pane: renders a session's local dev server in an isolated
 * Electron <webview>. Shows the detected app URL when present, otherwise offers
 * to launch the working dir's dev server (reusing the tracker launcher). The
 * webview is hardened + loopback-only in the main process (will-attach-webview).
 */
export function AppPane({ sessionId, appUrl }: Props): JSX.Element {
  const ref = useRef<CrewWebviewElement | null>(null)
  const [url, setUrl] = useState<string | null>(appUrl && isLoopbackHttp(appUrl) ? appUrl : null)
  const [phase, setPhase] = useState<Phase>(url ? 'loading' : 'idle')
  const [note, setNote] = useState<string>('')
  const [launched, setLaunched] = useState(false)

  // Adopt a freshly-detected URL if we didn't have one yet (agent started its
  // server after the pane opened).
  useEffect(() => {
    if (!url && appUrl && isLoopbackHttp(appUrl)) {
      setUrl(appUrl)
      setPhase('loading')
    }
  }, [appUrl, url])

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
  const launch = async (): Promise<void> => {
    setPhase('launching')
    setNote('Starting dev server… (first compile can take ~10–20s)')
    try {
      const res = await window.crew.launchProject(sessionId)
      if (res.ok && res.url && isLoopbackHttp(res.url)) {
        setLaunched(!res.external)
        setUrl(res.url)
        setPhase('loading')
        setNote(res.slow ? 'Still compiling — the app will appear shortly.' : '')
      } else {
        setPhase('idle')
        setNote(res.error || 'Could not start a dev server for this folder.')
      }
    } catch (e) {
      setPhase('idle')
      setNote(e instanceof Error ? e.message : String(e))
    }
  }
  const stop = async (): Promise<void> => {
    await window.crew.stopProject(sessionId)
    setLaunched(false)
    setUrl(null)
    setPhase('idle')
    setNote('')
  }

  if (!url) {
    return (
      <div className="app-pane app-pane--empty">
        <div className="app-pane__empty">
          <Icon name="globe" size={26} />
          {phase === 'launching' ? (
            <>
              <p className="app-pane__empty-title">Launching…</p>
              <p className="app-pane__empty-sub">{note}</p>
            </>
          ) : (
            <>
              <p className="app-pane__empty-title">No app detected yet</p>
              <p className="app-pane__empty-sub">
                {note || 'Start a dev server in the terminal, or launch this project’s dev server.'}
              </p>
              <button type="button" className="btn btn--primary" onClick={() => void launch()}>
                Launch app
              </button>
            </>
          )}
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
        {launched && (
          <button type="button" className="app-pane__ctl" title="Stop dev server" onClick={() => void stop()}>
            <Icon name="x" size={13} />
          </button>
        )}
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
