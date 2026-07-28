// Pure navigation math for jump-to-prompt. Given the sorted absolute buffer
// lines of landmark rows (OSC 133 prompt starts + Enter submits) and the line
// currently at the top of the viewport, pick the next/previous landmark to
// scroll to. Dependency-free so it is unit-tested in Node; the renderer's engine
// supplies the real line numbers.

export function pickJumpTarget(
  sortedLines: number[],
  viewportTop: number,
  dir: 'prev' | 'next'
): number | null {
  if (sortedLines.length === 0) return null
  if (dir === 'next') {
    for (const l of sortedLines) if (l > viewportTop) return l
    return null
  }
  for (let i = sortedLines.length - 1; i >= 0; i--) {
    if (sortedLines[i] < viewportTop) return sortedLines[i]
  }
  return null
}
