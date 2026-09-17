# Background Idle Performance Measurement

Run this procedure only against an already-installed signed Crew app or a
Developer ID-signed candidate. Do not launch an unsigned Crew, Electron,
Playwright, or GUI E2E build on this machine.

## Preconditions

1. Record the absolute signed bundle path as `CREW_APP`, for example
   `/Applications/Crew.app`.
2. Confirm the bundle is signed:

   ```bash
   codesign --verify --deep --strict "$CREW_APP"
   ```

3. Open the same roster and number of Crew windows for baseline and candidate.
4. Select one session that is continuously producing terminal output.
5. Create a new empty evidence directory outside the repository:

   ```bash
   EVIDENCE_DIR="$HOME/Desktop/crew-background-perf-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$EVIDENCE_DIR"
   ```

## Process Inclusion Rule

Include every process whose executable command starts inside the exact signed
bundle: Crew main, every Crew Helper renderer, and Crew Helper GPU. Exclude
installers, shells, grep/awk, and processes from any other Crew bundle.

Resolve and freeze the candidate PID list before each sample run:

```bash
ps -axo pid=,comm= |
  awk -v app="$CREW_APP/Contents/" 'index($0, app) == 1 { print $1 }' |
  sort -n > "$EVIDENCE_DIR/pids.txt"
cat "$EVIDENCE_DIR/pids.txt"
```

If the PID list changes during a run, discard that run and repeat it.

## Foreground Baseline

Keep a Crew window focused. Capture ten one-second combined-CPU samples:

```bash
: > "$EVIDENCE_DIR/foreground.tsv"
for second in $(seq 1 10); do
  pids=$(paste -sd, "$EVIDENCE_DIR/pids.txt")
  total=$(ps -o %cpu= -p "$pids" | awk '{ sum += $1 } END { printf "%.2f", sum }')
  printf "%s\t%s\n" "$second" "$total" | tee -a "$EVIDENCE_DIR/foreground.tsv"
  sleep 1
done
```

The foreground baseline is the median of these ten combined values.

## Background Samples

Focus a non-Crew app without hiding or quitting Crew and immediately run:

```bash
: > "$EVIDENCE_DIR/background.tsv"
for second in $(seq 1 30); do
  pids=$(paste -sd, "$EVIDENCE_DIR/pids.txt")
  total=$(ps -o %cpu= -p "$pids" | awk '{ sum += $1 } END { printf "%.2f", sum }')
  printf "%s\t%s\n" "$second" "$total" | tee -a "$EVIDENCE_DIR/background.tsv"
  sleep 1
done
```

Calculate the foreground median, background sample 5, the reduction at sample
5, and the 30-second background median:

```bash
python3 - "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
from statistics import median
import sys

root = Path(sys.argv[1])
foreground = [float(line.split()[1]) for line in (root / "foreground.tsv").read_text().splitlines()]
background = [float(line.split()[1]) for line in (root / "background.tsv").read_text().splitlines()]
baseline = median(foreground)
at_five = background[4]
reduction = 100.0 if baseline == 0 and at_five == 0 else (baseline - at_five) / baseline * 100
result = (
    f"foreground_median={baseline:.2f}\n"
    f"background_sample_5={at_five:.2f}\n"
    f"reduction_at_5_seconds={reduction:.2f}%\n"
    f"background_30_second_median={median(background):.2f}\n"
)
(root / "summary.txt").write_text(result)
print(result, end="")
PY
```

## Correctness Checks

1. While Crew is backgrounded, drive one test session to the normal Needs-you
   state. Confirm its roster/tray state changes and exactly one native
   notification arrives under the existing notification policy. Record pass or
   fail in `$EVIDENCE_DIR/correctness.txt`.
2. Keep another session producing distinct timestamped output while Crew is
   backgrounded.
3. Return focus to Crew, select that session, and confirm the selected terminal
   immediately shows recent output, accepts input, and is neither blank nor
   frozen. Record pass or fail in `$EVIDENCE_DIR/correctness.txt`.

## Acceptance

- `reduction_at_5_seconds` is at least 80%.
- `30-second median below 5%` is satisfied by `background_30_second_median`.
- Needs-you detection and its single native notification work while backgrounded.
- Returning to Crew restores the selected terminal with recent output and no
  blank or frozen view.

Retain `pids.txt`, `foreground.tsv`, `background.tsv`, `summary.txt`, and
`correctness.txt` together. If any threshold or correctness check fails, retain
the evidence, identify the failed check, and do not describe the performance fix
as complete.
