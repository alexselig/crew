# Pane rendering repair — why 0.7.1 did not finish the job

2026-09-23

## Symptom

Agent panes still render wrapped, fragmented, half-blank output: in-place
redraws miss their own previous line and pile up as stranded prefixes, columns
land mid-pane, long lines wrap early. 0.7.1 shipped a fix for exactly this and
the reports did not stop.

## What 0.7.1 actually fixed

`resize()` used to drop a size reported before the PTY existed. A pane reports
its size as soon as it mounts, which for a session started from an *already
open* pane is before spawn, so that number went on the floor and the process
spent its life believing it had 100 columns. 0.7.1 made `resize()` record the
size even with no process, and `spawn` read it back.

That is a real fix, and it covers exactly one path: the pane was already open
when the session started.

## Why it survived

The common path is the other one. Sessions restore **asleep** so a large roster
costs nothing at launch (`restore?.defer` → `ASLEEP`), and opening a pane is
what wakes them. On that path three things lined up:

1. **`TerminalView.tsx` woke before it measured.** `window.crew.wake(id)` ran
   synchronously on mount; the pane's size only reached the main process from
   `fit()`, which first ran a frame later inside `requestAnimationFrame`. The
   agent was spawned ~16ms before anyone told it how wide the pane was.
2. **`CrewTerminal.tsx` had the identical defect.** Same order, second copy.
3. **`cols`/`rows` were never persisted.** `persistSessions()` omitted them and
   `create()` hardcoded `DEFAULT_COLS`/`DEFAULT_ROWS`, so every relaunch reset
   every session to 100×30 regardless of what the pane had reported before.

So after any restart, opening a restored session spawned its agent at 100×30
and corrected it a frame too late — after the agent had already drawn its first
layout for a 100-column terminal.

`test/pty-size-desync.test.ts` was blind to this. Its tests call `resize()`
*before* `wake()`, an ordering the renderer never actually performed, and one
test asserted only `cols > 0` for the un-measured case — which is precisely the
production path for every restored session.

## The fix

**Ordering.** Mount the terminal, fit, report, *then* wake. `p.term.open(host)`
must come first because the pane cannot be measured before it exists, so `wake`
moved after the first synchronous fit rather than the fit moving earlier. The
sequence is now `startPaneSession()` — a function with barely any body, named
and tested because the order is the entire contract, is invisible at the call
site, and has already been got wrong once.

**Persistence.** `cols`/`rows` are saved and restored, so even a mount that is
not yet measurable spawns at the last size that pane really had, instead of the
default. `resize()` marks the existing `persistDirty` flag rather than writing,
because it fires continuously while a window edge is dragged and the tick
collapses that into one write.

These are complementary, not redundant: ordering fixes the common case,
persistence covers the case where the synchronous measure returns null.

## Repairing sessions that are already damaged

Fixing the spawn does nothing for an agent already running at the wrong size,
which is every session the user currently has open. Repair is two moves:

- **Make the agent redraw.** Resizing to the size it already has signals
  nothing, so `repair()` nudges the width by one column and back. Both edges
  raise SIGWINCH, which is what makes a TUI re-render from its own model.
- **Throw away the damaged rendering.** No redraw rewrites scrollback.
  `clearPane()` resets the emulator *and* drops `scrollbackSnapshot` and the raw
  tail — without that, retiring and reopening the pane replays the mangled text
  straight back from the rebuild path.

Order matters: clear first, then signal. Signalling first means the clear wipes
the very output the repair just asked for.

Blocks and the transcript are deliberately kept. They are the session's real
history, they are not what the width bug damaged, and dropping them would turn
a rendering repair into data loss.

**Nothing mangled is persisted to disk.** `pendingOutput` is a transient flush
buffer and `transcriptBytes` reads the *agent's* own conversation file, which
Crew never replays into a terminal. So the cleanup is a live operation, not a
migration, and it cannot corrupt saved state.

Surfaced as **Repair session rendering** in the ⌘K palette, acting on every
session at once. `window.crew.repair(id)` takes an optional id for a single
session.

## Verification

- `test/pane-start-order.test.ts` — measure-before-wake, plus the two
  degraded paths (unmeasurable, throwing) that must still start the agent.
- `test/repair-rendering.test.ts` — clear-before-redraw.
- `test/pty-size-desync.test.ts` — size survives a restart; repair nudges and
  restores; a sleeping session reports nothing to repair.

Each ordering test was confirmed to fail against the reversed sequence, and the
persistence test failed with `{cols: 100, rows: 30}` before the fix.
