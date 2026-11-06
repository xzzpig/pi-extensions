import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapCommandWithSandboxLinux } from '../../src/sandbox/linux-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'

/**
 * A denyWrite path nested under an allowed write path has to be masked.
 *
 * The containment check used to be `path.startsWith(allowedPath + '/')`, which
 * builds '//' when the allowed write path is the filesystem root, so nothing
 * ever matched and the deny mask was silently dropped.
 */
describe.if(isLinux)('denyWrite under a root write path', () => {
  let root: string
  let denyPath: string
  let otherPath: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'deny-root-')))
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

  it('skips the mask when the deny path is not writable anyway', async () => {
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
