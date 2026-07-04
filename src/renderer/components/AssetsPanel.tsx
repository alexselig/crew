import { useEffect, useState } from 'react'
import type { AssetItem, AssetKind } from '../../shared/assets'
import { assetUrl } from '../../shared/assets'
import { shellQuote } from '../../shared/shell-quote'
import { focusTerminal } from '../terminal-pool'
import { onPreviewRequest } from '../preview-bus'
import { Since } from './Since'

const KIND_GLYPH: Record<AssetKind, string> = {
  image: '🖼',
  html: '🌐',
  pdf: '📄',
  video: '🎞',
  audio: '🔊'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Preview({ asset }: { asset: AssetItem }): JSX.Element {
  // cache-bust so an agent overwriting the same file refreshes the preview
  const src = assetUrl(asset.path) + '?v=' + asset.mtime
  switch (asset.kind) {
    case 'image':
      return <img className="assets__preview-media" src={src} alt={asset.name} />
    case 'html':
      // Scripts allowed (previewing vibe-coded pages is the point); no
      // same-origin, so the page can't reach crew's renderer or IPC.
      return (
        <iframe
          className="assets__preview-frame"
          src={src}
          sandbox="allow-scripts"
          title={asset.name}
        />
      )
    case 'pdf':
      return <iframe className="assets__preview-frame" src={src} title={asset.name} />
    case 'video':
      return <video className="assets__preview-media" src={src} controls />
    case 'audio':
      return <audio className="assets__preview-audio" src={src} controls />
  }
}

/**
 * Live "what did my agent just make?" panel: watches the session cwd (via the
 * main-process AssetWatchers) and previews images, HTML, PDFs etc. in-app.
 */
export function AssetsPanel({ sessionId }: { sessionId: string }): JSX.Element | null {
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem('crew.assetsOpen') !== '0')
  const [selected, setSelected] = useState<AssetItem | null>(null)

  useEffect(() => {
    let mounted = true
    setAssets([])
    setSelected(null)
    void window.crew.listAssets(sessionId).then((a) => mounted && setAssets(a))
    const off = window.crew.onAssets((e) => {
      if (e.id === sessionId) setAssets(e.assets)
    })
    // Clicking a file path in the terminal previews it here (opening the
    // panel if it's collapsed).
    const offPreview = onPreviewRequest((sid, item) => {
      if (sid !== sessionId) return
      localStorage.setItem('crew.assetsOpen', '1')
      setOpen(true)
      setSelected(item)
    })
    return () => {
      mounted = false
      off()
      offPreview()
    }
  }, [sessionId])

  // Keep the preview fresh when the agent overwrites the selected file.
  useEffect(() => {
    if (!selected) return
    const cur = assets.find((a) => a.path === selected.path)
    if (cur && cur.mtime !== selected.mtime) setSelected(cur)
  }, [assets, selected])

  function toggle(): void {
    setOpen((v) => {
      localStorage.setItem('crew.assetsOpen', v ? '0' : '1')
      return !v
    })
  }

  function insertPath(a: AssetItem): void {
    window.crew.sendInput(sessionId, shellQuote(a.path) + ' ')
    focusTerminal(sessionId)
  }

  // Clicking an image opens it in the OS previewer (Preview.app); other kinds
  // toggle the in-app preview pane.
  function activate(a: AssetItem): void {
    if (a.kind === 'image') {
      void window.crew.openAsset(a.path)
      return
    }
    setSelected((prev) => (prev?.path === a.path ? null : a))
  }

  if (!open) {
    return (
      <button
        type="button"
        className="assets-rail"
        title="Show assets"
        onClick={toggle}
      >
        <span className="assets-rail__glyph">🖼</span>
        {assets.length > 0 && <span className="assets-rail__count">{assets.length}</span>}
      </button>
    )
  }

  return (
    <aside className="assets">
      <header className="assets__header">
        <span className="assets__title">
          Assets{assets.length > 0 && <span className="assets__count">{assets.length}</span>}
        </span>
        <button type="button" className="icon-btn" title="Hide assets" onClick={toggle}>
          »
        </button>
      </header>

      {selected && (
        <div className="assets__preview">
          <Preview asset={selected} />
          <div className="assets__preview-bar">
            <span className="assets__preview-name" title={selected.path}>
              {selected.name}
            </span>
            <span className="assets__preview-size">{formatSize(selected.size)}</span>
            <button
              type="button"
              className="icon-btn"
              title="Insert path into terminal"
              onClick={() => insertPath(selected)}
            >
              ⤶
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Reveal in Finder"
              onClick={() => void window.crew.revealAsset(selected.path)}
            >
              📂
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Open with default app"
              onClick={() => void window.crew.openAsset(selected.path)}
            >
              ↗
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Close preview"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="assets__list">
        {assets.length === 0 ? (
          <p className="assets__empty">
            Images, pages and other files your agent creates in this folder will show up here.
          </p>
        ) : (
          assets.map((a) => (
            <div
              key={a.path}
              className={`asset ${a.path === selected?.path ? 'is-selected' : ''}`}
              role="button"
              tabIndex={0}
              title={a.relDir ? `${a.relDir}/${a.name}` : a.name}
              onClick={() => activate(a)}
              onKeyDown={(e) => e.key === 'Enter' && activate(a)}
            >
              {a.kind === 'image' ? (
                <img
                  className="asset__thumb"
                  src={assetUrl(a.path) + '?v=' + a.mtime}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="asset__glyph">{KIND_GLYPH[a.kind]}</span>
              )}
              <span className="asset__meta">
                <span className="asset__name">{a.name}</span>
                <span className="asset__sub">
                  {a.relDir && <span className="asset__dir">{a.relDir}/</span>}
                  <Since from={a.mtime} />
                </span>
              </span>
              <button
                type="button"
                className="icon-btn asset__insert"
                title="Insert path into terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  insertPath(a)
                }}
              >
                ⤶
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
