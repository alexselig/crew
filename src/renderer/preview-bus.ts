// Tiny renderer-side event bus connecting terminal link clicks (terminal-pool)
// to the AssetsPanel preview, without threading callbacks through the pool.

import type { AssetItem } from '../shared/assets'

type PreviewCb = (sessionId: string, asset: AssetItem) => void

const subs = new Set<PreviewCb>()

export function onPreviewRequest(cb: PreviewCb): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function requestPreview(sessionId: string, asset: AssetItem): void {
  for (const cb of subs) cb(sessionId, asset)
}

/**
 * Resolve a path token printed by the agent (via main, which stats it and adds
 * it to the session's asset list) and preview it. No-op for dead paths.
 */
export async function previewToken(sessionId: string, token: string): Promise<void> {
  const item = await window.crew.resolveAsset(sessionId, token)
  if (item) requestPreview(sessionId, item)
}
