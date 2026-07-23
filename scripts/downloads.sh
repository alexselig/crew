#!/bin/bash
# Crew download stats — reads GitHub's built-in per-asset download counts for
# every release. No site analytics, no cookies, no tracking code: GitHub already
# counts these server-side, so this stays consistent with the site's
# "100% local, no telemetry" privacy statement.
#
# Usage: bash scripts/downloads.sh
set -euo pipefail

REPO="alexselig/crew"

echo "Crew downloads — $(date '+%Y-%m-%d %H:%M')"
echo "  (source: GitHub Releases download_count — real downloads, no site tracking)"
echo

# Per-asset counts, newest release first (the API already returns them that way),
# plus a grand total across every release.
gh api "/repos/$REPO/releases" --paginate --jq '
  .[] | .tag_name as $t | .assets[]
  | select(.download_count > 0)
  | [$t, .name, (.download_count|tostring)] | @tsv
' | awk -F'\t' '
  { printf "  %-10s %-30s %6d\n", $1, $2, $3; total += $3 }
  END { printf "\n  %-41s %6d\n", "TOTAL", total }
'
