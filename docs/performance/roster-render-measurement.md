# Roster Render Cost Measurement

Run this procedure only against an already-installed signed Crew app or a
Developer ID-signed candidate. Do not launch an unsigned Crew, Electron,
Playwright, or GUI E2E build on this machine.

This measures **foreground** cost, which is what the background-idle work did
not cover. Crew is focused throughout; the point is what a large roster costs
while you are actually using it.

## Why this is measured

The roster is not windowed: every session in the list renders a card, and every
card carries an illustrated mascot drawn as inline SVG line art. The art set is
64 characters, 547 vector paths, 144,676 coordinates — a median character is
about 1,658 coordinates and the heaviest (tiger) is 7,334. A 115-session roster
therefore asks the compositor to lay out and rasterize a cast of mascots, most
of which are scrolled out of view, and to re-rasterize the running ones on every
animation frame because `char-work` scales them.

## Preconditions

1. Record the absolute signed bundle path as `CREW_APP`, for example
   `/Applications/Crew.app`.
2. Confirm the bundle is signed:

   ```bash
   codesign --verify --deep --strict "$CREW_APP"
   ```

3. Open a roster of at least 60 sessions, the same roster for baseline and
   candidate. Record the count.
4. Put at least five sessions in the running state, so the mascot scale
   animation is active.
5. Scroll the roster to the top and leave it there.
6. Create a new empty evidence directory outside the repository:

   ```bash
   EVIDENCE_DIR="$HOME/Desktop/crew-roster-perf-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$EVIDENCE_DIR"
   ```

## Process Inclusion Rule

Include every process whose executable command starts inside the exact signed
bundle: Crew main, every Crew Helper renderer, and Crew Helper GPU. Exclude
installers, shells, grep/awk, and processes from any other Crew bundle.

```bash
ps -axo pid=,comm= |
  awk -v app="$CREW_APP/Contents/" '
    {
      pid=$1
      executable=$0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", executable)
      if (index(executable, app) == 1) print pid
    }
  ' |
  sort -n > "$EVIDENCE_DIR/pids.txt"
cat "$EVIDENCE_DIR/pids.txt"
```

If the PID list changes during a run, discard that run and repeat it.

## Sampling

Use `top`, not `ps`. On macOS `ps %cpu` is averaged over the whole life of the
process, so it understates a change that has just been made; `top` reports
utilization over its own sampling interval.

Keep a Crew window focused and the roster scrolled to the top, then take 30
two-second samples of the GPU helper and the renderer:

```bash
pids=$(awk '{ printf "-pid %s ", $1 }' "$EVIDENCE_DIR/pids.txt")
top -l 31 -s 2 $pids -stats pid,cpu,mem |
  awk '/^[0-9]+/ { print $1 "\t" $2 "\t" $3 }' > "$EVIDENCE_DIR/foreground.tsv"
```

Discard the first sample of each PID: `top` reports a lifetime average for its
first interval and interval utilization thereafter.

```bash
python3 - "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
from statistics import median
import sys

rows = {}
for line in (Path(sys.argv[1]) / "foreground.tsv").read_text().splitlines():
    pid, cpu, mem = line.split("\t")
    rows.setdefault(pid, []).append(float(cpu))

total = []
for pid, samples in rows.items():
    kept = samples[1:]          # drop the lifetime-average first sample
    print(f"pid {pid}: median {median(kept):.1f}% over {len(kept)} samples")
    total.append(median(kept))
print(f"combined median: {sum(total):.1f}%")
PY
```

Record the `MEM` column for the GPU helper as well: texture churn shows up as
the figure swinging between samples rather than settling.

## Acceptance

A candidate passes when, against the same roster and the same number of running
sessions as the baseline:

1. The combined foreground median is **at least 40% lower** than the baseline.
2. The GPU helper's median CPU is **at least 50% lower** than the baseline.
3. The GPU helper's resident memory **varies by less than 50 MB** across the
   30 samples, where the baseline swings by more.
4. Scrolling the roster end to end stays smooth, and no card renders blank or
   at the wrong height.
5. The drop indicator is still drawn when a card is dragged over another card.
   This is the one place containment is deliberately switched off, so it is the
   one place a containment regression would show.
6. Mascots for running sessions still bob and scale, and mascots still grey out
   when a session is gone.

Checks 4 to 6 are the visual contract. `content-visibility` changes when the
browser does layout and paint, so a mistake shows up as wrong geometry rather
than as a crash — it has to be looked at, not just measured.

## Reviewing the visual contract without a signed build

Checks 4 to 6 above need a running app, but they only exercise CSS, and the
renderer is Chromium. `scripts/make-review-page.py` writes a static page that
loads the real `src/renderer/styles.css` and the real line art out of
`src/renderer/character-art.tsx`, then renders a 115-card roster with the
mascots animating:

```bash
python3 scripts/make-review-page.py /tmp/crew-roster-review
cd /tmp/crew-roster-review && python3 -m http.server 8931 --bind 127.0.0.1
```

Open <http://127.0.0.1:8931/> in an ordinary browser. This is not an unsigned
Crew build and not an Electron or Playwright run — it is a web page, so the rule
at the top of this document does not apply to it.

The toolbar toggles between the current CSS and a baseline that reverts only the
two properties under review, reports the number of cards Chromium is currently
skipping (read from its own `contentvisibilityautostatechange` event rather than
inferred), forces the drag-over state so the drop line can be confirmed to
survive paint containment, and applies `.crew-inactive` to confirm animations
pause. A scroll FPS readout covers check 4.

What the page cannot tell you: it has no xterm and no React, so it isolates the
CSS rather than reproducing app load, and the GPU memory figure in check 3 still
has to come from the sampling procedure above against a signed build.

## What this does not cover

Renderer JS cost is not addressed here. The roster re-renders every card when
the roster updates (up to four times a second, `TICK_MS = 250`), and no
component is wrapped in `React.memo`. That is deliberate: sampling the signed
0.7.0 renderer showed its main thread idle in 3,285 of 3,443 samples, so
reconciliation was not the constraint and memoization would have added prop
stability requirements for no measured gain. Re-measure before concluding it is
still the right call — a roster several times larger would change the arithmetic.
