import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'

describe.if(isLinux)('mandatory CWD opt-out composes with fork protections', () => {
  for (const protectNonexistentFiles of [false, true]) {
    it(`explicit nonexistent denyWrite remains enforced (protect=${protectNonexistentFiles})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'fork-mandatory-compat-'))
      const previous = process.cwd()
      process.chdir(root)
      try {
        const wrapped = await wrapCommandWithSandboxLinux({
          command: "printf forbidden > .secret",
          needsNetworkRestriction: false,
          writeConfig: {
            allowOnly: [root],
            denyWithinAllow: [join(root, '.secret')],
            denyMandatoryCwdFiles: false,
          },
          protectNonexistentFiles,
          enableWeakerNestedSandbox: true,
        })
        const result = spawnSync(wrapped, { shell: true, encoding: 'utf8', timeout: 10000 })
        expect(result.status).not.toBe(0)
        expect(readFileSync(join(root, '.secret'), 'utf8')).toBe('')
      } finally {
        cleanupBwrapMountPoints({ force: true })
        process.chdir(previous)
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('existing mandatory file stays denied when both nonexistent-file switches are off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-existing-compat-'))
    const previous = process.cwd()
    process.chdir(root)
    writeFileSync('.bashrc', 'original')
    try {
      const wrapped = await wrapCommandWithSandboxLinux({
        command: "printf forbidden > .bashrc",
        needsNetworkRestriction: false,
        writeConfig: { allowOnly: [root], denyWithinAllow: [], denyMandatoryCwdFiles: false },
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })
      const result = spawnSync(wrapped, { shell: true, encoding: 'utf8', timeout: 10000 })
      expect(result.status).not.toBe(0)
      expect(readFileSync('.bashrc', 'utf8')).toBe('original')
    } finally {
      cleanupBwrapMountPoints({ force: true })
      process.chdir(previous)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
