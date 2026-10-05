# Footprint and stability are not the next performance problem

**Status: deliberate negative result.** Recorded so the next "Crew feels heavy"
instinct gets checked against measurement before anyone starts optimising.

This is a sibling to [`backlog-disposition.md`](./backlog-disposition.md), which
closed four of eight approved performance items with evidence rather than code.
Same discipline, applied before the work starts instead of during it.

## The claim

Memory footprint and process stability are **not** where the next performance
effort should go. Nothing in the available instrumentation suggests either is a
problem, and two of the three numbers are not close to a limit.

## The evidence

From `~/Library/Application Support/Crew/crew-crash.log`, the memory census
written by the probe in `src/main/index.ts`:

| Measure | Value | Headroom |
| --- | --- | --- |
| JS heap | 15–28 MB | against a **3586 MB** limit — 0.8% at peak |
| Peak DOM nodes | 1681 | no threshold anywhere near it |
| Canvas elements | 3 | — |
| Crashes | **0** | across the whole log |
| Clean quits | 19 | 2026-08-26 → 2026-10-03 |

1289 census samples, 1308 log lines total. Zero lines match
`crash|render-process-gone|killed`.

## What this evidence cannot support

The stability half is reasonably strong: 19 clean quits and zero crashes span
14 active days across five calendar weeks of ordinary use.

**The memory half is much weaker than it looks, and the raw log says so.**
Every one of the 1289 samples carries `"tiles":1,"xterms":1`, and they all fall
in a single 123-minute window on 2026-08-26 (16:06Z → 18:09Z):

```
tiles histogram:   {"1":1289}
xterms histogram:  {"1":1289}
census window:     2026-08-26T16:06:26.939Z -> 2026-08-26T18:09:44.553Z
```

So the census measured **one session open for two hours on one day**. It is
silent about the case that actually matters — a 131-session store with a grid
of live tiles and several xterms mounted at once. "15–28 MB" is the footprint of
roughly the smallest configuration Crew supports.

Note also that peak heap (28 MB) was sampled at `dom:1195`, not at the peak DOM
of 1681, so within this window heap did not track DOM size.

## What follows

- **Do not start footprint or stability work on the strength of this log.**
  There is no evidence of a problem, which is not the same as evidence of none.
- **Do not cite "15–28 MB" as Crew's memory profile.** It is the single-tile
  idle figure, and quoting it for a full roster overstates what was measured.
- **Before any re-measurement, fix the census first.** It must run across more
  than one day and more than one tile, or it will keep producing this same
  unfalsifiable result. The probe lives in `src/main/index.ts`.
- The roster-render and background-idle procedures in this directory already
  exercise multi-tile states; prefer extending those over trusting this census.

## Provenance

Derived from the usage analysis behind backlog items CB-13…CB-21 (see
`backlog/backlog.json`). CB-21 originally asserted the negative result for both
memory and stability; reading the raw samples narrowed the memory half to a
single-tile, single-session window. The narrowing is the useful part.
