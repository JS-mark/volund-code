import { describe, expect, it } from 'vitest'

import {
  deriveSigningKey,
  GatewayOAuthServer,
  generateGatewayClient,
  hashGatewayClient,
  hashGatewayClientREFID_014Q,
  parseGatewayClients,
} from './oauth'
import type { GatewayOAuthClient } from './oauth'

const key = deriveSigningKey('test-key-material')
/** 客户端明文只活在测试体里；服务器只见哈希。 */
const CLIENT_PLAINTEXT = 's'.repeat(43)
const client: GatewayOAuthClient = {
  id: 'ci-bot',
  secretHash: hashGatewayClientREFID_014Q(CLIENT_PLAINTEXT),
  scopes: ['chat', 'sessions'],
}

function makeServer(overrides: { now?: () => number; ttl?: number } = {}) {
  return new GatewayOAuthServer({
    issuer: 'volund-gateway',
    signingKey: key,
    tokenTtlSeconds: overrides.ttl ?? 3600,
    clients: [client],
    ...(overrides.now ? { now: overrides.now } : {}),
  })
}

describe('GatewayOAuthServer', () => {
  it('issues and verifies a token round-trip', () => {
    const oauth = makeServer()
    const issued = oauth.issue(client, [])
    expect(issued).toBeDefined()
    expect(issued!.tokenType).toBe('Bearer')
    const claims = oauth.verify(issued!.accessToken)
    expect(claims?.sub).toBe('ci-bot')
    expect(claims?.scopes).toEqual(['chat', 'sessions'])
  })

  it('grants a requested subset of scopes', () => {
    const oauth = makeServer()
    const issued = oauth.issue(client, ['chat'])
    expect(oauth.verify(issued!.accessToken)?.scopes).toEqual(['chat'])
  })

  it('refuses scopes the client does not hold', () => {
    const oauth = makeServer()
    expect(oauth.issue(client, ['admin'])).toBeUndefined()
  })

  it('rejects tokens signed with another key', () => {
    const issued = makeServer().issue(client, [])
    const other = new GatewayOAuthServer({
      issuer: 'volund-gateway',
      signingKey: deriveSigningKey('other-key'),
      tokenTtlSeconds: 3600,
      clients: [client],
    })
    expect(other.verify(issued!.accessToken)).toBeUndefined()
  })

  it('rejects expired tokens', () => {
    let now = 1_700_000_000_000
    const oauth = makeServer({ now: () => now })
    const issued = oauth.issue(client, [])!
    expect(oauth.verify(issued.accessToken)).toBeDefined()
    now += 3601_000
    expect(oauth.verify(issued.accessToken)).toBeUndefined()
  })

  it('rejects tampered payloads', () => {
    const issued = makeServer().issue(client, [])!
    const [header, payload] = issued.accessToken.split('.')
    const forged = `${header}.${Buffer.from(JSON.stringify({ iss: 'volund-gateway', sub: 'ci-bot', exp: 9_999_999_999 })).toString('base64url')}.forged`
    expect(makeServer().verify(forged)).toBeUndefined()
    expect(payload).toBeDefined()
  })

  it('rejects tokens whose alg header differs (alg confusion gate)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ iss: 'volund-gateway', sub: 'ci-bot', exp: 9_999_999_999 }),
    ).toString('base64url')
    expect(makeServer().verify(`${header}.${payload}.x`)).toBeUndefined()
  })

  it('rejects tokens for unknown clients', () => {
    const oauth = makeServer()
    const issued = oauth.issue(client, [])!
    const stranger = new GatewayOAuthServer({
      issuer: 'volund-gateway',
      signingKey: key,
      tokenTtlSeconds: 3600,
      clients: [
        { id: 'other', secretHash: hashGatewayClientREFID_014Q('t'.repeat(43)), scopes: ['chat'] },
      ],
    })
    expect(stranger.verify(issued.accessToken)).toBeUndefined()
  })

  it('authenticates plaintext against the stored hash (constant-time)', () => {
    const oauth = makeServer()
    expect(oauth.authenticate('ci-bot', CLIENT_PLAINTEXT)?.id).toBe('ci-bot')
    expect(oauth.authenticate('ci-bot', 'wrong-secret-value')).toBeUndefined()
    expect(oauth.authenticate('nobody', CLIENT_PLAINTEXT)).toBeUndefined()
  })
})

describe('parseGatewayClients', () => {
  it('hashes plaintext entries and reports them for migration', () => {
    const parsed = parseGatewayClients(
      JSON.stringify([{ id: 'a', secret: 'x'.repeat(32), scopes: ['chat'] }]),
    )
    expect(parsed.clients).toEqual([
      { id: 'a', secretHash: hashGatewayClientREFID_014Q('x'.repeat(32)), scopes: ['chat'] },
    ])
    expect(parsed.migratedPlaintextIds).toEqual(['a'])
    // 落盘形态里不含明文
    expect(JSON.stringify(parsed.clients)).not.toContain('x'.repeat(32))
  })

  it('accepts hash-form entries untouched', () => {
    const hash = hashGatewayClientREFID_014Q('x'.repeat(32))
    const parsed = parseGatewayClients(JSON.stringify([{ id: 'a', secretHash: hash }]))
    expect(parsed.clients[0]?.secretHash).toBe(hash)
    expect(parsed.migratedPlaintextIds).toEqual([])
  })

  it('defaults scopes to [chat]', () => {
    const parsed = parseGatewayClients(JSON.stringify([{ id: 'a', secret: 'x'.repeat(32) }]))
    expect(parsed.clients[0]?.scopes).toEqual(['chat'])
  })

  it.each([
    ['not json', 'not json'],
    ['non-array', '{}'],
    ['empty array', '[]'],
    ['neither secret nor hash', JSON.stringify([{ id: 'a' }])],
    [
      'both secret and hash',
      JSON.stringify([{ id: 'a', secret: 'x'.repeat(32), secretHash: 'f'.repeat(64) }]),
    ],
    ['short secret', JSON.stringify([{ id: 'a', secret: 'short' }])],
    ['bad hash shape', JSON.stringify([{ id: 'a', secretHash: 'not-hex' }])],
    ['bad id chars', JSON.stringify([{ id: 'a b c', secret: 'x'.repeat(32) }])],
    [
      'duplicate id',
      JSON.stringify([
        { id: 'a', secret: 'x'.repeat(32) },
        { id: 'a', secretHash: 'f'.repeat(64) },
      ]),
    ],
    ['bad scopes', JSON.stringify([{ id: 'a', secret: 'x'.repeat(32), scopes: 'chat' }])],
  ])('rejects %s', (_label, source) => {
    expect(() => parseGatewayClients(source)).toThrow()
  })
})

describe('generateGatewayClient / hashGatewayClient', () => {
  it('generates unique clients; storage form carries only the hash', () => {
    const a = generateGatewayClient()
    const b = generateGatewayClient()
    expect(a.id).not.toBe(b.id)
    expect(a.secret).not.toBe(b.secret)
    expect(a.secret.length).toBeGreaterThanOrEqual(32)
    const stored = hashGatewayClient(a)
    expect(stored).not.toHaveProperty('secret')
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.scopes).toEqual(a.scopes)
  })
})
