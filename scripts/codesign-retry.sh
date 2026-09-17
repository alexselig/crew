#!/bin/bash
set -u

REAL_CODESIGN="${CREW_REAL_CODESIGN:-/usr/bin/codesign}"
TIMESTAMP_URL="${CREW_TIMESTAMP_URL:-http://timestamp.apple.com/ts01}"
RETRIES="${CREW_CODESIGN_RETRIES:-10}"
DELAY="${CREW_CODESIGN_RETRY_DELAY:-10}"
EXPECTED_AUTHORITY="${CREW_EXPECTED_AUTHORITY:-}"
ARGS=()
TARGET="${!#}"
IS_SIGNING=0

for arg in "$@"; do
  if [ "$arg" = "--sign" ]; then
    IS_SIGNING=1
  fi
  if [ "$arg" = "--timestamp" ]; then
    ARGS+=("--timestamp=$TIMESTAMP_URL")
  else
    ARGS+=("$arg")
  fi
done

has_valid_signature() {
  local signature
  [ -n "$EXPECTED_AUTHORITY" ] &&
    "$REAL_CODESIGN" --verify --strict "$TARGET" >/dev/null 2>&1 &&
    signature="$("$REAL_CODESIGN" -dvvv "$TARGET" 2>&1)" &&
    grep -Fq "Authority=$EXPECTED_AUTHORITY" <<<"$signature" &&
    grep -Fq "Timestamp=" <<<"$signature"
}

if [ "$IS_SIGNING" = "1" ] && has_valid_signature; then
  echo "    $TARGET already has a valid timestamped signature." >&2
  exit 0
fi

for ((attempt = 1; attempt <= RETRIES; attempt++)); do
  if "$REAL_CODESIGN" "${ARGS[@]}"; then
    exit 0
  fi
  if [ "$IS_SIGNING" = "1" ] && has_valid_signature; then
    echo "    codesign reported failure, but $TARGET already has a valid timestamped signature." >&2
    exit 0
  fi
  if [ "$attempt" -lt "$RETRIES" ]; then
    echo "    codesign attempt $attempt failed — retrying this file in ${DELAY}s…" >&2
    sleep "$DELAY"
  fi
done

exit 1
