import { describe, it, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  wrapCommandWithSandboxLinux,
  cleanupBwrapMountPoints,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'

const TEST_DIR = join(tmpdir(), `protect-nonexistent-files-${Date.now()}`)
mkdirSync(TEST_DIR, { recursive: true })

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})
describe.if(isLinux)('protectNonexistentFiles option (Linux only)', () => {
  // New opt-out: protectNonexistentFiles: false must NOT create
  // /dev/null or empty-dir mount point placeholders for dangerous files
  // that do not exist yet (e.g. .bashrc, .mcp.json in the working
  // directory). The host filesystem stays clean during execution, so
  // tools like git status / lint glob scans do not see synthetic dotfiles.
  //
  // Existing dangerous files and user-configured denyWrite paths must
  // remain protected regardless of the flag.

  // Returns directory entries (names) currently present in path.
  const listEntries = (dir: string): string[] => {
    return readdirSync(dir).sort()
  }

  it('no mount point placeholders appear during execution when false', async () => {
    const cleanDir = join(TEST_DIR, 'optout-clean')
    mkdirSync(cleanDir, { recursive: true })
    const originalDir = process.cwd()
    process.chdir(cleanDir)

    try {
      const writeConfig = {
        allowOnly: ['.'],
        denyWithinAllow: [] as string[],
      }

      // Without the opt-out, bwrap materializes empty .bashrc/.mcp.json
      // etc. as host files while the command runs. With it, nothing should
      // appear — not even during execution.
      const wrappedCommand = await wrapCommandWithSandboxLinux({
        command: 'ls -la; echo hello',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig,
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })

      const result = spawnSync(wrappedCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 10000,
      })

      expect(result.status).toBe(0)

      // No ghost dotfiles should have appeared on the host at all
      const entries = listEntries(cleanDir)
      expect(entries.filter(f => f.startsWith('.'))).toEqual([])
      // Output should prove the sandbox-internal view did not create them either
      expect(result.stdout).not.toContain('.bashrc')

      cleanupBwrapMountPoints()
    } finally {
      process.chdir(originalDir)
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })

  it('command can create a dangerous file when false (protection opted out)', async () => {
    const cleanDir = join(TEST_DIR, 'optout-create')
    mkdirSync(cleanDir, { recursive: true })
    const originalDir = process.cwd()
    process.chdir(cleanDir)

    try {
      const writeConfig = {
        allowOnly: ['.'],
        denyWithinAllow: [] as string[],
      }

      const wrappedCommand = await wrapCommandWithSandboxLinux({
        command: "echo 'hello' > .mcp.json",
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig,
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })

      const result = spawnSync(wrappedCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 10000,
      })

      expect(result.status).toBe(0)
      expect(readFileSync('.mcp.json', 'utf8').trim()).toBe('hello')

      cleanupBwrapMountPoints()
    } finally {
      process.chdir(originalDir)
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })

  it('existing dangerous files stay protected when false', async () => {
    const cleanDir = join(TEST_DIR, 'optout-existing')
    mkdirSync(cleanDir, { recursive: true })
    writeFileSync(join(cleanDir, '.bashrc'), 'ORIGINAL')
    const originalDir = process.cwd()
    process.chdir(cleanDir)

    try {
      const writeConfig = {
        allowOnly: ['.'],
        denyWithinAllow: [] as string[],
      }

      const wrappedCommand = await wrapCommandWithSandboxLinux({
        command: "echo 'MALICIOUS' >> .bashrc",
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig,
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })

      const result = spawnSync(wrappedCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 10000,
      })

      // Write must be blocked; the existing file must keep its content
      expect(result.status).not.toBe(0)
      expect(readFileSync('.bashrc', 'utf8')).toBe('ORIGINAL')

      cleanupBwrapMountPoints()
    } finally {
      process.chdir(originalDir)
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })

  it('existing dangling dangerous symlink stays protected when false', async () => {
    // Regression: existence is judged with lstat, not existsSync. A
    // dangling symlink (target missing) has a real directory entry, so
    // it must keep its protection when the opt-out is active, exactly
    // like the default mode (which resolves the deny to the missing
    // link target). existsSync follows the link, saw no target, and
    // wrongly dropped the deny, letting the sandboxed command append
    // to (or replace) the symlink.
    const cleanDir = join(TEST_DIR, 'optout-dangling')
    mkdirSync(cleanDir, { recursive: true })
    symlinkSync('missing-target', join(cleanDir, '.bashrc'))
    const originalDir = process.cwd()
    process.chdir(cleanDir)

    try {
      const writeConfig = {
        allowOnly: ['.'],
        denyWithinAllow: [] as string[],
      }

      const wrappedCommand = await wrapCommandWithSandboxLinux({
        command: "echo 'MALICIOUS' >> .bashrc",
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig,
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })

      const result = spawnSync(wrappedCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 10000,
      })

      // The write must be blocked (the deny resolves to the missing
      // target, which is masked). bwrap materializes an empty mount
      // point file at the masked target on the host — identical to the
      // default-mode behavior — so assert the process was rejected and
      // that no content was written there, rather than absence.
      expect(result.status).not.toBe(0)
      expect(readFileSync('missing-target', 'utf8')).toBe('')

      cleanupBwrapMountPoints()
    } finally {
      process.chdir(originalDir)
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })

  it('user denyWrite still blocks non-existent paths when false', async () => {
    const cleanDir = join(TEST_DIR, 'optout-denywrite')
    mkdirSync(cleanDir, { recursive: true })
    const originalDir = process.cwd()
    process.chdir(cleanDir)

    try {
      const writeConfig = {
        allowOnly: ['.'],
        denyWithinAllow: [join(cleanDir, '.secrets')] as string[],
      }

      const wrappedCommand = await wrapCommandWithSandboxLinux({
        command: "echo 'secret' > .secrets 2>&1",
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig,
        protectNonexistentFiles: false,
        enableWeakerNestedSandbox: true,
      })

      const result = spawnSync(wrappedCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 10000,
      })

      // Explicit denyWrite wins even for non-existent paths: the write
      // is blocked. bwrap still materializes an empty mount point file
      // on the host (that is exactly how a deny rule blocks creation),
      // so assert the content was never written rather than absence.
      expect(result.status).not.toBe(0)
      expect(readFileSync('.secrets', 'utf8')).toBe('')

      cleanupBwrapMountPoints()
    } finally {
      process.chdir(originalDir)
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })
})
