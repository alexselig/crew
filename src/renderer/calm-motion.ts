import { useEffect } from 'react'

/** Attribute the calm-motion CSS swap keys off (see styles.css). */
export const CALM_MOTION_ATTR = 'data-calm-motion'

/**
 * Publish the "Calm working animation" setting on <html>.
 *
 * It goes on the document element rather than the app root so it also reaches
 * mascots rendered in portals — the command palette and modals mount outside
 * the app subtree. The attribute is removed rather than set to 'off' when the
 * setting is disabled, so the default path costs no selector matching.
 */
export function useCalmMotion(enabled: boolean): void {
  useEffect(() => {
    const el = document.documentElement
    if (enabled) el.setAttribute(CALM_MOTION_ATTR, 'on')
    else el.removeAttribute(CALM_MOTION_ATTR)
    return () => el.removeAttribute(CALM_MOTION_ATTR)
  }, [enabled])
}
