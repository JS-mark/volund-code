/**
 * §11.3 `volund remote`——远程网关的多机接入命令族：
 *
 * - `volund remote enroll`：在已接入网关的本机上铸造机器注册码
 *   （POST /v1/pairing，uplink scope）。需要 [remote] 三件套已配置。
 * - `volund remote connect`：在新机器上核销注册码（公开端点
 *   POST /pairing/redeem），网关铸造独立机器客户端——明文 client_secret
 *   只出现在这一次应答里——随后写回 [remote] 段并启用，下次启动即拨出。
 *
 * 信任模型与设备配对一致：持有已接入机器凭证的人 = 有权接纳新机器。
 * 命令层只做参数解析、HTTP 与呈现；[remote] 写回走 config 端口的 schema 门。
 */
import { productIdentity } from '@volund/shared'
import type { JsonValue } from '@volund/shared'

import type { CliResult, CommandDefinition } from '../shared/cli-types'

interface RemoteSection {
  readonly gateway_url?: string
  readonly client_id?: string
  readonly client_secret?: string
}

interface TokenResponse {
  readonly access_token?: string
  readonly error?: { readonly message?: string }
}

interface RedeemResponse {
  readonly client_id?: string
  readonly client_secret?: string
  readonly error?: { readonly code?: string; readonly message?: string }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** 网关 JSON 错误体 → 一行人话（网络层错误原样上抛由调用方兜底）。 */
async function gatewayError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message ?? `gateway returned ${response.status}`
  } catch {
    return `gateway returned ${response.status}`
  }
}

export function createRemoteCommand(): CommandDefinition {
  return {
    name: 'remote',
    async run({ args, cwd, ports }): Promise<CliResult> {
      const json = args.json === true
      const config = ports.config
      if (!config.listMerged || !config.setValue)
        return { exitCode: 2, stdout: '', stderr: 'config commands are not wired in this build' }
      const action = args._[1]

      if (action === 'enroll') {
        const merged = await config.listMerged({ cwd })
        const remote = (merged.config['remote'] ?? {}) as RemoteSection
        if (!remote.gateway_url || !remote.client_id || !remote.client_secret)
          return {
            exitCode: 2,
            stdout: '',
            stderr:
              'remote control is not configured; run `volund remote connect` or fill [remote] gateway_url/client_id/client_secret first',
          }
        let token: string
        try {
          const tokenResponse = await fetch(joinUrl(remote.gateway_url, '/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: remote.client_id,
              client_secret: remote.client_secret,
            }),
          })
          const body = (await tokenResponse.json()) as TokenResponse
          if (!tokenResponse.ok || !body.access_token)
            return {
              exitCode: 1,
              stdout: '',
              stderr: `gateway rejected the machine credentials: ${body.error?.message ?? tokenResponse.status}`,
            }
          token = body.access_token
        } catch (cause) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `cannot reach the gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
        try {
          const minted = await fetch(joinUrl(remote.gateway_url, '/v1/pairing'), {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          })
          const body = (await minted.json()) as { code?: string; expiresAt?: number }
          if (!minted.ok || !body.code)
            return { exitCode: 1, stdout: '', stderr: await gatewayError(minted) }
          if (json)
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ code: body.code, expiresAt: body.expiresAt })}\n`,
              stderr: '',
            }
          return {
            exitCode: 0,
            stdout:
              `enrollment code: ${body.code}\n` +
              `valid for 5 minutes. On the new machine run:\n` +
              `  ${productIdentity.commandName} remote connect --gateway ${remote.gateway_url} --code ${body.code}\n`,
            stderr: '',
          }
        } catch (cause) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `cannot reach the gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
      }

      if (action === 'connect') {
        const gateway = typeof args.gateway === 'string' ? args.gateway : undefined
        const code = typeof args.code === 'string' ? args.code : undefined
        if (!gateway || !code)
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'remote connect requires --gateway <url> and --code <code>',
          }
        let credentials: RedeemResponse
        try {
          const redeem = await fetch(joinUrl(gateway, '/pairing/redeem'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
          })
          const body = (await redeem.json()) as RedeemResponse
          if (!redeem.ok || !body.client_id || !body.client_secret)
            return {
              exitCode: 1,
              stdout: '',
              stderr: body.error?.message ?? `gateway returned ${redeem.status}`,
            }
          credentials = body
        } catch (cause) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `cannot reach the gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
          }
        }
        const writes: [string, JsonValue][] = [
          ['remote.gateway_url', gateway],
          ['remote.client_id', credentials.client_id!],
          ['remote.client_secret', credentials.client_secret!],
          ['remote.enabled', true],
        ]
        for (const [key, value] of writes) await config.setValue({ cwd, key, value })
        if (json)
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ client_id: credentials.client_id, gateway })}\n`,
            stderr: '',
          }
        return {
          exitCode: 0,
          stdout:
            `registered as ${credentials.client_id}; [remote] configured and enabled.\n` +
            `remote control dials out on the next start (or toggle 远程控制 in the web console).\n`,
          stderr: '',
        }
      }

      return {
        exitCode: 2,
        stdout: '',
        stderr: `unknown remote action: ${action ?? '<none>'}. Use 'volund remote enroll' or 'volund remote connect'.`,
      }
    },
  }
}
