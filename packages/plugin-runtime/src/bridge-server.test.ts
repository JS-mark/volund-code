import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  decodeValue,
  encodeValue,
  PluginBridgeError,
  PluginBridgeServer,
  PluginCallbackRef,
} from './bridge-server'

/**
 * 模拟 plugin_host.mjs 一侧：截获宿主写出的帧（hostRequests），
 * 用 reply/replyRaw 注入插件 → 宿主的帧。
 */
function fakePluginSide() {
  const stream = new PassThrough()
  stream.setEncoding('utf8')
  const hostRequests: { id?: number; method?: string; params?: unknown; result?: unknown }[] = []
  let buffer = ''
  stream.write = ((chunk: string): boolean => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) hostRequests.push(JSON.parse(line))
    }
    return true
  }) as never
  const server = new PluginBridgeServer(stream as unknown as NodeJS.ReadWriteStream)
  const reply = (frame: object) =>
    stream.emit('data', `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, ...frame })}\n`)
  const replyRaw = (line: string) => stream.emit('data', `${line}\n`)
  return { server, hostRequests, reply, replyRaw }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('PluginBridgeServer（fd3 桥协议 v1）', () => {
  it('resolves waitFor on notifications and dispatches plugin requests', async () => {
    const { server, reply } = fakePluginSide()
    const seen: unknown[] = []
    server.onRequest = (method, params) => {
      seen.push([method, params])
      return { ok: true }
    }
    const ready = server.waitFor('host.ready')
    reply({ method: 'host.ready', params: {} })
    await expect(ready).resolves.toEqual({})

    reply({ id: 1, method: 'volund.ui.status.registerTab', params: { id: 't', label: 'L' } })
    await tick()
    expect(seen).toEqual([['volund.ui.status.registerTab', { id: 't', label: 'L' }]])
    server.close()
  })

  it('answers plugin requests with a result frame', async () => {
    const { server, hostRequests, reply } = fakePluginSide()
    server.onRequest = () => ({ answer: 42 })
    reply({ id: 7, method: 'volund.session.getUsage' })
    await tick()
    const response = hostRequests.find((frame) => frame.id === 7)
    expect(response).toMatchObject({ id: 7, result: { answer: 42 } })
    server.close()
  })

  it('decodes $callback placeholders and round-trips callback.invoke', async () => {
    const { server, hostRequests, reply } = fakePluginSide()
    let captured: unknown
    server.onRequest = (_method, params) => {
      captured = params
      return null
    }
    reply({
      id: 1,
      method: 'volund.ui.status.registerTab',
      params: { id: 't', label: 'L', render: { $callback: 'callback-9' } },
    })
    await tick()
    const render = (captured as { render: PluginCallbackRef }).render
    expect(render).toBeInstanceOf(PluginCallbackRef)

    const invoked = server.invokeCallback(render, [])
    await tick()
    const call = hostRequests.find((frame) => frame.method === 'callback.invoke')
    expect(call?.params).toMatchObject({ callbackId: 'callback-9', args: [] })
    reply({ id: call!.id, result: { kind: 'rows', sections: [] } })
    await expect(invoked).resolves.toEqual({ kind: 'rows', sections: [] })
    server.close()
  })

  it('returns an error frame when the handler throws', async () => {
    const { server, hostRequests, reply } = fakePluginSide()
    server.onRequest = () => {
      throw new Error('boom')
    }
    reply({ id: 3, method: 'volund.ui.status.registerTab', params: {} })
    await tick()
    const response = hostRequests.find((frame) => frame.id === 3) as unknown as {
      error: { message: string }
    }
    expect(response.error.message).toContain('boom')
    server.close()
  })

  it('times out waiting for a notification that never comes', async () => {
    const { server } = fakePluginSide()
    await expect(server.waitFor('host.ready', 20)).rejects.toMatchObject({
      code: 'plugin_bridge_timeout',
    })
    server.close()
  })

  it('closes on a frame with a foreign protocol version and never dispatches it', async () => {
    const { server, replyRaw } = fakePluginSide()
    let dispatched = false
    server.onRequest = () => {
      dispatched = true
      return null
    }
    const pending = server.invokeCallback(new PluginCallbackRef('callback-1'))
    const rejection = expect(pending).rejects.toMatchObject({ code: 'plugin_bridge_protocol' })
    replyRaw(
      JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 99, id: 5, method: 'volund.log.info' }),
    )
    await tick()
    expect(dispatched).toBe(false)
    await rejection
    server.close()
  })

  it('rejects pending callbacks on close', async () => {
    const { server } = fakePluginSide()
    const pending = server.invokeCallback(new PluginCallbackRef('callback-1'))
    const rejection = expect(pending).rejects.toBeInstanceOf(PluginBridgeError)
    server.close()
    await rejection
  })

  it('encode/decode round-trips nested structures and callback refs', () => {
    const encoded = encodeValue({ a: [1, 'x', { b: { $callback: 'c-1' } }] })
    expect(encoded).toEqual({ a: [1, 'x', { b: { $callback: 'c-1' } }] })
    const decoded = decodeValue({ a: [1, 'x', { b: { $callback: 'c-1' } }] })
    const nested = (decoded as { a: { b: unknown }[] }).a[2]
    expect(nested?.b).toBeInstanceOf(PluginCallbackRef)
  })
})
