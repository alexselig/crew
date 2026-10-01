#!/usr/bin/env bash
#
# Give a git worktree a working node_modules, or tell you precisely why it has not got one.
#
#   scripts/worktree-deps.sh            # fix the worktree you are standing in
#   scripts/worktree-deps.sh --check    # report only, change nothing
#   scripts/worktree-deps.sh --all      # fix every worktree of this repo
#
# Why this exists
# ---------------
# A full install of this repo is ~1 GB and contains a downloaded Electron binary,
# so every worktree gets a `node_modules` *symlink* to one real install rather
# than its own copy. Three things then go wrong, and all three look like code
# failures before they turn out to be the environment:
#
#   1. The symlink used to be committed, pointing at `../../node_modules` -- a
#      path that does not exist. A fresh worktree therefore failed with
#      `vitest: command not found`, which reads like a broken package.json.
#   2. Repointing it by hand left the tree dirty, and `publish.sh` refuses to
#      release from a dirty tree. (It is now gitignored, so this cannot recur on
#      any branch that has this script.)
#   3. The Electron binary inside the donor install gets removed periodically,
#      and the resulting ENOENT names a path deep inside node_modules with no
#      hint of what to do about it.
#
# On (3): the Electron that the corporate npm proxy supplies is refused by
# Gatekeeper -- "notarization indicates this code has been revoked" -- and macOS
# does not merely block it, it *deletes* Electron.app. So any attempt to launch
# Electron directly on this machine silently destroys the install for every
# worktree linked to it. Restore it with `node node_modules/electron/install.js`;
# `npx electron install` cannot work, because npx tries to *run* the very binary
# that is missing.
#
# So: find a donor install that is actually complete, link to it, and say so.

set -euo pipefail

CHECK_ONLY=0
ALL=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --all) ALL=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${ROOT%/.git}

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# A node_modules is usable only if it can run the tests *and* launch the app.
# Checking just one of the two is how a worktree passes `npm test` and then dies
# at `npm start` with an opaque ENOENT.
complete_install() {
  local nm=$1
  [ -x "$nm/.bin/vitest" ] || return 1
  [ -d "$nm/electron/dist/Electron.app" ] || return 1
  return 0
}

# Resolve symlinks, so two spellings of the same directory cannot produce a
# relative link that walks out of the repo and back in again. (/tmp -> /private/tmp
# on macOS is the easy way to hit this.)
canonical() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

# Every checkout of this repo, including the main one.
worktrees() {
  local p
  git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' |
    while read -r p; do canonical "$p"; done
}

find_donor() {
  local wt nm
  for wt in $(worktrees); do
    nm="$wt/node_modules"
    # Only a real directory can be a donor; a symlink would chain.
    [ -d "$nm" ] && [ ! -L "$nm" ] || continue
    if complete_install "$nm"; then echo "$wt"; return 0; fi
  done
  return 1
}

DONOR=$(find_donor || true)

if [ -z "$DONOR" ]; then
  bad "No worktree has a complete install to link against."
  # Distinguish "nothing installed" from "installed but Electron went missing",
  # because the remedies are different and the second one is the common case.
  for wt in $(worktrees); do
    nm="$wt/node_modules"
    if [ -d "$nm" ] && [ ! -L "$nm" ] && [ -x "$nm/.bin/vitest" ]; then
      warn "$(basename "$wt") has packages but no Electron binary."
      warn "Launching Electron on this Mac deletes it: Gatekeeper reports the"
      warn "build the npm proxy supplies as revoked. Do not run it to check."
      echo
      echo "  Restore it with:"
      echo "    cd $wt && node node_modules/electron/install.js"
      exit 1
    fi
  done
  echo
  echo "  Create one with:"
  echo "    cd $ROOT && npm ci"
  exit 1
fi

ok "donor: $DONOR/node_modules"

link_one() {
  local wt=$1 nm="$1/node_modules" rel
  local name
  name=$(basename "$wt")

  if [ "$wt" = "$DONOR" ]; then
    ok "$name: is the donor"
    return 0
  fi

  if [ -d "$nm" ] && [ ! -L "$nm" ]; then
    if complete_install "$nm"; then
      ok "$name: has its own complete install"
    else
      warn "$name: has its own install, but it is incomplete (not touching it)"
    fi
    return 0
  fi

  # Relative, so the link keeps working if the repo is moved or renamed.
  rel=$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
        "$DONOR/node_modules" "$wt")

  if [ -L "$nm" ] && [ "$(readlink "$nm")" = "$rel" ] && complete_install "$nm"; then
    ok "$name: already linked"
    return 0
  fi

  if [ "$CHECK_ONLY" = 1 ]; then
    bad "$name: needs linking -> $rel"
    return 1
  fi

  rm -f "$nm"
  ln -s "$rel" "$nm"
  ok "$name: linked -> $rel"
}

status=0
if [ "$ALL" = 1 ]; then
  for wt in $(worktrees); do link_one "$wt" || status=1; done
else
  here=$(canonical "$(git rev-parse --show-toplevel)")
  link_one "$here" || status=1
fi

exit $status
