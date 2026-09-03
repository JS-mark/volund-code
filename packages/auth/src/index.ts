import { sanitize } from '@volund/shared'
export interface AuthTelemetry {
  emit(name: string, source: string, payload: Record<string, unknown>): Promise<void>
}
export interface CredentialStore {
  get(provider: string): Promise<string | undefined>
  set(provider: string, value: string): Promise<void>
  delete(provider: string): Promise<void>
}
export interface AuthOptions {
  keychain?: CredentialStore
  encrypted?: CredentialStore
  env?: NodeJS.ProcessEnv
  /**
   * Layer 4（§8.4）：用户级 config.toml 的 `[auth] <provider>_api_key` 显式 opt-in。
   * 由组装层注入（auth 包不读 TOML）；项目级 config 由 §8.3.1 数据流向门禁止。
   */
  configKeys?: (provider: string) => Promise<string | undefined>
  telemetry: AuthTelemetry
}
const envName = (provider: string) =>
  `${provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`
export class AuthManager {
  readonly #cache = new Map<string, string>()
  constructor(readonly options: AuthOptions) {}
  private event(name: string, payload: Record<string, unknown>) {
    return this.options.telemetry.emit(name, 'auth', sanitize(payload))
  }
  async getCredential(provider: string): Promise<string | undefined> {
    const start = Date.now(),
      cached = this.#cache.get(provider)
    if (cached) {
      await this.event('auth.credential.resolved', {
        provider,
        layer: 1,
        cache_hit: true,
        duration_ms: Date.now() - start,
      })
      return cached
    }
    const stores = [this.options.keychain, this.options.encrypted]
    for (let i = 0; i < stores.length; i++) {
      try {
        const value = await stores[i]?.get(provider)
        if (value) {
          this.#cache.set(provider, value)
          await this.event('auth.credential.resolved', {
            provider,
            layer: i + 1,
            cache_hit: false,
            duration_ms: Date.now() - start,
          })
          return value
        }
      } catch (error) {
        await this.event(i === 0 ? 'auth.keychain.error' : 'auth.encfile.unlock_result', {
          provider,
          platform: process.platform,
          error_class: error instanceof Error ? error.name : 'unknown',
          fallback_to: i === 0 ? 'enc_file' : 'env',
          outcome: 'bad_passphrase',
        })
      }
    }
    const value = this.options.env?.[envName(provider)]
    if (value) {
      this.#cache.set(provider, value)
      await this.event('auth.credential.resolved', {
        provider,
        layer: 3,
        cache_hit: false,
        duration_ms: Date.now() - start,
      })
      return value
    }
    const fromConfig = await this.options.configKeys?.(provider)
    if (fromConfig) {
      this.#cache.set(provider, fromConfig)
      await this.event('auth.credential.resolved', {
        provider,
        layer: 4,
        cache_hit: false,
        duration_ms: Date.now() - start,
      })
      return fromConfig
    }
    await this.event('auth.credential.miss', {
      provider,
      layers_tried: this.options.configKeys ? [1, 2, 3, 4] : [1, 2, 3],
    })
    return undefined
  }
  async login(
    provider: string,
    credential: string,
    verify: (credential: string) => Promise<boolean>,
    options: { flow?: 'api-key' | 'oauth' | 'stdin'; dangerouslySkipVerify?: boolean } = {},
  ): Promise<void> {
    const start = Date.now()
    await this.event('auth.login.started', {
      provider,
      flow: options.flow ?? 'stdin',
      session_uuid: crypto.randomUUID(),
    })
    try {
      if (!options.dangerouslySkipVerify) {
        await this.event('auth.login.verify_requested', {
          provider,
          endpoint_kind: 'provider_verify',
          latency_est_ms: 0,
        })
        const verifyStart = Date.now(),
          ok = await verify(credential)
        await this.event('auth.login.verify_result', {
          provider,
          outcome: ok ? 'ok' : '4xx',
          duration_ms: Date.now() - verifyStart,
        })
        if (!ok) throw new Error('Credential verification failed')
      } else await this.event('auth.dangerously.skip_verify', { provider })
      const store = this.options.keychain ?? this.options.encrypted
      if (!store) throw new Error('No secure credential store available')
      await store.set(provider, credential)
      this.#cache.set(provider, credential)
      await this.event('auth.login.stored', {
        provider,
        sink: this.options.keychain ? 'keychain' : 'enc_file',
        duration_ms: Date.now() - start,
      })
    } catch (error) {
      await this.event('auth.login.failed', {
        provider,
        stage: 'verify',
        error_class: error instanceof Error ? error.name : 'unknown',
        duration_ms: Date.now() - start,
      })
      throw error
    }
  }
  async logout(provider: string): Promise<void> {
    const cleared: string[] = []
    for (const [name, store] of [
      ['keychain', this.options.keychain],
      ['enc_file', this.options.encrypted],
    ] as const)
      if (store) {
        await store.delete(provider)
        cleared.push(name)
      }
    this.#cache.delete(provider)
    await this.event('auth.logout.completed', { provider, sinks_cleared: cleared })
    await this.event('auth.revoked', { provider, reason: 'user_logout' })
  }
}
export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>()
  async get(p: string) {
    return this.values.get(p)
  }
  async set(p: string, v: string) {
    this.values.set(p, v)
  }
  async delete(p: string) {
    this.values.delete(p)
  }
}
export { EncryptedCredentialStore } from './encrypted-store'
export {
  McpOAuthClient,
  McpOAuthError,
  oauthCredentialKey,
  oauthHeaderKey,
  type AuthServerMetadata,
  type McpOAuthOptions,
  type StoredMcpToken,
} from './mcp-oauth'
