# Retired sessions rebuilt from flat text — the third pane-rendering bug

Third and final leg of the "panes render wrong" reports. 0.7.1 and 0.7.3 both
fixed real bugs and both left the symptom in place, which is the signal that the
remaining cause was structural rather than another ordering slip.

## Symptom

Rows duplicated and composited on top of each other: a line the agent had
already replaced still on screen, and its replacement drawn again further down.
Not the 0.7.1/0.7.3 symptom (text wrapped at 100 columns), which is why those
fixes did not touch it.

## Root cause

`retire()` bounded the pool by disposing the emulator of a session nobody is
watching, keeping a **plain-text** snapshot (`getVisibleText()`) to replay when
the session comes back.

Plain text cannot restore a terminal. It loses:

- **the cursor position** — the decisive one
- SGR attributes and colours
- the active buffer (normal vs alternate)

A CLI agent repaints *relative to the cursor*: `ESC[1A`, erase, rewrite. After a
flat-text replay the cursor sits at the bottom of the dumped buffer, far from
where the agent left it, so the next repaint lands on the wrong row. The old
content is never erased and the new content is drawn somewhere else — exactly
the duplication seen.

### Why it was constant rather than occasional

`MAX_LIVE_ENGINES` is 12. The reporting user's store held **118 live sessions**,
so retirement was the normal path, not an edge case. Nearly every session
revisited had been through the lossy round trip.

## Fix

Snapshot with `@xterm/addon-serialize`, xterm's supported mechanism for this,
which emits an escape-sequence stream reproducing attributes, cursor position
and alt-buffer state. Flat text stays as a fallback if serialization fails —
degraded, but never worse than what it replaced.

The snapshot's scrollback is capped (`SNAPSHOT_SCROLLBACK`, 1000 lines) because
one is held per dormant session and an unbounded renderer heap is the very thing
the pool exists to prevent. The viewport is always serialized; only history
above it is trimmed.

## Tests

`test/renderer-regressions.test.ts`, against a real xterm in a real browser,
compares a terminal that was round-tripped through the snapshot with one that
never was, after both receive the *same* cursor-relative repaint:

- normal buffer — fails without the fix, with `thinking...` left on screen and
  `done.` landing 20 rows below
- alternate buffer — asserts the rebuilt terminal is still in alt mode; fails
  without the fix

Both were confirmed to fail with the fix reverted. An earlier version of the alt
test asserted only text equality and passed either way; it was rewritten rather
than kept, because a test that cannot fail proves nothing.
