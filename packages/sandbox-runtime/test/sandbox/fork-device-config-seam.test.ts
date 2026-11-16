import { describe, expect, it } from 'bun:test'
import { resolveConfiguredDevices } from '../../src/sandbox/fork-devices.js'

// Basic real nodes exercise config resolution, NOT extra-device E2E acceptance.
describe('device manager configuration seam', () => {
  const baseline = { allowDevices: ['/dev/null'], denyRead: [], denyWrite: [] }
  it('defaults to none, inherits absent fields, replaces and clears explicit lists', () => {
    expect(
      resolveConfiguredDevices(undefined, undefined, 'linux', false),
    ).toEqual([])
    expect(resolveConfiguredDevices({}, baseline, 'linux', false)).toEqual([
      '/dev/null',
    ])
    expect(
      resolveConfiguredDevices(
        { allowDevices: ['/dev/zero'] },
        baseline,
        'linux',
        false,
      ),
    ).toEqual(['/dev/zero'])
    expect(
      resolveConfiguredDevices({ allowDevices: [] }, baseline, 'linux', false),
    ).toEqual([])
    expect(baseline.allowDevices).toEqual(['/dev/null'])
  })
  for (const field of ['denyRead', 'denyWrite'] as const) {
    it(`preserves ${field} precedence and disabled enforcement`, () => {
      const denied = { ...baseline, [field]: ['/dev'] }
      expect(() =>
        resolveConfiguredDevices(undefined, denied, 'linux', false),
      ).toThrow(`conflicts with ${field}`)
      expect(
        resolveConfiguredDevices({ [field]: [] }, denied, 'linux', false),
      ).toEqual(['/dev/null'])
      expect(() =>
        resolveConfiguredDevices(
          { [field]: ['/dev/null'] },
          baseline,
          'linux',
          false,
        ),
      ).toThrow(`conflicts with ${field}`)
      expect(
        resolveConfiguredDevices(undefined, denied, 'linux', true),
      ).toEqual(['/dev/null'])
    })
  }
  it('never disables device validation together with ordinary filesystem rules', () => {
    expect(() =>
      resolveConfiguredDevices(
        { allowDevices: ['/dev/*'] },
        baseline,
        'linux',
        true,
      ),
    ).toThrow('explicit')
    expect(() =>
      resolveConfiguredDevices(undefined, baseline, 'macos', true),
    ).toThrow('not supported')
    expect(
      resolveConfiguredDevices({ allowDevices: [] }, baseline, 'windows', true),
    ).toEqual([])
  })
})
