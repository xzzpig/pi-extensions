import { once } from 'node:events'
import { connect, createServer, Socket } from 'node:net'
import { expect, test } from 'bun:test'
import { createHttpProxyServer } from '../../src/sandbox/http-proxy.js'

test('a CONNECT tunnel disables Nagle on both proxy sockets', async () => {
  const original = Socket.prototype.setNoDelay
  const calls: Array<{ socket: Socket; enabled: boolean | undefined }> = []
  Socket.prototype.setNoDelay = function (enabled?: boolean) {
    calls.push({ socket: this, enabled })
    return original.call(this, enabled)
  }

  const upstream = createServer()
  let incoming: Socket | undefined
  const proxy = createHttpProxyServer({
    filter: (_port, _host, socket) => {
      incoming = socket as Socket
      return true
    },
  })
  // Bun's HTTP server exposes its own socket class rather than net.Socket.
  // Observe this concrete socket before the proxy's CONNECT listener runs.
  proxy.prependListener('connect', (_request, socket) => {
    const incomingSocket = socket as Socket
    const setNoDelay = incomingSocket.setNoDelay
    incomingSocket.setNoDelay = function (enabled?: boolean) {
      calls.push({ socket: this, enabled })
      return setNoDelay.call(this, enabled)
    }
  })
  let client: Socket | undefined
  try {
    upstream.listen(0, '127.0.0.1')
    proxy.listen(0, '127.0.0.1')
    await Promise.all([once(upstream, 'listening'), once(proxy, 'listening')])
    const upstreamPort = (upstream.address() as { port: number }).port
    const proxyPort = (proxy.address() as { port: number }).port
    client = connect({ host: '127.0.0.1', port: proxyPort })
    await once(client, 'connect')
    const response = once(client, 'data')
    client.write(
      `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
    )
    const [data] = await response
    expect(String(data)).toContain('200 Connection Established')
    expect(incoming).toBeDefined()
    expect(
      calls.some(call => call.socket === incoming && call.enabled === true),
    ).toBe(true)
    expect(
      calls.some(call => call.socket !== incoming && call.enabled === true),
    ).toBe(true)
  } finally {
    Socket.prototype.setNoDelay = original
    client?.destroy()
    for (const { socket } of calls) socket.destroy()
    proxy.close()
    upstream.close()
  }
}, 10000)
