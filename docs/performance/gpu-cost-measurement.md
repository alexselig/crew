# Where Crew's GPU time actually goes

> Run this procedure only against an already-installed signed Crew app or a
> Developer ID-signed candidate. Do not launch an unsigned Crew, Electron,
> Playwright, or GUI E2E build on this machine.

This is the write-up for the "find out what the GPU process is doing with
750 MB" investigation. It was ranked first in the performance backlog on the
grounds that it was cheap and that its answer could re-rank everything below
it. It did.

## The question

Earlier foreground sampling of the signed 0.7.0 build showed the GPU helper
process holding 617–750 MB of RSS, burning 21–28% CPU, and — the part nobody
could explain — swinging by roughly 130 MB between two-second samples. A
130 MB oscillation is the classic signature of raster churn: surfaces being
thrown away and redrawn instead of reused. That hypothesis was plausible and
completely unverified.

## Method

Measured against the installed, signed 0.7.0 (`/Applications/Crew.app`,
`TeamIdentifier=42KAR3VVM7`), with the user's real 115-session roster loaded.

Note that **0.7.0 does not contain PR #14** (the `content-visibility` change
for off-screen roster cards). Everything below is therefore the *pre-fix*
baseline, which is exactly what is wanted for isolating the cause.

```bash
top -l 8 -s 2 -pid <main> -pid <gpu> -pid <helper> -pid <renderer> \
    -stats pid,command,cpu,mem,purg
```

Two rules that matter, both learned the hard way:

- **Discard the first sample per PID.** `top` reports a lifetime average for
  its first interval, not an instantaneous reading.
- **Do not use `ps %cpu`.** On macOS it is averaged over the whole process
  lifetime, so it both understates current cost and completely hides a change
  you just made.

The decisive step was a controlled A/B rather than more sampling. Crew already
pauses background motion (commit `8387866`) by putting the window into a
`.crew-inactive` state when it is not frontmost. So simply activating another
app and re-measuring isolates the cost of foreground animation — with no code
change, no instrumentation, and nothing unsigned launched.

## Result

| Process | Crew frontmost | Crew backgrounded |
| --- | --- | --- |
| GPU helper | **28.1%** CPU, 573 MB | **0.0%** CPU, 445 MB |
| Renderer | **16.3%** CPU, 155 MB | **0.2%** CPU, 155 MB |
| Main | 4.0% CPU, 117 MB | 1.5% CPU, 118 MB |

Both findings are unambiguous:

1. **Essentially all GPU and renderer CPU is foreground animation.**
   28.1% → 0.0% and 16.3% → 0.2% is not a shift in workload, it is the
   workload stopping. Backgrounded Crew is effectively free.

2. **The mysterious ~130 MB swing was never raster churn.** It is the
   445 MB → 573 MB difference in this table: the compositor layers backing the
   animating mascots, allocated when motion starts and released when it stops.
   The earlier "swing between samples" was this same allocation being caught
   mid-transition. There is no pathological churn to fix.

## What is doing the work

Three infinite CSS animations drive every mascot, in `src/renderer/styles.css`:

| Selector | Animation | Animates |
| --- | --- | --- |
| `.character--run .character__glyph` | `char-run 2.4s infinite` | `opacity` |
| `.character--run .character__art` | `char-work 1.5s infinite` | `transform` + `opacity` |
| `.character--start .character__glyph`, `.character--start .character__art` | `char-blink 1.6s infinite` | `opacity` |

`transform` and `opacity` are both compositable, so these are about as cheap
per element as CSS animation gets. The cost is not the property being
animated — it is **how many elements are animating at once**, multiplied by
how expensive each one is to rasterize. In 0.7.0 that is an unwindowed roster
of 115 cards, each carrying an inline-SVG mascot, all painting whether or not
they are on screen.

## What this changes about the plan

- **PR #14 is aimed at the right target.** `content-visibility: auto` skips
  off-screen cards entirely, and a skipped element does not run its
  animations. The off-screen share of that 28% should simply disappear. This
  has *not yet been measured*, because it requires a signed build containing
  PR #14 and none exists yet — see "Still open" below.

- **Path simplification (PERF-04) is now the most valuable remaining item**,
  not merely a bundle-size win. Whatever mascots remain on screen re-rasterize
  at animation frame rate, and that cost is directly proportional to path
  complexity — currently 578 paths and 151,713 coordinates across the cast.
  Cutting node count cuts per-frame raster cost everywhere it matters.

- **Roster IPC deltas (PERF-07) are confirmed as not addressing this.** The
  renderer drops to 0.2% CPU when backgrounded while the main process keeps
  emitting the roster. The foreground 16.3% is paint, not IPC or JavaScript.
  The evidence says this will not move the numbers in this table.

- **There is nothing to fix in the GPU process itself.** It is behaving
  correctly; it is being asked to composite too much.

## Still open

The one question this could not answer: **how much of the 28.1% PR #14 already
removes.** Answering it needs a signed build containing PR #14, measured with
the same procedure and the same 115-session roster. Until that exists, treat
the remaining items' expected gains as bounded by an unknown fraction of the
numbers above.

Re-run the table at the top of this document as the first step after the next
signed build, and record the result here.
