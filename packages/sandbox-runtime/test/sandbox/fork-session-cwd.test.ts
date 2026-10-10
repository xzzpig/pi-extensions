import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxManager } from '../../src/sandbox/sandbox-manager.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fork-session-cwd-'))
  const session = join(root, 'session')
  mkdirSync(session)
  return { root, session }
}

describe.if(isLinux)(
  'mandatory filesystem protection uses the per-command cwd',
  () => {
    it('protects session filenames and scans existing nested files without process.chdir', async () => {
      const { root, session } = makeRoot()
      const host = process.cwd()
      const manager = createSandboxManager()
      mkdirSync(join(session, 'nested'))
      writeFileSync(join(session, 'nested/.gitconfig'), 'original')
      try {
        await manager.initialize({
          network: { disabled: true, allowedDomains: [], deniedDomains: [] },
          filesystem: { allowWrite: [session], denyRead: [], denyWrite: [] },
          enableWeakerNestedSandbox: true,
        })
        for (const filename of ['.bashrc', '.mcp.json', 'nested/.gitconfig']) {
          const wrapped = await manager.wrapWithSandbox(
            `printf forbidden > ${filename}`,
            undefined,
            undefined,
            undefined,
            session,
          )
          expect(process.cwd()).toBe(host)
          const result = spawnSync(wrapped, {
            cwd: session,
            shell: true,
            encoding: 'utf8',
            timeout: 10000,
          })
          expect(result.status).not.toBe(0)
          expect(readFileSync(join(session, filename), 'utf8')).toBe(
            filename.includes('/') ? 'original' : '',
          )
          manager.cleanupAfterCommand()
        }
      } finally {
        await manager.reset()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('argv wrapper forwards its existing cwd and concurrent wraps stay isolated', async () => {
      const { root, session } = makeRoot()
      const second = join(root, 'second')
      mkdirSync(second)
      const host = process.cwd()
      const manager = createSandboxManager()
      try {
        await manager.initialize({
          network: { disabled: true, allowedDomains: [], deniedDomains: [] },
          filesystem: {
            allowWrite: [session, second],
            denyRead: [],
            denyWrite: [],
          },
          enableWeakerNestedSandbox: true,
        })
        const commands = await Promise.all(
          [session, second].map(cwd =>
            manager.wrapWithSandboxArgv(
              'printf forbidden > .mcp.json',
              '/bin/bash',
              undefined,
              undefined,
              cwd,
            ),
          ),
        )
        expect(process.cwd()).toBe(host)
        expect(commands[0].argv[2]).toContain(join(session, '.mcp.json'))
        expect(commands[0].argv[2]).not.toContain(join(second, '.mcp.json'))
        expect(commands[1].argv[2]).toContain(join(second, '.mcp.json'))
        expect(commands[1].argv[2]).not.toContain(join(session, '.mcp.json'))
        for (const [index, cwd] of [session, second].entries()) {
          const { argv, env } = commands[index]
          const result = spawnSync(argv[0], argv.slice(1), {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 10000,
          })
          expect(result.status).not.toBe(0)
          manager.cleanupAfterCommand()
        }
      } finally {
        await manager.reset()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('session mandatory opt-outs retain existing scanned files and explicit hard denies', async () => {
      const { root, session } = makeRoot()
      const manager = createSandboxManager()
      writeFileSync(join(session, '.bashrc'), 'original')
      try {
        await manager.initialize({
          network: { disabled: true, allowedDomains: [], deniedDomains: [] },
          filesystem: {
            allowWrite: [session],
            denyRead: [],
            denyWrite: [join(session, '.secret')],
            denyMandatoryCwdFiles: false,
            protectNonexistentFiles: false,
          },
          enableWeakerNestedSandbox: true,
        })
        const create = await manager.wrapWithSandbox(
          'printf permitted > .mcp.json',
          undefined,
          undefined,
          undefined,
          session,
        )
        expect(
          spawnSync(create, {
            cwd: session,
            shell: true,
            encoding: 'utf8',
            timeout: 10000,
          }).status,
        ).toBe(0)
        expect(readFileSync(join(session, '.mcp.json'), 'utf8')).toBe(
          'permitted',
        )
        manager.cleanupAfterCommand()
        for (const file of ['.bashrc', '.secret']) {
          const wrapped = await manager.wrapWithSandbox(
            `printf forbidden > ${file}`,
            undefined,
            undefined,
            undefined,
            session,
          )
          expect(
            spawnSync(wrapped, {
              cwd: session,
              shell: true,
              encoding: 'utf8',
              timeout: 10000,
            }).status,
          ).not.toBe(0)
          expect(readFileSync(join(session, file), 'utf8')).toBe(
            file === '.bashrc' ? 'original' : '',
          )
          manager.cleanupAfterCommand()
        }
        expect(existsSync(join(session, '.gitconfig'))).toBe(false)
      } finally {
        await manager.reset()
        rmSync(root, { recursive: true, force: true })
      }
    })
  },
)

it('macOS generated mandatory rules anchor static and glob paths to the session cwd', () => {
  const { root, session } = makeRoot()
  try {
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { cwd: session, allowOnly: [session], denyWithinAllow: [] },
    })
    expect(wrapped).toContain(join(session, '.bashrc'))
    expect(wrapped).toContain(join(session, '.mcp.json'))
    expect(wrapped).not.toContain(join(process.cwd(), '.bashrc'))
    expect(wrapped).not.toContain(`${process.cwd()}/`)
    expect(process.cwd()).not.toBe(session)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
