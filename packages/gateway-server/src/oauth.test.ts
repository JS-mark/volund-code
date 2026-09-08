import { describe, expect, it } from 'vitest'

import {
  deriveSigningKey,
  GatewayOAuthServer,
  generateGatewayClient,
  parseGatewayClients,
} from './oauth'
import type { GatewayOAuthClient } from './oauth'

const key = deriveSigningKey('test-key-material')
const client: GatewayOAuthClient = {
  id: 'ci-bot',
  secret: 's'.repeat(43),
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
      clients: [{ id: 'other', secret: 't'.repeat(43), scopes: ['chat'] }],
    })
    expect(stranger.verify(issued.accessToken)).toBeUndefined()
  })

  it('authenticates client credentials with constant-time compare', () => {
    const oauth = makeServer()
    expect(oauth.authenticate('ci-bot', 's'.repeat(43))?.id).toBe('ci-bot')
    expect(oauth.authenticate('ci-bot', 'wrong-secret-value')).toBeUndefined()
    expect(oauth.authenticate('nobody', 's'.repeat(43))).toBeUndefined()
  })
})

describe('parseGatewayClients', () => {
  it('parses a valid client list', () => {
    const clients = parseGatewayClients(
      JSON.stringify([{ id: 'a', secret: 'x'.repeat(32), scopes: ['chat'] }]),
    )
    expect(clients).toEqual([{ id: 'a', secret: 'x'.repeat(32), scopes: ['chat'] }])
  })

  it('defaults scopes to [chat]', () => {
    const clients = parseGatewayClients(JSON.stringify([{ id: 'a', secret: 'x'.repeat(32) }]))
    expect(clients[0]?.scopes).toEqual(['chat'])
  })

  it.each([
    ['not json', 'not json'],
    ['non-array', '{}'],
    ['empty array', '[]'],
    ['missing secret', JSON.stringify([{ id: 'a' }])],
    ['short secret', JSON.stringify([{ id: 'a', secret: 'short' }])],
    ['bad id chars', JSON.stringify([{ id: 'a b c', secret: 'x'.repeat(32) }])],
    [
      'duplicate id',
      JSON.stringify([
        { id: 'a', secret: 'x'.repeat(32) },
        { id: 'a', secret: 'y'.repeat(32) },
      ]),
    ],
    ['bad scopes', JSON.stringify([{ id: 'a', secret: 'x'.repeat(32), scopes: 'chat' }])],
  ])('rejects %s', (_label, source) => {
    expect(() => parseGatewayClients(source)).toThrow()
  })
})

describe('generateGatewayClient', () => {
  it('generates unique clients with chat+sessions scopes', () => {
    const a = generateGatewayClient()
    const b = generateGatewayClient()
    expect(a.id).not.toBe(b.id)
    expect(a.secret).not.toBe(b.secret)
    expect(a.scopes).toEqual(['chat', 'sessions'])
    expect(a.secret.length).toBeGreaterThanOrEqual(32)
  })
})
