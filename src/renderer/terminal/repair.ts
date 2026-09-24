/**
 * Repair panes that are already drawing mangled output.
 *
 * Sessions started before a pane reported its width booted into a terminal of
 * the wrong size and drew their first layout for it. Correcting the size fixes
 * what the agent draws next; it does nothing about what is already on screen,
 * because no redraw rewrites scrollback. So repairing is two moves: throw away
 * the damaged rendering, then make the agent draw itself again.
 *
 * The order is the part worth guarding. Clearing after the redraw signal would
 * wipe the very output the repair just asked for and leave a blank pane.
 */
export async function repairRendering(
  ids: string[],
  clearPane: (id: string) => void,
  signalRedraw: (id?: string) => Promise<number>
): Promise<number> {
  for (const id of ids) {
    try {
      clearPane(id)
    } catch {
      // A pane with no live emulator has nothing to clear; the redraw below
      // still applies to the session behind it.
    }
  }
  return signalRedraw()
}
