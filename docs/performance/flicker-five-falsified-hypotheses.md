# CB-1: five explanations for the flicker, all falsified

**Status:** unresolved. The cause is not known, and this document exists so the
next attempt does not re-run an experiment that has already failed.

**Date:** 2026-10-05. Observed on 0.7.8, which carries every candidate fix.

## Why this is written down

Five fixes have been shipped at this symptom. Every one of them targeted a cause
that had been *reasoned about* rather than *observed*, and the symptom survived
all five. That is not five unlucky guesses; it is a method failing, and the
method was: read the code, find something that could plausibly flicker, fix it,
ship, and ask the user whether it helped.

The user reported the symptom again while a session was actively reproducing it.
That report is the first hard evidence this bug has ever had, and it was spent
on falsification rather than on a sixth fix.

## What was ruled out, and how

The app under observation had been running for 2 days 20 hours with 133 sessions
and the enhanced (WebGL) terminal engine switched on.

### 1. The mascot's bob-and-scale animation — **dead**

The leading explanation, and the one 0.7.7 shipped against: each working session
ran an independently phased 1.5s bob, so a roster of working sessions appeared to
jitter. The fix made calm motion the default via migration
`2026-10-calm-motion-default`.

The live store shows `"calmMotion": true` in settings **and**
`2026-10-calm-motion-default` present in the `migrations` list. The fix is
active on the machine that is still flickering. This explanation is finished.

### 2. WebGL context contention — **shipped, symptom survives**

`src/renderer/terminal/xterm-engine.ts` already carries the full treatment: a
budget of 8 contexts, `reclaimWebglSlot()` taking contexts back from off-screen
terminals, a synchronous `WEBGL_lose_context` on release so Chromium's 16-context
cap sees the slot immediately, and an immediate drop to the DOM renderer on
context loss rather than waiting out the addon's three-second grace period. The
comments in that file name "the flicker" as the thing being prevented.

### 3. The roster reordering as session state flaps — **guarded**

In `needs` grouping a session moves between the "Needs you" and "Working" groups
when its state changes (`src/renderer/grouping.ts:153`), which would look exactly
like a row jumping up and down. But `src/shared/detection.ts` applies a
`confirmMs` debounce before committing a `WAITING_*` verdict, explicitly so that
"brief pauses between token bursts don't flip the red dot".

### 4. The roster reordering by recency — **impossible**

`recencyOf()` is `lastPromptAt ?? createdAt` (`src/renderer/grouping.ts:62`) —
the user's last prompt. It does not move while an agent produces output, so
output cannot reorder the roster.

### 5. The renderer dying and reloading — **dead**

`terminal/lru.ts` warns that an out-of-memory renderer "keeps dying and reloading
[which] is exactly what a user sees as flicker", and its pool cap yields to
mounted terminals, so the cap *can* be exceeded by a large enough grid.

`app.on('render-process-gone')` has been logging to `crew-crash.log` for five
weeks. The log contains **zero** such events — 1289 `memcensus` lines and 19
`quit` lines, nothing else. The renderer has never died on this machine.

Note that CB-21's "memory is a non-issue" negative result cannot be used to rule
anything in or out here: all 1289 of its samples carry `tiles:1, xterms:1`, a
single tile with a single terminal, inside one 123-minute window on one day. It
never measured the grid.

## What is left

Structure was not observed moving; it was only *argued* not to move. The
remaining possibilities are paint-level — CSS, an animation, compositing,
occlusion — or a structural churn nobody has thought of. Both are answerable by
measurement rather than by reading.

## How to get the answer

A capture, not a theory. Quit Crew, then launch it with the census on:

```bash
CREW_FLICKERLOG=1 /Applications/Crew.app/Contents/MacOS/Crew
```

Reproduce the flicker for a minute or two, then read the verdict:

```bash
grep -E "flicker(-summary)?:" ~/Library/Application\ Support/Crew/crew-crash.log | tail -20
```

The census samples four times a second (a flicker is brief; the 5s memory census
would sit straight through one) and logs **only** the samples where something
moved, plus a plain-language reading every 30 seconds and one on window close.

Read it like this:

| What the summary says | What it means |
|---|---|
| `canvas` or `webgl` moving repeatedly | terminals are swapping between the WebGL and DOM renderers |
| `xterms` or `tiles` moving repeatedly | terminals are being unmounted and remounted |
| `focus` or `visible` moving repeatedly | the window is losing focus/visibility underneath the UI |
| nothing moved at all | the DOM held still: it is paint, and all five fixes above were aimed at the wrong layer |

The last row is the most valuable outcome, because it is the one that redirects
the entire investigation — and it is the one no amount of further code reading
can produce.

The census is off unless `CREW_FLICKERLOG=1` is set, swallows its own failures,
and records only counters — no prompts, no terminal output, no paths.
