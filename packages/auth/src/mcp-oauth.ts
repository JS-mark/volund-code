import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { CredentialStore } from './index'

/** SM-07：OAuth 2.1 客户端流所需的授权服务器元数据（RFC 8414 / OIDC 发现）。 */
export interface AuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
}

/** 持久化的 MCP OAuth 令牌（存 auth store：`mcp.<name>.oauth`）。 */
export interface StoredMcpToken {
  accessToken: string
  tokenType: string
  clientId: string
  refreshToken?: string
  /** epoch ms；缺省 = 不过期。 */
  expiresAt?: number
}

export interface McpOAuthOptions {
  serverName: string
  serverUrl: string
  /** 凭据存取（keychain/加密文件；运行层传入 AuthManager 的底层 store）。 */
  store: CredentialStore
  fetch?: typeof fetch
  /** 打开浏览器（默认平台 open/xdg-open/start；测试注入捕获授权 URL）。 */
  openBrowser?: (url: string) => Promise<void>
  /** 授权回程等待上限 ms（默认 5 分钟）。 */
  timeoutMs?: number
  now?: () => number
  scopes?: readonly string[]
}

export const oauthCredentialKey = (serverName: string) => `mcp.${serverName}.oauth`
export const oauthHeaderKey = (serverName: string) => `mcp.${serverName}.Authorization`

export class McpOAuthError extends Error {}

const base64url = (bytes: Buffer) => bytes.toString('base64url')
const redirectUriFor = (port: number) => `http://127.0.0.1:${port}/callback`

/**
 * SM-07：MCP 远程 server 的 OAuth 2.1 客户端流。
 *
 * 401/403（needs-auth）→ `volund mcp login <name>` →
 *   发现（RFC 8414 / OIDC / MCP protected-resource）→ DCR（public client）→
 *   PKCE S256 + state → 本机 loopback 回程 → 授权码交换 →
 *   token 存 auth（`mcp.<name>.oauth`）+ `Bearer` 头快照（`mcp.<name>.Authorization`，
 *   供 mcp.toml 的 `keyref://` 占位与无 header 配置的自动注入消费）。
 */
export class McpOAuthClient {
  constructor(readonly options: McpOAuthOptions) {}

