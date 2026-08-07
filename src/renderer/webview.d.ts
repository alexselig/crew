// Ambient JSX typing for Electron's <webview> tag, used by the session "App"
// pane (AppPane). Kept renderer-local and minimal — only the attributes and
// element methods/events Crew actually uses. Enabled by webviewTag:true on the
// main window's webPreferences (see src/main/index.ts).

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/** The subset of Electron's WebviewTag surface AppPane relies on. */
export interface CrewWebviewElement extends HTMLElement {
  src: string
  reload(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  stop(): void
}

interface WebviewAttributes extends HTMLAttributes<CrewWebviewElement> {
  src?: string
  partition?: string
  /** Kept as a string attribute; React lowercases unknown DOM attrs. */
  useragent?: string
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewAttributes, CrewWebviewElement>
    }
  }
}
