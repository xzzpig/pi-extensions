import { expect, test } from 'bun:test'
import { getPlatform, getWslVersion } from '../../src/utils/platform.js'

test('Android/Termux selects the Linux backend without being treated as WSL', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  expect(original?.configurable).toBe(true)
  try {
    Object.defineProperty(process, 'platform', {
      ...original,
      value: 'android',
    })
    expect(getPlatform()).toBe('linux')
    expect(getWslVersion()).toBeUndefined()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
})