  /** 返回可直接放进 Authorization 头的值（`Bearer ...`），并持久化凭据。 */
  async login(): Promise<string> {
    const stored = await this.#readStoredToken()
    if (stored && !this.#expired(stored)) return this.#headerValue(stored)
    if (stored?.refreshToken) {
      try {
        const refreshed = await this.#refresh(stored)
        await this.#persist(refreshed)
        return this.#headerValue(refreshed)
      } catch {
        // 刷新失败（吊销/网络）→ 走完整重授权。
      }
    }
    const metadata = await this.#discover()
    if (!metadata)
      throw new McpOAuthError(
        `no OAuth authorization server metadata discovered for ${this.options.serverUrl}`,
      )
    const token = await this.#authorize(metadata)
    await this.#persist(token)
    return this.#headerValue(token)
  }

  /** 吊销（best-effort）并清除两把凭据。 */
  async logout(): Promise<void> {
    const stored = await this.#readStoredToken()
    if (stored) {
      try {
        const metadata = await this.#discover()
        if (metadata?.revocation_endpoint)
          await this.#postForm(metadata.revocation_endpoint, {
            token: stored.accessToken,
            client_id: stored.clientId,
          })
      } catch {
        // 吊销失败不阻塞本地登出。
      }
    }
    await this.options.store.delete(oauthCredentialKey(this.options.serverName))
    await this.options.store.delete(oauthHeaderKey(this.options.serverName))
  }

  async #readStoredToken(): Promise<StoredMcpToken | undefined> {
    const raw = await this.options.store.get(oauthCredentialKey(this.options.serverName))
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as StoredMcpToken
      if (typeof parsed.accessToken === 'string' && typeof parsed.clientId === 'string')
        return parsed
    } catch {
      // 损坏的存储条目按未登录处理。
    }
    return undefined
  }

  #expired(token: StoredMcpToken): boolean {
    return (
      typeof token.expiresAt === 'number' && token.expiresAt <= (this.options.now ?? Date.now)()
    )
  }

  #headerValue(token: StoredMcpToken): string {
    return `${token.tokenType === 'DPoP' ? 'DPoP' : 'Bearer'} ${token.accessToken}`
  }

  async #persist(token: StoredMcpToken): Promise<void> {
    await this.options.store.set(oauthCredentialKey(this.options.serverName), JSON.stringify(token))
    await this.options.store.set(oauthHeaderKey(this.options.serverName), this.#headerValue(token))
  }

  /**
   * 元数据发现：MCP protected-resource 指向的授权服务器优先；其后按
   * RFC 8414（含 path 变体）与 OIDC 依次探测。
   */
  async #discover(): Promise<AuthServerMetadata | undefined> {
    const fetcher = this.options.fetch ?? fetch
    const url = new URL(this.options.serverUrl)
    const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    const bases: string[] = [url.origin]
    for (const wellKnown of [
      `${url.origin}/.well-known/oauth-protected-resource${suffix}`,
      `${url.origin}/.well-known/oauth-protected-resource`,
    ]) {
      try {
        const response = await fetcher(wellKnown)
        if (!response.ok) continue
        const body = (await response.json()) as { authorization_servers?: string[] }
        const primary = body.authorization_servers?.[0]
        if (primary) {
          const parsed = new URL(primary)
          bases.unshift(
            `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`,
          )
          break
        }
      } catch {
        // 无 protected-resource → 直接探测授权服务器元数据。
      }
    }
    for (const base of bases)
      for (const wellKnown of [
        `${base}/.well-known/oauth-authorization-server${suffix}`,
        `${base}/.well-known/oauth-authorization-server`,
        `${base}/.well-known/openid-configuration`,
      ]) {
        try {
          const response = await fetcher(wellKnown)
          if (!response.ok) continue
          const body = (await response.json()) as Partial<AuthServerMetadata>
          if (
            typeof body.authorization_endpoint === 'string' &&
            typeof body.token_endpoint === 'string'
          )
            return {
              authorization_endpoint: body.authorization_endpoint,
              token_endpoint: body.token_endpoint,
              ...(typeof body.registration_endpoint === 'string'
                ? { registration_endpoint: body.registration_endpoint }
                : {}),
              ...(typeof body.revocation_endpoint === 'string'
                ? { revocation_endpoint: body.revocation_endpoint }
                : {}),
              ...(Array.isArray(body.scopes_supported)
                ? { scopes_supported: body.scopes_supported.filter((s) => typeof s === 'string') }
                : {}),
            }
        } catch {
          continue
        }
      }
    return undefined
  }

  async #register(metadata: AuthServerMetadata, redirectUri: string): Promise<string> {
    if (!metadata.registration_endpoint)
      throw new McpOAuthError(
        'authorization server exposes no dynamic client registration endpoint; configure a client_id manually',
      )
    const response = await (this.options.fetch ?? fetch)(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: `volund-mcp-${this.options.serverName}`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(this.options.scopes?.length ? { scope: this.options.scopes.join(' ') } : {}),
      }),
    })
    if (!response.ok)
      throw new McpOAuthError(`dynamic client registration failed: HTTP ${response.status}`)
    const body = (await response.json()) as { client_id?: string }
    if (typeof body.client_id !== 'string')
      throw new McpOAuthError('dynamic client registration returned no client_id')
    return body.client_id
  }

  async #authorize(metadata: AuthServerMetadata): Promise<StoredMcpToken> {
    const timeoutMs = this.options.timeoutMs ?? 300_000
    const loopback = await this.#listenLoopback()
    try {
      const clientId = await this.#register(metadata, loopback.redirectUri)
      // PKCE S256 + 随机 state（回程校验防 CSRF/混入）。
      const verifier = base64url(randomBytes(48))
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const state = base64url(randomBytes(16))
      const authUrl = new URL(metadata.authorization_endpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', loopback.redirectUri)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      const scopes = this.options.scopes ?? metadata.scopes_supported
      if (scopes?.length) authUrl.searchParams.set('scope', scopes.join(' '))

      // 先注册回程等待再开浏览器：授权服务器可能在我们 await 前就回调。
      const codePromise = loopback.waitForCode(state, timeoutMs)
      // 预挂空 catch：回程若先于下方 await 到达，拒绝已发生而处理器未挂，
      // 会被记成 unhandled rejection；真正的错误仍由下方 await 抛出。
      codePromise.catch(() => undefined)
      await this.#openBrowser(authUrl.toString())
      const code = await codePromise
      return await this.#exchange(metadata, {
        clientId,
        code,
        verifier,
        redirectUri: loopback.redirectUri,
      })
    } finally {
      loopback.server.close()
    }
  }

  async #openBrowser(url: string): Promise<void> {
    if (this.options.openBrowser) return this.options.openBrowser(url)
    const { spawn } = await import('node:child_process')
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const child = spawn(command, process.platform === 'win32' ? ['/c', 'start', url] : [url], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref?.()
  }

  /** 本机 loopback 回程服务器：首个 /callback 携带授权码，state 不符即拒绝。 */
  #listenLoopback(): Promise<{
    server: Server
    redirectUri: string
    waitForCode: (expectedState: string, timeoutMs: number) => Promise<string>
  }> {
    return new Promise((resolveServer, rejectServer) => {
      let resolveCode: ((code: string) => void) | undefined
      let rejectCode: ((error: Error) => void) | undefined
      let expectedState: string | undefined
      // 回程一次性：首个 /callback 之后的所有请求静默 404（keep-alive 重放/
      // 重试不得二次 settle，否则会产生 unhandled rejection）。
      let settled = false
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback' || settled) {
          response.statusCode = 404
          response.end()
          return
        }
        settled = true
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(
          error
            ? '<html><body><h3>Volund CLI: authorization failed</h3></body></html>'
            : '<html><body><h3>Volund CLI authorized — you can close this window.</h3></body></html>',
        )
        if (url.searchParams.get('state') !== expectedState)
          rejectCode?.(new McpOAuthError('authorization callback state mismatch'))
        else if (error) rejectCode?.(new McpOAuthError(`authorization failed: ${error}`))
        else if (code) resolveCode?.(code)
        else rejectCode?.(new McpOAuthError('authorization callback carried no code'))
      })
      server.once('error', rejectServer)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          rejectServer(new McpOAuthError('failed to bind loopback redirect server'))
          return
        }
        resolveServer({
          server,
          redirectUri: redirectUriFor(address.port),
          waitForCode: (state, timeoutMs) =>
            new Promise<string>((resolve, reject) => {
              expectedState = state
              const timer = setTimeout(
                () => reject(new McpOAuthError('timed out waiting for the authorization callback')),
                timeoutMs,
              )
              resolveCode = (code) => {
                clearTimeout(timer)
                resolve(code)
              }
              rejectCode = (error) => {
                clearTimeout(timer)
                reject(error)
              }
            }),
        })
      })
    })
  }

  async #exchange(
    metadata: AuthServerMetadata,
    input: { clientId: string; code: string; verifier: string; redirectUri: string },
  ): Promise<StoredMcpToken> {
    const body = await this.#postForm(metadata.token_endpoint, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    })
    return this.#tokenFromResponse(body, input.clientId)
  }

  async #refresh(stored: StoredMcpToken): Promise<StoredMcpToken> {
    const metadata = await this.#discover()
    if (!metadata?.token_endpoint) throw new McpOAuthError('token endpoint unavailable for refresh')
    const body = await this.#postForm(metadata.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken!,
      client_id: stored.clientId,
    })
    return this.#tokenFromResponse(body, stored.clientId, stored.refreshToken)
  }

  #tokenFromResponse(
    body: Record<string, unknown>,
    clientId: string,
    fallbackRefreshToken?: string,
  ): StoredMcpToken {
    if (typeof body.access_token !== 'string')
      throw new McpOAuthError('token endpoint returned no access_token')
    const tokenType = typeof body.token_type === 'string' ? body.token_type : 'Bearer'
    return {
      accessToken: body.access_token,
      tokenType,
      clientId,
      ...(typeof body.refresh_token === 'string'
        ? { refreshToken: body.refresh_token }
        : fallbackRefreshToken
          ? { refreshToken: fallbackRefreshToken }
          : {}),
      ...(typeof body.expires_in === 'number'
        ? { expiresAt: (this.options.now ?? Date.now)() + body.expires_in * 1000 }
        : {}),
    }
  }

  async #postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await (this.options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    })
    if (!response.ok) throw new McpOAuthError(`token request failed: HTTP ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  }
}
