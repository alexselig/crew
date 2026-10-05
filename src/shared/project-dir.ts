/**
 * Whether a directory is worth remembering as a project.
 *
 * $HOME never is. Every one of the 131 sessions in the store at the time this
 * was written launched in home, which is exactly why `recentDirs` was still
 * empty after months of use: home is where you end up when nobody chose, so
 * recording it would bury real projects under noise and make the recents list
 * useless from its first write.
 *
 * Shared because both sides need the same answer: main decides what to record
 * on create, and the renderer decides what to suggest and what to offer.
 */
export function isProjectDir(dir: string, homeDir: string): boolean {
  const d = trimDir(dir)
  return d.length > 0 && d !== trimDir(homeDir)
}

/** Normalise a directory for comparison: trimmed, without trailing slashes. */
export function trimDir(dir: string): string {
  return dir.trim().replace(/\/+$/, '')
}
