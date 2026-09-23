import { describe, it, expect } from 'vitest'
import { DropTracker, dragHasFiles } from '../src/renderer/terminal/drop-tracker'

/**
 * Regression: "drag and drop into the terminal stopped working for this
 * session", and panes that look blank.
 *
 * The drop overlay was driven by a depth counter whose handlers returned early
 * when the payload did not advertise 'Files' -- including the drop handler,
 * which was the only thing that reset the counter. Any unbalanced
 * dragenter/dragleave pair therefore stranded the counter above zero, leaving a
 * tinted, pointer-events-none panel permanently covering the terminal. Because
 * the counter is per pane, exactly one session breaks and stays broken.
 */
describe('DropTracker', () => {
  it('shows the overlay for a file drag and hides it again on leave', () => {
    const t = new DropTracker()
    expect(t.enter(true)).toBe(true)
    expect(t.leave(true)).toBe(false)
  })

  it('does not flicker while the drag crosses child elements', () => {
    const t = new DropTracker()
    t.enter(true) // pane
    t.enter(true) // child
    expect(t.leave(true)).toBe(true) // left the pane for the child: still over
    expect(t.leave(true)).toBe(false)
  })

  it('ignores Crew\'s own non-file drags', () => {
    const t = new DropTracker()
    expect(t.enter(false)).toBe(false)
    expect(t.active).toBe(false)
  })

  it('clears on a drop whose payload does not advertise files', () => {
    // The old handler returned before resetting here, which is what stranded
    // the overlay: entered as a file drag, dropped as something else.
    const t = new DropTracker()
    t.enter(true)
    expect(t.end()).toBe(false)
  })

  it('clears when a drag is cancelled after entering', () => {
    const t = new DropTracker()
    t.enter(true)
    t.enter(true)
    expect(t.end()).toBe(false)
  })

  it('recovers from an unbalanced enter so the next drag still works', () => {
    const t = new DropTracker()
    t.enter(true)
    t.enter(true)
    t.leave(true) // one leave goes missing (drag left the window)
    expect(t.active).toBe(true)
    t.end() // window-level safety net
    expect(t.active).toBe(false)

    // The next drag on this same pane must behave normally.
    expect(t.enter(true)).toBe(true)
    expect(t.leave(true)).toBe(false)
  })

  it('never goes negative, so a stray leave cannot invert the next drag', () => {
    const t = new DropTracker()
    t.leave(true)
    t.leave(true)
    expect(t.active).toBe(false)
    expect(t.enter(true)).toBe(true)
    expect(t.leave(true)).toBe(false)
  })

  it('detects file payloads', () => {
    expect(dragHasFiles(['Files'])).toBe(true)
    expect(dragHasFiles(['text/plain'])).toBe(false)
    expect(dragHasFiles([])).toBe(false)
  })
})
