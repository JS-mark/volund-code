/**
 * `volund remote enroll|connect` 命令族：真实本地 HTTP 假网关 + config 端口假。
 * 覆盖：enroll 读 [remote] 铸码、connect 核销写回 [remote] 三件套 + enabled、
 * 未配置时的明确报错、usage 注册（reservedCommandNames 防裸 prompt 吞没）。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

import { runCli } from '../cli'
import type { VolundPorts } from '../ports'
import { createRemoteCommand } from './remote'

const GATEWAY_SECRET = 'g'.repeat(43)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += String(chunk)
    })
    req.on('end', () => resolve(raw))
  })
}

let gateway: Server | undefined
let gatewayBase = ''
let mintCalls = 0
let redeemCalls = 0

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (req.url === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    if (form.get('client_id') === 'known-client' && form.get('client_secret'))
      return respond(res, 200, { access_token: 'jwt-token', token_type: 'Bearer' })
    return respond(res, 401, {
      error: { code: 'gateway_client_rejected', message: 'invalid client credentials' },
    })
  }
  if (req.url === '/v1/pairing' && req.method === 'POST') {
    mintCalls += 1
    if (req.headers.authorization !== 'Bearer jwt-token')
      return respond(res, 401, {
        error: { code: 'gateway_auth_invalid', message: 'missing or expired bearer token' },
      })
    return respond(res, 200, { code: 'ABCD2345', expiresAt: 1_000 })
  }
  if (req.url === '/pairing/redeem' && req.method === 'POST') {
    redeemCalls += 1
    const body = JSON.parse(await readBody(req)) as { code?: string }
    if (body.code === 'GOODCODE')
      return respond(res, 200, {
        client_id: 'volund-new',
        client_secret: GATEWAY_SECRET,
        scope: 'chat sessions uplink',
      })
    return respond(res, 400, {
      error: {
        code: 'gateway_pairing_invalid',
        message: 'pairing code is invalid or expired',
      },
    })
  }
  respond(res, 404, { error: { code: 'gateway_schema_invalid', message: 'unknown endpoint' } })
}

beforeAll(async () => {
  gateway = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 500, { error: { code: 'internal', message: 'failed' } })
    })
  })
  await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve))
  const address = gateway!.address()
  gatewayBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => gateway?.close(() => resolve()))
})

function ports(configState: Record<string, unknown>): {
  ports: VolundPorts
  writes: [string, unknown][]
} {
  const writes: [string, unknown][] = []
  return {
    writes,
    ports: {
      identity: { version: '0.0.0-test' },
      native: {
        probe: vi.fn(async () => ({
          tier: 'full' as const,
          mechanism: 'test sandbox',
          features: { filesystem: true, network: true },
          degradationReasons: [],
        })),
        health: vi.fn(async () => ({ sandbox: true, search: false, fs: false })),
      },
      config: {
        health: vi.fn(async () => ({ valid: true, detail: 'valid' })),
        listMerged: vi.fn(async () => ({ config: configState, warnings: [] })),
        setValue: vi.fn(async (input: { key: string; value: unknown }) => {
          writes.push([input.key, input.value])
          return { file: 'user' }
        }),
      },
      auth: { health: vi.fn(async () => ({ configured: false, detail: '' })) },
      telemetry: {
        securityEvent: vi.fn(async () => {}),
        summary: vi.fn(async () => ({
          samples: 0,
          corruptLines: 0,
          tiers: {},
          escape: { allow: 0, deny: 0, ratio: null },
          probe: null,
        })),
        export: vi.fn(async () => 0),
        clear: vi.fn(async () => {}),
        health: vi.fn(async () => ({
          exists: false,
          writable: true,
          corruptLines: 0,
          samples: 0,
          detail: '',
        })),
      },
    } as unknown as VolundPorts,
  }
}

describe('volund remote command', () => {
  it('is a reserved subcommand (help short-circuits instead of becoming a prompt)', async () => {
    const result = await runCli(['remote', '--help'], ports({}).ports)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('remote connect --gateway <url> --code <code>')
  })

  it('dispatches through runCli (registry registration, not swallowed as a prompt)', async () => {
    const { ports: testPorts } = ports({})
    const result = await runCli(['remote', 'bogus-action'], testPorts)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown remote action')
  })

  it('enroll mints a code from configured [remote] credentials', async () => {
    const { ports: testPorts } = ports({
      remote: {
        gateway_url: gatewayBase,
        client_id: 'known-client',
        client_secret: GATEWAY_SECRET,
      },
    })
    const result = await createRemoteCommand().run({
      args: { _: ['remote', 'enroll'] } as never,
      cwd: process.cwd(),
      ports: testPorts,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ABCD2345')
    expect(mintCalls).toBe(1)
  })

  it('enroll fails with guidance when [remote] is not configured', async () => {
    const { ports: testPorts } = ports({})
    const result = await createRemoteCommand().run({
      args: { _: ['remote', 'enroll'] } as never,
      cwd: process.cwd(),
      ports: testPorts,
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('remote connect')
  })

  it('connect redeems the code, writes [remote], and enables remote control', async () => {
    const { ports: testPorts, writes } = ports({})
    const result = await createRemoteCommand().run({
      args: { _: ['remote', 'connect'], gateway: gatewayBase, code: 'GOODCODE' } as never,
      cwd: process.cwd(),
      ports: testPorts,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('volund-new')
    expect(redeemCalls).toBe(1)
    expect(writes).toEqual([
      ['remote.gateway_url', gatewayBase],
      ['remote.client_id', 'volund-new'],
      ['remote.client_secret', GATEWAY_SECRET],
      ['remote.enabled', true],
    ])
  })

  it('connect surfaces gateway rejection without writing config', async () => {
    const { ports: testPorts, writes } = ports({})
    const result = await createRemoteCommand().run({
      args: { _: ['remote', 'connect'], gateway: gatewayBase, code: 'BADCODE' } as never,
      cwd: process.cwd(),
      ports: testPorts,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid or expired')
    expect(writes).toEqual([])
  })
})
