import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  deviceBindArgs,
  isDevicePath,
  validateDevices,
} from '../../src/sandbox/fork-devices.js'
import { FilesystemConfigSchema } from '../../src/sandbox/sandbox-config.js'
import {
  wrapCommandWithSandboxLinux,
  cleanupBwrapMountPoints,
} from '../../src/sandbox/linux-sandbox-utils.js'

// Synthetic stats exercise validation only, never substitute for real-device E2E.
const directory = {
  isSymbolicLink: () => false,
  isCharacterDevice: () => false,
  isBlockDevice: () => false,
}
const character = { ...directory, isCharacterDevice: () => true }
const block = { ...directory, isBlockDevice: () => true }
const link = { ...directory, isSymbolicLink: () => true }
const stat = (p: string) =>
  p === '/dev/kvm' || p === '/dev/net/tun' ? character : directory

describe('explicit device validation', () => {
  it('defaults to none and permits empty on other platforms', () => {
    expect(validateDevices(undefined, 'linux')).toEqual([])
    expect(validateDevices([], 'macos')).toEqual([])
  })
  for (const value of [null, 1, '/dev/kvm', [1]]) {
    it(`rejects invalid list ${JSON.stringify(value)}`, () => {
      expect(() => validateDevices(value, 'linux')).toThrow(
        'filesystem.allowDevices',
      )
    })
  }
  for (const value of [
    '/dev',
    '/dev/',
    '/dev/*',
    '/dev/kvm?',
    '/dev/[a]',
    '/tmp/kvm',
    'dev/kvm',
    '/dev/../dev/kvm',
    '/dev//kvm',
    '/dev/kvm/',
    '/dev/kvm\n',
  ]) {
    it(`rejects unsafe path ${JSON.stringify(value)}`, () => {
      expect(isDevicePath(value)).toBe(false)
      expect(() => validateDevices([value], 'linux', {}, stat)).toThrow(
        'filesystem.allowDevices',
      )
    })
  }
  it('accepts and deduplicates character/block devices', () => {
    expect(
      validateDevices(
        ['/dev/kvm', '/dev/kvm', '/dev/net/tun'],
        'linux',
        {},
        stat,
      ),
    ).toEqual(['/dev/kvm', '/dev/net/tun'])
    expect(
      validateDevices(['/dev/disk'], 'linux', {}, p =>
        p === '/dev/disk' ? block : directory,
      ),
    ).toEqual(['/dev/disk'])
  })
  it('rejects non Linux, missing, non device and symlink components', () => {
    expect(() => validateDevices(['/dev/kvm'], 'windows', {}, stat)).toThrow(
      'not supported',
    )
    expect(() =>
      validateDevices(['/dev/kvm'], 'linux', {}, () => {
        throw new Error('ENOENT')
      }),
    ).toThrow('ENOENT')
    expect(() =>
      validateDevices(['/dev/kvm'], 'linux', {}, () => directory),
    ).toThrow('character or block')
    expect(() =>
      validateDevices(['/dev/net/tun'], 'linux', {}, p =>
        p === '/dev/net' ? link : stat(p),
      ),
    ).toThrow('symbolic link')
    expect(() =>
      validateDevices(['/dev/kvm'], 'linux', {}, p =>
        p === '/dev/kvm' ? link : stat(p),
      ),
    ).toThrow('symbolic link')
  })
  for (const field of ['denyRead', 'denyWrite']) {
    for (const pattern of ['/dev/kvm', '/dev', '/dev/*', '/dev/**', '/']) {
      it(`rejects ${field} conflict ${pattern}`, () => {
        expect(() =>
          validateDevices(['/dev/kvm'], 'linux', { [field]: [pattern] }, stat),
        ).toThrow(`conflicts with ${field}`)
      })
    }
  }
  it('does not confuse sibling prefix with ancestor', () => {
    expect(
      validateDevices(['/dev/kvm'], 'linux', { denyWrite: ['/dev/kv'] }, stat),
    ).toEqual(['/dev/kvm'])
  })
  it('builds strict binds and validates schema paths', () => {
    expect(deviceBindArgs(['/dev/kvm'])).toEqual([
      '--dev-bind',
      '/dev/kvm',
      '/dev/kvm',
    ])
    const schema = FilesystemConfigSchema.partial()
    expect(schema.safeParse({ allowDevices: ['/dev/kvm'] }).success).toBe(true)
    expect(schema.safeParse({ allowDevices: ['/dev/*'] }).success).toBe(false)
  })
})

describe.if(process.platform === 'linux')(
  'Linux device namespace command generation',
  () => {
    it('runs real bubblewrap with basic device access (not extra-device acceptance)', async () => {
      const command = await wrapCommandWithSandboxLinux({
        command: 'printf probe >/dev/null && printf DEVICE_PROBE_OK',
        allowDevices: ['/dev/null'],
        needsNetworkRestriction: false,
        allowAllUnixSockets: true,
      })
      try {
        const result = spawnSync('sh', ['-c', command], {
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(result.error).toBeUndefined()
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('DEVICE_PROBE_OK')
      } finally {
        cleanupBwrapMountPoints()
      }
    })
    it('does not bypass device isolation when other restrictions are absent', async () => {
      const command = await wrapCommandWithSandboxLinux({
        isolateDevices: true,
        command: 'true',
        needsNetworkRestriction: false,
        allowAllUnixSockets: true,
      })
      try {
        expect(command).toContain('--dev /dev')
        expect(command).not.toContain('--dev-bind')
      } finally {
        cleanupBwrapMountPoints()
      }
    })
    it('appends a basic device bind after --dev (infrastructure test, NOT extra device E2E)', async () => {
      const command = await wrapCommandWithSandboxLinux({
        command: 'true',
        allowDevices: ['/dev/null'],
        needsNetworkRestriction: false,
        allowAllUnixSockets: true,
      })
      try {
        expect(command).toContain('--dev /dev --dev-bind /dev/null /dev/null')
      } finally {
        cleanupBwrapMountPoints()
      }
    })
  },
)
