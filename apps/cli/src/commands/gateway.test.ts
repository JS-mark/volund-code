import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GatewayOAuthServer } from '@volund/gateway-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createGatewayModelResolver,
  resolveGatewayConfig,
  resolveGatewayCredentials,
} from './gateway'

describe('createGatewayModelResolver', () => {
  const resolve = createGatewayModelResolver({
    aliases: new Map([['vision', { provider: 'anthropic', model: 'mimo-v2.5' }]]),
    defaultProvider: 'openai',
  })

  it('resolves aliases before anything else', () => {
    expect(resolve('vision')).toBe('anthropic/mimo-v2.5')
  })

  it('keeps qualified ids as-is', () => {
    expect(resolve('anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4')
  })

  it('prefixes bare names with the default provider', () => {
    expect(resolve('gpt-4o')).toBe('openai/gpt-4o')
  })
})

describe('resolveGatewayConfig', () => {
  it('applies defaults', () => {
    const config = resolveGatewayConfig({ args: {}, cwd: '/work', env: {} })
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8788)
    expect(config.permissionMode).toBe('auto')
    expect(config.workspace).toBe('/work')
    expect(config.corsOrigins).toEqual([])
    expect(config.defaultProvider).toBe('openai')
  })

  it('honours env overrides and --port precedence over GATEWAY_PORT', () => {
    const config = resolveGatewayConfig({
      args: { port: '9999' },
      cwd: '/work',
      env: {
        GATEWAY_PORT: '8787',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PERMISSION_MODE: 'ask',
        GATEWAY_CORS_ORIGINS: 'https://a.example, https://b.example',
        GATEWAY_TOKEN_TTL_SECONDS: '60',
      },
    })
    expect(config.port).toBe(9999)
    expect(config.host).toBe('127.0.0.1')
    expect(config.permissionMode).toBe('ask')
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example'])
    expect(config.tokenTtlSeconds).toBe(60)
  })

  it('rejects an invalid permission mode', () => {
    expect(() =>
      resolveGatewayConfig({ args: {}, cwd: '/work', env: { GATEWAY_PERMISSION_MODE: 'yolo' } }),
    ).toThrow(/GATEWAY_PERMISSION_MODE/)
  })

  it('rejects out-of-range integers', () => {
    expect(() =>
      resolveGatewayConfig({ args: {}, cwd: '/work', env: { GATEWAY_PORT: '70000' } }),
    ).toThrow(/invalid integer/)
    expect(() =>
      resolveGatewayConfig({ args: {}, cwd: '/work', env: { GATEWAY_RATE_LIMIT_RPM: 'abc' } }),
    ).toThrow(/invalid integer/)
  })
})

describe('resolveGatewayCredentials', () => {
  let home = ''

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'volund-gateway-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('generates and persists a bootstrap client and signing key (0600, hash-only)', async () => {
    const first = await resolveGatewayCredentials(home, {})
    expect(first.source).toBe('generated')
    expect(first.generated).toBeDefined()
    expect(first.clients).toHaveLength(1)

    // 文件权限与落盘内容
    const clientsFile = join(home, 'gateway', 'clients.json')
    const keyFile = join(home, 'gateway', 'token-key')
    expect((await stat(clientsFile)).mode & 0o777).toBe(0o600)
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)

    // 落盘只有哈希，明文只出现在 generated（一次性打印）里
    const onDisk = await readFile(clientsFile, 'utf8')
    expect(onDisk).not.toContain(first.generated!.secret)
    expect(JSON.parse(onDisk)[0].secretHash).toMatch(/^[0-9a-f]{64}$/)

    // 第二次启动：复用同一份客户端与密钥（token 跨重启不失效）
    const second = await resolveGatewayCredentials(home, {})
    expect(second.source).toBe('file')
    expect(second.generated).toBeUndefined()
    expect(second.clients).toEqual(first.clients)
    expect(Buffer.from(second.signingKey).equals(Buffer.from(first.signingKey))).toBe(true)
  })

  it('migrates a plaintext clients file to hashes and keeps authentication working', async () => {
    const dir = join(home, 'gateway')
    await mkdir(dir, { recursive: true })
    const plaintext = 'p'.repeat(32)
    await writeFile(
      join(dir, 'clients.json'),
      JSON.stringify([{ id: 'legacy', secret: plaintext, scopes: ['chat'] }]),
    )
    const resolved = await resolveGatewayCredentials(home, {})
    expect(resolved.migrated).toBe(true)
    const onDisk = await readFile(join(dir, 'clients.json'), 'utf8')
    expect(onDisk).not.toContain(plaintext)
    // 哈希后的客户端仍能用明文通过认证
    const oauth = new GatewayOAuthServer({
      issuer: 't',
      signingKey: resolved.signingKey,
      tokenTtlSeconds: 60,
      clients: resolved.clients,
    })
    expect(oauth.authenticate('legacy', plaintext)?.id).toBe('legacy')
    // 再跑一次：已是哈希格式，不再迁移
    const second = await resolveGatewayCredentials(home, {})
    expect(second.migrated).toBe(false)
  })

  it('prefers GATEWAY_CLIENTS env over the file', async () => {
    const envClient = { id: 'env-client', secret: 'e'.repeat(32), scopes: ['chat'] }
    const resolved = await resolveGatewayCredentials(home, {
      GATEWAY_CLIENTS: JSON.stringify([envClient]),
    })
    expect(resolved.source).toBe('env')
    expect(resolved.clients[0]?.id).toBe('env-client')
  })

  it('derives the signing key from GATEWAY_TOKEN_SECRET', async () => {
    const a = await resolveGatewayCredentials(home, {
      GATEWAY_CLIENTS: JSON.stringify([{ id: 'c', secret: 'x'.repeat(32) }]),
      GATEWAY_TOKEN_SECRET: 'secret-material',
    })
    const b = await resolveGatewayCredentials(home, {
      GATEWAY_CLIENTS: JSON.stringify([{ id: 'c', secret: 'x'.repeat(32) }]),
      GATEWAY_TOKEN_SECRET: 'secret-material',
    })
    expect(Buffer.from(a.signingKey).equals(Buffer.from(b.signingKey))).toBe(true)
  })

  it('fails closed on malformed GATEWAY_CLIENTS', async () => {
    await expect(resolveGatewayCredentials(home, { GATEWAY_CLIENTS: '{}' })).rejects.toThrow(
      /JSON array/,
    )
  })

  it('fails closed on a malformed clients file', async () => {
    const dir = join(home, 'gateway')
    await resolveGatewayCredentials(home, {}) // 先生成合法文件
    await writeFile(join(dir, 'clients.json'), 'not json')
    await expect(resolveGatewayCredentials(home, {})).rejects.toThrow(/JSON array/)
  })
})
