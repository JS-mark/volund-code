import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { MemoryCredentialStore } from './index'
import { McpOAuthClient, McpOAuthError, oauthCredentialKey, oauthHeaderKey } from './mcp-oauth'

const SERVER = 'https://mcp.example.com/mcp'

/** 端到端假授权服务器：protected-resource → metadata → DCR → token 交换。 */
function fakeServer(
  options: {
    clientId?: string
    accessToken?: string
    expiresIn?: number
    registrationEndpoint?: string | false
  } = {},
) {
  const calls: Array<{ url: string; body?: unknown; headers?: Headers }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const headers = new Headers(init?.headers)
    calls.push({ url: target, ...(init?.body ? { body: String(init.body) } : {}), headers })
    if (target.includes('/.well-known/oauth-protected-resource'))
      return Response.json({ authorization_servers: ['https://auth.example.com'] }, { status: 200 })
    if (target.startsWith('https://auth.example.com/.well-known'))
      return Response.json(
        {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          ...(options.registrationEndpoint === undefined || options.registrationEndpoint
            ? { registration_endpoint: 'https://auth.example.com/register' }
            : {}),
          revocation_endpoint: 'https://auth.example.com/revoke',
          scopes_supported: ['mcp:tools'],
        },
        { status: 200 },
      )
    if (target === 'https://auth.example.com/register')
      return Response.json({ client_id: options.clientId ?? 'client-123' }, { status: 201 })
    if (target === 'https://auth.example.com/token') {
      const form = new URLSearchParams(String(init?.body))
      return Response.json(
        {
          access_token: options.accessToken ?? 'at-1',
          token_type: 'Bearer',
          ...(form.get('grant_type') === 'refresh_token' ? {} : { refresh_token: 'rt-1' }),
          ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
        },
        { status: 200 },
      )
    }
    if (target === 'https://auth.example.com/revoke') return new Response('', { status: 200 })
    return new Response('', { status: 404 })
  })
  return { fetcher, calls }
}

describe('McpOAuthClient (SM-07)', () => {
  it('runs discovery, DCR, PKCE and code exchange; persists token and header snapshot', async () => {
    const store = new MemoryCredentialStore()
    const { fetcher, calls } = fakeServer()
    const openUrls: string[] = []
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
      openBrowser: async (url) => {
        openUrls.push(url)
        // 模拟授权服务器回程：从授权 URL 里取 state，回 code（真实的 http 回程）。
        const authUrl = new URL(url)
        const redirect = authUrl.searchParams.get('redirect_uri')!
        await fetch(`${redirect}?code=abc&state=${authUrl.searchParams.get('state')}`)
      },
      timeoutMs: 2000,
    })

    const header = await client.login()

    expect(header).toBe('Bearer at-1')
    expect(openUrls).toHaveLength(1)
    const authUrl = new URL(openUrls[0]!)
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.example.com/authorize')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('client_id')).toBe('client-123')
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    // PKCE：token 交换携带的 verifier 与授权 URL 的 challenge 匹配（S256）。
    const exchange = calls.find((call) => call.url === 'https://auth.example.com/token')!
    const form = new URLSearchParams(String(exchange.body))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('abc')
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
      authUrl.searchParams.get('code_challenge'),
    )
    // 持久化：oauth JSON + Bearer 头快照。
    const stored = JSON.parse(store.values.get(oauthCredentialKey('linear'))!) as {
      accessToken: string
      clientId: string
      refreshToken?: string
    }
    expect(stored).toMatchObject({ accessToken: 'at-1', clientId: 'client-123' })
    expect(stored.refreshToken).toBe('rt-1')
    expect(store.values.get(oauthHeaderKey('linear'))).toBe('Bearer at-1')
  })

  it('returns the stored token without network when unexpired', async () => {
    const store = new MemoryCredentialStore()
    store.values.set(
      oauthCredentialKey('linear'),
      JSON.stringify({
        accessToken: 'fresh',
        tokenType: 'Bearer',
        clientId: 'client-123',
        expiresAt: Date.now() + 60_000,
      }),
    )
    const { fetcher, calls } = fakeServer()
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
      openBrowser: async () => {
        throw new Error('browser must not open for a fresh token')
      },
    })

    await expect(client.login()).resolves.toBe('Bearer fresh')
    expect(calls).toEqual([])
  })

  it('refreshes an expired token through the refresh grant', async () => {
    const store = new MemoryCredentialStore()
    store.values.set(
      oauthCredentialKey('linear'),
      JSON.stringify({
        accessToken: 'stale',
        tokenType: 'Bearer',
        clientId: 'client-123',
        refreshToken: 'rt-old',
        expiresAt: Date.now() - 1000,
      }),
    )
    const { fetcher, calls } = fakeServer({ accessToken: 'renewed' })
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
      openBrowser: async () => {
        throw new Error('browser must not open when refresh succeeds')
      },
    })

    await expect(client.login()).resolves.toBe('Bearer renewed')
    const refresh = calls.find((call) => call.url === 'https://auth.example.com/token')!
    const form = new URLSearchParams(String(refresh.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-old')
    expect(store.values.get(oauthHeaderKey('linear'))).toBe('Bearer renewed')
  })

  it('rejects a callback with mismatched state', async () => {
    const store = new MemoryCredentialStore()
    const { fetcher } = fakeServer()
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
      openBrowser: async (url) => {
        const authUrl = new URL(url)
        const redirect = authUrl.searchParams.get('redirect_uri')!
        await fetch(`${redirect}?code=abc&state=tampered`)
      },
      timeoutMs: 2000,
    })

    await expect(client.login()).rejects.toBeInstanceOf(McpOAuthError)
    expect(store.values.size).toBe(0)
  })

  it('fails fast when the server exposes no registration endpoint', async () => {
    const store = new MemoryCredentialStore()
    const { fetcher } = fakeServer({ registrationEndpoint: false })
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
      openBrowser: async () => {},
      timeoutMs: 500,
    })

    await expect(client.login()).rejects.toThrow(/no dynamic client registration endpoint/)
  })

  it('logout revokes best-effort and clears both credential keys', async () => {
    const store = new MemoryCredentialStore()
    store.values.set(
      oauthCredentialKey('linear'),
      JSON.stringify({ accessToken: 'at-1', tokenType: 'Bearer', clientId: 'client-123' }),
    )
    store.values.set(oauthHeaderKey('linear'), 'Bearer at-1')
    const { fetcher, calls } = fakeServer()
    const client = new McpOAuthClient({
      serverName: 'linear',
      serverUrl: SERVER,
      store,
      fetch: fetcher as typeof fetch,
    })

    await client.logout()

    expect(store.values.size).toBe(0)
    const revoke = calls.find((call) => call.url === 'https://auth.example.com/revoke')
    expect(revoke).toBeDefined()
    expect(new URLSearchParams(String(revoke!.body)).get('token')).toBe('at-1')
  })
})
