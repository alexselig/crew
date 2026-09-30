// The runtime factory: turns a persisted ConductorConfig into the live
// ConductorRuntime that conductor-ipc.ts's shipped backend needs. This file
// contains the only place that derives Conductor's on-disk scratch paths, so
// that guarantee (Conductor never writes into the user's repo) lives in one
// auditable spot rather than being re-derived ad hoc wherever a workspace is
// wired up.

import { join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { createLaneManager } from './lanes'
import { createJournal } from './conductor-journal'
import { createConductor } from './conductor'
import type { ComposeDeps } from './conductor-compose'
import type { ConductorRuntime } from './conductor-ipc'
import type { ConductorConfig, ConductorSettings } from '../shared/conductor'

/** Thrown by conductorPaths() when workspaceId cannot be proven safe to use
 *  as a single path segment under <userDataDir>/conductor/. Fail-closed:
 *  anything that cannot be proven safe is rejected, never sanitised, because
 *  a sanitised id could silently collide with another workspace's directory
 *  (e.g. "a/b" and "a..b" both being stripped to "ab"). */
export class InvalidWorkspaceIdError extends Error {
  constructor(workspaceId: unknown) {
    super(`invalid conductor workspaceId: ${JSON.stringify(workspaceId)}`)
    this.name = 'InvalidWorkspaceIdError'
  }
}

// A workspaceId must be usable as exactly one path segment on every
// platform Electron ships on, including Windows. That rules out:
//   - the Windows-reserved path characters `<>:"/\|?*` (`:` also introduces
//     a drive letter like "C:" or a stream name like "C:foo", either of
//     which would resolve outside <userDataDir> on Windows even though it
//     contains no `/` or `\`);
//   - ASCII control characters (0x00-0x1F, 0x7F), which are invalid in
//     Windows filenames and can smuggle unexpected bytes (e.g. a newline)
//     into anything that later logs or shells out with the derived path;
//   - "." or ".." (or a string made up only of dots), which would name the
//     directory itself or its parent rather than a child of it;
//   - the empty string;
//   - unbounded length, which some filesystems refuse outright;
//   - a trailing "." or trailing/leading whitespace: Windows silently
//     strips trailing dots and spaces from a path segment, so "ws." and
//     "ws " both actually name the directory "ws" on disk — accepting them
//     as distinct ids would let two different workspaceIds alias the same
//     directory;
//   - a Windows reserved device basename (CON, PRN, AUX, NUL, COM1-9,
//     LPT1-9), case-insensitively, including a dotted form like "CON.txt"
//     (Windows matches on the name before the first dot) — these cannot be
//     used as a child directory name on that platform;
//   - a workspaceId that is not already in Unicode NFC form: macOS's
//     normalising (default) filesystem treats the NFC and NFD encodings of
//     the same visible string (e.g. "é" vs. "e" + combining acute) as the
//     same directory entry, so two distinct-looking-but-canonically-equal
//     ids must not both be accepted as separate, non-aliasing workspaces.
// Anything else is rejected rather than stripped/escaped: silently
// rewriting an attacker-controlled string into "something plausible" is
// exactly the bug class this guards against.
const WINDOWS_RESERVED_CHARS = /[<>:"/\\|?*]/
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const ONLY_DOTS = /^\.+$/
const TRAILING_DOT_OR_SPACE = /[. ]$/
const LEADING_WHITESPACE = /^\s/
const MAX_WORKSPACE_ID_LENGTH = 255
const WINDOWS_RESERVED_BASENAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

const isValidWorkspaceId = (workspaceId: unknown): workspaceId is string => {
  if (typeof workspaceId !== 'string') return false
  if (workspaceId.length === 0) return false
  if (workspaceId.length > MAX_WORKSPACE_ID_LENGTH) return false
  if (ONLY_DOTS.test(workspaceId)) return false
  if (WINDOWS_RESERVED_CHARS.test(workspaceId)) return false
  if (ASCII_CONTROL_CHARS.test(workspaceId)) return false
  if (TRAILING_DOT_OR_SPACE.test(workspaceId)) return false
  if (LEADING_WHITESPACE.test(workspaceId)) return false
  if (WINDOWS_RESERVED_BASENAME.test(workspaceId.split('.', 1)[0])) return false
  if (workspaceId.normalize('NFC') !== workspaceId) return false
  return true
}

/** Pure. Derives Conductor's scratch paths for one workspace, all rooted
 *  under <userDataDir>/conductor/<workspaceId>/ — never inside the user's
 *  repository. Throws InvalidWorkspaceIdError instead of returning a
 *  plausible-looking path when workspaceId cannot be proven to name a single
 *  safe child directory. */
export function conductorPaths(
  userDataDir: string,
  workspaceId: string
): { integrationWorktree: string; lanesDir: string; journal: string } {
  if (!isValidWorkspaceId(workspaceId)) throw new InvalidWorkspaceIdError(workspaceId)

  const base = join(userDataDir, 'conductor', workspaceId)

  // Belt and suspenders on top of the string checks above: prove the
  // resolved directory really does land inside userDataDir before handing
  // out paths derived from it.
  const resolvedUserData = resolve(userDataDir)
  const resolvedBase = resolve(base)
  if (resolvedBase !== resolvedUserData && !resolvedBase.startsWith(resolvedUserData + sep)) {
    throw new InvalidWorkspaceIdError(workspaceId)
  }

  return {
    integrationWorktree: join(base, 'integration'),
    lanesDir: join(base, 'lanes'),
    journal: join(base, 'journal.ndjson')
  }
}

export interface SamePathDeps {
  /** Injectable for tests. Must throw (not return a fabricated path) when
   *  `path` cannot be resolved on disk — samePath() relies on that to know
   *  when to fall back. Defaults to `fs.realpathSync.native`, which on
   *  macOS also returns the true on-disk casing, settling case, symlink and
   *  most alias questions in the one call. */
  realpath?(path: string): string
}

// The only realpath failures that *prove* a path cannot exist on disk.
// ENOENT: no such file or directory. ENOTDIR: a non-final segment of the
// path exists but is not a directory, which likewise means the full path
// cannot exist. Both are safe to treat as "unresolvable, fall back to
// resolve()" because there is nothing on disk left to have been mistaken
// for something else. Anything else (EACCES: exists but unreadable; ELOOP:
// a symlink cycle; or any error this code doesn't recognise) means realpath
// could not *disprove* existence either — the path might well resolve to
// something samePath cannot see — so those must not be silently downgraded
// to "doesn't exist".
const PROVEN_NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR'])

// True when `path`, taken literally (not resolved), contains a `..`
// (parent) segment. resolve() collapses `..` lexically — including through
// segments that don't exist on disk — so a fallback path (one realpath has
// already proven doesn't exist) containing `..` cannot be trusted: resolve()
// may have collapsed it back to something that looks identical to an
// unrelated, real path. A lone `.` segment carries no such risk and is
// still safely collapsed by resolve().
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '..')
}

