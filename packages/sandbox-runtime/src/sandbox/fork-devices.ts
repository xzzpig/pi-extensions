import { lstatSync, type Stats } from 'node:fs'
import { posix } from 'node:path'
import { globToRegex, normalizePathForSandbox } from './sandbox-utils.js'

/** Only explicit, canonical device paths; do not normalize away unsafe input. */
export function isDevicePath(value: string): boolean {
  return (
    value.startsWith('/dev/') &&
    value === posix.normalize(value) &&
    !value.endsWith('/') &&
    !/[\s*?[\]{}\\]/.test(value) &&
    ![...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
}

function fail(device: unknown, reason: string): never {
  throw new Error(
    `filesystem.allowDevices ${JSON.stringify(device)}: ${reason}`,
  )
}

export interface DeviceDenies {
  denyRead?: readonly string[]
  denyWrite?: readonly string[]
}

/** Match the node or any ancestor using the runtime's existing glob semantics. */
function matchesDeny(device: string, pattern: string): boolean {
  const regex = new RegExp(globToRegex(normalizePathForSandbox(pattern)))
  for (let candidate = device; ; candidate = posix.dirname(candidate)) {
    if (regex.test(candidate)) return true
    if (candidate === '/') return false
  }
}

/** Validate at execution time as well as config load; never ignore missing nodes. */
export function validateDevices(
  value: unknown,
  platform: string,
  denies: DeviceDenies = {},
  stat: (
    path: string,
  ) => Pick<
    Stats,
    'isSymbolicLink' | 'isCharacterDevice' | 'isBlockDevice'
  > = lstatSync,
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(p => typeof p === 'string')) {
    fail(value, 'must be an array of strings')
  }
  if (value.length && platform !== 'linux') {
    fail(value, `device passthrough is not supported on ${platform}`)
  }
  const devices = [...new Set(value as string[])]
  for (const device of devices) {
    if (!isDevicePath(device))
      fail(device, 'must be a canonical explicit /dev/ device path')
    try {
      const components = device.slice(1).split('/')
      let current = ''
      for (const component of components) {
        current += '/' + component
        const node = stat(current)
        if (node.isSymbolicLink())
          fail(device, `symbolic link component ${current} is not allowed`)
        if (
          current === device &&
          !node.isCharacterDevice() &&
          !node.isBlockDevice()
        ) {
          fail(device, 'must be an existing character or block device')
        }
      }
    } catch (error) {
      // Preserve the OS cause and add the config field/path, not a silent fallback.
      fail(device, error instanceof Error ? error.message : String(error))
    }
    for (const field of ['denyRead', 'denyWrite'] as const) {
      for (const pattern of denies[field] ?? []) {
        if (matchesDeny(device, pattern))
          fail(device, `conflicts with ${field} ${JSON.stringify(pattern)}`)
      }
    }
  }
  return devices
}

interface DeviceFilesystemConfig extends DeviceDenies {
  allowDevices?: string[]
}

/** Keep device-specific precedence and disabled-rule handling out of the manager. */
export function resolveConfiguredDevices(
  custom: DeviceFilesystemConfig | undefined,
  baseline: DeviceFilesystemConfig | undefined,
  platform: string,
  fsDisabled: boolean,
): string[] {
  return validateDevices(
    custom?.allowDevices ?? baseline?.allowDevices,
    platform,
    fsDisabled
      ? {}
      : {
          denyRead: custom?.denyRead ?? baseline?.denyRead,
          denyWrite: custom?.denyWrite ?? baseline?.denyWrite,
        },
  )
}

export function deviceBindArgs(devices: readonly string[]): string[] {
  return devices.flatMap(device => ['--dev-bind', device, device])
}
