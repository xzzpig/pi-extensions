import {
  spawn as nativeSpawn,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { type Writable } from 'stream'

const processes = new WeakMap<
  ChildProcess,
  {
    done: Promise<number | null>
    closed: Promise<void>
    ready: Promise<void>
    controlClosed: Promise<void>
    control?: Writable
    directory?: string
  }
>()

// Bun 1.3.11's extra stdio 'pipe' socket can disappear during spawn even
// after the previous child closed. A real POSIX pipe inherited as a numeric
// fd avoids that adapter, while updates still arrive after CLI startup.
export function spawn(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  let directory: string | undefined
  let reader: number | undefined
  let writer: number | undefined
  let anchor: number | undefined
  let child: ChildProcess
  try {
    const stdio = [
      ...(options.stdio as Exclude<SpawnOptions['stdio'], string | undefined>),
    ]
    // Windows retains its native pipe transport; POSIX FIFO creation is not
    // available there. Do not silently skip the protocol tests on Windows.
    if (stdio[3] === 'pipe' && process.platform !== 'win32') {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'control-fd-pipe-'))
      const fifo = path.join(directory, 'control')
      execFileSync('mkfifo', [fifo], { timeout: 2000 })
      // The anchor lets both blocking endpoints open without deadlocking.
      anchor = fs.openSync(fifo, fs.constants.O_RDWR)
      reader = fs.openSync(fifo, fs.constants.O_RDONLY)
      writer = fs.openSync(fifo, fs.constants.O_WRONLY)
      fs.closeSync(anchor)
      anchor = undefined
      stdio[3] = reader
    }
    child = nativeSpawn(command, args, {
      ...options,
      stdio,
      env: { ...process.env, ...options.env, SRT_DEBUG: 'true' },
    })
  } catch (error) {
    if (writer !== undefined) fs.closeSync(writer)
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    throw error
  } finally {
    if (anchor !== undefined) fs.closeSync(anchor)
    if (reader !== undefined) fs.closeSync(reader)
  }

  const control =
    writer === undefined
      ? (child.stdio[3] as Writable | undefined)
      : fs.createWriteStream('', { fd: writer })
  if (control) child.stdio[3] = control as (typeof child.stdio)[3]
  const controlClosed = new Promise<void>(resolve => {
    if (control) control.once('close', () => resolve())
    else resolve()
  })
  const closed = new Promise<void>(resolve =>
    child.once('close', () => resolve()),
  )
  let markReady!: () => void
  const listening = new Promise<void>(resolve => {
    markReady = resolve
  })
  let stderr = ''
  child.stderr?.on('data', data => {
    stderr += data.toString()
    if (stderr.includes('Listening for config updates on fd 3')) markReady()
  })
  const done = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error('control-fd child did not close within 5000ms')),
      5000,
    )
    const fail = (error: Error) => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(error)
    }
    child.on('error', fail)
    for (const stream of child.stdio) stream?.on('error', fail)
    child.once('close', code => {
      control?.destroy()
      void controlClosed.then(() => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  })
  const ready = Promise.race([
    listening,
    done.then(() => {
      throw new Error(`control-fd child closed before readiness: ${stderr}`)
    }),
  ])
  // Register immediately, but surface failures to the test and teardown.
  void done.catch(() => {})
  void ready.catch(() => {})
  processes.set(child, {
    done,
    closed,
    ready,
    controlClosed,
    control,
    directory,
  })
  return child
}

export function waitForControlReady(child: ChildProcess): Promise<void> {
  return processes.get(child)!.ready
}

export async function waitForChild(
  child: ChildProcess,
): Promise<number | null> {
  const state = processes.get(child)!
  state.control?.end()
  child.stdin?.end()
  const code = await state.done
  await state.controlClosed
  return code
}

export async function disposeChild(child: ChildProcess | null): Promise<void> {
  if (!child) return
  const state = processes.get(child)!
  try {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    state.control?.destroy()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([state.closed, state.controlClosed]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error('control-fd teardown did not close within 2000ms'),
              ),
            2000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    await state.done
  } finally {
    if (state.directory)
      fs.rmSync(state.directory, { recursive: true, force: true })
  }
}
