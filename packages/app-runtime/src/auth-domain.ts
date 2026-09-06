/**
 * AuthController 域（§8.4 / P1-04e）：凭据健康、登录、登出。
 * 从 createProductionPorts 闭包迁入；凭据交互输入与 verify 网络调用经
 * options 注入（Web 的登录流程在 P4 单独设计，不走交互 prompt）。
 */
import { join } from 'node:path'

import type { AuthManager } from '@volund/auth'
import { loadTomlFile } from '@volund/config'
import type { JsonValue } from '@volund/shared'

/** auth 端口的宿主接缝。 */
export interface AuthDomainOptions {
  readonly home: string
  readonly auth: AuthManager
  /** 交互式凭据输入（CLI raw-mode prompt；Web 不提供 → login 由显式凭据驱动）。 */
  readonly promptCredential: (prompt: string) => Promise<string>
  /** 登录前向配置的网关 verify（§8.3 provider.<name>.baseUrl）。 */
  readonly verifyAnthropic: (credential: string, baseUrl: string | undefined) => Promise<boolean>
}

/**
 * 用户级 config.toml 的 [auth] 段（§8.4 Layer 4 / skipAuth）。
 * 项目级 config 到不了这里：§8.3.1 数据流向门把整段标为 forbidden。
 * AuthManager 的 configKeys 装配与 auth 端口共用本函数。
 */
export async function readAuthSection(home: string): Promise<Record<string, JsonValue>> {
  let config: Record<string, JsonValue>
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const section = config.auth
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {}
}

export function createAuthDomain(options: AuthDomainOptions) {
  const readAuthSectionLocal = () => readAuthSection(options.home)
  /** login 的 verify 请求要打向配置的网关（§8.3 provider.<name>.baseUrl），否则网关 key 在官方端点上必然 4xx。 */
  const readAnthropicBaseUrl = async (): Promise<string | undefined> => {
    let config: Record<string, JsonValue>
    try {
      config = await loadTomlFile(join(options.home, 'config.toml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const provider = config.provider
    const entry =
      provider && typeof provider === 'object' && !Array.isArray(provider)
        ? (provider as Record<string, JsonValue>).anthropic
        : undefined
    const baseUrl =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).baseUrl
        : undefined
    return typeof baseUrl === 'string' && baseUrl ? baseUrl : undefined
  }

  return {
    async health() {
      const section = await readAuthSectionLocal()
      if (section.skipAuth === true) {
        const keyIgnored =
          typeof section.anthropic_api_key === 'string' && section.anthropic_api_key !== ''
        return {
          configured: true,
          detail: `anthropic credential skipped by config (auth.skipAuth)${keyIgnored ? '; auth.anthropic_api_key is set but ignored while skipAuth=true' : ''}`,
        }
      }
      const configured = Boolean(await options.auth.getCredential('anthropic'))
      return {
        configured,
        detail: configured ? 'anthropic credential available' : 'anthropic credential unavailable',
      }
    },
    async login(input: {
      provider: string
      credential?: string
      flow: 'api-key' | 'stdin'
      dangerouslySkipVerify: boolean
    }) {
      const section = await readAuthSectionLocal()
      // §8.4：skipAuth / config Layer 4 已覆盖时，交互登录是 no-op——
      // 不弹输入、不发 verify；显式 --api-key-stdin 仍可落盘
      if (input.credential === undefined) {
        if (section.skipAuth === true)
          return {
            detail: `${input.provider} authentication is skipped by config (auth.skipAuth=true); nothing to store`,
          }
        const configured = section[`${input.provider}_api_key`]
        if (typeof configured === 'string' && configured)
          return {
            detail: `${input.provider} credential already provided by config (auth.${input.provider}_api_key); login is unnecessary`,
          }
      }
      const credential =
        input.credential ?? (await options.promptCredential('Anthropic API key: ')).trim()
      if (!credential) throw new Error('Credential input was cancelled')
      const verifyBaseUrl = await readAnthropicBaseUrl()
      await options.auth.login(
        input.provider,
        credential,
        (value) => options.verifyAnthropic(value, verifyBaseUrl),
        { flow: input.flow, dangerouslySkipVerify: input.dangerouslySkipVerify },
      )
      const skipNote =
        section.skipAuth === true
          ? ' (note: auth.skipAuth=true in config; the stored credential stays unused until it is removed)'
          : ''
      return {
        detail: `${input.provider} credential stored in encrypted credential store${skipNote}`,
      }
    },
    async logout(provider: string) {
      await options.auth.logout(provider)
      return { detail: `${provider} credential removed` }
    },
  }
}
