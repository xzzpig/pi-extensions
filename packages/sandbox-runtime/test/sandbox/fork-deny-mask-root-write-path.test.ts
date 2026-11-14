import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapCommandWithSandboxLinux } from '../../src/sandbox/linux-sandbox-utils.js'
import { isAtOrUnder } from '../../src/sandbox/fork-path-containment.js'
import { isLinux } from '../helpers/platform.js'

// Fork-only coverage for the root-write-path deny mask. The recorded upstream
// spells containment as `target.startsWith(allowed + '/')`, which builds '//'
// when the allowed path is '/', so the deny path looked unwritable, the mask
// was skipped, and the writable `--bind / /` stayed. See
// src/sandbox/fork-path-containment.ts for the helper and why it mirrors
// upstream's isAtOrUnder byte for byte.

describe('isAtOrUnder', () => {
  it('treats every absolute path as under the file system root', () => {
    expect(isAtOrUnder('/', '/')).toBe(true)
    expect(isAtOrUnder('/tmp/agent', '/')).toBe(true)
  })

  it('includes the directory itself and rejects siblings', () => {
    expect(isAtOrUnder('/a', '/a')).toBe(true)
    expect(isAtOrUnder('/a/b', '/a')).toBe(true)
    expect(isAtOrUnder('/ab', '/a')).toBe(false)
    // A child literally named '..foo' is still a child; a naive
    // `relative.startsWith('..')` test would misread it as a parent escape.
    expect(isAtOrUnder('/a/..foo', '/a')).toBe(true)
  })

  it('matches upstream for an unresolved ".."', () => {
    // normalizePathForSandbox does not collapse '..' for paths that do not
    // exist, and upstream's helper still counts this as a descendant.
    // Asserted so a future move away from upstream parity is deliberate.
    expect(isAtOrUnder('/a/../b', '/a')).toBe(true)
  })
})

describe.if(isLinux)('denyWrite under a root write path', () => {
  let root: string
  let denyPath: string
  let otherPath: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fork-deny-root-')))
    denyPath = join(root, 'agent')
    otherPath = join(root, 'elsewhere')
    mkdirSync(denyPath, { recursive: true })
    mkdirSync(otherPath, { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('masks the deny path when the write path is /', async () => {
    const result = await wrapCommandWithSandboxLinux({
      command: 'echo hello',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [] },
      writeConfig: { allowOnly: ['/'], denyWithinAllow: [denyPath] },
    })

    expect(result).toContain(`--ro-bind ${denyPath} ${denyPath}`)
  })

  it('still skips the mask when the deny path is not writable anyway', async () => {
    // Not under an allowed write path, so it is already read-only from the
    // initial --ro-bind / / and masking it again would be redundant.
    const result = await wrapCommandWithSandboxLinux({
      command: 'echo hello',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [] },
      writeConfig: { allowOnly: [otherPath], denyWithinAllow: [denyPath] },
    })

    expect(result).not.toContain(`--ro-bind ${denyPath} ${denyPath}`)
  })
})
