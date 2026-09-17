#!/usr/bin/env bash
# Print a timestamp-authority URL that codesign can actually reach.
#
# codesign resolves the TSA hostname through its own network stack. On networks
# where timestamp.apple.com's AAAA record is unroutable, every signature fails
# with "A timestamp was expected but was not found" even though the service is
# healthy over IPv4. Substituting a resolved A record sidesteps that entirely.
# The TSA is plain HTTP, so there is no TLS hostname to invalidate.
set -uo pipefail

URL="${1:-http://timestamp.apple.com/ts01}"

scheme="${URL%%://*}"
rest="${URL#*://}"
host="${rest%%/*}"
path="${rest#"$host"}"

# Already a literal IPv4 address — nothing to resolve.
if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' "$URL"
  exit 0
fi

address=""
if command -v dig >/dev/null 2>&1; then
  while read -r answer; do
    [[ "$answer" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    address="$answer"
    break
  done < <(dig +short "$host" A 2>/dev/null)
fi

if [ -z "$address" ]; then
  printf '%s\n' "$URL"
  exit 0
fi

printf '%s://%s%s\n' "$scheme" "$address" "$path"