function canonicalize(
  path: string,
  realpath: (path: string) => string
): { value: string; resolved: boolean; unresolvableParent: boolean } {
  try {
    return { value: realpath(path), resolved: true, unresolvableParent: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== undefined && PROVEN_NOT_FOUND_CODES.has(code)) {
      // Doesn't exist (yet): not an error condition for an identity check —
      // fall back to the plain resolve()-based path. But if the unresolved
      // path contains a `..` segment, resolve() collapsed it lexically
      // through a segment realpath just proved doesn't exist on disk, so
      // the result cannot be trusted for an identity comparison.
      return { value: resolve(path), resolved: false, unresolvableParent: hasParentSegment(path) }
    }
    // EACCES, ELOOP, or anything unrecognised: realpath could not prove the
    // path doesn't exist, so samePath cannot safely claim to know its
    // identity either. Rethrow rather than guessing — see samePath's doc
    // comment for why this is the fail-closed choice, and
    // conductor-compose.ts:58 for how the one caller surfaces it.
    throw error
  }
}

/** Pure (aside from the filesystem read realpath() itself performs).
 *  Compares two filesystem paths the way a repository identity check needs
 *  to: the same directory should compare equal regardless of a trailing
 *  slash, a `.`/`..` segment, a symlink, or an NFC/NFD Unicode alias —
 *  while a genuinely different directory, or a case-variant of one on a
 *  case-sensitive volume, must never compare equal. Shared by
 *  conductor-compose.ts so that discipline lives in one place rather than
 *  being re-derived at each comparison site.
 *
 *  Strategy: canonicalize each side with realpath() first, since on macOS
 *  that resolves case, symlinks and Unicode aliasing all at once for
 *  anything that actually exists on disk. Only when a side is *proven* not
 *  to exist (ENOENT/ENOTDIR — see PROVEN_NOT_FOUND_CODES) does this fall
 *  back to an exact resolve()+NFC comparison, with NO case folding: whether
 *  two differently-cased paths name the same directory is a property of the
 *  volume they live on, not of the host OS (macOS ships both case-sensitive
 *  and case-insensitive volumes), and a path that doesn't exist on disk
 *  cannot be conducted anyway — so the only cost of comparing case-exactly
 *  here is a false reject for a path that isn't real, never a false accept
 *  of two paths that are. Any other realpath failure (EACCES, ELOOP, or
 *  unrecognised) is not caught here at all: canonicalize() rethrows it,
 *  because realpath failing to *disprove* existence is not license to
 *  guess — samePath must fail closed by refusing to answer rather than by
 *  risking a false accept. */
export function samePath(a: string, b: string, deps: SamePathDeps = {}): boolean {
  const realpath = deps.realpath ?? ((path: string) => realpathSync.native(path))
  const canonA = canonicalize(a, realpath)
  const canonB = canonicalize(b, realpath)

  // A `..` segment in a path realpath already proved doesn't exist cannot be
  // resolved safely by resolve()'s lexical collapse (see canonicalize) — so
  // samePath has no business asserting equality for it. This is a legitimate
  // "different repository" rejection, not an unknowable error: the path
  // plainly does not exist, so it plainly isn't the same directory as
  // anything that does.
  if (canonA.unresolvableParent || canonB.unresolvableParent) {
    return false
  }

  const normalizedA = canonA.value.normalize('NFC')
  const normalizedB = canonB.value.normalize('NFC')
  return normalizedA === normalizedB
}

export interface CreateConductorRuntimeDeps {
  config: ConductorConfig
  journalPath: string
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
}

/** Assembles the live ConductorRuntime for one workspace from its persisted
 *  ConductorConfig. Does not itself call conductorPaths(): the caller
 *  derives journalPath (and the config's own integrationWorktree/lanesDir)
 *  once, up front, so this factory has a single, already-validated source of
 *  truth for where things live. */
export function createConductorRuntime(deps: CreateConductorRuntimeDeps): ConductorRuntime {
  const { config, journalPath, createSession, closeSession } = deps

  const settings: ConductorSettings = {
    repo: config.repo,
    integrationBranch: config.integrationBranch,
    integrationWorktree: config.integrationWorktree,
    lanesDir: config.lanesDir,
    maxLanes: config.maxLanes,
    test: config.test
  }

  const lanes = createLaneManager(settings)
  const journal = createJournal(journalPath)
  const conductor = createConductor({ lanes, journal, settings })

  return { lanes, conductor, settings, createSession, closeSession }
}
