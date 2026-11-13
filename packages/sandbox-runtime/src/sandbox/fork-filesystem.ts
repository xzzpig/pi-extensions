import * as fs from 'fs'

/**
 * Whether a directory entry exists at path, without following symlinks. This
 * differs from fs.existsSync: a dangling symlink (target missing) has a real
 * directory entry, so it counts as existing.
 */
// [fork] Exported for the pi-sandbox fork, which judges user-configured
// denyWrite paths with the same lstat semantics (a dangling symlink counts
// as an existing, still-protected entry).
export function pathEntryLstatExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
}
