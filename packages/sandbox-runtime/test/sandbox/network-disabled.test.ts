import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from '../../src/sandbox/sandbox-config.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
} from '../../src/sandbox/sandbox-schemas.js'
import { isLinux, isMacOS, isSupportedPlatform } from '../helpers/platform.js'

/**
 * Tests for network.disabled.
 *
 * When true, no network policy is enforced or infrastructure started:
 * allowedDomains/deniedDomains and proxy settings are ignored, no local
 * proxy or Linux bridge runs, macOS profiles allow all network
 * operations ((allow network*)), and Linux skips --unshare-net so the
 * sandbox shares the host network namespace. Filesystem restrictions
 * must remain fully in effect.
 */

function configWith(disabled?: boolean): SandboxRuntimeConfig {
  return {
    network: {
      ...(disabled !== undefined ? { disabled } : {}),
      allowedDomains: ['example.com'],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: ['/nonexistent-allow-write'],
      denyWrite: [],
    },
  }
}

describe.if(isSupportedPlatform)('network.disabled schema', () => {
  it('accepts disabled true/false/absent', () => {
    const filesystem = {
      denyRead: [],
      allowWrite: ['/tmp'],
      denyWrite: [],
    }
    expect(
      SandboxRuntimeConfigSchema.safeParse({
        network: { disabled: true, allowedDomains: [], deniedDomains: [] },
        filesystem,
      }).success,
    ).toBe(true)
    expect(
      SandboxRuntimeConfigSchema.safeParse({
        network: { disabled: false, allowedDomains: [], deniedDomains: [] },
        filesystem,
      }).success,
    ).toBe(true)
    expect(
      SandboxRuntimeConfigSchema.safeParse({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem,
      }).success,
    ).toBe(true)
  })
})

describe.if(isLinux)('network.disabled on Linux', () => {
  afterAll(async () => {
    await SandboxManager.reset()
  })

  it('control: wraps with --unshare-net when not disabled', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(configWith())

    const wrapped = await SandboxManager.wrapWithSandbox('echo hi')
    expect(wrapped).toContain('--unshare-net')
  })

  it('omits --unshare-net and proxy plumbing when disabled', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(configWith(true))

    const wrapped = await SandboxManager.wrapWithSandbox('echo hi')
    expect(wrapped).not.toContain('--unshare-net')
    // No proxy env plumbing and no proxy socket binds.
    expect(wrapped).not.toContain('HTTP_PROXY')
    expect(wrapped).not.toContain('.sock')
    // No proxy listeners were started either.
    expect(SandboxManager.getSocksProxyPort()).toBeUndefined()
  })

  it('still enforces filesystem restrictions when disabled', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(configWith(true))

    const wrapped = await SandboxManager.wrapWithSandbox('echo hi')
    // The command is still wrapped by bwrap with a read-only root bind,
    // i.e. filesystem policy generation is unaffected.
    expect(wrapped).toContain('bwrap')
    expect(wrapped).toContain('--ro-bind / /')
    expect(wrapped).not.toContain('--unshare-net')
  })

  it('per-call customConfig.network can disable for one call', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(configWith())

    const wrapped = await SandboxManager.wrapWithSandbox('echo hi', undefined, {
      network: { ...configWith().network, disabled: true },
    })
    expect(wrapped).not.toContain('--unshare-net')
  })

  it('per-call customConfig.network without the key stays restricted', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(configWith(true))

    // Global init skipped the proxies, so a per-call override that omits
    // `disabled` re-applies namespace isolation (hard-blocked network —
    // documented limitation; use reset()+initialize() to toggle globally).
    const wrapped = await SandboxManager.wrapWithSandbox('echo hi', undefined, {
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
    })
    expect(wrapped).toContain('--unshare-net')
  })
})

describe.if(isMacOS)('network.disabled on macOS', () => {
  beforeAll(async () => {
    await SandboxManager.reset()
  })

  afterAll(async () => {
    await SandboxManager.reset()
  })

  it('direct wrapper emits (allow network*) without restriction', () => {
    const readConfig: FsReadRestrictionConfig | undefined = undefined
    const writeConfig: FsWriteRestrictionConfig | undefined = undefined
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'echo hi',
      needsNetworkRestriction: false,
      readConfig,
      writeConfig,
    })
    expect(wrapped).toContain('(allow network*)')
  })

  it('direct wrapper restricts network when restriction applies', () => {
    const readConfig: FsReadRestrictionConfig | undefined = undefined
    const writeConfig: FsWriteRestrictionConfig = {
      allowOnly: ['/tmp'],
      denyWithinAllow: [],
    }
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'echo hi',
      needsNetworkRestriction: true,
      httpProxyPort: 12345,
      readConfig,
      writeConfig,
    })
    expect(wrapped).not.toContain('(allow network*)')
  })

  it('manager-level disabled config emits (allow network*)', async () => {
    await SandboxManager.initialize(configWith(true))

    const wrapped = await SandboxManager.wrapWithSandbox('echo hi')
    expect(wrapped).toContain('(allow network*)')
    expect(SandboxManager.getSocksProxyPort()).toBeUndefined()
  })
})
