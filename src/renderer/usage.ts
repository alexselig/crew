/**
 * Renderer-side usage counting.
 *
 * Insights are the least important thing on screen, so this can never be the
 * reason something breaks: if the bridge is missing or the call rejects, it is
 * silently dropped. Mirrors countUsage() in the main process, which swallows
 * errors for the same reason.
 *
 * Still a no-op unless the user has opted in — that decision is enforced in
 * main, so the renderer never needs to know the consent state to stay honest.
 */
export function countUsage(
  event: string,
  fields: { ms?: number; n?: number; v?: string } = {}
): void {
  try {
    void window.crew?.recordUsage?.(event, fields)?.catch?.(() => {})
  } catch {
    /* never worth interrupting the user's work for */
  }
}
