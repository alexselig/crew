import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Node does not expose directory flushing on Windows. Unix errors propagate so
 * callers never acknowledge a rename/new file before its directory is flushed. */
export function syncParentDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dirname(path), 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Publish a fully flushed file and directory entry. The caller creates the
 * directory; a failed write before rename never truncates the existing target. */
export function atomicWriteFile(path: string, contents: string | Buffer): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    created = false
    syncParentDirectory(path)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (err) {
        console.warn('[crew] failed to close temporary file:', err)
      }
    }
    if (created) {
      try {
        unlinkSync(temporary)
      } catch (err) {
        console.warn(`[crew] failed to remove temporary file ${temporary}:`, err)
      }
    }
  }
}
