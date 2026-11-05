import { describe, expect, it } from 'vitest'
import {
  spawn,
  waitForControlReady,
  waitForChild,
  disposeChild,
} from './fork-control-fd-process'
import { type Writable } from 'stream'

describe('fork control-fd process lifecycle', () => {
  it('delivers dynamic data and EOF across repeated spawns', async () => {
    for (let i = 0; i < 40; i++) {
      const child = spawn(
        'node',
        [
          '-e',
          `
        const fs = require('fs');
        const control = fs.createReadStream('', { fd: 3 });
        control.on('data', data => process.stdout.write(data));
        control.on('error', error => { throw error });
        control.on('end', () => process.stdout.write('EOF'));
        console.error('Listening for config updates on fd 3');
      `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
      )
      let stdout = ''
      child.stdout!.on('data', data => {
        stdout += data.toString()
      })
      try {
        await waitForControlReady(child)
        const payload = `update-${i}\n`
        ;(child.stdio[3] as Writable).write(payload)
        expect(await waitForChild(child)).toBe(0)
        expect(stdout).toBe(payload + 'EOF')
      } finally {
        await disposeChild(child)
      }
    }
  }, 15000)

  it('rejects exit before readiness instead of treating it as success', async () => {
    const child = spawn('node', ['-e', 'process.exit(7)'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    try {
      await expect(waitForControlReady(child)).rejects.toThrow(
        'closed before readiness',
      )
      expect(await waitForChild(child)).toBe(7)
    } finally {
      await disposeChild(child)
    }
  })

  it('propagates child spawn errors and still tears down', async () => {
    const child = spawn('/no-such-control-fd-command', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await expect(waitForChild(child)).rejects.toThrow()
    await expect(disposeChild(child)).rejects.toThrow()
  })

  it('rejects its deadline and reaps an unresponsive child', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    await expect(waitForChild(child)).rejects.toThrow(
      'did not close within 5000ms',
    )
    await expect(disposeChild(child)).rejects.toThrow(
      'did not close within 5000ms',
    )
    expect(child.signalCode).toBe('SIGKILL')
  }, 10000)

  it('propagates stream errors and reaps the child', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    child.stdin!.destroy(new Error('injected stdin failure'))
    await expect(waitForChild(child)).rejects.toThrow('injected stdin failure')
    await expect(disposeChild(child)).rejects.toThrow('injected stdin failure')
    expect(child.signalCode).toBe('SIGKILL')
  })
})
