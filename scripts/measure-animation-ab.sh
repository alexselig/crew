#!/bin/bash
# Variant A/B with an occlusion guard.
#
# An occluded or backgrounded browser window stops compositing, so a stolen
# focus (a Teams popup will do it) reads as a spectacular but fake ~0% result.
# Every variant therefore verifies Microsoft Edge is frontmost immediately
# before AND after sampling, and retries the variant if it was not.
set -uo pipefail

EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
URL_BASE="${URL_BASE:-http://127.0.0.1:8934/}"
OUT="${OUT:-/tmp/crew-ab/guarded.tsv}"
SAMPLES="${SAMPLES:-9}"
ATTEMPTS=3
: > "$OUT"

frontmost() {
  osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null
}

for variant in ${VARIANTS:-base noshadow glowbg animparent filterlayer static}; do
  for attempt in $(seq 1 $ATTEMPTS); do
    profile="/tmp/crew-ab/g-$variant"
    rm -rf "$profile"
    "$EDGE" --user-data-dir="$profile" --no-first-run --no-default-browser-check \
            --disable-features=Translate --window-size=940,620 \
            --app="${URL_BASE}#${variant}" >/dev/null 2>&1 &
    edge_pid=$!
    sleep 8

    before="$(frontmost)"
    gpu_pid=$(ps -axo pid=,command= | grep "$profile" | grep -- "--type=gpu-process" \
              | awk '{print $1}' | head -1)

    if [ "$before" != "Microsoft Edge" ] || [ -z "$gpu_pid" ]; then
      echo "  $variant attempt $attempt: not frontmost ($before) or no gpu pid -- retrying" >&2
      kill "$edge_pid" 2>/dev/null
      for p in $(ps -axo pid=,command= | grep "$profile" | grep -v grep | awk '{print $1}'); do
        kill "$p" 2>/dev/null
      done
      sleep 3
      continue
    fi

    tmp="/tmp/crew-ab/.s-$variant"
    top -l "$SAMPLES" -s 2 -pid "$gpu_pid" -stats pid,cpu,mem 2>/dev/null \
      | awk -v v="$variant" -v pid="$gpu_pid" '$1 == pid { print v "\t" $2 "\t" $3 }' > "$tmp"
    after="$(frontmost)"

    kill "$edge_pid" 2>/dev/null
    for p in $(ps -axo pid=,command= | grep "$profile" | grep -v grep | awk '{print $1}'); do
      kill "$p" 2>/dev/null
    done
    sleep 3

    if [ "$after" != "Microsoft Edge" ]; then
      echo "  $variant attempt $attempt: focus lost during run ($after) -- retrying" >&2
      continue
    fi
    cat "$tmp" >> "$OUT"
    echo "  $variant: ok ($(wc -l < "$tmp" | tr -d ' ') samples)" >&2
    break
  done
done

python3 - "$OUT" <<'PY'
from pathlib import Path
from statistics import median, mean, pstdev
import sys, re

rows = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    p = line.split("\t")
    if len(p) < 3 or not re.fullmatch(r"\d+(\.\d+)?", p[1]):
        continue
    rows.setdefault(p[0], []).append(float(p[1]))
rows = {k: v[1:] for k, v in rows.items()}   # top's first interval is a lifetime average

base = median(rows["base"]) if "base" in rows else None
print(f"{'variant':<13}{'median%':>9}{'mean%':>8}{'sd':>7}{'n':>4}   vs base")
for v, s in rows.items():
    m = median(s)
    d = "" if v == "base" or not base else f"   {(m-base)/base*100:+.1f}%"
    flag = "  <-- mean/median diverge, suspect occlusion" if abs(mean(s) - m) > 5 else ""
    print(f"{v:<13}{m:>9.1f}{mean(s):>8.1f}{pstdev(s):>7.1f}{len(s):>4}   {d}{flag}")
PY
