// Dependency-free shell quoting for paths inserted into an agent's prompt
// (e.g. files dropped onto a terminal). POSIX single-quote style. Unit-tested.

const SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/

/** Quote a single path so a shell (or an agent reading a prompt) sees it as one token. */
export function shellQuote(p: string): string {
  if (p.length === 0) return "''"
  if (SAFE.test(p)) return p
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

/** Quote and join multiple paths for insertion as prompt text. */
export function quotePaths(paths: string[]): string {
  return paths.map(shellQuote).join(' ')
}
