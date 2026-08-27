import { createReadStream, createWriteStream } from 'node:fs'
import { pathToFileURL } from 'node:url'

const VERSION = 1,
  MAX_FRAME = 1024 * 1024,
  MAX_CALLS = 500
const input = createReadStream(null, { fd: 3, autoClose: false })
const output = createWriteStream(null, { fd: 3, autoClose: false })
let buffer = '',
  nextId = 1,
  calls = 0
const pending = new Map()
const callbacks = new Map()
const heartbeat = setInterval(() => {
  void write({ jsonrpc: '2.0', bridgeVersion: VERSION, method: 'host.heartbeat', params: {} })
}, 5_000)
heartbeat.unref()
const write = async (value) => {
  const frame = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('bridge frame exceeds limit')
  if (!output.write(frame)) await new Promise((resolve) => output.once('drain', resolve))
}
const rpc = async (method, params) => {
  if (++calls > MAX_CALLS) throw new Error('bridge call quota exceeded')
  const id = nextId++
  await write({ jsonrpc: '2.0', bridgeVersion: VERSION, id, method, params })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('bridge call timed out'))
    }, 10_000)
    pending.set(id, { resolve, reject, timeout })
  })
}
input.setEncoding('utf8')
input.on('data', (chunk) => {
  buffer += chunk
  if (Buffer.byteLength(buffer) > MAX_FRAME) throw new Error('bridge frame exceeds limit')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error('invalid bridge JSON')
    }
    if (message.jsonrpc !== '2.0' || message.bridgeVersion !== VERSION)
      throw new Error('unsupported bridge protocol')
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      clearTimeout(waiter.timeout)
      if (message.error) waiter.reject(new Error(String(message.error.message || 'RPC failed')))
      else waiter.resolve(message.result)
      continue
    }
    if (message.method === 'callback.invoke' && message.id !== null && message.id !== undefined) {
      const callback = callbacks.get(message.params?.callbackId)
      Promise.resolve()
        .then(() => {
          if (!callback) throw new Error('unknown callback')
          return callback(...(message.params?.args || []))
        })
        .then(
          (result) =>
            write({
              jsonrpc: '2.0',
              bridgeVersion: VERSION,
              id: message.id,
              result: encode(result),
            }),
          (error) =>
            write({
              jsonrpc: '2.0',
              bridgeVersion: VERSION,
              id: message.id,
              error: { code: -32000, message: String(error?.message || error) },
            }),
        )
    }
  }
})
input.on('end', () => {
  clearInterval(heartbeat)
  for (const item of pending.values()) {
    clearTimeout(item.timeout)
    item.reject(new Error('bridge closed'))
  }
  process.exitCode = 1
})
const encode = (value) => {
  if (typeof value === 'function') {
    const callbackId = `callback-${nextId++}`
    callbacks.set(callbackId, value)
    return { $callback: callbackId }
  }
  return Array.isArray(value)
    ? value.map(encode)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
      : value
}
const proxy = (path) =>
  new Proxy(() => {}, {
    get: (_, key) => (key === 'then' ? undefined : proxy([...path, String(key)])),
    apply: (_, __, args) =>
      rpc(`volund.${path.join('.')}`, encode(args.length === 1 ? args[0] : args)),
  })
const entry = process.argv[1]
if (!entry) throw new Error('missing plugin entry')
try {
  await write({ jsonrpc: '2.0', bridgeVersion: VERSION, method: 'host.ready', params: {} })
  const plugin = await import(pathToFileURL(entry).href)
  const activate = plugin.activate || plugin.default?.activate || plugin.default
  if (typeof activate !== 'function') throw new Error('plugin must export activate')
  await activate(Object.assign(proxy([]), { apiVersion: '1.0' }))
  await write({ jsonrpc: '2.0', bridgeVersion: VERSION, method: 'host.activated', params: {} })
} catch {
  // An active fd 3 read watcher otherwise keeps Node alive after startup
  // failures. Exit directly so the native parent observes the failure promptly
  // without exposing the plugin's error details.
  clearInterval(heartbeat)
  process.kill(process.pid, 'SIGKILL')
}
